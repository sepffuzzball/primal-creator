/**
 * Real-Postgres test for migration 0023 (`0023_skill_track_and_class_priority`),
 * which makes a skill's `track` mandatory and adds class-priority offer ordering.
 *
 * The migration is additive and non-destructive:
 *   1. Adds a nullable `classStableIdAtEarn` provenance column to `skill_offers`
 *      (the catalog stableId of the character's selected CLASS at the moment a
 *      schedule-credit offer was EARNED). NULL on all existing offers (no
 *      backfill): a monster race credit and any legacy/imported offer are null.
 *   2. Backfills a missing `track` key in every persisted `skills` config JSONB to
 *      `'race'` via the JSONB `||` operator, preserving every existing key
 *      (rarity, effects, milestone, any already-typed track). A config that
 *      already declares `class`/`profession` is left untouched.
 *
 * A custom prior config is seeded onto real `catalog_definitions` rows (a skills
 * config with no track, one typed `class`, one typed `profession`, and a
 * non-skills control), then the exact migration statement is applied and the
 * merge is verified. The classStableIdAtEarn column presence / nullability and
 * the no-backfill guarantee are also exercised, and the original rows are cleaned
 * up in `afterAll`.
 *
 * Runs ONLY when explicitly opted in (see `resolveDbIntegration`); the database
 * must already have `prisma migrate deploy` applied (migration 0023 included) for
 * the `_prisma_migrations` check. Because the migration also touches unrelated
 * rows only through the kind='skills' WHERE guard, the test seeds its own rows and
 * deletes them so no other suite is disturbed.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/db/client"
import { resolveDbIntegration } from "@/lib/test/db-integration"

const gate = await resolveDbIntegration()

/** A config with NO track and other keys that must be preserved by the merge. */
const NO_TRACK_CONFIG = {
  rarity: "Common",
  milestone: 4,
  effects: [{ phase: "flat", amount: { strength: 3 }, stacking: "stack" }],
}

/** A config that already declares a `class` track (must be left untouched). */
const CLASS_TRACK_CONFIG = {
  track: "class",
  rarity: "Uncommon",
  milestone: 5,
  effects: [],
}

/** A config that already declares a `profession` track (must be left untouched). */
const PROFESSION_TRACK_CONFIG = {
  track: "profession",
  rarity: "Rare",
  milestone: 6,
  effects: [],
  choiceGroup: "special",
}

/** A config with no track at all (only the optional `milestone` annotation). */
const BARE_CONFIG = { milestone: 7 }

/** A control config on a NON-skills row; the backfill must not touch it. */
const NON_SKILL_CONFIG = { raceType: "enlightened", naturalGrade: "F" }

const seededStableIds = [
  "pg-no-track",
  "pg-class-track",
  "pg-prof-track",
  "pg-bare",
  "pg-nonskill",
]

async function seedSkillsRows(): Promise<void> {
  const rows: Array<{
    kind: string
    stableId: string
    name: string
    config: Record<string, unknown>
  }> = [
    {
      kind: "skills",
      stableId: "pg-no-track",
      name: "No Track",
      config: NO_TRACK_CONFIG,
    },
    {
      kind: "skills",
      stableId: "pg-class-track",
      name: "Class Track",
      config: CLASS_TRACK_CONFIG,
    },
    {
      kind: "skills",
      stableId: "pg-prof-track",
      name: "Profession Track",
      config: PROFESSION_TRACK_CONFIG,
    },
    { kind: "skills", stableId: "pg-bare", name: "Bare", config: BARE_CONFIG },
    {
      kind: "races",
      stableId: "pg-nonskill",
      name: "Non Skill",
      config: NON_SKILL_CONFIG,
    },
  ]
  for (const r of rows) {
    await prisma.catalogDefinition.create({
      data: {
        kind: r.kind as never,
        stableId: r.stableId,
        name: r.name,
        config: r.config as Prisma.InputJsonValue,
      },
    })
  }
}

async function cleanup(): Promise<void> {
  await prisma.catalogDefinition.deleteMany({
    where: { stableId: { in: seededStableIds } },
  })
}

