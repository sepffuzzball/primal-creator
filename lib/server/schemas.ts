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
import type { Grade } from "@/lib/rules"

// ------------------------------------------------------------------ //
// Attribute / grade primitives
// ------------------------------------------------------------------ //

// Mirrors GRADE_ORDER in lib/rules/types.ts (G,F,E,D,C,B,A,S). Hardcoded here so
// the Zod output type is the literal union, not a widened string.
export const gradeSchema = z.enum(["G", "F", "E", "D", "C", "B", "A", "S"])

/**
 * The blessing hierarchy, lowest to highest (docs/rules/blessings.md): eight
 * tiers including Baptism. Baptism is the lowest entry tier - a ritual marking a
 * follower as an adherent, below the seven substantive blessing levels
 * (Minor..True). Baptism is NOT a canonical source-confirmed blessing level; it
 * is a user-configured entry stage. A blessing must declare one of these tiers;
 * no other value is accepted on a NEW or CONFIG-CHANGED write (legacy rows are
 * readable without it). Baptism carries no invented numeric effect; a baptism
 * blessing uses `effects: []`.
 */
export const blessingTierSchema = z.enum([
  "Baptism",
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

/**
 * Sparse derived-resource patch over the HP/MP/SP maxima whose values are finite
 * integers (signed, matching `Partial<Record<DerivedResource, number>>` in the
 * engine type). Used for the engine CharacterState equipment bonus: a stored
 * state's `derivedFlat` / `derivedPercentBasisPoints` round-trip through JSON and
 * stay plain declarative integers. Zod `.int()` rejects NaN / Infinity, so a
 * parsed value is always finite.
 */
export const derivedResourceIntegerSchema = z.object({
  hp: z.number().int().optional(),
  mp: z.number().int().optional(),
  sp: z.number().int().optional(),
})

/**
 * Sparse derived-resource patch whose values are nonnegative integers. Used for
 * the catalog-level `equipmentConfigSchema` derived HP/MP/SP bonuses: the editor
 * only accepts nonnegative whole-number additions to the resource maxima.
 */
export const nonnegativeDerivedResourceSchema = z.object({
  hp: z.number().int().nonnegative().optional(),
  mp: z.number().int().nonnegative().optional(),
  sp: z.number().int().nonnegative().optional(),
})

// ------------------------------------------------------------------ //
// Engine CharacterState (mirrors lib/rules/types.ts)
// ------------------------------------------------------------------ //

const trackStateSchema = z
  .object({
    level: z.number().int().nonnegative(),
    quarter: z.number().int().min(0).max(3),
    definitionId: z.string(),
    // Optional explicit class/profession grade state; absent on legacy states. The
    // engine never infers a grade for a missing field.
    grade: gradeSchema.optional(),
    // Authoritative EXP percentage within the current level (0..99). Optional:
    // legacy states predating explicit EXP tracking omit it. When present the track
    // is "explicit" and `quarter` must equal floor(experiencePercent / 25).
    experiencePercent: z.number().int().min(0).max(99).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.experiencePercent == null) return
    const expected = Math.floor(data.experiencePercent / 25)
    if (data.quarter !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `experiencePercent ${data.experiencePercent} requires quarter ${expected} (got ${data.quarter})`,
        path: ["quarter"],
      })
    }
  })

const raceStateSchema = z
  .object({
    level: z.number().int().nonnegative(),
    grade: gradeSchema,
    mode: z.enum(["derived", "independent"]),
    definitionId: z.string().optional(),
    // Quarter index within the current race level, present on monsters
    // (independent race mode) advancing on a four-quarter cadence. Optional so
    // legacy states that predate race-quarter tracking still deserialize; when
    // absent the engine treats it as 0.
    quarter: z.number().int().min(0).max(3).optional(),
    // Authoritative race-level EXP percentage within the current race level
    // (0..99), present on independent (monster) races only. Optional: legacy
    // states and derived (enlightened) races omit it. When present, `quarter`
    // (defaulting to 0 when absent) must equal floor(experiencePercent / 25).
    experiencePercent: z.number().int().min(0).max(99).optional(),
    origin: z.enum(["integrated", "born"]).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.experiencePercent == null) return
    const quarter = data.quarter ?? 0
    const expected = Math.floor(data.experiencePercent / 25)
    if (quarter !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `experiencePercent ${data.experiencePercent} requires quarter ${expected} (got ${quarter})`,
        path: ["quarter"],
      })
    }
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
  // Optional per-attribute equipment percentage bonuses, expressed as nonnegative
  // integer basis points (10000 = 100%). Absent on legacy states; the engine treats
  // a missing field as no percentage contribution.
  percentBasisPoints: nonnegativePartialVectorSchema.optional(),
  // Optional per-resource flat bonuses applied directly to the derived HP/MP/SP
  // maxima. Unlike the attribute `bonus`, these do NOT consume the per-attribute
  // aggregate or overall equipment cap budgets, never compound, and only sum
  // across items. Absent on legacy states; the engine treats a missing field as 0.
  derivedFlat: derivedResourceIntegerSchema.optional(),
  // Optional per-resource percentage bonuses (nonnegative basis points,
  // 10000 = 100%) applied once to the positive (base + flat) derived value. They
  // are summed across items and never compound, and they do not share the
  // attribute equipment cap budgets. Absent on legacy states; contributes 0.
  derivedPercentBasisPoints: derivedResourceIntegerSchema.optional(),
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

/**
 * Explicit special-ability selections carried by final character creation (and
 * mirrored, with identical bounds, by the resumable draft payload).
 *
 * Every field is optional so an omitted/empty selection is valid; the server
 * never infers a special ability or auto-selects one. Bounds:
 *   - `blessing` is a single optional `{ godId, tier }` object (at most one
 *     blessing, selected as a god + exact tier). The god definition must be an
 *     unarchived `gods` catalog entry; the link stores the tier verbatim and its
 *     live effect is synthesized from the god's `blessingEffects[tier]`.
 *   - `bloodlineIds` is an optional array of at most one nonempty id (a
 *     character may carry at most one bloodline link, enforced server-side and
 *     by a partial unique index; see docs/rules/bloodlines.md).
 *   - `transcendentSkillIds` is an optional array of at most 8 nonempty, unique
 *     ids (the transport-level upper bound; the effective per-character limit is
 *     the admin-configurable `maxTranscendentSkills` from HouseRules, default 3).
 *   - No id may appear in more than one field (no overlap across kinds), and
 *     each array must itself be internally unique.
 */
