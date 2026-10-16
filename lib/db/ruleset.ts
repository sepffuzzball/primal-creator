/**
 * Server-wide house-rules singleton access.
 *
 * The `house_rules` table holds a SINGLE row (`id = 'active'`) carrying the
 * validated, admin-editable house-rule defaults for the calculation engine. It
 * is created and seeded by migration 0007_house_rules (never by the seed script)
 * so the application never silently falls back to an in-memory default.
 *
 * `loadHouseRules(db)` must be called at most ONCE per service public read or
 * mutation request, and - for a mutation - through the SAME transaction client
 * that performs the write. The resulting validated `config` (and `version`
 * provenance) is then passed down through the service layer; helpers never issue
 * their own hidden lookup.
 *
 * The config shape is EXACT and strict: any unknown key, missing key, non-integer
 * value, or value outside the allowed range is rejected.
 */

import { z } from "zod"
import { ApiError } from "@/lib/server/errors"
import type { SkillChoiceIntervals } from "@/lib/rules"

/** The singleton key. The application reads/writes only this row. */
export const HOUSE_RULES_ID = "active" as const

/** The admin-facing nullability of the config (0..100 for percentages; 0..100000 for rates). */
export interface HouseRulesConfig {
  equipmentIndividualCapPercent: number
  equipmentCombinedCapPercent: number
  consumableGradeRates: {
    F: number
    E: number
    D: number
    C: number
  }
  /**
   * The maximum number of transcendent skills a character may hold at once
   * (default 3). Bounded 0..8 - the same upper bound the transport-imposed
   * `transcendentSkillIds` array has, so a house cap can never exceed what a
   * create payload can carry. Enforced by the service across creation,
   * association edits and backup import, never relaxed.
   */
  maxTranscendentSkills: number
  /**
   * The configurable number of levels between skill-choice CREDITS, per grade.
   * G is now configurable too (default 5): a G-grade monster/race earns credits on
   * the same cadence as F, but is capped by the F band (see
   * `isSkillChoiceMilestone`). Each value is an integer 1..250. Used to determine
   * whether a class/profession (or race) level-up awards a skill-choice milestone
   * credit; edits after a credit is earned never alter already-earned offers (see
   * `isSkillChoiceMilestone`).
   */
  skillChoiceIntervals: SkillChoiceIntervals
}

/**
 * Strict, exact validation of the persisted/admin-submitted house-rules config.
 * `.strict()` rejects any key outside the documented shape, so a future field is
 * never silently dropped on a read or accepted on a write until it is added here.
 */
export const houseRulesConfigSchema = z
  .object({
    equipmentIndividualCapPercent: z.number().int().min(0).max(100),
    equipmentCombinedCapPercent: z.number().int().min(0).max(100),
    consumableGradeRates: z
      .object({
        F: z.number().int().min(0).max(100_000),
        E: z.number().int().min(0).max(100_000),
        D: z.number().int().min(0).max(100_000),
        C: z.number().int().min(0).max(100_000),
      })
      .strict(),
    maxTranscendentSkills: z.number().int().min(0).max(8),
    skillChoiceIntervals: z
      .object({
        G: z.number().int().min(1).max(250),
        F: z.number().int().min(1).max(250),
        E: z.number().int().min(1).max(250),
        D: z.number().int().min(1).max(250),
        C: z.number().int().min(1).max(250),
        B: z.number().int().min(1).max(250),
        A: z.number().int().min(1).max(250),
        S: z.number().int().min(1).max(250),
      })
      .strict(),
  })
  .strict()

/**
 * The documented default house config. Matches exactly what migration 0007
 * inserts (plus the `maxTranscendentSkills` default added by migration 0012);
 * kept here for tests and for describing the startup defaults.
 */
export const DEFAULT_HOUSE_RULES_CONFIG: HouseRulesConfig = {
  equipmentIndividualCapPercent: 20,
  equipmentCombinedCapPercent: 15,
  consumableGradeRates: { F: 3, E: 5, D: 15, C: 45 },
  maxTranscendentSkills: 3,
  skillChoiceIntervals: {
    G: 5,
    F: 5,
    E: 5,
    D: 20,
    C: 30,
    B: 40,
    A: 50,
    S: 60,
  },
}

/** A loaded (validated) house-rules row. */
export interface HouseRulesRow {
  version: number
  config: HouseRulesConfig
  updatedAt: Date
}

/**
 * The minimal Prisma surface needed to load the singleton row. Both the real
 * Prisma client and its transaction client expose `houseRules.findUnique`, and
 * the in-memory test mock models the same query.
 */
export interface HouseRulesDbClient {
  houseRules: {
    findUnique(args: { where: { id: string } }): Promise<{
      id: string
      version: number
      config: unknown
      updatedAt: Date
    } | null>
  }
}

/**
 * Load and validate the singleton house-rules row. Throws a 503
 * `ruleset_unavailable` error when the row is absent (e.g. migration not yet
 * applied) so the application NEVER falls back to an in-memory default on a
 * service read/mutation/import/export. Config is validated with
 * `houseRulesConfigSchema`, so a malformed stored config surfaces as a hard
 * error, never a fabricated default.
 */
export async function loadHouseRules(
  db: HouseRulesDbClient
): Promise<HouseRulesRow> {
  const row = await db.houseRules.findUnique({ where: { id: HOUSE_RULES_ID } })
  if (!row) {
    throw new ApiError(
      503,
      "ruleset_unavailable",
      "The server-wide house rules row is missing; apply migrations"
    )
  }
  const config = houseRulesConfigSchema.parse(row.config)
  return { version: row.version, config, updatedAt: row.updatedAt }
}
