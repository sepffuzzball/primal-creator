/**
 * Zod schemas for every JSON surface that crosses the API boundary, plus the
 * schemas used to validate (de)serialization of the engine CharacterState and
 * the per-kind catalog config. Everything the client sends is validated here;
 * unknown/invalid payloads are rejected with a 400 before reaching the service.
 *
 * Note: the engine's CharacterState is a pure data object (no Dates, no
 * functions), so it round-trips through JSON losslessly. The schemas below
 * mirror `lib/rules/types.ts` and are intentionally permissive on effect
 * payloads (pass-through) so future engine fields do not break persistence.
 */

import { z } from "zod"

// ------------------------------------------------------------------ //
// Attribute / grade primitives
// ------------------------------------------------------------------ //

// Mirrors GRADE_ORDER in lib/rules/types.ts (G,F,E,D,C,B,A,S). Hardcoded here so
// the Zod output type is the literal union, not a widened string.
export const gradeSchema = z.enum(["G", "F", "E", "D", "C", "B", "A", "S"])

/**
 * The seven-level blessing hierarchy, lowest to highest (docs/rules/blessings.md).
 * A blessing must declare one of these tiers; no other value is accepted on a NEW
 * or CONFIG-CHANGED write (legacy rows are readable without it).
 */
export const blessingTierSchema = z.enum([
  "Minor",
  "Lesser",
  "Intermediate",
  "Major",
  "Greater",
  "Divine",
  "True",
])

export type BlessingTier = z.infer<typeof blessingTierSchema>

/** Full attribute vector: every canonical key required, numeric. */
const fullVectorSchema = z.object({
  strength: z.number(),
  agility: z.number(),
  endurance: z.number(),
  vitality: z.number(),
  toughness: z.number(),
  wisdom: z.number(),
  intelligence: z.number(),
  perception: z.number(),
  willpower: z.number(),
})

/** Sparse attribute patch: every canonical key numeric but optional. */
export const partialVectorSchema = z.object({
  strength: z.number().optional(),
  agility: z.number().optional(),
  endurance: z.number().optional(),
  vitality: z.number().optional(),
  toughness: z.number().optional(),
  wisdom: z.number().optional(),
  intelligence: z.number().optional(),
  perception: z.number().optional(),
  willpower: z.number().optional(),
})

/**
 * Sparse attribute patch whose values are nonnegative integers. Used for the
 * catalog-level bonuses that the engine consumes (title flat / percent basis
 * points, equipment bonus). These are bounded by the engine's caps, never
 * negative, and always whole numbers.
 */
export const nonnegativePartialVectorSchema = z.object({
  strength: z.number().int().nonnegative().optional(),
  agility: z.number().int().nonnegative().optional(),
  endurance: z.number().int().nonnegative().optional(),
  vitality: z.number().int().nonnegative().optional(),
  toughness: z.number().int().nonnegative().optional(),
  wisdom: z.number().int().nonnegative().optional(),
  intelligence: z.number().int().nonnegative().optional(),
  perception: z.number().int().nonnegative().optional(),
  willpower: z.number().int().nonnegative().optional(),
})

/**
 * Sparse attribute patch whose values are finite integers (signed, unlike the
 * nonnegative basis-point vector). Used for blessing / bloodline effect `flat`
 * amounts: a value must be a whole JSON-safe number - never a float, `NaN` or
 * `Infinity` - so the stored config round-trips through JSON and stays a plain
 * declarative data object.
 */
export const integerPartialVectorSchema = z.object({
  strength: z.number().int().optional(),
  agility: z.number().int().optional(),
  endurance: z.number().int().optional(),
  vitality: z.number().int().optional(),
  toughness: z.number().int().optional(),
  wisdom: z.number().int().optional(),
  intelligence: z.number().int().optional(),
  perception: z.number().int().optional(),
  willpower: z.number().int().optional(),
})

// ------------------------------------------------------------------ //
// Engine CharacterState (mirrors lib/rules/types.ts)
// ------------------------------------------------------------------ //

const trackStateSchema = z.object({
  level: z.number().int().nonnegative(),
  quarter: z.number().int().min(0).max(3),
  definitionId: z.string(),
  // Optional explicit class/profession grade state; absent on legacy states. The
  // engine never infers a grade for a missing field.
  grade: gradeSchema.optional(),
})

const raceStateSchema = z.object({
  level: z.number().int().nonnegative(),
  grade: gradeSchema,
  mode: z.enum(["derived", "independent"]),
  definitionId: z.string().optional(),
  origin: z.enum(["integrated", "born"]).optional(),
})