export const specialAbilitiesSchema = z
  .object({
    blessing: z
      .object({
        godId: z.string().min(1),
        tier: blessingTierSchema,
      })
      .optional(),
    bloodlineIds: z.array(z.string().min(1)).max(1).optional(),
    transcendentSkillIds: z.array(z.string().min(1)).max(8).optional(),
  })
  .superRefine((data, ctx) => {
    // Internal uniqueness + cross-field no-overlap. Every selected id is tracked;
    // selecting the same id twice (within one array, or across blessing /
    // bloodline / transcendent) is rejected, since each id resolves to exactly
    // one catalog definition.
    const seen = new Map<string, string>()
    const register = (id: string, field: string) => {
      const prior = seen.get(id)
      if (prior != null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${id}" is selected more than once (${prior}, ${field})`,
          path: [field],
        })
      } else {
        seen.set(id, field)
      }
    }
    for (const id of data.bloodlineIds ?? []) register(id, "bloodlineIds")
    for (const id of data.transcendentSkillIds ?? [])
      register(id, "transcendentSkillIds")
    if (data.blessing != null) register(data.blessing.godId, "blessing")
  })

export const characterCreateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  // Character-profile metadata. Optional + nullable: an omitted or null field is
  // persisted as NULL (a missing value on create is never a 400). The bounds
  // mirror draft-schema.ts (nickname 200, pronouns 100, ageDescription 4000,
  // appearance 8000, biography 8000, notes 4000).
  nickname: z.string().max(200).nullable().optional(),
  pronouns: z.string().max(100).nullable().optional(),
  ageDescription: z.string().max(4000).nullable().optional(),
  appearance: z.string().max(8000).nullable().optional(),
  biography: z.string().max(8000).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  origin: z.enum(["integrated", "born"]),
  raceId: z.string().min(1),
  // `classId` is required for an enlightened race (a nonempty string) and null
  // for a monster. The Zod shape only permits null/absent here; the authoritative
  // per-raceType rule is enforced by the service layer, which knows the resolved
  // race config (Zod cannot see it). A null/empty class on an enlightened race
  // and a non-null class on a monster are rejected there.
  classId: z.string().min(1).nullable().optional(),
  // `professionId` is optional for an enlightened race and must be null for a
  // monster (see classId: enforcement lives in the service layer).
  professionId: z.string().min(1).nullable().optional(),
  // Explicit special-ability selections. When supplied, the corresponding
  // blessing/bloodline/transcendent-skill catalog definitions are resolved by
  // kind and linked as CharacterAssociations atomically with the create. When
  // omitted/empty, no ability is granted (legacy `special` bool is informational
  // only). See `specialAbilitiesSchema`.
  specialAbilities: specialAbilitiesSchema.optional(),
  // When supplied (the wizard's final "create" step), the matching draft is
  // consumed atomically with character creation: a stale/missing version 409s
  // `draft_conflict` and rolls back the whole create. When absent (a non-wizard
  // API client, or create-from-scratch), no draft is touched.
  draftVersion: z.number().int().nonnegative().optional(),
})

export const characterUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  // Character-profile metadata. Optional + nullable so a PATCH may clear a field
  // (null) or leave it untouched (omitted). The bounds mirror draft-schema.ts.
  nickname: z.string().max(200).nullable().optional(),
  pronouns: z.string().max(100).nullable().optional(),
  ageDescription: z.string().max(4000).nullable().optional(),
  appearance: z.string().max(8000).nullable().optional(),
  biography: z.string().max(8000).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  archived: z.boolean().optional(),
  currentResources: z.record(z.string(), z.number()).optional(),
  version: z.number().int().nonnegative().optional(),
})

export const advanceSchema = z.object({
  track: z.enum(["class", "profession", "race"]),
  version: z.number().int().nonnegative(),
})

/**
 * The authoritative EXP-percent set / instant level-up payload for
 * `POST /api/characters/[id]/experience`. Discriminated on `operation`:
 *
 *   - `operation: "set"` carries a `percent` integer 0..100 and settles the
 *     authoritative experience percentage of the selected track. A target below
 *     100 settles the percentage within the current level; a target of 100 is a
 *     level-up (an instant `levelUp` equivalent).
 *   - `operation: "levelUp"` carries no `percent` and is exactly
 *     `setExperiencePercent(..., 100)`: an instant level-up from any percentage.
 *
 * Both variants require the CAS `version`. `track` accepts the same three
 * vocabularies as `/advance`, and the same race-mode validation applies (a race
 * track is legal only for an independent monster race; a class/profession track is
 * legal only for an enlightened race).
 */
export const experienceSetSchema = z
  .object({
    operation: z.literal("set"),
    track: z.enum(["class", "profession", "race"]),
    percent: z.number().int().min(0).max(100),
    version: z.number().int().nonnegative(),
  })
  .strict()

export const experienceLevelUpSchema = z
  .object({
    operation: z.literal("levelUp"),
    track: z.enum(["class", "profession", "race"]),
    version: z.number().int().nonnegative(),
  })
  .strict()

/**
 * The safe-compensating reversal of the latest actual level-up. The client asks
 * to undo the most recent `advance` level-up on the selected track, carrying only
 * the CAS `version` - no `percent` (the restored EXP percentage comes entirely from
 * the immutable journal of the original level-up event, which this operation never
 * rewrites). The service rejects with 409 `level_undo_blocked` (and writes nothing)
 * when no safe live level-up exists, when a later non-cosmetic event has superseded
 * it, or when the current state no longer matches the original level-up's
 * "after" snapshot. See docs/rules/leveling.md.
 */
