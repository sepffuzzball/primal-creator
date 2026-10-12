/**
 * Real-Postgres integration tests for trusted-backup character import.
 *
 * Exercises the full v3 export -> import round trip against a live database:
 * creating a source character with a title, equipment, a granted skill and a
 * selected skill offer, exporting it as a `primal-character/3` document, then
 * importing that document into a NEW character and asserting the import marker,
 * the provenance events, and the reapplied associations/offers. Also verifies
 * that a missing catalog definition and a semantically invalid state each reject
 * with a 400 and leave NO character behind (the transaction rolls back fully).
 *
 * Runs ONLY when explicitly opted in (see `resolveDbIntegration`): a normal
 * `pnpm test` skips this file entirely. Cleanup is strictly scoped to the ids this
 * run creates (users, catalog definitions, and characters).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { prisma } from "@/lib/db/client"
import {
  associateCharacter,
  createCharacter,
  exportCharacter,
  importCharacter,
  skillCharacter,
} from "@/lib/db/service"
import {
  IMPORT_RULESET_VERSION,
  type CharacterImportDocument,
} from "@/lib/server/import-schema"
import { resolveDbIntegration } from "@/lib/test/db-integration"

const gate = await resolveDbIntegration()

// Every id this run creates; afterAll deletes exactly these rows in FK-safe order.
const createdCharacterIds: string[] = []
const createdCatalogIds: string[] = []
const createdUserIds: string[] = []

const ownerUser = { id: "pg-owner", email: "owner@test.local", isAdmin: false }
const adminUser = { id: "pg-admin", email: "admin@test.local", isAdmin: true }

const CATALOG = {
  human: "catalog-human",
  archer: "catalog-archer",
  alchemist: "catalog-alchemist",
  title1: "catalog-title-1",
  gear1: "catalog-gear-1",
  skill1: "catalog-skill-1",
} as const

function attr(n: number) {
  return {
    strength: n,
    agility: n,
    endurance: n,
    vitality: n,
    toughness: n,
    wisdom: n,
    intelligence: n,
    perception: n,
    willpower: n,
  }
}

async function seedUser(id: string, email: string, isAdmin: boolean) {
  // Idempotent: a crashed prior run may have left the user behind.
  await prisma.user.upsert({
    where: { email },
    update: { id, isAdmin, disabled: false },
    create: { id, email, password: "x", isAdmin, disabled: false },
  })
  createdUserIds.push(id)
}

async function seedCatalog(
  id: string,
  kind: string,
  stableId: string,
  name: string,
  config: Record<string, unknown>
) {
  // Delete-then-create so we control the exact id even if a crashed prior run
  // left a row behind (the (kind, stableId) unique would otherwise collide).
  await prisma.catalogDefinition.deleteMany({
    where: { kind: kind as never, stableId },
  })
  await prisma.catalogDefinition.create({
    data: {
      id,
      kind: kind as never,
      stableId,
      name,
      config: config as never,
    },
  })
  createdCatalogIds.push(id)
}

/** Assert a failed import committed nothing: the character count is unchanged. */
async function expectNoCharacterCreated(
  before: number,
  fn: () => Promise<unknown>
): Promise<void> {
  await expect(fn()).rejects.toMatchObject({ status: 400 })
  const after = await prisma.character.count({
    where: { ownerId: adminUser.id },
  })
  expect(after).toBe(before)
}

