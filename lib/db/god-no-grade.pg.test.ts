/**
 * Real-Postgres test for migration 0020 (`0020_ungrade_gods`) and the resulting
 * invariant that a `gods` catalog entry carries no grade band.
 *
 * Migration 0020 runs `UPDATE catalog_definitions SET grade = NULL WHERE
 * kind = 'gods' AND grade IS NOT NULL`, clearing any stale grade on a god row
 * while preserving its config (e.g. `blessingEffects`) and any character /
 * association links to it. From here on every write/import boundary rejects a
 * non-null grade on a gods entry with 400 `invalid_grade`.
 *
 * A god fitted with a non-null grade plus a `blessingEffects` config and a
 * `BLESSING` character link is seeded directly via raw SQL to reproduce a
 * pre-0020 row (the service itself refuses to create one), then the exact
 * migration statement is applied and the grade is verified nulled while the
 * config and the link remain untouched. The service-level create/update guards
 * are exercised against the live database as well.
 *
 * Runs ONLY when explicitly opted in (see `resolveDbIntegration`); the database
 * must already have `prisma migrate deploy` applied (migration 0020 included).
 * Cleanup is strictly scoped to the ids this run creates.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { prisma } from "@/lib/db/client"
import {
  createCatalogItem,
  getCatalogItem,
  updateCatalogItem,
} from "@/lib/db/service"
import { resolveDbIntegration } from "@/lib/test/db-integration"

const gate = await resolveDbIntegration()

const userId = "pg-ungrade-user"
const characterId = "pg-ungrade-character"
const godDefId = "pg-ungrade-god"
const godStableId = "pg-ungrade-god"
const blessingLinkId = "pg-ungrade-bless"

// Ids created through the service (god rows); deleted in afterAll like every
// other id this run creates.
const createdServiceIds: string[] = []

async function seedUser() {
  await prisma.user.upsert({
    where: { email: "ungrade@test.local" },
    update: { id: userId },
    create: { id: userId, email: "ungrade@test.local", password: "x" },
  })
}

async function seedCharacter() {
  await prisma.character.create({
    data: {
      id: characterId,
      ownerId: userId,
      name: "Ungrade Check",
      state: {},
    },
  })
}

/**
 * A god row carrying a non-null grade plus a `blessingEffects` config, exactly
 * like a pre-0020 row. Inserted directly via raw SQL because the service layer
 * (correctly) rejects a non-null grade on create.
 */
async function seedGradedGod() {
  const config = {
    pantheon: "Void",
    divineRank: "God",
    blessingEffects: { True: [{ phase: "flat", amount: { strength: 5 } }] },
  }
  await prisma.$executeRaw`
    INSERT INTO "catalog_definitions"
      ("id", "kind", "stableId", "name", "grade", "config", "archived", "createdAt", "updatedAt")
    VALUES
      (${godDefId}, 'gods', ${godStableId}, 'Ungrade God', 'S', ${JSON.stringify(
        config
      )}::jsonb, false, now(), now())
  `
}

async function seedBlessingLink() {
  await prisma.characterAssociation.create({
    data: {
      id: blessingLinkId,
      characterId,
      definitionId: godDefId,
      kind: "BLESSING",
      blessingTier: "True",
    },
  })
}