export const experienceUndoSchema = z
  .object({
    operation: z.literal("undo"),
    track: z.enum(["class", "profession", "race"]),
    version: z.number().int().nonnegative(),
  })
  .strict()

export const experienceSchema = z.discriminatedUnion("operation", [
  experienceSetSchema,
  experienceLevelUpSchema,
  experienceUndoSchema,
])

export const allocateSchema = z.object({
  allocation: partialVectorSchema,
  version: z.number().int().nonnegative(),
})

/**
 * Set-once profession after creation. The client supplies the id of an active
 * `professions` catalog entry (graded exactly at the character's current race
 * grade and declaring a per-level config for that grade) plus the CAS `version`.
 * The service rejects a monster / classless race, validates the catalog entry,
 * and 409s an already-set profession with `profession_already_set`. No level
 * awards are granted and the class/race tracks are never touched.
 */
export const professionSetSchema = z.object({
  professionId: z.string().min(1),
  version: z.number().int().nonnegative(),
})

/**
 * Manual inventory bookkeeping (add / remove owned equipment or consumable
 * quantity) plus a distinct stock-only `use` action for owned Items.
 *
 * - `add` / `remove` are literal bookkeeping operations: `quantity` is bounded
 *   1..999999 (the same bound the migration's CHECK constraint enforces),
 *   `version` is the CAS token, and `sourceNote` is a mandatory, at-most-500-
 *   character note recorded into the `inventory_adjust` journal. Acquisition is
 *   manual here - no acquisition economy is invented, so the note is the only
 *   provenance the client supplies.
 * - `use` is a distinct stock-only action: it spends EXACTLY one owned unit of a
 *   catalog `items` definition and applies no mechanical effect (no stat/current-
 *   resource change, no recipe). `quantity` must be exactly 1, `sourceNote` is
 *   optional and ignored (the service journals the automatic note "Used item"),
 *   and the service records an explicit `inventory_use` progression event. An
 *   `items` definition may be used even when archived (owned stock may still be
 *   spent); an equipment definition cannot be used (400).
 */
export const inventoryPostSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("add"),
    definitionId: z.string().min(1),
    quantity: z.number().int().min(1).max(999999),
    version: z.number().int().nonnegative(),
    sourceNote: z.string().min(1).max(500),
  }),
  z.object({
    operation: z.literal("remove"),
    definitionId: z.string().min(1),
    quantity: z.number().int().min(1).max(999999),
    version: z.number().int().nonnegative(),
    sourceNote: z.string().min(1).max(500),
  }),
  z.object({
    operation: z.literal("use"),
    definitionId: z.string().min(1),
    quantity: z.literal(1),
    version: z.number().int().nonnegative(),
    sourceNote: z.string().max(500).optional(),
  }),
])

/**
 * A single evolution choice. Every track (race, class, profession) must be named
 * explicitly and must point at a DESTINATION catalog definition id - there is no
 * legacy grade-only path and no `evolutions` catalog kind anymore, so the client
 * always chooses a real destination definition. `reason` is optional and is only
 * ever recorded in the journal (it never gates anything).
 */
export const evolveSchema = z.object({
  track: z.enum(["race", "class", "profession"]),
  optionId: z.string().min(1),
  version: z.number().int().nonnegative(),
  reason: z.string().optional(),
})

/**
 * A ring's physical position on the character. Ring is a SINGLE catalog slot
 * (`"Ring"`) but a character may wear up to two rings, one in each position; the
 * chosen position is persisted per-link on the association
 * (`CharacterAssociation.equipmentPosition`), never on the catalog config. This
 * schema is the only accepted vocabulary for that per-link position.
 */
export const equipmentPositionSchema = z.enum(["Ring 1", "Ring 2"])

export type EquipmentPosition = z.infer<typeof equipmentPositionSchema>

export const associationSchema = z
  .object({
    kind: z.enum([
      "title",
      "equipment",
      "blessing",
      "bloodline",
      "transcendent",
    ]),
    definitionId: z.string().min(1),
    operation: z.enum(["add", "remove"]),
    version: z.number().int().nonnegative(),
    // A self-reported qualifying reason, recorded on the associate event. Required
    // for a RANKED title add (<=500 chars, trimmed nonempty enforced by the service
    // which knows whether the target title is ranked); optional and ignored
    // otherwise. Never a proof claim - just the player's account.
    reason: z.string().max(500).optional(),
    // The physical ring position, REQUIRED for an `add` of a Ring-slot equipment
    // item (a single catalog `Ring` slot but two wearable positions). Forbidden on
    // any non-Ring equipment add and ignored on a remove. Never required on a
    // non-equipment kind.
    equipmentPosition: equipmentPositionSchema.optional(),
    // The exact blessing tier, meaningful ONLY on a `blessing` add (a blessing
    // link stores the tier it was granted at, and the live effect is synthesized
    // from the god's `blessingEffects[tier]`). REQUIRED on a blessing add - the
    // service never writes a null tier (the DB CHECK rejects one) - and ignored on
    // a remove or any non-blessing kind, where it may be omitted or supplied as
    // metadata only. When supplied on a blessing add it is persisted verbatim on
    // the link; the god's definition `definitionId` is the god that granted it.
    tier: blessingTierSchema.optional(),
  })
  .superRefine((data, ctx) => {
    // A blessing ADD must carry an exact tier (one of the eight). A missing tier
    // is rejected at the API boundary before reaching the service, so a blessing
    // link can never be created with a null tier. A remove / non-blessing kind
    // never requires a tier.
    if (
      data.kind === "blessing" &&
      data.operation === "add" &&
      data.tier == null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "a blessing add requires an exact tier (one of the eight blessing tiers)",
        path: ["tier"],
      })
    }
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

/**
 * An explicit skill-upgrade request. The owner or an admin upgrades the
 * character's linked skill in an `upgradeGroup` to a strictly higher-ordered
 * rarity variant. `reason` is a mandatory at-most-500-character note recorded
 * into the `skill_upgrade` journal; `version` is the CAS token.
 */
