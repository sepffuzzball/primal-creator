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

// ------------------------------------------------------------------ //
// Engine CharacterState (mirrors lib/rules/types.ts)
// ------------------------------------------------------------------ //

const trackStateSchema = z.object({
  level: z.number().int().nonnegative(),
  quarter: z.number().int().min(0).max(3),
  definitionId: z.string(),
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
 * A RACE evolution path choice. The client must supply the id of an unarchived
 * `evolutions` catalog entry that declares a valid race path config. `reason` is
 * optional and is only ever recorded (or, for an admin, used to override the
 * narrative `manualRequirementsText` hard gate). A user-provided reason never
 * bypasses a mechanical requirement.
 */
export const evolvePathSchema = z.object({
  optionId: z.string().min(1),
  version: z.number().int().nonnegative(),
  reason: z.string().optional(),
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

export const evolveSchema = z.union([evolvePathSchema, evolveGradeSchema])

export const associationSchema = z.object({
  kind: z.enum(["title", "equipment"]),
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

export const blessingConfigSchema = z
  .object({
    grade: gradeSchema.optional(),
    effect: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()

export const bloodlineConfigSchema = z
  .object({
    grade: gradeSchema.optional(),
    vector: partialVectorSchema.optional(),
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
    requiredTitleStableIds: z.array(z.string()).optional(),
    requiredSkillStableIds: z.array(z.string()).optional(),
    manualRequirementsText: z.string().optional(),
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