const levelAwardSchema = z.object({
  track: z.string(),
  level: z.number().int().nonnegative(),
  definitionId: z.string(),
  fixed: fullVectorSchema,
  free: z.number().int().nonnegative(),
})

const allocationEntrySchema = z.object({
  id: z.string(),
  source: z.string(),
  at: z.number(),
  points: fullVectorSchema,
})

const permanentGainSchema = z.object({
  id: z.string(),
  source: z.string(),
  kind: z.enum(["raceLevel", "buff", "consumable"]),
  grade: gradeSchema.optional(),
  count: z.number().int().optional(),
  vector: partialVectorSchema,
  requested: partialVectorSchema.optional(),
  gradeAtApplication: gradeSchema.optional(),
  raceLevelAtApplication: z.number().int().nonnegative().optional(),
  capRemainingAfter: partialVectorSchema.optional(),
  appliedAt: z.union([z.string(), z.number()]).optional(),
})

const effectConditionSchema = z.union([
  z.object({ kind: z.literal("always") }),
  z.object({
    kind: z.literal("levelAtLeast"),
    track: z.string(),
    level: z.number(),
  }),
  z.object({ kind: z.literal("gradeAtLeast"), grade: gradeSchema }),
])

const effectBase = {
  id: z.string(),
  source: z.string(),
  provenance: z.string(),
  condition: effectConditionSchema.optional(),
  expiresAt: z.number().optional(),
  group: z.string().optional(),
  stacking: z.enum(["replace", "stack", "stackCapped"]),
}

const gameEffectSchema = z.discriminatedUnion("phase", [
  z.object({
    ...effectBase,
    phase: z.literal("flat"),
    amount: partialVectorSchema,
  }),
  z.object({
    ...effectBase,
    phase: z.literal("percent"),
    basisPoints: partialVectorSchema,
  }),
  z.object({
    ...effectBase,
    phase: z.literal("temporary"),
    amount: partialVectorSchema,
  }),
])

const equipmentBonusSchema = z.object({
  id: z.string(),
  name: z.string(),
  slot: z.string(),
  source: z.string(),
  bonus: partialVectorSchema,
})

export const characterStateSchema = z.object({
  baseAttributes: fullVectorSchema,
  tracks: z.record(z.string(), trackStateSchema),
  race: raceStateSchema,
  historicalLevelAwards: z.array(levelAwardSchema),
  allocations: z.array(allocationEntrySchema),
  permanentGains: z.array(permanentGainSchema),
  activeEffects: z.array(gameEffectSchema),
  equipment: z.array(equipmentBonusSchema),
  currentResources: z.record(z.string(), z.number()),
  turn: z.number().int().nonnegative(),
})

// ------------------------------------------------------------------ //
// Auth
// ------------------------------------------------------------------ //

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

/**
 * Self-service password change. The `currentPassword` is always required; the
 * `newPassword` must be at least 12 characters (the same minimum enforced for
 * admin-created and admin-reset passwords). Exactly matching the current password
 * is rejected by the service layer after the current password is verified.
 */
export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12),
})

/**
 * Admin user creation. There is no public registration: only an admin may create
 * a user. Email must be a valid address (normalized to lowercase server-side);
 * password must be at least 12 characters and is hashed with bcrypt cost 12. The
 * caller may promote the new user to admin by passing `isAdmin`.
 */
export const adminUserCreateSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12),
  isAdmin: z.boolean().optional(),
})

/**
 * Admin user patch. At least one property must be present, and a reset password
 * must be at least 12 characters. `isAdmin` / `disabled` toggle role and access;
 * a password reset bumps `sessionVersion` so every previously issued token is
 * revoked immediately.
 */
export const adminUserPatchSchema = z
  .object({
    isAdmin: z.boolean().optional(),
    disabled: z.boolean().optional(),
    password: z.string().min(12).optional(),
  })
  .refine(
    (data) =>
      data.isAdmin !== undefined ||
      data.disabled !== undefined ||
      data.password !== undefined,
    {
      message: "Provide at least one of isAdmin, disabled, or password",
    }
  )

// ------------------------------------------------------------------ //
// Characters
// ------------------------------------------------------------------ //

export const characterCreateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  origin: z.enum(["integrated", "born"]),
  raceId: z.string().min(1),
  classId: z.string().min(1),
  professionId: z.string().optional(),
  // When supplied (the wizard's final "create" step), the matching draft is
  // consumed atomically with character creation: a stale/missing version 409s
  // `draft_conflict` and rolls back the whole create. When absent (a non-wizard
  // API client, or create-from-scratch), no draft is touched.
  draftVersion: z.number().int().nonnegative().optional(),
})