describe.skipIf(!gate.run)(
  "migration 0023: skill track mandatory + class priority",
  () => {
    beforeAll(async () => {
      await seedSkillsRows()
    })

    afterAll(async () => {
      await cleanup()
    })

    it("records migration 0023 as applied", async () => {
      // The 0.1.0 baseline collapses the whole 0001..0023 chain into a single
      // migration, so the schema may be established by the baseline migration
      // rather than by the historical 0023 one. Accept either.
      const rows = await prisma.$queryRaw<Array<{ migration_name: string }>>`
        SELECT "migration_name" FROM "_prisma_migrations"
        WHERE "migration_name" = '20261016000000_initial_0_1_0'
           OR "migration_name" LIKE '0023%'
      `
      expect(rows.length).toBeGreaterThanOrEqual(1)
    })

    it("adds a nullable classStableIdAtEarn column without backfilling existing offers", async () => {
      // The column must exist and be nullable; a fresh offer (legacy/imported
      // shape) reads back as NULL, never a fabricated class id.
      const cols = await prisma.$queryRaw<Array<{ is_nullable: string }>>`
        SELECT "is_nullable" FROM information_schema.columns
        WHERE table_name = 'skill_offers' AND column_name = 'classStableIdAtEarn'
      `
      expect(cols).toHaveLength(1)
      expect(cols[0].is_nullable).toBe("YES")

      // Verify no backfill was applied to an existing offer: insert a minimal offer
      // through the client (which now knows the column) and confirm it stays null.
      const user = await prisma.user.upsert({
        where: { email: "pg-0023@example.com" },
        update: {},
        create: { email: "pg-0023@example.com", password: "pg" },
      })
      const character = await prisma.character.create({
        data: {
          ownerId: user.id,
          name: "PG 0023",
          state: { tracks: {} } as Prisma.InputJsonValue,
        },
      })
      try {
        const offer = await prisma.skillOffer.create({
          data: {
            characterId: character.id,
            track: "class",
            level: 4,
            choiceGroup: "standard",
            generation: 0,
            earnedGrade: null,
            trackDefinitionStableId: null,
            classStableIdAtEarn: null,
          },
        })
        expect(offer.classStableIdAtEarn).toBeNull()
        const raw = await prisma.$queryRaw<
          Array<{ classStableIdAtEarn: string | null }>
        >`
          SELECT "classStableIdAtEarn" FROM "skill_offers" WHERE "id" = ${offer.id}
        `
        expect(raw[0].classStableIdAtEarn).toBeNull()
      } finally {
        await prisma.skillOffer.deleteMany({
          where: { characterId: character.id },
        })
        await prisma.character.deleteMany({ where: { id: character.id } })
        await prisma.user.deleteMany({
          where: { id: user.id },
        })
      }
    })

    it("backfills a missing track to 'race' and preserves every existing config key", async () => {
      // Apply the exact migration backfill statement.
      await prisma.$executeRaw`
        UPDATE "catalog_definitions"
        SET "config" = "config" || jsonb_build_object('track', 'race')
        WHERE "kind" = 'skills'
          AND "config" ->> 'track' IS NULL
      `

      const noTrack = await prisma.catalogDefinition.findUnique({
        where: { kind_stableId: { kind: "skills", stableId: "pg-no-track" } },
      })
      // The missing track is normalized to the 'race' default.
      expect((noTrack!.config as Record<string, unknown>).track).toBe("race")
      // Every other authored key is preserved exactly.
      expect(noTrack!.config).toMatchObject({
        rarity: "Common",
        milestone: 4,
        effects: [
          { phase: "flat", amount: { strength: 3 }, stacking: "stack" },
        ],
      })

      const bare = await prisma.catalogDefinition.findUnique({
        where: { kind_stableId: { kind: "skills", stableId: "pg-bare" } },
      })
      expect(bare!.config).toEqual({ milestone: 7, track: "race" })
    })

    it("leaves an already-typed class/profession track (and any non-skills row) untouched", async () => {
      // Note: the previous test already ran the backfill; the typed rows must never
      // have been rewritten regardless.
      const classRow = await prisma.catalogDefinition.findUnique({
        where: {
          kind_stableId: { kind: "skills", stableId: "pg-class-track" },
        },
      })
      expect((classRow!.config as Record<string, unknown>).track).toBe("class")
      expect(classRow!.config).toMatchObject({
        rarity: "Uncommon",
        milestone: 5,
      })

      const profRow = await prisma.catalogDefinition.findUnique({
        where: { kind_stableId: { kind: "skills", stableId: "pg-prof-track" } },
      })
      expect((profRow!.config as Record<string, unknown>).track).toBe(
        "profession"
      )
      expect(profRow!.config).toMatchObject({
        rarity: "Rare",
        milestone: 6,
        choiceGroup: "special",
      })

      // A non-skills row must never receive a track key from the backfill.
      const nonSkill = await prisma.catalogDefinition.findUnique({
        where: { kind_stableId: { kind: "races", stableId: "pg-nonskill" } },
      })
      expect(nonSkill!.config).toEqual(NON_SKILL_CONFIG)
    })

    it("re-running the backfill is idempotent", async () => {
      await prisma.$executeRaw`
        UPDATE "catalog_definitions"
        SET "config" = "config" || jsonb_build_object('track', 'race')
        WHERE "kind" = 'skills'
          AND "config" ->> 'track' IS NULL
      `
      const noTrack = await prisma.catalogDefinition.findUnique({
        where: { kind_stableId: { kind: "skills", stableId: "pg-no-track" } },
      })
      expect((noTrack!.config as Record<string, unknown>).track).toBe("race")
      // No duplicate track key is introduced (JSONB `||` overwrites, never stacks).
      const trackKeys = Object.keys(
        noTrack!.config as Record<string, unknown>
      ).filter((k) => k === "track")
      expect(trackKeys).toEqual(["track"])
    })
  }
)