export const skillUpgradeSchema = z.object({
  definitionId: z.string().min(1),
  version: z.number().int().nonnegative(),
  reason: z.string().min(1).max(500),
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
  "bloodlines",
  "items",
  "gods",
  "transcendent_skills",
])

/**
 * Normalize a catalog-kind string to its canonical value, mapping the legacy
 * `consumables` alias to `items`. Anything else is returned unchanged. Used at
 * catalog import boundaries so a pre-existing manifest/upload (and the not-yet-
 * migrated UI) that still says `consumables` resolves against the `items` catalog
 * rows; the legacy value is never persisted.
 */
export function normalizeCatalogKind(kind: string): string {
  return kind === "consumables" ? "items" : kind
}

/**
 * A `gods` catalog entry carries no grade band: a god's power, divine rank and
 * blessing tier are expressed through `blessingEffects[tier]` (and the optional
 * `pantheon` / `divineRank` metadata), never through the shared
 * `catalog_definitions.grade` column that races/classes/professions and other
 * graded kinds use. Migration 0020 nulled any pre-existing god grade, and from
 * here on every write/import path for a god must reject a non-null grade -
 * only `null` (or an omitted grade, which reads back as null) is legal.
 *
 * Returns true when `kind` is `gods` AND `grade` is a non-null value, which is
 * exactly the case the service/import layer must reject with 400
 * `invalid_grade`. Centralized here so the create/update service path and every
 * catalog import path share the same invariant rather than each inlining it.
 */
export function godGradeForbidden(kind: string, grade: unknown): boolean {
  return kind === "gods" && grade != null
}

/**
 * The advancement-track kinds that always carry a required catalog grade. A
 * race/class/profession is graded by definition - its `grade` is how the engine
 * pins a track to a per-grade definition (see `resolveTrackDefinition`) and is
 * never null after a migration that stamped graded tracks. A PATCH that tries to
 * clear such a grade to null must be rejected before any write, so a valid grade
 * can never be accidentally erased by a generic optional-grade clear.
 *
 * Returns true when `kind` is one of races/classes/professions AND `grade` is the
 * explicit `null` value, which is exactly the case the service update path must
 * reject with 400 `invalid_grade`. An omitted grade (`undefined`) is legal - it
 * preserves the existing non-null value, so a metadata-only PATCH never trips
 * this. Centralized here so the update path shares the invariant instead of
 * inlining kind-specific logic, mirroring `godGradeForbidden`.
 */
export function requiredGradeNullForbidden(
  kind: string,
  grade: unknown
): boolean {
  return (
    (kind === "races" || kind === "classes" || kind === "professions") &&
    grade === null
  )
}

/**
 * Grade-specific prose descriptions for a catalog entry, keyed by the grade
 * ladder (G..S). Authored independently of the legacy `description` string and of
 * the entry's own `grade` band (a legacy race whose `grade` is null may still
 * carry a description for its natural grade; a grade-cap row may carry text for
 * any band). Never auto-populated from `description`.
 *
 * The map is optional and may be empty: an omitted or `{}` value means the entry
 * carries no authored grade text (it reads back as an empty map). Keys are
 * STRICT - only G..S are accepted, so a typo like `"H"` is rejected rather than
 * silently dropped. Values are trimmed and must be nonempty and at most 8000
 * characters; a blank or oversized value is rejected.
 */
export const gradeDescriptionsSchema = z
  .record(z.string(), z.string().trim().min(1).max(8000))
  .superRefine((map, ctx) => {
    for (const [key] of Object.entries(map)) {
      if (
        !gradeSchema.options.includes(
          key as (typeof gradeSchema.options)[number]
        )
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `gradeDescriptions has an invalid grade key "${key}"`,
          path: [key],
        })
      }
    }
  }) as z.ZodType<Partial<Record<Grade, string>>>

/**
 * Grade-specific automatic skill grants for a race or class/profession track,
 * keyed by the grade ladder (G..S). Each value is a list of `skills` catalog
 * `stableId` entries the engine grants automatically at the moment the
 * character reaches that grade: on create for the starting grade, on profession
 * assignment for the newly assigned track grade, or on evolution into the target
 * grade of the new selected catalog definition. Optional and may be empty: a
 * missing or `{}` value means the entry declares no auto-grant (it reads back as
 * an empty map, never a fabricated list). Keys are STRICT - only G..S are
 * accepted, so a typo like `"H"` is rejected rather than silently dropped. Each
 * list must be internally unique and every id nonempty; a repeated id for a
 * grade is rejected. The service layer resolves each id to an unarchived skill on
 * a NEW or config-changing write and rejects a missing or archived reference.
 */
export const gradeGrantedSkillStableIdsSchema = z
  .record(z.string(), z.array(z.string().min(1)))
  .superRefine((map, ctx) => {
    for (const [grade, ids] of Object.entries(map)) {
      if (
        !gradeSchema.options.includes(
          grade as (typeof gradeSchema.options)[number]
        )
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `gradeGrantedSkillStableIds has an invalid grade key "${grade}"`,
          path: [grade],
        })
      }
      if (Array.isArray(ids)) {
        const seen = new Set<string>()
        for (const id of ids) {
          if (seen.has(id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `"${id}" is granted more than once for grade "${grade}" in "gradeGrantedSkillStableIds"`,
              path: [grade],
            })
            break
          }
          seen.add(id)
        }
      }
    }
  }) as z.ZodType<Partial<Record<Grade, string[]>>>

/**
 * Extract the grade-specific granted skill stableIds declared for a single grade
 * from a race/class/profession config. A missing or malformed map yields `[]`
 * (never a fabricated list), so a legacy config that predates the field grants
 * nothing.
 */
export function gradeSkillStableIdsFor(
  config: Record<string, unknown>,
  grade: Grade
): string[] {
  const byGrade = config.gradeGrantedSkillStableIds
  if (!byGrade || typeof byGrade !== "object" || Array.isArray(byGrade))
    return []
  const ids = (byGrade as Record<string, unknown>)[grade]
  if (!Array.isArray(ids)) return []
  return ids.filter((id): id is string => typeof id === "string")
}