export const characterUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  archived: z.boolean().optional(),
  currentResources: z.record(z.string(), z.number()).optional(),
  version: z.number().int().nonnegative().optional(),
})

export const advanceSchema = z.object({
  track: z.enum(["class", "profession"]),
  version: z.number().int().nonnegative(),
})

export const allocateSchema = z.object({
  allocation: partialVectorSchema,
  version: z.number().int().nonnegative(),
})

export const consumeSchema = z.object({
  definitionId: z.string().min(1),
  version: z.number().int().nonnegative(),
})

/**
 * Manual inventory bookkeeping (add / remove owned equipment or consumable
 * quantity). `operation` is a literal add/remove, `quantity` is bounded 1..999999
 * (the same bound the migration's CHECK constraint enforces), `version` is the CAS
 * token, and `sourceNote` is a mandatory, at-most-500-character note recorded into
 * the `inventory_adjust` journal. Acquisition is manual here - no acquisition
 * economy is invented, so the note is the only provenance the client supplies.
 */
export const inventoryPostSchema = z.object({
  operation: z.enum(["add", "remove"]),
  definitionId: z.string().min(1),
  quantity: z.number().int().min(1).max(999999),
  version: z.number().int().nonnegative(),
  sourceNote: z.string().min(1).max(500),
})

/**
 * A RACE evolution path choice. The client must supply the id of an unarchived
 * `evolutions` catalog entry that declares a valid race path config. `reason` is
 * optional and is only ever recorded (or, for an admin, used to override the
 * narrative `manualRequirementsText` hard gate). A user-provided reason never
 * bypasses a mechanical requirement.
 *
 * `track` is a LITERAL optional `"race"` - never a free string. This is what
 * keeps a class/profession track path (`track: "class"` / `track: "profession"`)
 * from being matched (and silently stripped) here: when Zod reaches this branch
 * with `track: "class"`, the value fails the literal and the union moves on to
 * `evolveTrackPathSchema`, which preserves the track. Old clients that omit
 * `track` entirely (the legacy race shape) still parse here unchanged.
 */
export const evolvePathSchema = z.object({
  optionId: z.string().min(1),
  version: z.number().int().nonnegative(),
  reason: z.string().optional(),
  track: z.literal("race").optional(),
})

/**
 * Legacy grade-only evolution. Retained as the house fallback that is only
 * accepted when NO valid catalog race path to the requested grade exists; when a
 * path exists the server 409s `evolution_choice_required`.
 */
export const evolveGradeSchema = z.object({
  grade: gradeSchema,
  version: z.number().int().nonnegative(),
})

/**
 * A CLASS/PROFESSION track evolution path choice. The client supplies the id of
 * an unarchived `evolutions` catalog entry that declares a valid
 * `track: "class"` / `track: "profession"` path config, plus the target `track`.
 * `reason` is optional and is only ever recorded (or, for an admin, used to
 * override the narrative `manualRequirementsText` hard gate). A user-provided
 * reason never bypasses a mechanical requirement. The selected track is only
 * that track's `grade`/`definitionId`; the race grade is never touched.
 */
export const evolveTrackPathSchema = z.object({
  track: z.enum(["class", "profession"]),
  optionId: z.string().min(1),
  version: z.number().int().nonnegative(),
  reason: z.string().optional(),
})

export const evolveSchema = z.union([
  evolvePathSchema,
  evolveGradeSchema,
  evolveTrackPathSchema,
])

export const associationSchema = z.object({
  kind: z.enum(["title", "equipment", "blessing", "bloodline", "transcendent"]),
  definitionId: z.string().min(1),
  operation: z.enum(["add", "remove"]),
  version: z.number().int().nonnegative(),
})

export const skillSelectSchema = z.object({
  operation: z.literal("select"),
  offerId: z.string().min(1),
  definitionId: z.string().min(1),
  version: z.number().int().nonnegative(),
})

export const skillGrantSchema = z.object({
  operation: z.literal("grant"),
  definitionId: z.string().min(1),
  version: z.number().int().nonnegative(),
  reason: z.string().min(1),
})

// Discriminated union: a skill action is either a player/admin selection of a
// pending offer option, or an admin-only manual grant.
export const skillsPostSchema = z.discriminatedUnion("operation", [
  skillSelectSchema,
  skillGrantSchema,
])

// ------------------------------------------------------------------ //
// Catalog
// ------------------------------------------------------------------ //

