/**
 * Real-Postgres test for the migration 0019 database CHECK constraint on
 * `character_associations` (`character_associations_blessing_tier_check`).
 *
 * The constraint enforces the blessing-tier invariant at the database layer: a
 * `BLESSING` link must always carry a non-null `blessingTier`, while every other
 * kind must carry a null `blessingTier`. The application (schema + service)
 * enforces the same rule, but this test proves the MIGRATION itself created a
 * working constraint, so a null-tier blessing link can never be written even by
 * a caller that bypasses the service.
 *
 * Runs ONLY when explicitly opted in (see `resolveDbIntegration`), same as every
 * other `.pg.test.ts` file; the database must already have `prisma migrate
 * deploy` applied (migration 0019 included). Cleanup is strictly scoped to the
 * ids this run creates.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { prisma } from "@/lib/db/client"
import { resolveDbIntegration } from "@/lib/test/db-integration"

const gate = await resolveDbIntegration()

const userId = "pg-blessing-check-user"
const characterId = "pg-blessing-check-character"
// Two distinct catalog definitions so the (characterId, definitionId) unique
// allows one BLESSING row and one TITLE row to coexist: the DB CHECK does not
// care which definition kind each association kind points at (that is an
// application concern), so a `titles` definition is fine for a TITLE row.
const godDefId = "pg-blessing-check-god"
const titleDefId = "pg-blessing-check-title"

async function seedUser() {
  await prisma.user.upsert({
    where: { email: "blessing-check@test.local" },
    update: { id: userId },
    create: { id: userId, email: "blessing-check@test.local", password: "x" },
  })
}

async function seedCharacter() {
  await prisma.character.create({
    data: {
      id: characterId,
      ownerId: userId,
      name: "Blessing Check",
      state: {},
    },
  })
}

async function seedDefinitions() {
  await prisma.catalogDefinition.create({
    data: {
      id: godDefId,
      kind: "gods",
      stableId: "pg-blessing-check-god",
      name: "Blessing Check God",
      config: {},
    },
  })
  await prisma.catalogDefinition.create({
    data: {
      id: titleDefId,
      kind: "titles",
      stableId: "pg-blessing-check-title",
      name: "Blessing Check Title",
      config: {},
    },
  })
}

describe.skipIf(!gate.run)(
  "migration 0019 blessing-tier CHECK constraint",
  () => {
    beforeAll(async () => {
      await prisma.character.deleteMany({ where: { id: characterId } })
      await prisma.catalogDefinition.deleteMany({
        where: { id: { in: [godDefId, titleDefId] } },
      })
      await seedUser()
      await seedCharacter()
      await seedDefinitions()
    })

    afterAll(async () => {
      await prisma.character.deleteMany({ where: { id: characterId } })
      await prisma.catalogDefinition.deleteMany({
        where: { id: { in: [godDefId, titleDefId] } },
      })
      await prisma.user.deleteMany({ where: { id: userId } })
    })

    it("adds the database CHECK constraint on character_associations", async () => {
      const rows = await prisma.$queryRaw<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = '"character_associations"'::regclass
        AND contype = 'c'
        AND conname = 'character_associations_blessing_tier_check'
    `
      expect(rows).toHaveLength(1)
    })

    it("rejects a BLESSING link with a null blessingTier", async () => {
      await expect(
        prisma.$executeRaw`
        INSERT INTO "character_associations"
          ("id", "characterId", "definitionId", "kind", "blessingTier")
        VALUES
          ('pg-bless-null', ${characterId}, ${godDefId}, 'BLESSING', NULL)
      `
      ).rejects.toThrow()
    })

    it("accepts a BLESSING link with a non-null blessingTier", async () => {
      await expect(
        prisma.$executeRaw`
        INSERT INTO "character_associations"
          ("id", "characterId", "definitionId", "kind", "blessingTier")
        VALUES
          ('pg-bless-valid', ${characterId}, ${godDefId}, 'BLESSING', 'Minor'::"BlessingTier")
      `
      ).resolves.toBe(1)
    })

    it("accepts a non-BLESSING link with a null blessingTier", async () => {
      await expect(
        prisma.$executeRaw`
        INSERT INTO "character_associations"
          ("id", "characterId", "definitionId", "kind", "blessingTier")
        VALUES
          ('pg-t-null', ${characterId}, ${titleDefId}, 'TITLE', NULL)
      `
      ).resolves.toBe(1)
    })

    it("rejects a non-BLESSING link that leaks a blessingTier", async () => {
      await expect(
        prisma.$executeRaw`
        INSERT INTO "character_associations"
          ("id", "characterId", "definitionId", "kind", "blessingTier")
        VALUES
          ('pg-tier-leak', ${characterId}, ${titleDefId}, 'TITLE', 'Minor'::"BlessingTier")
      `
      ).rejects.toThrow()
    })
  }
)