/**
 * Collect every skill stableId referenced across all grades in a
 * race/class/profession config's `gradeGrantedSkillStableIds`. Used by the import
 * allow-set resolution to reject a reference that would dangle after the upload.
 */
export function allGradeGrantedSkillStableIds(
  config: Record<string, unknown>
): string[] {
  const byGrade = config.gradeGrantedSkillStableIds
  if (!byGrade || typeof byGrade !== "object" || Array.isArray(byGrade))
    return []
  const out: string[] = []
  for (const ids of Object.values(byGrade as Record<string, unknown>)) {
    if (Array.isArray(ids)) {
      for (const id of ids) if (typeof id === "string") out.push(id)
    }
  }
  return out
}

const catalogBase = {
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  grade: gradeSchema.nullable().optional(),
  sourceUrl: z.string().url().nullable().optional(),
  archived: z.boolean().optional(),
  gradeDescriptions: gradeDescriptionsSchema.optional(),
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
    // How the race advances: an enlightened race selects exact class/profession
    // tracks (derived race level), a monster has race-only levels (independent
    // race mode). Required on NEW or config-changing writes; a legacy config
    // without it is interpreted as `enlightened` by the service layer (never
    // authoritative, preserved backups/UI).
    raceType: z.enum(["enlightened", "monster"]).optional(),
    naturalGrade: gradeSchema.optional(),
    raceDefinitions: z.record(z.string(), raceDefinitionSchema).optional(),
    gradeGrantedSkillStableIds: gradeGrantedSkillStableIdsSchema.optional(),
  })
  .passthrough()

/**
 * Detect a `races` config whose `raceType` is present but not a recognized enum
 * value (`"enlightened"` / `"monster"`). A legacy config without `raceType` is
 * safe to read (it defaults to `enlightened`), but a NEW or CONFIG-CHANGED race
 * is rejected by the service layer when this returns true.
 */
export function hasInvalidRaceTypeConfig(
  config: Record<string, unknown>
): boolean {
  const raceType = config.raceType
  if (raceType == null) return false
  return raceType !== "enlightened" && raceType !== "monster"
}

/**
 * Detect a `races` config whose `naturalGrade` is present but not a recognized
 * grade value (`"G"` / `"F"` / `"E"` / `"D"` / `"C"` / `"B"` / `"A"` / `"S"`).
 * A legacy config without `naturalGrade` is safe to read (it falls back to `F`
 * for the class/profession stamp), but a NEW or CONFIG-CHANGED race is rejected
 * by the service layer when this returns true - an arbitrary grade string is
 * never silently accepted.
 */
export function hasInvalidNaturalGradeConfig(
  config: Record<string, unknown>
): boolean {
  if (config.naturalGrade == null) return false
  return !gradeSchema.safeParse(config.naturalGrade).success
}

/**
 * Detect a `races` config that is not a valid authoritative race-advancement
 * config for a NEW or CONFIG-CHANGED write. The modern-shape guard requires
 * BOTH fields: `raceType` must be a recognized enum value
 * (`"enlightened"` / `"monster"`) AND `naturalGrade` must be a gradeSchema-valid
 * grade. A missing/invalid `raceType` or a missing/invalid `naturalGrade` makes
 * this true. The service layer requires a complete config whenever a race is
 * created or its config is changed; legacy rows lacking these fields remain
 * readable and metadata-only-PATCHable (see `raceConfigSchema` and the service's
 * preservation logic on a config-changing edit).
 */
export function isIncompleteRaceConfig(
  config: Record<string, unknown>
): boolean {
  const hasValidType =
    config.raceType === "enlightened" || config.raceType === "monster"
  const hasValidGrade = gradeSchema.safeParse(config.naturalGrade).success
  return !hasValidType || !hasValidGrade
}

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
    gradeGrantedSkillStableIds: gradeGrantedSkillStableIdsSchema.optional(),
  })
  .passthrough()

// ------------------------------------------------------------------ //
// Equipment metadata (slot / rarity / soulbound / eligibility)
// ------------------------------------------------------------------ //

/** Ordered canonical equipment rarity tiers, ascending by commonness. */
export const EQUIPMENT_RARITIES = [
  "Inferior",
  "Common",
  "Uncommon",
  "Rare",
  "Epic",
  "Ancient",
  "Legendary",
  "Mythical",
  "Sacred",
  "Divine",
] as const

/**
 * The `Unique` rarity is "incomparable": it is NOT part of the ordered comparable
 * ladder in `EQUIPMENT_RARITIES` (no tier is above or below it), so it is held
 * separately rather than appended to that ladder.
 */
export const EQUIPMENT_UNIQUE_RARITY = "Unique" as const

/** The full equipment rarity vocabulary incl. the incomparable `Unique`. */
export const equipmentRaritySchema = z.enum([
  ...EQUIPMENT_RARITIES,
  EQUIPMENT_UNIQUE_RARITY,
])

/**
 * The shared rarity vocabulary reused by every catalog kind that carries a
 * rarity tier, aliased to `equipmentRaritySchema` so the accepted values and the
 * incomparable `Unique` tier stay identical across equipment and skills.
 */
export const raritySchema = equipmentRaritySchema

/**
 * The 0-based order of a rarity within the comparable ladder
 * (`EQUIPMENT_RARITIES`). The incomparable `Unique` tier and any missing /
 * unrecognized value return undefined, so a caller can distinguish "not on the
 * comparable ladder, nothing is strictly above or below it" from a real tier.
 */
export function rarityOrderIndex(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined
  const index = EQUIPMENT_RARITIES.indexOf(
    value as (typeof EQUIPMENT_RARITIES)[number]
  )
  return index >= 0 ? index : undefined
}

/** The canonical equipment slots. */
export const EQUIPMENT_SLOTS = [
  "Head",
  "Chest",
  "Back",
  "Arms",
  "Hands",
  "Legs",
  "Feet",
  "Neck",
  "Ring",
  "Weapon",
] as const