export const catalogKindSchema = z.enum([
  "races",
  "classes",
  "professions",
  "titles",
  "equipment",
  "skills",
  "blessings",
  "bloodlines",
  "consumables",
  "evolutions",
  "gods",
  "transcendent_skills",
])

const catalogBase = {
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  grade: gradeSchema.nullable().optional(),
  provenance: z.enum(["verified", "inferred", "house"]).optional(),
  sourceUrl: z.string().url().nullable().optional(),
  archived: z.boolean().optional(),
}

export const catalogCreateSchema = z.object({
  ...catalogBase,
  stableId: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
})

export const catalogUpdateSchema = z.object({
  ...catalogBase,
  stableId: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
})

// ------------------------------------------------------------------ //
// Per-kind catalog config validation
// ------------------------------------------------------------------ //

const raceDefinitionSchema = z.object({
  id: z.string(),
  perLevel: partialVectorSchema,
  freePerLevel: z.number().int().nonnegative(),
})

export const raceConfigSchema = z
  .object({
    naturalGrade: gradeSchema.optional(),
    raceDefinitions: z.record(z.string(), raceDefinitionSchema).optional(),
  })
  .passthrough()

export const trackConfigSchema = z
  .object({
    grades: z
      .record(
        z.string(),
        z.object({
          fixed: partialVectorSchema,
          free: z.number().int().nonnegative(),
        })
      )
      .optional(),
  })
  .passthrough()

export const equipmentConfigSchema = z
  .object({
    slot: z.string().min(1).optional(),
    bonus: nonnegativePartialVectorSchema.optional(),
  })
  .passthrough()

/**
 * A single declarative passive effect carried by a skill's catalog config.
 *
 * Only the phases the engine can synthesize live from a catalog entry are
 * accepted: `flat` (a signed integer attribute vector, so a skill may be a
 * debuff) and `percent` (nonnegative integer basis points). A skill may carry an
 * optional `condition` (reusing the engine's existing EffectCondition shape) and
 * declares its own `stacking`. `group` is the per-effect stacking group and is
 * preserved as-is by the service layer, so a single skill can carry independent
 * flat AND percent effects that both apply. The skill's `upgradeGroup` is used
 * only to remove superseded linked skills on select/grant, never as an effect
 * replace group. `stacking` is optional for legacy entries that predate the
 * modern shape; it defaults to "stack" (or "replace" when a `group` is set).
 */
const skillEffectBase = {
  condition: effectConditionSchema.optional(),
  stacking: z.enum(["replace", "stack", "stackCapped"]).optional(),
  group: z.string().optional(),
}

const skillEffectSchema = z.discriminatedUnion("phase", [
  z.object({
    ...skillEffectBase,
    phase: z.literal("flat"),
    amount: partialVectorSchema,
  }),
  z.object({
    ...skillEffectBase,
    phase: z.literal("percent"),
    basisPoints: nonnegativePartialVectorSchema,
  }),
])

/**
 * The declarative passive-effect shape shared by blessings and bloodlines. It is
 * the same flat/percent discriminated union as a skill effect, but the `flat`
 * amount is restricted to finite integers (see `integerPartialVectorSchema`) so
 * the stored config stays a plain JSON-safe, whole-number vector. A blessing may
 * also carry a `grade`/`effect` legacy field for readability; bloodlines carry a
 * `vector` legacy field. `SkillEffect` is the typed interface both config kinds
 * use; a bloodline with narrative-only effects (no numbers) uses `effects: []`.
 */
export const catalogEffectSchema = z.discriminatedUnion("phase", [
  z.object({
    ...skillEffectBase,
    phase: z.literal("flat"),
    amount: integerPartialVectorSchema,
  }),
  z.object({
    ...skillEffectBase,
    phase: z.literal("percent"),
    basisPoints: nonnegativePartialVectorSchema,
  }),
])

export type SkillEffect = z.infer<typeof catalogEffectSchema>

/**
 * Catalog config for a `skills` entry.
 *
 * `track` is read permissively so a legacy entry carrying an arbitrary string
 * (e.g. "Class") never breaks a read: such a config stays readable/editable and
 * its effects still synthesize, and the unrecognized track is simply ignored for
 * offers (it never matches an advancing "class"/"profession" track). A NEW or
 * CONFIG-CHANGED skill must use the enum value; the service layer rejects any
 * other string via `hasInvalidSkillTrack`.
 */
export const skillConfigSchema = z
  .object({
    track: z.string().optional(),
    milestone: z.number().int().nonnegative().optional(),
    choiceGroup: z.string().min(1).optional(),
    eligibleDefinitionStableIds: z.array(z.string()).optional(),
    effects: z.array(skillEffectSchema).optional(),
    upgradeGroup: z.string().optional(),
  })
  .passthrough()