describe.skipIf(!gate.run)(
  "migration 0020: gods carry no catalog grade",
  () => {
    beforeAll(async () => {
      await prisma.characterAssociation.deleteMany({
        where: { id: blessingLinkId },
      })
      await prisma.character.deleteMany({ where: { id: characterId } })
      await prisma.catalogDefinition.deleteMany({ where: { id: godDefId } })
      // It is safe to reuse a fixed run-specific god id only if no other row
      // occupies it; a leftover from a crashed run is deleted above, and the
      // service-created rows use fresh random stableIds so they never collide.
      await seedUser()
      await seedCharacter()
      await seedGradedGod()
      await seedBlessingLink()
    })

    afterAll(async () => {
      await prisma.characterAssociation.deleteMany({
        where: { id: blessingLinkId },
      })
      await prisma.character.deleteMany({ where: { id: characterId } })
      await prisma.catalogDefinition.deleteMany({
        where: { id: { in: [godDefId, ...createdServiceIds] } },
      })
      await prisma.user.deleteMany({ where: { id: userId } })
    })

    it("records migration 0020 as applied", async () => {
      const rows = await prisma.$queryRaw<Array<{ migration_name: string }>>`
      SELECT "migration_name" FROM "_prisma_migrations"
      WHERE "migration_name" LIKE '0020%'
    `
      expect(rows).toHaveLength(1)
    })

    it("the migration UPDATE clears a pre-existing god grade while preserving config and links", async () => {
      // Precondition: the seeded god carries a non-null grade.
      const before = await prisma.catalogDefinition.findUnique({
        where: { id: godDefId },
      })
      expect(before?.grade).toBe("S")
      expect(before?.config).toMatchObject({
        pantheon: "Void",
        blessingEffects: { True: [{ phase: "flat", amount: { strength: 5 } }] },
      })

      // Run the exact migration statement for a gods row.
      await prisma.$executeRaw`
      UPDATE "catalog_definitions"
      SET "grade" = NULL
      WHERE "kind" = 'gods' AND "grade" IS NOT NULL
    `

      const after = await prisma.catalogDefinition.findUnique({
        where: { id: godDefId },
      })
      expect(after?.grade).toBeNull()
      expect(after?.config).toEqual({
        pantheon: "Void",
        divineRank: "God",
        blessingEffects: { True: [{ phase: "flat", amount: { strength: 5 } }] },
      })

      // The character association link is preserved untouched.
      const link = await prisma.characterAssociation.findUnique({
        where: { id: blessingLinkId },
      })
      expect(link).not.toBeNull()
      expect(link?.definitionId).toBe(godDefId)
      expect(link?.blessingTier).toBe("True")
    })

    it("a god GET reads back grade null after migration", async () => {
      const item = await getCatalogItem("gods", godDefId)
      expect(item.grade).toBeNull()
    })

    it("rejects a gods create that carries a non-null grade", async () => {
      await expect(
        createCatalogItem("gods", {
          stableId: `pg-ungrade-bad-${randomUUID()}`,
          name: "Bad Create God",
          grade: "S",
          config: {},
        })
      ).rejects.toMatchObject({ status: 400, code: "invalid_grade" })
    })

    it("creates a gods entry with no grade and reads it back null", async () => {
      const item = await createCatalogItem("gods", {
        stableId: `pg-ungrade-ok-${randomUUID()}`,
        name: "Ok Create God",
        config: {},
      })
      createdServiceIds.push(item.id)
      expect(item.grade).toBeNull()
    })

    it("rejects a gods PATCH that sets a non-null grade and leaves the row unchanged", async () => {
      const item = await createCatalogItem("gods", {
        stableId: `pg-ungrade-patch-${randomUUID()}`,
        name: "Patch God",
        config: {},
      })
      createdServiceIds.push(item.id)

      await expect(
        updateCatalogItem("gods", item.id, { grade: "A" })
      ).rejects.toMatchObject({ status: 400, code: "invalid_grade" })

      const row = await prisma.catalogDefinition.findUnique({
        where: { id: item.id },
      })
      expect(row?.grade).toBeNull()
    })

    it("allows a metadata-only PATCH on a migrated god (grade stays null)", async () => {
      const item = await createCatalogItem("gods", {
        stableId: `pg-ungrade-meta-${randomUUID()}`,
        name: "Meta God",
        grade: null,
        config: {},
      })
      createdServiceIds.push(item.id)

      const patched = await updateCatalogItem("gods", item.id, {
        name: "Renamed Meta God",
      })
      expect(patched.name).toBe("Renamed Meta God")
      expect(patched.grade).toBeNull()
    })
  }
)