export const equipmentSlotSchema = z.enum(EQUIPMENT_SLOTS)

/**
 * Derive a ring position from a legacy equipment `config.slot` value. Before the
 * single-`Ring`-slot model, ring items were authored with the slot value
 * `"Ring 1"`/`"Ring 2"` (including case/spacing aliases such as `"ring1"`,
 * `"ring 2"`), so this recovers the position those rows encode. The canonical
 * `"Ring"` slot carries no positional info and returns undefined (the position
 * then comes from the persisted association link). Returns undefined for any
 * non-ring slot.
 */
export function legacyRingPositionForConfig(
  config: Record<string, unknown>
): EquipmentPosition | undefined {
  const slot = config.slot
  if (typeof slot !== "string") return undefined
  const key = slot.toLowerCase().replace(/\s+/g, "")
  if (key === "ring1") return "Ring 1"
  if (key === "ring2") return "Ring 2"
  return undefined
}

/**
 * Documented legacy slot aliases -> canonical slot. These normalize ONLY for
 * slot-collision / replacement / import-integrity comparisons; a catalog write
 * stores the original config verbatim (no synonym coercion) unless the value is
 * already canonical. Legacy ring slot values normalize to the canonical `"Ring"`
 * slot for category comparisons; the specific position is the per-link
 * `equipmentPosition`, never part of the canonical slot set.
 */
const EQUIPMENT_SLOT_ALIASES: Record<string, string> = {
  head: "Head",
  chest: "Chest",
  cloak: "Back",
  bracers: "Arms",
  gloves: "Hands",
  boots: "Feet",
  necklace: "Neck",
  ring1: "Ring",
  ring2: "Ring",
  "ring 1": "Ring",
  "ring 2": "Ring",
}

/**
 * Normalize an equipment slot value to its canonical form purely for collision /
 * replacement / import-integrity comparisons. Canonical values pass through
 * (case-insensitively, so `feet` maps to `Feet`), documented legacy aliases map
 * to their canonical slot, and any other value returns undefined (so an
 * unrecognized / legacy slot never participates in a collision). The original
 * `config.slot` is never rewritten by this function.
 */
export function normalizeEquipmentSlot(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const canonical = EQUIPMENT_SLOTS.find(
    (s) => s.toLowerCase() === value.toLowerCase()
  )
  if (canonical) return canonical
  return EQUIPMENT_SLOT_ALIASES[value.toLowerCase()]
}

/** Whether an equipment slot value is one of the canonical `EQUIPMENT_SLOTS`. */
export function isCanonicalEquipmentSlot(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (EQUIPMENT_SLOTS as readonly string[]).includes(value)
  )
}

/**
 * Detect an equipment config that is not a valid authoritative config for a NEW
 * or CONFIG-CHANGING write. The modern-shape guard requires BOTH a slot that
 * normalizes to a recognized canonical slot AND a valid `rarity`. A legacy
 * config lacking either remains readable / metadata-PATCHable but is never
 * authoritative for a new or config-changing write (mirroring race / skill /
 * blessing hardening). `minRaceLevel` / `soulbound` / `requiredRaceType` are
 * optional metadata validated by `equipmentConfigSchema` itself.
 */
export function isIncompleteEquipmentConfig(
  config: Record<string, unknown>
): boolean {
  if (normalizeEquipmentSlot(config.slot) == null) return true
  return !equipmentRaritySchema.safeParse(config.rarity).success
}

/**
 * Detect an equipment config that still carries the LEGACY requirement keys
 * (`minRaceLevel` / `requiredRaceType`) instead of the canonical
 * `minimumLevel` / `requiredLevelType` pair. A NEW or config-changing write must
 * never persist the legacy keys (the editor migrates them to canonical), while an
 * existing row that still carries them stays readable and enforced by the
 * eligibility engine. Only `minRaceLevel` / `requiredRaceType` are considered
 * legacy; `soulbound` is not (it has no canonical replacement).
 */
export function hasLegacyEquipmentRequirements(
  config: Record<string, unknown>
): boolean {
  return (
    config.minRaceLevel !== undefined || config.requiredRaceType !== undefined
  )
}

/**
 * The ordered blessing-tier ladder, lowest to highest. Driven by
 * `blessingTierSchema` so the enumeration order can never drift from the schema.
 */
export const BLESSING_TIER_ORDER = blessingTierSchema.options

/**
 * Whether a stored blessing tier is at or above a required minimum tier, using the
 * authoritative ordered ladder (Baptism < Minor < Lesser < Intermediate < Major <
 * Greater < Divine < True). Both must be valid `BlessingTier` values; the caller is
 * responsible for validating them (the schema already does).
 */
export function blessingTierAtLeast(
  tier: BlessingTier,
  required: BlessingTier
): boolean {
  const index = (t: BlessingTier) => BLESSING_TIER_ORDER.indexOf(t)
  return index(tier) >= index(required)
}