/**
 * A skill config is "offer-incomplete" when it declares exactly one of
 * `track` / `milestone`. An offer-eligible milestone skill requires BOTH: the
 * track the milestone applies to, and the level at which it is offered. Legacy
 * partial configs that carry neither (or carry only one) are still readable and
 * editable as metadata-only, but a NEW or CONFIG-CHANGED skill is rejected by
 * the service layer when this returns true, so an admin cannot create a skill
 * that silently never offers.
 */
export function isIncompleteSkillConfig(
  config: Record<string, unknown>
): boolean {
  const hasTrack = config.track != null
  const hasMilestone = config.milestone != null
  return hasTrack !== hasMilestone
}

/**
 * Detect a `skills` config whose `track` is present but not a recognized enum
 * value (`"class"` / `"profession"`). A legacy config may carry an arbitrary
 * track string that is safe to read and ignore for offers, but a NEW or
 * CONFIG-CHANGED skill is rejected by the service layer when this returns true.
 */
export function hasInvalidSkillTrack(config: Record<string, unknown>): boolean {
  const track = config.track
  if (track == null) return false
  return track !== "class" && track !== "profession"
}

export const titleConfigSchema = z
  .object({
    grade: gradeSchema.optional(),
    grants: z.record(z.string(), z.number()).optional(),
    flat: nonnegativePartialVectorSchema.optional(),
    percentBasisPoints: nonnegativePartialVectorSchema.optional(),
    upgradeGroup: z.string().optional(),
  })
  .passthrough()

/**
 * Catalog config for a `blessings` entry.
 *
 * Modern shape (required on NEW or CONFIG-CHANGED writes):
 *   - `tier` is the seven-level blessing hierarchy (Minor..True).
 *   - `effects` is the typed flat/percent declarative effect list. A blessing
 *     with purely narrative benefits (no numeric effect) may use `effects: []`.
 *   - `patronGodStableId` (optional) names the unarchived `gods` entry that is
 *     the blessing's patron; when provided the service stores the resolved FK
 *     `patronId` in the same transaction.
 *   - `compatibleBlessingStableIds` (optional) and `upgradeGroup` (optional) are
 *     forwarded as-is.
 *
 * The schema reads permissively (passthrough) so a LEGACY `{grade, effect}`
 * config stays readable and metadata-only-PATCHable: it carries no `tier` /
 * `effects`, and `isLegacyBlessingConfig` returns true so the service layer
 * rejects only NEW/CONFIG-CHANGED writes (never a read).
 */
export const blessingConfigSchema = z
  .object({
    grade: gradeSchema.optional(),
    // Legacy single-effect object; readable, not part of the modern shape.
    effect: z.record(z.string(), z.unknown()).optional(),
    tier: blessingTierSchema.optional(),
    patronGodStableId: z.string().min(1).optional(),
    effects: z.array(catalogEffectSchema).optional(),
    compatibleBlessingStableIds: z.array(z.string()).optional(),
    upgradeGroup: z.string().optional(),
  })
  .passthrough()

/**
 * Detects a `blessings` config that lacks the modern `tier`/`effects` shape.
 * Such a config is permitted for reads and metadata-only PATCHes (see
 * `blessingConfigSchema`), but the service layer requires the modern shape
 * whenever a blessing is created or its config is changed.
 */
export function isLegacyBlessingConfig(
  config: Record<string, unknown>
): boolean {
  return config.tier == null || config.effects == null
}

/**
 * Catalog config for a `bloodlines` entry.
 *
 * Modern shape (required on NEW or CONFIG-CHANGED writes):
 *   - `effects` is the typed flat/percent declarative effect list. May be `[]`
 *     for a narrative-only bloodline that grants no numeric effect.
 *   - `gradeEffects` (optional) is a partial map of grade -> effect list, so a
 *     bloodline like the Primal Hunter's can scale its Perception bonus per
 *     grade (see docs/rules/bloodlines.md). Grade-specific effects overlay the
 *     flat `effects` for matching grades.
 *   - `upgradeGroup` (optional) is forwarded as-is.
 *
 * The schema reads permissively (passthrough) so a LEGACY `{grade, vector}`
 * config stays readable and metadata-only-PATCHable; `isLegacyBloodlineConfig`
 * returns true so the service layer rejects only NEW/CONFIG-CHANGED writes.
 */
