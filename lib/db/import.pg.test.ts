/**
 * Real-Postgres integration tests for trusted-backup character import.
 *
 * Exercises the full v8 export -> import round trip against a live database:
 * creating a source character with a title, equipment, a granted skill, a
 * selected skill offer and a god (as a blessing + tier), exporting it as a
 * `primal-character/8` document, then importing that document into a NEW
 * character and asserting the import marker, the provenance events, and the
 * reapplied associations/offers. Also verifies that a missing catalog definition
 * and a semantically invalid state each reject with a 400 and leave NO character
 * behind (the transaction rolls back fully).
 *
 * Runs ONLY when explicitly opted in (see `resolveDbIntegration`): a normal
 * `pnpm test` skips this file entirely. Cleanup is strictly scoped to the ids this
 * run creates (users, catalog definitions, and characters).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { prisma } from "@/lib/db/client"
import {
  adjustCharacterInventory,
  associateCharacter,
  createCatalogItem,
  createCharacter,
  createInitialState,
  exportCharacter,
  importCharacter,
  serializeState,
  setCharacterCurrencyBalance,
  skillCharacter,
  updateCatalogItem,
} from "@/lib/db/service"
import {
  IMPORT_RULESET_VERSION,
  IMPORT_SCHEMA_V3,
  IMPORT_SCHEMA_V4,
  IMPORT_SCHEMA_V5,
  IMPORT_SCHEMA_V6,
  IMPORT_SCHEMA_V7,
  IMPORT_SCHEMA_V8,
  MAX_IMPORT_CURRENCIES,
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
  gear2: "catalog-gear-2",
  consum1: "catalog-consum-1",
  skill1: "catalog-skill-1",
  pgGod1: "catalog-pg-god-1",
  pgBloodline1: "catalog-pg-bloodline-1",
  pgTranscendent1: "catalog-pg-transcendent-1",
  pgCurrency1: "catalog-pg-currency-1",
  pgCurrency2: "catalog-pg-currency-2",
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

// Fully-allocated initial stat vector for the `initialAttributes` create field.
// Every catalog race in this suite is derived (enlightened), so this sums to the
// 70-point enlightened budget (9 base +61).
const enlightenedInitialAttributes = {
  strength: 1,
  agility: 1,
  endurance: 1,
  vitality: 1,
  toughness: 1,
  wisdom: 1,
  intelligence: 1,
  perception: 1,
  willpower: 62,
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
      grades: { F: { fixed: {}, free: 0 } },
    })
    await seedCatalog(
      CATALOG.alchemist,
      "professions",
      "alchemist",
      "Alchemist",
      { grades: { F: { fixed: {}, free: 0 } } }
    )
    await seedCatalog(CATALOG.title1, "titles", "title-1", "Heroic", {
      upgradeGroup: "hero",
    })
    await seedCatalog(CATALOG.gear1, "equipment", "gear-1", "Helm", {
      slot: "head",
    })
    await seedCatalog(CATALOG.gear2, "equipment", "gear-2", "Vest", {
      slot: "body",
    })
    await seedCatalog(CATALOG.consum1, "items", "consum-1", "Ration", {
      type: "permanent",
      amount: { strength: 1 },
    })
    await seedCatalog(CATALOG.skill1, "skills", "skill-1", "Skill One", {
      effects: [],
    })
    // Gods / bloodlines / transcendent catalog foundation: a god (a blessing is a
    // god + exact tier on a character association - there is no separate blessing
    // catalog kind), a narrative-only bloodline, and a transcendent skill. The god
    // carries a `blessingEffects.Minor` entry so a Minor blessing link round-trips
    // with a synthesized effect; the bloodline and transcendent skill are seeded
    // directly. Idempotent: a crashed prior run is cleaned up first.
    await seedCatalog(CATALOG.pgGod1, "gods", "pg-god-1", "PG God One", {
      pantheon: "Test Pantheon",
      divineRank: "God",
      blessingEffects: { Minor: [] },
    })
    await seedCatalog(
      CATALOG.pgBloodline1,
      "bloodlines",
      "pg-bloodline-1",
      "PG Bloodline One",
      { effects: [] }
    )
    await seedCatalog(
      CATALOG.pgTranscendent1,
      "transcendent_skills",
      "pg-transcendent-1",
      "PG Transcendent One",
      { passiveEffects: [{ phase: "flat", amount: { strength: 3 } }] }
    )
    // Currency catalog foundation for the v8 balance round trips. pgCurrency-1
    // stays ACTIVE; pgCurrency-2 is ARCHIVED (using direct balance writes, since the
    // owner-managed setter rejects an archived definition) so a hidden amount
    // survives a backup round trip.
    await seedCatalog(
      CATALOG.pgCurrency1,
      "currencies",
      "pg-currency-1",
      "PG Currency One",
      {}
    )
    await seedCatalog(
      CATALOG.pgCurrency2,
      "currencies",
      "pg-currency-2",
      "PG Currency Two",
      {}
    )
    await prisma.catalogDefinition.update({
      where: { id: CATALOG.pgCurrency2 },
      data: { archived: true },
    })
  })

  afterAll(async () => {
    if (createdCharacterIds.length > 0) {
      await prisma.character.deleteMany({
        where: { id: { in: createdCharacterIds } },
      })
    }
    if (createdCatalogIds.length > 0) {
      // There is no longer a `patron` FK (a blessing is a god + tier on a character
      // association), so every created catalog row is deleted together.
      await prisma.catalogDefinition.deleteMany({
        where: { id: { in: createdCatalogIds } },
      })
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    }
  })

  it("round-trips a v3 backup with title, equipment, granted skill, selected skill offer, a god blessing and a bloodline", async () => {
    const src = await createCharacter(
      {
        initialAttributes: enlightenedInitialAttributes,
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
    // Equipment is now owner-linked: an add requires the character to own at
    // least one unit of the definition, so seed the Helm stock first. Each
    // mutating service call increments the character version, so the versions
    // below follow the adjusted sequence.
    await adjustCharacterInventory(
      src.id,
      {
        operation: "add",
        definitionId: CATALOG.gear1,
        quantity: 1,
        version: 1,
        sourceNote: "seed stock for import round trip",
      },
      ownerUser
    )
    await associateCharacter(
      src.id,
      {
        kind: "equipment",
        definitionId: CATALOG.gear1,
        operation: "add",
        version: 2,
      },
      ownerUser
    )
    await skillCharacter(
      src.id,
      {
        operation: "grant",
        definitionId: CATALOG.skill1,
        version: 3,
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

    // The gods / bloodlines / transcendent catalog foundation: link the god at a
    // Minor blessing tier and a narrative-only bloodline so the export captures
    // them as typed associations and the importer re-resolves them by stableId.
    // The exact blessing tier is persisted on the link (never inferred).
    await prisma.characterAssociation.create({
      data: {
        characterId: src.id,
        definitionId: CATALOG.pgGod1,
        kind: "BLESSING",
        blessingTier: "Minor",
      },
    })
    await prisma.characterAssociation.create({
      data: {
        characterId: src.id,
        definitionId: CATALOG.pgBloodline1,
        kind: "BLOODLINE",
      },
    })
    await prisma.characterAssociation.create({
      data: {
        characterId: src.id,
        definitionId: CATALOG.pgTranscendent1,
        kind: "TRANSCENDENT",
      },
    })

    const rawDoc = await exportCharacter(src.id, ownerUser)
    const doc = rawDoc as unknown as CharacterImportDocument
    expect(doc.schema).toBe(IMPORT_SCHEMA_V8)
    expect(doc.rulesetVersion).toBe(IMPORT_RULESET_VERSION)
    expect(doc.identity).toMatchObject({
      name: "Source Hero",
      origin: "integrated",
      race: { stableId: "human" },
      class: { stableId: "archer" },
      profession: { stableId: "alchemist" },
    })
    expect(doc.associations).toHaveLength(6)
    expect(doc.skillOffers).toHaveLength(1)
    expect(doc.skillOffers[0].selectedStableId).toBe("skill-1")
    expect((doc as unknown as { isTranscendent: boolean }).isTranscendent).toBe(
      true
    )
    // v4 carries owned stock and the equipment grandfathering marker.
    const v4 = doc as unknown as {
      associations: Array<{ kind: string; legacyUnowned?: boolean }>
      inventory: Array<{
        definition: { kind: string; stableId: string }
        quantity: number
      }>
    }
    expect(v4.inventory).toEqual([
      { definition: { kind: "equipment", stableId: "gear-1" }, quantity: 1 },
    ])
    expect(
      v4.associations.find((a) => a.kind === "equipment")?.legacyUnowned
    ).toBe(false)

    const imported = await importCharacter(doc, adminUser)
    createdCharacterIds.push(imported.id)

    expect(imported.imported).toBe(true)
    expect(imported.origin).toBe("integrated")
    expect(imported.raceName).toBe("Human")
    expect(imported.className).toBe("Archer")
    expect(imported.professionName).toBe("Alchemist")
    expect(imported.associations).toHaveLength(6)
    expect(imported.skillOffers).toHaveLength(1)
    expect(imported.skillOffers[0].selectedDefinitionId).toBe(CATALOG.skill1)
    expect(
      (imported as unknown as { isTranscendent: boolean }).isTranscendent
    ).toBe(true)
    // Owned stock and the equipment marker are restored from the v4 backup.
    expect(imported.inventory).toHaveLength(1)
    expect(imported.inventory[0].definitionId).toBe(CATALOG.gear1)
    expect(imported.inventory[0].quantity).toBe(1)
    const importedEquip = await prisma.characterAssociation.findFirst({
      where: { characterId: imported.id, kind: "EQUIPMENT" },
    })
    expect(importedEquip?.legacyUnowned).toBe(false)

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
    expect(roundtrip.associations).toHaveLength(6)
    expect(
      (roundtrip as unknown as { inventory: unknown[] }).inventory
    ).toHaveLength(1)
    expect(
      (
        roundtrip as unknown as {
          associations: Array<{ kind: string; legacyUnowned?: boolean }>
        }
      ).associations.find((a) => a.kind === "equipment")?.legacyUnowned
    ).toBe(false)
    expect(roundtrip.skillOffers).toHaveLength(1)
    expect(roundtrip.skillOffers[0].selectedStableId).toBe("skill-1")
    expect(
      (roundtrip as unknown as { isTranscendent: boolean }).isTranscendent
    ).toBe(true)
  })

  it("round-trips a v4 backup with a consumable, an equipped item, and a grandfathered zero-stock link", async () => {
    const src = await createCharacter(
      {
        initialAttributes: enlightenedInitialAttributes,
        name: "V4 Hero",
        description: "v4 round trip",
        origin: "integrated",
        raceId: CATALOG.human,
        classId: CATALOG.archer,
        professionId: CATALOG.alchemist,
      },
      ownerUser
    )
    createdCharacterIds.push(src.id)

    await adjustCharacterInventory(
      src.id,
      {
        operation: "add",
        definitionId: CATALOG.consum1,
        quantity: 3,
        version: 0,
        sourceNote: "seed consumable for v4 roundtrip",
      },
      ownerUser
    )
    await adjustCharacterInventory(
      src.id,
      {
        operation: "add",
        definitionId: CATALOG.gear1,
        quantity: 2,
        version: 1,
        sourceNote: "seed gear for v4 roundtrip",
      },
      ownerUser
    )
    await associateCharacter(
      src.id,
      {
        kind: "equipment",
        definitionId: CATALOG.gear1,
        operation: "add",
        version: 2,
      },
      ownerUser
    )
    // A grandfathered link predating the inventory model: equipped with ZERO owned
    // stock (no inventory row), which a v4 backup must round-trip unchanged.
    await prisma.characterAssociation.create({
      data: {
        characterId: src.id,
        definitionId: CATALOG.gear2,
        kind: "EQUIPMENT",
        legacyUnowned: true,
      },
    })

    const raw = await exportCharacter(src.id, ownerUser)
    const doc = raw as unknown as CharacterImportDocument
    expect(doc.schema).toBe(IMPORT_SCHEMA_V8)
    const v4 = doc as unknown as {
      inventory: Array<{
        definition: { kind: string; stableId: string }
        quantity: number
      }>
      associations: Array<{
        kind: string
        legacyUnowned?: boolean
        definition: { stableId: string }
      }>
    }
    // Order is not contractual (no orderBy on the inventory read), so assert as a
    // set rather than a positional array.
    expect(v4.inventory).toHaveLength(2)
    expect(v4.inventory).toContainEqual({
      definition: { kind: "equipment", stableId: "gear-1" },
      quantity: 2,
    })
    expect(v4.inventory).toContainEqual({
      definition: { kind: "items", stableId: "consum-1" },
      quantity: 3,
    })
    const eq1 = v4.associations.find(
      (a) => a.kind === "equipment" && a.definition.stableId === "gear-1"
    )
    expect(eq1?.legacyUnowned).toBe(false)
    const eq2 = v4.associations.find(
      (a) => a.kind === "equipment" && a.definition.stableId === "gear-2"
    )
    expect(eq2?.legacyUnowned).toBe(true)

    const imported = await importCharacter(doc, adminUser)
    createdCharacterIds.push(imported.id)
    expect(imported.inventory).toHaveLength(2)
    expect(
      imported.inventory.find((i) => i.definitionId === CATALOG.gear1)?.quantity
    ).toBe(2)
    expect(
      imported.inventory.find((i) => i.definitionId === CATALOG.consum1)
        ?.quantity
    ).toBe(3)
    const storedEquip = await prisma.characterAssociation.findMany({
      where: { characterId: imported.id, kind: "EQUIPMENT" },
    })
    expect(
      storedEquip.find((a) => a.definitionId === CATALOG.gear1)?.legacyUnowned
    ).toBe(false)
    expect(
      storedEquip.find((a) => a.definitionId === CATALOG.gear2)?.legacyUnowned
    ).toBe(true)

    const importEvent = await prisma.progressionEvent.findFirst({
      where: { characterId: imported.id, kind: "import" },
    })
    const payload = importEvent!.payload as Record<string, unknown>
    expect(payload.backupSchema).toBe(IMPORT_SCHEMA_V8)
    expect(payload.inventoryCount).toBe(2)
  })

  it("imports archived owned stock inertly", async () => {
    const src = await createCharacter(
      {
        initialAttributes: enlightenedInitialAttributes,
        name: "Arch Stock",
        description: "archived stock",
        origin: "integrated",
        raceId: CATALOG.human,
        classId: CATALOG.archer,
        professionId: CATALOG.alchemist,
      },
      ownerUser
    )
    createdCharacterIds.push(src.id)
    await adjustCharacterInventory(
      src.id,
      {
        operation: "add",
        definitionId: CATALOG.gear2,
        quantity: 1,
        version: 0,
        sourceNote: "seed then archive",
      },
      ownerUser
    )
    // Catalog edit AFTER the stock was acquired: the reference stays valid but the
    // definition is now archived (inert). The backup must still round-trip it.
    await prisma.catalogDefinition.update({
      where: { id: CATALOG.gear2 },
      data: { archived: true },
    })

    const doc = (await exportCharacter(
      src.id,
      ownerUser
    )) as unknown as CharacterImportDocument
    const imported = await importCharacter(doc, adminUser)
    createdCharacterIds.push(imported.id)
    expect(imported.inventory).toHaveLength(1)
    expect(imported.inventory[0].definitionId).toBe(CATALOG.gear2)
    expect(imported.inventory[0].archived).toBe(true)
  })

  it("rejects a v4 backup with a missing inventory definition (rollback, no rows/events)", async () => {
    const before = await prisma.character.count({
      where: { ownerId: adminUser.id },
    })
    const eventsBefore = await prisma.progressionEvent.count()
    const srcRow = await prisma.character.findFirstOrThrow({
      where: { name: "Source Hero" },
    })
    const doc = (await exportCharacter(
      srcRow.id,
      adminUser
    )) as unknown as CharacterImportDocument
    const broken = {
      ...doc,
      inventory: [
        ...(doc as unknown as { inventory: unknown[] }).inventory,
        { definition: { kind: "equipment", stableId: "ghost" }, quantity: 1 },
      ],
    } as CharacterImportDocument
    await expectNoCharacterCreated(before, () =>
      importCharacter(broken, adminUser)
    )
    expect(await prisma.progressionEvent.count()).toBe(eventsBefore)
  })

  it("rejects a v4 backup with duplicate stock references (rollback, no rows/events)", async () => {
    const before = await prisma.character.count({
      where: { ownerId: adminUser.id },
    })
    const eventsBefore = await prisma.progressionEvent.count()
    const srcRow = await prisma.character.findFirstOrThrow({
      where: { name: "Source Hero" },
    })
    const doc = (await exportCharacter(
      srcRow.id,
      adminUser
    )) as unknown as CharacterImportDocument
    const broken = {
      ...doc,
      inventory: [
        { definition: { kind: "equipment", stableId: "gear-1" }, quantity: 1 },
        { definition: { kind: "equipment", stableId: "gear-1" }, quantity: 2 },
      ],
    } as CharacterImportDocument
    await expectNoCharacterCreated(before, () =>
      importCharacter(broken, adminUser)
    )
    expect(await prisma.progressionEvent.count()).toBe(eventsBefore)
  })

  it("rejects a v4 backup with a non-grandfathered equipment link and no owned stock (rollback, no rows/events)", async () => {
    const before = await prisma.character.count({
      where: { ownerId: adminUser.id },
    })
    const eventsBefore = await prisma.progressionEvent.count()
    const srcRow = await prisma.character.findFirstOrThrow({
      where: { name: "Source Hero" },
    })
    const doc = (await exportCharacter(
      srcRow.id,
      adminUser
    )) as unknown as CharacterImportDocument
    // Strip all owned stock; the exported equipment link is non-grandfathered, so
    // the importer must reject it rather than silently drop/unequip the link.
    const broken = {
      ...doc,
      inventory: [],
    } as CharacterImportDocument
    await expectNoCharacterCreated(before, () =>
      importCharacter(broken, adminUser)
    )
    expect(await prisma.progressionEvent.count()).toBe(eventsBefore)
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

  it("rejects a graded class track already past the next-grade threshold and rolls back", async () => {
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

    // The exported class track is graded F at level 0. Push its level past E's
    // entry threshold (25) without touching the race level: the importer must
    // reject the state before any write, since the first class level-up would
    // otherwise throw "without completed track evolution".
    const pastThreshold: CharacterImportDocument = {
      ...doc,
      state: {
        ...doc.state,
        tracks: {
          ...doc.state.tracks,
          class: {
            ...doc.state.tracks.class,
            level: 26,
          },
        },
      },
    }
    await expectNoCharacterCreated(before, () =>
      importCharacter(pastThreshold, adminUser)
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

  it("allows a god stableId change even while a blessing character link references it", async () => {
    // Idempotent: a crashed prior run may have left a god behind.
    await seedCatalog(
      "pg-race-god-rename",
      "gods",
      "pg-race-god-rename",
      "Race God Rename",
      {
        pantheon: "Race Pantheon",
        divineRank: "God",
        blessingEffects: { Minor: [] },
      }
    )
    // A character links this god as a Minor blessing. Gods carry no patron FK and
    // are exempt from the link-collision guard, so the stableId may be renamed
    // freely without blocking (the link stores the row `id`, not the stableId).
    const char = await createCharacter(
      {
        initialAttributes: enlightenedInitialAttributes,
        name: "Race God Referencer",
        description: "references the god",
        origin: "integrated",
        raceId: CATALOG.human,
        classId: CATALOG.archer,
        professionId: CATALOG.alchemist,
      },
      ownerUser
    )
    createdCharacterIds.push(char.id)
    await associateCharacter(
      char.id,
      {
        kind: "blessing",
        definitionId: "pg-race-god-rename",
        tier: "Minor",
        operation: "add",
        version: char.version,
      },
      ownerUser
    )

    const item = await updateCatalogItem("gods", "pg-race-god-rename", {
      stableId: "pg-race-god-renamed",
    })
    expect(item.stableId).toBe("pg-race-god-renamed")
  })

  it("maps a concurrent gods stableId race to a 409, never a 500", async () => {
    await prisma.catalogDefinition.deleteMany({
      where: { kind: "gods", stableId: "pg-race-bless-race" },
    })
    const pending = [
      createCatalogItem("gods", {
        stableId: "pg-race-bless-race",
        name: "Race God Race",
        config: { blessingEffects: { Minor: [] } },
      }),
      createCatalogItem("gods", {
        stableId: "pg-race-bless-race",
        name: "Race God Race",
        config: { blessingEffects: { Minor: [] } },
      }),
    ]
    const results = await Promise.allSettled(pending)
    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    const reason = (rejected[0] as PromiseRejectedResult).reason as {
      status?: number
      code?: string
    }
    expect(reason.status).toBe(409)
    expect([
      "catalog_stable_id_conflict",
      "catalog_serialization_conflict",
    ]).toContain(reason.code)
    // Track the winning god so cleanup can delete it.
    const winner = fulfilled[0] as PromiseFulfilledResult<{ id: string }>
    createdCatalogIds.push(winner.value.id)
  })

  it("concurrent equip vs remove-last-unit holds the ownership invariant (single winner, 409 loser)", async () => {
    const char = await createCharacter(
      {
        initialAttributes: enlightenedInitialAttributes,
        name: "Race Equip",
        description: "Concurrent equip vs remove",
        origin: "integrated",
        raceId: CATALOG.human,
        classId: CATALOG.archer,
        professionId: CATALOG.alchemist,
      },
      ownerUser
    )
    createdCharacterIds.push(char.id)
    // Seed exactly one owned unit of the equipment definition so both operations
    // start from the same physical state and the same character version.
    const seeded = await adjustCharacterInventory(
      char.id,
      {
        operation: "add",
        definitionId: CATALOG.gear1,
        quantity: 1,
        version: char.version,
        sourceNote: "seed race",
      },
      ownerUser
    )
    const version = seeded.version

    // Equip the item (associate add) and remove its final owned unit (inventory
    // remove) concurrently, both authorized and both starting from the SAME
    // character version. Both operations CAS the character version, so at most one
    // may commit; the loser must 409 (CAS / serialization / equipped).
    const results = await Promise.allSettled([
      associateCharacter(
        char.id,
        {
          kind: "equipment",
          definitionId: CATALOG.gear1,
          operation: "add",
          version,
        },
        ownerUser
      ),
      adjustCharacterInventory(
        char.id,
        {
          operation: "remove",
          definitionId: CATALOG.gear1,
          quantity: 1,
          version,
          sourceNote: "spend race",
        },
        adminUser
      ),
    ])
    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    const reason = (rejected[0] as PromiseRejectedResult).reason as {
      status?: number
      code?: string
    }
    // The loser is a 409 in the intended interleavings (CAS / serialization /
    // inventory_equipped). In the rare ordering where the equip observes the
    // already-committed removal it surfaces as a 400 inventory_insufficient
    // instead; either way exactly one operation wins and the invariant holds.
    if (reason.status === 409) {
      expect([
        "version_conflict",
        "catalog_serialization_conflict",
        "inventory_equipped",
      ]).toContain(reason.code)
    } else {
      expect(reason.status).toBe(400)
      expect(reason.code).toBe("inventory_insufficient")
    }

    // The ownership invariant must hold regardless of the race outcome: an
    // equipped item always retains at least one owned unit.
    const row = await prisma.character.findUnique({
      where: { id: char.id },
      include: {
        associations: { include: { definition: true } },
        inventory: { include: { definition: true } },
      },
    })
    const equipped = row!.associations.some(
      (a) => a.kind === "EQUIPMENT" && a.definitionId === CATALOG.gear1
    )
    const stock = row!.inventory.find((i) => i.definitionId === CATALOG.gear1)
    if (equipped) {
      expect(stock).toBeDefined()
      expect(stock!.quantity).toBeGreaterThanOrEqual(1)
    }
  })

  it("rejects a second BLESSING link on one character via the partial unique index", async () => {
    const char = await createCharacter(
      {
        initialAttributes: enlightenedInitialAttributes,
        name: "Blessing Singleton",
        origin: "integrated",
        raceId: CATALOG.human,
        classId: CATALOG.archer,
        professionId: CATALOG.alchemist,
      },
      ownerUser
    )
    createdCharacterIds.push(char.id)

    await associateCharacter(
      char.id,
      {
        kind: "blessing",
        definitionId: CATALOG.pgGod1,
        tier: "Minor",
        operation: "add",
        version: char.version,
      },
      ownerUser
    )

    // A second, different god for the SAME character. The migration's partial
    // unique index (at most one BLESSING link per character) must reject it with a
    // P2002 unique-violation on the character id.
    const other = await createCatalogItem("gods", {
      stableId: "pg-bless-singleton",
      name: "PG Blessing Singleton Other",
      config: { blessingEffects: { Minor: [] } },
    })
    createdCatalogIds.push(other.id)
    await expect(
      prisma.characterAssociation.create({
        data: {
          characterId: char.id,
          definitionId: other.id,
          kind: "BLESSING",
          // The DB CHECK (migration 0019) requires a BLESSING link to carry a
          // non-null tier, so provide one; the partial unique index should then
          // reject the second link on the character id as the intended P2002.
          blessingTier: "Minor",
        },
      })
    ).rejects.toMatchObject({ code: "P2002" })

    // Only the single original link remains.
    const links = await prisma.characterAssociation.findMany({
      where: { characterId: char.id, kind: "BLESSING" },
    })
    expect(links).toHaveLength(1)
    expect(links[0].definitionId).toBe(CATALOG.pgGod1)
  })

  it("rejects a backup carrying an active + archived blessing pair (singleton) and writes nothing", async () => {
    // Create an archived god so the backup can reference it as a blessing god.
    const arch = await createCatalogItem("gods", {
      stableId: "pg-bless-arch",
      name: "PG Blessing Archived",
      config: { blessingEffects: { Minor: [] } },
    })
    createdCatalogIds.push(arch.id)
    await prisma.catalogDefinition.update({
      where: { id: arch.id },
      data: { archived: true },
    })

    const before = await prisma.character.count({
      where: { ownerId: ownerUser.id },
    })

    const doc = {
      schema: IMPORT_SCHEMA_V7,
      rulesetVersion: IMPORT_RULESET_VERSION,
      identity: {
        name: "Imported Singleton",
        description: null,
        origin: "integrated",
        race: { stableId: "human" },
        class: { stableId: "archer" },
        profession: null,
      },
      state: serializeState(createInitialState("integrated", null, null)),
      liveState: {},
      status: {},
      associations: [
        {
          kind: "blessing",
          definition: { kind: "gods", stableId: "pg-god-1" },
          tier: "Minor",
        },
        {
          kind: "blessing",
          definition: { kind: "gods", stableId: "pg-bless-arch" },
          tier: "Minor",
        },
      ],
      inventory: [],
      events: [],
      skillOffers: [],
    } as CharacterImportDocument

    await expect(importCharacter(doc, ownerUser)).rejects.toMatchObject({
      status: 400,
      code: "import_link_collision",
    })

    // The failed import committed nothing: no character row was created.
    const after = await prisma.character.count({
      where: { ownerId: ownerUser.id },
    })
    expect(after).toBe(before)
    const assocCount = await prisma.characterAssociation.count({
      where: { kind: "BLESSING" },
    })
    expect(assocCount).toBeGreaterThanOrEqual(1) // only the source round-trip's link
  })

  /** Strip the per-link ring position from every equipment association in a doc. */
  function stripRingPositions(
    doc: CharacterImportDocument
  ): CharacterImportDocument {
    const associations = (
      doc.associations as Array<Record<string, unknown>>
    ).map((a) =>
      a.kind === "equipment" ? { ...a, equipmentPosition: undefined } : a
    )
    return { ...doc, associations } as CharacterImportDocument
  }

  it("round-trips two distinct Ring 1 / Ring 2 links through v5 export/import preserving positions", async () => {
    const src = await createCharacter(
      {
        initialAttributes: enlightenedInitialAttributes,
        name: "Ring Hero",
        description: "two rings",
        origin: "integrated",
        raceId: CATALOG.human,
        classId: CATALOG.archer,
        professionId: CATALOG.alchemist,
      },
      ownerUser
    )
    createdCharacterIds.push(src.id)

    await seedCatalog("catalog-ring-1", "equipment", "ring-1", "Band One", {
      slot: "Ring",
      bonus: { strength: 2 },
    })
    await seedCatalog("catalog-ring-2", "equipment", "ring-2", "Band Two", {
      slot: "Ring",
      bonus: { strength: 3 },
    })

    const inv1 = await adjustCharacterInventory(
      src.id,
      {
        operation: "add",
        definitionId: "catalog-ring-1",
        quantity: 1,
        version: 0,
        sourceNote: "seed",
      },
      ownerUser
    )
    const inv2 = await adjustCharacterInventory(
      src.id,
      {
        operation: "add",
        definitionId: "catalog-ring-2",
        quantity: 1,
        version: inv1.version,
        sourceNote: "seed",
      },
      ownerUser
    )
    const eq1 = await associateCharacter(
      src.id,
      {
        kind: "equipment",
        definitionId: "catalog-ring-1",
        operation: "add",
        version: inv2.version,
        equipmentPosition: "Ring 1",
      },
      ownerUser
    )
    await associateCharacter(
      src.id,
      {
        kind: "equipment",
        definitionId: "catalog-ring-2",
        operation: "add",
        version: eq1.character.version,
        equipmentPosition: "Ring 2",
      },
      ownerUser
    )

    const doc = (await exportCharacter(
      src.id,
      ownerUser
    )) as unknown as CharacterImportDocument
    expect(doc.schema).toBe(IMPORT_SCHEMA_V8)
    const ringAssocs = (
      doc.associations as Array<{
        kind: string
        equipmentPosition?: string | null
        definition: { stableId: string }
      }>
    ).filter((a) => a.kind === "equipment")
    expect(ringAssocs).toHaveLength(2)
    expect(
      ringAssocs.find((a) => a.definition.stableId === "ring-1")
        ?.equipmentPosition
    ).toBe("Ring 1")
    expect(
      ringAssocs.find((a) => a.definition.stableId === "ring-2")
        ?.equipmentPosition
    ).toBe("Ring 2")

    const imported = await importCharacter(doc, adminUser)
    createdCharacterIds.push(imported.id)
    expect(imported.associations).toHaveLength(2)
    const a1 = imported.associations.find(
      (a) => a.definitionId === "catalog-ring-1"
    )!
    const a2 = imported.associations.find(
      (a) => a.definitionId === "catalog-ring-2"
    )!
    expect(a1).toMatchObject({
      kind: "equipment",
      slot: "Ring",
      equipmentPosition: "Ring 1",
    })
    expect(a2).toMatchObject({
      kind: "equipment",
      slot: "Ring",
      equipmentPosition: "Ring 2",
    })

    const stored = await prisma.characterAssociation.findMany({
      where: { characterId: imported.id, kind: "EQUIPMENT" },
    })
    expect(
      stored.find((s) => s.definitionId === "catalog-ring-1")?.equipmentPosition
    ).toBe("Ring 1")
    expect(
      stored.find((s) => s.definitionId === "catalog-ring-2")?.equipmentPosition
    ).toBe("Ring 2")
  })

  it("rejects a v5 backup carrying two rings in the same active position (import_link_collision)", async () => {
    const src = await createCharacter(
      {
        initialAttributes: enlightenedInitialAttributes,
        name: "Ring Collide",
        description: "both at Ring 1",
        origin: "integrated",
        raceId: CATALOG.human,
        classId: CATALOG.archer,
        professionId: CATALOG.alchemist,
      },
      ownerUser
    )
    createdCharacterIds.push(src.id)

    await seedCatalog("catalog-ring-a", "equipment", "ring-a", "Ring A", {
      slot: "Ring",
      bonus: { strength: 1 },
    })
    await seedCatalog("catalog-ring-b", "equipment", "ring-b", "Ring B", {
      slot: "Ring",
      bonus: { strength: 2 },
    })
    // Two rings occupying the SAME physical position (grandfathered, so no stock).
    await prisma.characterAssociation.create({
      data: {
        characterId: src.id,
        definitionId: "catalog-ring-a",
        kind: "EQUIPMENT",
        legacyUnowned: true,
        equipmentPosition: "Ring 1",
      },
    })
    await prisma.characterAssociation.create({
      data: {
        characterId: src.id,
        definitionId: "catalog-ring-b",
        kind: "EQUIPMENT",
        legacyUnowned: true,
        equipmentPosition: "Ring 1",
      },
    })

    const doc = (await exportCharacter(
      src.id,
      ownerUser
    )) as unknown as CharacterImportDocument
    await expect(importCharacter(doc, adminUser)).rejects.toMatchObject({
      status: 400,
      code: "import_link_collision",
    })
  })

  it("rejects a backup carrying a Ring link with no position (import_ring_position_required)", async () => {
    const src = await createCharacter(
      {
        initialAttributes: enlightenedInitialAttributes,
        name: "Ring No Pos",
        description: "canonical Ring, no position",
        origin: "integrated",
        raceId: CATALOG.human,
        classId: CATALOG.archer,
        professionId: CATALOG.alchemist,
      },
      ownerUser
    )
    createdCharacterIds.push(src.id)

    await seedCatalog(
      "catalog-ring-nopos",
      "equipment",
      "ring-nopos",
      "No Position Band",
      { slot: "Ring", bonus: { strength: 2 } }
    )
    const inv = await adjustCharacterInventory(
      src.id,
      {
        operation: "add",
        definitionId: "catalog-ring-nopos",
        quantity: 1,
        version: 0,
        sourceNote: "seed",
      },
      ownerUser
    )
    await associateCharacter(
      src.id,
      {
        kind: "equipment",
        definitionId: "catalog-ring-nopos",
        operation: "add",
        version: inv.version,
        equipmentPosition: "Ring 1",
      },
      ownerUser
    )

    const doc = (await exportCharacter(
      src.id,
      ownerUser
    )) as unknown as CharacterImportDocument
    const stripped = stripRingPositions(doc)
    // Simulate a v3/v4 backup (no equipmentPosition field) exercising the trust-
    // nothing-liveState rule: a generic Ring slot with no position is rejected.
    const v3 = {
      ...stripped,
      schema: IMPORT_SCHEMA_V3,
    } as CharacterImportDocument
    await expect(importCharacter(v3, adminUser)).rejects.toMatchObject({
      status: 400,
      code: "import_ring_position_required",
    })
  })

  it("derives a ring position from a legacy Ring 1 catalog slot on a v3/v4 backup with no position in the doc", async () => {
    const src = await createCharacter(
      {
        initialAttributes: enlightenedInitialAttributes,
        name: "Ring Legacy Slot",
        description: "legacy slot derives position",
        origin: "integrated",
        raceId: CATALOG.human,
        classId: CATALOG.archer,
        professionId: CATALOG.alchemist,
      },
      ownerUser
    )
    createdCharacterIds.push(src.id)

    await seedCatalog(
      "catalog-ring-legacy",
      "equipment",
      "ring-legacy",
      "Legacy Band",
      { slot: "Ring 1", bonus: { strength: 2 } }
    )
    // A grandfathered link with no persisted position: the export falls back to the
    // legacy catalog slot, and the v3/v4 import path must derive the same position
    // rather than trusting the advisory liveState.
    await prisma.characterAssociation.create({
      data: {
        characterId: src.id,
        definitionId: "catalog-ring-legacy",
        kind: "EQUIPMENT",
        legacyUnowned: true,
        equipmentPosition: null,
      },
    })

    const doc = (await exportCharacter(
      src.id,
      ownerUser
    )) as unknown as CharacterImportDocument
    // The export already recovered the position from the legacy slot.
    const exportedRing = (
      doc.associations as Array<{
        kind: string
        equipmentPosition?: string | null
      }>
    ).find((a) => a.kind === "equipment")
    expect(exportedRing?.equipmentPosition).toBe("Ring 1")

    // Simulate a v3 backup and a v4 backup (no per-link position field). Both must
    // derive the position from the CURRENT catalog's legacy Ring 1 slot rather
    // than trusting the advisory liveState.
    const v4 = {
      ...stripRingPositions(doc),
      schema: IMPORT_SCHEMA_V4,
    } as CharacterImportDocument
    const importedV4 = await importCharacter(v4, adminUser)
    createdCharacterIds.push(importedV4.id)
    expect(importedV4.associations).toHaveLength(1)
    expect(importedV4.associations[0]).toMatchObject({
      kind: "equipment",
      slot: "Ring",
      equipmentPosition: "Ring 1",
    })
    const storedV4 = await prisma.characterAssociation.findFirst({
      where: {
        characterId: importedV4.id,
        definitionId: "catalog-ring-legacy",
      },
    })
    expect(storedV4?.equipmentPosition).toBe("Ring 1")

    const v3 = {
      ...stripRingPositions(doc),
      schema: IMPORT_SCHEMA_V3,
    } as CharacterImportDocument
    const importedV3 = await importCharacter(v3, adminUser)
    createdCharacterIds.push(importedV3.id)
    expect(importedV3.associations).toHaveLength(1)
    expect(importedV3.associations[0]).toMatchObject({
      kind: "equipment",
      slot: "Ring",
      equipmentPosition: "Ring 1",
    })
    const storedV3 = await prisma.characterAssociation.findFirst({
      where: {
        characterId: importedV3.id,
        definitionId: "catalog-ring-legacy",
      },
    })
    expect(storedV3?.equipmentPosition).toBe("Ring 1")
  })

  it("recovers a Ring 2 position from a v4 backup definition.config.slot snapshot after the current catalog slot migrated to Ring", async () => {
    // A pre-migration backup: the source catalog still named the slot "Ring 2"
    // (the definition reference carries that config snapshot), but the CURRENT
    // catalog slot has been migrated to the single canonical "Ring". The v3/v4
    // import path must recover the position from the snapshot, not the advisory
    // liveState, and the recovered position must survive a v5 export.
    await seedCatalog(
      "catalog-ring-snap-1",
      "equipment",
      "ring-snap-1",
      "Ring Snap One",
      { slot: "Ring", bonus: { strength: 2 } }
    )

    const doc = {
      schema: IMPORT_SCHEMA_V4,
      rulesetVersion: IMPORT_RULESET_VERSION,
      identity: {
        name: "Ring Snap V4",
        description: null,
        origin: "integrated",
        race: { stableId: "human" },
        class: { stableId: "archer" },
        profession: null,
      },
      state: serializeState(createInitialState("integrated", null, null)),
      liveState: {},
      status: {},
      associations: [
        {
          kind: "equipment",
          definition: {
            kind: "equipment",
            stableId: "ring-snap-1",
            config: { slot: "Ring 2" },
          },
          legacyUnowned: true,
        },
      ],
      inventory: [],
      events: [],
      skillOffers: [],
    } as CharacterImportDocument

    const imported = await importCharacter(doc, adminUser)
    createdCharacterIds.push(imported.id)
    expect(imported.associations).toHaveLength(1)
    expect(imported.associations[0]).toMatchObject({
      kind: "equipment",
      slot: "Ring",
      equipmentPosition: "Ring 2",
    })
    const stored = await prisma.characterAssociation.findFirst({
      where: {
        characterId: imported.id,
        definitionId: "catalog-ring-snap-1",
      },
    })
    expect(stored?.equipmentPosition).toBe("Ring 2")

    // The recovered position survives a v5 re-export.
    const exported = (await exportCharacter(
      imported.id,
      adminUser
    )) as unknown as CharacterImportDocument
    expect(exported.schema).toBe(IMPORT_SCHEMA_V8)
    const eq = (
      exported.associations as Array<{
        kind: string
        equipmentPosition?: string | null
      }>
    ).find((a) => a.kind === "equipment")
    expect(eq?.equipmentPosition).toBe("Ring 2")
  })

  it("recovers a Ring 2 position from a v3 backup definition.config.slot snapshot after the current catalog slot migrated to Ring", async () => {
    await seedCatalog(
      "catalog-ring-snap-2",
      "equipment",
      "ring-snap-2",
      "Ring Snap Two",
      { slot: "Ring", bonus: { strength: 2 } }
    )

    const doc = {
      schema: IMPORT_SCHEMA_V3,
      rulesetVersion: IMPORT_RULESET_VERSION,
      identity: {
        name: "Ring Snap V3",
        description: null,
        origin: "integrated",
        race: { stableId: "human" },
        class: { stableId: "archer" },
        profession: null,
      },
      state: serializeState(createInitialState("integrated", null, null)),
      liveState: {},
      status: {},
      associations: [
        {
          kind: "equipment",
          definition: {
            kind: "equipment",
            stableId: "ring-snap-2",
            config: { slot: "Ring 2" },
          },
        },
      ],
      events: [],
      skillOffers: [],
    } as CharacterImportDocument

    const imported = await importCharacter(doc, adminUser)
    createdCharacterIds.push(imported.id)
    expect(imported.associations).toHaveLength(1)
    expect(imported.associations[0]).toMatchObject({
      kind: "equipment",
      slot: "Ring",
      equipmentPosition: "Ring 2",
    })
    const stored = await prisma.characterAssociation.findFirst({
      where: {
        characterId: imported.id,
        definitionId: "catalog-ring-snap-2",
      },
    })
    expect(stored?.equipmentPosition).toBe("Ring 2")
  })

  it("rejects a Ring link with no position and no definition.config snapshot (import_ring_position_required)", async () => {
    await seedCatalog(
      "catalog-ring-snap-3",
      "equipment",
      "ring-snap-3",
      "Ring Snap Three",
      { slot: "Ring", bonus: { strength: 2 } }
    )

    const doc = {
      schema: IMPORT_SCHEMA_V4,
      rulesetVersion: IMPORT_RULESET_VERSION,
      identity: {
        name: "Ring Snap No Snapshot",
        description: null,
        origin: "integrated",
        race: { stableId: "human" },
        class: { stableId: "archer" },
        profession: null,
      },
      state: serializeState(createInitialState("integrated", null, null)),
      liveState: {},
      status: {},
      associations: [
        {
          kind: "equipment",
          definition: { kind: "equipment", stableId: "ring-snap-3" },
          legacyUnowned: true,
        },
      ],
      inventory: [],
      events: [],
      skillOffers: [],
    } as CharacterImportDocument

    await expect(importCharacter(doc, adminUser)).rejects.toMatchObject({
      status: 400,
      code: "import_ring_position_required",
    })
  })

  it("rejects a Ring link whose definition.config.slot snapshot is a non-ring slot (import_ring_position_required)", async () => {
    await seedCatalog(
      "catalog-ring-snap-4",
      "equipment",
      "ring-snap-4",
      "Ring Snap Four",
      { slot: "Ring", bonus: { strength: 2 } }
    )

    const doc = {
      schema: IMPORT_SCHEMA_V4,
      rulesetVersion: IMPORT_RULESET_VERSION,
      identity: {
        name: "Ring Snap Forged Slot",
        description: null,
        origin: "integrated",
        race: { stableId: "human" },
        class: { stableId: "archer" },
        profession: null,
      },
      state: serializeState(createInitialState("integrated", null, null)),
      liveState: {},
      status: {},
      associations: [
        {
          kind: "equipment",
          definition: {
            kind: "equipment",
            stableId: "ring-snap-4",
            config: { slot: "Head" },
          },
          legacyUnowned: true,
        },
      ],
      inventory: [],
      events: [],
      skillOffers: [],
    } as CharacterImportDocument

    await expect(importCharacter(doc, adminUser)).rejects.toMatchObject({
      status: 400,
      code: "import_ring_position_required",
    })
  })

  it("defaults a v5 backup's skill offer to generation 0 / canceledAt null (back-compat)", async () => {
    const doc = {
      schema: IMPORT_SCHEMA_V5,
      rulesetVersion: IMPORT_RULESET_VERSION,
      identity: {
        name: "V5 Hero",
        description: null,
        origin: "integrated",
        race: { stableId: "human" },
        class: { stableId: "archer" },
        profession: null,
      },
      state: serializeState(createInitialState("integrated", null, null)),
      liveState: {},
      status: {},
      associations: [],
      inventory: [],
      events: [],
      // A legacy v5 offer omits `generation` and `canceledAt` entirely.
      skillOffers: [
        {
          track: "class",
          level: 1,
          choiceGroup: "standard",
          offeredAt: "2026-02-02T00:00:00.000Z",
          options: [
            {
              stableId: "skill-1",
              nameSnapshot: "Skill One",
              configSnapshot: {},
            },
          ],
        },
      ],
    } as CharacterImportDocument

    const imported = await importCharacter(doc, adminUser)
    createdCharacterIds.push(imported.id)

    const offer = await prisma.skillOffer.findFirst({
      where: { characterId: imported.id },
    })
    expect(offer).not.toBeNull()
    expect(offer!.generation).toBe(0)
    expect(offer!.canceledAt).toBeNull()
  })

  it("preserves a canceled offer's generation and canceledAt across a v6 backup round trip", async () => {
    const src = await createCharacter(
      {
        initialAttributes: enlightenedInitialAttributes,
        name: "Undo Hero",
        description: "v6 canceled offer round trip",
        origin: "integrated",
        raceId: CATALOG.human,
        classId: CATALOG.archer,
        professionId: null,
      },
      ownerUser
    )
    createdCharacterIds.push(src.id)

    // A voided (canceled) offer at generation 1. Append-only: it must survive the
    // backup export verbatim (never dropped, never rewritten).
    const canceledAt = new Date("2026-03-03T12:00:00.000Z")
    await prisma.skillOffer.create({
      data: {
        characterId: src.id,
        track: "class",
        level: 1,
        choiceGroup: "standard",
        generation: 1,
        canceledAt,
        selectedDefinitionId: null,
        offeredAt: new Date("2026-03-03T00:00:00.000Z"),
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

    const doc = (await exportCharacter(
      src.id,
      ownerUser
    )) as unknown as CharacterImportDocument
    expect(doc.schema).toBe(IMPORT_SCHEMA_V8)
    expect(doc.skillOffers).toHaveLength(1)
    const exportedOffer = doc.skillOffers[0]
    expect(exportedOffer.generation).toBe(1)
    expect(exportedOffer.canceledAt).toBe(canceledAt.toISOString())

    const imported = await importCharacter(doc, adminUser)
    createdCharacterIds.push(imported.id)

    const offer = await prisma.skillOffer.findFirst({
      where: { characterId: imported.id },
    })
    expect(offer).not.toBeNull()
    expect(offer!.generation).toBe(1)
    expect(offer!.canceledAt?.toISOString()).toBe(canceledAt.toISOString())
  })

  it("rejects a v6 backup with an invalid skill-offer canceledAt and commits nothing", async () => {
    const before = await prisma.character.count({
      where: { ownerId: adminUser.id },
    })
    const offersBefore = await prisma.skillOffer.count()
    const doc = {
      schema: IMPORT_SCHEMA_V6,
      rulesetVersion: IMPORT_RULESET_VERSION,
      identity: {
        name: "Invalid Canceled",
        description: null,
        origin: "integrated",
        race: { stableId: "human" },
        class: { stableId: "archer" },
        profession: null,
      },
      state: serializeState(createInitialState("integrated", null, null)),
      liveState: {},
      status: {},
      associations: [],
      inventory: [],
      events: [],
      skillOffers: [
        {
          track: "class",
          level: 1,
          choiceGroup: "standard",
          generation: 1,
          canceledAt: "not-a-date",
          options: [
            {
              stableId: "skill-1",
              nameSnapshot: "Skill One",
              configSnapshot: {},
            },
          ],
        },
      ],
    } as CharacterImportDocument

    await expect(importCharacter(doc, adminUser)).rejects.toMatchObject({
      status: 400,
      code: "invalid_import",
    })

    // The failed import committed nothing: no character, no offer row.
    const after = await prisma.character.count({
      where: { ownerId: adminUser.id },
    })
    expect(after).toBe(before)
    expect(await prisma.skillOffer.count()).toBe(offersBefore)
  })

  // ------------------------------------------------------------------ //
  // v8 currency balances
  // ------------------------------------------------------------------ //

  function v8ImportDoc(
    currencyBalances: unknown[],
    extra: Record<string, unknown> = {}
  ): CharacterImportDocument {
    return {
      schema: IMPORT_SCHEMA_V8,
      rulesetVersion: IMPORT_RULESET_VERSION,
      identity: {
        name: "Imported V8",
        description: null,
        origin: "integrated",
        race: { stableId: "human" },
        class: { stableId: "archer" },
        profession: null,
      },
      state: serializeState(createInitialState("integrated", null, null)),
      liveState: {},
      status: {},
      associations: [],
      inventory: [],
      events: [],
      skillOffers: [],
      currencyBalances,
      ...extra,
    } as CharacterImportDocument
  }

  async function expectImportRejects(
    doc: CharacterImportDocument,
    code: string,
    ownerId: string
  ): Promise<void> {
    const before = await prisma.character.count({ where: { ownerId } })
    const eventsBefore = await prisma.progressionEvent.count()
    await expect(importCharacter(doc, adminUser)).rejects.toMatchObject({
      status: 400,
      code,
    })
    const after = await prisma.character.count({ where: { ownerId } })
    expect(after).toBe(before)
    expect(await prisma.progressionEvent.count()).toBe(eventsBefore)
  }

  it("round-trips a v8 backup that carries inventory, a god blessing, and currency balances", async () => {
    const src = await createCharacter(
      {
        initialAttributes: enlightenedInitialAttributes,
        name: "V8 Wallet Hero",
        description: "v8 currency round trip",
        origin: "integrated",
        raceId: CATALOG.human,
        classId: CATALOG.archer,
        professionId: CATALOG.alchemist,
      },
      ownerUser
    )
    createdCharacterIds.push(src.id)

    // Owned stock + equipped (non-grandfathered) so the v8 inventory checks run,
    // plus a god blessing so the v8 association model is exercised.
    const inv = await adjustCharacterInventory(
      src.id,
      {
        operation: "add",
        definitionId: CATALOG.gear1,
        quantity: 1,
        version: 0,
        sourceNote: "seed v8 stock",
      },
      ownerUser
    )
    const equip = await associateCharacter(
      src.id,
      {
        kind: "equipment",
        definitionId: CATALOG.gear1,
        operation: "add",
        version: inv.version,
      },
      ownerUser
    )
    const bless = await associateCharacter(
      src.id,
      {
        kind: "blessing",
        definitionId: CATALOG.pgGod1,
        tier: "Minor",
        operation: "add",
        version: equip.character.version,
      },
      ownerUser
    )
    expect(bless.character.id).toBe(src.id)

    // A held balance on the ACTIVE currency, and a ZERO balance against the
    // ARCHIVED currency (created directly, since the owner-managed setter rejects
    // an archived definition). A hidden amount must survive the backup round trip.
    await prisma.characterCurrencyBalance.create({
      data: {
        characterId: src.id,
        definitionId: CATALOG.pgCurrency1,
        amount: 100,
      },
    })
    await prisma.characterCurrencyBalance.create({
      data: {
        characterId: src.id,
        definitionId: CATALOG.pgCurrency2,
        amount: 0,
      },
    })

    const doc = (await exportCharacter(
      src.id,
      ownerUser
    )) as unknown as CharacterImportDocument
    expect(doc.schema).toBe(IMPORT_SCHEMA_V8)
    const balances = (
      doc as {
        currencyBalances: Array<{
          definition: { kind: string; stableId: string }
          amount: number
        }>
      }
    ).currencyBalances
    expect(balances).toHaveLength(2)
    expect(balances).toContainEqual({
      definition: { kind: "currencies", stableId: "pg-currency-1" },
      amount: 100,
    })
    expect(balances).toContainEqual({
      definition: { kind: "currencies", stableId: "pg-currency-2" },
      amount: 0,
    })

    const imported = await importCharacter(doc, adminUser)
    createdCharacterIds.push(imported.id)

    expect(imported.associations).toHaveLength(2)
    expect(imported.inventory).toHaveLength(1)
    expect(imported.inventory[0].definitionId).toBe(CATALOG.gear1)

    const rows = await prisma.characterCurrencyBalance.findMany({
      where: { characterId: imported.id },
    })
    expect(rows).toHaveLength(2)
    expect(
      rows.find((r) => r.definitionId === CATALOG.pgCurrency1)?.amount
    ).toBe(100)
    expect(
      rows.find((r) => r.definitionId === CATALOG.pgCurrency2)?.amount
    ).toBe(0)

    const importEvent = await prisma.progressionEvent.findFirst({
      where: { characterId: imported.id, kind: "import" },
    })
    const payload = importEvent!.payload as Record<string, unknown>
    expect(payload.backupSchema).toBe(IMPORT_SCHEMA_V8)
    expect(payload.currencyBalanceCount).toBe(2)
  })

  it("caps NEW distinct balance rows at MAX_IMPORT_CURRENCIES and round-trips that exact count (archived included)", async () => {
    // Seed exactly MAX_IMPORT_CURRENCIES distinct currencies, archiving every other
    // one so the cap demonstrably counts ARCHIVED balances too (a hidden amount must
    // survive a backup round-trip).
    const currencyIds: string[] = []
    for (let i = 0; i < MAX_IMPORT_CURRENCIES; i++) {
      const id = `catalog-pg-cur-cap-${i}`
      await seedCatalog(
        id,
        "currencies",
        `pg-cur-cap-${i}`,
        `Cap Currency ${i}`,
        {}
      )
      currencyIds.push(id)
      if (i % 2 === 0) {
        await prisma.catalogDefinition.update({
          where: { id },
          data: { archived: true },
        })
      }
    }

    const src = await createCharacter(
      {
        initialAttributes: enlightenedInitialAttributes,
        name: "Cap Wallet",
        description: "cap boundary round trip",
        origin: "integrated",
        raceId: CATALOG.human,
        classId: CATALOG.archer,
        professionId: CATALOG.alchemist,
      },
      ownerUser
    )
    createdCharacterIds.push(src.id)

    for (let i = 0; i < MAX_IMPORT_CURRENCIES; i++) {
      await prisma.characterCurrencyBalance.create({
        data: {
          characterId: src.id,
          definitionId: currencyIds[i],
          amount: i,
        },
      })
    }

    // Exporting a character at the cap yields exactly MAX_IMPORT_CURRENCIES
    // balances, which is the v8 schema max, so a re-import always round-trips.
    const doc = (await exportCharacter(
      src.id,
      ownerUser
    )) as unknown as CharacterImportDocument
    const balances = (doc as unknown as { currencyBalances: unknown[] })
      .currencyBalances
    expect(balances).toHaveLength(MAX_IMPORT_CURRENCIES)

    const imported = await importCharacter(doc, adminUser)
    createdCharacterIds.push(imported.id)
    const rows = await prisma.characterCurrencyBalance.findMany({
      where: { characterId: imported.id },
    })
    expect(rows).toHaveLength(MAX_IMPORT_CURRENCIES)

    // The imported character is at the cap: a 501st distinct ACTIVE currency must
    // be rejected before any write.
    await seedCatalog(
      "catalog-pg-cur-cap-extra",
      "currencies",
      "pg-cur-cap-extra",
      "Cap Currency Extra",
      {}
    )
    await expect(
      setCharacterCurrencyBalance(
        imported.id,
        { definitionId: "catalog-pg-cur-cap-extra", amount: 1, version: 0 },
        adminUser
      )
    ).rejects.toMatchObject({ status: 409, code: "currency_defs_cap_exceeded" })

    // Updates and deletes of EXISTING rows remain allowed at the cap.
    const upd = await setCharacterCurrencyBalance(
      imported.id,
      { definitionId: currencyIds[1], amount: 9999, version: 0 },
      adminUser
    )
    expect(upd.version).toBe(1)
    const del = await setCharacterCurrencyBalance(
      imported.id,
      { definitionId: currencyIds[3], amount: null, version: 1 },
      adminUser
    )
    expect(del.version).toBe(2)
  })

  it("imports a legacy v7 document and produces no currency balances", async () => {
    const doc = {
      schema: IMPORT_SCHEMA_V7,
      rulesetVersion: IMPORT_RULESET_VERSION,
      identity: {
        name: "V7 No Balances",
        description: null,
        origin: "integrated",
        race: { stableId: "human" },
        class: { stableId: "archer" },
        profession: null,
      },
      state: serializeState(createInitialState("integrated", null, null)),
      liveState: {},
      status: {},
      associations: [],
      inventory: [],
      events: [],
      skillOffers: [],
    } as CharacterImportDocument

    const imported = await importCharacter(doc, adminUser)
    createdCharacterIds.push(imported.id)
    const rows = await prisma.characterCurrencyBalance.findMany({
      where: { characterId: imported.id },
    })
    expect(rows).toHaveLength(0)
  })

  it("rejects a v8 backup with a missing currency stableId (rollback)", async () => {
    await expectImportRejects(
      v8ImportDoc([
        {
          definition: { kind: "currencies", stableId: "ghost-currency" },
          amount: 5,
        },
      ]),
      "import_currency_missing",
      adminUser.id
    )
  })

  it("rejects a v8 backup with duplicate currency stableId references (rollback)", async () => {
    await expectImportRejects(
      v8ImportDoc([
        {
          definition: { kind: "currencies", stableId: "pg-currency-1" },
          amount: 1,
        },
        {
          definition: { kind: "currencies", stableId: "pg-currency-1" },
          amount: 2,
        },
      ]),
      "import_duplicate_currency",
      adminUser.id
    )
  })

  it("rejects a v8 backup that references a non-currency catalog entry as a currency (rollback)", async () => {
    // gear-1 is an EQUIPMENT catalog entry; referencing it as a currency is a
    // wrong-kind reference (the stableId exists, but under a different kind).
    await expectImportRejects(
      v8ImportDoc([
        {
          definition: { kind: "currencies", stableId: "gear-1" },
          amount: 5,
        },
      ]),
      "import_currency_wrong_kind",
      adminUser.id
    )
  })

  it("rejects a v8 backup whose currency definition kind is not 'currencies' (rollback)", async () => {
    await expectImportRejects(
      v8ImportDoc([
        {
          definition: { kind: "items", stableId: "pg-currency-1" },
          amount: 5,
        },
      ]),
      "import_currency_wrong_kind",
      adminUser.id
    )
  })

  it("rejects a v8 backup with an out-of-range currency amount (rollback)", async () => {
    await expectImportRejects(
      v8ImportDoc([
        {
          definition: { kind: "currencies", stableId: "pg-currency-1" },
          amount: -1,
        },
      ]),
      "import_currency_invalid",
      adminUser.id
    )
  })
})