export const equipmentConfigSchema = z
  .object({
    slot: z.string().min(1).optional(),
    bonus: nonnegativePartialVectorSchema.optional(),
    // Optional per-attribute equipment percentage bonuses, expressed as nonnegative
    // integer basis points (10000 = 100%). The flat `bonus` is unchanged; a percent
    // bonus shares the capped flat equipment budget. Absent on legacy entries.
    percentBasisPoints: nonnegativePartialVectorSchema.optional(),
    // Optional per-resource flat bonuses applied directly to the derived HP/MP/SP
    // maxima. Unlike the attribute `bonus`, these do NOT consume the per-attribute
    // aggregate or overall equipment cap budgets. The editor accepts only
    // nonnegative integers; absent on legacy entries.
    derivedFlat: nonnegativeDerivedResourceSchema.optional(),
    // Optional per-resource percentage bonuses (nonnegative integer basis points,
    // 10000 = 100%) applied to the derived HP/MP/SP maxima, likewise independent of
    // the attribute equipment cap budgets. Absent on legacy entries.
    derivedPercentBasisPoints: nonnegativeDerivedResourceSchema.optional(),
    rarity: equipmentRaritySchema.optional(),
    soulbound: z.boolean().optional(),
    // Legacy race-only eligibility keys. Still readable and enforced, but never
    // authoritative on a NEW or config-changing write (see
    // `hasLegacyEquipmentRequirements`); the editor migrates them to the canonical
    // `minimumLevel` / `requiredLevelType` pair.
    minRaceLevel: z.number().int().nonnegative().optional(),
    requiredRaceType: z.enum(["enlightened", "monster"]).optional(),
    // Canonical eligibility: a nonnegative minimum level on a declared track/race
    // type. `minimumLevel` requires `requiredLevelType`; `requiredLevelType` alone
    // (no level) means a type restriction at level 0 (the track/race must exist and
    // be of the requested type, but the level is not gated).
    minimumLevel: z.number().int().nonnegative().optional(),
    requiredLevelType: z
      .enum(["class", "profession", "humanoidRace", "monstrousRace"])
      .optional(),
    // Optional divine patron eligibility. `requiredGodStableId` names the god's
    // catalog `stableId`; `minimumBlessingTier` (default Baptism when absent) is the
    // lowest blessing tier that satisfies the requirement. A config that sets a
    // minimum tier MUST also name a god.
    requiredGodStableId: z.string().min(1).optional(),
    minimumBlessingTier: blessingTierSchema.optional(),
    // Optional equipment-granted passive skills. Each entry is the catalog
    // `stableId` of a `skills` definition whose current `config.effects` are
    // synthesized live while the item is worn and eligible (`[]` is allowed: an
    // item grants no passive). Every id must be nonempty and internally unique;
    // the service layer resolves each id to an unarchived skill on a new /
    // config-changing write and rejects a missing or archived reference.
    grantedSkillStableIds: z.array(z.string().min(1)).optional(),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    if (data.minimumLevel != null && data.requiredLevelType == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'a "requiredLevelType" ("class"/"profession"/"humanoidRace"/"monstrousRace") is required when "minimumLevel" is set',
        path: ["requiredLevelType"],
      })
    }
    if (data.minimumBlessingTier != null && data.requiredGodStableId == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'a "requiredGodStableId" is required when "minimumBlessingTier" is set',
        path: ["requiredGodStableId"],
      })
    }
    if (data.grantedSkillStableIds != null) {
      const seen = new Set<string>()
      for (const id of data.grantedSkillStableIds) {
        if (seen.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `"${id}" is granted more than once in "grantedSkillStableIds"`,
            path: ["grantedSkillStableIds"],
          })
          break
        }
        seen.add(id)
      }
    }
  })

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
 * (e.g. "Class") or no `track` at all never breaks a read: such a config stays
 * readable/editable and its effects still synthesize, and the unrecognized /
 * missing track is simply ignored for offers. A NEW or CONFIG-CHANGED skill MUST
 * declare an exact enum value (`"race"` / `"class"` / `"profession"`); the
 * service layer rejects a missing track via `isIncompleteSkillConfig` and any
 * other string via `hasInvalidSkillTrack`.
 *
 * `milestone`, `choiceGroup` and `eligibleDefinitionStableIds` are retained as
 * LEGACY annotations carried by offer snapshots: they are still read, imported
 * and exported verbatim, but they no longer restrict scheduled-credit
 * eligibility (a scheduled credit ignores them entirely). `milestone` is
 * optional and has no paired requirement; `choiceGroup` and
 * `eligibleDefinitionStableIds` likewise only describe the authored intent.
 *
 * `classStableId` is an optional, nonempty catalog stableId of a `classes`
 * entry, valid on ANY track. It is PRIORITY ONLY: it never restricts eligibility
 * and is used solely to deterministically order offer options so a skill tied to
 * the earned class sorts first.
 */
export const skillConfigSchema = z
  .object({
    track: z.string().optional(),
    milestone: z.number().int().nonnegative().optional(),
    choiceGroup: z.string().min(1).optional(),
    eligibleDefinitionStableIds: z.array(z.string()).optional(),
    classStableId: z.string().min(1).optional(),
    effects: z.array(skillEffectSchema).optional(),
    upgradeGroup: z.string().optional(),
    rarity: raritySchema.optional(),
  })
  .passthrough()

/**
 * Detect a `skills` config that does not declare a valid `rarity`. A NEW or
 * CONFIG-CHANGED skill must declare a rarity (see `skillConfigSchema`); a legacy
 * config without one stays readable and metadata-only-PATCHable (mirroring the
 * equipment slot/rarity hardening), but is never authoritative for a new or
 * config-changing write.
 */
export function isIncompleteSkillRarity(
  config: Record<string, unknown>
): boolean {
  return !raritySchema.safeParse(config.rarity).success
}

/**
 * A skill config is "incomplete" when it does not declare a `track`. A NEW or
 * CONFIG-CHANGED skill must be typed (an exact `"race"` / `"class"` /
 * `"profession"` value); a config that omits `track` entirely is rejected by the
 * service layer when this returns true so an admin cannot create a skill that
 * silently never offers. Legacy entries (the migration backfills a missing
 * `track` in persisted `catalog_definitions` to `"race"`) stay readable and
 * metadata-only-editable, but a missing `track` is never authoritative for a new
 * or config-changing write.
 */
export function isIncompleteSkillConfig(
  config: Record<string, unknown>
): boolean {
  return config.track == null
}

/**
 * Detect a `skills` config whose `track` is present but not a recognized enum
 * value (`"race"` / `"class"` / `"profession"`). A legacy config may carry an
 * arbitrary track string that is safe to read and ignore for offers, but a NEW
 * or CONFIG-CHANGED skill is rejected by the service layer when this returns
 * true.
 */
export function hasInvalidSkillTrack(config: Record<string, unknown>): boolean {
  const track = config.track
  if (track == null) return false
  return track !== "race" && track !== "class" && track !== "profession"
}