export const bloodlineConfigSchema = z
  .object({
    grade: gradeSchema.optional(),
    // Legacy stat vector; readable, not part of the modern shape.
    vector: partialVectorSchema.optional(),
    effects: z.array(catalogEffectSchema).optional(),
    gradeEffects: z.record(z.string(), z.array(catalogEffectSchema)).optional(),
    upgradeGroup: z.string().optional(),
  })
  .passthrough()
  .superRefine((config, ctx) => {
    if (config.gradeEffects == null) return
    for (const key of Object.keys(config.gradeEffects)) {
      if (
        !gradeSchema.options.includes(
          key as (typeof gradeSchema.options)[number]
        )
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `bloodline gradeEffects has an invalid grade "${key}"`,
          path: ["gradeEffects", key],
        })
      }
    }
  })

/**
 * Detects a `bloodlines` config that lacks the modern `effects` shape. Such a
 * config is permitted for reads and metadata-only PATCHes, but the service layer
 * requires the modern shape whenever a bloodline is created or its config is
 * changed.
 */
export function isLegacyBloodlineConfig(
  config: Record<string, unknown>
): boolean {
  return config.effects == null
}

/**
 * Catalog config for a `transcendent_skills` entry.
 *
 * A transcendent skill is a self-created skill that breaks some fundamental rule
 * of the system (see docs/rules/transcendents.md). It is character-linkable and
 * may carry an explicit `passiveEffects` list (typed flat/percent per-effect
 * declarative effects, the same discriminated union as a skill/blessing/bloodline
 * effect so stacking group/condition come from the shared skill effect schema),
 * plus optional narrative `costDescription` and `acquisitionNotes` that the
 * engine never interprets mechanically (no auto-activation, no cost deduction, no
 * universal eligibility threshold).
 *
 * Modern shape (required on NEW or CONFIG-CHANGED writes):
 *   - `passiveEffects` is the typed flat/percent declarative effect list. May be
 *     `[]` for a narrative-only transcendent that grants no numeric effect. A
 *     config that omits it is rejected by the service layer (it never fabricates
 *     a default bonus).
 *   - `costDescription` / `acquisitionNotes` (optional) are prose only - they are
 *     surfaced to the UI but never treated as a mechanical cost or a triggered
 *     always-on power.
 *
 * The schema reads permissively (passthrough) so a LEGACY config that predates
 * `passiveEffects` stays readable and metadata-only-PATCHable;
 * `isLegacyTranscendentSkillConfig` returns true so the service layer requires the
 * modern shape only on NEW/CONFIG-CHANGED writes (never a read).
 */
export const transcendentSkillConfigSchema = z
  .object({
    costDescription: z.string().optional(),
    acquisitionNotes: z.string().optional(),
    passiveEffects: z.array(catalogEffectSchema).optional(),
  })
  .passthrough()

/**
 * Detects a `transcendent_skills` config that lacks the modern `passiveEffects`
 * shape. Such a config is permitted for reads and metadata-only PATCHes, but the
 * service layer requires the modern shape whenever a transcendent skill is
 * created or its config is changed.
 */
export function isLegacyTranscendentSkillConfig(
  config: Record<string, unknown>
): boolean {
  return config.passiveEffects == null
}

/**
 * Catalog config for a `gods` entry (the Gods & Patrons catalog kind). The god
 * config is intentionally metadata-only in this phase: `pantheon` and
 * `divineRank` are free-text descriptors the UI may surface, and a `gods` entry
 * is never granted numeric effects to characters (phase 2 wires blessing/bloodline
 * associations). It reads permissively so a future shape cannot break a read.
 */
export const godConfigSchema = z
  .object({
    pantheon: z.string().optional(),
    divineRank: z.string().optional(),
  })
  .passthrough()

/**
 * Catalog config for a `consumables` entry.
 *
 * A consumable is exactly one of two kinds:
 *   - `permanent`: grants a permanent external stat gain, capped by the grade-based
 *     race-level capacity (F3/E5/D15/C45). It must NOT carry `durationQuarters`.
 *   - `temporary`: produces a temporary effect that lasts `durationQuarters` quarters
 *     and is NOT capped by the grade rates. It MUST carry a positive `durationQuarters`.
 *
 * `amount` is a non-negative integer partial vector that must request at least one
 * positive attribute (an all-zero amount is rejected as empty).
 *
 * Legacy entries created before the `type`/`amount` shape was hardened may omit
 * either field. Such a config is accepted here (metadata-only, so the catalog
 * stays readable/editable) and is rejected only at consume time with an
 * actionable `legacy_consumable_config` error - never granted a fabricated
 * default amount. New POSTs and config-changing PATCHes are required by the
 * service layer to carry the modern full shape (see `isLegacyConsumableConfig`).
 */