describe.skipIf(!gate.run)("character import round trip (real PG)", () => {
  beforeAll(async () => {
    // Drop any characters this run's users may have left behind so the catalog
    // delete-then-create below is never blocked by an FK reference.
    await prisma.character.deleteMany({
      where: { ownerId: { in: [ownerUser.id, adminUser.id] } },
    })
    await seedUser(ownerUser.id, ownerUser.email, ownerUser.isAdmin)
    await seedUser(adminUser.id, adminUser.email, adminUser.isAdmin)

    await seedCatalog(CATALOG.human, "races", "human", "Human", {
      raceDefinitions: {
        G: { id: "human:G", perLevel: attr(1), freePerLevel: 5 },
      },
    })
    await seedCatalog(CATALOG.archer, "classes", "archer", "Archer", {
      grades: { G: { fixed: {}, free: 0 } },
    })
    await seedCatalog(
      CATALOG.alchemist,
      "professions",
      "alchemist",
      "Alchemist",
      { grades: { G: { fixed: {}, free: 0 } } }
    )
    await seedCatalog(CATALOG.title1, "titles", "title-1", "Heroic", {
      upgradeGroup: "hero",
    })
    await seedCatalog(CATALOG.gear1, "equipment", "gear-1", "Helm", {
      slot: "head",
    })
    await seedCatalog(CATALOG.skill1, "skills", "skill-1", "Skill One", {
      effects: [],
    })
  })

  afterAll(async () => {
    if (createdCharacterIds.length > 0) {
      await prisma.character.deleteMany({
        where: { id: { in: createdCharacterIds } },
      })
    }
    if (createdCatalogIds.length > 0) {
      await prisma.catalogDefinition.deleteMany({
        where: { id: { in: createdCatalogIds } },
      })
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    }
  })

  it("round-trips a v3 backup with a title, equipment, granted skill and selected skill offer", async () => {
    const src = await createCharacter(
      {
        name: "Source Hero",
        description: "Original",
        origin: "integrated",
        raceId: CATALOG.human,
        classId: CATALOG.archer,
        professionId: CATALOG.alchemist,
      },
      ownerUser
    )
    createdCharacterIds.push(src.id)

    // Link a title and equipment, then grant a skill (admin).
    await associateCharacter(
      src.id,
      {
        kind: "title",
        definitionId: CATALOG.title1,
        operation: "add",
        version: 0,
      },
      ownerUser
    )
    await associateCharacter(
      src.id,
      {
        kind: "equipment",
        definitionId: CATALOG.gear1,
        operation: "add",
        version: 1,
      },
      ownerUser
    )
    await skillCharacter(
      src.id,
      {
        operation: "grant",
        definitionId: CATALOG.skill1,
        version: 2,
        reason: "story",
      },
      adminUser
    )

    // A selected skill offer for the granted skill (export must capture it). The
    // historical selection timestamp must survive the round trip unchanged.
    const originalSelectedAt = new Date("2026-01-01T12:00:00.000Z")
    await prisma.skillOffer.create({
      data: {
        characterId: src.id,
        track: "class",
        level: 1,
        choiceGroup: "standard",
        selectedDefinitionId: CATALOG.skill1,
        selectedAt: originalSelectedAt,
        offeredAt: new Date("2026-01-01T00:00:00.000Z"),
        options: {
          create: [
            {
              definitionId: CATALOG.skill1,
              nameSnapshot: "Skill One",
              configSnapshot: {},
            },
          ],
        },
      },
    })

    const rawDoc = await exportCharacter(src.id, ownerUser)
    const doc = rawDoc as unknown as CharacterImportDocument
    expect(doc.schema).toBe("primal-character/3")
    expect(doc.rulesetVersion).toBe(IMPORT_RULESET_VERSION)
    expect(doc.identity).toMatchObject({
      name: "Source Hero",
      origin: "integrated",
      race: { stableId: "human" },
      class: { stableId: "archer" },
      profession: { stableId: "alchemist" },
    })
    expect(doc.associations).toHaveLength(3)
    expect(doc.skillOffers).toHaveLength(1)
    expect(doc.skillOffers[0].selectedStableId).toBe("skill-1")

    const imported = await importCharacter(doc, adminUser)
    createdCharacterIds.push(imported.id)

    expect(imported.imported).toBe(true)
    expect(imported.origin).toBe("integrated")
    expect(imported.raceName).toBe("Human")
    expect(imported.className).toBe("Archer")
    expect(imported.professionName).toBe("Alchemist")
    expect(imported.associations).toHaveLength(3)
    expect(imported.skillOffers).toHaveLength(1)
    expect(imported.skillOffers[0].selectedDefinitionId).toBe(CATALOG.skill1)

    // The historical selection timestamp is preserved verbatim (not restamped).
    const importedOffer = await prisma.skillOffer.findFirst({
      where: { characterId: imported.id },
    })
    expect(importedOffer?.selectedAt?.toISOString()).toBe(
      originalSelectedAt.toISOString()
    )

    // The source is untouched; the import created a distinct character.
    expect(imported.id).not.toBe(src.id)
    const stored = await prisma.character.findUnique({ where: { id: src.id } })
    expect(stored?.name).toBe("Source Hero")

    // Journal: every source event is stored as provenance plus one import marker.
    const evs = await prisma.progressionEvent.findMany({
      where: { characterId: imported.id },
      orderBy: { createdAt: "asc" },
    })
    const kinds = evs.map((e) => e.kind)
    expect(kinds[kinds.length - 1]).toBe("import")
    expect(kinds.slice(0, -1).every((k) => k === "import_history")).toBe(true)
    const marker = evs[evs.length - 1].payload as Record<string, unknown>
    expect(marker.rulesetVersion).toBe(IMPORT_RULESET_VERSION)

    // Exporting the imported character must reproduce the same identity/links.
    const roundtrip = (await exportCharacter(
      imported.id,
      adminUser
    )) as unknown as CharacterImportDocument
    expect(roundtrip.identity).toEqual(doc.identity)
    expect(roundtrip.associations).toHaveLength(3)
    expect(roundtrip.skillOffers).toHaveLength(1)
    expect(roundtrip.skillOffers[0].selectedStableId).toBe("skill-1")
  })

  it("rejects a backup whose race definition is missing and creates no character", async () => {
    const before = await prisma.character.count({
      where: { ownerId: adminUser.id },
    })
    const doc = (await exportCharacter(
      (
        await prisma.character.findFirstOrThrow({
          where: { name: "Source Hero" },
        })
      ).id,
      adminUser
    )) as unknown as CharacterImportDocument

    // Point identity.race at a stableId that does not exist in the catalog.
    const doc2: CharacterImportDocument = {
      ...doc,
      identity: { ...doc.identity, race: { stableId: "ghost" } },
    }
    await expectNoCharacterCreated(before, () =>
      importCharacter(doc2, adminUser)
    )
  })

  it("rejects a semantically invalid state (over-allocated points) and rolls back", async () => {
    const before = await prisma.character.count({
      where: { ownerId: adminUser.id },
    })
    const srcRow = await prisma.character.findFirstOrThrow({
      where: { name: "Source Hero" },
    })
    const doc = (await exportCharacter(
      srcRow.id,
      adminUser
    )) as unknown as CharacterImportDocument

    // Force an over-allocation: one non-integer allocation with no awards means
    // allocated > total free, which the importer must reject.
    const overAlloc: CharacterImportDocument = {
      ...doc,
      state: {
        ...doc.state,
        allocations: [
          {
            id: "alloc-x",
            source: "manual",
            at: 0,
            points: attr(1),
          },
        ],
      },
    }
    await expectNoCharacterCreated(before, () =>
      importCharacter(overAlloc, adminUser)
    )
  })

  it("uses a fresh character id and never overwrites on repeated import", async () => {
    const srcRow = await prisma.character.findFirstOrThrow({
      where: { name: "Source Hero" },
    })
    const doc = (await exportCharacter(
      srcRow.id,
      adminUser
    )) as unknown as CharacterImportDocument
    const first = await importCharacter(doc, adminUser)
    const second = await importCharacter(doc, adminUser)
    createdCharacterIds.push(first.id, second.id)
    expect(first.id).not.toBe(second.id)
    expect(second.imported).toBe(true)
  })
})