/**
 * Extract a skill config's optional `classStableId` as a trimmed nonempty string,
 * or null when the config declares none (or an empty / malformed value, which the
 * Zod schema would reject on a write but which a legacy row may still carry).
 * Priority-only: this never gates eligibility, only sorts offer options.
 */
export function skillClassStableIdOf(
  config: Record<string, unknown>
): string | null {
  const value = config.classStableId
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * The sequential title-improvement descriptor carried by a ranked title config.
 *
 * A ranked title belongs to a named improvement `seriesId`, occupies a positive
 * `rank` (1..100), and may only be attached to a character whose race grade is at
 * least `minRaceGrade`. The subobject is strict: only these three keys are
 * accepted, so a typo (e.g. `minGrade`) is rejected rather than silently dropped
 * and never enforced.
 */
export const titleImprovementSchema = z
  .object({
    seriesId: z.string().min(1),
    rank: z.number().int().min(1).max(100),
    minRaceGrade: gradeSchema,
  })
  .strict()

export type TitleImprovement = z.infer<typeof titleImprovementSchema>

export const titleConfigSchema = z
  .object({
    grade: gradeSchema.optional(),
    grants: z.record(z.string(), z.number()).optional(),
    flat: nonnegativePartialVectorSchema.optional(),
    percentBasisPoints: nonnegativePartialVectorSchema.optional(),
    upgradeGroup: z.string().optional(),
    improvement: titleImprovementSchema.optional(),
    // Optional title-granted passive skills. Each entry is the catalog `stableId`
    // of a `skills` definition whose current `config.effects` are synthesized live
    // while the character carries the unarchived TITLE link (`[]` is allowed: a
    // title grants no passive). Every id must be nonempty and internally unique;
    // the service layer resolves each id to an unarchived skill on a new /
    // config-changing write and rejects a missing or archived reference.
    grantedSkillStableIds: z.array(z.string().min(1)).optional(),
  })
  .passthrough()
  .superRefine((config, ctx) => {
    // A ranked title is progressed through its upgrade group; the group MUST be
    // the series id so the same-group removal path can atomically displace the
    // prior ranked link. A config that declares an improvement but not the
    // matching group cannot be progressed and is rejected on authoring.
    if (config.improvement != null) {
      if (config.upgradeGroup !== config.improvement.seriesId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `ranked title improvement requires upgradeGroup to equal seriesId ("${config.improvement.seriesId}")`,
          path: ["improvement"],
        })
      }
    }
    // Each granted skill stableId must be internally unique (mirroring the
    // equipment `grantedSkillStableIds` refinement). A repeated id is rejected
    // rather than silently double-granted.
    if (config.grantedSkillStableIds != null) {
      const seen = new Set<string>()
      for (const id of config.grantedSkillStableIds) {
        if (seen.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `"${id}" is granted more than once in "grantedSkillStableIds"`,
            path: ["grantedSkillStableIds"],
          })
          break
        }
        seen.add(id)
      }
    }
  })

/**
 * Catalog config for a `bloodlines` entry.
 *
 * Modern shape (required on NEW or CONFIG-CHANGED writes):
 *   - `effects` is the typed flat/percent declarative effect list. May be `[]`
 *     for a narrative-only bloodline that grants no numeric effect.
 *   - `gradeEffects` (optional) is a partial map of grade -> effect list, so a
 *     bloodline like the Primal Hunter's can scale its Perception bonus per
 *     grade (see docs/rules/bloodlines.md). Grade-specific effects REPLACE the
 *     flat `effects` for the character's exact current race grade; a missing
 *     grade falls back to the base `effects`, and an explicit empty list for the
 *     character's grade suppresses the base effects entirely (never a base+grade
 *     addition).
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
 * Catalog config for a `gods` entry (the Gods & Patrons catalog kind).
 *
 * `pantheon` and `divineRank` are free-text descriptors the UI may surface. A
 * god may ALSO carry a `blessingEffects` map: a partial record of blessing tier
 * -> declarative effect list, so a god's blessing at a given tier synthesizes
 * those effects live when a character links that god+tier as a blessing. A
 * missing tier (or a god with no `blessingEffects` entry for that tier)
 * contributes no effects (the link is still valid and shown, just without a
 * synthesized numeric bonus - no invented value). A god is never auto-linked
 * solely because it exists in the catalog; a character only receives a blessing
 * when an explicit `{godId, tier}` selection is linked.
 *
 * The schema reads permissively (passthrough) so a future shape cannot break a
 * read. `blessingEffects` keys are STRICT - only the eight blessing tiers are
 * accepted, so a typo (e.g. "minor") is rejected rather than silently dropped.
 */
export const godConfigSchema = z
  .object({
    pantheon: z.string().optional(),
    divineRank: z.string().optional(),
    blessingEffects: z
      .partialRecord(blessingTierSchema, z.array(catalogEffectSchema))
      .optional(),
  })
  .passthrough()

/**
 * Catalog config for an `items` entry (the inventory-only catalog kind that
 * replaces the legacy `consumables` kind).
 *
 * ITEM metadata-only in this phase: it carries NO mandatory mechanical fields -
 * no required `type`/`amount`/`durationQuarters`, and no consume path. An item
 * is owned inventory bookkeeping; any permanent/temporary effects it may have
 * already live immutably in Character.state. The config accepts `{}` (an empty
 * object is a valid item config, as is an omitted config) and any optional
 * narrative keys; unknown keys pass through so a legacy `consumables` config
 * (which may still carry `type`/`amount`/`durationQuarters`) reads without
 * breakage. Mechanical application of item effects is a later stage.
 */
export const itemConfigSchema = z
  .object({
    narrative: z.string().optional(),
    description: z.string().optional(),
    grade: gradeSchema.optional(),
  })
  .passthrough()

const catalogConfigSchemaMap: Record<string, z.ZodTypeAny> = {
  races: raceConfigSchema,
  classes: trackConfigSchema,
  professions: trackConfigSchema,
  titles: titleConfigSchema,
  equipment: equipmentConfigSchema,
  skills: skillConfigSchema,
  bloodlines: bloodlineConfigSchema,
  items: itemConfigSchema,
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