export const consumableConfigSchema = z
  .object({
    type: z.enum(["permanent", "temporary"]).optional(),
    amount: nonnegativePartialVectorSchema.optional(),
    durationQuarters: z.number().int().positive().optional(),
    group: z.string().optional(),
    grade: gradeSchema.optional(),
  })
  .passthrough()
  .superRefine((config, ctx) => {
    const { type, amount, durationQuarters } = config
    // A legacy consumable config (missing `type` or `amount`) is metadata-only
    // and is skipped here; consume rejects it explicitly rather than inventing a
    // default amount.
    if (type == null || amount == null) return
    const hasPositive = Object.values(amount).some(
      (v) => typeof v === "number" && Number.isFinite(v) && v > 0
    )
    if (!hasPositive) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "consumable amount must request at least one positive attribute",
        path: ["amount"],
      })
    }
    if (type === "temporary" && durationQuarters == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "temporary consumable requires durationQuarters (a positive integer)",
        path: ["durationQuarters"],
      })
    }
    if (type === "permanent" && durationQuarters != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "permanent consumable forbids durationQuarters",
        path: ["durationQuarters"],
      })
    }
  })

/**
 * Detect a `consumables` config that lacks the modern `type`/`amount` shape.
 * Such a config is permitted for reads and metadata-only PATCHes (see
 * `consumableConfigSchema`), but the service layer requires the modern full
 * shape whenever a consumable is created or its config is changed, and rejects
 * it with an actionable error at consume time. This avoids accepting a
 * fabricated default amount.
 */
export function isLegacyConsumableConfig(
  config: Record<string, unknown>
): boolean {
  return config.type == null || config.amount == null
}

function isGradeValue(value: unknown): boolean {
  return gradeSchema.safeParse(value).success
}

/**
 * Catalog config for an `evolutions` entry.
 *
 * Two shapes are supported:
 *   - A **legacy metadata-only** config (`{from, to, titleId}`) remains readable
 *     and editable (metadata PATCH) but is NOT a usable race evolution path.
 *   - An **active race evolution path**: `track: "race"` plus the required
 *     `fromRaceStableId`, `toRaceStableId`, `fromGrade`, `toGrade`, and optional
 *     `minRaceLevel`, `requiredTitleStableIds`, `requiredSkillStableIds` and
 *     `manualRequirementsText`. Only this shape can be selected by
 *     `POST /api/characters/[id]/evolve` with `optionId`.
 *
 * The schema reads permissively (passthrough) so a legacy or partial config never
 * breaks a catalog read; the service layer rejects a NEW or CONFIG-CHANGED
 * evolutions entry whose config is not a valid full race path (see
 * `isValidRaceEvolutionConfig`), mirroring the consumables/skills hardening.
 */
export const evolutionConfigSchema = z
  .object({
    from: gradeSchema.optional(),
    to: gradeSchema.optional(),
    titleId: z.string().optional(),
    track: z.string().optional(),
    fromRaceStableId: z.string().optional(),
    toRaceStableId: z.string().optional(),
    fromGrade: gradeSchema.optional(),
    toGrade: gradeSchema.optional(),
    minRaceLevel: z.number().int().nonnegative().optional(),
    minTrackLevel: z.number().int().nonnegative().optional(),
    requiredTitleStableIds: z.array(z.string()).optional(),
    requiredSkillStableIds: z.array(z.string()).optional(),
    manualRequirementsText: z.string().optional(),
    // Class/profession path fields (a fully-formed track evolution path).
    fromDefinitionStableId: z.string().optional(),
    toDefinitionStableId: z.string().optional(),
  })
  .passthrough()

/**
 * Whether an `evolutions` config is a fully-formed, active race evolution path.
 *
 * A legacy metadata-only config (the old `{from,to,titleId}` shape) is readable
 * and editable, but is NOT a full path, so this returns false and it can never be
 * used as an `optionId` choice. The service layer rejects NEW or CONFIG-CHANGED
 * evolutions entries whose config fails this check, same as consumables/skills.
 */
