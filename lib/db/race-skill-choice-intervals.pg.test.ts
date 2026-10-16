/**
 * Real-Postgres test for migration 0022 (`0022_race_skill_choices`), which extends
 * the scheduled skill-choice credits to independent monstrous races and makes the
 * G-grade interval configurable.
 *
 * The migration is additive and non-destructive: it merges ONLY the `G` key into
 * the singleton `house_rules.config.skillChoiceIntervals` object via the JSONB
 * `||` operator, preserving any customized F/E/D/C/B/A/S interval values and every
 * other top-level config key (equipment caps, consumable rates, transcendent cap).
 * There is NO skill_offers schema change this pass.
 *
 * A custom prior config is seeded directly onto the singleton `house_rules` row
 * (non-default F-S intervals plus customized other keys), then the exact migration
 * statement is applied and the merge is verified: G added, custom F-S preserved,
 * other keys untouched. The idempotency of a re-run and the missing-key fallback
 * are also exercised. The original row config is always restored in `afterAll`.
 *
 * Runs ONLY when explicitly opted in (see `resolveDbIntegration`); the database
 * must already have `prisma migrate deploy` applied (migration 0022 included).
 * Because the migration targets the singleton `house_rules` row (id `'active'`),
 * the original config is captured and restored so no other test is disturbed.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/db/client"
import { HOUSE_RULES_ID } from "@/lib/db/ruleset"
import { resolveDbIntegration } from "@/lib/test/db-integration"

const gate = await resolveDbIntegration()

/**
 * A custom prior config that exercises the "preserve customized F-S and other
 * keys" guarantee: non-default F/S interval values plus non-default equipment
 * caps, consumable rates and transcendent cap. G is absent (as it was before
 * migration 0022).
 */
const PRIOR_CONFIG = {
  equipmentIndividualCapPercent: 25,
  equipmentCombinedCapPercent: 18,
  consumableGradeRates: { F: 4, E: 6, D: 16, C: 46 },
  maxTranscendentSkills: 4,
  skillChoiceIntervals: { F: 7, E: 9, D: 21, C: 31, B: 41, A: 51, S: 61 },
}

/** Prior config minus the entire `skillChoiceIntervals` key (pre-0021 shape). */
const PRIOR_CONFIG_NO_INTERVALS = {
  equipmentIndividualCapPercent: 25,
  equipmentCombinedCapPercent: 18,
  consumableGradeRates: { F: 4, E: 6, D: 16, C: 46 },
  maxTranscendentSkills: 4,
}

