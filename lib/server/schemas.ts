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
  kind: z.enum(["raceLevel", "buff"]),
  grade: gradeSchema.optional(),
  count: z.number().int().optional(),
  vector: partialVectorSchema,
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

export const evolveSchema = z.object({
  grade: gradeSchema,
  version: z.number().int().nonnegative(),
})

export const associationSchema = z.object({
  kind: z.enum(["title", "equipment"]),
  definitionId: z.string().min(1),
  operation: z.enum(["add", "remove"]),
  version: z.number().int().nonnegative(),
})

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

export const skillConfigSchema = z
  .object({
    milestone: z.number().int().nonnegative().optional(),
    track: z.string().optional(),
  })
  .passthrough()

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

export const consumableConfigSchema = z
  .object({
    group: z.string().optional(),
    amount: partialVectorSchema.optional(),
    durationQuarters: z.number().int().nonnegative().optional(),
    grade: gradeSchema.optional(),
  })
  .passthrough()

export const evolutionConfigSchema = z
  .object({
    from: gradeSchema.optional(),
    to: gradeSchema.optional(),
    titleId: z.string().optional(),
  })
  .passthrough()

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