export function isValidRaceEvolutionConfig(
  config: Record<string, unknown>
): boolean {
  if (config.track !== "race") return false
  if (
    typeof config.fromRaceStableId !== "string" ||
    config.fromRaceStableId.length === 0
  ) {
    return false
  }
  if (
    typeof config.toRaceStableId !== "string" ||
    config.toRaceStableId.length === 0
  ) {
    return false
  }
  if (!isGradeValue(config.fromGrade)) return false
  if (!isGradeValue(config.toGrade)) return false
  if (
    config.minRaceLevel != null &&
    (typeof config.minRaceLevel !== "number" ||
      !Number.isInteger(config.minRaceLevel) ||
      config.minRaceLevel < 0)
  ) {
    return false
  }
  if (
    config.requiredTitleStableIds != null &&
    (!Array.isArray(config.requiredTitleStableIds) ||
      config.requiredTitleStableIds.some((s) => typeof s !== "string"))
  ) {
    return false
  }
  if (
    config.requiredSkillStableIds != null &&
    (!Array.isArray(config.requiredSkillStableIds) ||
      config.requiredSkillStableIds.some((s) => typeof s !== "string"))
  ) {
    return false
  }
  if (
    config.manualRequirementsText != null &&
    typeof config.manualRequirementsText !== "string"
  ) {
    return false
  }
  return true
}

/**
 * Whether an `evolutions` config is a fully-formed, active class/profession
 * (track) evolution path.
 *
 * A track path declares `track: "class"` or `track: "profession"` plus the
 * required `fromDefinitionStableId`, `toDefinitionStableId`, `fromGrade` and
 * `toGrade`. The optional `minTrackLevel`, `requiredTitleStableIds`,
 * `requiredSkillStableIds` and `manualRequirementsText` are validated the same
 * way as a race path. A legacy metadata-only config (the old `{from,to,titleId}`
 * shape) is readable and editable, but is NOT a full track path, so this returns
 * false. The service layer rejects NEW or CONFIG-CHANGED evolutions entries whose
 * config is neither a complete race path nor a complete class/profession path.
 */
export function isValidTrackEvolutionConfig(
  config: Record<string, unknown>
): boolean {
  if (config.track !== "class" && config.track !== "profession") return false
  if (
    typeof config.fromDefinitionStableId !== "string" ||
    config.fromDefinitionStableId.length === 0
  ) {
    return false
  }
  if (
    typeof config.toDefinitionStableId !== "string" ||
    config.toDefinitionStableId.length === 0
  ) {
    return false
  }
  if (!isGradeValue(config.fromGrade)) return false
  if (!isGradeValue(config.toGrade)) return false
  if (
    config.minTrackLevel != null &&
    (typeof config.minTrackLevel !== "number" ||
      !Number.isInteger(config.minTrackLevel) ||
      config.minTrackLevel < 0)
  ) {
    return false
  }
  if (
    config.requiredTitleStableIds != null &&
    (!Array.isArray(config.requiredTitleStableIds) ||
      config.requiredTitleStableIds.some((s) => typeof s !== "string"))
  ) {
    return false
  }
  if (
    config.requiredSkillStableIds != null &&
    (!Array.isArray(config.requiredSkillStableIds) ||
      config.requiredSkillStableIds.some((s) => typeof s !== "string"))
  ) {
    return false
  }
  if (
    config.manualRequirementsText != null &&
    typeof config.manualRequirementsText !== "string"
  ) {
    return false
  }
  return true
}

/**
 * Whether an `evolutions` config is a fully-formed path: either a complete race
 * path OR a complete class/profession path. A legacy metadata-only config (the
 * old `{from,to,titleId}` shape) is readable/editable but not a usable path, so
 * this returns false and it can never be selected by `optionId`.
 */
export function isValidEvolutionConfig(
  config: Record<string, unknown>
): boolean {
  return (
    isValidRaceEvolutionConfig(config) || isValidTrackEvolutionConfig(config)
  )
}

const catalogConfigSchemaMap: Record<string, z.ZodTypeAny> = {
  races: raceConfigSchema,
  classes: trackConfigSchema,
  professions: trackConfigSchema,
  titles: titleConfigSchema,
  equipment: equipmentConfigSchema,
  skills: skillConfigSchema,
  blessings: blessingConfigSchema,
  bloodlines: bloodlineConfigSchema,
  consumables: consumableConfigSchema,
  evolutions: evolutionConfigSchema,
  gods: godConfigSchema,
  transcendent_skills: transcendentSkillConfigSchema,
}

/**
 * Validate a catalog entry's `config` against the per-kind Zod schema. Returns
 * the parsed (potentially normalized) config object. Throws a ZodError if the
 * config does not match its kind.
 */
export function parseCatalogConfig(
  kind: string,
  config: unknown
): Record<string, unknown> {
  const schema = catalogConfigSchemaMap[kind]
  if (!schema) return {}
  if (config == null) return {}
  const parsed = schema.parse(config)
  return parsed as Record<string, unknown>
}

export function isCatalogKind(value: string): boolean {
  return catalogKindSchema.safeParse(value).success
}