describe.skipIf(!gate.run)(
  "migration 0022: race skill-choice intervals add G only",
  () => {
    let originalConfig: Prisma.JsonValue | undefined
    let rowExistedBefore = false

    beforeAll(async () => {
      const existing = await prisma.houseRules.findUnique({
        where: { id: HOUSE_RULES_ID },
      })
      if (existing) {
        rowExistedBefore = true
        originalConfig = existing.config
        await prisma.houseRules.update({
          where: { id: HOUSE_RULES_ID },
          data: { config: PRIOR_CONFIG as Prisma.InputJsonValue },
        })
      } else {
        await prisma.houseRules.create({
          data: {
            id: HOUSE_RULES_ID,
            version: 0,
            config: PRIOR_CONFIG as Prisma.InputJsonValue,
          },
        })
      }
    })

    afterAll(async () => {
      if (rowExistedBefore) {
        await prisma.houseRules.update({
          where: { id: HOUSE_RULES_ID },
          data: { config: originalConfig as Prisma.InputJsonValue },
        })
      } else {
        await prisma.houseRules.deleteMany({
          where: { id: HOUSE_RULES_ID },
        })
      }
    })

    it("records migration 0022 as applied", async () => {
      const rows = await prisma.$queryRaw<Array<{ migration_name: string }>>`
        SELECT "migration_name" FROM "_prisma_migrations"
        WHERE "migration_name" LIKE '0022%'
      `
      expect(rows).toHaveLength(1)
    })

    it("adds ONLY the G interval, preserving customized F-S intervals and all other config keys", async () => {
      // Precondition: the seeded config carries custom F-S intervals and no G.
      const before = await prisma.houseRules.findUnique({
        where: { id: HOUSE_RULES_ID },
      })
      const beforeConfig = before?.config as Record<string, unknown>
      expect(beforeConfig.skillChoiceIntervals).toEqual({
        F: 7,
        E: 9,
        D: 21,
        C: 31,
        B: 41,
        A: 51,
        S: 61,
      })
      expect(
        (beforeConfig.skillChoiceIntervals as Record<string, unknown>).G
      ).toBeUndefined()

      // Apply the exact migration statement.
      await prisma.$executeRaw`
      UPDATE "house_rules"
      SET "config" = "config" || jsonb_build_object(
        'skillChoiceIntervals',
        COALESCE("config" -> 'skillChoiceIntervals', '{}'::jsonb) || '{"G":5}'::jsonb
      )
      WHERE "id" = 'active'
    `

      const after = await prisma.houseRules.findUnique({
        where: { id: HOUSE_RULES_ID },
      })
      const afterConfig = after?.config as Record<string, unknown>
      const intervals = afterConfig.skillChoiceIntervals as Record<
        string,
        unknown
      >
      // G is added at the documented default of 5.
      expect(intervals.G).toBe(5)
      // Customized F-S values are preserved exactly (never rewritten to default).
      expect(intervals.F).toBe(7)
      expect(intervals.E).toBe(9)
      expect(intervals.D).toBe(21)
      expect(intervals.C).toBe(31)
      expect(intervals.B).toBe(41)
      expect(intervals.A).toBe(51)
      expect(intervals.S).toBe(61)
      // Other top-level keys are untouched.
      expect(afterConfig.equipmentIndividualCapPercent).toBe(25)
      expect(afterConfig.equipmentCombinedCapPercent).toBe(18)
      expect(afterConfig.maxTranscendentSkills).toBe(4)
      expect(afterConfig.consumableGradeRates).toEqual({
        F: 4,
        E: 6,
        D: 16,
        C: 46,
      })
    })

    it("re-running the merge is idempotent (G stays 5 and custom F-S are not reset)", async () => {
      // The previous test already merged G in; a re-run must not duplicate or
      // reset anything.
      await prisma.$executeRaw`
      UPDATE "house_rules"
      SET "config" = "config" || jsonb_build_object(
        'skillChoiceIntervals',
        COALESCE("config" -> 'skillChoiceIntervals', '{}'::jsonb) || '{"G":5}'::jsonb
      )
      WHERE "id" = 'active'
    `

      const after = await prisma.houseRules.findUnique({
        where: { id: HOUSE_RULES_ID },
      })
      const intervals = (after?.config as Record<string, unknown>)
        .skillChoiceIntervals as Record<string, unknown>
      expect(intervals.G).toBe(5)
      expect(intervals.F).toBe(7)
      expect(intervals.S).toBe(61)
    })

    it("a config with NO skillChoiceIntervals key gains the G-only nested object", async () => {
      // Simulate a pre-0021 config (or a config that never carried the key): only
      // the OTHER keys present. The merge must add `skillChoiceIntervals = {"G":5}`
      // without touching any other key.
      await prisma.houseRules.update({
        where: { id: HOUSE_RULES_ID },
        data: { config: PRIOR_CONFIG_NO_INTERVALS as Prisma.InputJsonValue },
      })

      await prisma.$executeRaw`
      UPDATE "house_rules"
      SET "config" = "config" || jsonb_build_object(
        'skillChoiceIntervals',
        COALESCE("config" -> 'skillChoiceIntervals', '{}'::jsonb) || '{"G":5}'::jsonb
      )
      WHERE "id" = 'active'
    `

      const after = await prisma.houseRules.findUnique({
        where: { id: HOUSE_RULES_ID },
      })
      const afterConfig = after?.config as Record<string, unknown>
      expect(afterConfig.skillChoiceIntervals).toEqual({ G: 5 })
      expect(afterConfig.equipmentIndividualCapPercent).toBe(25)
      expect(afterConfig.equipmentCombinedCapPercent).toBe(18)
      expect(afterConfig.maxTranscendentSkills).toBe(4)
      expect(afterConfig.consumableGradeRates).toEqual({
        F: 4,
        E: 6,
        D: 16,
        C: 46,
      })
    })
  }
)
