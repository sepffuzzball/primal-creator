/**
 * Character + catalog persistence and engine orchestration.
 *
 * This module is the only place that touches Prisma for character operations. It
 * combines the pure rules engine (lib/rules) with persistence: it builds the
 * server-held RulesConfig from catalog rows, serializes/deserializes the engine
 * CharacterState through Zod, applies mutations inside a transaction with
 * optimistic-concurrency (version) checks, and appends an immutable
 * ProgressionEvent for every state change. No client-supplied stat awards are
 * accepted - every award is derived server-side from catalog definitions.
 *
 * Pure helpers (buildRulesConfig, createInitialState, applyAdvance,
 * applyAllocate, applyEvolve, serializeState/deserializeState) are exported so
 * they can be unit-tested without a database.
 */

import { z } from "zod"
import { Prisma } from "@prisma/client"
import {
  advanceQuarter,
  advanceRaceQuarter,
  allocatePoints,
  allocatedPoints,
  ATTRIBUTES,
  bandForGrade,
  calculateStatus,
  defaultRulesConfig,
  deriveRaceLevel,
  evolveGrade,
  evolveTrackGrade,
  experiencePercentFor,
  gradeLevelUpBlockers,
  gradeOrderIndex,
  isSkillChoiceMilestone,
  levelUpFromExperience,
  makeVector,
  nextGrade,
  permanentConsumableCap,
  setExperiencePercent,
  totalFreePoints,
  zeroVector,
  type AttributeVector,
  type AdvanceResult,
  type CharacterState,
  type DerivedResource,
  type EffectCondition,
  type Grade,
  type GradeBand,
  type PartialVector,
  type RaceDefinition,
  type RaceType,
  type RulesConfig,
  type SkillChoiceIntervals,
  type StatusResult,
  type TrackDefinition,
  type TrackId,
} from "@/lib/rules"
import { prisma } from "@/lib/db/client"
import {
  loadHouseRules,
  type HouseRulesConfig,
  type HouseRulesRow,
} from "@/lib/db/ruleset"
import {
  allGradeGrantedSkillStableIds,
  blessingTierAtLeast,
  characterStateSchema,
  CURRENCY_AMOUNT_MAX,
  currencyGradeDescriptionsForbidden,
  currencyGradeForbidden,
  ENLIGHTENED_INITIAL_TOTAL,
  godGradeForbidden,
  gradeSchema,
  gradeSkillStableIdsFor,
  hasInvalidNaturalGradeConfig,
  hasInvalidRaceTypeConfig,
  hasInvalidSkillTrack,
  hasLegacyEquipmentRequirements,
  isIncompleteRaceConfig,
  isIncompleteSkillConfig,
  isIncompleteSkillRarity,
  isLegacyBloodlineConfig,
  isIncompleteEquipmentConfig,
  isLegacyTranscendentSkillConfig,
  initialAttributesSchema,
  MONSTER_INITIAL_TOTAL,
  normalizeCatalogKind,
  normalizeEquipmentSlot,
  parseCatalogConfig,
  rarityOrderIndex,
  requiredGradeNullForbidden,
  skillClassStableIdOf,
  SKILL_UPGRADE_TARGET_LIMIT,
  skillUpgradeCloneSchema,
  skillGradeDescriptionsForbidden,
  skillGradeForbidden,
  titleImprovementSchema,
  legacyRingPositionForConfig,
  type BlessingTier,
  type TitleImprovement,
} from "@/lib/server/schemas"
import {
  IMPORT_RULESET_VERSION,
  IMPORT_SCHEMA_V3,
  IMPORT_SCHEMA_V4,
  IMPORT_SCHEMA_V5,
  IMPORT_SCHEMA_V6,
  IMPORT_SCHEMA_V7,
  IMPORT_SCHEMA_V8,
  MAX_IMPORT_CURRENCIES,
  MAX_IMPORT_INVENTORY,
  type CharacterImportDocument,
} from "@/lib/server/import-schema"
import { badRequest, conflict, forbidden, notFound } from "@/lib/server/errors"
import { PORTRAIT_KIND, portraitAssetUrl } from "@/lib/storage/portraits"
import type { SessionUser } from "@/lib/auth/session"
import {
  skillUpgradeTargets,
  validateSkillUpgradeGraph,
  type SkillUpgradeNode,
} from "@/lib/skills/upgrade-graph"

// ------------------------------------------------------------------ //
// Types
// ------------------------------------------------------------------ //

const characterInclude = {
  race: true,
  class: true,
  profession: true,
  associations: { include: { definition: true } },
  inventory: { include: { definition: true } },
  skillOffers: {
    include: { options: { include: { definition: true } } },
  },
  // The single currently-active portrait asset (at most one exists per character).
  // Carried on every character read so a list query never issues a per-card
  // portrait fetch; only the character's own asset relation is included, so a
  // list never exposes an asset the user does not own.
  assets: {
    where: { kind: PORTRAIT_KIND },
    orderBy: { updatedAt: "desc" },
    take: 1,
  },
} as const

type CharacterWithCatalog = Prisma.CharacterGetPayload<{
  include: typeof characterInclude
}>

export type DbClient = Prisma.TransactionClient | typeof prisma

/**
 * Declared equipment eligibility requirements (level/type and/or divine patron).
 * The canonical fields are `minimumLevel` + `requiredLevelType` and
 * `requiredGodStableId` + `minimumBlessingTier`. The legacy `minRaceLevel` /
 * `requiredRaceType` pair is still surfaced (readable) for entries that predate
 * the canonical shape; a modern write never persists them.
 */
export type EquipmentRequirements = {
  /** Canonical nonnegative minimum level on the declared `requiredLevelType`. */
  minimumLevel?: number
  /** Canonical track/race type the minimum level applies to. */
  requiredLevelType?: "class" | "profession" | "humanoidRace" | "monstrousRace"
  /** Catalog `stableId` of the divine patron required for eligibility. */
  requiredGodStableId?: string
  /** Lowest blessing tier (default Baptism when only the god is named) that satisfies the patron requirement. */
  minimumBlessingTier?: BlessingTier
  /** Legacy minimum RACE level (readable for pre-canonical entries). */
  minRaceLevel?: number
  /** Legacy required race type (readable for pre-canonical entries). */
  requiredRaceType?: "enlightened" | "monster"
}

export interface CharacterAssociationView {
  id: string
  definitionId: string
  kind:
    "title" | "equipment" | "skill" | "blessing" | "bloodline" | "transcendent"
  name: string
  /**
   * Current catalog prose for the linked definition, read from the live definition
   * (`link.definition.description`) for EVERY association kind. Never falls back to
   * the authored grade-specific `gradeDescription`; `null` when the definition
   * carries no prose. Exposed even for an archived definition, so the UI already
   * receives the current description and never has to consult the active-only skill
   * catalog.
   */
  definitionDescription: string | null
  slot?: string
  upgradeGroup?: string
  /** Catalog grade of the linked definition (skills use this for tiers). */
  grade?: string
  /**
   * Authored grade-specific prose for the linked definition AT ITS OWN catalog
   * `grade` band (never the character's race grade). Present only when the
   * definition declares a grade AND has authored `gradeDescriptions` text for
   * that grade; a null definition grade or an empty map yields an absent field.
   * Never falls back to the legacy `description`.
   */
  gradeDescription?: string
  /** Ranked title progression metadata, when the linked title declares it. */
  improvement?: { seriesId: string; rank: number; minRaceGrade: string }
  /** Whether the linked catalog definition is currently archived. */
  definitionArchived: boolean
  /**
   * The exact blessing tier a blessing link was granted at, present ONLY on a
   * blessing association (which references a `gods` definition). The live effect
   * is synthesized from the god's `blessingEffects[tier]`; never inferred.
   */
  tier?: BlessingTier
  /** Rarity tier, present on equipment and skill links that declare one. */
  rarity?: string
  /** Whether an equipment link is soulbound (metadata only; no transfer mechanic). */
  soulbound?: boolean
  /**
   * Authoritative DIRECT outgoing upgrade target skill stableIds, present ONLY on
   * a skill association (serialized from the linked skill definition's parsed
   * config). The OWN-field distinction is preserved: an absent field (undefined)
   * means the legacy `upgradeGroup` + `rarity` fallback applies; an explicit `[]`
   * means the skill is terminal (no successor, no fallback); a nonempty list names
   * the exact target stableIds (a skill may branch to several). Never present on a
   * non-skill association, regardless of its config.
   */
  upgradeToStableIds?: string[]
  /** Level / race-type / divine-patron requirements an equipment link declares, when any. */
  requirements?: EquipmentRequirements
  /**
   * Live eligibility of an equipment link against the character's current race
   * level / race type / blessing. An ineligible item stays linked (and shown) but
   * its equipment bonus is not synthesized until the character qualifies.
   */
  equipmentEligibility?: { eligible: boolean; reason?: string }
  /**
   * The physical ring position occupied by this equipment link, present ONLY on a
   * Ring-slot item (the single canonical "Ring" catalog slot is worn in two
   * positions). Absent on non-ring equipment links. For UI; the catalog `slot`
   * always shows "Ring".
   */
  equipmentPosition?: "Ring 1" | "Ring 2"
}

/**
 * A read-only view of an owned inventory row. Ownership is per-definition house
 * bookkeeping (no item instances or capacity): only the integer `quantity` and
 * the linked definition's identity/metadata are exposed. `kind` is the catalog
 * kind of the linked definition - always `"equipment"` or `"items"`, since
 * no other kind can be added to inventory.
 */
export interface CharacterInventoryItemView {
  id: string
  definitionId: string
  name: string
  kind: "equipment" | "items"
  quantity: number
  /** Whether the linked catalog definition is currently archived. */
  archived: boolean
  /** Equipment slot, when the linked definition declares one. */
  slot?: string
  /** Equipment rarity tier, present only on equipment definitions. */
  rarity?: string
  /** Whether an equipment definition is soulbound (metadata only). */
  soulbound?: boolean
  /** Level / race-type / divine-patron requirements an equipment definition declares, when any. */
  requirements?: EquipmentRequirements
  /**
   * Live eligibility of an equipment definition against the character's current
   * race level / race type. Metadata for future UI; it does not gate inventory
   * stock ownership (which may always be acquired).
   */
  equipmentEligibility?: { eligible: boolean; reason?: string }
}

export interface SkillOfferOptionView {
  definitionId: string
  nameSnapshot: string
  /** Whether the offered option's catalog definition is currently archived. */
  archived: boolean
  /**
   * Live prose for the offered option, read from the CURRENT catalog definition
   * (never the immutable `nameSnapshot`). A skill carries no grade-specific prose
   * (migration 20261017200000_skill_grade_removed cleared any authored
   * `gradeDescriptions`), so this is always the definition's `description`. The
   * authored grade-specific text at the offer's snapshotted `earnedGrade` is still
   * preferred on a legacy skill row that carries it; otherwise the legacy
   * `description` is used. `null` when the linked definition is missing (no
   * catalog match) or carries no prose at all.
   */
  description: string | null
  /**
   * Rarity tier, read from the option's IMMUTABLE earned `configSnapshot` (never
   * the live catalog config). `null` when the snapshot declares none or a
   * non-string value.
   */
  rarity: string | null
  /**
   * Skill track type, read from the option's IMMUTABLE earned `configSnapshot`
   * (never the live catalog config). A legacy snapshot that omits the type falls
   * back to the offer's own track; `null` only when neither carries a recognized
   * `"race" | "class" | "profession"` value.
   */
  skillType: "race" | "class" | "profession" | null
  /**
   * Catalog stableId of the class the option ties to, read from the option's
   * IMMUTABLE earned `configSnapshot` (never the live catalog config). `null`
   * when the snapshot declares none.
   */
  classStableId: string | null
  /**
   * Catalog tier grade of the offered definition, when set. A skill offer option
   * never carries one - a skill has no catalog grade band (migration
   * 20261017200000_skill_grade_removed), so `grade` is always omitted on a skill
   * option even when the row still holds a legacy value.
   */
  grade?: string
  /**
   * Whether the option is priority-tied to the offer's snapshotted earned class.
   * True only when the option's PERSISTED config snapshot declares a nonempty
   * `classStableId` exactly equal to the offer's snapshotted `classStableIdAtEarn`
   * (itself nonempty). Always false on a legacy/imported offer (no earned-class
   * snapshot) and for a monster race credit (which has no class). Computed from
   * the persisted earned context, never the character's current class.
   * Priority-only: never eligibility, never order-changing.
   */
  classPriority: boolean
}

export interface SkillOfferView {
  id: string
  track: string
  level: number
  choiceGroup: string
  /** Sequential offer generation for this base key (0 = initial offer). */
  generation: number
  /**
   * When the offer was canceled (append-only). Null while the offer is still
   * active and selectable. The UI marks a canceled offer non-selectable; it stays
   * visible as historical record.
   */
  canceledAt: string | null
  options: SkillOfferOptionView[]
  selectedDefinitionId: string | null
  /**
   * Provenance of a schedule (milestone) credit: the grade whose skill-choice
   * interval awarded this offer. Null on legacy/imported offers.
   */
  earnedGrade?: string | null
  /**
   * Catalog stableId of the selected track at the moment the credit was earned.
   * Null on legacy/imported offers.
   */
  trackDefinitionStableId?: string | null
  /**
   * Catalog stableId of the character's selected CLASS at the moment the credit
   * was earned, snapshotted at EARNING time for class/profession credits and null
   * for a monster race credit (which has no class). Populated only on a
   * scheduled/milestone offer; null on legacy/imported offers. Priority-only: it
   * drives deterministic option ordering (skills whose `classStableId` matches
   * sort first), never eligibility.
   */
  classStableIdAtEarn?: string | null
}

export interface CharacterDetail {
  id: string
  name: string
  description: string | null
  nickname: string | null
  pronouns: string | null
  ageDescription: string | null
  appearance: string | null
  biography: string | null
  notes: string | null
  origin: "integrated" | "born"
  raceId: string | null
  classId: string | null
  professionId: string | null
  raceName: string | null
  className: string | null
  professionName: string | null
  /**
   * Authored grade-specific prose for the character's linked race definition at
   * the character's current race grade (`state.race.grade`). `null` when the race
   * definition is missing, carries no authored text for that grade, or the
   * character has no race. Never falls back to the legacy `description`.
   */
  raceGradeDescription: string | null
  /**
   * Authored grade-specific prose for the character's linked class definition at
   * the class track's OWN grade (`state.tracks.class.grade`). `null` when the
   * class definition is missing, carries no authored text for that grade, or the
   * legacy track has no explicit grade (no inference from the race grade). Never
   * falls back to the legacy `description`.
   */
  classGradeDescription: string | null
  /**
   * Authored grade-specific prose for the character's linked profession
   * definition at the profession track's OWN grade
   * (`state.tracks.profession.grade`). `null` when the profession definition is
   * missing, carries no authored text for that grade, or the legacy track has no
   * explicit grade (no inference from the race grade). Never falls back to the
   * legacy `description`.
   */
  professionGradeDescription: string | null
  state: unknown
  version: number
  archived: boolean
  /** True when the character was created from a user-supplied trusted-backup import. */
  imported: boolean
  /**
   * Derived transcendent quality: true when at least one unarchived linked
   * `transcendent_skills` (AssociationKind TRANSCENDENT) definition exists. Not a
   * persisted flag - it is recomputed at read time from the live links, so
   * archiving/unlinking the last active definition clears it.
   */
  isTranscendent: boolean
  createdAt: string
  updatedAt: string
  associations: CharacterAssociationView[]
  /**
   * Owned inventory quantities (equipment + items), including archived
   * catalog stock. Absent = zero owned stock of that definition.
   */
  inventory: CharacterInventoryItemView[]
  /** Pending + selected skill offers (milestone choices) for this character. */
  skillOffers: SkillOfferView[]
  status?: StatusResult
  /**
   * Server-computed grade-ceiling blockers for a +Level on each level-able track,
   * keyed by track (`race` | `class` | `profession`). A track is present only when
   * a level-up on it is blocked by the authoritative current grade ceiling; an
   * absent key means a level-up is allowed on that track (or the track is not
   * level-able in the character's current mode). Computed in `toDetail` from the
   * same grade table and race derivation as the progression engine - never a
   * second query and never mutated state.
   */
  levelUpBlocked?: Partial<Record<"race" | "class" | "profession", string>>
  /**
   * Server-computed permanent-consumable capacity per attribute (authoritative;
   * the UI must not recompute this). Populated on every character detail read.
   */
  permanentConsumableCap?: PartialVector
  /** Server-computed remaining permanent-consumable capacity per attribute. */
  permanentConsumableRemaining?: PartialVector
  /**
   * The version of the server-wide house-rules config this detail was derived
   * from. Always present - the singleton house-rules row is required (a missing
   * row yields a 503 `ruleset_unavailable`, never a silent default). Lets the UI
   * detect that a rule edit has bumped the config.
   */
  rulesetVersion?: number
}

export interface CharacterListItem {
  id: string
  name: string
  description: string | null
  raceName: string | null
  className: string | null
  professionName: string | null
  updatedAt: string
  archived: boolean
  /** True when the character was created from a user-supplied trusted-backup import. */
  imported: boolean
  /** The character's authoritative race grade, read from stored state (never derived from level). */
  raceGrade: Grade
  /** The character's current race level, read from stored state. */
  raceLevel: number
  /**
   * The configured level band for the character's race grade per the current
   * house-rules grade table (inclusive min/max). `null` when that grade has no
   * configured band. Exposed even when the level falls outside the band (a born
   * high-grade character at level 0), since the starting grade is provenance
   * driven, not level driven.
   */
  raceGradeBand: { min: number; max: number } | null
  /**
   * The character's active portrait, or null when none has been uploaded. The
   * `url` is always the canonical authenticated `/api/assets/{id}` route (never a
   * filesystem path). Present on every list response.
   */
  portrait: { assetId: string; url: string } | null
  status?: StatusResult
  /**
   * The version of the server-wide house-rules config this list item was derived
   * from. Always present - the singleton house-rules row is required (a missing
   * row yields a 503 `ruleset_unavailable`, never a silent default).
   */
  rulesetVersion?: number
}

export interface CatalogItem {
  id: string
  kind: string
  stableId: string
  name: string
  description: string | null
  grade: string | null
  sourceUrl: string | null
  archived: boolean
  config: Record<string, unknown>
  /**
   * Grade-specific prose descriptions keyed by the grade ladder (G..S), authored
   * independently of the legacy `description` string and of the entry's own
   * `grade` band. Always present; an entry with no authored grade text reads back
   * as `{}`.
   */
  gradeDescriptions: Partial<Record<Grade, string>>
  createdAt: string
  updatedAt: string
}

// ------------------------------------------------------------------ //
// Character-profile metadata normalization
// ------------------------------------------------------------------ //

/**
 * Normalize an optional character-profile metadata value at the persistence
 * boundary. Converts ONLY the exact empty string `""` to NULL (a blank posted
 * field clears the stored value) and otherwise preserves the input VERBATIM -
 * leading/trailing whitespace and internal newlines are never trimmed, so
 * users can type "  \nHello\n  " and have it round-trip exactly as written.
 * An omitted/null argument stays null.
 */
export function metadataOrNull(
  value: string | null | undefined
): string | null {
  if (value === "") return null
  return value ?? null
}

// ------------------------------------------------------------------ //
// Serialization / deserialization of the engine state
// ------------------------------------------------------------------ //

/** Encode engine state as a JSON-safe object (Zod validated on the way out). */
export function serializeState(state: CharacterState): unknown {
  return characterStateSchema.parse(state)
}

/** Decode and validate stored JSON back into an engine CharacterState. */
export function deserializeState(json: unknown): CharacterState {
  return characterStateSchema.parse(json)
}

// ------------------------------------------------------------------ //
// Config building (server-held; never client-supplied)
// ------------------------------------------------------------------ //

type CatalogRow = {
  kind: string
  stableId: string
  name: string
  config: unknown
}

function raceDefinitionsFrom(
  config: Record<string, unknown>
): Partial<Record<Grade, RaceDefinition>> {
  const defs = (config.raceDefinitions ?? {}) as Record<
    string,
    {
      id: string
      perLevel?: Partial<Record<string, number>>
      freePerLevel?: number
    }
  >
  const out: Partial<Record<Grade, RaceDefinition>> = {}
  for (const [grade, d] of Object.entries(defs)) {
    out[grade as Grade] = {
      id: d.id,
      perLevel: makeVector(d.perLevel ?? {}),
      freePerLevel: d.freePerLevel ?? 0,
    }
  }
  return out
}

/**
 * Build the engine RulesConfig for a single character from its catalog rows.
 * Everything not sourced from a catalog row keeps the engine default (which is
 * itself a documented house assumption), so no canon formula is invented.
 *
 * `houseRules` is the validated, admin-editable singleton house config
 * (`HouseRulesConfig` from lib/db/ruleset.ts). When supplied it OVERRIDES the
 * engine defaults for the three editable knobs (equipment caps + consumable grade
 * rates); everything else (grade table, race derivation strategy, open grade
 * gates, permanent race caps, unresolved resources) stays at the engine default.
 * It never rewrites historical awards - it only changes how future/live values
 * are derived.
 */
export function buildRulesConfig(
  raceRow: CatalogRow | null,
  houseRules?: HouseRulesConfig
): RulesConfig {
  const config = defaultRulesConfig()
  if (raceRow) {
    const parsed = parseCatalogConfig(raceRow.kind, raceRow.config ?? {})
    const defs = raceDefinitionsFrom(parsed)
    if (Object.keys(defs).length > 0) config.raceDefinitions = defs
  }
  if (houseRules) {
    config.equipmentIndividualCapPercent =
      houseRules.equipmentIndividualCapPercent
    config.equipmentCombinedCapPercent = houseRules.equipmentCombinedCapPercent
    config.consumableGradeRates = {
      ...config.consumableGradeRates,
      ...houseRules.consumableGradeRates,
    }
  }
  // resourceMultipliers stay null (derived resources unresolved -> max null).
  // consumable grades not individually overridden keep the engine assumptions.
  // gradeGates stay open ({}).
  return config
}

/** The grade table order index, used only for choosing a fallback definition. */
function gradeIndex(grade: string): number {
  const idx = gradeOrderIndex(grade as Grade)
  return Number.isFinite(idx) ? idx : 0
}

/** Whether a class/profession catalog row defines per-level gains for `grade`. */
function trackHasGradeConfig(row: CatalogRow, grade: string): boolean {
  const config = parseCatalogConfig(row.kind, row.config ?? {})
  const grades = (config.grades ?? {}) as Record<string, unknown>
  return grades[grade] != null
}

/**
 * Resolve the track definition to use for advancing `track`.
 *
 * - A **graded** track (`state.tracks[track].grade` present) selects EXACTLY that
 *   grade's per-grade config and returns null when the catalog row defines no
 *   config for it - it never falls back to another grade. This keeps a graded
 *   class/profession pinned to its declared grade, so a missing per-grade config
 *   surfaces as an actionable "no_definition" rather than silently using a
 *   different grade's gains.
 * - An **ungraded legacy** track keeps the race-grade fallback: the definition is
 *   chosen by the character's current race grade, and if that grade has no
 *   definition in the catalog row, the lowest-defined grade is used.
 *
 * Returns null when the catalog row defines no per-grade track gains.
 */
export function resolveTrackDefinition(
  row: CatalogRow | null,
  state: CharacterState,
  track: TrackId
): TrackDefinition | null {
  if (!row) return null
  const config = parseCatalogConfig(row.kind, row.config ?? {})
  const grades = (config.grades ?? {}) as Record<
    string,
    { fixed?: Partial<Record<string, number>>; free?: number }
  >
  const entries = Object.entries(grades)
  if (entries.length === 0) return null

  const gradedTrack = state.tracks[track]?.grade
  if (gradedTrack) {
    const chosen = entries.find(([g]) => g === gradedTrack)
    if (!chosen) return null
    const [grade, def] = chosen
    return {
      id: `${row.stableId}:${grade}`,
      name: row.name,
      fixed: makeVector(def.fixed ?? {}),
      free: def.free ?? 0,
      grade: grade as Grade,
    }
  }

  entries.sort((a, b) => gradeIndex(a[0]) - gradeIndex(b[0]))
  let chosen = entries.find(([g]) => g === state.race.grade)
  if (!chosen) chosen = entries[0]
  const [grade, def] = chosen
  return {
    id: `${row.stableId}:${grade}`,
    name: row.name,
    fixed: makeVector(def.fixed ?? {}),
    free: def.free ?? 0,
    grade: grade as Grade,
  }
}

// ------------------------------------------------------------------ //
// Initial state
// ------------------------------------------------------------------ //

/**
 * Build the engine CharacterState for a newly created character.
 *
 * - Tracks (class/profession) start at level 0 (a configurable start could be
 *   injected by overriding the level, but 0 is the safe default).
 * - Race level is 0. Integrated origin -> grade G; born -> grade F. Grade is the
 *   origin-driven starting grade, not derived from level.
 * - No awards are granted at creation; every award is a server-side snapshot from
 *   the catalog. Base attributes are zero (no fabricated starting stats).
 *
 * `classRow` is optional: it is supplied by the real `createCharacter` flow and
 * marks a "graded" new character. When present, the class track (and, if
 * `professionRow` is also supplied, the profession track) is stamped with the
 * explicit starting F grade and the `stableId:F` definition, so a new class or
 * profession is immediately gated by its own (not the race's) grade. Existing
 * pure-helper callers that omit `classRow` keep the legacy ungraded state (empty
 * definitionId, no explicit grade), preserving their behavior.
 */
export function createInitialState(
  origin: "integrated" | "born",
  raceRow: CatalogRow | null,
  professionRow: CatalogRow | null,
  classRow?: CatalogRow | null,
  // Optional fully-allocated initial stat vector. The production `createCharacter`
  // ALWAYS passes the validated vector from the required `initialAttributes` API
  // field; legacy unit-fixture callers that omit it keep the historical zero-vector
  // base (never fabricated stats, so their assertions are unchanged).
  baseAttributes?: AttributeVector
): CharacterState {
  const tracks: CharacterState["tracks"] = {}
  const classLevel = 0
  const professionLevel = 0

  // Resolve the race's authoritative advancement mode from its config. A legacy
  // config without `raceType` is interpreted as `enlightened` (non-authoritative,
  // preserved backups/UI). A monster is race-only: no class/profession tracks.
  const raceConfig = raceRow
    ? parseCatalogConfig(raceRow.kind, raceRow.config ?? {})
    : {}
  const raceType =
    (raceConfig.raceType as RaceType | undefined) ?? "enlightened"
  const naturalGrade = gradeSchema.safeParse(raceConfig.naturalGrade).success
    ? (raceConfig.naturalGrade as Grade)
    : undefined

  // An enlightened race's class/profession tracks are stamped with the race's
  // natural grade (or the legacy F fallback when the config carries none), so a
  // new class/profession is immediately gated by the grade it must operate at.
  const trackStartGrade: Grade = naturalGrade ?? "F"

  // The race's own starting grade is origin-driven: an integrated character
  // always enters at G; a born character enters at the race's natural grade (F
  // fallback) - never derived from level.
  const raceStartGrade: Grade =
    origin === "integrated" ? "G" : (naturalGrade ?? "F")

  if (raceType !== "monster") {
    tracks["class"] = {
      level: classLevel,
      quarter: 0,
      definitionId: classRow ? `${classRow.stableId}:${trackStartGrade}` : "",
      ...(classRow ? { grade: trackStartGrade } : {}),
    }
    if (professionRow) {
      tracks["profession"] = {
        level: professionLevel,
        quarter: 0,
        definitionId: classRow
          ? `${professionRow.stableId}:${trackStartGrade}`
          : "",
        ...(classRow ? { grade: trackStartGrade } : {}),
      }
    }
  }

  return {
    baseAttributes: baseAttributes ?? zeroVector(),
    tracks,
    race:
      raceType === "monster"
        ? {
            level: 0,
            grade: raceStartGrade,
            mode: "independent",
            origin,
            // Monsters advance on a four-quarter cadence; derived (enlightened)
            // races never use it.
            quarter: 0,
          }
        : {
            level: 0,
            grade: raceStartGrade,
            mode: "derived",
            origin,
          },
    historicalLevelAwards: [],
    allocations: [],
    permanentGains: [],
    activeEffects: [],
    equipment: [],
    currentResources: {},
    turn: 0,
  }
}

// ------------------------------------------------------------------ //
// Initial-attribute validation
// ------------------------------------------------------------------ //

/**
 * Validate a client-supplied initial stat vector AND its category-dependent total,
 * returning the verified engine AttributeVector.
 *
 * The shape (full nine-key, each a safe integer >= 1, no extra keys) is enforced
 * by `initialAttributesSchema` (the same strict shape the API boundary uses). The
 * TOTAL is category-dependent and only known once the authoritative race type is
 * resolved, so it is enforced here, inside the transaction, AFTER the race config
 * is read - never at the API boundary, where Zod cannot see the race config.
 *
 * Budgets: 70 for an enlightened (class/profession) race, 210 for a monster
 * (race-only) race. A missing / shape-invalid / wrong-total vector rejects with
 * 400 `invalid_initial_attributes` BEFORE any character write or draft consume.
 */
function validateInitialAttributes(
  value: unknown,
  raceType: RaceType
): AttributeVector {
  const parsed = initialAttributesSchema.safeParse(value)
  if (!parsed.success) {
    throw badRequest(
      "invalid_initial_attributes",
      "initialAttributes must be a full nine-key attribute vector (strength, agility, endurance, vitality, toughness, wisdom, intelligence, perception, willpower), each a safe integer >= 1, with no extra keys"
    )
  }
  const vector = parsed.data
  const budget =
    raceType === "monster" ? MONSTER_INITIAL_TOTAL : ENLIGHTENED_INITIAL_TOTAL
  let total = 0
  for (const attr of ATTRIBUTES) total += vector[attr]
  if (total !== budget) {
    throw badRequest(
      "invalid_initial_attributes",
      `initialAttributes sum ${total} does not match the ${raceType} race budget of ${budget}`
    )
  }
  return vector
}

// ------------------------------------------------------------------ //
// Pure application helpers
// ------------------------------------------------------------------ //

/** Run advanceQuarter but allow a definitionId transition after an evolution. */
export function applyAdvance(
  state: CharacterState,
  trackId: TrackId,
  definition: TrackDefinition,
  config: RulesConfig
) {
  const existing = state.tracks[trackId]
  if (!existing) {
    throw badRequest("unknown_track", `Character has no "${trackId}" track`)
  }
  // A graded track (explicit class/profession grade) is pinned to exactly one
  // per-grade definition: advancing with a definition from a different grade is a
  // 400, never a silent swap. Only an UNGRADED legacy state permits the silent
  // definition-id transition after an evolution (the engine's consistency guard
  // would otherwise reject the advance).
  if (
    existing.grade != null &&
    existing.definitionId &&
    existing.definitionId !== definition.id
  ) {
    throw badRequest(
      "definition_mismatch",
      `Track "${trackId}" is grade ${existing.grade} with definition "${existing.definitionId}"; cannot advance with definition "${definition.id}"`
    )
  }
  let next = state
  if (existing.definitionId && existing.definitionId !== definition.id) {
    next = {
      ...next,
      tracks: {
        ...next.tracks,
        [trackId]: { ...existing, definitionId: definition.id },
      },
    }
  }
  return advanceQuarter(next, trackId, definition, config)
}

export function applyAllocate(
  state: CharacterState,
  allocation: Partial<Record<string, number>>
) {
  const result = allocatePoints(state, allocation)
  if (!result.ok || !result.state) {
    throw badRequest("allocation", result.errors.join("; "))
  }
  return result.state
}

export function applyEvolve(
  state: CharacterState,
  grade: Grade,
  config: RulesConfig
) {
  const result = evolveGrade(state, grade, config)
  if (!result.ok) {
    throw badRequest("evolution", result.errors.join("; "))
  }
  return { state: result.state!, journal: result.journal }
}

// ------------------------------------------------------------------ //
// DTO helpers
// ------------------------------------------------------------------ //

/** A single declarative passive effect read out of a catalog `config.effects`. */
type DeclarativeEffect = {
  phase: string
  amount?: PartialVector
  basisPoints?: PartialVector
  condition?: EffectCondition
  stacking?: "replace" | "stack" | "stackCapped"
  group?: string
}

/**
 * Synthesize a list of declarative catalog effects into `activeEffects`,
 * preserving each effect's OWN phase/condition/stacking/group. The `upgradeGroup`
 * on the catalog entry is never used here (it is only an add/select replacement
 * group), so a single entry's flat AND percent effects both apply. `idBase` is
 * the prefix used to give every effect a unique id - for a skill/blessing it is
 * the definition id, and for a bloodline's grade-replacement effects it is
 * `def.id:grade-<grade>` so a grade-replacement effect never shares an id with a
 * base effect (a bloodline applies EXACTLY ONE set per character - either the
 * base effects or the matching grade's, never both).
 * `source` comes from the catalog row; the synthesized effect's `provenance` is
 * the generic internal `"catalog"` string (the catalog provenance taxonomy no
 * longer exists).
 */
function appendDeclarativeEffects(
  activeEffects: CharacterState["activeEffects"],
  def: { id: string; name: string },
  effects: DeclarativeEffect[],
  idBase: string
): void {
  for (let i = 0; i < effects.length; i++) {
    const eff = effects[i]
    const group = eff.group
    const base = {
      id: `${idBase}:eff-${i}`,
      source: def.name,
      provenance: "catalog",
      condition: eff.condition,
      group,
      stacking: eff.stacking ?? (group ? "replace" : "stack"),
    }
    if (eff.phase === "flat") {
      activeEffects.push({
        ...base,
        phase: "flat",
        amount: makeVector(eff.amount ?? {}),
      })
    } else if (eff.phase === "percent") {
      activeEffects.push({
        ...base,
        phase: "percent",
        basisPoints: makeVector(eff.basisPoints ?? {}),
      })
    }
  }
}

/**
 * Synthesize the live `activeEffects` for every skill a catalog config grants via
 * `grantedSkillStableIds`, using the shared unarchived-skill map (loading it on
 * demand through `db` when first needed) and the shared dedup sets. A skill
 * already linked as a SKILL association wins (skip); otherwise the first eligible,
 * unarchived grant encountered across equipment AND title associations applies
 * once and is never double counted. Returns the (possibly newly loaded) skill map
 * so the caller keeps the in-request `sharedSkillMap` optimization.
 */
async function appendGrantedSkillEffects(
  activeEffects: CharacterState["activeEffects"],
  def: { id: string; name: string },
  granted: string[] | undefined,
  linkedSkillStableIds: Set<string>,
  appliedSkillStableIds: Set<string>,
  skillMap: Map<string, UnarchivedSkillDef> | null,
  db: DbClient
): Promise<Map<string, UnarchivedSkillDef> | null> {
  if (!granted || granted.length === 0) return skillMap
  for (const stableId of granted) {
    if (linkedSkillStableIds.has(stableId)) continue
    if (appliedSkillStableIds.has(stableId)) continue
    if (skillMap == null) skillMap = await loadUnarchivedSkillMap(db)
    const skillDef = skillMap.get(stableId)
    if (!skillDef) continue
    appliedSkillStableIds.add(stableId)
    appendDeclarativeEffects(
      activeEffects,
      {
        id: `${def.id}:granted:${stableId}`,
        name: `${def.name} (${skillDef.name})`,
      },
      (skillDef.config.effects ?? []) as DeclarativeEffect[],
      `${def.id}:granted:${stableId}`
    )
  }
  return skillMap
}

/**
 * The character's authoritative race type for equipment ELIGIBILITY ONLY. An
 * explicit catalog `raceType` is always authoritative. For a LEGACY race config
 * with no `raceType`, resolve from the character's race mode instead:
 * `independent` (a monster) => `monster`, anything else (`derived`) =>
 * `enlightened`. This eligibility-only resolution changes no other race-category
 * semantics - it does not affect how the race itself is classified anywhere else.
 */
function characterRaceType(
  character: { race?: { config?: unknown } | null },
  state: CharacterState
): RaceType {
  if (!character.race) {
    return state.race.mode === "independent" ? "monster" : "enlightened"
  }
  const raceConfig = parseCatalogConfig("races", character.race.config ?? {})
  const raceType = raceConfig.raceType as RaceType | undefined
  if (raceType) return raceType
  // Legacy race config with no explicit raceType: fall back to the character's
  // race mode for eligibility only (independent => monster, derived =>
  // enlightened).
  return state.race.mode === "independent" ? "monster" : "enlightened"
}

/**
 * The subset of a character an equipment eligibility check needs beyond the stored
 * state: the race catalog row (to resolve the eligibility-only race type) and the
 * live associations (to verify a divine-patron requirement against the character's
 * active blessing link).
 */
type EquipmentEligibilityAssociation = {
  kind: string
  blessingTier?: string | null
  definition?: {
    kind: string
    name?: string
    stableId: string
    archived: boolean
    config?: unknown
  } | null
}

type EquipmentEligibilityCharacter = {
  race?: { config?: unknown } | null
  associations?: EquipmentEligibilityAssociation[]
}

/**
 * Whether a character currently meets an equipment config's eligibility
 * requirements.
 *
 * The canonical requirement pair is `minimumLevel` + `requiredLevelType`:
 *   - `class` / `profession` require the track to exist (no track -> ineligible) and
 *     compare its own level;
 *   - `humanoidRace` requires the eligibility race type to resolve to `enlightened`
 *     and compares the RACE level;
 *   - `monstrousRace` requires the eligibility race type to resolve to `monster`
 *     and compares the RACE level.
 * `requiredLevelType` alone (no `minimumLevel`) means a type restriction at level 0
 * (the track/race must exist and match the type).
 *
 * The legacy `minRaceLevel` / `requiredRaceType` pair remains readable and enforced
 * for pre-canonical entries (a modern write never persists them), mapping
 * `enlightened` to humanoid races and `monster` to monstrous races.
 *
 * A divine-patron requirement (`requiredGodStableId`) requires an active, unarchived
 * BLESSING link to a god whose catalog `stableId` matches, carrying a blessing tier
 * at or above `minimumBlessingTier` (default `Baptism`). No matching link, an
 * archived god, or a too-low tier is ineligible.
 *
 * Returns a human-readable reason when ineligible. This gates only the live
 * equipment bonus: a linked-but-ineligible item stays linked and is still shown,
 * just synthesized without its bonus.
 */
function equipmentEligibilityFor(
  config: Record<string, unknown>,
  state: CharacterState,
  character: EquipmentEligibilityCharacter
): { eligible: boolean; reason?: string } {
  // Canonical level/type requirements.
  const minimumLevel = config.minimumLevel
  const requiredLevelType = config.requiredLevelType
  if (
    requiredLevelType === "class" ||
    requiredLevelType === "profession" ||
    requiredLevelType === "humanoidRace" ||
    requiredLevelType === "monstrousRace"
  ) {
    if (requiredLevelType === "class" || requiredLevelType === "profession") {
      const label = requiredLevelType === "class" ? "Class" : "Profession"
      const track = state.tracks[requiredLevelType]
      if (!track) {
        return {
          eligible: false,
          reason: `Requires an active ${label} track`,
        }
      }
      const min = typeof minimumLevel === "number" ? minimumLevel : 0
      if (track.level < min) {
        return {
          eligible: false,
          reason: `Requires ${label} level ${min} or higher (currently ${track.level})`,
        }
      }
    } else {
      const requiredRace =
        requiredLevelType === "humanoidRace" ? "enlightened" : "monster"
      const characterType = characterRaceType(character, state)
      const label = (t: RaceType) =>
        t === "monster" ? "monstrous" : "humanoid"
      if (characterType !== requiredRace) {
        return {
          eligible: false,
          reason: `Requires a ${label(requiredRace)} race (currently ${label(characterType)})`,
        }
      }
      const min = typeof minimumLevel === "number" ? minimumLevel : 0
      if (state.race.level < min) {
        return {
          eligible: false,
          reason: `Requires ${label(requiredRace)} race level ${min} or higher (currently ${state.race.level})`,
        }
      }
    }
  }

  // Legacy minRaceLevel / requiredRaceType (readable and enforced).
  const minRaceLevel = config.minRaceLevel
  const raceLevel = state.race.level
  if (typeof minRaceLevel === "number" && raceLevel < minRaceLevel) {
    return {
      eligible: false,
      reason: `Requires race level ${minRaceLevel} or higher (currently ${raceLevel})`,
    }
  }
  const requiredRaceType = config.requiredRaceType
  if (requiredRaceType === "enlightened" || requiredRaceType === "monster") {
    const characterType = characterRaceType(character, state)
    if (characterType !== requiredRaceType) {
      const label = (t: RaceType) =>
        t === "monster" ? "monstrous" : "humanoid"
      return {
        eligible: false,
        reason: `Requires a ${label(requiredRaceType)} race (currently ${label(characterType)})`,
      }
    }
  }

  // Divine-patron requirements.
  const requiredGodStableId = config.requiredGodStableId
  if (
    typeof requiredGodStableId === "string" &&
    requiredGodStableId.length > 0
  ) {
    const minTier =
      (config.minimumBlessingTier as BlessingTier | undefined) ?? "Baptism"
    let matched = false
    for (const link of character.associations ?? []) {
      if (link.kind !== "BLESSING") continue
      const def = link.definition
      if (!def || def.kind !== "gods") continue
      if (def.stableId !== requiredGodStableId) continue
      matched = true
      const godName = def.name ?? def.stableId
      if (def.archived) {
        return {
          eligible: false,
          reason: `Requires a blessing from ${godName}; that divine patron is archived`,
        }
      }
      const linkTier = (link.blessingTier as BlessingTier | null) ?? null
      if (linkTier == null) {
        return {
          eligible: false,
          reason: `Requires a blessing from ${godName} at ${minTier} or higher (no tier granted)`,
        }
      }
      if (!blessingTierAtLeast(linkTier, minTier)) {
        return {
          eligible: false,
          reason: `Requires ${godName}'s blessing at ${minTier} or higher (currently ${linkTier})`,
        }
      }
      break
    }
    if (!matched) {
      return {
        eligible: false,
        reason: `Requires a blessing from the ${requiredGodStableId} patron (none linked)`,
      }
    }
  }

  return { eligible: true }
}

/**
 * Copy the finite integer derived-resource (hp/mp/sp) bonuses from a catalog
 * config object into the engine's `Partial<Record<DerivedResource, number>>`
 * shape. Non-finite / missing values are dropped so a synthesized live equipment
 * item never carries NaN or Infinity.
 */
function makeDerivedVector(
  partial: unknown
): Partial<Record<DerivedResource, number>> {
  const out: Partial<Record<DerivedResource, number>> = {}
  if (partial == null || typeof partial !== "object") return out
  const source = partial as Record<string, unknown>
  for (const resource of ["hp", "mp", "sp"] as const) {
    const v = source[resource]
    if (typeof v === "number" && Number.isFinite(v)) out[resource] = v
  }
  return out
}

/**
 * An unarchived `skills` catalog definition resolved by stableId for
 * equipment-granted passive synthesis. Only the fields `liveState` needs are
 * carried; the `config` is the parsed catalog config object.
 */
type UnarchivedSkillDef = {
  id: string
  name: string
  stableId: string
  config: Record<string, unknown>
}

/**
 * Load the catalog definitions that equipment-granted passive skills may resolve
 * to: every unarchived `skills` entry, keyed by stableId. Queried on demand (only
 * when an eligible equipped item actually declares `grantedSkillStableIds`), and
 * only unarchived rows are loaded so an archived skill is naturally inert. A skill
 * that is not in the map cannot be granted (it is skipped, never inferred).
 */
async function loadUnarchivedSkillMap(
  db: DbClient
): Promise<Map<string, UnarchivedSkillDef>> {
  const rows = await db.catalogDefinition.findMany({
    where: { kind: "skills", archived: false },
  })
  const map = new Map<string, UnarchivedSkillDef>()
  for (const row of rows) {
    map.set(row.stableId, {
      id: row.id,
      name: row.name,
      stableId: row.stableId,
      config: (row.config ?? {}) as Record<string, unknown>,
    })
  }
  return map
}

/**
 * Build a read-time "live" CharacterState by merging the immutable stored state
 * with equipment and effects synthesized from the character's currently linked,
 * unarchived catalog definitions. The stored `state` is never mutated, so
 * history stays immutable; catalog edits recalculate live effects without
 * rewriting historical awards. Existing stored effects/equipment are respected
 * (they are never overwritten, only appended).
 */
async function liveState(
  character: CharacterWithCatalog,
  db: DbClient = prisma,
  sharedSkillMap?: Map<string, UnarchivedSkillDef> | null
): Promise<CharacterState> {
  const state = deserializeState(character.state)
  const equipment = [...state.equipment]
  const activeEffects = [...state.activeEffects]
  // Dedup: a skill stableId granted by equipment must never be counted twice. It
  // is applied once, and an existing linked SKILL association takes priority - so
  // collect every stableId already linked as a SKILL association and skip it in
  // the equipment-granted synthesis (a linked archived skill is inert either way).
  const linkedSkillStableIds = new Set<string>()
  for (const link of character.associations) {
    const linkedDef = link.definition
    if (linkedDef && link.kind === "SKILL" && linkedDef.kind === "skills") {
      linkedSkillStableIds.add(linkedDef.stableId)
    }
  }
  // Across equipment items, a skill stableId may be granted more than once; only
  // the first equipped (association order) grant applies.
  const appliedSkillStableIds = new Set<string>()
  // Lazily loaded only when an eligible equipped item actually grants a skill. A
  // caller that already loaded the unarchived-skill map for the whole request
  // (e.g. listCharacters withStatus) passes it via `sharedSkillMap` so this never
  // issues a second (per-character) lookup; a null value means load on demand.
  let skillMap: Map<string, UnarchivedSkillDef> | null = sharedSkillMap ?? null
  for (const link of character.associations) {
    const def = link.definition
    if (!def || def.archived) continue
    const config = parseCatalogConfig(def.kind, def.config ?? {})
    if (def.kind === "equipment") {
      const slot = config.slot as string | undefined
      if (!slot) continue
      // A linked item whose level / race-type requirement is currently unmet is
      // still shown (the link, stock and journal stay intact) but its bonus is
      // not synthesized until the character qualifies.
      const eligible = equipmentEligibilityFor(
        config,
        state,
        character
      ).eligible
      // Ring is ONE catalog slot ("Ring") but a character may wear two rings, one
      // per position, so the live state uses the persisted per-link position (or
      // the legacy config-derived fallback) as the effective slot. This keeps a
      // Ring 1 and a Ring 2 item distinct in the synthesized equipment list.
      let liveSlot = slot
      if (normalizeEquipmentSlot(slot) === "Ring") {
        const pos =
          link.equipmentPosition ?? legacyRingPositionForConfig(config)
        if (pos) liveSlot = pos
      }
      equipment.push({
        id: def.id,
        name: def.name,
        slot: liveSlot,
        source: def.name,
        bonus: eligible
          ? makeVector((config.bonus ?? {}) as PartialVector)
          : {},
        // The equipment percentage bonus is synthesized from the CURRENT catalog
        // config exactly like the flat bonus and only when the item is currently
        // eligible. An ineligible/archived item keeps BOTH contributions inert.
        percentBasisPoints: eligible
          ? makeVector((config.percentBasisPoints ?? {}) as PartialVector)
          : {},
        // Derived HP/MP/SP maxima bonuses are synthesized from the CURRENT catalog
        // config and gated on eligibility the same way. They do NOT consume the
        // per-attribute aggregate or overall equipment cap budgets (the engine
        // computes them independently), so they never affect the 20%/15% attribute
        // caps. An ineligible/archived item keeps both derived fields inert.
        derivedFlat: eligible ? makeDerivedVector(config.derivedFlat) : {},
        derivedPercentBasisPoints: eligible
          ? makeDerivedVector(config.derivedPercentBasisPoints)
          : {},
      })
      // Equipment-granted passive skills. When the item is worn and currently
      // eligible, each `grantedSkillStableIds` entry resolves to a `skills` catalog
      // definition whose CURRENT `config.effects` are synthesized live - sourced to
      // this item + skill, never persisted as a CharacterAssociation SKILL link and
      // never offered as a milestone. A skill also linked as a SKILL association
      // wins (skip the equipment grant, the linked association already applied it);
      // otherwise the first equipped grant applies. Archived skills never load and
      // are inert, and a resolvable-but-archived-after-equip skill is likewise inert.
      if (eligible) {
        skillMap = await appendGrantedSkillEffects(
          activeEffects,
          def,
          config.grantedSkillStableIds as string[] | undefined,
          linkedSkillStableIds,
          appliedSkillStableIds,
          skillMap,
          db
        )
      }
    } else if (def.kind === "titles") {
      const flat = config.flat as PartialVector | undefined
      if (flat) {
        activeEffects.push({
          id: `${def.id}:flat`,
          source: def.name,
          provenance: "catalog",
          phase: "flat",
          amount: makeVector(flat),
          stacking: "stack",
        })
      }
      const pct = config.percentBasisPoints as PartialVector | undefined
      if (pct) {
        activeEffects.push({
          id: `${def.id}:percent`,
          source: def.name,
          provenance: "catalog",
          phase: "percent",
          basisPoints: makeVector(pct),
          stacking: "stack",
        })
      }
      // Title-granted passive skills. While the unarchived TITLE association
      // survives, each `grantedSkillStableIds` entry resolves to a `skills` catalog
      // definition whose CURRENT `config.effects` are synthesized live - sourced to
      // this title + skill, never persisted as a CharacterAssociation SKILL link and
      // never offered as a milestone. A skill also linked as a SKILL association
      // wins (skip the title grant, the linked association already applied it);
      // otherwise the first surviving grant across titles AND equipment applies.
      // Archived skills never load and are inert, and an archived title is skipped
      // earlier. Ranked replacement uses only the current linked rank: the
      // same-series displacement at link time deletes the superseded rank, so no
      // earlier-ranked title's grants accumulate (surviving TITLE links only).
      skillMap = await appendGrantedSkillEffects(
        activeEffects,
        def,
        config.grantedSkillStableIds as string[] | undefined,
        linkedSkillStableIds,
        appliedSkillStableIds,
        skillMap,
        db
      )
    } else if (def.kind === "skills") {
      // Synthesize each declarative passive effect from the current catalog
      // config. History stays immutable; editing a skill's effects recalculates
      // the live status without rewriting the stored state or the journal. Each
      // effect retains its OWN stacking/replace group; the skill's `upgradeGroup`
      // is only an add/select replacement group, never an effect replace group.
      appendDeclarativeEffects(
        activeEffects,
        def,
        (config.effects ?? []) as DeclarativeEffect[],
        def.id
      )
    } else if (def.kind === "gods") {
      // A god linked as a blessing synthesizes the effects the god's current
      // catalog config declares for the blessing tier STORED ON THE LINK. The
      // tier is never inferred from the god config; a link without a tier (or a
      // god with no `blessingEffects` entry for that tier) contributes nothing -
      // no invented numeric bonus. Archived definitions are skipped earlier, so
      // an archived god link (a blessing) is inert.
      const tier = link.blessingTier
      const effects = (config.blessingEffects ?? {}) as Record<
        string,
        DeclarativeEffect[] | undefined
      >
      const chosen = tier ? (effects[tier] ?? []) : []
      appendDeclarativeEffects(activeEffects, def, chosen, def.id)
    } else if (def.kind === "bloodlines") {
      // A bloodline's declared effects are grade-specific REPLACEMENT, never
      // additive: when the character's current race grade has an OWN entry in
      // `gradeEffects`, EXACTLY that grade's effects replace the base `effects`
      // (an explicit empty list for the current grade suppresses the base
      // effects entirely, so no effects apply). A missing exact grade falls back
      // to the base `effects`. There is never a fallback to another grade and
      // never a base+grade addition. Legacy `{ grade, vector }` config
      // contributes nothing. The grade-replacement effects use a distinct id
      // prefix so a grade-replacement effect never collides with a base-effect id.
      const gradeEffects = (config.gradeEffects ?? {}) as Record<
        string,
        DeclarativeEffect[]
      >
      const gradeKey = state.race.grade
      // "property exists" is OWN-property presence, so an explicit empty grade
      // list (`[]`) is still an authoritative override that suppresses base.
      const hasGradeOverride = Object.prototype.hasOwnProperty.call(
        gradeEffects,
        gradeKey
      )
      if (hasGradeOverride) {
        appendDeclarativeEffects(
          activeEffects,
          def,
          (gradeEffects[gradeKey] ?? []) as DeclarativeEffect[],
          `${def.id}:grade-${gradeKey}`
        )
      } else {
        appendDeclarativeEffects(
          activeEffects,
          def,
          (config.effects ?? []) as DeclarativeEffect[],
          def.id
        )
      }
    } else if (def.kind === "transcendent_skills") {
      // A transcendent skill's `passiveEffects` are declared in the catalog config
      // and synthesized live exactly like a skill/blessing/bloodline effect - each
      // effect keeps its OWN condition/stacking/group from the shared skill effect
      // schema. `costDescription` / `acquisitionNotes` are never interpreted here
      // (no cost deduction, no triggered always-on power), and a legacy config that
      // omits `passiveEffects` contributes nothing (no invented numeric bonus).
      appendDeclarativeEffects(
        activeEffects,
        def,
        (config.passiveEffects ?? []) as DeclarativeEffect[],
        def.id
      )
    }
  }
  return { ...state, equipment, activeEffects }
}

async function statusFor(
  character: CharacterWithCatalog,
  config: RulesConfig,
  db: DbClient = prisma,
  skillMap?: Map<string, UnarchivedSkillDef> | null
): Promise<StatusResult> {
  return calculateStatus(await liveState(character, db, skillMap), config)
}

function configFor(
  character: CharacterWithCatalog,
  houseRules: HouseRulesConfig
): RulesConfig {
  return buildRulesConfig(character.race, houseRules)
}

/** Encode a full vector as a sparse `PartialVector` with only non-zero entries. */
function toSparseVector(vec: AttributeVector): PartialVector {
  const out: PartialVector = {}
  for (const attr of ATTRIBUTES) {
    if (vec[attr] !== 0) out[attr] = vec[attr]
  }
  return out
}

/**
 * Server-computed, authoritative permanent-consumable capacity and remaining
 * capacity per attribute. The UI must not recompute the grade-band cap, so it is
 * derived here from the character's race level, origin and the server-held rules
 * config (F3/E5/D15/C45). Used by the detail read so the Consumables sheet can
 * show "current cap and remaining" without re-deriving the cap.
 */
function permanentConsumableInfo(
  character: CharacterWithCatalog,
  config: RulesConfig
): {
  cap: PartialVector
  remaining: PartialVector
} {
  const state = deserializeState(character.state)
  // Capacity is always derived from the authoritative Character.origin column,
  // never inferred from the grade. A legacy state that predates origin tracking
  // is resolved against the DB row, so a born character is never mis-capped as
  // integrated (or vice versa) just because `state.race.origin` is absent.
  const origin: "born" | "integrated" = character.origin
  const cap = permanentConsumableCap(state.race.level, config, { origin })
  const used = zeroVector()
  for (const g of state.permanentGains) {
    if (g.kind !== "consumable") continue
    for (const attr of ATTRIBUTES) {
      const v = g.vector[attr]
      if (typeof v === "number" && Number.isFinite(v)) used[attr] += v
    }
  }
  const remaining = zeroVector()
  for (const attr of ATTRIBUTES) {
    remaining[attr] = Math.max(0, cap[attr] - used[attr])
  }
  return { cap: toSparseVector(cap), remaining: toSparseVector(remaining) }
}

/**
 * Map a persisted association kind to its public view kind, exhaustively. Every
 * Prisma association kind is covered by the record, so a newly introduced kind is
 * a compile-time error rather than a silent fallback that mislabels data.
 */
const associationViewKinds: Record<
  CharacterWithCatalog["associations"][number]["kind"],
  CharacterAssociationView["kind"]
> = {
  TITLE: "title",
  EQUIPMENT: "equipment",
  SKILL: "skill",
  // Not wired to characters yet (phase 2), but the persisted kind must map to a
  // typed view label so a stored BLESSING/BLOODLINE link is never mislabelled.
  BLESSING: "blessing",
  BLOODLINE: "bloodline",
  TRANSCENDENT: "transcendent",
}

function associationViewKind(
  kind: CharacterWithCatalog["associations"][number]["kind"]
): CharacterAssociationView["kind"] {
  return associationViewKinds[kind]
}

/**
 * The character data needed to compute equipment eligibility metadata: the stored
 * state (for level/race resolution), the race catalog row (eligibility-only race
 * type), and the live associations (so a divine-patron requirement can be checked
 * against the character's active blessing link). A caller may provide only the
 * fields it loaded.
 */
type EquipmentViewContext = {
  state: unknown
  race?: { config?: unknown } | null
  associations?: EquipmentEligibilityAssociation[]
}

/**
 * Extract public equipment metadata - rarity / soulbound / declared requirements /
 * live eligibility - from an equipment config against the owning character's
 * current race level and race type. Callers invoke this only for equipment
 * definitions; the returned object always carries a live `equipmentEligibility`
 * (an ineligible definition stays shown but its bonus is not synthesized until
 * the character qualifies). A legacy config lacking rarity/requirements simply
 * yields absent fields.
 */
function equipmentViewMetadata(
  config: Record<string, unknown>,
  context: EquipmentViewContext
): {
  rarity?: string
  soulbound?: boolean
  requirements?: EquipmentRequirements
  equipmentEligibility: { eligible: boolean; reason?: string }
} {
  const state = deserializeState(context.state)
  const metadata: {
    rarity?: string
    soulbound?: boolean
    requirements?: EquipmentRequirements
    equipmentEligibility: { eligible: boolean; reason?: string }
  } = { equipmentEligibility: equipmentEligibilityFor(config, state, context) }
  if (config.rarity != null) metadata.rarity = config.rarity as string
  if (config.soulbound != null) metadata.soulbound = config.soulbound as boolean
  const requirements: EquipmentRequirements = {}
  if (typeof config.minimumLevel === "number") {
    requirements.minimumLevel = config.minimumLevel as number
  }
  if (
    config.requiredLevelType === "class" ||
    config.requiredLevelType === "profession" ||
    config.requiredLevelType === "humanoidRace" ||
    config.requiredLevelType === "monstrousRace"
  ) {
    requirements.requiredLevelType = config.requiredLevelType
  }
  if (typeof config.requiredGodStableId === "string") {
    requirements.requiredGodStableId = config.requiredGodStableId
  }
  if (
    config.minimumBlessingTier !== undefined &&
    config.minimumBlessingTier !== null
  ) {
    requirements.minimumBlessingTier =
      config.minimumBlessingTier as BlessingTier
  }
  // Legacy keys remain surfaced (readable) for pre-canonical entries.
  if (typeof config.minRaceLevel === "number") {
    requirements.minRaceLevel = config.minRaceLevel as number
  }
  if (
    config.requiredRaceType === "enlightened" ||
    config.requiredRaceType === "monster"
  ) {
    requirements.requiredRaceType = config.requiredRaceType
  }
  if (Object.keys(requirements).length > 0) {
    metadata.requirements = requirements
  }
  return metadata
}

/**
 * Resolve the authored grade-specific prose for a linked catalog definition at
 * the definition's OWN `grade` band. Returns undefined when the definition has no
 * grade, or when it has no authored text for that grade (an empty or partial map
 * reads back as no prose). Never uses the character's race grade.
 */
function associationGradeDescription(def: {
  grade?: string | null
  gradeDescriptions?: unknown
}): string | undefined {
  if (def.grade == null) return undefined
  const map = normalizeGradeDescriptions(def.gradeDescriptions)
  return map[def.grade as Grade] ?? undefined
}

/**
 * Resolve the authored grade-specific prose for a character's linked race/class/
 * profession definition at an explicit grade, or null. A missing row, a null
 * `grade` (a legacy ungraded track), or an empty/partial `gradeDescriptions` map
 * all read back as null - no inference from another grade and never a fallback to
 * the legacy `description`.
 */
function gradeDescriptionAt(
  def: { gradeDescriptions?: unknown } | null | undefined,
  grade: string | undefined
): string | null {
  if (def == null || grade == null) return null
  const map = normalizeGradeDescriptions(def.gradeDescriptions)
  return map[grade as Grade] ?? null
}

function associationView(
  link: CharacterWithCatalog["associations"][number],
  character: EquipmentViewContext
): CharacterAssociationView {
  const config = parseCatalogConfig(
    link.definition.kind,
    link.definition.config ?? {}
  )
  const kind = associationViewKind(link.kind)
  const view: CharacterAssociationView = {
    id: link.id,
    definitionId: link.definitionId,
    kind,
    name: link.definition.name,
    definitionDescription: link.definition.description ?? null,
    definitionArchived: link.definition.archived,
  }
  if (kind === "equipment") {
    const slot = config.slot as string | undefined
    if (slot) {
      // The catalog/item view always lists the canonical slot. Ring is ONE
      // catalog slot; the worn position is surfaced separately via
      // `equipmentPosition`, never conflated with the slot itself.
      const normalized = normalizeEquipmentSlot(slot)
      view.slot = normalized === "Ring" ? "Ring" : slot
    }
    // A Ring-slot link exposes its physical position for the UI. The persisted
    // per-link value wins; a legacy config that still names Ring 1 / Ring 2 is
    // the read-time fallback. Non-ring links carry no position.
    const position =
      link.equipmentPosition ?? legacyRingPositionForConfig(config)
    if (normalizeEquipmentSlot(config.slot as string | undefined) === "Ring") {
      if (position === "Ring 1" || position === "Ring 2") {
        view.equipmentPosition = position
      }
    }
    const metadata = equipmentViewMetadata(config, character)
    if (metadata.rarity != null) view.rarity = metadata.rarity
    if (metadata.soulbound != null) view.soulbound = metadata.soulbound
    if (metadata.requirements) view.requirements = metadata.requirements
    view.equipmentEligibility = metadata.equipmentEligibility
  }
  if (
    kind === "title" ||
    kind === "skill" ||
    kind === "blessing" ||
    kind === "bloodline"
  ) {
    const upgradeGroup = config.upgradeGroup as string | undefined
    if (upgradeGroup) view.upgradeGroup = upgradeGroup
  }
  // A blessing association exposes the exact tier it was granted at. It is read
  // from the persisted link (never inferred from the god config); a link with no
  // tier has no synthesized effect but is still shown.
  if (kind === "blessing" && link.blessingTier != null) {
    view.tier = link.blessingTier
  }
  if (kind === "title") {
    const improvement = titleImprovementForConfig(config)
    if (improvement) {
      view.improvement = {
        seriesId: improvement.seriesId,
        rank: improvement.rank,
        minRaceGrade: improvement.minRaceGrade,
      }
    }
  }
  // A transcendent association may carry an optional catalog grade band, but a
  // skill association never does: a skill has no catalog grade (migration
  // 20261017200000_skill_grade_removed), so `grade` is never rendered on a skill,
  // even when the row still holds a legacy value.
  if (kind === "transcendent") {
    if (link.definition.grade) view.grade = link.definition.grade
  }
  if (kind === "skill") {
    const rarity = config.rarity as string | undefined
    if (rarity) view.rarity = rarity
    // Authoritative DIRECT outgoing upgrade targets, serialized from the linked
    // skill definition's parsed config with the OWN-field distinction preserved:
    // `undefined` (field absent) leaves the property omitted so the legacy
    // `upgradeGroup` + `rarity` fallback applies; `[]` renders as an explicitly
    // terminal skill; a nonempty list names the exact target stableIds.
    const upgradeTargets = skillUpgradeTargets(config)
    if (upgradeTargets !== undefined) view.upgradeToStableIds = upgradeTargets
  }
  // Authored grade prose at the definition's OWN grade band, for any graded
  // linked definition (skills/equipment/titles/etc). Never the character race
  // grade; a null definition grade or an empty map leaves the field absent.
  const associationGrade = associationGradeDescription(link.definition)
  if (associationGrade != null) view.gradeDescription = associationGrade
  return view
}

/**
 * Class-tie priority for a skill option: 0 when the skill's IMMUTABLE earned
 * snapshot `classStableId` (the persisted `configSnapshot`, never the live
 * catalog config) matches the offer's snapshotted `classStableIdAtEarn`, else 1.
 * Never hides a nonmatching class-tied skill - it only orders it after the
 * matching one. A null `classStableIdAtEarn` (race credit or no snapshot) leaves
 * every option at priority 1.
 */
function skillOptionClassTiePriority(
  configSnapshot: Record<string, unknown>,
  classStableIdAtEarn: string | null | undefined
): number {
  const cs = skillClassStableIdOf(configSnapshot)
  if (cs == null || classStableIdAtEarn == null) return 1
  return cs === classStableIdAtEarn ? 0 : 1
}

/**
 * Whether an offered skill option is priority-tied to the offer's snapshotted
 * earned class. True only when the option's PERSISTED config snapshot declares a
 * nonempty `classStableId` exactly equal to the offer's snapshotted
 * `classStableIdAtEarn` (itself nonempty). Always false on a legacy/imported
 * offer (no earned-class snapshot) and for a monster race credit (which has no
 * class). Computed from the persisted earned context, never the character's
 * current class. Priority-only: it never gates eligibility and never reorders
 * options (the SORT already ran); it is a read-time UI indicator.
 */
function skillOptionClassPriority(
  configSnapshot: Record<string, unknown>,
  classStableIdAtEarn: string | null | undefined
): boolean {
  const cs = skillClassStableIdOf(configSnapshot)
  if (cs == null || classStableIdAtEarn == null) return false
  return cs === classStableIdAtEarn
}

/**
 * Deterministic option order: class tie matching the earned snapshot first, then
 * the SNAPSHOT name casefold, then stableId, then id. Class tie and name are read
 * from the immutable earned snapshot (`configSnapshot` / `nameSnapshot`), never
 * the live catalog config - so a post-earn catalog edit (renaming a skill or
 * retying its class) never moves an already-offered option.
 */
function compareSkillOfferOptions(
  a: {
    configSnapshot: Record<string, unknown>
    name: string
    stableId: string
    id: string
  },
  b: {
    configSnapshot: Record<string, unknown>
    name: string
    stableId: string
    id: string
  },
  classStableIdAtEarn: string | null | undefined
): number {
  const pa = skillOptionClassTiePriority(a.configSnapshot, classStableIdAtEarn)
  const pb = skillOptionClassTiePriority(b.configSnapshot, classStableIdAtEarn)
  if (pa !== pb) return pa - pb
  const na = a.name.toLocaleLowerCase()
  const nb = b.name.toLocaleLowerCase()
  if (na !== nb) return na < nb ? -1 : 1
  if (a.stableId !== b.stableId) return a.stableId < b.stableId ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Resolve the LIVE prose for a skill-offer option from its current catalog
 * definition. A skill carries no authored grade-specific prose (migration
 * 20261017200000_skill_grade_removed cleared any `gradeDescriptions`), so the
 * definition's `description` is returned; the authored grade text at the offer's
 * snapshotted `earnedGrade` is preferred only on a legacy skill row that still
 * carries it. `null` when the definition is missing (no catalog match) or carries
 * no prose at all. Never the immutable `nameSnapshot`.
 */
function skillOptionLiveDescription(
  definition:
    | { description?: string | null; gradeDescriptions?: unknown }
    | null
    | undefined,
  earnedGrade: string | null | undefined
): string | null {
  if (definition == null) return null
  if (earnedGrade != null) {
    const map = normalizeGradeDescriptions(definition.gradeDescriptions)
    const authored = map[earnedGrade as Grade]
    if (authored != null) return authored
  }
  return definition.description ?? null
}

/** Build the read-time skill-offer view with the current archived status of each option. */
function skillOfferView(
  offer: CharacterWithCatalog["skillOffers"][number]
): SkillOfferView {
  // Options are serialized in a deterministic order: a skill whose `classStableId`
  // matches the offer's snapshotted earned class sorts first (class tie), then by
  // name casefold, then stableId, then id. This survives refresh and import, where
  // option rows are appended in catalog order, because the view always re-sorts.
  // The class tie and name come from the option's IMMUTABLE earned snapshot
  // (`configSnapshot` / `nameSnapshot`), never the live catalog config, so a
  // post-earn catalog edit (rename or class retie) never reorders an already
  // offered option. A nonmatching class-tied skill is never hidden - it only sorts
  // after the match.
  //
  // The earning-time class snapshot is MEANINGFUL only on a scheduled
  // class/profession credit: BOTH provenance halves present AND the offer is on
  // the 'class'/'profession' track. A monster RACE credit has no earned class and
  // a legacy/untyped offer (no provenance) has no snapshot, so neither may attach
  // earned-class priority - even if a persisted row (from a pre-fix import) holds
  // a value where none belongs. Computed here so the sort, the priority badge and
  // the exposed field all agree.
  const isClassProfTrack =
    offer.track === "class" || offer.track === "profession"
  const hasProvenance =
    offer.earnedGrade != null && offer.trackDefinitionStableId != null
  const classSnapshot =
    hasProvenance && isClassProfTrack
      ? (offer.classStableIdAtEarn ?? null)
      : null
  const sortedOptions = [...offer.options].sort((a, b) =>
    compareSkillOfferOptions(
      {
        configSnapshot: (a.configSnapshot ?? {}) as Record<string, unknown>,
        name: a.nameSnapshot,
        stableId: a.definition?.stableId ?? "",
        id: a.definitionId,
      },
      {
        configSnapshot: (b.configSnapshot ?? {}) as Record<string, unknown>,
        name: b.nameSnapshot,
        stableId: b.definition?.stableId ?? "",
        id: b.definitionId,
      },
      classSnapshot
    )
  )
  return {
    id: offer.id,
    track: offer.track,
    level: offer.level,
    choiceGroup: offer.choiceGroup,
    generation: offer.generation,
    canceledAt: offer.canceledAt ? offer.canceledAt.toISOString() : null,
    options: sortedOptions.map((o) => {
      const cs = (o.configSnapshot ?? {}) as Record<string, unknown>
      const rawRarity = cs.rarity
      const rarity =
        typeof rawRarity === "string" && rawRarity.length > 0 ? rawRarity : null
      const rawTrack = cs.track
      let skillType: "race" | "class" | "profession" | null = null
      if (
        rawTrack === "race" ||
        rawTrack === "class" ||
        rawTrack === "profession"
      ) {
        skillType = rawTrack
      } else if (
        offer.track === "race" ||
        offer.track === "class" ||
        offer.track === "profession"
      ) {
        skillType = offer.track as "race" | "class" | "profession"
      }
      return {
        definitionId: o.definitionId,
        nameSnapshot: o.nameSnapshot,
        archived: o.definition?.archived ?? false,
        description: skillOptionLiveDescription(
          o.definition,
          offer.earnedGrade
        ),
        rarity,
        skillType,
        classStableId: skillClassStableIdOf(cs),
        // A skill option never carries a grade: a skill has no catalog grade band
        // (migration 20261017200000_skill_grade_removed), so `grade` is omitted
        // even when the row still holds a legacy value.
        classPriority: skillOptionClassPriority(cs, classSnapshot),
      }
    }),
    selectedDefinitionId: offer.selectedDefinitionId,
    earnedGrade: offer.earnedGrade,
    trackDefinitionStableId: offer.trackDefinitionStableId,
    ...(offer.earnedGrade != null || offer.trackDefinitionStableId != null
      ? { classStableIdAtEarn: classSnapshot }
      : {}),
  }
}

/**
 * Derive a character's transcendent quality at read time. True when at least one
 * linked `TRANSCENDENT` association points at an unarchived catalog definition.
 * Archived links are inert (they contribute no live effect and do not make a
 * character a transcendent), and an archived/unlinked last active definition
 * clears the flag. No persisted flag - this is always recomputed from the current
 * links, so the derived quality can never diverge from the live links.
 */
function isTranscendentFor(character: CharacterWithCatalog): boolean {
  return character.associations.some(
    (a) => a.kind === "TRANSCENDENT" && !!a.definition && !a.definition.archived
  )
}

/**
 * Build the read-time inventory view for an owned inventory row. `kind` is always
 * the linked definition's catalog kind (equipment or items); the slot is
 * surfaced only for equipment definitions that declare one. Archived linked
 * definitions are still shown (inventory stock is the user's record, including
 * archived items they may not be able to newly add but still own).
 */
function inventoryView(
  item: CharacterWithCatalog["inventory"][number],
  character: EquipmentViewContext
): CharacterInventoryItemView {
  const def = item.definition
  const config = parseCatalogConfig(def.kind, def.config ?? {})
  const view: CharacterInventoryItemView = {
    id: item.id,
    definitionId: item.definitionId,
    name: def.name,
    kind: def.kind === "items" ? "items" : "equipment",
    quantity: item.quantity,
    archived: def.archived,
  }
  if (def.kind === "equipment") {
    const slot = config.slot as string | undefined
    if (slot) view.slot = slot
    const metadata = equipmentViewMetadata(config, character)
    if (metadata.rarity != null) view.rarity = metadata.rarity
    if (metadata.soulbound != null) view.soulbound = metadata.soulbound
    if (metadata.requirements) view.requirements = metadata.requirements
    view.equipmentEligibility = metadata.equipmentEligibility
  }
  return view
}

async function toDetail(
  character: CharacterWithCatalog,
  withStatus: boolean,
  config: RulesConfig,
  rulesetVersion?: number,
  db: DbClient = prisma,
  skillMap?: Map<string, UnarchivedSkillDef> | null
): Promise<CharacterDetail> {
  const consumableInfo = permanentConsumableInfo(character, config)
  // Decode the stored engine state once so the authored grade prose can be resolved
  // at the character's OWN grades (race grade; the class/profession track grades).
  // The stored `state` JSON is returned verbatim below; this parse is only for the
  // grade-description lookup and never mutates or re-derives the state.
  const state = deserializeState(character.state)
  const raceGradeDescription = gradeDescriptionAt(
    character.race,
    state.race.grade
  )
  const classGradeDescription = gradeDescriptionAt(
    character.class,
    state.tracks.class?.grade
  )
  const professionGradeDescription = gradeDescriptionAt(
    character.profession,
    state.tracks.profession?.grade
  )
  return {
    id: character.id,
    name: character.name,
    description: character.description,
    nickname: character.nickname,
    pronouns: character.pronouns,
    ageDescription: character.ageDescription,
    appearance: character.appearance,
    biography: character.biography,
    notes: character.notes,
    origin: character.origin,
    raceId: character.raceId,
    classId: character.classId,
    professionId: character.professionId,
    raceName: character.race?.name ?? null,
    className: character.class?.name ?? null,
    professionName: character.profession?.name ?? null,
    raceGradeDescription,
    classGradeDescription,
    professionGradeDescription,
    state: character.state,
    version: character.version,
    archived: character.archived,
    imported: character.imported,
    isTranscendent: isTranscendentFor(character),
    createdAt: character.createdAt.toISOString(),
    updatedAt: character.updatedAt.toISOString(),
    associations: character.associations.map((l) =>
      associationView(l, character)
    ),
    inventory: character.inventory.map((i) => inventoryView(i, character)),
    skillOffers: character.skillOffers.map(skillOfferView),
    status: withStatus
      ? await statusFor(character, config, db, skillMap)
      : undefined,
    levelUpBlocked: gradeLevelUpBlockers(state, config),
    permanentConsumableCap: consumableInfo.cap,
    permanentConsumableRemaining: consumableInfo.remaining,
    ...(rulesetVersion != null ? { rulesetVersion } : {}),
  }
}

/**
 * Resolve the character's active portrait to a public view, or null when none has
 * been uploaded. The asset comes from the character's own already-loaded `assets`
 * relation (the read include carries the single most-recent portrait asset), so a
 * list query never issues a per-card fetch. The `url` is ALWAYS the canonical
 * authenticated `/api/assets/{id}` route - never a filesystem path, and never an
 * asset the user does not own.
 */
function portraitViewFor(
  character: CharacterWithCatalog
): { assetId: string; url: string } | null {
  const asset = character.assets?.[0]
  if (!asset) return null
  return { assetId: asset.id, url: portraitAssetUrl(asset.id) }
}

export async function toListItem(
  character: CharacterWithCatalog,
  withStatus: boolean,
  config: RulesConfig,
  rulesetVersion: number | undefined,
  state: CharacterState,
  db: DbClient = prisma,
  skillMap?: Map<string, UnarchivedSkillDef> | null
): Promise<CharacterListItem> {
  // The race grade is the authoritative stored grade, never re-derived from the
  // level (the G/F band overlap and born-high-grade provenance make `gradeForLevel`
  // wrong for exactly the characters a dashboard card must trust). The configured
  // band for that grade is read from the current house-rules grade table; a grade
  // with no configured band reads back as null. The band is exposed even when the
  // level falls outside it (a born high-grade character at level 0) - the starting
  // grade is provenance driven, not level driven.
  const raceBand = bandForGrade(state.race.grade, config.gradeTable)
  return {
    id: character.id,
    name: character.name,
    description: character.description,
    raceName: character.race?.name ?? null,
    className: character.class?.name ?? null,
    professionName: character.profession?.name ?? null,
    updatedAt: character.updatedAt.toISOString(),
    archived: character.archived,
    imported: character.imported,
    raceGrade: state.race.grade,
    raceLevel: state.race.level,
    raceGradeBand: raceBand ? { min: raceBand.min, max: raceBand.max } : null,
    portrait: portraitViewFor(character),
    status: withStatus
      ? await statusFor(character, config, db, skillMap)
      : undefined,
    ...(rulesetVersion != null ? { rulesetVersion } : {}),
  }
}

/**
 * Build a full character detail from a loaded row AND a single in-request
 * house-rules row, deriving the rules config ONCE and passing it through the
 * status / consumable-cap helpers (no hidden DB lookups inside).
 */
async function detailFor(
  character: CharacterWithCatalog,
  houseRules: HouseRulesRow,
  db: DbClient = prisma,
  skillMap?: Map<string, UnarchivedSkillDef> | null
): Promise<CharacterDetail> {
  const config = buildRulesConfig(character.race, houseRules.config)
  return await toDetail(
    character,
    true,
    config,
    houseRules.version,
    db,
    skillMap
  )
}

/**
 * Build a character list item from a loaded row AND a single in-request
 * house-rules row, deriving the config once and passing it through the helpers.
 */
async function listItemFor(
  character: CharacterWithCatalog,
  houseRules: HouseRulesRow,
  withStatus: boolean,
  db: DbClient = prisma,
  skillMap?: Map<string, UnarchivedSkillDef> | null
): Promise<CharacterListItem> {
  const config = configFor(character, houseRules.config)
  const state = deserializeState(character.state)
  return await toListItem(
    character,
    withStatus,
    config,
    houseRules.version,
    state,
    db,
    skillMap
  )
}

// ------------------------------------------------------------------ //
// Read helpers
// ------------------------------------------------------------------ //

function ownedWhere(user: SessionUser) {
  return user.isAdmin ? {} : { ownerId: user.id }
}

// ------------------------------------------------------------------ //
// Character persistence
// ------------------------------------------------------------------ //

/** A catalog definition snapshot for the create journal's special-abilities block. */
function specialAbilitySnapshot(def: {
  id: string
  name: string
  stableId: string
}): Record<string, unknown> {
  return {
    id: def.id,
    name: def.name,
    stableId: def.stableId,
    provenance: "catalog",
  }
}

type SpecialAbilitiesSelection = {
  blessing?: { godId: string; tier: BlessingTier } | null
  bloodlineIds?: string[]
  transcendentSkillIds?: string[]
}

type ResolvedSpecialAbilities = {
  associations: Array<{
    definitionId: string
    kind: "BLESSING" | "BLOODLINE" | "TRANSCENDENT"
    tier?: BlessingTier
  }>
  journal: Record<string, unknown> | null
}

/**
 * Resolve the explicit special-ability selections against the catalog and
 * validate their invariants, all inside the create transaction so any failure
 * 400s/409s with NO character, event, links or draft deletion.
 *
 * - Every id must resolve to an existing catalog definition of the CORRESPONDING
 *   kind (`gods` / `bloodlines` / `transcendent_skills`), and that
 *   definition must be unarchived (an archived entry is inert and cannot be
 *   newly linked). A blessing is selected as a god + exact tier.
 * - A blessing is limited to one by the single `blessing` field.
 * - A character may carry at most ONE bloodline link. Selecting more than one
 *   bloodline is a `link_collision` (the two no longer coexist; the second is
 *   rejected so the single-link invariant holds at create).
 * - Transcendent skills are distinct and limited to `maxTranscendentSkills` (the
 *   admin-configurable HouseRules cap, default 3). Selecting more than the cap
 *   is a `link_collision`. No id may appear in more than one field.
 */
async function resolveSpecialAbilities(
  tx: DbClient,
  selection: SpecialAbilitiesSelection | undefined,
  maxTranscendentSkills: number
): Promise<ResolvedSpecialAbilities> {
  if (!selection) return { associations: [], journal: null }

  const associations: ResolvedSpecialAbilities["associations"] = []
  const seen = new Map<string, string>()
  const register = (id: string, label: string): void => {
    const prior = seen.get(id)
    if (prior != null) {
      throw badRequest(
        "duplicate",
        `"${id}" is selected both as ${prior} and ${label}`
      )
    }
    seen.set(id, label)
  }

  const resolve = async (
    id: string,
    expectedKind: string,
    label: string
  ): Promise<{
    id: string
    name: string
    stableId: string
    config: Record<string, unknown>
  }> => {
    const def = await tx.catalogDefinition.findUnique({ where: { id } })
    if (!def) {
      throw badRequest(
        "catalog_not_found",
        `${label} "${id}" is not in the catalog`
      )
    }
    if (def.kind !== expectedKind) {
      throw badRequest(
        "wrong_kind",
        `${label} id "${id}" is kind "${def.kind}", expected "${expectedKind}"`
      )
    }
    if (def.archived) {
      throw badRequest(
        "catalog_archived",
        `${label} "${def.name}" is archived; re-enable it in the catalog to create the character`
      )
    }
    register(def.id, label)
    return {
      id: def.id,
      name: def.name,
      stableId: def.stableId,
      config: (def.config ?? {}) as Record<string, unknown>,
    }
  }

  const journal: Record<string, unknown> = {}

  // Blessing - single field, so at most one may be selected. A blessing is a god
  // + exact tier: the god definition must be an unarchived `gods` entry, and the
  // tier is persisted verbatim on the link (never inferred from the god config).
  const blessingSelection = selection.blessing ?? null
  const blessing = blessingSelection
    ? await resolve(blessingSelection.godId, "gods", "Blessing")
    : null
  journal.blessing = blessing
    ? {
        ...specialAbilitySnapshot(blessing),
        tier: blessingSelection!.tier,
      }
    : null
  if (blessing) {
    associations.push({
      definitionId: blessing.id,
      kind: "BLESSING",
      tier: blessingSelection!.tier,
    })
  }

  // Bloodlines - at most one per character. Selecting two is a collision: the
  // second is rejected so the single-link invariant holds (the DB partial unique
  // index also rejects a concurrent duplicate writer with `bloodline_singleton_conflict`).
  // The upgradeGroup logic is retained for a single selection so a bloodline that
  // declares a group is still reported in the journal, but with only one link no
  // two selections can share a group.
  const bloodlineGroups = new Map<string, string>()
  const bloodlines: Array<Record<string, unknown>> = []
  const bloodlineIds = selection.bloodlineIds ?? []
  if (bloodlineIds.length > 1) {
    throw badRequest(
      "link_collision",
      `A character may carry at most one bloodline; selected ${bloodlineIds.length}`
    )
  }
  for (const id of bloodlineIds) {
    const def = await resolve(id, "bloodlines", "Bloodline")
    const config = parseCatalogConfig("bloodlines", def.config)
    const upgradeGroup =
      typeof config.upgradeGroup === "string" && config.upgradeGroup.length > 0
        ? config.upgradeGroup
        : undefined
    if (upgradeGroup != null) {
      const existing = bloodlineGroups.get(upgradeGroup)
      if (existing != null) {
        throw badRequest(
          "link_collision",
          `Bloodlines "${existing}" and "${def.name}" both occupy upgrade group "${upgradeGroup}"; select only one per group`
        )
      }
      bloodlineGroups.set(upgradeGroup, def.name)
    }
    associations.push({ definitionId: def.id, kind: "BLOODLINE" })
    bloodlines.push({
      ...specialAbilitySnapshot(def),
      upgradeGroup: upgradeGroup ?? null,
    })
  }
  journal.bloodlines = bloodlines

  // Transcendent skills - distinct and bounded by the admin-configured cap. A
  // request that selects more than the cap is rejected before any write; the
  // count reflects the selections on this create only (a new character has no
  // pre-existing transcendent links).
  const transcendents: Array<Record<string, unknown>> = []
  const transcendentIds = selection.transcendentSkillIds ?? []
  if (transcendentIds.length > maxTranscendentSkills) {
    throw badRequest(
      "link_collision",
      `A character may carry at most ${maxTranscendentSkills} transcendent skills; selected ${transcendentIds.length}`
    )
  }
  for (const id of transcendentIds) {
    const def = await resolve(id, "transcendent_skills", "Transcendent skill")
    associations.push({ definitionId: def.id, kind: "TRANSCENDENT" })
    transcendents.push(specialAbilitySnapshot(def))
  }
  journal.transcendentSkills = transcendents

  return { associations, journal }
}

export async function listCharacters(
  user: SessionUser,
  opts?: { withStatus?: boolean; includeArchived?: boolean }
): Promise<CharacterListItem[]> {
  const where = {
    ...ownedWhere(user),
    ...(opts?.includeArchived ? {} : { archived: false }),
  }
  // Load the house rules ONCE for the whole request (read path, no transaction).
  const houseRules = await loadHouseRules(prisma)
  const rows = await prisma.character.findMany({
    where,
    include: characterInclude,
    orderBy: { updatedAt: "desc" },
  })
  const withStatus = opts?.withStatus ?? false
  // Share a single unarchived-skill map across every list item when a status is
  // requested, so an equipment-granted passive never issues a per-character
  // catalog lookup. A status-less list never computes a live state, so the map is
  // never needed (and never loaded) - an unnecessary query is avoided.
  const skillMap = withStatus ? await loadUnarchivedSkillMap(prisma) : null
  return Promise.all(
    rows.map((row) =>
      listItemFor(row, houseRules, withStatus, prisma, skillMap)
    )
  )
}

async function assertOwner(
  db: DbClient,
  id: string,
  user: SessionUser
): Promise<CharacterWithCatalog> {
  const row = await db.character.findUnique({
    where: { id },
    include: characterInclude,
  })
  if (!row) throw notFound("character_not_found", "Character not found")
  if (!user.isAdmin && row.ownerId !== user.id) {
    throw forbidden("forbidden", "You do not own this character")
  }
  return row
}

export async function getCharacter(
  id: string,
  user: SessionUser,
  opts?: { withStatus?: boolean }
): Promise<CharacterDetail> {
  const row = await assertOwner(prisma, id, user)
  const houseRules = await loadHouseRules(prisma)
  const config = buildRulesConfig(row.race, houseRules.config)
  return await toDetail(
    row,
    opts?.withStatus ?? true,
    config,
    houseRules.version
  )
}

export async function createCharacter(
  input: {
    name: string
    description?: string
    // Character-profile metadata. Optional + nullable: an omitted/null field is
    // persisted as NULL (a missing value is never a 400). Mirrors the create
    // schema bounds (nickname 200, pronouns 100, ageDescription 4000,
    // appearance 8000, biography 8000, notes 4000).
    nickname?: string | null
    pronouns?: string | null
    ageDescription?: string | null
    appearance?: string | null
    biography?: string | null
    notes?: string | null
    origin: "integrated" | "born"
    raceId: string
    // Required for an enlightened race (a nonempty string), null for a monster.
    // The authoritative per-raceType rule is enforced below against the resolved
    // race config (Zod cannot see it). Omitted is treated as null.
    classId?: string | null
    // Optional for an enlightened race, must be null for a monster.
    professionId?: string | null
    // REQUIRED fully-allocated initial stat vector. The API boundary (Zod) has
    // already enforced the full nine-key shape with each integer >= 1; the
    // service re-validates the shape defensively and then enforces the
    // category-dependent TOTAL (70 for an enlightened race, 210 for a monster)
    // after resolving the authoritative race config, so an absent / wrong
    // allocation 400s before any character write or draft consume.
    initialAttributes: AttributeVector
    // Explicit special-ability selections. When supplied, the referenced
    // blessing (a god + tier), bloodline or transcendent-skill catalog
    // definitions are resolved by kind, validated (unarchived, no collision) and
    // linked atomically with the create. Omitted/empty grants no ability.
    specialAbilities?: {
      blessing?: { godId: string; tier: BlessingTier } | null
      bloodlineIds?: string[]
      transcendentSkillIds?: string[]
    }
    // Wizard draft-consume token. When supplied, the matching draft is deleted
    // atomically with character creation; a stale/absent version 409s and rolls
    // back the whole create + event. When absent, no draft is touched.
    draftVersion?: number
  },
  user: SessionUser
): Promise<CharacterDetail> {
  // Resolve the race / class / profession, run every eligibility check and build
  // the initial engine state INSIDE the SAME SERIALIZABLE transaction that writes
  // the character + create event + draft CAS. This makes a concurrent admin edit
  // to the race's `raceType` safe: the authoritative type is read only from the
  // transaction snapshot (never a stale value resolved outside it), and if the
  // edit commits while this create is in flight the SERIALIZABLE conflict
  // surfaces as a 409 `serialization_conflict` instead of a raw P2034 - with no
  // partially-written character, no stray event and no draft consumed.
  const serializable = {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  }
  try {
    return await prisma.$transaction(async (tx) => {
      // Load the house rules ONCE for this mutation, through the SAME tx client.
      const houseRules = await loadHouseRules(tx)
      // Resolve the race and the optional class / profession through the tx client
      // so every eligibility check and the state build below observe the SAME
      // snapshot the write will be committed against. Re-reading the type under
      // the transaction is the whole point: a concurrent `updateCatalogItem`
      // raceType change is either visible here (rejected by the eligibility
      // guards, no inconsistent character) or committed after this snapshot, in
      // which case SERIALIZABLE aborts this transaction instead of writing a
      // character built from a stale type.
      const [race, cls, profession] = await Promise.all([
        tx.catalogDefinition.findUnique({ where: { id: input.raceId } }),
        input.classId
          ? tx.catalogDefinition.findUnique({ where: { id: input.classId } })
          : Promise.resolve(null),
        input.professionId
          ? tx.catalogDefinition.findUnique({
              where: { id: input.professionId },
            })
          : Promise.resolve(null),
      ])
      if (!race) throw notFound("race_not_found", "Race not found")
      if (input.classId && !cls) {
        throw notFound("class_not_found", "Class not found")
      }
      if (input.professionId && !profession) {
        throw notFound("profession_not_found", "Profession not found")
      }
      if (race.kind !== "races")
        throw badRequest("invalid_race", "Race catalog entry has wrong kind")
      if (cls && cls.kind !== "classes")
        throw badRequest("invalid_class", "Class catalog entry has wrong kind")
      if (profession && profession.kind !== "professions") {
        throw badRequest(
          "invalid_profession",
          "Profession catalog entry has wrong kind"
        )
      }

      // Resolve the race's authoritative advancement mode + natural grade. A legacy
      // config without `raceType` is interpreted as `enlightened`; a legacy config
      // without `naturalGrade` falls back to F for the class/profession stamp and
      // skips the strict natural-grade eligibility checks.
      const raceConfig = parseCatalogConfig(race.kind, race.config ?? {})
      const raceType =
        (raceConfig.raceType as RaceType | undefined) ?? "enlightened"
      const naturalGrade = gradeSchema.safeParse(raceConfig.naturalGrade)
        .success
        ? (raceConfig.naturalGrade as Grade)
        : undefined
      // The class/profession tracks are stamped with the grade they must operate at:
      // the race's natural grade, or the legacy F fallback.
      const trackStartGrade: Grade = naturalGrade ?? "F"
      // The race's own starting grade is origin-driven: integrated always G;
      // born enters at the race's natural grade (F fallback).
      const raceStartGrade: Grade =
        input.origin === "integrated" ? "G" : (naturalGrade ?? "F")

      if (raceType === "monster") {
        // A monster is race-only: no class tracked, no profession tracked.
        if (input.classId != null) {
          throw badRequest(
            "invalid_class",
            `Monster race "${race.name}" has no class; classId must be null`
          )
        }
        if (input.professionId != null) {
          throw badRequest(
            "invalid_profession",
            `Monster race "${race.name}" has no profession; professionId must be null`
          )
        }
      } else {
        // An enlightened race always selects an exact class.
        if (!cls) {
          throw badRequest(
            "invalid_class",
            `Enlightened race "${race.name}" requires a class; classId is required`
          )
        }
        // A graded new character requires an explicit per-level config for the grade
        // its track is stamped with. Without it the class/profession track cannot be
        // stamped with its `${stableId}:${grade}` definition and would fail to advance.
        if (!trackHasGradeConfig(cls, trackStartGrade)) {
          throw badRequest(
            "invalid_class_grade",
            `Class "${cls.name}" defines no ${trackStartGrade}-grade per-level config; add a "grades.${trackStartGrade}" entry to create it`
          )
        }
        if (profession && !trackHasGradeConfig(profession, trackStartGrade)) {
          throw badRequest(
            "invalid_profession_grade",
            `Profession "${profession.name}" defines no ${trackStartGrade}-grade per-level config; add a "grades.${trackStartGrade}" entry to create it`
          )
        }
        // Exact natural-grade eligibility (no lower-grade fallback): when the race
        // declares a naturalGrade, the selected class/profession catalog row must be
        // that grade AND define a per-level config at that grade.
        if (naturalGrade) {
          if (cls.grade !== naturalGrade) {
            throw badRequest(
              "invalid_class_grade",
              `Class "${cls.name}" is grade ${cls.grade ?? "(unset)"}; the "${race.name}" race requires the natural grade ${naturalGrade}`
            )
          }
          if (profession) {
            if (profession.grade !== naturalGrade) {
              throw badRequest(
                "invalid_profession_grade",
                `Profession "${profession.name}" is grade ${profession.grade ?? "(unset)"}; the "${race.name}" race requires the natural grade ${naturalGrade}`
              )
            }
          }
        }
      }

      // The race must define a per-level definition for the grade the character
      // starts in; otherwise the first race-gain would reject for lack of a snapshot.
      const raceDefs = (raceConfig.raceDefinitions ?? {}) as Record<
        string,
        unknown
      >
      if (raceDefs[raceStartGrade] == null) {
        throw badRequest(
          "invalid_race_grade",
          `Race "${race.name}" defines no ${raceStartGrade}-grade race definition; add a "raceDefinitions.${raceStartGrade}" entry to create it`
        )
      }

      // Validate the required initial-stat allocation against the authoritative
      // race type NOW (after the race config is resolved and all per-grade checks
      // above have passed) so an absent / wrong allocation 400s BEFORE the
      // character row or any draft consume is written/removed.
      const initialAttributes = validateInitialAttributes(
        input.initialAttributes,
        raceType
      )
      const state = createInitialState(
        input.origin,
        race,
        profession,
        cls,
        initialAttributes
      )
      const serialized = serializeState(state)

      // Resolve the explicit special-ability selections INSIDE the transaction so a
      // wrong-kind / archived / collision / missing failure rolls back the whole
      // create (no character, no event, no links, no draft deletion). Omitted or
      // empty grants nothing (no inferred power from a legacy `special` bool).
      const special = await resolveSpecialAbilities(
        tx,
        input.specialAbilities,
        houseRules.config.maxTranscendentSkills
      )

      // Build the ordered grade-grant request list: race, then class, then
      // profession (deterministic). Each request is stamped with the grade the
      // source will START at in the newly-created state - the race at
      // `state.race.grade` (G for an integrated character, the race's natural
      // grade for a born one) and the class/profession at their OWN starting
      // track grade. A monster race has no class/profession tracks, so only the
      // race grants apply. A missing/archived skill is resolved (and journaled as
      // skipped) rather than aborting the create.
      const grantRequests: GradeGrantRequest[] = []
      const raceGrantGrade = state.race.grade
      for (const stableId of gradeSkillStableIdsFor(
        raceConfig,
        raceGrantGrade
      )) {
        grantRequests.push({ stableId, grade: raceGrantGrade })
      }
      if (cls) {
        const classGrade = state.tracks.class?.grade
        if (classGrade) {
          const classConfig = parseCatalogConfig(cls.kind, cls.config ?? {})
          for (const stableId of gradeSkillStableIdsFor(
            classConfig,
            classGrade
          )) {
            grantRequests.push({ stableId, grade: classGrade })
          }
        }
      }
      if (profession) {
        const professionGrade = state.tracks.profession?.grade
        if (professionGrade) {
          const professionConfig = parseCatalogConfig(
            profession.kind,
            profession.config ?? {}
          )
          for (const stableId of gradeSkillStableIdsFor(
            professionConfig,
            professionGrade
          )) {
            grantRequests.push({ stableId, grade: professionGrade })
          }
        }
      }
      // Resolve the grade-grant requests against the live unarchived skill catalog
      // inside the transaction so the resulting links/journal are part of the same
      // atomic write as the character + event. A new character owns no SKILL links,
      // so the existing-skill set is empty.
      const createSkillMap = await loadUnarchivedSkillMap(tx)
      const gradeResolution = resolveGradeSkillGrants(
        [],
        grantRequests,
        createSkillMap
      )

      // Create the character and append the "create" progression event atomically: a
      // character row must never exist without its corresponding journal entry.
      const created = await tx.character.create({
        data: {
          ownerId: user.id,
          name: input.name,
          description: input.description ?? null,
          nickname: metadataOrNull(input.nickname),
          pronouns: metadataOrNull(input.pronouns),
          ageDescription: metadataOrNull(input.ageDescription),
          appearance: metadataOrNull(input.appearance),
          biography: metadataOrNull(input.biography),
          notes: metadataOrNull(input.notes),
          origin: input.origin,
          raceId: race.id,
          // A monster has no class; every other (enlightened) race has one.
          classId: cls?.id ?? null,
          professionId: profession?.id ?? null,
          state: serialized as Prisma.InputJsonValue,
          version: 0,
        },
        include: characterInclude,
      })

      // Record ONLY which profile-metadata fields were supplied (never the prose),
      // so the create journal stays a compact auditable record without duplicating
      // long nicknames/biographies/notes.
      const suppliedMetadataFields = (
        [
          "nickname",
          "pronouns",
          "ageDescription",
          "appearance",
          "biography",
          "notes",
        ] as const
      ).filter((field) => metadataOrNull(input[field]) != null)

      await tx.progressionEvent.create({
        data: {
          characterId: created.id,
          kind: "create",
          payload: {
            origin: input.origin,
            raceId: race.id,
            classId: cls?.id ?? null,
            professionId: profession?.id ?? null,
            // Selection snapshots, present only when the caller supplied
            // a non-empty special-ability selection.
            ...(special.journal ? { specialAbilities: special.journal } : {}),
            // Grade-granted skill acquisition record (granted / upgraded / noop /
            // skipped), present only when the create actually granted or attempted
            // a grade skill.
            ...(hasGradeGrantJournalEntries(gradeResolution.journal)
              ? { skillGrants: gradeResolution.journal }
              : {}),
            ...(suppliedMetadataFields.length
              ? { metadataFields: suppliedMetadataFields }
              : {}),
          } as Prisma.InputJsonValue,
        },
      })

      // Insert the resolved associations atomically with the create + event. Each
      // link is persisted with the exact catalog kind, so a stored BLESSING /
      // BLOODLINE / TRANSCENDENT link is never mislabelled by a later read. A
      // blessing link carries the exact tier it was granted at so the live effect
      // is synthesized from the god's `blessingEffects[tier]`.
      for (const assoc of special.associations) {
        await tx.characterAssociation.create({
          data: {
            characterId: created.id,
            definitionId: assoc.definitionId,
            kind: assoc.kind,
            ...(assoc.tier != null ? { blessingTier: assoc.tier } : {}),
          },
        })
      }

      // Persist the resolved grade-granted skill links (SKILL associations) with
      // the create. A duplicate/upgrade resolved by the policy above replaces the
      // superseded link rather than stacking; a no-op/skipped request writes
      // nothing.
      await persistGradeSkillGrants(tx, created.id, gradeResolution)

      // The wizard's final create step consumes the matching draft atomically: the
      // draft delete is committed or rolled back with the character + event. A
      // supplied `draftVersion` that does not match the current draft is a 409
      // conflict (no second best-effort DELETE later, and no unvalidated state).
      // When `draftVersion` is absent (a non-wizard API client) the draft is left
      // untouched.
      if (input.draftVersion != null) {
        const draftResult = await tx.characterDraft.deleteMany({
          where: { userId: user.id, version: input.draftVersion },
        })
        if (draftResult.count !== 1) {
          throw conflict(
            "draft_conflict",
            `Draft version mismatch: expected ${input.draftVersion}`
          )
        }
      }

      // Re-fetch AFTER inserting associations so the returned detail exposes the
      // linked blessing / bloodline / transcendent (and their synthesized live
      // effects), not the empty snapshot returned by `character.create`.
      const withAssociations = (await tx.character.findUnique({
        where: { id: created.id },
        include: characterInclude,
      }))!
      return await detailFor(withAssociations, houseRules, tx)
    }, serializable)
  } catch (err) {
    if (isSerializationFailure(err)) {
      throw conflict(
        "serialization_conflict",
        "Concurrent catalog change detected; retry the character creation"
      )
    }
    throw err
  }
}

export async function updateCharacter(
  id: string,
  patch: {
    name?: string
    description?: string | null
    // Character-profile metadata. Optional + nullable so a PATCH may clear a field
    // (null) or leave it untouched (omitted). Bounds mirror the update schema.
    nickname?: string | null
    pronouns?: string | null
    ageDescription?: string | null
    appearance?: string | null
    biography?: string | null
    notes?: string | null
    archived?: boolean
    currentResources?: Record<string, number>
    version?: number
  },
  user: SessionUser
): Promise<CharacterDetail> {
  return prisma.$transaction(async (tx) => {
    const row = await assertOwner(tx, id, user)
    // Load the house rules once for this mutation, through the same tx client.
    const houseRules = await loadHouseRules(tx)
    // CAS token: prefer the client-supplied version (validate-and-write), but
    // when the client omits it (e.g. a PATCH that only flips `archived`) fall
    // back to the version read from the DB inside this transaction. Either way
    // the conditional update below never overwrites a newer committed state with
    // a stale write - if the version moved, `updateMany` matches 0 rows and the
    // mutation 409s (and the event insert is rolled back with it).
    const expected = patch.version ?? row.version

    const state = deserializeState(row.state)
    let nextState = state
    if (patch.currentResources) {
      nextState = {
        ...nextState,
        currentResources: {
          ...state.currentResources,
          ...patch.currentResources,
        },
      }
    }

    const result = await tx.character.updateMany({
      where: { id, version: expected },
      data: {
        ...(patch.name != null ? { name: patch.name } : {}),
        ...(patch.description !== undefined
          ? { description: patch.description }
          : {}),
        ...(patch.nickname !== undefined
          ? { nickname: metadataOrNull(patch.nickname) }
          : {}),
        ...(patch.pronouns !== undefined
          ? { pronouns: metadataOrNull(patch.pronouns) }
          : {}),
        ...(patch.ageDescription !== undefined
          ? { ageDescription: metadataOrNull(patch.ageDescription) }
          : {}),
        ...(patch.appearance !== undefined
          ? { appearance: metadataOrNull(patch.appearance) }
          : {}),
        ...(patch.biography !== undefined
          ? { biography: metadataOrNull(patch.biography) }
          : {}),
        ...(patch.notes !== undefined
          ? { notes: metadataOrNull(patch.notes) }
          : {}),
        ...(patch.archived != null ? { archived: patch.archived } : {}),
        ...(patch.currentResources
          ? { state: serializeState(nextState) as Prisma.InputJsonValue }
          : {}),
        version: { increment: 1 },
      },
    })

    if (result.count !== 1) {
      throw conflict(
        "version_conflict",
        `Version mismatch: expected ${expected}, got a newer version`
      )
    }

    // The update journal names ONLY the profile-metadata fields that actually
    // changed (never the long prose) so a biography/edit does not duplicate
    // private notes into the journal. The actor id is always recorded.
    const changedMetadataFields = (
      [
        "nickname",
        "pronouns",
        "ageDescription",
        "appearance",
        "biography",
        "notes",
      ] as const
    ).filter(
      (field) =>
        patch[field] !== undefined &&
        metadataOrNull(patch[field]) !== row[field]
    )

    await tx.progressionEvent.create({
      data: {
        characterId: id,
        kind: "update",
        payload: {
          name: patch.name,
          description: patch.description,
          archived: patch.archived,
          currentResources: patch.currentResources,
          ...(changedMetadataFields.length
            ? { changedFields: changedMetadataFields }
            : {}),
          actorId: user.id,
        } as Prisma.InputJsonValue,
      },
    })

    const updated = (await tx.character.findUnique({
      where: { id },
      include: characterInclude,
    }))!
    return await detailFor(updated, houseRules, tx)
  })
}

export async function archiveCharacter(
  id: string,
  user: SessionUser
): Promise<CharacterDetail> {
  return prisma.$transaction(async (tx) => {
    const row = await assertOwner(tx, id, user)
    const houseRules = await loadHouseRules(tx)
    const result = await tx.character.updateMany({
      where: { id, version: row.version },
      data: { archived: true, version: { increment: 1 } },
    })
    if (result.count !== 1) {
      throw conflict(
        "version_conflict",
        `Version mismatch: expected ${row.version}, got a newer version`
      )
    }
    await tx.progressionEvent.create({
      data: {
        characterId: id,
        kind: "archive",
        payload: { from: row.archived } as Prisma.InputJsonValue,
      },
    })
    const updated = (await tx.character.findUnique({
      where: { id },
      include: characterInclude,
    }))!
    return await detailFor(updated, houseRules, tx)
  })
}

/**
 * Whether an unarchived `skills` catalog definition matches a schedule-credit
 * (milestone) credit offer. A scheduled credit offers ANY active skill matching
 * the earned track type exactly; the skill's `milestone`, `choiceGroup` and
 * `eligibleDefinitionStableIds` are LEGACY annotations that no longer restrict
 * scheduled-credit eligibility. A skill carries no catalog grade band (migration
 * 20261017200000_skill_grade_removed nulled it), so eligibility is by config
 * `track` ONLY - a legacy skill row that still holds a non-null `grade` is still
 * matched, and never filtered by the earned grade. The skill's own `choiceGroup`
 * is deliberately ignored - all matches collapse into the single "standard"
 * offer. Shared by the initial credit offer AND by `refreshPendingSkillOffers`,
 * so a refresh never appends an option the original credit would have rejected.
 */
function skillDefMatchesScheduledOffer(
  def: { config: unknown },
  offer: { track: string }
): boolean {
  const config = parseCatalogConfig("skills", def.config ?? {})
  return config.track === offer.track
}

/**
 * Create the SINGLE skill-choice credit offer for a character that just leveled a
 * class/profession track (or a monster race) to a MILESTONE level.
 *
 * A credit is generated only when the track's authoritative grade (passed as
 * `offerGrade`) is a skill-choice MILESTONE at `newLevel` under the transaction's
 * `intervals` schedule (every grade G..S now credits). Non-milestone level-ups
 * produce no offer, even when skills are configured for that level.
 *
 * When a credit IS due, exactly ONE offer is created with choiceGroup
 * `"standard"` - regardless of any skill config `choiceGroup` - and it is created
 * even when zero unarchived skills match (a zero-option milestone credit). The
 * offer options are the unarchived `skills` catalog entries whose config `track`
 * exactly matches the advanced track. A skill carries no catalog grade band
 * (migration 20261017200000_skill_grade_removed), so it is never filtered by the
 * earned grade - a legacy skill row that still holds a `grade` is still offered
 * (no inferred compatibility). The skill's `milestone`, `choiceGroup` and
 * `eligibleDefinitionStableIds` are LEGACY annotations ignored
 * for scheduled-credit eligibility; every matching-typed skill is offered at any
 * credit milestone. Options are ordered deterministically BEFORE insert: a skill
 * whose `classStableId` matches the snapshotted class (`classStableIdAtEarn`)
 * sorts first, then name casefold, then stableId, then id. Provenance
 * (`earnedGrade`, `trackDefinitionStableId`, `classStableIdAtEarn`) is persisted
 * on the offer; legacy/imported offers are never backfilled.
 *
 * A pre-existing ACTIVE (canceledAt null) offer for the same
 * (character, track, level, "standard") is left untouched (never duplicated); a
 * canceled offer does not block a re-offer, which is created at the next
 * generation (max existing generation + 1) without deleting or rewriting the
 * canceled record (append-only). A concurrent insert of the same generation
 * between the check and the create surfaces as a unique-variant that aborts the
 * whole transaction (no silent skip, no half-applied advance).
 *
 * Returns the created offer (id + choiceGroup), or an empty array when no credit
 * is due or a pre-existing active offer already covers the key.
 */
async function createSkillOffersForAdvance(
  tx: DbClient,
  characterId: string,
  track: "race" | "class" | "profession",
  newLevel: number,
  offerGrade: Grade,
  trackStableId: string | undefined,
  classStableIdAtEarn: string | null,
  intervals: SkillChoiceIntervals
): Promise<Array<{ id: string; choiceGroup: string }>> {
  // Only a configured skill-choice milestone credits. "Other level-ups no offers
  // even if skills configured."
  if (!isSkillChoiceMilestone(offerGrade, newLevel, intervals)) return []

  const skillDefs = await tx.catalogDefinition.findMany({
    where: { kind: "skills", archived: false },
  })
  const eligible: Array<{
    def: {
      id: string
      name: string
      stableId: string
      grade: string | null
      config: unknown
    }
  }> = []

  for (const def of skillDefs) {
    // The skill config `choiceGroup` is deliberately IGNORED for a schedule
    // credit: all matching options collapse into a single "standard" offer so a
    // credit is never multiplied. The track eligibility is shared with
    // `refreshPendingSkillOffers` so a refresh never inserts an option the
    // original credit would have rejected. A skill carries no catalog grade band,
    // so it is matched by config `track` only, regardless of the earned grade.
    if (!skillDefMatchesScheduledOffer({ config: def.config }, { track })) {
      continue
    }
    eligible.push({
      def: {
        id: def.id,
        name: def.name,
        stableId: def.stableId,
        grade: def.grade,
        config: def.config,
      },
    })
  }

  // Deterministic eligible-option order before any DB insert (class tie first).
  // At EARNING time each option's `def.config` is exactly the config snapped into
  // `configSnapshot`, so sorting on it here is sorting on the future snapshot: a
  // later catalog edit never retroactively reorders an already-inserted option.
  eligible.sort((a, b) =>
    compareSkillOfferOptions(
      {
        configSnapshot: parseCatalogConfig("skills", a.def.config ?? {}),
        name: a.def.name,
        stableId: a.def.stableId,
        id: a.def.id,
      },
      {
        configSnapshot: parseCatalogConfig("skills", b.def.config ?? {}),
        name: b.def.name,
        stableId: b.def.stableId,
        id: b.def.id,
      },
      classStableIdAtEarn
    )
  )

  // EXACTLY ONE offer per (character, track, level), always choiceGroup
  // "standard", even when zero skills match (a zero-option milestone credit).
  // Enforce the active-offer invariant by checking for a pre-existing ACTIVE
  // (canceledAt null) offer BEFORE creating, inside this live transaction. A
  // pre-existing active offer is left untouched and never duplicated; a canceled
  // offer does NOT block a re-offer (created as max generation + 1, superseding
  // the canceled one WITHOUT deleting it or rewriting its snapshots).
  const existingOffers = await tx.skillOffer.findMany({
    where: { characterId, track, level: newLevel, choiceGroup: "standard" },
  })
  if (existingOffers.some((o) => o.canceledAt == null)) return []
  const maxGeneration = existingOffers.reduce(
    (m, o) => Math.max(m, o.generation),
    -1
  )
  const generation = maxGeneration === -1 ? 0 : maxGeneration + 1
  const offer = await tx.skillOffer.create({
    data: {
      characterId,
      track,
      level: newLevel,
      choiceGroup: "standard",
      generation,
      earnedGrade: offerGrade,
      trackDefinitionStableId: trackStableId ?? null,
      classStableIdAtEarn: classStableIdAtEarn ?? null,
      options: {
        create: eligible.map((e) => ({
          definitionId: e.def.id,
          nameSnapshot: e.def.name,
          configSnapshot: (e.def.config ?? {}) as Prisma.InputJsonValue,
        })),
      },
    },
  })
  return [{ id: offer.id, choiceGroup: "standard" }]
}

export async function advanceCharacter(
  id: string,
  body: { track: "class" | "profession" | "race"; version: number },
  user: SessionUser
): Promise<{ character: CharacterDetail; journal: unknown }> {
  return prisma.$transaction(async (tx) => {
    const row = await assertOwner(tx, id, user)
    const houseRules = await loadHouseRules(tx)
    const state = deserializeState(row.state)
    const config = configFor(row, houseRules.config)

    // How the character advances is fixed by its race mode: a monster advances on
    // an independent race-only track; an enlightened race advances via its
    // class/profession (derived) tracks. The two are mutually exclusive.
    const isMonster = state.race.mode === "independent"
    const isRaceTrack = body.track === "race"

    let result: AdvanceResult
    let definitionId: string
    if (isRaceTrack) {
      // Race-only advance is legal only for a monster (independent race mode).
      if (!isMonster) {
        throw badRequest(
          "invalid_track",
          `Race advance is only for an independent (monster) race; character race mode is "${state.race.mode}"`
        )
      }
      const def = config.raceDefinitions?.[state.race.grade]
      if (!def) {
        throw badRequest(
          "no_definition",
          `No race definition for grade ${state.race.grade}`
        )
      }
      definitionId = def.id
      result = advanceRaceQuarter(state, def, config)
    } else {
      // A class/profession advance is legal only for an enlightened race.
      if (isMonster) {
        throw badRequest(
          "invalid_track",
          `A monster (independent) race has no "${body.track}" track`
        )
      }
      const trackRow = body.track === "class" ? row.class : row.profession
      const definition = resolveTrackDefinition(trackRow, state, body.track)
      if (!definition) {
        throw badRequest(
          "no_definition",
          `No supported track definition for ${body.track}`
        )
      }
      definitionId = definition.id
      result = applyAdvance(state, body.track, definition, config)
    }

    const serialized = serializeState(result.state)
    // Compare-and-swap against the client's expected version. If any concurrent
    // mutation bumped the version, `updateMany` matches 0 rows and we 409 (the
    // event insert below is never reached, so it is rolled back with the txn).
    const updatedMany = await tx.character.updateMany({
      where: { id, version: body.version },
      data: {
        state: serialized as Prisma.InputJsonValue,
        version: { increment: 1 },
      },
    })
    if (updatedMany.count !== 1) {
      throw conflict(
        "version_conflict",
        `Version mismatch: expected ${body.version}, got a newer version`
      )
    }

    // Skills are offered, never auto-awarded: on a level-up, generate one offer
    // from the current unarchived skills catalog. A class/profession level-up
    // (enlightened race) and an independent (monster) race level-up both earn a
    // single choiceGroup "standard" credit offer at a matching grade milestone,
    // even with zero options; a quarter-only advance (no level up) produces none.
    // The offers are created inside the same transaction as the CAS state write and
    // the immutable advance event, so a conflict rolls all of them back together.
    let skillOffers: Array<{ id: string; choiceGroup: string }> = []
    if (result.journal.leveledUp) {
      const newLevel = result.journal.levelAfter
      if (isRaceTrack) {
        // Independent (monster) race: a race level-up earns a skill-choice credit
        // offer at every matching grade milestone, even with zero options. No
        // class/profession offer is ever made for a monster. The earned grade is
        // the race's own grade; the track stableId is the race's catalog stableId
        // (the race identity is preserved across evolution, never re-derived).
        const raceStableId = row.race?.stableId
        skillOffers = await createSkillOffersForAdvance(
          tx,
          id,
          "race",
          newLevel,
          result.state.race.grade,
          raceStableId ?? undefined,
          null,
          houseRules.config.skillChoiceIntervals
        )
      } else {
        const raceGrade = result.state.race.grade
        // A graded class/profession track filters milestone offers by the track's OWN
        // grade (independent of the race grade); an ungraded legacy track uses the
        // race grade.
        const trackGrade = result.state.tracks[body.track]?.grade ?? raceGrade
        const trackStableId =
          body.track === "class"
            ? row.class?.stableId
            : row.profession?.stableId
        skillOffers = await createSkillOffersForAdvance(
          tx,
          id,
          body.track,
          newLevel,
          trackGrade,
          trackStableId ?? undefined,
          row.class?.stableId ?? null,
          houseRules.config.skillChoiceIntervals
        )
      }
    }

    const advanceJournal: Record<string, unknown> = { ...result.journal }
    // The version AFTER this advance committed, so a consumer can deterministically
    // undo the event (find the prior version token). Legacy events that predate this
    // field remain readable/undoable by falling back to the event's preceding
    // version when this is absent.
    advanceJournal.characterVersionAfter = body.version + 1
    // Every level-up advance event records `skillOfferIds` (an empty array when
    // zero offers were generated) so the undo code can distinguish "explicitly no
    // offers to cancel" from a legacy event that never recorded the field. The
    // `skillOffers` payload is optional and omitted when there are none.
    if (result.journal.leveledUp) {
      advanceJournal.skillOfferIds = skillOffers.map((o) => o.id)
      if (skillOffers.length > 0) {
        advanceJournal.skillOffers = skillOffers
      }
    }

    await tx.progressionEvent.create({
      data: {
        characterId: id,
        kind: "advance",
        payload: {
          track: body.track,
          definitionId,
          journal: advanceJournal,
        } as unknown as Prisma.InputJsonValue,
      },
    })
    const updated = (await tx.character.findUnique({
      where: { id },
      include: characterInclude,
    }))!
    return {
      character: await toDetail(updated, true, config, houseRules.version, tx),
      journal: advanceJournal,
    }
  })
}

// ------------------------------------------------------------------ //
// Level-up undo (safe compensating reversal)
// ------------------------------------------------------------------ //

/**
 * Whether an `update` progression-event payload recorded a `currentResources`
 * resource mutation. The `updateCharacter` journal carries `currentResources`
 * only when the request actually supplied resources; an absent/undefined value
 * means the update was metadata-only (name / description / archive). Conservative:
 * any present value - even an empty object or null - is treated as a mutation,
 * since it cannot prove a metadata-only edit.
 */
function updatePayloadMutatesResources(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return true
  return (
    (payload as { currentResources?: unknown }).currentResources !== undefined
  )
}

/**
 * Events that do NOT supersede a level-up for undo purposes. These are purely
 * cosmetic / metadata-only (creation, archive toggle, and backup-import markers).
 * An `update` is cosmetic ONLY when its payload records no `currentResources`
 * change - a metadata-only profile edit (name / description / archive) is safe,
 * but a resource mutation must block the undo. Every other event kind (advance,
 * experience_set, allocate, evolve, consume,
 * skill_select/skill_grant/skill_upgrade, associate, inventory_adjust,
 * profession_set, level_undo) blocks the undo.
 */
function isCosmeticUndoEvent(e: { kind: string; payload: unknown }): boolean {
  if (e.kind === "update") {
    return !updatePayloadMutatesResources(e.payload)
  }
  return (
    e.kind === "create" ||
    e.kind === "archive" ||
    e.kind === "import" ||
    e.kind === "import_history"
  )
}

/** Deterministic event order: by `createdAt` (asc), then `id` (asc). */
function byCreatedAtThenId(
  a: { createdAt: Date; id: string },
  b: { createdAt: Date; id: string }
): number {
  const t = a.createdAt.getTime() - b.createdAt.getTime()
  if (t !== 0) return t
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Whether two attribute vectors are numerically identical across every attribute. */
function vectorsEqual(a: AttributeVector, b: AttributeVector): boolean {
  for (const attr of ATTRIBUTES) {
    if ((a[attr] ?? 0) !== (b[attr] ?? 0)) return false
  }
  return true
}

/**
 * The UndoHistory payload shape recovered from an immutable `advance` level-up
 * event. Only the fields the undo needs are typed; unknown fields are ignored.
 */
type UndoAdvanceJournal = {
  track?: string
  levelBefore?: number
  levelAfter?: number
  quarterBefore?: number
  percentBefore?: number
  raceLevelBefore?: number
  raceLevelAfter?: number
  award?: { definitionId?: string; fixed?: AttributeVector; free?: number }
  raceGain?: {
    grade?: string
    levelsGained?: number
    fixed?: AttributeVector
    free?: number
  } | null
  skillOfferIds?: string[]
}

/**
 * Perform the safe compensating reversal of the most recent live level-up
 * (`operation: "undo"`). It runs inside the same SERIALIZABLE transaction as the
 * other experience operations. See `experienceCharacter` + docs/rules/leveling.md.
 *
 * The original `advance` event is never rewritten or deleted: only the current
 * state is compensated back to the journal's "before" values, the corresponding
 * award suffix is removed from `historicalLevelAwards`, and generated milestone
 * skill offers are canceled (append-only `canceledAt` stamp, never deleted). Any
 * condition that makes the reversal unsafe rejects with 409 `level_undo_blocked`
 * and writes nothing.
 */
async function undoExperience(
  tx: DbClient,
  characterId: string,
  state: CharacterState,
  config: RulesConfig,
  body: {
    operation: "undo"
    track: "race" | "class" | "profession"
    version: number
  },
  houseRules: HouseRulesRow
): Promise<{ character: CharacterDetail; journal: unknown }> {
  const isMonster = state.race.mode === "independent"
  const isRaceTrack = body.track === "race"

  // Race-mode track validity, mirroring /advance and the set/levelUp path.
  if (isRaceTrack) {
    if (!isMonster) {
      throw badRequest(
        "invalid_track",
        `Race experience is only for an independent (monster) race; character race mode is "${state.race.mode}"`
      )
    }
  } else if (isMonster) {
    throw badRequest(
      "invalid_track",
      `A monster (independent) race has no "${body.track}" track`
    )
  }

  const trackState = isRaceTrack ? state.race : state.tracks[body.track]
  if (!trackState) {
    throw badRequest("invalid_track", `Character has no "${body.track}" track`)
  }
  // A level-up can only be undone when there is a level to undo.
  const currentLevel = isRaceTrack ? state.race.level : trackState.level
  if (currentLevel <= 0) {
    throw conflict(
      "level_undo_blocked",
      `No level to undo: "${body.track}" is at level ${currentLevel}`
    )
  }

  // Load the immutable journal and order it deterministically (createdAt, then id).
  const events = (
    await tx.progressionEvent.findMany({
      where: { characterId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    })
  ).sort(byCreatedAtThenId)
  // Imported history is never authoritative for undo: exclude it entirely.
  const relevant = events.filter((e) => e.kind !== "import_history")

  // Locate the most recent LIVE advance-with-leveledUp event.
  let target: (typeof relevant)[number] | undefined
  for (let i = relevant.length - 1; i >= 0; i--) {
    const e = relevant[i]
    if (e.kind !== "advance") continue
    const payload = e.payload as { journal?: { leveledUp?: boolean } }
    if (payload?.journal?.leveledUp === true) {
      target = e
      break
    }
  }
  if (!target) {
    throw conflict(
      "level_undo_blocked",
      `No level-up event found to undo on "${body.track}"`
    )
  }

  const targetPayload = target.payload as {
    track?: string
    journal?: Record<string, unknown>
  }
  const j = (targetPayload.journal ?? {}) as UndoAdvanceJournal

  // The selected track must be the one that actually leveled up.
  if (targetPayload.track && targetPayload.track !== body.track) {
    throw conflict(
      "level_undo_blocked",
      `The latest level-up was on "${targetPayload.track}", not "${body.track}"`
    )
  }

  // A later non-cosmetic event (or a same-timestamp ambiguous progression event)
  // supersedes the level-up: reject rather than guess.
  const targetTime = target.createdAt.getTime()
  for (const e of relevant) {
    if (e.id === target.id) continue
    if (isCosmeticUndoEvent(e)) continue
    const sameTime = e.createdAt.getTime() === targetTime
    const after = sameTime
      ? e.id > target.id
      : e.createdAt.getTime() > targetTime
    if (after) {
      throw conflict(
        "level_undo_blocked",
        `Cannot undo: a later "${e.kind}" event supersedes the level-up`
      )
    }
    if (sameTime) {
      throw conflict(
        "level_undo_blocked",
        `Cannot undo: ambiguous progression events share the level-up timestamp (${e.kind})`
      )
    }
  }

  const levelBefore = j.levelBefore
  const levelAfter = j.levelAfter
  const quarterBefore = j.quarterBefore ?? 0
  const raceLevelBefore = j.raceLevelBefore
  const raceLevelAfter = j.raceLevelAfter
  if (
    levelBefore == null ||
    levelAfter == null ||
    raceLevelBefore == null ||
    raceLevelAfter == null
  ) {
    throw conflict(
      "level_undo_blocked",
      "Level-up event journal is missing level / race-level before or after"
    )
  }
  const award = j.award
  if (!award || !award.definitionId || !award.fixed || award.free == null) {
    throw conflict(
      "level_undo_blocked",
      "Level-up event journal is missing the award snapshot"
    )
  }
  const raceGain = j.raceGain

  // Validate the CURRENT state against the level-up's "after" snapshot.
  if (trackState.level !== levelAfter) {
    throw conflict(
      "level_undo_blocked",
      `Track "${body.track}" is at level ${trackState.level}, expected ${levelAfter} (the level-up was already undone or superseded)`
    )
  }
  const currentQuarter = isRaceTrack
    ? (state.race.quarter ?? 0)
    : trackState.quarter
  const currentPercent = isRaceTrack
    ? state.race.experiencePercent
    : (trackState as { experiencePercent?: number }).experiencePercent
  if (currentQuarter !== 0) {
    throw conflict(
      "level_undo_blocked",
      `Track "${body.track}" has advanced to quarter ${currentQuarter}; cannot undo from the level-up boundary`
    )
  }
  if (currentPercent != null && currentPercent !== 0) {
    throw conflict(
      "level_undo_blocked",
      `Track "${body.track}" is at ${currentPercent}% within its level; cannot undo from the level-up boundary`
    )
  }
  if (state.race.level !== raceLevelAfter) {
    throw conflict(
      "level_undo_blocked",
      `Race level is ${state.race.level}, expected ${raceLevelAfter}`
    )
  }

  // Track grade/definition must be unchanged since the award (a later evolution is
  // already caught by the event scan, but a manual drift is rejected here).
  if (!isRaceTrack) {
    const currentDef = (trackState as { definitionId: string }).definitionId
    if (award.definitionId && currentDef !== award.definitionId) {
      throw conflict(
        "level_undo_blocked",
        `Track "${body.track}" definition changed since the award (${currentDef} vs ${award.definitionId})`
      )
    }
  } else {
    const raceDefId = state.race.definitionId
    if (raceDefId && award.definitionId && raceDefId !== award.definitionId) {
      throw conflict(
        "level_undo_blocked",
        `Race definition changed since the award (${raceDefId} vs ${award.definitionId})`
      )
    }
  }

  // Validate the exact historicalLevelAwards suffix that the level-up appended.
  const trackAwards = state.historicalLevelAwards.filter(
    (a) => a.track === body.track && a.level === levelAfter
  )
  if (trackAwards.length !== 1) {
    throw conflict(
      "level_undo_blocked",
      `Expected exactly one "${body.track}" award at level ${levelAfter}, found ${trackAwards.length}`
    )
  }
  const trackAward = trackAwards[0]
  if (
    trackAward.definitionId !== award.definitionId ||
    !vectorsEqual(trackAward.fixed, award.fixed) ||
    trackAward.free !== award.free
  ) {
    throw conflict(
      "level_undo_blocked",
      `The "${body.track}" award at level ${levelAfter} does not match the level-up snapshot`
    )
  }

  if (isRaceTrack) {
    // Independent monster race: the award IS a race award. It also must agree with
    // the raceGain journal when present.
    if (raceGain) {
      if (
        !vectorsEqual(raceGain.fixed ?? trackAward.fixed, trackAward.fixed) ||
        (raceGain.free ?? trackAward.free) !== trackAward.free
      ) {
        throw conflict(
          "level_undo_blocked",
          `Race award at level ${levelAfter} does not match the raceGain snapshot`
        )
      }
    }
  } else if (raceGain) {
    // A derived (enlightened) race also gained a race level from this level-up: there
    // must be a matching race award at raceLevelAfter.
    const raceAwards = state.historicalLevelAwards.filter(
      (a) => a.track === "race" && a.level === raceLevelAfter
    )
    if (raceAwards.length !== 1) {
      throw conflict(
        "level_undo_blocked",
        `Expected exactly one race award at level ${raceLevelAfter}, found ${raceAwards.length}`
      )
    }
    const raceAward = raceAwards[0]
    if (
      !raceGain.fixed ||
      !vectorsEqual(raceAward.fixed, raceGain.fixed) ||
      (raceAward.free ?? 0) !== (raceGain.free ?? 0)
    ) {
      throw conflict(
        "level_undo_blocked",
        `Race award at level ${raceLevelAfter} does not match the raceGain snapshot`
      )
    }
  } else if (raceLevelAfter !== raceLevelBefore) {
    // No raceGain recorded but the race level changed: mismatch.
    throw conflict(
      "level_undo_blocked",
      `Race level changed (${raceLevelBefore} -> ${raceLevelAfter}) but no raceGain was recorded`
    )
  }

  // Restore the track (and race) to the journal's "before" values.
  const percentBefore =
    j.percentBefore != null && j.percentBefore >= 0 && j.percentBefore <= 99
      ? j.percentBefore
      : quarterBefore * 25
  const restoredQuarter = Math.floor(percentBefore / 25)

  const restoredTracks = { ...state.tracks }
  const restoredRace = { ...state.race }
  if (isRaceTrack) {
    restoredRace.level = levelBefore
    restoredRace.quarter = restoredQuarter
    restoredRace.experiencePercent = percentBefore
  } else {
    restoredTracks[body.track] = {
      ...state.tracks[body.track]!,
      level: levelBefore,
      quarter: restoredQuarter,
      experiencePercent: percentBefore,
    }
    if (raceGain) {
      // A derived race level that advanced with the level-up is restored to its
      // prior value. We verify against the current derivation strategy below.
      restoredRace.level = raceLevelBefore
    }
  }

  // Remove only the current-state award suffix: the immutable advance event stays.
  const restoredAwards = state.historicalLevelAwards.filter((a) => {
    if (a.track === body.track && a.level === levelAfter) return false
    if (raceGain && a.track === "race" && a.level === raceLevelAfter)
      return false
    return true
  })

  const restored: CharacterState = {
    ...state,
    tracks: restoredTracks,
    race: restoredRace,
    historicalLevelAwards: restoredAwards,
  }

  // Derived-race sanity check against the current configured derive strategy.
  if (!isRaceTrack && !isMonster) {
    const derived = deriveRaceLevel(restored, config)
    if (derived !== raceLevelBefore) {
      throw conflict(
        "level_undo_blocked",
        `Derived race level after undo would be ${derived}, expected ${raceLevelBefore}`
      )
    }
  }

  // The restored free pool must still cover every allocated point.
  const freeAfter = totalFreePoints(restored)
  const allocated = allocatedPoints(state)
  if (freeAfter < allocated) {
    throw conflict(
      "level_undo_blocked",
      `Undo would leave the character ${allocated - freeAfter} free points in deficit (${allocated} allocated, ${freeAfter} remaining)`
    )
  }

  // Cancel generated milestone skill offers (append-only; never delete).
  //
  // An explicit `skillOfferIds` list (even an empty one) is authoritative: cancel
  // exactly those ids and nothing else, so a `[]` recorded by a level-up that
  // generated zero offers never cancels a pre-existing unrelated pending offer at
  // the same track/level. Only when the field is ABSENT do we fall back to the
  // legacy behavior of cancelling all active offers for the track/level.
  const canceledOfferIds: string[] = []
  if (j.skillOfferIds !== undefined) {
    for (const offerId of j.skillOfferIds) {
      const offer = await tx.skillOffer.findUnique({ where: { id: offerId } })
      if (!offer) {
        throw conflict(
          "level_undo_blocked",
          `Skill offer ${offerId} referenced by the level-up no longer exists`
        )
      }
      if (
        offer.characterId !== characterId ||
        offer.track !== body.track ||
        offer.level !== levelAfter
      ) {
        throw conflict(
          "level_undo_blocked",
          `Skill offer ${offerId} does not belong to this level-up`
        )
      }
      if (offer.canceledAt != null) {
        throw conflict(
          "level_undo_blocked",
          `Skill offer ${offerId} is already canceled`
        )
      }
      if (offer.selectedDefinitionId != null) {
        throw conflict(
          "level_undo_blocked",
          `Skill offer ${offerId} was selected; undo cannot remove the selected skill`
        )
      }
      await tx.skillOffer.update({
        where: { id: offerId },
        data: { canceledAt: new Date() },
      })
      canceledOfferIds.push(offerId)
    }
  } else {
    // Legacy event without offer ids: find active offers for the same track/level.
    // A selected offer blocks; pending ones are associated with this single last
    // level-up only when they are the sole active set (one per group).
    const activeOffers = await tx.skillOffer.findMany({
      where: {
        characterId,
        track: body.track,
        level: levelAfter,
        canceledAt: null,
      },
    })
    if (activeOffers.some((o) => o.selectedDefinitionId != null)) {
      throw conflict(
        "level_undo_blocked",
        `A skill offer at level ${levelAfter} was selected; undo cannot remove the selected skill`
      )
    }
    for (const offer of activeOffers) {
      await tx.skillOffer.update({
        where: { id: offer.id },
        data: { canceledAt: new Date() },
      })
      canceledOfferIds.push(offer.id)
    }
  }

  // Compare-and-swap against the client's expected version.
  const updatedMany = await tx.character.updateMany({
    where: { id: characterId, version: body.version },
    data: {
      state: serializeState(restored) as Prisma.InputJsonValue,
      version: { increment: 1 },
    },
  })
  if (updatedMany.count !== 1) {
    throw conflict(
      "version_conflict",
      `Version mismatch: expected ${body.version}, got a newer version`
    )
  }

  const undoJournal: Record<string, unknown> = {
    track: body.track,
    levelBefore: levelAfter,
    levelAfter: levelBefore,
    quarterBefore: 0,
    quarterAfter: restoredQuarter,
    percentBefore: 0,
    percentAfter: percentBefore,
    raceLevelBefore: raceLevelAfter,
    raceLevelAfter: raceLevelBefore,
    leveledUp: false,
    undone: true,
    award,
    raceGain: raceGain ?? null,
    canceledOfferIds,
    characterVersionAfter: body.version + 1,
  }

  await tx.progressionEvent.create({
    data: {
      characterId,
      kind: "level_undo",
      payload: {
        operation: "undo",
        track: body.track,
        originalEventId: target.id,
        journal: undoJournal,
      } as unknown as Prisma.InputJsonValue,
    },
  })

  const updated = (await tx.character.findUnique({
    where: { id: characterId },
    include: characterInclude,
  }))!
  return {
    character: await toDetail(updated, true, config, houseRules.version, tx),
    journal: { ...undoJournal, originalEventId: target.id },
  }
}

/**
 * POST /api/characters/[id]/experience.
 *
 * Settle the authoritative EXP percent of a track (class / profession / race) or
 * perform an instant level-up, leveraging the pure engine functions
 * `setExperiencePercent` / `levelUpFromExperience`. The authoritative race-mode
 * validation mirrors `/advance`: a race track is legal only for an independent
 * (monster) race; a class/profession track is legal only for an enlightened race.
 *
 * - `set` with `percent < 100` records an `experience_set` event (journal with
 *   percentBefore/After, turnsAdvanced) and never touches skill offers.
 * - `set` with `percent === 100`, or a `levelUp`, performs an actual level-up and
 *   records an `advance` event whose journal carries `characterVersionAfter`, the
 *   snapshotted award/raceGain, and the generated milestone skill offers (created
 *   exactly once inside this transaction).
 * - A no-op `set` (target === current) is rejected 400 `experience_unchanged`
 *   without bumping the version or writing an event.
 * - A closed grade gate thrown by the pure engine aborts atomically (state, turn,
 *   offers, and event all roll back) and surfaces as 400 `grade_blocked`.
 *
 * The whole mutation runs under SERIALIZABLE isolation; a P2034 serialization
 * conflict is surfaced as a 409 rather than a raw 500.
 */
export async function experienceCharacter(
  id: string,
  body:
    | {
        operation: "set"
        track: "race" | "class" | "profession"
        percent: number
        version: number
      }
    | {
        operation: "levelUp"
        track: "race" | "class" | "profession"
        version: number
      }
    | {
        operation: "undo"
        track: "race" | "class" | "profession"
        version: number
      },
  user: SessionUser
): Promise<{ character: CharacterDetail; journal: unknown }> {
  const serializable = {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  } as const
  try {
    return await prisma.$transaction(async (tx) => {
      const row = await assertOwner(tx, id, user)
      const houseRules = await loadHouseRules(tx)
      const state = deserializeState(row.state)
      const config = configFor(row, houseRules.config)

      const isMonster = state.race.mode === "independent"
      const isRaceTrack = body.track === "race"

      // `undo` short-circuits the pure engine: it compensates the latest actual
      // level-up directly (see `undoExperience`), so no definition resolution,
      // engine call, or skill-offer generation is needed here.
      if (body.operation === "undo") {
        return await undoExperience(tx, id, state, config, body, houseRules)
      }

      // Resolve the authoritative current definition and validate race mode before
      // calling the engine, mirroring /advance.
      let definition: TrackDefinition | RaceDefinition
      let definitionId: string
      if (isRaceTrack) {
        if (!isMonster) {
          throw badRequest(
            "invalid_track",
            `Race experience is only for an independent (monster) race; character race mode is "${state.race.mode}"`
          )
        }
        const raceDef = config.raceDefinitions?.[state.race.grade]
        if (!raceDef) {
          throw badRequest(
            "no_definition",
            `No race definition for grade ${state.race.grade}`
          )
        }
        definition = raceDef
        definitionId = raceDef.id
      } else {
        if (isMonster) {
          throw badRequest(
            "invalid_track",
            `A monster (independent) race has no "${body.track}" track`
          )
        }
        const trackRow = body.track === "class" ? row.class : row.profession
        const trackDef = resolveTrackDefinition(trackRow, state, body.track)
        if (!trackDef) {
          throw badRequest(
            "no_definition",
            `No supported track definition for ${body.track}`
          )
        }
        definition = trackDef
        definitionId = trackDef.id
      }

      // A no-op set must reject 400 instead of bumping version / writing an event.
      if (body.operation === "set") {
        const current = experiencePercentFor(state, body.track)
        if (body.percent === current) {
          throw badRequest(
            "experience_unchanged",
            `Experience is already ${current}% on "${body.track}"`
          )
        }
      }

      // Run the pure engine. A closed grade gate throws before any write, so a
      // partial state/turn/offer/event never escapes the transaction.
      let result: AdvanceResult
      try {
        if (body.operation === "set") {
          result = isRaceTrack
            ? setExperiencePercent(
                state,
                "race",
                body.percent,
                definition as RaceDefinition,
                config
              )
            : setExperiencePercent(
                state,
                body.track,
                body.percent,
                definition as TrackDefinition,
                config
              )
        } else {
          result = isRaceTrack
            ? levelUpFromExperience(
                state,
                "race",
                definition as RaceDefinition,
                config
              )
            : levelUpFromExperience(
                state,
                body.track,
                definition as TrackDefinition,
                config
              )
        }
      } catch (err) {
        // Grade-ceiling gates from the pure engine. A graded class/profession
        // track may not push PAST the next grade's entry level (`without
        // completed track evolution`), and a derived/independent race may not
        // push past its own (`without completed evolution`). Both are the
        // caller's 400, never a 500, and the explicit substring match never
        // masks an unrelated engine failure. Throwing here aborts the whole
        // transaction, so no state / version / event / offer write escapes.
        const message = err instanceof Error ? err.message : ""
        if (
          message.includes("without completed evolution") ||
          message.includes("without completed track evolution")
        ) {
          throw badRequest("grade_blocked", message)
        }
        throw err
      }

      const serialized = serializeState(result.state)
      // Compare-and-swap against the client's expected version. If any concurrent
      // mutation bumped the version, `updateMany` matches 0 rows and we 409 (the
      // event insert below is never reached, so it is rolled back with the txn).
      const updatedMany = await tx.character.updateMany({
        where: { id, version: body.version },
        data: {
          state: serialized as Prisma.InputJsonValue,
          version: { increment: 1 },
        },
      })
      if (updatedMany.count !== 1) {
        throw conflict(
          "version_conflict",
          `Version mismatch: expected ${body.version}, got a newer version`
        )
      }

      const leveledUp = result.journal.leveledUp === true

      // Skill offers are generated only on an actual level-up, exactly once inside
      // this transaction. A class/profession track (enlightened race) and an
      // independent (monster) race level-up both earn a single choiceGroup
      // "standard" credit offer at a grade milestone, even with zero options; a
      // percent-only set (no level-up) produces none.
      let skillOffers: Array<{ id: string; choiceGroup: string }> = []
      if (leveledUp) {
        const newLevel = result.journal.levelAfter
        if (isRaceTrack) {
          // Independent (monster) race: a race level-up earns a skill-choice credit
          // offer at every matching grade milestone, even with zero options. No
          // class/profession offer is ever made for a monster. The earned grade is
          // the race's own grade; the track stableId is the race's catalog stableId
          // (preserved identity across evolution).
          const raceStableId = row.race?.stableId
          skillOffers = await createSkillOffersForAdvance(
            tx,
            id,
            "race",
            newLevel,
            result.state.race.grade,
            raceStableId ?? undefined,
            null,
            houseRules.config.skillChoiceIntervals
          )
        } else {
          const raceGrade = result.state.race.grade
          const trackGrade = result.state.tracks[body.track]?.grade ?? raceGrade
          const trackStableId =
            body.track === "class"
              ? row.class?.stableId
              : row.profession?.stableId
          skillOffers = await createSkillOffersForAdvance(
            tx,
            id,
            body.track,
            newLevel,
            trackGrade,
            trackStableId ?? undefined,
            row.class?.stableId ?? null,
            houseRules.config.skillChoiceIntervals
          )
        }
      }

      const journal: Record<string, unknown> = { ...result.journal }
      if (leveledUp) {
        // The version AFTER this level-up committed, so a consumer can
        // deterministically undo the event by finding the prior version token.
        journal.characterVersionAfter = body.version + 1
        // Every level-up advance event records `skillOfferIds` (an empty array
        // when zero offers were generated) so the undo code can distinguish
        // "explicitly no offers to cancel" from a legacy event that never
        // recorded the field. The `skillOffers` payload is optional and omitted
        // when there are none.
        journal.skillOfferIds = skillOffers.map((o) => o.id)
        if (skillOffers.length > 0) {
          journal.skillOffers = skillOffers
        }
      }

      const eventKind = leveledUp ? "advance" : "experience_set"
      await tx.progressionEvent.create({
        data: {
          characterId: id,
          kind: eventKind,
          payload: {
            operation: body.operation,
            track: body.track,
            ...(body.operation === "set" ? { percent: body.percent } : {}),
            ...(leveledUp ? { definitionId } : {}),
            journal,
          } as unknown as Prisma.InputJsonValue,
        },
      })

      const updated = (await tx.character.findUnique({
        where: { id },
        include: characterInclude,
      }))!
      return {
        character: await toDetail(
          updated,
          true,
          config,
          houseRules.version,
          tx
        ),
        journal,
      }
    }, serializable)
  } catch (err) {
    if (isSerializationFailure(err)) {
      throw conflict(
        "serialization_conflict",
        "Concurrent character change detected; retry the experience request"
      )
    }
    throw err
  }
}

/**
 * Resolve the skill config's upgrade group from a definition, or undefined.
 */
function skillUpgradeGroup(def: {
  kind: string
  config?: unknown
}): string | undefined {
  const group = parseCatalogConfig(def.kind, def.config ?? {}).upgradeGroup
  return typeof group === "string" && group.length > 0 ? group : undefined
}

/**
 * Resolve the skill config's ordered rarity from a definition, or undefined.
 */
function skillRarityOf(def: {
  kind: string
  config?: unknown
}): string | undefined {
  const rarity = parseCatalogConfig(def.kind, def.config ?? {}).rarity
  return typeof rarity === "string" && rarity.length > 0 ? rarity : undefined
}

/**
 * Collect every SKILL-kind link on the character that shares `upgradeGroup`,
 * WITHOUT deleting anything. The newly acquired definition is excluded, and only
 * SKILL-kind links are considered. This is the exact set
 * `removeSameUpgradeGroupSkills` would remove - used to enforce the
 * monotonic-rarity guard BEFORE any write.
 */
function sameUpgradeGroupSkillLinks(
  associations: CharacterWithCatalog["associations"],
  definitionId: string,
  upgradeGroup: string
): Array<{
  definitionId: string
  name: string
  rarity: string | undefined
}> {
  const links: Array<{
    definitionId: string
    name: string
    rarity: string | undefined
  }> = []
  for (const link of associations) {
    if (link.kind !== "SKILL") continue
    if (link.definitionId === definitionId) continue
    if (skillUpgradeGroup(link.definition) !== upgradeGroup) continue
    links.push({
      definitionId: link.definitionId,
      name: link.definition.name,
      rarity: skillRarityOf(link.definition),
    })
  }
  return links
}

/**
 * Enforce the monotonic rarity rule for a select/grant that replaces one or more
 * linked skills in the same upgrade group: the incoming skill must carry a
 * strictly higher ordered rarity than EVERY removed link. Rejects with 400
 * `skill_rarity_not_higher` when the target rarity is missing/incomparable
 * (e.g. `Unique`), when any removed link's rarity is missing/incomparable, or
 * when any removed link is not strictly lower. Skills with no group (or with no
 * removable same-group links) never reach this check.
 */
function assertSkillRarityMonotonic(
  target: { definitionId: string; name: string; rarity: string | undefined },
  removedLinks: Array<{
    definitionId: string
    name: string
    rarity: string | undefined
  }>
): void {
  const targetIndex = rarityOrderIndex(target.rarity)
  if (targetIndex == null) {
    throw badRequest(
      "skill_rarity_not_higher",
      `Skill "${target.name}" must carry an ordered rarity (missing or incomparable "Unique") to replace a linked skill in its upgrade group`
    )
  }
  for (const link of removedLinks) {
    const linkIndex = rarityOrderIndex(link.rarity)
    if (linkIndex == null) {
      throw badRequest(
        "skill_rarity_not_higher",
        `Skill "${target.name}" cannot replace "${link.name}": "${link.name}" has an incomparable/missing rarity ("${link.rarity ?? "(none)"}")`
      )
    }
    if (linkIndex >= targetIndex) {
      throw badRequest(
        "skill_rarity_not_higher",
        `Skill "${target.name}" (rarity "${target.rarity}") is not strictly higher than "${link.name}" (rarity "${link.rarity}")`
      )
    }
  }
}

/**
 * Delete every skill link on the character that shares `upgradeGroup` (never
 * stack superseded tiers). The newly acquired definition is excluded, and only
 * SKILL-kind links are considered.
 */
async function removeSameUpgradeGroupSkills(
  tx: DbClient,
  characterId: string,
  associations: CharacterWithCatalog["associations"],
  definitionId: string,
  upgradeGroup: string
): Promise<Array<{ definitionId: string; name: string }>> {
  const removed: Array<{ definitionId: string; name: string }> = []
  for (const link of associations) {
    if (link.kind !== "SKILL") continue
    if (link.definitionId === definitionId) continue
    if (skillUpgradeGroup(link.definition) !== upgradeGroup) continue
    removed.push({
      definitionId: link.definitionId,
      name: link.definition.name,
    })
    await tx.characterAssociation.deleteMany({
      where: { characterId, definitionId: link.definitionId },
    })
  }
  return removed
}

// ------------------------------------------------------------------ //
// Grade-granted skill acquisition helpers
// ------------------------------------------------------------------ //

/** A SKILL association currently owned by a character (persisted or planned). */
type OwnedSkillLink = {
  definitionId: string
  stableId: string
  name: string
  config: Record<string, unknown>
}

/** One requested grade-granted skill: a stableId plus the source grade. */
type GradeGrantRequest = {
  stableId: string
  grade: Grade
}

/** The immutable audit journal for a grade-grant acquisition. */
type GradeGrantJournal = {
  /** Skills newly linked directly in this acquisition. */
  granted: Array<{ stableId: string; name: string; grade: Grade }>
  /** Skills upgraded (replaced) from a lower-rarity owned link to a higher one. */
  upgraded: Array<{
    fromStableId: string
    fromName: string
    toStableId: string
    toName: string
    grade: Grade
  }>
  /**
   * Requested skills already owned with no eligible authored upgrade (retained).
   * `reason` records WHY the acquisition was retained as a no-op - the relevant
   * one here is an owned same-group link carrying an incomparable rarity
   * (`Unique`, or a missing/unrecognized value), which nothing can be strictly
   * higher than, so the existing links are preserved rather than deleted.
   */
  noop: Array<{
    stableId: string
    name: string
    grade: Grade
    reason: string
  }>
  /** Requested skills that could not be resolved (missing/archived), never omitted. */
  skipped: Array<{ stableId: string; grade: Grade }>
  /**
   * Skills that were planned as a `granted` (or intermediate upgrade source) link
   * in this acquisition but were later SUPERSEDED by a subsequent grant in the same
   * transaction (e.g. a race-grade Common grant that a class-grade duplicate
   * upgraded to a higher-rarity tier in the same upgrade group). A superseded link
   * was never actually persisted, so it never appears in `granted`/`upgraded` as a
   * live link; it is recorded here with its originating grade so the audit trail
   * explains how a planned grant was replaced by a later upgrade.
   */
  superseded: Array<{ stableId: string; name: string; grade: Grade }>
}

/** The outcome of resolving a set of grade-grant requests. */
type GradeGrantResolution = {
  toCreate: Array<{ definitionId: string; stableId: string; grade: Grade }>
  toDeleteDefinitionIds: string[]
  journal: GradeGrantJournal
}

/** Whether a grant journal carries any meaningful record. */
function hasGradeGrantJournalEntries(j: GradeGrantJournal): boolean {
  return (
    j.granted.length > 0 ||
    j.upgraded.length > 0 ||
    j.noop.length > 0 ||
    j.skipped.length > 0 ||
    j.superseded.length > 0
  )
}

/**
 * Extract every currently-owned SKILL association on the character as a
 * `OwnedSkillLink` so the grade-grant duplicate/upgrade policy can see what the
 * character already holds. Only SKILL-kind links are considered (a blessing /
 * bloodline / transcendent never participates in a skill upgrade group).
 */
function ownedSkillLinksFrom(
  associations: CharacterWithCatalog["associations"]
): OwnedSkillLink[] {
  const links: OwnedSkillLink[] = []
  for (const link of associations) {
    if (link.kind !== "SKILL") continue
    const def = link.definition
    links.push({
      definitionId: link.definitionId,
      stableId: def?.stableId ?? link.definitionId,
      name: def?.name ?? "(unresolved)",
      config: (def?.config ?? {}) as Record<string, unknown>,
    })
  }
  return links
}

/** Read a config's `upgradeGroup`, or undefined when absent/blank. */
function configUpgradeGroup(
  config: Record<string, unknown>
): string | undefined {
  const group = config.upgradeGroup
  return typeof group === "string" && group.length > 0 ? group : undefined
}

/** Read a config's `rarity`, or undefined when absent/blank. */
function configRarity(config: Record<string, unknown>): string | undefined {
  const rarity = config.rarity
  return typeof rarity === "string" && rarity.length > 0 ? rarity : undefined
}

/**
 * Resolve a set of grade-grant requests against the currently-owned skills and the
 * live unarchived skill catalog, producing EXACTLY the links to create and the
 * existing links to remove, plus an immutable journal. Never grants a missing or
 * archived skill (an unresolvable stableId is skipped and journaled), and never
 * invents a skill.
 *
 * Duplicate policy: requesting a skill that is ALREADY owned - either the exact
 * same skill, or another skill whose `upgradeGroup` collides - does not stack. The
 * collision is resolved by searching the group's current unarchived skills for the
 * NEXT authored rarity STRICTLY HIGHER than the strongest owned skill in the group
 * (ladder Inferior..Divine; `Unique` is incomparable and never strictly higher). If
 * such an authored skill exists it replaces the owned skill(s) (one-group invariant
 * preserved); otherwise the owned skill is retained and the request journals a
 * no-op. An unresolvable request is skipped, never crash a partial grant.
 *
 * Incomparable guard: if ANY owned same-group link carries an incomparable rarity
 * (`Unique`, or a missing/unrecognized value) then nothing authored can be
 * strictly higher than it, so the acquisition is a no-op - no owned link is
 * deleted and no replacement is written. This prevents an automatic per-grade
 * grant from silently deleting an incomparable `Unique` (or missing-rarity) skill
 * just because another same-group link happens to be comparable. Only when EVERY
 * owned same-group link has a comparable rarity is a replacement attempted, and
 * it is written only when strictly higher than all of them.
 */
function resolveGradeSkillGrants(
  existingSkills: OwnedSkillLink[],
  requests: GradeGrantRequest[],
  skillMap: Map<string, UnarchivedSkillDef>
): GradeGrantResolution {
  const empty = {
    granted: [],
    upgraded: [],
    noop: [],
    skipped: [],
    superseded: [],
  } as GradeGrantJournal
  if (requests.length === 0) {
    return { toCreate: [], toDeleteDefinitionIds: [], journal: empty }
  }

  // Working set of currently-owned skills (persisted + newly planned). Each entry
  // carries its provenance so the audit journal can tell a real persisted link from
  // an intermediate THIS transaction planned but never wrote.
  const owned: Array<
    OwnedSkillLink & {
      provenance: "persisted" | "planned"
      plannedGrade?: Grade
    }
  > = existingSkills.map((s) => ({ ...s, provenance: "persisted" }))
  const existingIds = new Set(existingSkills.map((s) => s.definitionId))
  const toCreate = new Map<
    string,
    { definitionId: string; stableId: string; grade: Grade }
  >()
  const newlyPlanned = new Set<string>()
  const toDeleteDefinitionIds = new Set<string>()
  const noop: GradeGrantJournal["noop"] = []
  const skipped: GradeGrantJournal["skipped"] = []
  // Every skill planned in this transaction (granted directly or chosen as an
  // upgrade replacement), keyed by stableId, carrying its ORIGINAL planned grade so
  // a later-superseded intermediate can be journaled truthfully under `superseded`.
  const plannedByStableId = new Map<
    string,
    { stableId: string; name: string; grade: Grade }
  >()
  const recordPlanned = (
    stableId: string,
    name: string,
    grade: Grade
  ): void => {
    if (!plannedByStableId.has(stableId)) {
      plannedByStableId.set(stableId, { stableId, name, grade })
    }
  }

  // Record a retained (no-op) acquisition with the reason it was not applied.
  const recordNoop = (
    stableId: string,
    name: string,
    grade: Grade,
    reason: string
  ): void => {
    noop.push({ stableId, name, grade, reason })
  }

  const removeOwned = (defId: string): void => {
    const idx = owned.findIndex((s) => s.definitionId === defId)
    if (idx >= 0) owned.splice(idx, 1)
    if (existingIds.has(defId)) {
      toDeleteDefinitionIds.add(defId)
    } else if (toCreate.has(defId)) {
      toCreate.delete(defId)
      newlyPlanned.delete(defId)
    }
  }

  for (const request of requests) {
    const def = skillMap.get(request.stableId)
    if (!def) {
      // Missing or archived: graceful skip, never a partial grant.
      skipped.push({ stableId: request.stableId, grade: request.grade })
      continue
    }
    const defGroup = configUpgradeGroup(def.config)

    // Collision: the exact skill is owned, or a nonempty upgradeGroup is shared.
    const colliding = owned.filter(
      (s) =>
        s.stableId === request.stableId ||
        (defGroup != null && configUpgradeGroup(s.config) === defGroup)
    )

    if (colliding.length === 0) {
      // No collision - link directly.
      toCreate.set(def.id, {
        definitionId: def.id,
        stableId: def.stableId,
        grade: request.grade,
      })
      newlyPlanned.add(def.id)
      owned.push({
        definitionId: def.id,
        stableId: def.stableId,
        name: def.name,
        config: def.config,
        provenance: "planned",
        plannedGrade: request.grade,
      })
      recordPlanned(def.stableId, def.name, request.grade)
      continue
    }

    // Collision -> duplicate policy.
    const group = defGroup ?? configUpgradeGroup(colliding[0].config)
    if (group == null) {
      // No upgrade group to search - retain the owned skill as a no-op.
      recordNoop(
        def.stableId,
        def.name,
        request.grade,
        "no upgrade group to search for a higher-rarity replacement"
      )
      continue
    }
    const inGroup = colliding.filter(
      (s) => configUpgradeGroup(s.config) === group
    )
    if (inGroup.length === 0) {
      recordNoop(
        def.stableId,
        def.name,
        request.grade,
        "no owned same-group skill to replace"
      )
      continue
    }

    // Incomparable guard: if ANY owned same-group link carries an incomparable
    // rarity (`Unique`, or a missing/unrecognized value), nothing authored can be
    // strictly higher than it, so this acquisition is a no-op - no owned link is
    // deleted and no replacement written. This prevents an automatic per-grade
    // grant from silently deleting an incomparable `Unique` (or missing-rarity)
    // skill just because another same-group link happens to be comparable.
    const incomparable = inGroup.find(
      (s) => rarityOrderIndex(configRarity(s.config)) == null
    )
    if (incomparable != null) {
      recordNoop(
        def.stableId,
        def.name,
        request.grade,
        `owned same-group skill "${incomparable.name}" carries an incomparable/missing rarity (cannot be strictly upgraded)`
      )
      continue
    }

    // Base rarity: the strongest (highest comparable) owned skill in the group, so
    // the chosen replacement is strictly higher than EVERY removed link.
    let baseIndex: number | null = null
    for (const s of inGroup) {
      const idx = rarityOrderIndex(configRarity(s.config))
      if (idx != null && (baseIndex == null || idx > baseIndex)) baseIndex = idx
    }
    if (baseIndex == null) {
      // Defensive: every owned skill in the group is incomparable (see guard
      // above); nothing can be strictly higher, so retain as a no-op.
      recordNoop(
        def.stableId,
        def.name,
        request.grade,
        "owned same-group skills carry incomparable/missing rarities"
      )
      continue
    }

    const candidates: UnarchivedSkillDef[] = []
    for (const candidate of skillMap.values()) {
      if (configUpgradeGroup(candidate.config) !== group) continue
      const idx = rarityOrderIndex(configRarity(candidate.config))
      if (idx == null || idx <= baseIndex) continue
      candidates.push(candidate)
    }
    // Smallest strictly-higher rarity, then stableId lexicographic tie-break.
    candidates.sort((a, b) => {
      const ai = rarityOrderIndex(configRarity(a.config))!
      const bi = rarityOrderIndex(configRarity(b.config))!
      if (ai !== bi) return ai - bi
      return a.stableId < b.stableId ? -1 : a.stableId > b.stableId ? 1 : 0
    })
    if (candidates.length === 0) {
      recordNoop(
        def.stableId,
        def.name,
        request.grade,
        `no authored rarity strictly higher than the strongest owned skill in upgrade group "${group}"`
      )
      continue
    }

    const chosen = candidates[0]
    const displaced = [...inGroup]
    for (const s of displaced) removeOwned(s.definitionId)
    toCreate.set(chosen.id, {
      definitionId: chosen.id,
      stableId: chosen.stableId,
      grade: request.grade,
    })
    newlyPlanned.add(chosen.id)
    owned.push({
      definitionId: chosen.id,
      stableId: chosen.stableId,
      name: chosen.name,
      config: chosen.config,
      provenance: "planned",
      plannedGrade: request.grade,
    })
    recordPlanned(chosen.stableId, chosen.name, request.grade)
  }

  // Derive the truthful journal from the FINAL plan and the provenance ledger. The
  // incremental snapshots that would have been recorded during the loop claim links
  // the acquisition never persisted (e.g. a chain race Common A -> class Uncommon B
  // -> profession Rare C leaves only C, with A and B never written). So we rebuild
  // the story instead:
  //   - a final link with no displaced PERSISTED same-group source is `granted`;
  //   - a final link that displaced a real persisted same-group link is `upgraded`
  //     from the STRONGEST such persisted source (never from a phantom
  //     intermediate planned in this transaction);
  //   - every intermediate this transaction planned but never wrote is
  //     `superseded` with its ORIGINAL planned grade.
  const finalStableIds = new Set<string>()
  for (const c of toCreate.values()) finalStableIds.add(c.stableId)

  // Removed persisted same-group links, grouped by upgrade group - the only
  // legitimate `upgraded` source (a link that actually existed before this
  // transaction and was replaced by a final plan).
  const removedPersistedByGroup = new Map<string, OwnedSkillLink[]>()
  for (const defId of toDeleteDefinitionIds) {
    const existing = existingSkills.find((s) => s.definitionId === defId)
    if (!existing) continue
    const group = configUpgradeGroup(existing.config)
    if (group == null) continue
    const arr = removedPersistedByGroup.get(group) ?? []
    arr.push(existing)
    removedPersistedByGroup.set(group, arr)
  }

  const granted: GradeGrantJournal["granted"] = []
  const upgraded: GradeGrantJournal["upgraded"] = []
  for (const c of toCreate.values()) {
    const def = skillMap.get(c.stableId)
    const name = def?.name ?? c.stableId
    const group = def ? configUpgradeGroup(def.config) : undefined
    const removed =
      group != null ? removedPersistedByGroup.get(group) : undefined
    if (removed != null && removed.length > 0) {
      // A real persisted same-group link was displaced; report the actual
      // pre/post transition from the STRONGEST such source to the final link.
      const strongest = removed.reduce(
        (acc, s) => {
          const idx = rarityOrderIndex(configRarity(s.config))
          if (idx != null && (acc.idx == null || idx > acc.idx)) {
            return { idx, s }
          }
          return acc
        },
        { idx: null as number | null, s: removed[0] }
      )
      upgraded.push({
        fromStableId: strongest.s.stableId,
        fromName: strongest.s.name,
        toStableId: c.stableId,
        toName: name,
        grade: c.grade,
      })
    } else {
      granted.push({ stableId: c.stableId, name, grade: c.grade })
    }
  }

  const superseded: GradeGrantJournal["superseded"] = []
  for (const [stableId, plan] of plannedByStableId) {
    if (finalStableIds.has(stableId)) continue
    superseded.push({ stableId, name: plan.name, grade: plan.grade })
  }

  const resolution: GradeGrantResolution = {
    toCreate: [...toCreate.values()],
    toDeleteDefinitionIds: [...toDeleteDefinitionIds],
    journal: { granted, upgraded, noop, skipped, superseded },
  }
  reconcileGradeSkillGrantJournal(resolution)
  return resolution
}

/**
 * Reconcile a grade-grant journal against the FINAL association plan that is
 * actually persisted, so the journal never claims a skill is still linked when a
 * later grant in the same acquisition superseded (replaced) it.
 *
 * A newly-planned link that a later grant upgraded away never left the database.
 * It must not appear under `granted` (which would claim it is a live link), and
 * it should be recorded under `superseded` (with its originating grade) so the
 * audit trail explains how a planned grant was replaced by a later upgrade. This
 * matters for a single acquisition that carries MULTIPLE track grants in one
 * transaction (e.g. race + class, or class + profession), where an intermediate
 * planned grant is replaced by a later upgrade in the same resolution.
 *
 * Unrelated `granted`/`upgraded` links, and any no-op/skip, are untouched. The
 * function is idempotent: running it again on an already-reconciled journal is a
 * no-op.
 */
function reconcileGradeSkillGrantJournal(
  resolution: GradeGrantResolution
): void {
  const journal = resolution.journal
  const finalStableIds = new Set(resolution.toCreate.map((c) => c.stableId))
  const superseded: GradeGrantJournal["superseded"] = [
    ...(journal.superseded ?? []),
  ]
  const seen = new Set(superseded.map((s) => s.stableId))
  const recordSuperseded = (entry: {
    stableId: string
    name: string
    grade: Grade
  }): void => {
    if (!finalStableIds.has(entry.stableId) && !seen.has(entry.stableId)) {
      seen.add(entry.stableId)
      superseded.push(entry)
    }
  }

  // A `granted` entry whose stableId no longer appears in the final plan was
  // superseded; drop it from `granted` and record it under `superseded`.
  const keptGranted: GradeGrantJournal["granted"] = []
  for (const g of journal.granted) {
    if (finalStableIds.has(g.stableId)) keptGranted.push(g)
    else recordSuperseded(g)
  }
  journal.granted = keptGranted

  // An upgrade whose `toStableId` no longer appears in the final plan was itself
  // superseded by a later upgrade; it is not a live link. Its source (if not
  // already recorded and not persisted) is tracked as superseded.
  const keptUpgraded: GradeGrantJournal["upgraded"] = []
  for (const u of journal.upgraded) {
    if (finalStableIds.has(u.toStableId)) {
      keptUpgraded.push(u)
    } else if (!finalStableIds.has(u.fromStableId)) {
      recordSuperseded({
        stableId: u.fromStableId,
        name: u.fromName,
        grade: u.grade,
      })
    }
  }
  journal.upgraded = keptUpgraded

  journal.superseded = superseded
}

/**
 * Persist a resolved grade-grant set for a character: remove every superseded
 * SKILL link, then create every resulting link (kind SKILL). Idempotent against
 * a definitionId that was never actually persisted (e.g. a newly-planned skill
 * superseded before the write landed), and safe to run inside the same
 * transaction as the owning mutation.
 *
 * Before writing, it reconciles the granted/upgraded journal snapshots against the
 * FINAL association plan, so a grant that was planned then superseded by a later
 * upgrade in the same acquisition is never reported as a live link. The journal
 * and the persisted links stay consistent: only actually-persisted skills appear
 * under `granted`/`upgraded`, and a superseded intermediate grant is recorded
 * under `superseded` (with its originating grade) rather than omitted.
 */
async function persistGradeSkillGrants(
  tx: DbClient,
  characterId: string,
  resolution: GradeGrantResolution
): Promise<void> {
  reconcileGradeSkillGrantJournal(resolution)
  for (const defId of resolution.toDeleteDefinitionIds) {
    await tx.characterAssociation.deleteMany({
      where: { characterId, definitionId: defId },
    })
  }
  for (const c of resolution.toCreate) {
    await tx.characterAssociation.create({
      data: {
        characterId,
        definitionId: c.definitionId,
        kind: "SKILL" as never,
      },
    })
  }
}

type SkillSelectInput = {
  operation: "select"
  offerId: string
  definitionId: string
  version: number
}

type SkillGrantInput = {
  operation: "grant"
  definitionId: string
  version: number
  reason: string
}

type SkillActionInput = SkillSelectInput | SkillGrantInput

/**
 * Answer a skill offer (`select`) or grant a skill manually (`grant`).
 *
 * SELECT: the owner or an admin picks one own pending offer option. The option
 * must belong to the offer, its definition must be unarchived, the skill must not
 * already be acquired, and the offer must still be pending (a repeat selection or
 * a selection on an already-answered offer is rejected). Selecting links the skill
 * as a CharacterAssociation (kind SKILL), removes any linked skill in the same
 * upgrade group (never stack), stamps the offer `selected*`, and appends an
 * immutable `skill_select` event - all atomically under the character's CAS
 * version.
 *
 * GRANT: admin-only. Requires a nonempty reason; the definition must be an
 * unarchived `skills` entry. It records provenance "manual" in the event, and
 * applies the same upgrade-group replacement as a select.
 */
/**
 * Acquire a Postgres row lock (`FOR UPDATE`) on the given skill-offer rows,
 * in ascending id order, BEFORE reading/validating them. Both the selection
 * (`skillCharacter`) and the pending-refresh (`refreshPendingSkillOffers`)
 * transactions take this lock so a refresh can never append options to an
 * offer that is concurrently selected, and a selection can never run while a
 * refresh is mid-append to the same offer. Locking in sorted id order avoids a
 * deadlock between concurrent refreshes that touch overlapping offer sets.
 *
 * The lock is held until the caller's transaction commits/rolls back. A
 * stale-concurrency snapshot (the row was committed by a concurrent
 * transaction after this transaction began) surfaces as a P2034 serialization
 * failure, which the caller maps to a retryable 409.
 */
async function lockSkillOfferRows(db: DbClient, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const sorted = [...ids].sort()
  await db.$queryRaw`
    SELECT id FROM skill_offers
    WHERE id IN (${Prisma.join(sorted)})
    ORDER BY id
    FOR UPDATE`
}

export async function skillCharacter(
  id: string,
  input: SkillActionInput,
  user: SessionUser
): Promise<{ character: CharacterDetail }> {
  return prisma.$transaction(async (tx) => {
    const row = await assertOwner(tx, id, user)
    const houseRules = await loadHouseRules(tx)

    if (input.operation === "select") {
      // Lock the offer row BEFORE reading/validating it so a concurrent
      // refresh cannot append options to this offer in the middle of the
      // selection. The lock is held until this transaction commits, so a
      // refresh that targets the same offer blocks behind it.
      await lockSkillOfferRows(tx, [input.offerId])
      const offer = await tx.skillOffer.findUnique({
        where: { id: input.offerId },
        include: { options: { include: { definition: true } } },
      })
      if (!offer || offer.characterId !== id) {
        throw notFound("offer_not_found", "Skill offer not found")
      }
      // A canceled offer is no longer selectable: it stays visible as a historical
      // record, but answering it is a 409 `offer_canceled` (the offer was voided,
      // e.g. by an EXP undo that canceled the offer pending a re-offer).
      if (offer.canceledAt != null) {
        throw conflict("offer_canceled", "This skill offer has been canceled")
      }
      // Repeat selection / already-answered offer.
      if (offer.selectedDefinitionId != null) {
        throw badRequest(
          "offer_already_selected",
          "This skill offer has already been answered"
        )
      }
      const option = offer.options.find(
        (o) => o.definitionId === input.definitionId
      )
      if (!option) {
        throw badRequest(
          "option_not_found",
          "Selected skill is not one of this offer's options"
        )
      }
      const def = option.definition
      if (def.archived) {
        throw badRequest(
          "catalog_archived",
          `Offered skill "${def.name}" is archived; re-enable it in the catalog to select it`
        )
      }
      if (
        row.associations.some(
          (a) => a.definitionId === def.id && a.kind === "SKILL"
        )
      ) {
        throw badRequest("duplicate", `Skill "${def.name}" is already acquired`)
      }

      const defConfig = parseCatalogConfig(def.kind, def.config ?? {})
      const upgradeGroup =
        typeof defConfig.upgradeGroup === "string" &&
        defConfig.upgradeGroup.length > 0
          ? defConfig.upgradeGroup
          : undefined
      const defRarity =
        typeof defConfig.rarity === "string" && defConfig.rarity.length > 0
          ? defConfig.rarity
          : undefined
      const removedLinks =
        upgradeGroup != null
          ? sameUpgradeGroupSkillLinks(row.associations, def.id, upgradeGroup)
          : []
      // Monotonic-rarity guard: only enforced when the action would actually
      // remove a linked skill in the same upgrade group. Reject (400) BEFORE any
      // write so a lower/equal/incomparable replacement never lands.
      if (removedLinks.length > 0) {
        assertSkillRarityMonotonic(
          { definitionId: def.id, name: def.name, rarity: defRarity },
          removedLinks
        )
      }
      const removed =
        upgradeGroup != null
          ? await removeSameUpgradeGroupSkills(
              tx,
              id,
              row.associations,
              def.id,
              upgradeGroup
            )
          : []

      await tx.characterAssociation.create({
        data: {
          characterId: id,
          definitionId: def.id,
          kind: "SKILL" as never,
        },
      })
      await tx.skillOffer.update({
        where: { id: offer.id },
        data: { selectedDefinitionId: def.id, selectedAt: new Date() },
      })

      const updatedMany = await tx.character.updateMany({
        where: { id, version: input.version },
        data: { version: { increment: 1 } },
      })
      if (updatedMany.count !== 1) {
        throw conflict(
          "version_conflict",
          `Version mismatch: expected ${input.version}, got a newer version`
        )
      }

      await tx.progressionEvent.create({
        data: {
          characterId: id,
          kind: "skill_select",
          payload: {
            operation: "select",
            offerId: offer.id,
            definitionId: def.id,
            track: offer.track,
            level: offer.level,
            choiceGroup: offer.choiceGroup,
            definition: {
              id: def.id,
              name: def.name,
              stableId: def.stableId,
              grade: def.grade,
              provenance: "catalog",
              upgradeGroup: upgradeGroup ?? null,
            },
            selectedAt: new Date().toISOString(),
            removed,
          } as unknown as Prisma.InputJsonValue,
        },
      })

      const updated = (await tx.character.findUnique({
        where: { id },
        include: characterInclude,
      }))!
      return { character: await detailFor(updated, houseRules, tx) }
    }

    // GRANT (admin only)
    if (!user.isAdmin) {
      throw forbidden("forbidden", "Only an admin can grant a skill")
    }
    const reason = input.reason.trim()
    if (!reason) {
      throw badRequest(
        "reason_required",
        "A reason is required to grant a skill"
      )
    }
    const def = await tx.catalogDefinition.findUnique({
      where: { id: input.definitionId },
    })
    if (!def) {
      throw notFound("catalog_not_found", "Catalog entry not found")
    }
    if (def.kind !== "skills") {
      throw badRequest(
        "wrong_kind",
        `Catalog entry has wrong kind (expected "skills")`
      )
    }
    if (def.archived) {
      throw badRequest(
        "catalog_archived",
        "Catalog entry is archived and cannot be granted"
      )
    }
    if (
      row.associations.some(
        (a) => a.definitionId === def.id && a.kind === "SKILL"
      )
    ) {
      throw badRequest("duplicate", `Skill "${def.name}" is already acquired`)
    }

    const defConfig = parseCatalogConfig(def.kind, def.config ?? {})
    const upgradeGroup =
      typeof defConfig.upgradeGroup === "string" &&
      defConfig.upgradeGroup.length > 0
        ? defConfig.upgradeGroup
        : undefined
    const defRarity =
      typeof defConfig.rarity === "string" && defConfig.rarity.length > 0
        ? defConfig.rarity
        : undefined
    const removedLinks =
      upgradeGroup != null
        ? sameUpgradeGroupSkillLinks(row.associations, def.id, upgradeGroup)
        : []
    // Monotonic-rarity guard: only enforced when the action would actually
    // remove a linked skill in the same upgrade group. Reject (400) BEFORE any
    // write so a lower/equal/incomparable replacement never lands.
    if (removedLinks.length > 0) {
      assertSkillRarityMonotonic(
        { definitionId: def.id, name: def.name, rarity: defRarity },
        removedLinks
      )
    }
    const removed =
      upgradeGroup != null
        ? await removeSameUpgradeGroupSkills(
            tx,
            id,
            row.associations,
            def.id,
            upgradeGroup
          )
        : []

    await tx.characterAssociation.create({
      data: {
        characterId: id,
        definitionId: def.id,
        kind: "SKILL" as never,
      },
    })

    const updatedMany = await tx.character.updateMany({
      where: { id, version: input.version },
      data: { version: { increment: 1 } },
    })
    if (updatedMany.count !== 1) {
      throw conflict(
        "version_conflict",
        `Version mismatch: expected ${input.version}, got a newer version`
      )
    }

    await tx.progressionEvent.create({
      data: {
        characterId: id,
        kind: "skill_grant",
        payload: {
          operation: "grant",
          definitionId: def.id,
          reason,
          provenance: "manual",
          definition: {
            id: def.id,
            name: def.name,
            stableId: def.stableId,
            grade: def.grade,
            provenance: "catalog",
            upgradeGroup: upgradeGroup ?? null,
          },
          grantedAt: new Date().toISOString(),
          removed,
        } as unknown as Prisma.InputJsonValue,
      },
    })

    const updated = (await tx.character.findUnique({
      where: { id },
      include: characterInclude,
    }))!
    return { character: await detailFor(updated, houseRules, tx) }
  })
}

/**
 * Refresh the pending SCHEDULED skill offers for a character, appending any newly
 * authored unarchived skills that are now eligible for each pending scheduled
 * credit - WITHOUT rewriting history.
 *
 * A pending scheduled offer is one with schedule-credit provenance (`earnedGrade`
 * and `trackDefinitionStableId` both set) that is still active (not selected, not
 * canceled). For each such offer the service queries the unarchived `skills`
 * catalog and appends ONLY genuinely new eligible options via `createMany` with
 * `skipDuplicates` (the DB unique `(offerId, definitionId)` is the last line of
 * defense). Eligibility uses the exact same rules as the original credit
 * (`skillDefMatchesScheduledOffer`): the config `track` is exact - a skill carries
 * no catalog grade band, so a skill is matched by track only, regardless of the
 * earned grade (a legacy skill row that still holds a `grade` is still matched).
 * The `milestone`, `choiceGroup` and `eligibleDefinitionStableIds` are legacy
 * annotations that no longer gate a scheduled credit. Existing option snapshots
 * are never modified - even if the skill has since been archived or edited - and
 * archived skills never appear.
 *
 * Legacy offers lacking provenance are untouched. The character CAS version and
 * the journal are NOT bumped (this only appends snapshot rows); the reloaded
 * detail is returned. Under SERIALIZABLE isolation a concurrent selection that
 * commits between this read and write aborts this transaction (P2034), which is
 * surfaced as a retryable 409 - the client retry is idempotent and, on retry, the
 * now-selected offer is filtered out, so options are never appended after a
 * selection.
 */
export async function refreshPendingSkillOffers(
  id: string,
  user: SessionUser
): Promise<{ character: CharacterDetail }> {
  return prisma
    .$transaction(
      async (tx) => {
        // assertOwner enforces owner/admin + existence; the returned row is not
        // needed here (the detail is re-read after the appends).
        await assertOwner(tx, id, user)
        const houseRules = await loadHouseRules(tx)

        // Only pending SCHEDULED offers: provenance set, not selected, not canceled.
        const pendingFilter = {
          characterId: id,
          earnedGrade: { not: null },
          trackDefinitionStableId: { not: null },
          selectedDefinitionId: null,
          selectedAt: null,
          canceledAt: null,
        }

        // First identify the candidate offer ids, then lock them (in sorted id
        // order) BEFORE reading/validating them, so a concurrent selection that
        // commits while this refresh is in flight cannot have options appended to
        // its offer after the selection. The lock is held through the append.
        const candidateIds = await tx.skillOffer.findMany({
          where: pendingFilter,
          select: { id: true },
        })
        await lockSkillOfferRows(
          tx,
          candidateIds.map((c) => c.id)
        )

        // Re-read the pending offers after locking. If a selection committed while
        // this refresh was acquiring the lock, the offer is now excluded from this
        // filter (a fresh snapshot) or, in a stale SERIALIZABLE snapshot, the
        // locked row surfaces as a P2034 serialization failure handled below - so
        // an already-selected offer is never appended to.
        const pendingOffers = await tx.skillOffer.findMany({
          where: pendingFilter,
          include: { options: true },
        })

        if (pendingOffers.length === 0) {
          const updated = (await tx.character.findUnique({
            where: { id },
            include: characterInclude,
          }))!
          return { character: await detailFor(updated, houseRules, tx) }
        }

        // Load the unarchived skills catalog ONCE for the whole refresh, so a skill
        // authored after the original credit is eligible on the next refresh.
        const skillDefs = await tx.catalogDefinition.findMany({
          where: { kind: "skills", archived: false },
        })

        for (const offer of pendingOffers) {
          // A scheduled offer always carries both provenance columns (filtered
          // above); guard the narrow only defensively.
          if (
            offer.earnedGrade == null ||
            offer.trackDefinitionStableId == null
          )
            continue
          const existing = new Set(offer.options.map((o) => o.definitionId))
          const newOptions: Array<{
            definitionId: string
            nameSnapshot: string
            configSnapshot: Prisma.InputJsonValue
          }> = []
          for (const def of skillDefs) {
            if (existing.has(def.id)) continue
            if (
              !skillDefMatchesScheduledOffer(
                { config: def.config },
                { track: offer.track }
              )
            ) {
              continue
            }
            newOptions.push({
              definitionId: def.id,
              nameSnapshot: def.name,
              configSnapshot: (def.config ?? {}) as Prisma.InputJsonValue,
            })
          }
          if (newOptions.length === 0) continue
          await tx.skillOfferOption.createMany({
            data: newOptions.map((o) => ({ ...o, offerId: offer.id })),
            skipDuplicates: true,
          })
        }

        const updated = (await tx.character.findUnique({
          where: { id },
          include: characterInclude,
        }))!
        return { character: await detailFor(updated, houseRules, tx) }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )
    .catch((err) => {
      // A concurrent write (e.g. a selection that committed after our offer read)
      // that cannot serialize surfaces as P2034; map it to a retryable 409 rather
      // than a raw 500. The transaction has already rolled back, so no stray option
      // rows are left behind.
      if (isSerializationFailure(err)) {
        throw conflict(
          "serialization_conflict",
          "Concurrent character write conflict; retry the skill refresh"
        )
      }
      throw err
    })
}

type SkillUpgradeInput = {
  /** Optional exact source skill link to upgrade from (explicit path). */
  sourceDefinitionId?: string
  definitionId: string
  version: number
  reason: string
}

/**
 * Upgrade a character's linked skill.
 *
 * The owner or an admin supplies the id of an ACTIVE (unarchived) `skills` entry
 * (`definitionId`) plus a mandatory reason and a CAS `version`. There are two
 * supported flows:
 *
 * 1. EXPLICIT EDGE (the caller also supplies `sourceDefinitionId`). The exact
 *    source must be a linked SKILL association on the character. When that
 *    source's config declares its OWN `upgradeToStableIds` field (including `[]`),
 *    the target's stableId MUST be directly listed there: the upgrade follows the
 *    declared DIRECT edge, with NO rarity / upgrade-group / track / level gate
 *    (a same-rarity, lower-rarity, `Unique`, cross-group or cross-track target is
 *    allowed). `[]` means the source is explicitly terminal, so any target is
 *    rejected. When the named source is legacy (no own `upgradeToStableIds`), it
 *    is allowed only under the legacy same-`upgradeGroup` + strictly higher
 *    ordered rarity fallback. Only the CHOSEN source link is removed; a nonempty
 *    target upgrade group that would collide with ANY OTHER still-linked skill is
 *    rejected (`link_collision`) rather than deleting that skill. The source may
 *    be an ARCHIVED catalog entry - its config is still read.
 *
 * 2. LEGACY TARGET-ONLY (`sourceDefinitionId` omitted). The current unambiguous
 *    same-group target-only flow is retained, but ONLY when every eligible linked
 *    source is legacy (no own `upgradeToStableIds`); an explicit-edge source must
 *    be named by the caller rather than silently removed / its list bypassed
 *    (400 `skill_source_required`). The target must carry a valid ordered rarity
 *    and a nonempty `upgradeGroup`, and the character must hold EXACTLY ONE other
 *    linked skill in that group with a strictly LOWER ordered rarity; that link
 *    is replaced (never stacked). Rejections are 400 `skill_rarity_not_higher`.
 *
 * Both flows run under SERIALIZABLE isolation with the same CAS version increment
 * as select/grant; there is no XP cost. The immutable `skill_upgrade` event
 * snapshots the from/to stable ids, names, rarities, descriptions, the reason,
 * the removed-link record, and a nullable upgrade group.
 */
export async function upgradeSkill(
  id: string,
  input: SkillUpgradeInput,
  user: SessionUser
): Promise<{ character: CharacterDetail }> {
  return prisma
    .$transaction(
      async (tx) => {
        const row = await assertOwner(tx, id, user)
        const houseRules = await loadHouseRules(tx)

        const def = await tx.catalogDefinition.findUnique({
          where: { id: input.definitionId },
        })
        if (!def) {
          throw notFound("catalog_not_found", "Catalog entry not found")
        }
        if (def.kind !== "skills") {
          throw badRequest(
            "wrong_kind",
            `Catalog entry has wrong kind (expected "skills")`
          )
        }
        if (def.archived) {
          throw badRequest(
            "catalog_archived",
            `Skill "${def.name}" is archived; re-enable it in the catalog to upgrade to it`
          )
        }
        const defConfig = parseCatalogConfig("skills", def.config ?? {})
        const targetGroup = upgradeGroupForConfig(defConfig)
        const targetRarity = skillRarityOf({
          kind: "skills",
          config: def.config ?? {},
        })
        if (
          row.associations.some(
            (a) => a.definitionId === def.id && a.kind === "SKILL"
          )
        ) {
          throw badRequest(
            "duplicate",
            `Skill "${def.name}" is already acquired`
          )
        }

        // Resolve the exact source link. Null when the caller omits it and the
        // legacy target-only flow applies.
        const sourceLink =
          input.sourceDefinitionId != null
            ? (row.associations.find(
                (a) =>
                  a.kind === "SKILL" &&
                  a.definitionId === input.sourceDefinitionId
              ) ?? null)
            : null
        if (input.sourceDefinitionId != null && sourceLink == null) {
          throw badRequest(
            "skill_source_not_linked",
            `Skill source "${input.sourceDefinitionId}" is not a linked skill on this character`
          )
        }

        // Captured for the immutable journal: the removed link snapshot + the
        // removal set.
        let removedDefinitionId: string
        let removedStableId: string
        let removedName: string
        let removedDescription: string | null
        let removedRarity: string | undefined
        let removed: Array<{ definitionId: string; name: string }>

        if (sourceLink != null) {
          // ---- Explicit source path ----
          const sourceDef = sourceLink.definition
          if (!sourceDef) {
            throw badRequest(
              "skill_source_not_linked",
              `Skill source "${input.sourceDefinitionId}" has no catalog definition`
            )
          }
          removedDefinitionId = sourceDef.id
          removedStableId = sourceDef.stableId
          removedName = sourceDef.name
          removedDescription = sourceDef.description
          removedRarity = skillRarityOf(sourceDef)

          const sourceTargets = skillUpgradeTargets(sourceDef.config ?? {})
          if (sourceTargets === undefined) {
            // Legacy source: only the same-group strictly-higher-rarity fallback.
            const sourceGroup = skillUpgradeGroup(sourceDef)
            if (
              sourceGroup == null ||
              targetGroup == null ||
              sourceGroup !== targetGroup
            ) {
              throw badRequest(
                "skill_rarity_not_higher",
                `Skill "${def.name}" cannot upgrade "${sourceDef.name}": they are not in the same upgrade group`
              )
            }
            assertSkillRarityMonotonic(
              { definitionId: def.id, name: def.name, rarity: targetRarity },
              [
                {
                  definitionId: sourceDef.id,
                  name: sourceDef.name,
                  rarity: removedRarity,
                },
              ]
            )
          } else {
            // Explicit-edge source: the target stableId MUST be directly listed.
            if (!sourceTargets.includes(def.stableId)) {
              throw badRequest(
                "skill_upgrade_edge_missing",
                `Skill "${def.name}" is not a declared upgrade target of "${sourceDef.name}"`
              )
            }
          }

          // A declared edge may cross groups, so a nonempty target upgrade group
          // must not collide with ANY OTHER still-linked skill (reject, never
          // delete that skill). Archived definitions are inert and skipped.
          if (targetGroup != null) {
            for (const link of row.associations) {
              if (link.kind !== "SKILL") continue
              if (link.definitionId === def.id) continue
              if (link.definitionId === sourceLink.definitionId) continue
              const otherDef = link.definition
              if (!otherDef || otherDef.archived) continue
              if (skillUpgradeGroup(otherDef) === targetGroup) {
                throw conflict(
                  "link_collision",
                  `Skill "${def.name}" shares upgrade group "${targetGroup}" with the still-linked skill "${otherDef.name}"`
                )
              }
            }
          }

          // Remove ONLY the chosen source link.
          await tx.characterAssociation.deleteMany({
            where: { characterId: id, definitionId: sourceLink.definitionId },
          })
          removed = [{ definitionId: sourceDef.id, name: sourceDef.name }]
        } else {
          // ---- Legacy target-only flow (source omitted) ----
          if (targetGroup == null) {
            throw badRequest(
              "skill_rarity_not_higher",
              `Skill "${def.name}" has no "upgradeGroup", so it cannot upgrade a linked skill`
            )
          }
          if (targetRarity == null) {
            throw badRequest(
              "skill_rarity_not_higher",
              `Skill "${def.name}" has no ordered "rarity" (missing or incomparable "Unique"), so it cannot upgrade a linked skill`
            )
          }

          // The same-group source links (excluding the target). Exactly one is
          // required; an archived source is allowed and its config still read.
          const sources = row.associations.filter(
            (a) =>
              a.kind === "SKILL" &&
              a.definitionId !== def.id &&
              skillUpgradeGroup(a.definition) === targetGroup
          )
          if (sources.length === 0) {
            throw badRequest(
              "skill_rarity_not_higher",
              `Skill "${def.name}" cannot upgrade: no linked skill in upgrade group "${targetGroup}" to replace`
            )
          }
          if (sources.length > 1) {
            throw badRequest(
              "skill_rarity_not_higher",
              `Skill "${def.name}" cannot upgrade: more than one linked skill in upgrade group "${targetGroup}" (ambiguous)`
            )
          }

          // Retain the same-group target-only flow only when the single linked
          // source is legacy (no own upgradeToStableIds). An explicit-edge source
          // must be named by the caller so its edge list is not bypassed.
          const source = sources[0]
          const sourceDef = source.definition
          const sourceRarity = skillRarityOf(sourceDef)
          if (skillUpgradeTargets(sourceDef.config ?? {}) !== undefined) {
            throw badRequest(
              "skill_source_required",
              `Skill "${def.name}" cannot pick a source automatically: "${sourceDef.name}" declares an explicit upgrade edge, so pass "sourceDefinitionId"`
            )
          }
          // Strictly higher ordered rarity than the single source link.
          assertSkillRarityMonotonic(
            {
              definitionId: def.id,
              name: def.name,
              rarity: targetRarity,
            },
            [
              {
                definitionId: source.definitionId,
                name: sourceDef.name,
                rarity: sourceRarity,
              },
            ]
          )

          removedDefinitionId = sourceDef.id
          removedStableId = sourceDef.stableId
          removedName = sourceDef.name
          removedDescription = sourceDef.description
          removedRarity = sourceRarity
          removed = await removeSameUpgradeGroupSkills(
            tx,
            id,
            row.associations,
            def.id,
            targetGroup
          )
        }

        await tx.characterAssociation.create({
          data: {
            characterId: id,
            definitionId: def.id,
            kind: "SKILL" as never,
          },
        })

        const updatedMany = await tx.character.updateMany({
          where: { id, version: input.version },
          data: { version: { increment: 1 } },
        })
        if (updatedMany.count !== 1) {
          throw conflict(
            "version_conflict",
            `Version mismatch: expected ${input.version}, got a newer version`
          )
        }

        await tx.progressionEvent.create({
          data: {
            characterId: id,
            kind: "skill_upgrade",
            payload: {
              operation: "upgrade",
              definitionId: def.id,
              reason: input.reason,
              from: {
                definitionId: removedDefinitionId,
                stableId: removedStableId,
                name: removedName,
                rarity: removedRarity ?? null,
                description: removedDescription,
              },
              to: {
                definitionId: def.id,
                stableId: def.stableId,
                name: def.name,
                rarity: targetRarity ?? null,
                description: def.description,
              },
              upgradeGroup: targetGroup ?? null,
              removed,
              upgradedAt: new Date().toISOString(),
            } as unknown as Prisma.InputJsonValue,
          },
        })

        const updated = (await tx.character.findUnique({
          where: { id },
          include: characterInclude,
        }))!
        return { character: await detailFor(updated, houseRules, tx) }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )
    .catch((err) => {
      // A concurrent character write that cannot serialize surfaces as P2034;
      // map it to a retryable 409 rather than a raw 500. The SERIALIZABLE
      // transaction has already rolled back, so no stray event, replaced link or
      // CAS version bump is left behind.
      if (isSerializationFailure(err)) {
        throw conflict(
          "serialization_conflict",
          "Concurrent character write conflict; retry the skill upgrade"
        )
      }
      throw err
    })
}

export async function allocateCharacter(
  id: string,
  body: { allocation: Partial<Record<string, number>>; version: number },
  user: SessionUser
): Promise<{ character: CharacterDetail; status: StatusResult }> {
  return prisma.$transaction(async (tx) => {
    const row = await assertOwner(tx, id, user)
    const houseRules = await loadHouseRules(tx)
    const state = deserializeState(row.state)
    const config = configFor(row, houseRules.config)
    const nextState = applyAllocate(state, body.allocation)
    const serialized = serializeState(nextState)
    const updatedMany = await tx.character.updateMany({
      where: { id, version: body.version },
      data: {
        state: serialized as Prisma.InputJsonValue,
        version: { increment: 1 },
      },
    })
    if (updatedMany.count !== 1) {
      throw conflict(
        "version_conflict",
        `Version mismatch: expected ${body.version}, got a newer version`
      )
    }
    await tx.progressionEvent.create({
      data: {
        characterId: id,
        kind: "allocate",
        payload: { allocation: body.allocation } as Prisma.InputJsonValue,
      },
    })
    const updated = (await tx.character.findUnique({
      where: { id },
      include: characterInclude,
    }))!
    return {
      character: await toDetail(updated, true, config, houseRules.version, tx),
      status: await statusFor(updated, config, tx),
    }
  })
}

export type EvolveCharacterInput = {
  /**
   * Every evolution choice now requires an explicit track. There is no legacy
   * grade-only path (the grade-only house fallback is retired), so the client
   * must always name the track and the destination definition it wants.
   */
  track: "race" | "class" | "profession"
  optionId: string
  version: number
  reason?: string
}

export interface EvolutionOptionView {
  /** The DESTINATION catalog definition id (a races/classes/professions row). */
  id: string
  name: string
  description: string | null
  fromGrade: Grade
  toGrade: Grade
  /** Destination display name (race, class, or profession name). */
  toTrackName: string
  /** The track this evolution option targets. */
  track: "race" | "class" | "profession"
  sourceUrl: string | null
  /**
   * Whether all mechanical (hard) requirements are met. Only the engine-level
   * grade-band / grade-gate blockers apply; there is no path/title/manual gate.
   */
  eligible: boolean
  /** Human-readable unmet mechanical requirements (empty when eligible). */
  blockers: string[]
}

export interface EvolutionOptionsResult {
  options: EvolutionOptionView[]
  /**
   * Always false: race/class/profession evolution is no longer gated by catalog
   * paths, so there is never a legacy grade-only fallback to offer.
   */
  legacyAvailable: false
}

/**
 * Resolve a race catalog row's authoritative advancement type from its config. A
 * legacy config without `raceType` is interpreted as `enlightened` (the same
 * non-authoritative default the rest of the service uses). Used to enforce that a
 * race evolution never crosses raceType.
 */
function raceTypeForRow(row: { config?: unknown }): RaceType {
  const parsed = parseCatalogConfig("races", row.config ?? {})
  return (parsed.raceType as RaceType | undefined) ?? "enlightened"
}

/**
 * Engine-level grade-band / grade-gate blockers for a class/profession evolution,
 * mirroring exactly what the pure `evolveTrackGrade` rejects (a missing band, a
 * track level below the target band's entry level or above its max, and a closed
 * grade gate). GET must agree with POST, so the choice list surfaces these reasons
 * up front rather than reporting a falsely-eligible option that the POST would
 * then reject. The destination definition/grade gating is handled separately by
 * the candidate query.
 */
function trackGradeBandBlockers(
  track: "class" | "profession",
  targetGrade: Grade,
  trackLevel: number,
  config: RulesConfig
): string[] {
  const blockers: string[] = []
  if (config.gradeGates[targetGrade] === false) {
    blockers.push(`grade gate closed for ${targetGrade}`)
  }
  const band = bandForGrade(targetGrade, config.gradeTable)
  if (!band) {
    blockers.push(`no grade band defined for ${targetGrade}`)
  } else if (trackLevel < band.entryLevel || trackLevel > band.max) {
    blockers.push(
      `${track} level ${trackLevel} does not qualify for ${targetGrade} (needs ${band.entryLevel}-${band.max})`
    )
  }
  return blockers
}

/**
 * Engine-level grade-band / grade-gate blockers for a race evolution, mirroring
 * exactly what the pure `evolveGrade` rejects (a missing band, a race level below
 * the target band's entry level or above its max, and a closed grade gate). GET
 * must agree with POST, so the race choice list surfaces these reasons up front
 * rather than reporting a falsely-eligible option that the POST would then
 * reject. `raceLevel` is the value `evolveGrade` itself resolves for the level
 * check (the derived race level in derived mode, the stored level otherwise), so
 * the two sides cannot drift. The destination race/grade gating is handled
 * separately by the candidate query.
 */
export function raceGradeBandBlockers(
  targetGrade: Grade,
  raceLevel: number,
  config: RulesConfig
): string[] {
  const blockers: string[] = []
  if (config.gradeGates[targetGrade] === false) {
    blockers.push(`grade gate closed for ${targetGrade}`)
  }
  const band = bandForGrade(targetGrade, config.gradeTable)
  if (!band) {
    blockers.push(`no grade band defined for ${targetGrade}`)
  } else if (raceLevel < band.entryLevel || raceLevel > band.max) {
    blockers.push(
      `race level ${raceLevel} does not qualify for ${targetGrade} (needs ${band.entryLevel}-${band.max})`
    )
  }
  return blockers
}

/**
 * GET /api/characters/[id]/evolutions?track=race|class|profession (owner/admin,
 * default race). Returns contextual NEXT-GRADE-only evolution candidates derived
 * from the unarchived definitions catalog.
 *
 * There is no `evolutions` catalog kind anymore. A race may evolve into ANY
 * unarchived race that advances in the SAME mode (same raceType) and defines the
 * next grade's race definition; a class or profession may evolve into ANY
 * unarchived class/profession that defines the next grade's `grades[toGrade]`
 * gain. No path/required-title or manual gate applies, so `legacyAvailable` is
 * always false and the only blockers surfaced are the engine-level grade-band /
 * grade-gate ones the POST would also reject.
 */
export async function getEvolutionOptions(
  id: string,
  user: SessionUser,
  track: "race" | "class" | "profession" = "race"
): Promise<EvolutionOptionsResult> {
  const row = await assertOwner(prisma, id, user)
  const state = deserializeState(row.state)
  const houseRules = await loadHouseRules(prisma)
  const config = buildRulesConfig(row.race, houseRules.config)

  if (track !== "race") {
    return buildTrackEvolutionOptions(row, state, track, config)
  }
  return buildRaceEvolutionOptions(row, state, config)
}

/**
 * Build race evolution options for the selected character. A candidate is an
 * unarchived race that advances in the same mode (same raceType as the current
 * race) AND defines the next grade's race definition; the grade-band / grade-gate
 * blockers are surfaced exactly as the pure evolveGrade engine would reject them.
 */
async function buildRaceEvolutionOptions(
  row: CharacterWithCatalog,
  state: CharacterState,
  config: RulesConfig
): Promise<EvolutionOptionsResult> {
  const currentGrade = state.race.grade
  const targetGrade = nextGrade(currentGrade)
  if (!targetGrade) {
    return { options: [], legacyAvailable: false }
  }
  const currentRaceType: RaceType | null = row.race
    ? raceTypeForRow(row.race)
    : null

  // The race level resolved exactly as the pure evolveGrade engine does for its
  // band check (derived in derived mode, stored otherwise), so GET and POST cannot
  // disagree about whether the level qualifies for the target band.
  const raceLevel =
    state.race.mode === "derived"
      ? deriveRaceLevel(state, config)
      : state.race.level

  const rows = await prisma.catalogDefinition.findMany({
    where: { kind: "races", archived: false },
  })
  const options: EvolutionOptionView[] = []
  for (const destRace of rows) {
    const destConfig = parseCatalogConfig("races", destRace.config ?? {})
    const defs = (destConfig.raceDefinitions ?? {}) as Record<string, unknown>
    if (!(targetGrade in defs)) continue
    // An evolution must never cross raceType without an explicit conversion: only
    // offer a destination that advances in the same mode as the current race.
    if (
      currentRaceType != null &&
      raceTypeForRow(destRace) !== currentRaceType
    ) {
      continue
    }
    const blockers = raceGradeBandBlockers(targetGrade, raceLevel, config)
    options.push({
      id: destRace.id,
      name: destRace.name,
      description: destRace.description,
      fromGrade: currentGrade,
      toGrade: targetGrade,
      toTrackName: destRace.name,
      track: "race",
      sourceUrl: destRace.sourceUrl,
      eligible: blockers.length === 0,
      blockers,
    })
  }
  return { options, legacyAvailable: false }
}

/**
 * Build class/profession evolution options for the selected track. A candidate is
 * an unarchived class (or profession) that defines the next grade's `grades`
 * gain; the grade-band / grade-gate blockers are surfaced exactly as the pure
 * evolveTrackGrade engine would reject them. A track without an explicit grade
 * (a legacy graded-unknown state) returns no options.
 */
async function buildTrackEvolutionOptions(
  row: CharacterWithCatalog,
  state: CharacterState,
  track: "class" | "profession",
  config: RulesConfig
): Promise<EvolutionOptionsResult> {
  const trackState = state.tracks[track]
  if (!trackState || !trackState.grade) {
    return { options: [], legacyAvailable: false }
  }
  const trackGrade = trackState.grade
  const targetGrade = nextGrade(trackGrade)
  if (!targetGrade) {
    return { options: [], legacyAvailable: false }
  }
  const destKind = track === "class" ? "classes" : "professions"

  const rows = await prisma.catalogDefinition.findMany({
    where: { kind: destKind, archived: false },
  })
  const options: EvolutionOptionView[] = []
  for (const destDefinition of rows) {
    const destConfig = parseCatalogConfig(destKind, destDefinition.config ?? {})
    const grades = (destConfig.grades ?? {}) as Record<string, unknown>
    if (!(targetGrade in grades)) continue
    const blockers = trackGradeBandBlockers(
      track,
      targetGrade,
      trackState.level,
      config
    )
    options.push({
      id: destDefinition.id,
      name: destDefinition.name,
      description: destDefinition.description,
      fromGrade: trackGrade,
      toGrade: targetGrade,
      toTrackName: destDefinition.name,
      track,
      sourceUrl: destDefinition.sourceUrl,
      eligible: blockers.length === 0,
      blockers,
    })
  }
  return { options, legacyAvailable: false }
}

export async function evolveCharacter(
  id: string,
  body: EvolveCharacterInput,
  user: SessionUser
): Promise<{ character: CharacterDetail; journal: unknown }> {
  const serializable = {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const row = await assertOwner(tx, id, user)
      const houseRules = await loadHouseRules(tx)
      const state = deserializeState(row.state)

      if (body.track === "race") {
        return evolveRaceDefinition(tx, row, state, body, user, houseRules)
      }
      return evolveTrackDefinition(tx, row, state, body, user, houseRules)
    }, serializable)
  } catch (err) {
    if (isSerializationFailure(err)) {
      throw conflict(
        "serialization_conflict",
        "Concurrent catalog change detected; retry the evolution"
      )
    }
    throw err
  }
}

/**
 * POST /api/characters/[id]/evolve (race branch).
 *
 * Evolve the race grade to the next grade by choosing a destination race
 * definition. The destination row is re-fetched and ALL of the predicates that
 * built the GET option are revalidated INSIDE the SERIALIZABLE transaction, then
 * the pure engine (evolveGrade) runs against the destination race's rules config.
 * Only the race grade/definition change; class/profession tracks and every other
 * ledger are preserved. There is no grade-only fallback, so the client must
 * always choose a destination definition.
 */
async function evolveRaceDefinition(
  tx: DbClient,
  row: CharacterWithCatalog,
  state: CharacterState,
  body: EvolveCharacterInput,
  user: SessionUser,
  houseRules: HouseRulesRow
): Promise<{ character: CharacterDetail; journal: unknown }> {
  const destRace = await tx.catalogDefinition.findUnique({
    where: { id: body.optionId },
  })
  if (!destRace || destRace.kind !== "races") {
    throw notFound(
      "evolution_destination_missing",
      "Evolution destination race not found"
    )
  }
  if (destRace.archived) {
    throw badRequest(
      "catalog_archived",
      `Destination race "${destRace.name}" is archived`
    )
  }

  const currentGrade = state.race.grade
  const currentRaceType: RaceType | null = row.race
    ? raceTypeForRow(row.race)
    : null
  const targetGrade = nextGrade(currentGrade)
  if (!targetGrade) {
    throw badRequest(
      "invalid_evolution_grade",
      `Character race is grade ${currentGrade}; there is no next grade to evolve into`
    )
  }

  // Destination race must define the next grade's race definition (the same
  // predicate GET used to build the option).
  const destConfigParsed = parseCatalogConfig("races", destRace.config ?? {})
  const defs = (destConfigParsed.raceDefinitions ?? {}) as Record<
    string,
    unknown
  >
  if (!(targetGrade in defs)) {
    throw badRequest(
      "evolution_destination_definition_missing",
      `Destination race "${destRace.name}" has no ${targetGrade}-grade race definition`
    )
  }

  // An evolution must never cross raceType without an explicit conversion.
  const destRaceType = raceTypeForRow(destRace)
  if (currentRaceType != null && destRaceType !== currentRaceType) {
    throw badRequest(
      "race_type_mismatch",
      `Evolution would change race type from "${currentRaceType}" to "${destRaceType}"; a race cannot cross its advancement mode without an explicit conversion`
    )
  }

  // Re-evaluate the engine-level grade-band / grade-gate gate INSIDE the
  // transaction using the destination race's rules config.
  const config = buildRulesConfig(destRace, houseRules.config)
  const raceLevel =
    state.race.mode === "derived"
      ? deriveRaceLevel(state, config)
      : state.race.level
  const blockers = raceGradeBandBlockers(targetGrade, raceLevel, config)
  if (blockers.length > 0) {
    throw badRequest("evolution", blockers.join("; "))
  }

  const oldRace = {
    id: row.race?.id ?? null,
    stableId: row.race?.stableId ?? null,
    name: row.race?.name ?? null,
  }

  // Run the pure engine (evolveGrade) with the TARGET race's rules config, only
  // after validating both current and destination. No rewards/skills are
  // invented: class/profession tracks, historical awards and allocations are
  // preserved.
  const result = applyEvolve(state, targetGrade, config)
  const serialized = serializeState(result.state)
  const updatedMany = await tx.character.updateMany({
    where: { id: row.id, version: body.version },
    data: {
      raceId: destRace.id,
      state: serialized as Prisma.InputJsonValue,
      version: { increment: 1 },
    },
  })
  if (updatedMany.count !== 1) {
    throw conflict(
      "version_conflict",
      `Version mismatch: expected ${body.version}, got a newer version`
    )
  }

  // Grade-granted skills for the TARGET grade of the NEW selected race
  // definition (the grade the character is evolving into). Resolve against the
  // character's existing SKILL links so an already-owned / colliding skill
  // follows the duplicate/upgrade policy, persist the result alongside the
  // evolution, and journal it below.
  const grantGrade = targetGrade
  const grantRequests: GradeGrantRequest[] = []
  for (const stableId of gradeSkillStableIdsFor(destConfigParsed, grantGrade)) {
    grantRequests.push({ stableId, grade: grantGrade })
  }
  const raceSkillMap = await loadUnarchivedSkillMap(tx)
  const gradeResolution = resolveGradeSkillGrants(
    ownedSkillLinksFrom(row.associations),
    grantRequests,
    raceSkillMap
  )
  await persistGradeSkillGrants(tx, row.id, gradeResolution)

  const reason =
    typeof body.reason === "string" && body.reason.trim().length > 0
      ? body.reason.trim()
      : null
  const destDef = (defs[targetGrade] as { id?: string } | undefined)?.id ?? null
  const journal: Record<string, unknown> = {
    ...result.journal,
    source: "catalog",
    optionId: destRace.id,
    option: {
      id: destRace.id,
      name: destRace.name,
      stableId: destRace.stableId,
    },
    oldRace,
    destination: {
      id: destRace.id,
      stableId: destRace.stableId,
      name: destRace.name,
      grade: targetGrade,
    },
    oldDefinitionId: state.race.definitionId,
    newDefinitionId: destDef ?? result.state.race.definitionId,
    reason,
    ...(hasGradeGrantJournalEntries(gradeResolution.journal)
      ? { skillGrants: gradeResolution.journal }
      : {}),
  }

  await tx.progressionEvent.create({
    data: {
      characterId: row.id,
      kind: "evolve",
      payload: {
        track: "race",
        optionId: destRace.id,
        journal,
        reason,
      } as Prisma.InputJsonValue,
    },
  })
  const updated = (await tx.character.findUnique({
    where: { id: row.id },
    include: characterInclude,
  }))!
  const updatedConfig = buildRulesConfig(updated.race, houseRules.config)
  return {
    character: await toDetail(
      updated,
      true,
      updatedConfig,
      houseRules.version,
      tx
    ),
    journal,
  }
}

/**
 * POST /api/characters/[id]/evolve (track branch).
 *
 * Evolve a graded class/profession track to the next grade by choosing a
 * destination definition. The destination row is re-fetched and ALL of the
 * predicates that built the GET option are revalidated INSIDE the SERIALIZABLE
 * transaction, then the pure engine (evolveTrackGrade) runs against the
 * character's rules config. Only the target track's grade/definitionId change and
 * the character's classId/professionId is updated; the race grade and every other
 * ledger are preserved.
 */
async function evolveTrackDefinition(
  tx: DbClient,
  row: CharacterWithCatalog,
  state: CharacterState,
  body: EvolveCharacterInput,
  user: SessionUser,
  houseRules: HouseRulesRow
): Promise<{ character: CharacterDetail; journal: unknown }> {
  const track = body.track as "class" | "profession"
  const destKind = track === "class" ? "classes" : "professions"

  const destDefinition = await tx.catalogDefinition.findUnique({
    where: { id: body.optionId },
  })
  if (!destDefinition || destDefinition.kind !== destKind) {
    throw notFound(
      "evolution_destination_missing",
      `Evolution destination ${track} not found`
    )
  }
  if (destDefinition.archived) {
    throw badRequest(
      "catalog_archived",
      `Destination ${track} "${destDefinition.name}" is archived`
    )
  }

  const trackState = state.tracks[track]
  if (!trackState) {
    throw badRequest("unknown_track", `Character has no "${track}" track`)
  }
  const trackGrade = trackState.grade
  if (!trackGrade) {
    // Legacy graded-unknown state: no explicit grade to evolve.
    throw badRequest(
      "track_grade_unknown",
      `Character's "${track}" track has no explicit grade to evolve`
    )
  }
  const targetGrade = nextGrade(trackGrade)
  if (!targetGrade) {
    throw badRequest(
      "invalid_evolution_grade",
      `Character ${track} is grade ${trackGrade}; there is no next grade to evolve into`
    )
  }

  // Destination definition must define the next grade's `grades` gain (the same
  // predicate GET used to build the option).
  const destConfig = parseCatalogConfig(destKind, destDefinition.config ?? {})
  const destGrades = (destConfig.grades ?? {}) as Record<string, unknown>
  if (!(targetGrade in destGrades)) {
    throw badRequest(
      "evolution_destination_definition_missing",
      `Destination ${track} "${destDefinition.name}" has no ${targetGrade}-grade track definition`
    )
  }

  // Re-evaluate the engine-level grade-band / grade-gate gate INSIDE the
  // transaction.
  const config = configFor(row, houseRules.config)
  const blockers = trackGradeBandBlockers(
    track,
    targetGrade,
    trackState.level,
    config
  )
  if (blockers.length > 0) {
    throw badRequest("evolution", blockers.join("; "))
  }

  // Run the pure engine (evolveTrackGrade) with the character's rules config.
  const targetDefinitionId = `${destDefinition.stableId}:${targetGrade}`
  const result = evolveTrackGrade(
    state,
    track,
    targetGrade,
    targetDefinitionId,
    config
  )
  if (!result.ok) {
    throw badRequest("evolution", result.errors.join("; "))
  }
  const serialized = serializeState(result.state!)
  const updatedMany = await tx.character.updateMany({
    where: { id: row.id, version: body.version },
    data: {
      ...(track === "class"
        ? { classId: destDefinition.id }
        : { professionId: destDefinition.id }),
      state: serialized as Prisma.InputJsonValue,
      version: { increment: 1 },
    },
  })
  if (updatedMany.count !== 1) {
    throw conflict(
      "version_conflict",
      `Version mismatch: expected ${body.version}, got a newer version`
    )
  }

  // Grade-granted skills for the TARGET grade of the NEW selected track
  // definition (the grade the track is evolving into). Resolve against the
  // character's existing SKILL links so an already-owned / colliding skill
  // follows the duplicate/upgrade policy, persist the result alongside the
  // evolution, and journal it below.
  const grantGrade = targetGrade
  const grantRequests: GradeGrantRequest[] = []
  for (const stableId of gradeSkillStableIdsFor(destConfig, grantGrade)) {
    grantRequests.push({ stableId, grade: grantGrade })
  }
  const trackSkillMap = await loadUnarchivedSkillMap(tx)
  const gradeResolution = resolveGradeSkillGrants(
    ownedSkillLinksFrom(row.associations),
    grantRequests,
    trackSkillMap
  )
  await persistGradeSkillGrants(tx, row.id, gradeResolution)

  const reason =
    typeof body.reason === "string" && body.reason.trim().length > 0
      ? body.reason.trim()
      : null
  const journal: Record<string, unknown> = {
    ...result.journal,
    source: "track",
    optionId: destDefinition.id,
    option: {
      id: destDefinition.id,
      name: destDefinition.name,
      stableId: destDefinition.stableId,
    },
    destination: {
      id: destDefinition.id,
      stableId: destDefinition.stableId,
      name: destDefinition.name,
      grade: targetGrade,
    },
    reason,
    ...(hasGradeGrantJournalEntries(gradeResolution.journal)
      ? { skillGrants: gradeResolution.journal }
      : {}),
  }

  await tx.progressionEvent.create({
    data: {
      characterId: row.id,
      kind: "evolve",
      payload: {
        track,
        optionId: destDefinition.id,
        journal,
        reason,
      } as Prisma.InputJsonValue,
    },
  })
  const updated = (await tx.character.findUnique({
    where: { id: row.id },
    include: characterInclude,
  }))!
  const updatedConfig = buildRulesConfig(updated.race, houseRules.config)
  return {
    character: await toDetail(
      updated,
      true,
      updatedConfig,
      houseRules.version,
      tx
    ),
    journal,
  }
}

// ------------------------------------------------------------------ //
// Character inventory
// ------------------------------------------------------------------ //

/**
 * Read a character's owned inventory (equipment + items, including
 * archived stock) together with the current CAS version. A read path: no
 * mutation, so an archived character's inventory is still readable. Ownership is
 * the same owner/admin guard used everywhere else (a non-owner is 403).
 */
export async function getCharacterInventory(
  id: string,
  user: SessionUser
): Promise<{ inventory: CharacterInventoryItemView[]; version: number }> {
  const row = await prisma.character.findUnique({
    where: { id },
    include: {
      inventory: { include: { definition: true } },
      race: true,
      // The live inventory view evaluates equipment eligibility (level/race and
      // divine-patron requirements), so the active blessing links must be loaded.
      associations: { include: { definition: true } },
    },
  })
  if (!row) throw notFound("character_not_found", "Character not found")
  if (!user.isAdmin && row.ownerId !== user.id) {
    throw forbidden("forbidden", "You do not own this character")
  }
  return {
    inventory: row.inventory.map((i) => inventoryView(i, row)),
    version: row.version,
  }
}

/**
 * Add or remove owned inventory quantity for a character, or spend exactly one
 * owned unit of an `items` definition.
 *
 * This is the user's manual bookkeeping path for acquisition (no acquisition
 * economy is invented here): the client states how many units were obtained or
 * spent and a mandatory source note, and the service records the prior/new
 * quantity in the `inventory_adjust` journal along with a definition snapshot and
 * the acting user id. `use` is a distinct stock-only action that spends exactly
 * one owned unit of a catalog `items` definition and applies no mechanical
 * effect; it records an explicit `inventory_use` progression event with the
 * automatic note "Used item" and no source note.
 *
 * - Only `equipment` / `items` definitions may be inventoried. Adding
 *   requires an ACTIVE (unarchived) definition; removing/using is permitted for
 *   archived definitions (owned stock may be spent even when new stock cannot be
 *   acquired).
 * - `add` / `remove` accept `quantity` bounded 1..999999; `use` requires
 *   `quantity === 1`. A remove/use down to zero deletes the row (an absent row
 *   means zero stock); a remove beyond owned stock and a use with zero owned
 *   stock are rejected. A new distinct definition can be added only while the
 *   character owns fewer than MAX_IMPORT_INVENTORY distinct definitions (the
 *   trusted-backup roundtrip cap); exceeding it is a 409.
 * - `use` is only legal for an `items` definition - an equipment definition
 *   cannot be used (400). It never changes live state or status (no stat/current-
 *   resource effect, no recipe), so only the inventory quantity and the journal
 *   change.
 * - Ownership invariant: a removal that would take an equipped item's stock to
 *   zero is rejected with a 409 `inventory_equipped` (no auto-unequip). This
 *   applies to any EQUIPMENT association for the definition (legacyUnowned true
 *   or false, and including archived linked definitions) that currently owns
 *   stock; a grandfathered link already at zero stock has no inventory row to
 *   remove, so it never hits this branch and stays equipped. A removal that
 *   leaves at least one unit is always allowed. Use never triggers this guard
 *   (it only applies to items, which are never equipment-linked).
 * - The write runs under SERIALIZABLE isolation, CASes the character version, and
 *   maps a P2034 (cannot-serialize concurrent write) to a 409. A stale version
 *   409s and rolls back the inventory change and the journal.
 */
export async function adjustCharacterInventory(
  id: string,
  body: {
    operation: "add" | "remove" | "use"
    definitionId: string
    quantity: number
    version: number
    sourceNote?: string
  },
  user: SessionUser
): Promise<{
  character: CharacterDetail
  inventory: CharacterInventoryItemView[]
  version: number
}> {
  return prisma
    .$transaction(
      async (tx) => {
        const row = await assertOwner(tx, id, user)
        const houseRules = await loadHouseRules(tx)
        if (row.archived) {
          throw badRequest(
            "character_archived",
            "Archived character cannot adjust inventory"
          )
        }

        const definition = await tx.catalogDefinition.findUnique({
          where: { id: body.definitionId },
        })
        if (!definition) {
          throw notFound("catalog_not_found", "Catalog entry not found")
        }
        if (definition.kind !== "equipment" && definition.kind !== "items") {
          throw badRequest(
            "wrong_kind",
            `Catalog entry has wrong kind (expected "equipment" or "items")`
          )
        }
        if (body.operation === "add" && definition.archived) {
          throw badRequest(
            "catalog_archived",
            "Catalog entry is archived and cannot be added to inventory"
          )
        }
        // `use` is a stock-only action for catalog `items` only. An equipment
        // definition cannot be used (400). Archived `items` are permitted - owned
        // stock may still be spent - so no archived guard applies here, unlike
        // `add`. The quantity is enforced to be exactly 1 by the schema and again
        // here for direct service callers.
        if (body.operation === "use" && definition.kind !== "items") {
          throw badRequest(
            "wrong_kind",
            `Catalog entry has wrong kind for a use (expected "items")`
          )
        }
        if (body.operation === "use" && body.quantity !== 1) {
          throw badRequest(
            "validation",
            `A use spends exactly one unit (got quantity ${body.quantity})`
          )
        }

        const existing = await tx.characterInventoryItem.findUnique({
          where: {
            characterId_definitionId: {
              characterId: id,
              definitionId: definition.id,
            },
          },
        })
        const prior = existing?.quantity ?? 0
        let next: number
        if (body.operation === "add") {
          next = prior + body.quantity
          if (next > 999999) {
            throw badRequest(
              "inventory_cap_exceeded",
              `Inventory of "${definition.name}" would exceed the 999999 cap`
            )
          }
        } else if (body.operation === "use") {
          // A use spends exactly one owned unit. Zero/insufficient stock is
          // rejected BEFORE the CAS version is bumped and BEFORE any event is
          // written, so a failed use never advances the version.
          if (prior < 1) {
            throw badRequest(
              "inventory_insufficient",
              `You own no "${definition.name}" to use`
            )
          }
          next = prior - 1
        } else {
          if (prior < body.quantity) {
            throw badRequest(
              "inventory_insufficient",
              `You own only ${prior} of "${definition.name}"`
            )
          }
          next = prior - body.quantity
        }

        // Ownership invariant: an equipped item must keep owned stock. When a
        // removal would discard the final owned unit (next === 0) while the
        // definition is still linked as EQUIPMENT, reject BEFORE deleting the
        // row and BEFORE bumping the CAS version. This applies to every EQUIPMENT
        // association (legacyUnowned true or false) that currently owns stock;
        // a grandfathered link already at zero stock has no inventory row to
        // remove, so it never reaches this branch and stays equipped. There is
        // no auto-unequip: the link is left in place for the user to remove.
        // Archived linked definitions are still matched (owning archived stock
        // must not silently orphan a still-equipped item).
        if (next === 0 && body.operation === "remove") {
          const equipped = row.associations.some(
            (a) => a.kind === "EQUIPMENT" && a.definitionId === definition.id
          )
          if (equipped) {
            throw conflict(
              "inventory_equipped",
              `"${definition.name}" is equipped; unequip it before removing its final owned unit`
            )
          }
        }

        if (next === 0) {
          await tx.characterInventoryItem.deleteMany({
            where: { characterId: id, definitionId: definition.id },
          })
        } else if (existing) {
          await tx.characterInventoryItem.updateMany({
            where: { characterId: id, definitionId: definition.id },
            data: { quantity: next },
          })
        } else {
          // Creating a distinct stock row. The trusted-backup export/import caps
          // inventory at MAX_IMPORT_INVENTORY distinct definitions, so a manual add
          // that would push the count past that cap is rejected with a 409 to keep
          // an exported character self-roundtrippable.
          if (row.inventory.length >= MAX_IMPORT_INVENTORY) {
            throw conflict(
              "inventory_defs_cap_exceeded",
              `Inventory would exceed ${MAX_IMPORT_INVENTORY} distinct definitions; the trusted-backup export cannot round-trip more`
            )
          }
          await tx.characterInventoryItem.create({
            data: {
              characterId: id,
              definitionId: definition.id,
              quantity: next,
            },
          })
        }

        // CAS: the character version must match the expected value. A mismatch
        // returns 409 and rolls back the inventory change and the journal.
        const updatedMany = await tx.character.updateMany({
          where: { id, version: body.version },
          data: { version: { increment: 1 } },
        })
        if (updatedMany.count !== 1) {
          throw conflict(
            "version_conflict",
            `Version mismatch: expected ${body.version}, got a newer version`
          )
        }

        const definitionSnapshot = {
          id: definition.id,
          name: definition.name,
          kind: definition.kind,
          stableId: definition.stableId,
          grade: definition.grade,
          archived: definition.archived,
        }
        if (body.operation === "use") {
          await tx.progressionEvent.create({
            data: {
              characterId: id,
              kind: "inventory_use",
              payload: {
                operation: "use",
                definitionId: definition.id,
                definition: definitionSnapshot,
                // A use always spends exactly one unit; the client-supplied
                // sourceNote is ignored in favor of the automatic note.
                quantity: 1,
                priorQuantity: prior,
                newQuantity: next,
                sourceNote: "Used item",
                actorId: user.id,
                usedAt: new Date().toISOString(),
              } as Prisma.InputJsonValue,
            },
          })
        } else {
          await tx.progressionEvent.create({
            data: {
              characterId: id,
              kind: "inventory_adjust",
              payload: {
                operation: body.operation,
                definitionId: definition.id,
                definition: definitionSnapshot,
                quantity: body.quantity,
                priorQuantity: prior,
                newQuantity: next,
                sourceNote: body.sourceNote,
                actorId: user.id,
                at: new Date().toISOString(),
              } as Prisma.InputJsonValue,
            },
          })
        }

        const updated = (await tx.character.findUnique({
          where: { id },
          include: characterInclude,
        }))!
        return {
          character: await detailFor(updated, houseRules, tx),
          inventory: updated.inventory.map((i) => inventoryView(i, updated)),
          version: updated.version,
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )
    .catch((err) => {
      // A concurrent inventory write that cannot serialize surfaces as P2034;
      // map it to a 409 rather than a raw 500.
      if (isSerializationFailure(err)) {
        throw conflict(
          "catalog_serialization_conflict",
          "Concurrent character inventory write conflict; retry the change"
        )
      }
      throw err
    })
}

// ------------------------------------------------------------------ //
// Character currency balances
// ------------------------------------------------------------------ //

/**
 * A read-only view of a character's holdings of a `currencies` catalog entry.
 * Ownership is per-definition house bookkeeping: only the integer `amount` and
 * the linked definition's identity/metadata are exposed, and only for ACTIVE
 * (unarchived) currency definitions. An active currency the character does not
 * hold reads back with `amount: null` (an absent row means "no recorded
 * balance"). A balance saved against an ARCHIVED currency definition is hidden
 * from this view but retained, so reactivating the definition later reveals the
 * kept amount.
 */
export interface CharacterCurrencyView {
  /** The catalog `currencies` definition id (the row's own `id`, not its stableId). */
  definitionId: string
  stableId: string
  name: string
  description: string | null
  /** The character's held balance, or null when no stored balance exists for this currency. */
  amount: number | null
}

/**
 * Read a character's currency balances (every active `currencies` catalog entry,
 * joined with the character's stored balance) together with the current CAS
 * version. A read path: no mutation, so an archived character's balances are
 * still readable. Ownership is the same owner/admin guard used everywhere else
 * (a non-owner is 403).
 */
export async function getCharacterCurrencies(
  id: string,
  user: SessionUser
): Promise<{ currencies: CharacterCurrencyView[]; version: number }> {
  const row = await prisma.character.findUnique({ where: { id } })
  if (!row) throw notFound("character_not_found", "Character not found")
  if (!user.isAdmin && row.ownerId !== user.id) {
    throw forbidden("forbidden", "You do not own this character")
  }
  const [defs, balances] = await Promise.all([
    prisma.catalogDefinition.findMany({
      where: { kind: "currencies", archived: false },
    }),
    prisma.characterCurrencyBalance.findMany({
      where: { characterId: id },
      include: { definition: true },
    }),
  ])
  // Only balances referencing a `currencies` definition contribute. Amounts are
  // keyed by definition id so an archived currency's saved amount is simply not
  // looked up (hidden), and a reactivated entry is revealed with its kept value.
  const amountByDefinitionId = new Map<string, number>()
  for (const balance of balances) {
    if (balance.definition?.kind === "currencies") {
      amountByDefinitionId.set(balance.definitionId, balance.amount)
    }
  }
  const currencies = defs
    .slice()
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.stableId.localeCompare(b.stableId)
    )
    .map((def) => ({
      definitionId: def.id,
      stableId: def.stableId,
      name: def.name,
      description: def.description ?? null,
      amount: amountByDefinitionId.get(def.id) ?? null,
    }))
  return { currencies, version: row.version }
}

/**
 * Set a character's balance for a single `currencies` catalog definition.
 *
 * This is the owner/admin manual bookkeeping path for durable currency holdings
 * (no acquisition economy is invented here): the client states the exact held
 * amount, and the service persists it as a `character_currency_balances` row.
 * Unlike the engine's derived resources this value is NOT synthesized from a
 * catalog config, and unlike inventory quantity it is never a consumable or
 * equipment stock count - a balance is an end in itself. No progression event is
 * emitted and no character state is mutated: currency holdings live outside
 * `Character.state`.
 *
 * - `amount` must be a nonnegative whole number 0..2147483647 (the DB CHECK
 *   upper bound, well below the safe-integer limit). A `0` balance is a legal
 *   stored row (kept so the explicit character-currency association is
 *   preserved); `null` removes the stored row (an absent row means "no recorded
 *   balance").
 * - Only an ACTIVE (unarchived) `currencies` definition is accepted: a missing
 *   definition is a 404, and an archived or non-currency definition is rejected
 *   (a balance saved against an archived currency is preserved for a later
 *   reactivation but cannot be written while archived).
 * - The write runs under SERIALIZABLE isolation, CASes the character version,
 *   and maps a P2034 (cannot-serialize concurrent write) to a 409. A stale
 *   version 409s and rolls back the balance change.
 * - The version is bumped EXACTLY ONCE on an actual amount change. Setting the
 *   already-stored amount (or setting null when no row exists) is an idempotent
 *   no-op that never bumps the version, but a STALE no-op still 409s: a client
 *   holding an outdated character version is rejected even when nothing would
 *   change. A fresh no-op returns the unchanged current version and writes no
 *   event and no row.
 * - A NEW distinct balance row is limited to MAX_IMPORT_CURRENCIES per
 *   character (matching the trusted-backup roundtrip cap, counting ARCHIVED
 *   balances too), so an exported character always re-imports cleanly. Updating
 *   or deleting an EXISTING row is always allowed at the cap; creating the
 *   501st distinct row is a 409.
 */
export async function setCharacterCurrencyBalance(
  id: string,
  body: { definitionId: string; amount: number | null; version: number },
  user: SessionUser
): Promise<{ version: number }> {
  return prisma
    .$transaction(
      async (tx) => {
        const row = await assertOwner(tx, id, user)
        if (row.archived) {
          throw badRequest(
            "character_archived",
            "Archived character cannot update currency balances"
          )
        }
        if (
          body.amount != null &&
          (!Number.isInteger(body.amount) ||
            body.amount < 0 ||
            body.amount > CURRENCY_AMOUNT_MAX)
        ) {
          throw badRequest(
            "validation",
            `Currency amount must be a whole number 0..${CURRENCY_AMOUNT_MAX}`
          )
        }
        const definition = await tx.catalogDefinition.findUnique({
          where: { id: body.definitionId },
        })
        if (!definition) {
          throw notFound("catalog_not_found", "Catalog entry not found")
        }
        if (definition.kind !== "currencies") {
          throw badRequest(
            "wrong_kind",
            `Catalog entry has wrong kind (expected "currencies")`
          )
        }
        if (definition.archived) {
          throw badRequest(
            "catalog_archived",
            "Catalog entry is archived and cannot be set as a currency balance"
          )
        }

        const existing = await tx.characterCurrencyBalance.findUnique({
          where: {
            characterId_definitionId: {
              characterId: id,
              definitionId: definition.id,
            },
          },
        })

        let changed = false
        if (body.amount == null) {
          // `null` removes the stored row; with no row already present this is an
          // idempotent no-op that never bumps the version.
          if (existing) {
            await tx.characterCurrencyBalance.deleteMany({
              where: { characterId: id, definitionId: definition.id },
            })
            changed = true
          }
        } else if (existing) {
          if (existing.amount !== body.amount) {
            await tx.characterCurrencyBalance.updateMany({
              where: { characterId: id, definitionId: definition.id },
              data: { amount: body.amount },
            })
            changed = true
          }
        } else {
          // Creating a distinct balance row. The trusted-backup export/import caps
          // currency balances at MAX_IMPORT_CURRENCIES distinct definitions (see
          // import-schema), so a manual set that would push the count past that cap
          // is rejected with a 409 to keep an exported character self-roundtrippable.
          // ARCHIVED balances count toward the cap (a hidden amount must survive a
          // backup round-trip), so the check counts every stored row for the
          // character, not just active ones.
          const balanceCount = await tx.characterCurrencyBalance.count({
            where: { characterId: id },
          })
          if (balanceCount >= MAX_IMPORT_CURRENCIES) {
            throw conflict(
              "currency_defs_cap_exceeded",
              `Currency balances would exceed ${MAX_IMPORT_CURRENCIES} distinct definitions; the trusted-backup export cannot round-trip more`
            )
          }
          await tx.characterCurrencyBalance.create({
            data: {
              characterId: id,
              definitionId: definition.id,
              amount: body.amount,
            },
          })
          changed = true
        }

        if (!changed) {
          // Nothing changed (idempotent no-op), but a STALE client version is still
          // a conflict. Under SERIALIZABLE the row snapshot is authoritative; a
          // concurrent version bump would surface as a P2034 and become a 409 above.
          if (body.version !== row.version) {
            throw conflict(
              "version_conflict",
              `Version mismatch: expected ${body.version}, got ${row.version}`
            )
          }
          return { version: row.version }
        }

        // CAS: the character version must match the expected value. A mismatch
        // returns 409 and rolls back the balance change.
        const updatedMany = await tx.character.updateMany({
          where: { id, version: body.version },
          data: { version: { increment: 1 } },
        })
        if (updatedMany.count !== 1) {
          throw conflict(
            "version_conflict",
            `Version mismatch: expected ${body.version}, got a newer version`
          )
        }
        return { version: row.version + 1 }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )
    .catch((err) => {
      if (isSerializationFailure(err)) {
        throw conflict(
          "catalog_serialization_conflict",
          "Concurrent character currency write conflict; retry the change"
        )
      }
      throw err
    })
}

/** Decode the equipment slot from a catalog definition's parsed config (normalized). */
function definitionSlot(def: {
  kind: string
  config?: unknown
}): string | undefined {
  const slot = parseCatalogConfig(def.kind, def.config ?? {}).slot
  return normalizeEquipmentSlot(slot)
}

/** Decode the title upgrade group from a catalog definition's parsed config. */
function definitionUpgradeGroup(def: {
  kind: string
  config?: unknown
}): string | undefined {
  const group = parseCatalogConfig(def.kind, def.config ?? {}).upgradeGroup
  return typeof group === "string" && group.length > 0 ? group : undefined
}

/**
 * Parse a title config's `improvement` descriptor when present. The config has
 * already passed `parseCatalogConfig`, so the descriptor is validated; this still
 * returns undefined defensively for a config that omits it (an ordinary title).
 */
function titleImprovementForConfig(
  config: Record<string, unknown>
): TitleImprovement | undefined {
  const imp = config.improvement
  if (imp == null) return undefined
  const parsed = titleImprovementSchema.safeParse(imp)
  return parsed.success ? parsed.data : undefined
}

/** The improvement seriesId carried by a link's linked title definition, if any. */
function titleSeriesIdForLink(l: {
  kind: string
  definition: { kind: string; config?: unknown }
}): string | undefined {
  if (l.kind !== "TITLE") return undefined
  const cfg = parseCatalogConfig(l.definition.kind, l.definition.config ?? {})
  return titleImprovementForConfig(cfg)?.seriesId
}

/** Whether a linked title definition carries a ranked `improvement` descriptor. */
function isRankedTitleLink(l: {
  kind: string
  definition: { kind: string; config?: unknown }
}): boolean {
  if (l.kind !== "TITLE") return false
  const cfg = parseCatalogConfig(l.definition.kind, l.definition.config ?? {})
  return titleImprovementForConfig(cfg) != null
}

/**
 * Validate an add of a RANKED title (one whose config carries `improvement`).
 * This runs before any link is removed, so a rejected add writes nothing. The
 * character's race grade is the authority for the grade gate; rank progression is
 * strictly sequential:
 *   - rank 1 is only accepted when NO current link in the same series exists, and
 *     when no unrelated non-ranked title silently occupies the same upgrade group
 *     (that would be ambiguous and is rejected rather than displaced).
 *   - rank > 1 is only accepted when EXACTLY ONE current link in the same series
 *     exists with `improvement.rank === target.rank - 1` (archived links count)
 *     AND when no unrelated/non-ranked title occupies the target upgrade group
 *     (that add would silently displace it, which is rejected rather than
 *     silently applied).
 *
 * Resolves to 400 `title_grade_blocked` (grade gate), 400 `title_rank_conflict`
 * (skip/repeat/missing-prior/ambiguous) or 400 `title_reason_required` (a ranked
 * title add must carry a self-reported reason).
 */
function assertRankedTitleAdd(
  improvement: TitleImprovement,
  config: Record<string, unknown>,
  existing: CharacterWithCatalog["associations"],
  raceGrade: Grade,
  reason: string | undefined
): void {
  const trimmed = (reason ?? "").trim()
  if (trimmed.length === 0) {
    throw badRequest(
      "title_reason_required",
      "A ranked title add requires a reason (your qualifying clear)"
    )
  }
  if (gradeOrderIndex(raceGrade) < gradeOrderIndex(improvement.minRaceGrade)) {
    throw badRequest(
      "title_grade_blocked",
      `This rank requires race grade ${improvement.minRaceGrade} or higher (current race grade is ${raceGrade})`
    )
  }
  const seriesLinks = existing.filter(
    (l) => titleSeriesIdForLink(l) === improvement.seriesId
  )
  if (improvement.rank === 1) {
    if (seriesLinks.length > 0) {
      throw badRequest(
        "title_rank_conflict",
        `Rank 1 of series "${improvement.seriesId}" is already present; downgrade is not allowed`
      )
    }
    const group = config.upgradeGroup as string | undefined
    const groupLinks = existing.filter(
      (l) =>
        l.kind === "TITLE" && definitionUpgradeGroup(l.definition) === group
    )
    const unrelated = groupLinks.filter((l) => !seriesLinks.includes(l))
    if (unrelated.length > 0) {
      throw badRequest(
        "title_rank_conflict",
        `Rank 1 would replace the unrelated title "${unrelated[0].definition.name}" in upgrade group "${group}"; remove it first or use a distinct group`
      )
    }
    return
  }
  if (seriesLinks.length !== 1) {
    throw badRequest(
      "title_rank_conflict",
      `Rank ${improvement.rank} requires exactly one prior title in series "${improvement.seriesId}" (found ${seriesLinks.length})`
    )
  }
  const prior = seriesLinks[0]
  const priorImp = titleImprovementForConfig(
    parseCatalogConfig(prior.definition.kind, prior.definition.config ?? {})
  )
  if (priorImp?.rank !== improvement.rank - 1) {
    throw badRequest(
      "title_rank_conflict",
      `Rank ${improvement.rank} requires the immediately prior rank ${improvement.rank - 1} to be linked (found ${priorImp?.rank ?? "unranked"})`
    )
  }
  // Rank > 1 must occupy the target upgrade group alone: no unrelated / non-ranked
  // title may sit in the same group, or the add would silently displace it. The
  // immediately-prior series link is allowed (it is atomically replaced); a title
  // from ANOTHER series or an unranked title in the same group is rejected.
  if (improvement.rank > 1) {
    const group = config.upgradeGroup as string | undefined
    const groupLinks = existing.filter(
      (l) =>
        l.kind === "TITLE" && definitionUpgradeGroup(l.definition) === group
    )
    const unrelated = groupLinks.filter((l) => !seriesLinks.includes(l))
    if (unrelated.length > 0) {
      throw badRequest(
        "title_rank_conflict",
        `Rank ${improvement.rank} would replace the unrelated title "${unrelated[0].definition.name}" in upgrade group "${group}"; remove it first or use a distinct group`
      )
    }
  }
}

/** A human label for each associable kind, used only in error messages. */
function labelForKind(
  kind: "title" | "equipment" | "blessing" | "bloodline" | "transcendent"
): string {
  switch (kind) {
    case "title":
      return "title"
    case "equipment":
      return "equipment piece"
    case "blessing":
      return "blessing"
    case "bloodline":
      return "bloodline"
    case "transcendent":
      return "transcendent skill"
  }
}

/**
 * Attach (`add`) or detach (`remove`) a catalog definition as a character
 * association. Only a title, equipment piece, blessing or bloodline can be
 * linked here (skills are handled by `skillCharacter`).
 *
 * - **title / equipment**: an add never stacks superseded entries; it atomically
 *   removes whatever currently occupies the SAME title upgrade group / equipment
 *   slot.
 * - **blessing**: exactly one ACTIVE unarchived blessing may exist at a time, so
 *   an add atomically replaces EVERY existing blessing link on the character
 *   (including archived links), and a remove detaches only the named link.
 * - **bloodline**: at most ONE bloodline link may exist on a character. An add
 *   atomically replaces EVERY existing bloodline link on the character (active or
 *   archived) with the new one - the DB partial unique index enforces the
 *   singleton, and a concurrent duplicate writer surfaces as a
 *   `bloodline_singleton_conflict`. A remove detaches only the named link.
 * - **transcendent**: a character may carry at most `maxTranscendentSkills`
 *   (admin-configurable, default 3). An add is rejected with `link_limit` once
 *   the character already holds that many transcendent links (including archived
 *   ones); transcendent skills otherwise coexist freely, so a remove detaches
 *   only the named link.
 *
 * A duplicate add is rejected; an archived catalog entry can never be newly
 * attached but an archived linked entry can always be removed. The mutation runs
 * under SERIALIZABLE isolation and CASes the character version (`version`); a
 * stale version 409s (and rolls back the link delete/create and the event), and a
 * concurrent write that fails to serialize also 409s.
 */
export async function associateCharacter(
  id: string,
  body: {
    kind: "title" | "equipment" | "blessing" | "bloodline" | "transcendent"
    definitionId: string
    operation: "add" | "remove"
    version: number
    reason?: string
    // The physical ring position, required on an add of a Ring-slot equipment
    // item, forbidden on a non-ring add and ignored on a remove.
    equipmentPosition?: "Ring 1" | "Ring 2"
    // The exact blessing tier, meaningful only on a blessing operation (the
    // definitionId names the god that granted it; the tier is persisted verbatim
    // so the live effect is synthesized from the god's `blessingEffects[tier]`).
    tier?: BlessingTier
  },
  user: SessionUser
): Promise<{ character: CharacterDetail }> {
  return prisma
    .$transaction(
      async (tx) => {
        const row = await assertOwner(tx, id, user)
        const houseRules = await loadHouseRules(tx)
        // The configured transcendent-skill cap (default 3) is read here, through
        // the SAME tx, so an add is rejected before any write.
        const maxTranscendentSkills = houseRules.config.maxTranscendentSkills

        const definition = await tx.catalogDefinition.findUnique({
          where: { id: body.definitionId },
        })
        if (!definition) {
          throw notFound("catalog_not_found", "Catalog entry not found")
        }
        const expectedKind = ASSOC_KIND_TO_DEF_KIND[body.kind]
        if (definition.kind !== expectedKind) {
          throw badRequest(
            "wrong_kind",
            `Catalog entry has wrong kind (expected "${expectedKind}")`
          )
        }

        const assocKind = ASSOC_KIND_TO_DB[body.kind]
        const existing = row.associations
        const existingLink = existing.find(
          (l) => l.definitionId === body.definitionId && l.kind === assocKind
        )

        // Links the operation displaces: for an add, every existing link that
        // shares the equipment slot / title or bloodline upgrade group, or - for
        // a blessing - every existing blessing link; for a remove, the single link
        // being removed (an archived linked entry is always removable).
        const displaced: Array<{
          id: string
          definitionId: string
          name: string
          kind: string
        }> = []

        // Hoisted to the outer scope so the journal payload below can record a
        // chosen ring position (only meaningful on an add; inert on a remove).
        let isRingEquipment = false
        let ringPosition: "Ring 1" | "Ring 2" | undefined = undefined

        if (body.operation === "add") {
          // An archived catalog entry cannot be newly attached.
          if (definition.archived) {
            throw badRequest(
              "catalog_archived",
              "Catalog entry is archived and cannot be attached"
            )
          }
          if (existingLink) {
            throw badRequest(
              "duplicate",
              `This ${labelForKind(body.kind)} is already attached`
            )
          }
          // A blessing ADD must carry an exact tier (one of the eight). Reject a
          // missing tier before any link is displaced or written - after the
          // duplicate/archived checks so those rejections keep their own code, but
          // before the create - with a clear 400, so the DB CHECK never sees a null
          // BLESSING tier and the service never creates a null-tier blessing link.
          if (body.kind === "blessing" && body.tier == null) {
            throw badRequest(
              "invalid_blessing_tier",
              `Blessing "${definition.name}" requires an exact tier (one of the eight blessing tiers) when adding`
            )
          }

          const config = parseCatalogConfig(
            definition.kind,
            definition.config ?? {}
          )

          // Ring is ONE catalog slot but a character may wear two rings, one per
          // position. The chosen position MUST be supplied explicitly on a NEW add
          // of a Ring-slot item (never guessed from the config) and is FORBIDDEN on
          // any non-ring equipment add. A remove never requires it.
          const equipmentSlot = normalizeEquipmentSlot(config.slot)
          isRingEquipment =
            body.kind === "equipment" && equipmentSlot === "Ring"
          ringPosition = body.equipmentPosition
          if (body.operation === "add" && body.kind === "equipment") {
            if (isRingEquipment) {
              if (!ringPosition) {
                throw badRequest(
                  "ring_position_required",
                  `Ring equipment "${definition.name}" requires an explicit position (Ring 1 or Ring 2) when equipping`
                )
              }
            } else if (ringPosition != null) {
              throw badRequest(
                "position_not_allowed",
                `Equipment position "${ringPosition}" is only valid for a Ring-slot item`
              )
            }
          }

          // Equipping is gated by the item's level / race-type requirements. An
          // add whose requirement is currently unmet is rejected (400
          // `equipment_requirements_unmet`) BEFORE any link is removed or created;
          // acquiring inventory stock is still allowed (only the equip link is
          // gated). The requirement is checked against the character's RACE level
          // and race type, never the total/class level.
          if (body.kind === "equipment") {
            const raceState = deserializeState(row.state)
            const eligibility = equipmentEligibilityFor(config, raceState, row)
            if (!eligibility.eligible) {
              throw badRequest(
                "equipment_requirements_unmet",
                `${definition.name}: ${eligibility.reason}`
              )
            }
          }

          // A ranked title (its config carries `improvement`) is added through a
          // strict sequential rank gate. This runs before any link is removed, so a
          // rejected add writes nothing: the grade gate uses the character's race
          // grade (never the title's grade), the reason is mandatory, and rank
          // progression requires the immediately prior rank (or no prior for rank
          // 1). Ordinary titles carry no `improvement` and skip this entirely.
          if (body.kind === "title") {
            const improvement = titleImprovementForConfig(config)
            if (improvement) {
              const state = deserializeState(row.state)
              assertRankedTitleAdd(
                improvement,
                config,
                existing,
                state.race.grade,
                body.reason
              )
            } else {
              // Adding an UNRANKED title must never silently displace an existing
              // RANKED title in the same upgrade group: the ranked link is the
              // authority for a character's rank progression, so letting an
              // ordinary title replace it would bypass the rank sequence. Reject
              // BEFORE any same-group link is removed (so the ranked title stays),
              // while an ordinary unranked title replacing another ordinary
              // unranked title in a group remains allowed.
              const upgradeGroup = config.upgradeGroup as string | undefined
              if (upgradeGroup) {
                const sameGroupLinks = existing.filter(
                  (l) =>
                    l.kind === "TITLE" &&
                    definitionUpgradeGroup(l.definition) === upgradeGroup
                )
                const ranked = sameGroupLinks.find((l) => isRankedTitleLink(l))
                if (ranked) {
                  throw badRequest(
                    "title_rank_conflict",
                    `The upgrade group "${upgradeGroup}" is held by the ranked title "${ranked.definition.name}"; an ordinary title would bypass its rank progression - add it to a distinct group or remove the ranked title first`
                  )
                }
              }
            }
          }

          // A blessing never stacks. Adding one atomically replaces EVERY existing
          // blessing link on the character (active or archived - an archived link
          // is still removable, and exactly one active blessing may exist).
          if (body.kind === "blessing") {
            const sameKindLinks = existing.filter((l) => l.kind === "BLESSING")
            for (const link of sameKindLinks) {
              displaced.push({
                id: link.id,
                definitionId: link.definitionId,
                name: link.definition.name,
                kind: link.kind,
              })
              await tx.characterAssociation.deleteMany({
                where: {
                  characterId: id,
                  definitionId: link.definitionId,
                },
              })
            }
          }

          // Equipment add replaces whatever currently occupies the SAME slot. For a
          // Ring-slot item, ONLY the link occupying the SAME physical position is
          // removed - the other position is left untouched, so adding a Ring 1 item
          // never disturbs an already-equipped Ring 2 item (or vice versa). Remove
          // every matching link atomically - never leave a second effective item in
          // a position. Slot matching is done on the NORMALIZED canonical slot so a
          // legacy alias (`head`, `cloak`, ...) collides with its canonical
          // counterpart (`Head`, `Back`, ...).
          if (body.kind === "equipment") {
            const slot = normalizeEquipmentSlot(config.slot)
            if (slot) {
              const sameSlotLinks = existing.filter((l) => {
                if (l.kind !== "EQUIPMENT") return false
                if (definitionSlot(l.definition) !== slot) return false
                // For a ring, replace only the link whose persisted/derived
                // position matches the requested position. For a non-ring slot the
                // whole slot is the collision granularity.
                if (slot === "Ring") {
                  const otherConfig = parseCatalogConfig(
                    l.definition.kind,
                    l.definition.config ?? {}
                  )
                  const otherPos =
                    l.equipmentPosition ??
                    legacyRingPositionForConfig(otherConfig)
                  return otherPos === ringPosition
                }
                return true
              })
              for (const link of sameSlotLinks) {
                displaced.push({
                  id: link.id,
                  definitionId: link.definitionId,
                  name: link.definition.name,
                  kind: link.kind,
                })
                await tx.characterAssociation.deleteMany({
                  where: {
                    characterId: id,
                    definitionId: link.definitionId,
                  },
                })
              }
            }
          }

          // Title add never stacks superseded tiers: it removes every title that
          // currently occupies the same upgrade group.
          if (body.kind === "title") {
            const upgradeGroup = config.upgradeGroup as string | undefined
            if (upgradeGroup) {
              const sameGroupLinks = existing.filter(
                (l) =>
                  l.kind === "TITLE" &&
                  definitionUpgradeGroup(l.definition) === upgradeGroup
              )
              for (const link of sameGroupLinks) {
                displaced.push({
                  id: link.id,
                  definitionId: link.definitionId,
                  name: link.definition.name,
                  kind: link.kind,
                })
                await tx.characterAssociation.deleteMany({
                  where: {
                    characterId: id,
                    definitionId: link.definitionId,
                  },
                })
              }
            }
          }

          // A character may carry at most one bloodline. Adding one atomically
          // replaces EVERY existing bloodline link (active or archived) with the
          // new one - the same "supersede" semantics a blessing uses for its
          // singleton, so a character never holds two bloodlines.
          if (body.kind === "bloodline") {
            const sameKindLinks = existing.filter((l) => l.kind === "BLOODLINE")
            for (const link of sameKindLinks) {
              displaced.push({
                id: link.id,
                definitionId: link.definitionId,
                name: link.definition.name,
                kind: link.kind,
              })
              await tx.characterAssociation.deleteMany({
                where: {
                  characterId: id,
                  definitionId: link.definitionId,
                },
              })
            }
          }

          // A character may carry at most `maxTranscendentSkills` transcendent
          // skills (admin-configurable HouseRules cap, default 3). Adding one when
          // the count already equals (or exceeds) the cap is rejected before any
          // write; the count includes archived links so a grandfathered character
          // that exceeds the cap cannot add yet more, but can still remove.
          if (body.kind === "transcendent") {
            const transcendentCount = existing.filter(
              (l) => l.kind === "TRANSCENDENT"
            ).length
            if (transcendentCount >= maxTranscendentSkills) {
              throw badRequest(
                "link_limit",
                `This character already carries ${transcendentCount} transcendent skills (max ${maxTranscendentSkills})`
              )
            }
          }

          // Equipment is owner-linked: an add requires the character to own at
          // least one unit of the definition. A grandfathered link (legacyUnowned)
          // may be removed with zero stock, but a NEW link always needs stock.
          if (body.kind === "equipment") {
            const owned = await tx.characterInventoryItem.findUnique({
              where: {
                characterId_definitionId: {
                  characterId: id,
                  definitionId: definition.id,
                },
              },
            })
            if (!owned || owned.quantity < 1) {
              throw badRequest(
                "inventory_insufficient",
                `You own no "${definition.name}" to equip; add stock to your inventory first`
              )
            }
          }

          await tx.characterAssociation.create({
            data: {
              characterId: id,
              definitionId: definition.id,
              kind: assocKind as never,
              // Only equipment requiring ownership is grandfathered on existing
              // links; every newly created association is owned, never ownerless.
              ...(body.kind === "equipment" ? { legacyUnowned: false } : {}),
              // Persist the chosen ring position ONLY on a Ring-slot add. A
              // non-ring equipment link stores null (the schema default).
              ...(isRingEquipment ? { equipmentPosition: ringPosition } : {}),
              // A blessing add persists the exact tier it was granted at (it is
              // REQUIRED on a blessing add, so the link is never created with a
              // null tier); a link with no tier synthesizes no effect but is still
              // shown.
              ...(body.kind === "blessing" ? { blessingTier: body.tier } : {}),
            },
          })
        } else {
          if (!existingLink) {
            throw badRequest(
              "not_linked",
              `This ${labelForKind(body.kind)} is not attached to the character`
            )
          }
          displaced.push({
            id: existingLink.id,
            definitionId: existingLink.definitionId,
            name: existingLink.definition.name,
            kind: existingLink.kind,
          })
          await tx.characterAssociation.deleteMany({
            where: {
              characterId: id,
              definitionId: existingLink.definitionId,
            },
          })
        }

        // CAS: the character version must match the expected value. A mismatch
        // returns 409 and rolls back the link create/delete and the event.
        const updatedMany = await tx.character.updateMany({
          where: { id, version: body.version },
          data: { version: { increment: 1 } },
        })
        if (updatedMany.count !== 1) {
          throw conflict(
            "version_conflict",
            `Version mismatch: expected ${body.version}, got a newer version`
          )
        }

        const config = parseCatalogConfig(
          definition.kind,
          definition.config ?? {}
        )
        const improvement = titleImprovementForConfig(config)
        const rankedTitleAdd =
          body.kind === "title" &&
          body.operation === "add" &&
          improvement != null
        await tx.progressionEvent.create({
          data: {
            characterId: id,
            kind: "associate",
            payload: {
              operation: body.operation,
              kind: body.kind,
              definitionId: definition.id,
              ...(rankedTitleAdd ? { reason: (body.reason ?? "").trim() } : {}),
              definition: {
                id: definition.id,
                name: definition.name,
                kind: definition.kind,
                stableId: definition.stableId,
                grade: definition.grade,

                ...(body.kind === "equipment"
                  ? {
                      slot: (config.slot as string | undefined) ?? null,
                      // Record the chosen ring position on a Ring-slot add so the
                      // journal is auditable; absent on a non-ring add.
                      ...(isRingEquipment
                        ? { equipmentPosition: ringPosition }
                        : {}),
                    }
                  : {}),
                ...(body.kind === "title" || body.kind === "bloodline"
                  ? {
                      upgradeGroup:
                        (config.upgradeGroup as string | undefined) ?? null,
                    }
                  : {}),
                ...(body.kind === "title" && improvement != null
                  ? {
                      improvement: {
                        seriesId: improvement.seriesId,
                        rank: improvement.rank,
                        minRaceGrade: improvement.minRaceGrade,
                      },
                    }
                  : {}),
                ...(body.kind === "blessing"
                  ? {
                      // A blessing links a god (definitionId) and records the
                      // exact tier from the request, never from the god config.
                      tier: body.tier ?? null,
                    }
                  : {}),
              },
              added:
                body.operation === "add"
                  ? { id: definition.id, name: definition.name }
                  : null,
              removed: displaced,
            } as Prisma.InputJsonValue,
          },
        })

        const updated = (await tx.character.findUnique({
          where: { id },
          include: characterInclude,
        }))!
        return { character: await detailFor(updated, houseRules, tx) }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )
    .catch((err) => {
      // A concurrent association write that cannot serialize surfaces as P2034;
      // map it to a 409 rather than a raw 500.
      if (isSerializationFailure(err)) {
        throw conflict(
          "catalog_serialization_conflict",
          "Concurrent character association write conflict; retry the change"
        )
      }
      // A unique-constraint violation is ambiguous across association kinds, so
      // do NOT assume it is a blessing or bloodline singleton. Only a BLESSING or
      // BLOODLINE `add` (the two operations under a partial-unique index that
      // enforce the single-link invariant) is a singleton conflict; the partial
      // index itself is the other signal. Any OTHER association unique race (e.g.
      // a concurrent title/equipment link already occupying a slot) becomes a
      // generic 409 `association_conflict` the client can retry.
      if (isUniqueViolation(err)) {
        const isBlessingAdd =
          body.kind === "blessing" && body.operation === "add"
        const blessesBlessingIndex = isBlessingPartialIndexViolation(err)
        if (isBlessingAdd || blessesBlessingIndex) {
          throw conflict(
            "blessing_singleton_conflict",
            "A blessing is already attached to this character; add a new blessing to replace it"
          )
        }
        const isBloodlineAdd =
          body.kind === "bloodline" && body.operation === "add"
        const bloodlineIndex = isBloodlinePartialIndexViolation(err)
        if (isBloodlineAdd || bloodlineIndex) {
          throw conflict(
            "bloodline_singleton_conflict",
            "A bloodline is already attached to this character; add a new bloodline to replace it"
          )
        }
        throw conflict(
          "association_conflict",
          "A conflicting association already exists; retry the change"
        )
      }
      throw err
    })
}

/**
 * Set a set-once profession on an existing character, at its CURRENT race grade.
 *
 * This is the post-creation path that links a `professions` catalog entry to a
 * character whose creation did not pick one (or that must be assigned later by an
 * owner/admin). The profession is chosen EXACTLY at the character's current race
 * grade: the catalog entry's own `grade` must equal `state.race.grade` AND it must
 * declare a `grades[state.race.grade]` per-level config (the same per-grade gate a
 * create-time profession goes through). No level awards are granted and the
 * class/race tracks are never touched - only the `profession` track is added and
 * the `professionId` column/version are written under the transaction.
 *
 * Validations, in order:
 *   - Only an enlightened (non-monster) race with a class track may set a
 *     profession. A monster (independent race mode) or a legacy classless imported
 *     character is rejected with 400 `profession_requires_class`.
 *   - A character that already has a `professionId` or a `profession` track is
 *     rejected with 409 `profession_already_set` (set once).
 *   - The catalog entry must be an active (unarchived) `professions` definition.
 *   - The entry must be graded exactly at the character's current race grade
 *     (`profession_grade_mismatch` vs `profession_grade_config_missing`).
 *
 * The write CASes the character version (a stale version 409s `version_conflict`
 * and rolls back the state write + event) and runs under SERIALIZABLE isolation;
 * a concurrent write that fails to serialize is mapped to a retryable 409 rather
 * than a raw 500.
 */
export async function setCharacterProfession(
  id: string,
  body: { professionId: string; version: number },
  user: SessionUser
): Promise<{ character: CharacterDetail }> {
  return prisma
    .$transaction(
      async (tx) => {
        const row = await assertOwner(tx, id, user)
        const houseRules = await loadHouseRules(tx)
        const state = deserializeState(row.state)

        // A profession is a class-adjacent track: only an enlightened race that
        // advances through a class track may carry one. A monster (independent
        // race mode) and a legacy classless imported character both lack a class
        // track, so neither can gain a profession.
        if (state.race.mode === "independent" || !state.tracks["class"]) {
          throw badRequest(
            "profession_requires_class",
            "A profession can only be set on an enlightened race with a class track; this character has none"
          )
        }

        // Set once: a character that already carries a professionId or profession
        // track cannot be re-set to another profession.
        if (row.professionId != null || state.tracks["profession"]) {
          throw conflict(
            "profession_already_set",
            "Character already has a profession"
          )
        }

        const definition = await tx.catalogDefinition.findUnique({
          where: { id: body.professionId },
        })
        if (!definition) {
          throw notFound("catalog_not_found", "Profession not found")
        }
        if (definition.kind !== "professions") {
          throw badRequest(
            "wrong_kind",
            `Catalog entry has wrong kind (expected "professions")`
          )
        }
        if (definition.archived) {
          throw badRequest(
            "catalog_archived",
            "Profession is archived and cannot be set"
          )
        }

        const currentRaceGrade = state.race.grade
        // The profession must be selected AT the character's current race grade:
        // the catalog entry's own grade must match, and it must define a per-level
        // config for that grade (otherwise the profession track could never
        // advance).
        if (definition.grade !== currentRaceGrade) {
          throw badRequest(
            "profession_grade_mismatch",
            `Profession "${definition.name}" is grade ${definition.grade ?? "(unset)"}; character is race grade ${currentRaceGrade}`
          )
        }
        if (!trackHasGradeConfig(definition, currentRaceGrade)) {
          throw badRequest(
            "profession_grade_config_missing",
            `Profession "${definition.name}" defines no ${currentRaceGrade}-grade per-level config; add a "grades.${currentRaceGrade}" entry to set it`
          )
        }

        const professionTrack = {
          level: 0,
          quarter: 0,
          grade: currentRaceGrade,
          definitionId: `${definition.stableId}:${currentRaceGrade}`,
        }
        const nextState: CharacterState = {
          ...state,
          tracks: { ...state.tracks, profession: professionTrack },
        }
        const serialized = serializeState(nextState)

        // Grade-granted skills for the newly assigned profession at the grade the
        // new profession track is stamped with (the character's current race
        // grade). Resolve against the character's existing SKILL links inside the
        // transaction so a granted skill that is already owned (or collides in an
        // upgrade group) follows the duplicate/upgrade policy rather than stacking.
        const professionConfig = parseCatalogConfig(
          definition.kind,
          definition.config ?? {}
        )
        const grantGrade = currentRaceGrade
        const grantRequests: GradeGrantRequest[] = []
        for (const stableId of gradeSkillStableIdsFor(
          professionConfig,
          grantGrade
        )) {
          grantRequests.push({ stableId, grade: grantGrade })
        }
        const professionSkillMap = await loadUnarchivedSkillMap(tx)
        const gradeResolution = resolveGradeSkillGrants(
          ownedSkillLinksFrom(row.associations),
          grantRequests,
          professionSkillMap
        )

        // CAS: only the profession column, the engine state and the version change;
        // the class/race tracks and every ledger are left untouched.
        const updatedMany = await tx.character.updateMany({
          where: { id, version: body.version },
          data: {
            professionId: definition.id,
            state: serialized as Prisma.InputJsonValue,
            version: { increment: 1 },
          },
        })
        if (updatedMany.count !== 1) {
          throw conflict(
            "version_conflict",
            `Version mismatch: expected ${body.version}, got a newer version`
          )
        }

        // Persist the resolved grade-granted skill links alongside the profession
        // assignment (inside the same transaction), then journal the acquisition.
        await persistGradeSkillGrants(tx, id, gradeResolution)

        await tx.progressionEvent.create({
          data: {
            characterId: id,
            kind: "profession_set",
            payload: {
              professionId: definition.id,
              profession: {
                id: definition.id,
                name: definition.name,
                stableId: definition.stableId,
                grade: definition.grade,
              },
              before: {
                professionId: row.professionId,
                track: state.tracks["profession"] ?? null,
              },
              after: {
                professionId: definition.id,
                track: professionTrack,
              },
              ...(hasGradeGrantJournalEntries(gradeResolution.journal)
                ? { skillGrants: gradeResolution.journal }
                : {}),
            } as Prisma.InputJsonValue,
          },
        })

        const updated = (await tx.character.findUnique({
          where: { id },
          include: characterInclude,
        }))!
        return { character: await detailFor(updated, houseRules, tx) }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )
    .catch((err) => {
      // A concurrent profession set (or any concurrent character write) that cannot
      // serialize surfaces as P2034; map it to a 409 rather than a raw 500.
      if (isSerializationFailure(err)) {
        throw conflict(
          "catalog_serialization_conflict",
          "Concurrent character write conflict; retry the change"
        )
      }
      throw err
    })
}

export async function exportCharacter(
  id: string,
  user: SessionUser
): Promise<Record<string, unknown>> {
  const row = await assertOwner(prisma, id, user)
  const houseRules = await loadHouseRules(prisma)
  const config = configFor(row, houseRules.config)
  const state = deserializeState(row.state)
  // The live state is what `status` is computed from. It merges the immutable
  // stored state with effects/equipment synthesized from the currently linked,
  // unarchived catalog definitions. Exporting it (rather than only the stale
  // `state`) lets an importer reproduce the exact status without re-running the
  // association resolution.
  const live = await liveState(row)
  const events = await prisma.progressionEvent.findMany({
    where: { characterId: id },
    orderBy: { createdAt: "asc" },
  })
  const associations = row.associations.map((a) => ({
    id: a.id,
    definitionId: a.definitionId,
    kind: associationViewKind(a.kind),
    createdAt: a.createdAt.toISOString(),
    // Only equipment links carry the grandfathered marker and the ring position;
    // non-equipment links never export either (they cannot be grandfathered and
    // have no position).
    ...(a.kind === "EQUIPMENT"
      ? {
          legacyUnowned: a.legacyUnowned,
          // The physical ring position for a Ring-slot item; null for a non-ring
          // equipment link. The persisted per-link value wins; a legacy config that
          // still names Ring 1 / Ring 2 is the read-time fallback so no position is
          // ever silently dropped at export time.
          equipmentPosition:
            a.equipmentPosition ??
            legacyRingPositionForConfig(
              parseCatalogConfig(a.definition.kind, a.definition.config ?? {})
            ) ??
            null,
        }
      : {}),
    // A blessing link exports the exact tier it was granted at so the god + tier
    // relationship round-trips; the definition snapshot carries kind "gods".
    ...(a.kind === "BLESSING" ? { tier: a.blessingTier ?? null } : {}),
    definition: {
      id: a.definition.id,
      name: a.definition.name,
      kind: a.definition.kind,
      config: (a.definition.config ?? {}) as Record<string, unknown>,
      archived: a.definition.archived,
      stableId: a.definition.stableId,
      updatedAt: a.definition.updatedAt.toISOString(),
    },
  }))
  // Export owned inventory as stable identifiers so a re-import on another server
  // instance can resolve each definition against its own catalog. Only the kinds
  // that can be inventoried (equipment / items) are emitted; the quantity is
  // the owned count, never 0 (an absent entry means zero owned stock).
  const inventory = row.inventory.map((item) => ({
    definition: {
      kind: item.definition.kind === "items" ? "items" : "equipment",
      stableId: item.definition.stableId,
    },
    quantity: item.quantity,
  }))
  // Export every saved currency balance as a STABLE identifier + the exact held
  // amount (including a legal 0). The reference uses the catalog `stableId` (never
  // the DB id) so a re-import on another server instance can resolve it against
  // its own catalog, and an ARCHIVED currency definition's balance is still
  // exported - a hidden amount must survive a backup round-trip. Only rows whose
  // definition is actually a `currencies` entry contribute.
  const currencyBalances = (
    await prisma.characterCurrencyBalance.findMany({
      where: { characterId: id },
      include: { definition: true },
    })
  )
    .filter((b) => b.definition?.kind === "currencies")
    .map((b) => ({
      definition: {
        kind: "currencies",
        stableId: b.definition.stableId,
      },
      amount: b.amount,
    }))
  const identity = {
    name: row.name,
    description: row.description,
    // Profile metadata is exported verbatim (nullable) so a backup round-trips
    // these fields exactly; an absent field exports as null.
    nickname: row.nickname,
    pronouns: row.pronouns,
    ageDescription: row.ageDescription,
    appearance: row.appearance,
    biography: row.biography,
    notes: row.notes,
    origin: row.origin,
    race: { stableId: row.race?.stableId ?? null },
    class: { stableId: row.class?.stableId ?? null },
    profession: row.profession ? { stableId: row.profession.stableId } : null,
  }
  // Export skill offers with STABLE catalog identifiers so a re-import on another
  // server instance can resolve each option/selection against its own catalog.
  // `offeredAt`, `selectedAt` and `canceledAt` are emitted as ISO strings; the
  // importer parses them back to Dates. `generation` and `canceledAt` are part of
  // the v6 schema, re-exported verbatim so a canceled offer's identity and
  // cancellation timestamp survive a backup round-trip unchanged (append-only).
  const skillOffers = row.skillOffers.map((offer) => {
    const selectedOption = offer.options.find(
      (o) => o.definitionId === offer.selectedDefinitionId
    )
    return {
      track: offer.track,
      level: offer.level,
      choiceGroup: offer.choiceGroup,
      generation: offer.generation,
      canceledAt: offer.canceledAt ? offer.canceledAt.toISOString() : null,
      offeredAt: offer.offeredAt.toISOString(),
      selectedStableId: selectedOption?.definition?.stableId ?? null,
      selectedAt: offer.selectedAt ? offer.selectedAt.toISOString() : null,
      options: offer.options.map((o) => ({
        stableId: o.definition?.stableId ?? "",
        nameSnapshot: o.nameSnapshot,
        configSnapshot: (o.configSnapshot ?? {}) as Record<string, unknown>,
      })),
      // Schedule-credit provenance: a scheduled offer carries BOTH the earned grade
      // and the selected track's stableId (and, when the credit was earned on a
      // class/profession track, the snapshotted class). A legacy offer (all null)
      // omits them so its backup shape is unchanged; a mismatched row is normalized
      // to the pair (with null for the missing half) rather than dropped, so a
      // re-import still validates against the schema's required-together rule.
      ...(offer.earnedGrade != null || offer.trackDefinitionStableId != null
        ? {
            earnedGrade: offer.earnedGrade ?? null,
            trackDefinitionStableId: offer.trackDefinitionStableId ?? null,
            classStableIdAtEarn: offer.classStableIdAtEarn ?? null,
          }
        : {}),
    }
  })
  return {
    schema: IMPORT_SCHEMA_V8,
    rulesetVersion: IMPORT_RULESET_VERSION,
    identity,
    character: await listItemFor(row, houseRules, true),
    state,
    liveState: live,
    status: await statusFor(row, config),
    // Informational derived quality for the exporting UI; NOT authoritative on
    // import (the importer recomputes it from the re-linked associations).
    isTranscendent: isTranscendentFor(row),
    associations,
    inventory,
    currencyBalances,
    events: events.map((e) => ({
      kind: e.kind,
      payload: e.payload,
      createdAt: e.createdAt.toISOString(),
    })),
    skillOffers,
  }
}

// ------------------------------------------------------------------ //
// Trusted-backup import (v3 / v4)
// ------------------------------------------------------------------ //
//
// A trusted-backup document (v3 or v4) is *not* authoritative server-verified
// state. Every catalog reference (identity race/class/profession, each
// association definition, each inventory definition, each skill-offer
// option/selection) is resolved by `kind` + `stableId` to an EXISTING catalog
// definition; no catalog content is auto-created, and a
// missing/mismatched/archived required definition is rejected with an actionable
// 400. `liveState` / `status` in the document are advisory and are ignored -
// status is recomputed from the imported state. The imported history is stored as
// `import_history` events (source provenance, not valid live IDs) and an `import`
// marker event is appended.
//
// The v4 document additionally carries owned inventory quantities and a
// `legacyUnowned` marker on equipment associations. Inventory is validated and
// resolved transactionally alongside the associations and events; an equipment
// link that is NOT grandfathered (`legacyUnowned: false`) requires the backup to
// import at least one owned unit of the matching definition, while a
// grandfathered link may import with zero stock. A legacy v3 document (no
// inventory, no marker) imports no stock and grandfathers every equipment link.

type CatalogLookupRow = {
  id: string
  kind: string
  stableId: string
  name: string
  config: unknown
  archived: boolean
}

async function findCatalogByStableId(
  db: DbClient,
  kind: string,
  stableId: string
): Promise<CatalogLookupRow | null> {
  const row = await db.catalogDefinition.findUnique({
    where: { kind_stableId: { kind: kind as never, stableId } },
  })
  if (!row) return null
  return row
}

async function resolveIdentityRef(
  db: DbClient,
  kind: string,
  stableId: string | null,
  label: string
): Promise<CatalogLookupRow> {
  const def = stableId ? await findCatalogByStableId(db, kind, stableId) : null
  if (!def) {
    throw badRequest(
      "import_catalog_missing",
      `Imported ${label} "${stableId ?? "(unset)"}" (kind "${kind}") is not in the catalog`
    )
  }
  if (def.kind !== kind) {
    throw badRequest(
      "import_kind_mismatch",
      `Imported ${label} stableId "${stableId}" is kind "${def.kind}", expected "${kind}"`
    )
  }
  if (def.archived) {
    throw badRequest(
      "import_catalog_archived",
      `Imported ${label} "${def.name}" (${def.stableId}) is archived; re-enable it in the catalog before importing`
    )
  }
  return def
}

const ASSOC_KIND_TO_DB = {
  title: "TITLE",
  equipment: "EQUIPMENT",
  skill: "SKILL",
  blessing: "BLESSING",
  bloodline: "BLOODLINE",
  transcendent: "TRANSCENDENT",
} as const

const ASSOC_KIND_TO_DEF_KIND = {
  title: "titles",
  equipment: "equipment",
  skill: "skills",
  // A blessing link points at a `gods` definition (the legacy `blessings` catalog
  // kind was retired); the exact blessing tier lives on the association link.
  blessing: "gods",
  bloodline: "bloodlines",
  transcendent: "transcendent_skills",
} as const

type ResolvedAssoc = {
  sourceKind:
    "title" | "equipment" | "skill" | "blessing" | "bloodline" | "transcendent"
  dbKind:
    "TITLE" | "EQUIPMENT" | "SKILL" | "BLESSING" | "BLOODLINE" | "TRANSCENDENT"
  definitionId: string
  definition: CatalogLookupRow
  /**
   * Grandfathered status persisted on the association. Only meaningful for
   * EQUIPMENT links: a v4 doc carries the exported marker verbatim, while any
   * equipment link from a legacy v3 doc (no marker) is grandfathered (true).
   * Non-equipment links are always false.
   */
  legacyUnowned: boolean
  /**
   * The physical ring position for a Ring-slot EQUIPMENT link, or null for a
   * non-ring equipment link. A ring link with no resolvable position is rejected
   * before this point (no guessing); the position is sourced from the document
   * (v5) or derived from the CURRENT catalog config's legacy Ring 1 / Ring 2 slot
   * (v3/v4), never from the advisory liveState.
   */
  equipmentPosition: "Ring 1" | "Ring 2" | null
  /**
   * The exact blessing tier carried by a v7 blessing association. Null for every
   * non-blessing kind and for any legacy v3-v6 association (which cannot carry a
   * blessing - those are rejected upstream, so this is null in practice on
   * legacy docs).
   */
  tier?: BlessingTier | null
}

/**
 * A resolved (validated) inventory entry: the referenced catalog definition is
 * located by local `kind` + `stableId` and the owned quantity is unaltered. The
 * catalog row may be archived - archived stock is inert but still imported.
 */
type ResolvedInventoryItem = {
  definitionId: string
  definition: CatalogLookupRow
  quantity: number
}

/**
 * A resolved (validated) currency balance: the referenced catalog definition is
 * located by local `kind` + `stableId` (the definition may be archived - a hidden
 * amount must survive an import) and the held amount is unaltered.
 */
type ResolvedCurrencyBalance = {
  definitionId: string
  definition: CatalogLookupRow
  amount: number
}

type ResolveAssocOpts = {
  /** True for a v4 document; false for a legacy v3 doc (no inventory model). */
  enforceOwnership: boolean
  /** Resolved owned stock keyed by local catalog definition id (v4 only). */
  ownedStockByDefId: Map<string, number>
  /**
   * The admin-configurable transcendent-skill cap (default 3). An imported
   * document carrying more transcendent links than this is rejected with
   * `import_link_collision` before any write.
   */
  maxTranscendentSkills: number
  /**
   * The imported character's race grade (from the backup state). Used to enforce
   * a ranked title's minRaceGrade gate on import; a ranked title whose required
   * grade exceeds the backup's race grade is rejected before any write.
   */
  raceGrade: Grade
  /**
   * Whether a missing ring position may be recovered from the backup's own
   * `definition.config.slot` snapshot. True for a legacy v3/v4 document, whose
   * definition reference carries no per-link `equipmentPosition` but MAY carry a
   * pre-migration `definition.config.slot` naming `Ring 1`/`Ring 2`; false for a
   * v5 document, which carries the position explicitly and never trusts the
   * snapshot.
   */
  allowConfigSnapshotPosition: boolean
}

/**
 * Resolve the v4 `inventory` array against the local catalog. Every reference is
 * matched by local `kind` + `stableId` to EXISTING catalog definitions (archived
 * stock is allowed and imported inert); a missing definition or a duplicated
 * definition reference is rejected before any DB write. The array is already
 * bounded (<=500) and quantity-validated (1..999999) by the document schema.
 */
async function resolveInventoryRefs(
  db: DbClient,
  inventory: Extract<
    CharacterImportDocument,
    {
      schema:
        | typeof IMPORT_SCHEMA_V4
        | typeof IMPORT_SCHEMA_V5
        | typeof IMPORT_SCHEMA_V6
    }
  >["inventory"]
): Promise<ResolvedInventoryItem[]> {
  const seen = new Set<string>()
  const resolved: ResolvedInventoryItem[] = []
  for (const item of inventory) {
    const def = await findCatalogByStableId(
      db,
      item.definition.kind,
      item.definition.stableId
    )
    if (!def) {
      throw badRequest(
        "import_stock_missing",
        `Imported inventory references catalog "${item.definition.stableId}" (${item.definition.kind}) which is not in the catalog`
      )
    }
    if (seen.has(def.id)) {
      throw badRequest(
        "import_duplicate_stock",
        `Catalog "${def.name}" appears more than once in imported inventory`
      )
    }
    seen.add(def.id)
    resolved.push({
      definitionId: def.id,
      definition: def,
      quantity: item.quantity,
    })
  }
  return resolved
}

/**
 * Resolve the v8 `currencyBalances` array against the local catalog. Every
 * reference is matched by local `kind` + `stableId` to EXISTING `currencies`
 * catalog definitions; an ARCHIVED currency definition is allowed (a hidden
 * amount must survive an import). A missing definition, a wrong-kind reference
 * (the stableId belongs to a non-`currencies` catalog entry), a duplicated
 * definition reference, or an out-of-range amount is rejected before any DB
 * write. The array is already bounded (<=500) and amount-validated by the
 * document schema.
 */
async function resolveCurrencyBalances(
  db: DbClient,
  balances: Extract<
    CharacterImportDocument,
    { schema: typeof IMPORT_SCHEMA_V8 }
  >["currencyBalances"]
): Promise<ResolvedCurrencyBalance[]> {
  const seen = new Set<string>()
  const resolved: ResolvedCurrencyBalance[] = []
  for (const entry of balances) {
    // The only kind that can be a currency balance is `currencies`.
    if (entry.definition.kind !== "currencies") {
      throw badRequest(
        "import_currency_wrong_kind",
        `Imported balance "${entry.definition.stableId}" has definition kind "${entry.definition.kind}", expected "currencies"`
      )
    }
    const def = await findCatalogByStableId(
      db,
      "currencies",
      entry.definition.stableId
    )
    if (!def) {
      // Distinguish a wrong-kind reference (the stableId exists under another
      // catalog kind) from a genuinely missing currency, so the error is
      // actionable rather than a blanket "not in the catalog".
      const other = await db.catalogDefinition.findFirst({
        where: { stableId: entry.definition.stableId },
      })
      if (other) {
        throw badRequest(
          "import_currency_wrong_kind",
          `Imported balance "${entry.definition.stableId}" is catalog kind "${other.kind}", expected "currencies"`
        )
      }
      throw badRequest(
        "import_currency_missing",
        `Imported balance references catalog currency "${entry.definition.stableId}" which is not in the catalog`
      )
    }
    if (seen.has(def.stableId)) {
      throw badRequest(
        "import_duplicate_currency",
        `Catalog "${def.name}" appears more than once in imported currency balances`
      )
    }
    seen.add(def.stableId)
    if (
      !Number.isInteger(entry.amount) ||
      entry.amount < 0 ||
      entry.amount > CURRENCY_AMOUNT_MAX
    ) {
      throw badRequest(
        "import_currency_invalid",
        `Currency amount for "${def.name}" must be a whole number 0..${CURRENCY_AMOUNT_MAX}`
      )
    }
    resolved.push({
      definitionId: def.id,
      definition: def,
      amount: entry.amount,
    })
  }
  return resolved
}

function associationLegacyUnowned(
  a: CharacterImportDocument["associations"][number]
): boolean | undefined {
  return (a as { legacyUnowned?: boolean }).legacyUnowned
}

function associationEquipmentPosition(
  a: CharacterImportDocument["associations"][number]
): "Ring 1" | "Ring 2" | null | undefined {
  return (a as { equipmentPosition?: "Ring 1" | "Ring 2" | null })
    .equipmentPosition
}

function associationTier(
  a: CharacterImportDocument["associations"][number]
): BlessingTier | null | undefined {
  return (a as { tier?: BlessingTier | null }).tier
}

async function resolveAssociationRefs(
  db: DbClient,
  assocs: CharacterImportDocument["associations"],
  opts: ResolveAssocOpts
): Promise<ResolvedAssoc[]> {
  // A character may hold AT MOST ONE blessing link (active or archived). Count
  // every blessing ref first so a >1 total is ALWAYS a link collision
  // (`import_link_collision`) - whether the same definition is referenced twice,
  // or two different blessings (one possibly archived) are referenced - and
  // never a generic duplicate-link error. This runs BEFORE the per-ref duplicate
  // guard below, so `import_duplicate_link` only ever applies to non-blessing
  // kinds; a duplicated blessing is reported as a collision, not a duplicate.
  const blessingRefs = assocs.filter((a) => a.kind === "blessing")
  if (blessingRefs.length > 1) {
    throw badRequest(
      "import_link_collision",
      `More than one blessing: "${blessingRefs[0].definition.stableId}" and "${blessingRefs[1].definition.stableId}"`
    )
  }

  // A character may hold AT MOST ONE bloodline link (active or archived), the
  // same singleton the partial unique index enforces at write time. Count every
  // bloodline ref first so a >1 total is always a link collision, never a generic
  // duplicate-link error (same rationale as the blessing guard above).
  const bloodlineRefs = assocs.filter((a) => a.kind === "bloodline")
  if (bloodlineRefs.length > 1) {
    throw badRequest(
      "import_link_collision",
      `More than one bloodline: "${bloodlineRefs[0].definition.stableId}" and "${bloodlineRefs[1].definition.stableId}"`
    )
  }

  // A character may import at most `maxTranscendentSkills` transcendent links.
  // A backup that exceeds the configured cap is rejected before any write; the
  // imported document is a NEW character, so the count is simply the number of
  // transcendent refs (no pre-existing links to add to).
  const transcendentRefs = assocs.filter((a) => a.kind === "transcendent")
  if (transcendentRefs.length > opts.maxTranscendentSkills) {
    throw badRequest(
      "import_link_collision",
      `Imported character has ${transcendentRefs.length} transcendent skills, but the cap is ${opts.maxTranscendentSkills}`
    )
  }

  const seen = new Set<string>()
  const resolved: ResolvedAssoc[] = []
  for (const a of assocs) {
    const expectedDefKind = ASSOC_KIND_TO_DEF_KIND[a.kind]
    if (a.definition.kind !== expectedDefKind) {
      throw badRequest(
        "import_kind_mismatch",
        `Association "${a.definition.stableId}" has definition kind "${a.definition.kind}", but a "${a.kind}" association requires "${expectedDefKind}"`
      )
    }
    const def = await findCatalogByStableId(
      db,
      a.definition.kind,
      a.definition.stableId
    )
    if (!def) {
      throw badRequest(
        "import_link_missing",
        `Association "${a.kind}" references catalog "${a.definition.stableId}" (${a.definition.kind}) which is not in the catalog`
      )
    }
    if (seen.has(def.id)) {
      throw badRequest(
        "import_duplicate_link",
        `Catalog "${def.name}" is linked more than once`
      )
    }
    seen.add(def.id)

    // A ranked title (its catalog config carries `improvement`) may be imported at
    // ANY rank without prior rank history (a backup is a trusted association
    // snapshot), but only if the imported character's race grade meets the title's
    // minRaceGrade. A legacy backup's title simply has no improvement metadata and
    // is treated as unranked (no check).
    if (a.kind === "title") {
      const defConfig = parseCatalogConfig(def.kind, def.config ?? {})
      const improvement = titleImprovementForConfig(defConfig)
      if (improvement) {
        if (
          gradeOrderIndex(opts.raceGrade) <
          gradeOrderIndex(improvement.minRaceGrade)
        ) {
          throw badRequest(
            "import_grade_blocked",
            `Imported "${def.name}" requires race grade ${improvement.minRaceGrade} or higher, but the backup's race grade is ${opts.raceGrade}`
          )
        }
      }
    }

    let legacyUnowned: boolean
    let equipmentPosition: "Ring 1" | "Ring 2" | null = null
    if (a.kind === "equipment") {
      // v3 backups have no inventory model and no marker: a grandfathered link may
      // stay equipped regardless of stock. v4/v5 carry the exported marker verbatim;
      // only a non-grandfathered (false) link REQUIRES owned stock.
      legacyUnowned = opts.enforceOwnership
        ? (associationLegacyUnowned(a) ?? false)
        : true
      if (!legacyUnowned) {
        const owned = opts.ownedStockByDefId.get(def.id) ?? 0
        if (owned < 1) {
          throw badRequest(
            "import_stock_missing",
            `Equipment "${def.name}" (${def.stableId}) is linked but not grandfathered, and the backup owns no stock of it; add inventory or mark it legacyUnowned:true`
          )
        }
      }
      // Validate the category-position match against the CURRENT catalog. Ring is
      // ONE slot but a character may wear two; the position MUST be explicit. A v5
      // backup carries it verbatim and never trusts anything else - not the CURRENT
      // catalog's legacy slot and not the backup's own definition.config.slot
      // snapshot - so an explicit null (or a missing field) on a Ring link is a
      // hard rejection. A v3/v4 backup carries no position, so derive one from the
      // CURRENT catalog's legacy Ring 1 / Ring 2 slot first, and only when the
      // current slot has been migrated to the generic "Ring" (so the catalog row
      // itself provides no position) recover it from the backup's own
      // definition.config.slot snapshot (a pre-migration catalog still named
      // Ring 1 / Ring 2). Never from the advisory liveState/status. A Ring-slot
      // link with no resolvable position is rejected with actionable guidance
      // rather than guessed; a non-ring link carrying a ring position is rejected
      // as a category mismatch.
      const defConfig = parseCatalogConfig(def.kind, def.config ?? {})
      const isRing = slotForConfig(defConfig) === "Ring"
      const docPos = associationEquipmentPosition(a)
      if (isRing) {
        let derived: "Ring 1" | "Ring 2" | null | undefined
        if (opts.allowConfigSnapshotPosition) {
          // v3/v4 only: no per-link position exists in the document.
          derived = docPos ?? legacyRingPositionForConfig(defConfig)
          if (derived == null) {
            derived = legacyRingPositionForConfig(a.definition.config ?? {})
          }
        } else {
          // v5: the backup's own report is authoritative (null = explicit "no
          // position"), so no fallback to the current catalog's legacy slot.
          derived = docPos
        }
        if (!derived) {
          throw badRequest(
            "import_ring_position_required",
            `Ring equipment "${def.name}" (${def.stableId}) has no ring position; re-export the backup as primal-character/5 with per-link equipmentPosition values (or set the catalog slot to "Ring 1"/"Ring 2")`
          )
        }
        equipmentPosition = derived
      } else if (docPos != null) {
        throw badRequest(
          "import_ring_position_mismatch",
          `Equipment "${def.name}" (${def.stableId}) is not a Ring-slot item but carries ring position "${docPos}"`
        )
      }
    } else {
      // Only equipment links can be grandfathered.
      if (associationLegacyUnowned(a) === true) {
        throw badRequest(
          "import_legacy_unowned_non_equipment",
          `Association "${a.definition.stableId}" (${a.kind}) carries legacyUnowned:true, but only equipment links may be grandfathered`
        )
      }
      legacyUnowned = false
    }

    resolved.push({
      sourceKind: a.kind,
      dbKind: ASSOC_KIND_TO_DB[a.kind],
      definitionId: def.id,
      definition: def,
      legacyUnowned,
      equipmentPosition,
      // A v7 blessing association carries the exact tier it was granted at.
      tier: a.kind === "blessing" ? (associationTier(a) ?? null) : null,
    })
  }
  return resolved
}

/**
 * Reject a pair of active (unarchived) associations that would collide. Active
 * equipment links sharing a slot, title / skill / bloodline links sharing an
 * upgrade group, and more than one active blessing all collide. Archived
 * definitions are inert and never collide. This mirrors the runtime invariant
 * enforced by `associateCharacter` and `assertNoLinkCollision`.
 *
 * The bloodline singleton and transcendent cap are counted across ALL references
 * (active or archived): a character may hold at most one bloodline link and at
 * most `maxTranscendentSkills` transcendent links, regardless of archive state.
 */
function assertAssocCollisions(
  resolved: ResolvedAssoc[],
  maxTranscendentSkills: number
): void {
  const slots = new Map<string, string>()
  const titleGroups = new Map<string, string>()
  const skillGroups = new Map<string, string>()
  // A character may hold AT MOST ONE total BLESSING link (active OR archived).
  // Count every blessing BEFORE the archived-inert skip so an active+archived
  // pair is rejected: an archived blessing still occupies the single slot until
  // it is replaced or removed. All other kinds keep the archived-inert skip.
  let blessingName: string | null = null
  // A character may hold AT MOST ONE total BLOODLINE link (active OR archived),
  // the singleton enforced by the DB partial unique index.
  let bloodlineName: string | null = null
  // A character may hold at most `maxTranscendentSkills` transcendent links
  // (active OR archived); count everything so a grandfathered over-cap character
  // is still rejected on import.
  let transcendentCount = 0
  for (const r of resolved) {
    if (r.sourceKind === "blessing") {
      if (blessingName != null) {
        throw badRequest(
          "import_link_collision",
          `More than one blessing: "${blessingName}" and "${r.definition.name}"`
        )
      }
      blessingName = r.definition.name
      continue
    }
    if (r.sourceKind === "bloodline") {
      if (bloodlineName != null) {
        throw badRequest(
          "import_link_collision",
          `More than one bloodline: "${bloodlineName}" and "${r.definition.name}"`
        )
      }
      bloodlineName = r.definition.name
      continue
    }
    if (r.sourceKind === "transcendent") {
      transcendentCount++
      continue
    }
    if (r.definition.archived) continue
    const config = parseCatalogConfig(
      r.definition.kind,
      r.definition.config ?? {}
    )
    if (r.sourceKind === "equipment") {
      // Ring is ONE catalog slot but a character may wear two rings, so the
      // collision key is the physical position (Ring 1 / Ring 2), never the single
      // "Ring" slot - two rings on distinct positions coexist, two on the same one
      // collide. A non-ring item keeps the normalized slot as its key.
      const key = equipmentCollisionKey(r.equipmentPosition, config)
      if (key) {
        const existing = slots.get(key)
        if (existing) {
          throw badRequest(
            "import_link_collision",
            `Equipment slot "${key}" is occupied by both "${existing}" and "${r.definition.name}"`
          )
        }
        slots.set(key, r.definition.name)
      }
    } else if (r.sourceKind === "title") {
      const group = upgradeGroupForConfig(config)
      if (group) {
        const existing = titleGroups.get(group)
        if (existing) {
          throw badRequest(
            "import_link_collision",
            `Title upgrade group "${group}" is occupied by both "${existing}" and "${r.definition.name}"`
          )
        }
        titleGroups.set(group, r.definition.name)
      }
    } else if (r.sourceKind === "skill") {
      const group = upgradeGroupForConfig(config)
      if (group) {
        const existing = skillGroups.get(group)
        if (existing) {
          throw badRequest(
            "import_link_collision",
            `Skill upgrade group "${group}" is occupied by both "${existing}" and "${r.definition.name}"`
          )
        }
        skillGroups.set(group, r.definition.name)
      }
    }
  }
  // Report the transcendent over-cap BEFORE ending, so a grandfather-exceeding
  // backup fails the import with an actionable `import_link_collision`.
  if (transcendentCount > maxTranscendentSkills) {
    throw badRequest(
      "import_link_collision",
      `Imported character has ${transcendentCount} transcendent skills, but the cap is ${maxTranscendentSkills}`
    )
  }
}

type ResolvedOfferOption = {
  definitionId: string
  stableId: string
  nameSnapshot: string
  configSnapshot: Record<string, unknown>
}

type ResolvedOffer = {
  track: string
  level: number
  choiceGroup: string
  generation: number
  canceledAt: Date | null
  offeredAt: Date
  selectedDefinitionId: string | null
  selectedAt: Date | null
  options: ResolvedOfferOption[]
  /** Schedule-credit provenance (nullable on legacy/imported offers). */
  earnedGrade: string | null
  trackDefinitionStableId: string | null
  /**
   * Catalog stableId of the character's selected CLASS at the moment the credit
   * was earned, snapshotted at EARNING time for class/profession credits and null
   * for a monster race credit. Populated only on a v7 scheduled offer; null on
   * legacy/imported offers. Priority-only (drives deterministic option ordering),
   * never eligibility.
   */
  classStableIdAtEarn: string | null
}

function parseOfferDate(value: string | number | null | undefined): Date {
  if (value == null) return new Date()
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed
}

/**
 * Parse a skill-offer `canceledAt` timestamp STRICTLY: a supplied value must
 * represent a real, finite Date or the import is rejected with 400
 * `invalid_import` - it is never silently restamped to "now" (the same hard
 * rejection the document schema enforces for a direct service caller that bypasses
 * the route's Zod check).
 */
function parseCanceledAtStrict(value: string | number): Date {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw badRequest(
      "invalid_import",
      `Skill offer canceledAt "${String(value)}" is not a valid timestamp`
    )
  }
  return parsed
}

async function resolveSkillOfferRefs(
  db: DbClient,
  offers: CharacterImportDocument["skillOffers"]
): Promise<ResolvedOffer[]> {
  const seen = new Set<string>()
  const activeByBaseKey = new Map<string, string>()
  const result: ResolvedOffer[] = []
  for (const o of offers) {
    // v3/v4/v5 documents omit generation/canceledAt; they default to 0/null. A v6
    // document carries them explicitly and they are validated at the schema layer.
    const generation = o.generation ?? 0
    const baseKey = `${o.track}:${o.level}:${o.choiceGroup}`
    const key = `${baseKey}:${generation}`
    if (seen.has(key)) {
      throw badRequest(
        "import_duplicate_offer",
        `Duplicate skill offer for ${o.track} level ${o.level} choice group "${o.choiceGroup}" generation ${generation}`
      )
    }
    seen.add(key)

    // A selected + canceled offer is contradictory: a canceled (voided) offer is
    // never answered, so it must not carry a selection.
    if (o.selectedStableId != null && o.canceledAt != null) {
      throw badRequest(
        "import_selected_canceled",
        `Offer for ${o.track} level ${o.level} choice group "${o.choiceGroup}" generation ${generation} is both selected and canceled`
      )
    }

    // At most one ACTIVE (canceledAt null) offer per base key. Multiple
    // generations may coexist as historical records (a canceled offer superseded
    // by a new generation), but only one may be answerable.
    if (o.canceledAt == null) {
      const existing = activeByBaseKey.get(baseKey)
      if (existing != null) {
        throw badRequest(
          "import_offer_conflict",
          `Multiple active skill offers for ${o.track} level ${o.level} choice group "${o.choiceGroup}" (generations ${existing} and ${generation})`
        )
      }
      activeByBaseKey.set(baseKey, String(generation))
    }

    const options: ResolvedOfferOption[] = []
    const optionStableIds = new Set<string>()
    for (const opt of o.options) {
      const def = await findCatalogByStableId(db, "skills", opt.stableId)
      if (!def) {
        throw badRequest(
          "import_option_missing",
          `Skill option "${opt.stableId}" is not in the catalog`
        )
      }
      if (optionStableIds.has(def.stableId)) {
        throw badRequest(
          "import_duplicate_option",
          `Skill "${def.name}" appears twice in the same offer`
        )
      }
      optionStableIds.add(def.stableId)
      options.push({
        definitionId: def.id,
        stableId: def.stableId,
        nameSnapshot: opt.nameSnapshot,
        configSnapshot: opt.configSnapshot ?? {},
      })
    }

    let selectedDefinitionId: string | null = null
    if (o.selectedStableId != null) {
      if (!optionStableIds.has(o.selectedStableId)) {
        throw badRequest(
          "import_selected_not_in_options",
          `Offer for ${o.track} level ${o.level} selects "${o.selectedStableId}", which is not one of its options`
        )
      }
      // A selection only needs the selectedStableId to be among this offer's
      // options and to resolve to a valid catalog definition. It need NOT also
      // remain as a current skill association: a later upgrade in the same group
      // removes the old link, but the historical answer is still a faithful
      // record and must not block the import.
      selectedDefinitionId = options.find(
        (opt) => opt.stableId === o.selectedStableId
      )!.definitionId
    }

    // Schedule-credit provenance. Only a v7 offer carries these fields (validated
    // to be present together by the schema); a legacy v3/v4/v5/v6 offer omits them
    // and reads back as null, so a scheduled offer's provenance survives a backup
    // round-trip exactly while an older offer stays unchanged.
    const earnedGrade = "earnedGrade" in o ? (o.earnedGrade ?? null) : null
    const trackDefinitionStableId =
      "trackDefinitionStableId" in o
        ? (o.trackDefinitionStableId ?? null)
        : null
    // `classStableIdAtEarn` (the earning-time class snapshot) is meaningful ONLY
    // on a scheduled class/profession credit: BOTH provenance halves present AND
    // the offer is on the 'class'/'profession' track. A monster RACE credit has
    // no earned class and a legacy/untyped offer (no provenance) has no snapshot,
    // so on those the value is normalized to null - never attach earned-class
    // priority where none belongs. This is the same invariant the document schema
    // enforces, re-applied here so a direct service caller that bypasses the
    // route's Zod check (and an already-passed malformed document) never persists
    // a stray class snapshot.
    const isClassProfTrack = o.track === "class" || o.track === "profession"
    const hasProvenance = earnedGrade != null && trackDefinitionStableId != null
    const classStableIdAtEarn =
      "classStableIdAtEarn" in o && hasProvenance && isClassProfTrack
        ? (o.classStableIdAtEarn ?? null)
        : null

    result.push({
      track: o.track,
      level: o.level,
      choiceGroup: o.choiceGroup,
      generation,
      // canceledAt is parsed strictly (reject -> 400 invalid_import, never "now"),
      // so a canceled offer's cancellation instant is preserved exactly. The
      // legacy offeredAt/selectedAt keep the historical fallback (a missing value
      // restamps to now) for backward compatibility.
      canceledAt:
        o.canceledAt != null ? parseCanceledAtStrict(o.canceledAt) : null,
      offeredAt: parseOfferDate(o.offeredAt),
      selectedDefinitionId,
      selectedAt: selectedDefinitionId ? parseOfferDate(o.selectedAt) : null,
      options,
      earnedGrade,
      trackDefinitionStableId,
      classStableIdAtEarn,
    })
  }
  return result
}

/**
 * Remap the imported state's engine-internal definitionIds to the LOCAL catalog
 * forms so subsequent engine mutations resolve against this server's catalog:
 *   - current class/profession track definitionId -> the id selected by
 *     `resolveTrackDefinition` for the imported state (which applies the same
 *     chosen-grade fallback the advance flow uses, NOT a naive
 *     `${stableId}:${raceGrade}`), or 400 if the catalog row defines no track.
 *   - current race definitionId -> the local per-grade `raceDefinitions[grade].id`.
 * Historical level awards are preserved verbatim (they are source snapshots). No
 * other state is altered.
 */
function normalizeImportedState(
  state: CharacterState,
  identity: CharacterImportDocument["identity"],
  raceRow: CatalogLookupRow,
  classRow: CatalogLookupRow | null,
  profRow: CatalogLookupRow | null,
  raceType: RaceType
): CharacterState {
  const grade = state.race.grade
  // Normalize the race part first so the track definitions below are resolved
  // against the same state (and grade) the advance flow will use; the grade is
  // unchanged by normalization but the resolution must be identical.
  const raceState: CharacterState["race"] = {
    ...state.race,
    origin: identity.origin,
  }
  // A monster advances on an independent four-quarter cadence. Default an absent
  // quarter to 0 (the engine also treats it as 0); an enlightened (derived) race
  // never uses it, so it stays absent.
  if (raceType === "monster") {
    raceState.quarter = state.race.quarter ?? 0
  } else {
    delete raceState.quarter
  }
  const resolvedState: CharacterState = { ...state, race: raceState }

  const tracks: CharacterState["tracks"] = { ...state.tracks }
  if (tracks["class"]) {
    if (!classRow) {
      throw badRequest(
        "invalid_import",
        "Imported state declares a class track but the imported class identity is null"
      )
    }
    const def = resolveTrackDefinition(classRow, resolvedState, "class")
    if (!def) {
      throw badRequest(
        "invalid_import",
        `Class "${classRow.name}" (${classRow.stableId}) defines no track level-up; advancing class would fail`
      )
    }
    tracks["class"] = { ...tracks["class"], definitionId: def.id }
  }
  if (profRow && tracks["profession"]) {
    const def = resolveTrackDefinition(profRow, resolvedState, "profession")
    if (!def) {
      throw badRequest(
        "invalid_import",
        `Profession "${profRow.name}" (${profRow.stableId}) defines no track level-up; advancing profession would fail`
      )
    }
    tracks["profession"] = { ...tracks["profession"], definitionId: def.id }
  }

  const parsedRace = parseCatalogConfig(raceRow.kind, raceRow.config ?? {})
  const defs = parsedRace.raceDefinitions as
    Partial<Record<Grade, { id: string }>> | undefined
  const raceDefId = defs?.[grade]?.id
  if (raceDefId) raceState.definitionId = raceDefId
  else delete raceState.definitionId
  return { ...state, race: raceState, tracks }
}

/**
 * Assert a grade band drawn from the configured grade table is usable: the
 * published min/max and the evolution entry level must all be nonnegative. A
 * malformed band would make the imported track threshold comparisons meaningless
 * (a negative entry level would silently permit an un-advanceable track), so we
 * reject rather than miscompute a ceiling.
 */
function assertGradeBand(band: GradeBand, context: string): void {
  if (band.min < 0 || band.max < 0 || band.entryLevel < 0) {
    throw badRequest(
      "invalid_import",
      `${context} grade ${band.grade} band must be nonnegative (min ${band.min}, max ${band.max}, entryLevel ${band.entryLevel})`
    )
  }
}

/**
 * Assert the imported state's race mode agrees with the race's authoritative
 * advancement type. A monster race (raceType "monster") must be stored with race
 * mode "independent"; an enlightened race (raceType "enlightened", including a
 * legacy config that defaults to enlightened) must be stored with race mode
 * "derived". A mismatch means the backup was authored against a different (or
 * differently-configured) race definition, so reject with 400
 * `import_race_mode_mismatch` BEFORE any write. No automatic mode conversion is
 * attempted.
 */
function assertImportRaceMode(state: CharacterState, raceType: RaceType): void {
  const expectedMode = raceType === "monster" ? "independent" : "derived"
  if (state.race.mode !== expectedMode) {
    throw badRequest(
      "import_race_mode_mismatch",
      `Imported race mode "${state.race.mode}" disagrees with race type "${raceType}"; expected mode "${expectedMode}"`
    )
  }
}

/**
 * Validate the imported state's self-consistency before persisting. Rejects a
 * backup that (after Zod shape validation) has the wrong track set, out-of-range
 * track levels/quarters, a graded class/profession track already sitting past the
 * entry threshold of its NEXT grade, disagrees on origin, carries negative or
 * non-integer attribute/allocation values, over-allocates free points, or (for a
 * derived race) declares a race level inconsistent with the track levels. Every
 * failure is a 400 `invalid_import` raised BEFORE any DB write. No automatic
 * user-provided effects are added beyond the validated state.
 */
function assertImportState(
  state: CharacterState,
  identity: CharacterImportDocument["identity"],
  config: RulesConfig,
  raceType: RaceType
): void {
  if (raceType === "monster") {
    // A monster is race-only: exactly no class or profession tracks. Any track key
    // (including the class/profession tracks) is invalid for it.
    const monsterTracks = Object.keys(state.tracks)
    if (monsterTracks.length > 0) {
      throw badRequest(
        "invalid_import",
        `Imported monster state declares track(s): "${monsterTracks.join('", "')}"; a monster has no class or profession tracks`
      )
    }
    // Race-only grade ceiling: a monster's stored race level must not already sit
    // PAST the entry level of its NEXT grade (the same ceiling advanceRaceQuarter
    // enforces on a level-up), or the first quarter that levels up would reject
    // and the imported character could never advance. Equality is allowed. A
    // monster born at a higher natural grade at level 0 is fine (level 0 never
    // exceeds a nonnegative entry level). The top grade has no next band and is
    // not gated.
    const next = nextGrade(state.race.grade)
    if (next) {
      const nextBand = bandForGrade(next, config.gradeTable)
      if (!nextBand) {
        throw badRequest(
          "invalid_import",
          `Imported monster race next grade "${next}" has no grade band defined`
        )
      }
      assertGradeBand(nextBand, "Imported monster race")
      if (state.race.level > nextBand.entryLevel) {
        throw badRequest(
          "import_grade_blocked",
          `Imported monster race level ${state.race.level} exceeds the ${state.race.grade}->${next} threshold (${nextBand.entryLevel}); advancing would fail`
        )
      }
    }
  } else {
    // Exactly the class track must be present; the profession track must be present
    // iff a profession identity is declared, and no other track key is allowed.
    const allowedTracks = new Set(["class", "profession"])
    for (const key of Object.keys(state.tracks)) {
      if (!allowedTracks.has(key)) {
        throw badRequest(
          "invalid_import",
          `Imported state declares unknown track "${key}"`
        )
      }
    }
    if (!state.tracks["class"]) {
      throw badRequest(
        "invalid_import",
        "Imported state is missing the required class track"
      )
    }
    const hasProfessionIdentity = identity.profession != null
    const hasProfessionTrack = state.tracks["profession"] != null
    if (hasProfessionTrack !== hasProfessionIdentity) {
      throw badRequest(
        "invalid_import",
        hasProfessionIdentity
          ? "Imported state is missing the profession track for the declared profession"
          : "Imported state has a profession track but no profession identity"
      )
    }
  }

  // Track levels are nonnegative integers; quarters are 0..3. The document Zod
  // schema already constrains these, but re-checking here prevents a direct
  // service call from persisting an un-advanceable track.
  for (const [track, t] of Object.entries(state.tracks)) {
    if (!Number.isInteger(t.level) || t.level < 0) {
      throw badRequest(
        "invalid_import",
        `Imported track "${track}" level ${String(t.level)} must be a nonnegative integer`
      )
    }
    if (!Number.isInteger(t.quarter) || t.quarter < 0 || t.quarter > 3) {
      throw badRequest(
        "invalid_import",
        `Imported track "${track}" quarter ${String(t.quarter)} must be an integer in 0..3`
      )
    }
    // Graded track ceiling: a track carrying an explicit grade must not already sit
    // PAST the entry level of its NEXT grade, or the first level-up would throw
    // "without completed track evolution" and the imported character could never
    // advance. A value exactly AT the threshold is legal (the engine allows
    // reaching it); only a level strictly beyond it is rejected. The FINAL grade
    // has no next band, so its level is bounded by the published band max instead.
    // Legacy ungraded tracks (no `grade`) are exempt. Thresholds come from the
    // configured grade table via the engine's `nextGrade`/`bandForGrade` - never a
    // hand-rolled grade->level remapping - and every consulted band is checked to
    // be nonnegative so a malformed table cannot silently widen a ceiling.
    if (t.grade != null) {
      const currentBand = bandForGrade(t.grade, config.gradeTable)
      if (!currentBand) {
        throw badRequest(
          "invalid_import",
          `Imported track "${track}" grade "${t.grade}" has no grade band defined`
        )
      }
      assertGradeBand(currentBand, `Imported track "${track}"`)
      const next = nextGrade(t.grade)
      if (next) {
        const nextBand = bandForGrade(next, config.gradeTable)
        if (!nextBand) {
          throw badRequest(
            "invalid_import",
            `Imported track "${track}" next grade "${next}" has no grade band defined`
          )
        }
        assertGradeBand(nextBand, `Imported track "${track}"`)
        if (t.level > nextBand.entryLevel) {
          throw badRequest(
            "invalid_import",
            `Imported track "${track}" level ${t.level} exceeds the ${t.grade}->${next} threshold (${nextBand.entryLevel}); advancing would fail`
          )
        }
      } else if (currentBand.max != null && t.level > currentBand.max) {
        throw badRequest(
          "invalid_import",
          `Imported track "${track}" level ${t.level} exceeds the final grade ${t.grade} max (${currentBand.max})`
        )
      }
    }
  }

  if (state.race.origin != null && state.race.origin !== identity.origin) {
    throw badRequest(
      "invalid_import",
      `identity.origin "${identity.origin}" disagrees with state.race.origin "${state.race.origin}"`
    )
  }
  for (const [attr, v] of Object.entries(state.baseAttributes)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw badRequest(
        "invalid_import",
        `baseAttributes.${attr} must be a nonnegative number (got ${String(v)})`
      )
    }
  }
  for (const entry of state.allocations) {
    for (const [attr, v] of Object.entries(entry.points)) {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
        throw badRequest(
          "invalid_import",
          `allocation "${entry.id}" (${entry.source}) ${attr} must be a nonnegative integer (got ${String(v)})`
        )
      }
    }
  }
  const totalFree = totalFreePoints(state)
  const allocated = allocatedPoints(state)
  if (allocated > totalFree) {
    throw badRequest(
      "invalid_import",
      `allocated points ${allocated} exceed total free points ${totalFree}`
    )
  }
  if (state.race.mode === "derived") {
    const derived = deriveRaceLevel(state, config)
    if (state.race.level !== derived) {
      throw badRequest(
        "invalid_import",
        `race level ${state.race.level} is inconsistent with the derived level ${derived}`
      )
    }
  }
}

/**
 * Import a trusted-backup v3 document as a NEW character owned by `user`. Never
 * overwrites an existing character and never mutates the catalog. All writes
 * (character row, association links, skill offers/options, imported history and
 * the import marker) are transactional: any resolution/validation failure 400s
 * and rolls the whole import back.
 */
export async function importCharacter(
  input: CharacterImportDocument,
  user: SessionUser
): Promise<CharacterDetail> {
  // A legacy v3-v6 document may still carry a `blessing` association, but the
  // `blessings` catalog kind was retired (it is now a `gods` definition + a
  // per-link tier). Reject ANY legacy blessing association up front with an
  // actionable migration notice - even when the referenced definition would
  // otherwise resolve - so the caller knows to recover the link from a
  // pre-migration backup rather than silently dropping it. Migration 0019 (in
  // the archived 0001..0023 chain, now folded into the 0.1.0 baseline) is the
  // migration that retired the kind; the notice points at the backup taken
  // before it. A v7/v8 document shares the v7 blessing model, so it is never
  // treated as legacy here.
  const isLegacyBlessingSchema =
    input.schema === IMPORT_SCHEMA_V3 ||
    input.schema === IMPORT_SCHEMA_V4 ||
    input.schema === IMPORT_SCHEMA_V5 ||
    input.schema === IMPORT_SCHEMA_V6
  if (isLegacyBlessingSchema) {
    const legacyBlessing = input.associations.find((a) => a.kind === "blessing")
    if (legacyBlessing) {
      throw badRequest(
        "invalid_import",
        `Backups with legacy blessing associations cannot be imported; prior to applying migration 0019 take a PostgreSQL backup and recreate god+tier links manually afterward; remove links from old file only if intentional`
      )
    }
  }
  const serializable = {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const houseRules = await loadHouseRules(tx)
      const race = await resolveIdentityRef(
        tx,
        "races",
        input.identity.race.stableId,
        "race"
      )

      // The race's advancement mode determines what the class/profession identity
      // may carry. A monster is race-only: its class identity must be null and it
      // tracks no profession. An enlightened race always resolves an exact class.
      const raceConfig = parseCatalogConfig(race.kind, race.config ?? {})
      const raceType =
        (raceConfig.raceType as RaceType | undefined) ?? "enlightened"
      if (raceType === "monster") {
        if (input.identity.class.stableId != null) {
          throw badRequest(
            "invalid_import",
            `Monster race "${race.name}" has no class; imported class stableId "${input.identity.class.stableId}" is not allowed`
          )
        }
        if (input.identity.profession != null) {
          throw badRequest(
            "invalid_import",
            `Monster race "${race.name}" has no profession; imported profession is not allowed`
          )
        }
      }

      const cls =
        raceType === "monster"
          ? null
          : await resolveIdentityRef(
              tx,
              "classes",
              input.identity.class.stableId,
              "class"
            )
      const prof = input.identity.profession
        ? await resolveIdentityRef(
            tx,
            "professions",
            input.identity.profession.stableId,
            "profession"
          )
        : null

      // Deserialize with a hard rejection: a state that violates the engine schema
      // (including track levels/quarters) must 400 `invalid_import` before any DB
      // write, even when the route's Zod check was bypassed by a direct caller.
      let rawState: CharacterState
      try {
        rawState = deserializeState(input.state)
      } catch (err) {
        if (err instanceof z.ZodError) {
          const issues = err.issues
            .slice(0, 3)
            .map(
              (i) =>
                `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`
            )
            .join("; ")
          throw badRequest(
            "invalid_import",
            `Imported state is malformed - ${issues}`
          )
        }
        throw err
      }
      const config = buildRulesConfig(race, houseRules.config)
      // Validate the RAW document state before normalizing: `normalizeImportedState`
      // rewrites the origin to identity.origin, which would otherwise mask a
      // backup whose state.race.origin disagrees with identity.origin. The race-mode
      // consistency check runs FIRST so a backup authored against a differently
      // configured race definition fails with `import_race_mode_mismatch` rather
      // than surfacing the downstream origin/track checks.
      assertImportRaceMode(rawState, raceType)
      assertImportState(rawState, input.identity, config, raceType)
      const state = normalizeImportedState(
        rawState,
        input.identity,
        race,
        cls,
        prof,
        raceType
      )

      // A v3 doc has no inventory model; a v4/v5 doc carries owned stock (which is
      // validated and resolved before any DB write). The resolved stock map is what
      // the association resolver consults to enforce the ownership invariant on
      // non-grandfathered equipment links.
      const hasInventory =
        input.schema === IMPORT_SCHEMA_V4 ||
        input.schema === IMPORT_SCHEMA_V5 ||
        input.schema === IMPORT_SCHEMA_V6 ||
        input.schema === IMPORT_SCHEMA_V7 ||
        input.schema === IMPORT_SCHEMA_V8
      let resolvedInventory: ResolvedInventoryItem[] = []
      let ownedStockByDefId = new Map<string, number>()
      if (hasInventory) {
        resolvedInventory = await resolveInventoryRefs(tx, input.inventory)
        ownedStockByDefId = new Map(
          resolvedInventory.map((i) => [i.definitionId, i.quantity])
        )
      }

      const resolvedAssocs = await resolveAssociationRefs(
        tx,
        input.associations,
        {
          enforceOwnership: hasInventory,
          ownedStockByDefId,
          maxTranscendentSkills: houseRules.config.maxTranscendentSkills,
          raceGrade: state.race.grade,
          // Only a legacy v3/v4 document may recover a ring position from its own
          // definition.config.slot snapshot; a v5/v6/v7/v8 document carries the
          // position explicitly and never trusts the snapshot.
          allowConfigSnapshotPosition:
            input.schema === IMPORT_SCHEMA_V3 ||
            input.schema === IMPORT_SCHEMA_V4,
        }
      )
      assertAssocCollisions(
        resolvedAssocs,
        houseRules.config.maxTranscendentSkills
      )
      const resolvedOffers = await resolveSkillOfferRefs(tx, input.skillOffers)

      // A legacy v3-v7 document has no `currencyBalances` field and produces no
      // balances; only a v8 document carries them (validated before any DB write).
      let resolvedBalances: ResolvedCurrencyBalance[] = []
      if (input.schema === IMPORT_SCHEMA_V8) {
        resolvedBalances = await resolveCurrencyBalances(
          tx,
          input.currencyBalances
        )
      }

      const serialized = serializeState(state)
      const created = await tx.character.create({
        data: {
          ownerId: user.id,
          name: input.identity.name,
          description: input.identity.description ?? null,
          // Profile metadata is imported verbatim (nullable): an omitted/null field
          // in the backup is NULL, never a default. The exact empty string is also
          // stored as NULL; all other content (including whitespace/newlines) is
          // preserved byte-for-byte.
          nickname: metadataOrNull(input.identity.nickname),
          pronouns: metadataOrNull(input.identity.pronouns),
          ageDescription: metadataOrNull(input.identity.ageDescription),
          appearance: metadataOrNull(input.identity.appearance),
          biography: metadataOrNull(input.identity.biography),
          notes: metadataOrNull(input.identity.notes),
          origin: input.identity.origin,
          raceId: race.id,
          // A monster has no class; every other (enlightened) race has one.
          classId: cls?.id ?? null,
          professionId: prof?.id ?? null,
          state: serialized as Prisma.InputJsonValue,
          version: 0,
          imported: true,
        },
        include: characterInclude,
      })

      for (const a of resolvedAssocs) {
        await tx.characterAssociation.create({
          data: {
            characterId: created.id,
            definitionId: a.definitionId,
            kind: a.dbKind as never,
            // Only equipment links carry the grandfathered marker; non-equipment
            // links fall back to the schema default (false). Preserved verbatim so a
            // re-imported grandfathered link stays grandfathered and vice versa.
            ...(a.sourceKind === "equipment"
              ? { legacyUnowned: a.legacyUnowned }
              : {}),
            // Persist the exact ring position for a Ring-slot item (null for a
            // non-ring equipment link), so a v5 round-trip never loses the position.
            ...(a.sourceKind === "equipment"
              ? { equipmentPosition: a.equipmentPosition }
              : {}),
            // A v7 blessing link carries the exact tier it was granted at so the
            // live effect is synthesized from the god's `blessingEffects[tier]`.
            ...(a.sourceKind === "blessing"
              ? { blessingTier: a.tier ?? null }
              : {}),
          },
        })
      }

      // Import owned stock. Reached for a v4-v8 document (v3 imports no stock, so
      // the array is empty). Archived catalog stock is imported inert.
      for (const item of resolvedInventory) {
        await tx.characterInventoryItem.create({
          data: {
            characterId: created.id,
            definitionId: item.definitionId,
            quantity: item.quantity,
          },
        })
      }

      // Import currency balances transactionally with the character and its
      // associations/inventory; any failure above already rolled the whole import
      // back, so this writes only after every resolve has passed. An ARCHIVED
      // currency definition's balance is imported inert (a hidden amount survives).
      for (const balance of resolvedBalances) {
        await tx.characterCurrencyBalance.create({
          data: {
            characterId: created.id,
            definitionId: balance.definitionId,
            amount: balance.amount,
          },
        })
      }

      for (const o of resolvedOffers) {
        await tx.skillOffer.create({
          data: {
            characterId: created.id,
            track: o.track,
            level: o.level,
            choiceGroup: o.choiceGroup,
            generation: o.generation,
            canceledAt: o.canceledAt,
            offeredAt: o.offeredAt,
            selectedDefinitionId: o.selectedDefinitionId,
            selectedAt: o.selectedAt,
            // Schedule-credit provenance (nullable on legacy/imported offers).
            earnedGrade: o.earnedGrade,
            trackDefinitionStableId: o.trackDefinitionStableId,
            classStableIdAtEarn: o.classStableIdAtEarn,
            options: {
              create: o.options.map((opt) => ({
                definitionId: opt.definitionId,
                nameSnapshot: opt.nameSnapshot,
                configSnapshot: opt.configSnapshot as Prisma.InputJsonValue,
              })),
            },
          },
        })
      }

      for (const event of input.events) {
        await tx.progressionEvent.create({
          data: {
            characterId: created.id,
            kind: "import_history",
            payload: {
              sourceKind: event.kind ?? "unknown",
              sourceCreatedAt: event.createdAt ?? new Date().toISOString(),
              sourcePayload: event.payload ?? {},
            } as Prisma.InputJsonValue,
          },
        })
      }

      await tx.progressionEvent.create({
        data: {
          characterId: created.id,
          kind: "import",
          payload: {
            origin: input.identity.origin,
            raceStableId: race.stableId,
            classStableId: cls?.stableId ?? null,
            professionStableId: prof?.stableId ?? null,
            rulesetVersion: IMPORT_RULESET_VERSION,
            // Record which backup schema produced this import and how many distinct
            // stock definitions and currency balances were restored, so the marker
            // is an auditable record of the backup's origin (never verified source
            // provenance itself).
            backupSchema: input.schema,
            inventoryCount: resolvedInventory.length,
            currencyBalanceCount: resolvedBalances.length,
            sourceEvents: input.events.length,
          } as Prisma.InputJsonValue,
        },
      })

      // Re-fetch so the returned detail includes the associations and skill offers
      // created above (the `character.create` snapshot has empty relation arrays).
      const refetched = (await tx.character.findUnique({
        where: { id: created.id },
        include: characterInclude,
      }))!

      return await detailFor(refetched, houseRules, tx)
    }, serializable)
  } catch (err) {
    if (isSerializationFailure(err)) {
      throw conflict(
        "serialization_conflict",
        "Concurrent catalog change detected; retry the import"
      )
    }
    throw err
  }
}

// ------------------------------------------------------------------ //
// Catalog persistence
// ------------------------------------------------------------------ //

/**
 * Derive the catalog `stableId` for a write. A caller-supplied nonempty `stableId`
 * wins verbatim; an omitted/empty one is slugified from the entry name (lowercase,
 * non-alphanumeric runs collapsed to a single hyphen, trimmed), with a final
 * "entry" fallback for a name that slugs to nothing. Matches the exact derivation
 * the create path has always used so a P2002 conflict message reports the real
 * resulting stableId.
 */
function deriveCatalogStableId(name: string, provided?: string): string {
  if (provided) return provided
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || "entry"
}

function parseConfigOr400(
  kind: string,
  config: unknown
): Record<string, unknown> {
  try {
    return parseCatalogConfig(kind, config)
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Invalid catalog config"
    throw badRequest("invalid_config", message)
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { code?: string }).code === "P2002"
  )
}

/**
 * Detect a P2002 whose `meta.target` names the BLESSING singleton partial unique
 * index. Even when the caller did not pass kind/blessing (defensive),
 * `character_associations_characterId_blessing_key` is the single-slot invariant
 * index and can only be a blessing singleton conflict, never a generic one.
 */
function isBlessingPartialIndexViolation(err: unknown): boolean {
  if (!isUniqueViolation(err)) return false
  const meta = (err as { meta?: { target?: unknown } }).meta
  const target = meta?.target
  if (Array.isArray(target)) {
    return target.some(
      (t) => t === "character_associations_characterId_blessing_key"
    )
  }
  return target === "character_associations_characterId_blessing_key"
}

/**
 * Detect a P2002 whose `meta.target` names the BLOODLINE singleton partial unique
 * index. Even when the caller did not pass kind/bloodline (defensive),
 * `character_associations_characterId_bloodline_key` is the single-link invariant
 * index and can only be a bloodline singleton conflict, never a generic one.
 */
function isBloodlinePartialIndexViolation(err: unknown): boolean {
  if (!isUniqueViolation(err)) return false
  const meta = (err as { meta?: { target?: unknown } }).meta
  const target = meta?.target
  if (Array.isArray(target)) {
    return target.some(
      (t) => t === "character_associations_characterId_bloodline_key"
    )
  }
  return target === "character_associations_characterId_bloodline_key"
}

/**
 * Detect a Prisma serialization/deadlock failure (P2034) or a raw-query
 * serialization failure (P2010 with SQLSTATE 40001). Under SERIALIZABLE isolation
 * two concurrent catalog writes that race on the same row (e.g. two concurrent
 * blessing creates with the same stableId, or two concurrent god stableId
 * changes) cannot both commit; the loser surfaces as P2034 and we map it to a 409
 * rather than a raw 500.
 *
 * The raw `$queryRaw ... FOR UPDATE` row lock in `lockSkillOfferRows` can also
 * race a concurrent commit on the same offer row. PostgreSQL raises SQLSTATE
 * 40001 ("could not serialize access due to concurrent update"), which Prisma
 * surfaces as a `P2010` (raw query failed) carrying `meta.code = "40001"` - it
 * does NOT translate raw-query serialization failures to P2034. Recognize that
 * shape too so the retryable 409 contract holds for the offer-lock path as well.
 */
function isSerializationFailure(err: unknown): boolean {
  if (
    !!err &&
    typeof err === "object" &&
    (err as { code?: string }).code === "P2034"
  ) {
    return true
  }
  const meta = (err as { meta?: { code?: string; message?: string } }).meta
  return (
    !!err &&
    typeof err === "object" &&
    (err as { code?: string }).code === "P2010" &&
    (meta?.code === "40001" ||
      meta?.message?.includes("could not serialize access") === true)
  )
}

/**
 * Normalize a stored `gradeDescriptions` JSON value into the public
 * `Partial<Record<Grade, string>>` shape. A null/undefined/empty or non-object
 * value (e.g. a legacy row or the empty DB default) reads back as an empty map.
 * Entries whose key is not a recognized grade (G..S) or whose value is not a
 * nonempty string are dropped defensively; valid string values are trimmed.
 */
function normalizeGradeDescriptions(
  value: unknown
): Partial<Record<Grade, string>> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return {}
  }
  const out: Partial<Record<Grade, string>> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "string") continue
    if (
      !gradeSchema.options.includes(key as (typeof gradeSchema.options)[number])
    ) {
      continue
    }
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    out[key as Grade] = trimmed
  }
  return out
}

function catalogItem(row: {
  id: string
  kind: string
  stableId: string
  name: string
  description: string | null
  grade: string | null
  sourceUrl: string | null
  archived: boolean
  config: unknown
  gradeDescriptions: unknown
  createdAt: Date
  updatedAt: Date
}): CatalogItem {
  return {
    id: row.id,
    kind: row.kind,
    stableId: row.stableId,
    name: row.name,
    description: row.description,
    grade: row.grade,
    sourceUrl: row.sourceUrl,
    archived: row.archived,
    config: (row.config ?? {}) as Record<string, unknown>,
    gradeDescriptions: normalizeGradeDescriptions(row.gradeDescriptions),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function listCatalog(
  kind: string,
  opts: { includeArchived?: boolean } = {}
): Promise<CatalogItem[]> {
  const normalizedKind = normalizeCatalogKind(kind)
  const includeArchived = opts.includeArchived === true
  const rows = await prisma.catalogDefinition.findMany({
    where: {
      kind: normalizedKind as never,
      ...(includeArchived ? {} : { archived: false }),
    },
    orderBy: [{ grade: "asc" }, { name: "asc" }],
  })
  return rows.map(catalogItem)
}

export async function getCatalogItem(
  kind: string,
  id: string
): Promise<CatalogItem> {
  const normalizedKind = normalizeCatalogKind(kind)
  const row = await prisma.catalogDefinition.findUnique({ where: { id } })
  if (!row || row.kind !== normalizedKind) {
    throw notFound("catalog_not_found", "Catalog entry not found")
  }
  return catalogItem(row)
}

/**
 * A lightweight, read-only summary of a catalog entry exposed by the MCP catalog
 * listing endpoint. It carries only identity/ordering/availability columns and
 * never the heavy `config` / `description` / `gradeDescriptions` payloads, so a
 * publisher can enumerate a whole catalog without downloading every definition.
 */
export interface McpCatalogSummary {
  kind: string
  stableId: string
  name: string
  grade: string | null
  sourceUrl: string | null
  archived: boolean
}

/**
 * List catalog entries for the MCP publisher as lightweight summaries.
 *
 * Only the summary columns are selected; the heavy `config` / `description` /
 * `gradeDescriptions` payload is never fetched, so the listing stays bounded even
 * against an unbounded catalog. Active entries are returned by default; pass
 * `includeArchived` to additionally return archived entries. Rows are ordered by
 * grade then name for a stable browse. This is a read-only MCP path and never
 * rewrites catalog rows.
 */
export async function listMcpCatalogSummaries(
  kind: string,
  includeArchived: boolean
): Promise<McpCatalogSummary[]> {
  const normalizedKind = normalizeCatalogKind(kind)
  const rows = await prisma.catalogDefinition.findMany({
    where: {
      kind: normalizedKind as never,
      ...(includeArchived ? {} : { archived: false }),
    },
    select: {
      kind: true,
      stableId: true,
      name: true,
      grade: true,
      sourceUrl: true,
      archived: true,
    },
    orderBy: [{ grade: "asc" }, { name: "asc" }],
  })
  // The in-memory test mock does not honor `select`, so defensively project only
  // the summary columns; a real Prisma `select` already restricts them.
  return rows.map((row) => ({
    kind: row.kind,
    stableId: row.stableId,
    name: row.name,
    grade: row.grade,
    sourceUrl: row.sourceUrl,
    archived: row.archived,
  }))
}

/**
 * Fetch one full catalog entry by its composite `(kind, stableId)` key for the MCP
 * publisher detail endpoint.
 *
 * Unlike the listing summary, this returns the complete `CatalogItem` including
 * `config`, `description`, and `gradeDescriptions`, so a publisher can read a
 * single entry's full content without enumerating the whole catalog. A missing
 * entry (or a kind/stableId pair that does not match any row) throws 404
 * `catalog_not_found`.
 */
export async function getMcpCatalogEntry(
  kind: string,
  stableId: string
): Promise<CatalogItem> {
  const normalizedKind = normalizeCatalogKind(kind)
  const row = await prisma.catalogDefinition.findUnique({
    where: {
      kind_stableId: { kind: normalizedKind as never, stableId },
    },
  })
  if (!row) {
    throw notFound("catalog_not_found", "Catalog entry not found")
  }
  return catalogItem(row)
}

/**
 * Optional per-write controls for the transactional catalog write cores
 * (`createCatalogItemInTransaction` / `updateCatalogItemInTransaction`).
 *
 * `skillGraphValidatedInBatch` may ONLY be set true after the caller has already
 * validated the FINAL full skill upgrade graph against the same SERIALIZABLE
 * transaction snapshot the write will commit in: every explicit skill upgrade
 * edge across the whole graph (including target existence/kind, self-links,
 * duplicate stableIds, cycles, and the newly-added/changed-edge active-target
 * policy) must have been checked once up front. Intended for importers and the
 * MCP publisher, which sequence many catalog writes atomically and prevalidate
 * the complete final graph once rather than letting each sequential write
 * re-validate an intermediate graph that is temporarily invalid (dangling
 * references or cycles) while the batch is still in progress.
 *
 * When set true, ONLY the per-item `assertSkillUpgradeGraph` check is skipped.
 * Every other guard still runs: skill config schema parsing, the grade /
 * gradeDescriptions ban, linked rarity/upgrade-group immutability, stableId
 * rename protections, god/granted/grade-granted/title-granted skill references,
 * the skill classStableId ref, link-collision, race-type-in-use, and equipment
 * position checks. Omitted (or false) keeps the current per-item validation and
 * is what public CRUD relies on.
 *
 * `preserveRawSkillConfig` may ONLY be set true by the skill-variant clone
 * (`createSkillUpgradeVariant`). Every other caller leaves it unset. Because the
 * create/update helpers parse the config via Zod and persist the NORMALIZED
 * parsed shape, a config that carries unknown NESTED fields inside
 * `effects` / `condition` (which Zod strips even though the top-level schema is
 * `.passthrough()`) would lose that metadata on clone. When true AND the kind is
 * `skills`, the helper still fully validates the parsed config and runs every
 * guard, but persists the supplied RAW JSON config in place of the parsed
 * normalized config, so no unknown nested key is dropped. This option therefore
 * preserves the source's and clone's full raw metadata payload byte-for-byte.
 */
export type CatalogItemWriteOptions = {
  skillGraphValidatedInBatch?: true
  preserveRawSkillConfig?: true
}

export type CreateCatalogItemInput = {
  stableId?: string
  name: string
  description?: string | null
  grade?: string | null
  sourceUrl?: string | null
  archived?: boolean
  config?: Record<string, unknown>
  gradeDescriptions?: Partial<Record<Grade, string>>
}

/**
 * Validate and persist a new catalog entry inside an already-open caller-owned
 * transaction. This is the transactional core that `createCatalogItem` wraps.
 *
 * A caller that must sequence multiple catalog writes atomically (e.g. a managed
 * MCP publisher) opens its own SERIALIZABLE transaction, passes the transaction
 * client as `tx`, and calls this helper for each write. Every prevalidation check
 * and catalog-reference guard (god patron, granted/graded skills, skill
 * classStableId) runs against the SAME transaction snapshot as the insert, so a
 * concurrent god/skill/class stableId rename (or a race-type change) cannot
 * commit between the ref read and the write and leave a dangling reference. It
 * never opens a nested transaction nor touches the global `prisma` client.
 */
export async function createCatalogItemInTransaction(
  tx: DbClient,
  kind: string,
  input: CreateCatalogItemInput,
  options?: CatalogItemWriteOptions
): Promise<CatalogItem> {
  kind = normalizeCatalogKind(kind)
  // A gods entry carries no catalog grade band: divine power / blessing tier live
  // in `blessingEffects[tier]`, never the shared `grade` column. A non-null grade
  // on a new god is rejected before any write; `null`/omitted is the only legal
  // value (migration 0020, archived 0001..0023 chain, nulled any pre-existing god grade).
  if (godGradeForbidden(kind, input.grade)) {
    throw badRequest(
      "invalid_grade",
      'Gods carry no catalog grade: a gods entry must store "grade" as null'
    )
  }
  // A currencies entry likewise carries no catalog grade band (see
  // `currencyGradeForbidden`): a currency is a named in-world tender, not a graded
  // definition, so `grade` must be null/omitted. A non-null grade on a new
  // currency is rejected before any write.
  if (currencyGradeForbidden(kind, input.grade)) {
    throw badRequest(
      "invalid_grade",
      'Currencies carry no catalog grade: a currencies entry must store "grade" as null'
    )
  }
  // A currencies entry carries no grade ladder, so no grade-specific prose is
  // legal: gradeDescriptions must be empty (`{}`) or omitted. A non-empty map on a
  // new currency is rejected before any write.
  if (currencyGradeDescriptionsForbidden(kind, input.gradeDescriptions)) {
    throw badRequest(
      "invalid_grade_descriptions",
      'Currencies carry no grade ladder: "gradeDescriptions" must be empty or omitted'
    )
  }
  // A skills entry likewise carries no catalog grade band (see
  // `skillGradeForbidden`): a skill is offered to the advancing track by config
  // `track` alone, never by a catalog grade, so `grade` must be null/omitted. A
  // non-null grade on a new skill is rejected before any write (migration
  // 20261017200000_skill_grade_removed nulled any pre-existing skill grade).
  if (skillGradeForbidden(kind, input.grade)) {
    throw badRequest(
      "invalid_grade",
      'Skills carry no catalog grade: a skills entry must store "grade" as null'
    )
  }
  // A skills entry carries no grade ladder, so no grade-specific prose is legal:
  // gradeDescriptions must be empty (`{}`) or omitted. A non-empty map on a new
  // skill is rejected before any write.
  if (skillGradeDescriptionsForbidden(kind, input.gradeDescriptions)) {
    throw badRequest(
      "invalid_grade_descriptions",
      'Skills carry no grade ladder: "gradeDescriptions" must be empty or omitted'
    )
  }
  const config = parseConfigOr400(kind, input.config ?? {})
  if (kind === "skills" && isIncompleteSkillConfig(config)) {
    throw badRequest(
      "invalid_config",
      'Skill config requires a "track": expected "race", "class" or "profession"'
    )
  }
  if (kind === "skills" && hasInvalidSkillTrack(config)) {
    throw badRequest(
      "invalid_config",
      'Skill config has an invalid "track": expected "race", "class" or "profession"'
    )
  }
  // A NEW skill must declare a valid rarity (the same ordered vocabulary as
  // equipment). A legacy config without one is acceptable only for existing
  // entries, never here.
  if (kind === "skills" && isIncompleteSkillRarity(config)) {
    throw badRequest(
      "invalid_config",
      'Skill config requires a valid "rarity" (one of Inferior/Common/Uncommon/Rare/Epic/Ancient/Legendary/Mythical/Sacred/Divine/Unique)'
    )
  }
  // A NEW race must carry a recognized raceType ("enlightened" or "monster") AND
  // a gradeSchema-valid naturalGrade ("G".."S"). A legacy config lacking either is
  // allowed to read but is never authoritative for a new/config-changing write.
  if (kind === "races" && isIncompleteRaceConfig(config)) {
    throw badRequest(
      "invalid_config",
      'Race config must declare a valid "raceType" ("enlightened"/"monster") and a valid "naturalGrade" ("G","F","E","D","C","B","A","S")'
    )
  }
  // A NEW bloodline must carry the modern `effects` shape; a legacy
  // metadata-only config is accepted only for existing entries, never here.
  if (kind === "bloodlines" && isLegacyBloodlineConfig(config)) {
    throw badRequest(
      "invalid_config",
      'Bloodline config is missing required "effects" field'
    )
  }
  // A NEW transcendent skill must carry the modern `passiveEffects` shape; a
  // legacy metadata-only config is accepted only for existing entries, never
  // here (a missing list never yields a fabricated default bonus).
  if (
    kind === "transcendent_skills" &&
    isLegacyTranscendentSkillConfig(config)
  ) {
    throw badRequest(
      "invalid_config",
      'Transcendent skill config is missing required "passiveEffects" field'
    )
  }
  // A NEW equipment entry requires a valid slot AND a valid rarity; a legacy
  // metadata-only config (no slot / no rarity) is acceptable only for existing
  // entries, never here.
  if (kind === "equipment" && isIncompleteEquipmentConfig(config)) {
    throw badRequest(
      "invalid_config",
      'Equipment config requires a valid "slot" (one of Head/Chest/Back/Arms/Hands/Legs/Feet/Neck/Ring/Weapon, or a documented legacy alias) and a valid "rarity"'
    )
  }
  // A NEW equipment write must persist the CANONICAL requirement keys, never the
  // legacy `minRaceLevel` / `requiredRaceType` (the editor migrates them). An
  // existing row that still carries them stays readable and enforced, but a new
  // entry may not reintroduce them.
  if (kind === "equipment" && hasLegacyEquipmentRequirements(config)) {
    throw badRequest(
      "invalid_config",
      'Equipment config uses the legacy "minRaceLevel"/"requiredRaceType"; use the canonical "minimumLevel"/"requiredLevelType"'
    )
  }
  const stableId = deriveCatalogStableId(input.name, input.stableId)
  // A NEW equipment write must not reference a missing/archived divine patron.
  if (kind === "equipment") await assertEquipmentGodRef(tx, config)
  // A NEW equipment write must not grant a missing/archived passive skill.
  if (kind === "equipment") await assertEquipmentGrantedSkillsRefs(tx, config)
  // A NEW title write must not grant a missing/archived passive skill.
  if (kind === "titles") await assertTitleGrantedSkillsRefs(tx, config)
  // A NEW race/class/profession write must not reference a missing/archived
  // grade-granted skill.
  if (kind === "races" || kind === "classes" || kind === "professions") {
    await assertGradeGrantedSkillsRefs(tx, config)
  }
  // A NEW skill write that declares an optional class tie must reference an
  // existing class (a new class-tie selection must be ACTIVE).
  if (kind === "skills") {
    await assertSkillClassRef(tx, config, null)
    // A NEW skill write must also participate in a valid global skill upgrade
    // graph: every explicit outgoing edge (a newly added edge is always new on
    // a create) must target a currently ACTIVE skill, and no edge may be a
    // self-link, a missing/wrong-kind target, or part of a cycle. Skipped only
    // when the caller prevalidated the final full graph in the same SERIALIZABLE
    // transaction (`skillGraphValidatedInBatch`); the class-tie ref check above
    // still runs.
    if (options?.skillGraphValidatedInBatch !== true) {
      await assertSkillUpgradeGraph(tx, {
        sourceStableId: stableId,
        sourceConfig: config,
        sourceArchived: input.archived ?? false,
      })
    }
  }
  // The clone path (`preserveRawSkillConfig`) keeps the supplied RAW JSON config
  // so unknown nested fields inside `effects` / `condition` survive verbatim; every
  // OTHER caller persists the parsed normalized config. Both paths have been fully
  // validated above - this only changes what is WRITTEN, never what is checked.
  const persistedConfig =
    kind === "skills" && options?.preserveRawSkillConfig === true
      ? (input.config ?? {})
      : config
  const row = await tx.catalogDefinition.create({
    data: {
      kind: kind as never,
      stableId,
      name: input.name,
      description: input.description ?? null,
      grade: input.grade ?? null,
      sourceUrl: input.sourceUrl ?? null,
      archived: input.archived ?? false,
      config: persistedConfig as Prisma.InputJsonValue,
      ...(input.gradeDescriptions != null
        ? {
            gradeDescriptions: input.gradeDescriptions as Prisma.InputJsonValue,
          }
        : {}),
    },
  })
  return catalogItem(row)
}

export async function createCatalogItem(
  kind: string,
  input: CreateCatalogItemInput
): Promise<CatalogItem> {
  const normalizedKind = normalizeCatalogKind(kind)
  // Bloodlines, equipment, races, classes, professions and skills run under
  // SERIALIZABLE isolation: two concurrent creates that race on the same (kind,
  // stableId) cannot both commit, and the loser surfaces as P2034 which we map to
  // a 409 rather than a silent 500. Equipment, race/class/profession, bloodline
  // and skill creates also validate catalog references (god patron,
  // granted/graded skills, skill classStableId) against the live catalog inside
  // the transaction, so a concurrent god/skill/class stableId rename (or a
  // race-type change) cannot commit between the ref read and the write, leaving
  // a dangling reference. SERIALIZABLE re-checks the read/write dependency at
  // commit and aborts the create (P2034 -> 409) rather than persisting a
  // reference to a renamed-away stableId.
  const serializable =
    normalizedKind === "bloodlines" ||
    normalizedKind === "equipment" ||
    normalizedKind === "races" ||
    normalizedKind === "classes" ||
    normalizedKind === "professions" ||
    normalizedKind === "skills"
      ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      : undefined
  try {
    return await prisma.$transaction(
      (tx) => createCatalogItemInTransaction(tx, kind, input),
      serializable
    )
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict(
        "catalog_stable_id_conflict",
        `Catalog entry with stableId "${deriveCatalogStableId(input.name, input.stableId)}" already exists`
      )
    }
    if (isSerializationFailure(err)) {
      throw conflict(
        "catalog_serialization_conflict",
        "Concurrent catalog write conflict; retry the change"
      )
    }
    throw err
  }
}

/**
 * Reject a catalog update that would change a RANKED title's improvement identity
 * (seriesId / rank / minRaceGrade) or drop the improvement entirely, but only when
 * the title is actually linked to a character. A linked ranked title is the
 * authority for its character's rank progression, so changing its identity would
 * invalidate the sequence; the owner's current association must stay intact.
 *
 * Allowed on a linked title: metadata (name/description/grade) edits
 * and bonus recalculations (flat / percent), as long as the improvement identity
 * is not being added, changed or removed. Rejected with 409
 * `title_improvement_conflict` (no write) for a linked title whose improvement
 * identity is ADDED (an unranked row being promoted to ranked), changes
 * (series/rank/grade), or is removed. An unlinked catalog row may be edited
 * freely, including being promoted to ranked.
 */
async function assertTitleImprovementStable(
  tx: DbClient,
  definitionId: string,
  existingConfig: Record<string, unknown>,
  finalConfig: Record<string, unknown>
): Promise<void> {
  const existingImp = titleImprovementForConfig(
    parseCatalogConfig("titles", existingConfig)
  )
  const finalImp = titleImprovementForConfig(finalConfig)
  // No improvement on either side - an ordinary title, nothing to protect.
  if (existingImp == null && finalImp == null) return
  // Both present and identity unchanged - metadata/bonus edits may recalc live.
  if (existingImp != null && finalImp != null) {
    if (
      existingImp.seriesId === finalImp.seriesId &&
      existingImp.rank === finalImp.rank &&
      existingImp.minRaceGrade === finalImp.minRaceGrade
    ) {
      return
    }
  }
  const links = await tx.characterAssociation.findMany({
    where: { definitionId },
  })
  if (links.length === 0) return
  // On a linked title the improvement is immutable: adding it to a formerly
  // unranked title, removing it, or changing its series/rank/grade identity are
  // all rejected, because the link is the authority for a character's rank
  // progression. Metadata / bonus edits that keep the identity stable are
  // permitted (handled above).
  throw conflict(
    "title_improvement_conflict",
    "This ranked title is assigned to a character; its improvement series/rank/grade cannot be added, changed or removed"
  )
}

/**
 * Reject a catalog update that would change a LINKED skill's rarity or
 * upgradeGroup. A linked skill's rarity/group is the mechanical fact its
 * character link relies on for monotonic upgrade ordering and same-group
 * replacement, so changing it would silently invalidate the recorded
 * `skill_upgrade` history / snapshots. Metadata (name/description/grade) edits
 * and config edits that keep rarity/group stable (effects/track/milestone) are
 * allowed; prior snapshots are never silently adjusted. Rejected with 409
 * `skill_rarity_conflict` (no write) for a linked skill whose rarity/group is
 * added, changed or removed. An unlinked catalog row may be edited freely. This
 * runs AFTER `assertNoLinkCollision`, so a genuine group collision still
 * reports `link_collision` first.
 */
async function assertSkillAssociationStable(
  tx: DbClient,
  definitionId: string,
  existingConfig: Record<string, unknown>,
  finalConfig: Record<string, unknown>
): Promise<void> {
  const existingParsed = parseCatalogConfig("skills", existingConfig)
  const existingRarity =
    typeof existingParsed.rarity === "string" &&
    existingParsed.rarity.length > 0
      ? existingParsed.rarity
      : undefined
  const finalParsed = parseCatalogConfig("skills", finalConfig)
  const finalRarity =
    typeof finalParsed.rarity === "string" && finalParsed.rarity.length > 0
      ? finalParsed.rarity
      : undefined
  const existingGroup = upgradeGroupForConfig(existingConfig)
  const finalGroup = upgradeGroupForConfig(finalConfig)
  // Rarity AND group both stable - an ordinary metadata / effects edit, nothing
  // to protect.
  if (existingRarity === finalRarity && existingGroup === finalGroup) return
  const links = await tx.characterAssociation.findMany({
    where: { definitionId },
  })
  if (links.length === 0) return
  throw conflict(
    "skill_rarity_conflict",
    "This skill is assigned to a character; its rarity or upgrade group cannot be added, changed or removed while it is linked"
  )
}

/**
 * Reject a catalog update that would introduce a link collision on an EXISTING
 * character: an equipment `slot`, a title `upgradeGroup`, a skill `upgradeGroup`,
 * or a bloodline `upgradeGroup` collision (a character can never have two
 * effective non-archived links in the same slot/group).
 * A config edit / unarchive that introduces such a collision is rejected with 409
 * and the whole update is rolled back. Archived definitions are inert and never
 * collide. The check runs inside the same transaction as the update.
 */
/**
 * Verify that an equipment config's divine-patron reference resolves to an
 * existing, unarchived god catalog entry. Used on a NEW / config-changing
 * equipment write so a config never references a god that does not exist (or is
 * archived, which would render the item permanently ineligible). No-op when the
 * config names no patron.
 */
async function assertEquipmentGodRef(
  tx: DbClient,
  config: Record<string, unknown>
): Promise<void> {
  const requiredGodStableId = config.requiredGodStableId
  if (
    typeof requiredGodStableId !== "string" ||
    requiredGodStableId.length === 0
  ) {
    return
  }
  const god = await tx.catalogDefinition.findUnique({
    where: { kind_stableId: { kind: "gods", stableId: requiredGodStableId } },
  })
  if (!god) {
    throw badRequest(
      "invalid_config",
      `Equipment config requires divine patron "${requiredGodStableId}" which does not exist in the catalog`
    )
  }
  if (god.archived) {
    throw badRequest(
      "invalid_config",
      `Equipment config requires divine patron "${requiredGodStableId}" which is archived`
    )
  }
}

/**
 * Verify that a `skills` config's optional `classStableId` reference resolves to an
 * existing, unarchived `classes` catalog entry. Used on a NEW / config-changing
 * skill write. A missing `classStableId` is a no-op (priority-only). A NEW
 * selection (a value that differs from the existing config) must reference an
 * ACTIVE class; an archived class is tolerated only when the skill already
 * referenced that same class (a prior reference), so editing a skill that already
 * ties to an archived class never breaks. No-op when the config names no class.
 */
async function assertSkillClassRef(
  tx: DbClient,
  config: Record<string, unknown>,
  existingConfig: Record<string, unknown> | null
): Promise<void> {
  const classStableId = skillClassStableIdOf(config)
  if (classStableId == null) return
  const cls = await tx.catalogDefinition.findUnique({
    where: { kind_stableId: { kind: "classes", stableId: classStableId } },
  })
  if (!cls) {
    throw badRequest(
      "invalid_config",
      `Skill config classStableId "${classStableId}" does not exist in the catalog`
    )
  }
  if (cls.archived) {
    const priorClassStableId =
      existingConfig != null ? skillClassStableIdOf(existingConfig) : null
    if (priorClassStableId !== classStableId) {
      throw badRequest(
        "invalid_config",
        `Skill config classStableId "${classStableId}" is archived; a new class-tie selection must reference an active class`
      )
    }
  }
}

/**
 * Represent the prospective state of the skill being created or edited for
 * upgrade-graph validation: its (renamed) stableId, parsed config, archived
 * flag, and - on an update - the existing row id to exclude from the node set
 * and the PRIOR config whose outgoing edges must stay untouched.
 */
type SkillGraphSource = {
  /** The existing catalog row id to EXCLUDE from the node set (update only). */
  sourceRowId?: string
  /** The prospective stableId (may differ from the stored one on a rename). */
  sourceStableId: string
  /** The prospective parsed config (may differ on a config-changing update). */
  sourceConfig: Record<string, unknown>
  /** The prospective archived flag (may differ on an archival toggle). */
  sourceArchived: boolean
  /**
   * The PRIOR config's outgoing edges, used to decide which targets are newly
   * added/changed (must target active skills) vs unchanged (an archived-target
   * reference may remain). `null` on a create (every edge is new).
   */
  previousConfig?: Record<string, unknown> | null
}

/**
 * Validate the GLOBAL skill upgrade graph for a skill create or config-changed
 * update, reusing the pure helpers from `lib/skills/upgrade-graph.ts`.
 *
 * Reads EVERY skill definition (including archived) in the transaction snapshot,
 * overlays the prospective source node (the skill being created/edited, with its
 * prospective stableId and config - so a rename or config change is validated as
 * it will commit), and validates references plus global directed acyclicity
 * across the whole skill graph, archived nodes included. Rejects with a 400:
 *   - a target that does not exist (`invalid_skill_upgrade_graph`, "missing");
 *   - a target that exists but is NOT a skill (`invalid_skill_upgrade_graph`,
 *     "wrong kind");
 *   - a self-link, a duplicate node stableId, or a cycle
 *     (`invalid_skill_upgrade_graph`);
 *   - a NEWLY ADDED / changed outgoing edge that targets an ARCHIVED skill
 *     (`skill_upgrade_archived_target`). An unchanged archived-target reference
 *     already present in the prior config is permitted, and the archived target
 *     simply stays unavailable to upgrade.
 *
 * Rarity and track are ignored: an edge to a same/lower-rarity, `Unique`, or
 * cross-track target is allowed. `upgradeToStableIds: []` is allowed (an
 * explicitly terminal skill). No-op unless the source is a `skills` definition.
 */
async function assertSkillUpgradeGraph(
  tx: DbClient,
  source: SkillGraphSource
): Promise<void> {
  const rows = await tx.catalogDefinition.findMany({
    where: { kind: "skills" },
  })
  const nodes: SkillUpgradeNode[] = []
  for (const row of rows) {
    if (row.id === source.sourceRowId) continue
    nodes.push({
      stableId: row.stableId,
      archived: row.archived,
      config: row.config ?? {},
    })
  }
  nodes.push({
    stableId: source.sourceStableId,
    archived: source.sourceArchived,
    config: source.sourceConfig,
  })

  const skillIds = new Set(nodes.map((n) => n.stableId))

  // Resolve every explicit target across the whole graph (archived nodes
  // included) against the skill node set. A target that exists in the catalog
  // but is not a `skills` row is a "wrong kind" reference; one that does not
  // exist at all is "missing".
  let allStableIds: Set<string> | null = null
  const resolveTarget = async (
    target: string,
    fromStableId: string
  ): Promise<void> => {
    if (skillIds.has(target)) return
    if (allStableIds == null) {
      const allRows = await tx.catalogDefinition.findMany({})
      allStableIds = new Set(allRows.map((r) => r.stableId))
    }
    if (allStableIds.has(target)) {
      throw badRequest(
        "invalid_skill_upgrade_graph",
        `Skill "${fromStableId}" upgrades to "${target}" which exists but is not a skill`
      )
    }
    throw badRequest(
      "invalid_skill_upgrade_graph",
      `Skill "${fromStableId}" upgrades to missing stableId "${target}"`
    )
  }

  for (const node of nodes) {
    const targets = skillUpgradeTargets(node.config) ?? []
    for (const target of targets) {
      await resolveTarget(target, node.stableId)
    }
  }

  // Structural graph validation: duplicate stableIds, self-links, and cycles.
  const graphError = validateSkillUpgradeGraph(nodes)
  if (graphError != null) {
    throw badRequest("invalid_skill_upgrade_graph", graphError)
  }

  // Active-target policy: newly ADDED / changed outgoing edges of the source
  // skill must target a currently ACTIVE (unarchived) skill. An unchanged
  // archived-target reference stays allowed. On a create every edge is new, so
  // every target must be active. `[]` (terminal) has no edges and is allowed.
  const newTargets = skillUpgradeTargets(source.sourceConfig) ?? []
  const previousTargets = source.previousConfig
    ? (skillUpgradeTargets(source.previousConfig) ?? [])
    : []
  const addedOrChanged = newTargets.filter(
    (target) => !previousTargets.includes(target)
  )
  for (const target of addedOrChanged) {
    const targetNode = nodes.find((n) => n.stableId === target)
    if (targetNode && targetNode.archived) {
      throw badRequest(
        "skill_upgrade_archived_target",
        `Skill "${source.sourceStableId}" upgrades to archived skill "${target}"`
      )
    }
  }
}

/**
 * Verify that an equipment config's equipment-granted passive-skill references
 * (`grantedSkillStableIds`) all resolve to an existing, unarchived `skills`
 * catalog definition. Used on a NEW / config-changing equipment write so a config
 * never references a skill that does not exist (or is archived, which would render
 * the item's granted passives permanently inert). No-op when the config grants no
 * skill. A skill created by the same write is not considered here (import paths
 * build their own allow-set); this helper only checks the live catalog.
 */
async function assertEquipmentGrantedSkillsRefs(
  tx: DbClient,
  config: Record<string, unknown>
): Promise<void> {
  const granted = config.grantedSkillStableIds
  if (!Array.isArray(granted) || granted.length === 0) return
  const rows = await tx.catalogDefinition.findMany({
    where: { kind: "skills" },
  })
  const unarchivedStableIds = new Set(
    rows.filter((r) => !r.archived).map((r) => r.stableId)
  )
  const allStableIds = new Set(rows.map((r) => r.stableId))
  for (const stableId of granted) {
    if (typeof stableId !== "string" || stableId.length === 0) continue
    if (unarchivedStableIds.has(stableId)) continue
    if (allStableIds.has(stableId)) {
      throw badRequest(
        "invalid_config",
        `Equipment config grants skill "${stableId}" which is archived`
      )
    }
    throw badRequest(
      "invalid_config",
      `Equipment config grants skill "${stableId}" which does not exist in the catalog`
    )
  }
}

/**
 * Verify that a title config's title-granted passive-skill references
 * (`grantedSkillStableIds`) all resolve to an existing, unarchived `skills`
 * catalog definition. Used on a NEW / config-changing title write so a config
 * never references a skill that does not exist (or is archived, which would render
 * the title's granted passives permanently inert). No-op when the config grants no
 * skill. A skill created by the same write is not considered here (import paths
 * build their own allow-set); this helper only checks the live catalog.
 */
async function assertTitleGrantedSkillsRefs(
  tx: DbClient,
  config: Record<string, unknown>
): Promise<void> {
  const granted = config.grantedSkillStableIds
  if (!Array.isArray(granted) || granted.length === 0) return
  const rows = await tx.catalogDefinition.findMany({
    where: { kind: "skills" },
  })
  const unarchivedStableIds = new Set(
    rows.filter((r) => !r.archived).map((r) => r.stableId)
  )
  const allStableIds = new Set(rows.map((r) => r.stableId))
  for (const stableId of granted) {
    if (typeof stableId !== "string" || stableId.length === 0) continue
    if (unarchivedStableIds.has(stableId)) continue
    if (allStableIds.has(stableId)) {
      throw badRequest(
        "invalid_config",
        `Title config grants skill "${stableId}" which is archived`
      )
    }
    throw badRequest(
      "invalid_config",
      `Title config grants skill "${stableId}" which does not exist in the catalog`
    )
  }
}

/**
 * Verify that a race/class/profession config's grade-granted skill references
 * (`gradeGrantedSkillStableIds`) all resolve to an existing, unarchived `skills`
 * catalog definition. Used on a NEW / config-changing race/class/profession write
 * so a config never references a skill that does not exist (or is archived, which
 * would render the grade grant permanently inert and silently skip it). No-op when
 * the config grants no skill. A skill created by the same write is not considered
 * here (import paths build their own allow-set); this helper only checks the live
 * catalog.
 */
async function assertGradeGrantedSkillsRefs(
  tx: DbClient,
  config: Record<string, unknown>
): Promise<void> {
  const refs = allGradeGrantedSkillStableIds(config)
  if (refs.length === 0) return
  const rows = await tx.catalogDefinition.findMany({
    where: { kind: "skills" },
  })
  const unarchivedStableIds = new Set(
    rows.filter((r) => !r.archived).map((r) => r.stableId)
  )
  const allStableIds = new Set(rows.map((r) => r.stableId))
  for (const stableId of refs) {
    if (typeof stableId !== "string" || stableId.length === 0) continue
    if (unarchivedStableIds.has(stableId)) continue
    if (allStableIds.has(stableId)) {
      throw badRequest(
        "invalid_config",
        `Grade-granted skill "${stableId}" is archived`
      )
    }
    throw badRequest(
      "invalid_config",
      `Grade-granted skill "${stableId}" does not exist in the catalog`
    )
  }
}

/**
 * Prevent a god `stableId` rename that would dangle any equipment config whose
 * `requiredGodStableId` names the OLD id. Archiving a god is always allowed (an
 * archived patron simply renders referencing equipment ineligible), but a rename
 * must be blocked while any equipment entry references the old id - otherwise the
 * reference silently dangles and the item becomes permanently ineligible. No-op
 * unless a god's stableId is actually changing.
 */
async function assertGodStableIdRename(
  tx: DbClient,
  kind: string,
  existingStableId: string,
  proposedStableId: string | undefined
): Promise<void> {
  if (kind !== "gods") return
  if (proposedStableId == null || proposedStableId === existingStableId) return
  const equipment = await tx.catalogDefinition.findMany({
    where: { kind: "equipment" },
  })
  const refs: string[] = []
  for (const row of equipment) {
    const cfg = parseCatalogConfig("equipment", row.config ?? {})
    if (cfg.requiredGodStableId === existingStableId) refs.push(row.stableId)
  }
  if (refs.length > 0) {
    throw conflict(
      "god_stable_id_in_use",
      `God "${existingStableId}" is referenced as the required divine patron by ${refs.length} equipment entr${refs.length === 1 ? "y" : "ies"} (${refs.join(", ")}); renaming it would leave those references dangling`
    )
  }
}

/**
 * Prevent a skill `stableId` rename that would dangle any equipment config whose
 * `grantedSkillStableIds` names the OLD id, or any race/class/profession config
 * whose `gradeGrantedSkillStableIds` names the OLD id for any grade. Archiving a
 * skill is always allowed (an archived granted/graded skill is simply inert), but
 * a rename must be blocked while ANY referencing row - including archived rows -
 * names the old id in its granted-skill or grade-granted list, otherwise the
 * grant silently dangles and the item's passive / grade skill is lost. No-op
 * unless a skill's stableId is actually changing.
 */
async function assertSkillStableIdRename(
  tx: DbClient,
  kind: string,
  existingStableId: string,
  proposedStableId: string | undefined
): Promise<void> {
  if (kind !== "skills") return
  if (proposedStableId == null || proposedStableId === existingStableId) return
  const equipment = await tx.catalogDefinition.findMany({
    where: { kind: "equipment" },
  })
  const refs: string[] = []
  for (const row of equipment) {
    const cfg = parseCatalogConfig("equipment", row.config ?? {})
    const granted = cfg.grantedSkillStableIds
    if (Array.isArray(granted) && granted.includes(existingStableId)) {
      refs.push(row.stableId)
    }
  }
  if (refs.length > 0) {
    throw conflict(
      "skill_stable_id_in_use",
      `Skill "${existingStableId}" is granted by ${refs.length} equipment entr${refs.length === 1 ? "y" : "ies"} (${refs.join(", ")}); renaming it would leave those grants dangling`
    )
  }
  // A skill rename must ALSO be blocked while any race/class/profession config's
  // `gradeGrantedSkillStableIds` (for ANY grade, including archived track rows)
  // names the old id - otherwise the grade grant silently dangles and the skill is
  // silently skipped at acquisition. Read every row (including archived) so a
  // config that still references an archived definition is protected.
  const gradeTrackKinds = ["races", "classes", "professions"] as const
  const gradeRefs: Array<{ kind: string; stableId: string }> = []
  for (const trackKind of gradeTrackKinds) {
    const rows = await tx.catalogDefinition.findMany({
      where: { kind: trackKind },
    })
    for (const row of rows) {
      const cfg = parseCatalogConfig(trackKind, row.config ?? {})
      if (allGradeGrantedSkillStableIds(cfg).includes(existingStableId)) {
        gradeRefs.push({ kind: trackKind, stableId: row.stableId })
      }
    }
  }
  if (gradeRefs.length > 0) {
    const labels = gradeRefs.map((r) => `${r.kind}:${r.stableId}`).join(", ")
    throw conflict(
      "skill_stable_id_in_use",
      `Skill "${existingStableId}" is granted by ${gradeRefs.length} race/class/profession grade entr${gradeRefs.length === 1 ? "y" : "ies"} (${labels}); renaming it would leave those grants dangling`
    )
  }
  // A skill rename must ALSO be blocked while any TITLE config's
  // `grantedSkillStableIds` (for ANY entry, including archived title rows) names
  // the old id - otherwise the title-granted passive silently dangles and is
  // skipped at read. Read every row (including archived) so a config that still
  // references an archived definition is protected.
  const titleRows = await tx.catalogDefinition.findMany({
    where: { kind: "titles" },
  })
  const titleRefs: string[] = []
  for (const row of titleRows) {
    const cfg = parseCatalogConfig("titles", row.config ?? {})
    const granted = cfg.grantedSkillStableIds
    if (Array.isArray(granted) && granted.includes(existingStableId)) {
      titleRefs.push(row.stableId)
    }
  }
  if (titleRefs.length > 0) {
    throw conflict(
      "skill_stable_id_in_use",
      `Skill "${existingStableId}" is granted by ${titleRefs.length} title entr${titleRefs.length === 1 ? "y" : "ies"} (${titleRefs.join(", ")}); renaming it would leave those grants dangling`
    )
  }
  // A skill rename must ALSO be blocked while any SKILL config's
  // `upgradeToStableIds` (for ANY entry, including archived skill rows) names the
  // old id - otherwise the explicit upgrade edge silently dangles and the
  // successor is lost. Read every skill row (including archived) so a config
  // that still references an archived definition is protected. No automatic
  // rewrite: the rename is rejected, not the reference updated.
  const skillRows = await tx.catalogDefinition.findMany({
    where: { kind: "skills" },
  })
  const upgradeRefs: Array<{ kind: string; stableId: string }> = []
  for (const row of skillRows) {
    const cfg = parseCatalogConfig("skills", row.config ?? {})
    const targets = skillUpgradeTargets(cfg) ?? []
    if (targets.includes(existingStableId)) {
      upgradeRefs.push({ kind: "skills", stableId: row.stableId })
    }
  }
  if (upgradeRefs.length > 0) {
    const labels = upgradeRefs.map((r) => `${r.kind}:${r.stableId}`).join(", ")
    throw conflict(
      "skill_stable_id_in_use",
      `Skill "${existingStableId}" is referenced as an upgrade target by ${upgradeRefs.length} skill entr${upgradeRefs.length === 1 ? "y" : "ies"} (${labels}); renaming it would leave those upgrade edges dangling`
    )
  }
}

/**
 * Prevent a class `stableId` rename that would dangle any skill config whose
 * optional `classStableId` names the OLD id. Archiving a class is always allowed
 * (an archived class just means a tied skill no longer gets class-priority
 * sorting, and a prior reference to it stays valid), but a rename must be blocked
 * while any skill config - including archived skill rows - still names the old id
 * in its class tie, otherwise the reference silently dangles and the class-tie
 * priority is permanently lost. No-op unless a class's stableId is actually
 * changing.
 */
async function assertClassStableIdRename(
  tx: DbClient,
  kind: string,
  existingStableId: string,
  proposedStableId: string | undefined
): Promise<void> {
  if (kind !== "classes") return
  if (proposedStableId == null || proposedStableId === existingStableId) return
  const skills = await tx.catalogDefinition.findMany({
    where: { kind: "skills" },
  })
  const refs: Array<{ kind: string; stableId: string }> = []
  for (const row of skills) {
    const cfg = parseCatalogConfig("skills", row.config ?? {})
    if (skillClassStableIdOf(cfg) === existingStableId) {
      refs.push({ kind: "skills", stableId: row.stableId })
    }
  }
  if (refs.length > 0) {
    const labels = refs.map((r) => `${r.kind}:${r.stableId}`).join(", ")
    throw conflict(
      "class_stable_id_in_use",
      `Class "${existingStableId}" is referenced as the class tie by ${refs.length} skill entr${refs.length === 1 ? "y" : "ies"} (${labels}); renaming it would leave those references dangling`
    )
  }
}

async function assertNoLinkCollision(
  tx: DbClient,
  kind: string,
  definitionId: string,
  finalConfig: Record<string, unknown>,
  finalArchived: boolean
): Promise<void> {
  // Only slots (equipment) and upgrade groups (titles/skills/bloodlines) can
  // collide. Archived definitions synthesise no effect so they cannot conflict.
  if (
    kind !== "equipment" &&
    kind !== "titles" &&
    kind !== "skills" &&
    kind !== "bloodlines"
  ) {
    return
  }
  if (finalArchived) return

  const links = await tx.characterAssociation.findMany({
    where: { definitionId },
    include: {
      character: {
        include: { associations: { include: { definition: true } } },
      },
    },
  })

  const slot = kind === "equipment" ? slotForConfig(finalConfig) : undefined
  const group =
    kind === "titles" || kind === "skills" || kind === "bloodlines"
      ? upgradeGroupForConfig(finalConfig)
      : undefined
  const value = slot ?? group
  if (!value) return

  const expectedAssocKind =
    kind === "equipment"
      ? "EQUIPMENT"
      : kind === "titles"
        ? "TITLE"
        : kind === "skills"
          ? "SKILL"
          : "BLOODLINE"
  for (const link of links) {
    const character = link.character
    if (!character) continue
    // For equipment, the collision key is PER-LINK: a Ring-slot item's key is its
    // physical position (a character may wear two rings in distinct positions), so
    // the effective key cannot be derived from the config alone and must read the
    // persisted position on the link. Non-equipment keeps the single group value.
    const editedValue =
      kind === "equipment"
        ? equipmentCollisionKey(
            (link as { equipmentPosition?: "Ring 1" | "Ring 2" | null })
              .equipmentPosition,
            finalConfig
          )
        : value
    if (!editedValue) continue
    for (const other of character.associations ?? []) {
      if (other.definitionId === definitionId) continue
      if (other.kind !== expectedAssocKind) continue
      const def = other.definition
      if (!def || def.archived) continue
      const otherConfig = parseCatalogConfig(def.kind, def.config ?? {})
      const otherValue =
        kind === "equipment"
          ? equipmentCollisionKey(
              (other as { equipmentPosition?: "Ring 1" | "Ring 2" | null })
                .equipmentPosition,
              otherConfig
            )
          : upgradeGroupForConfig(otherConfig)
      if (otherValue === editedValue) {
        throw conflict(
          "link_collision",
          `Catalog edit would put "${character.name}" in conflict: "${def.name}" already occupies the same ${kind === "equipment" ? "slot" : "upgrade group"}`
        )
      }
    }
  }
}

function slotForConfig(config: Record<string, unknown>): string | undefined {
  return normalizeEquipmentSlot(config.slot)
}

/**
 * The collision key for an equipment link. For a non-ring item this is the
 * normalized slot (so two items cannot share a slot). For a Ring-slot item it is
 * the PHYSICAL position (`Ring:<pos>`), because Ring is ONE catalog slot but a
 * character may wear two rings, one per position - two distinct positions never
 * collide, only the same position does. When the position cannot be resolved
 * (defensive; after the migration it is always present) the whole "Ring" slot is
 * used as the key so an unresolvable ring never silently coexists with another.
 */
function equipmentCollisionKey(
  equipmentPosition: "Ring 1" | "Ring 2" | null | undefined,
  config: Record<string, unknown>
): string | undefined {
  const slot = slotForConfig(config)
  if (!slot) return undefined
  if (slot === "Ring") {
    const pos = equipmentPosition ?? legacyRingPositionForConfig(config)
    return pos ? `Ring:${pos}` : "Ring"
  }
  return slot
}

function upgradeGroupForConfig(
  config: Record<string, unknown>
): string | undefined {
  const group = config.upgradeGroup
  return typeof group === "string" && group.length > 0 ? group : undefined
}

export type UpdateCatalogItemPatch = {
  stableId?: string
  name?: string
  description?: string | null
  grade?: string | null
  sourceUrl?: string | null
  archived?: boolean
  config?: Record<string, unknown>
  gradeDescriptions?: Partial<Record<Grade, string>>
}

/**
 * Validate and persist a catalog update inside an already-open caller-owned
 * transaction. This is the transactional core that `updateCatalogItem` wraps.
 *
 * A caller that must sequence multiple catalog writes atomically (e.g. a managed
 * MCP publisher) opens its own SERIALIZABLE transaction and passes the
 * transaction client as `tx`. Every read, guard (title/skill/race/equipment
 * stable-ID, link-collision, race-type-in-use) and the final write run against
 * the same transaction snapshot, so a concurrent rename cannot commit between a
 * guard's read and the write and leave a dangling reference. It never opens a
 * nested transaction nor touches the global `prisma` client.
 *
 * Nullable PATCH semantics for `description` and `sourceUrl`: an omitted
 * (`undefined`) value preserves the stored column; an explicit `null` clears it.
 */
export async function updateCatalogItemInTransaction(
  tx: DbClient,
  kind: string,
  id: string,
  patch: UpdateCatalogItemPatch,
  options?: CatalogItemWriteOptions
): Promise<CatalogItem> {
  kind = normalizeCatalogKind(kind)
  // A gods entry carries no catalog grade band (see `godGradeForbidden`): a PATCH
  // that tries to set a non-null grade on a god is rejected before any write;
  // `grade: null` (or omitting grade) is the only legal value. A migrated god
  // already stores `grade IS NULL`, so clearing it is a harmless no-op.
  if (godGradeForbidden(kind, patch.grade)) {
    throw badRequest(
      "invalid_grade",
      'Gods carry no catalog grade: a gods entry must store "grade" as null'
    )
  }
  // A race/class/profession always carries a required catalog grade (see
  // `requiredGradeNullForbidden`): a PATCH that explicitly clears it to null is
  // rejected before any write, so a valid grade is never accidentally erased by
  // a generic optional-grade clear. Omitting grade stays legal (the existing
  // non-null value is preserved).
  if (requiredGradeNullForbidden(kind, patch.grade)) {
    throw badRequest(
      "invalid_grade",
      'A race/class/profession always carries a required catalog grade: "grade" cannot be cleared to null'
    )
  }
  // A currencies entry carries no catalog grade band (see `currencyGradeForbidden`):
  // a PATCH that tries to set a non-null grade on a currency is rejected before any
  // write; `grade: null` (or omitting grade) is the only legal value.
  if (currencyGradeForbidden(kind, patch.grade)) {
    throw badRequest(
      "invalid_grade",
      'Currencies carry no catalog grade: a currencies entry must store "grade" as null'
    )
  }
  // A currencies entry carries no grade ladder, so a PATCH that tries to set a
  // non-empty gradeDescriptions map is rejected before any write; an omitted value
  // preserves the stored (empty) map.
  if (currencyGradeDescriptionsForbidden(kind, patch.gradeDescriptions)) {
    throw badRequest(
      "invalid_grade_descriptions",
      'Currencies carry no grade ladder: "gradeDescriptions" must be empty or omitted'
    )
  }
  // A skills entry carries no catalog grade band (see `skillGradeForbidden`): a
  // PATCH that tries to set a non-null grade on a skill is rejected before any
  // write; `grade: null` (or omitting grade) is the only legal value. A migrated
  // skill already stores `grade IS NULL`, so clearing it is a harmless no-op.
  if (skillGradeForbidden(kind, patch.grade)) {
    throw badRequest(
      "invalid_grade",
      'Skills carry no catalog grade: a skills entry must store "grade" as null'
    )
  }
  // A skills entry carries no grade ladder, so a PATCH that tries to set a
  // non-empty gradeDescriptions map is rejected before any write; an omitted value
  // preserves the stored (empty) map.
  if (skillGradeDescriptionsForbidden(kind, patch.gradeDescriptions)) {
    throw badRequest(
      "invalid_grade_descriptions",
      'Skills carry no grade ladder: "gradeDescriptions" must be empty or omitted'
    )
  }
  const existing = await tx.catalogDefinition.findUnique({ where: { id } })
  if (!existing || existing.kind !== kind) {
    throw notFound("catalog_not_found", "Catalog entry not found")
  }
  let config: Record<string, unknown> | undefined
  if (patch.config != null) {
    config = parseConfigOr400(kind, patch.config)
    if (kind === "skills" && isIncompleteSkillConfig(config)) {
      throw badRequest(
        "invalid_config",
        'Skill config requires a "track": expected "race", "class" or "profession"'
      )
    }
    if (kind === "skills" && hasInvalidSkillTrack(config)) {
      throw badRequest(
        "invalid_config",
        'Skill config has an invalid "track": expected "race", "class" or "profession"'
      )
    }
    // A config-changing skill PATCH, like a new skill POST, must declare a
    // valid rarity. A legacy config that never carried one is editable only
    // via a metadata-only PATCH (no `config` in the payload).
    if (kind === "skills" && isIncompleteSkillRarity(config)) {
      throw badRequest(
        "invalid_config",
        'Skill config requires a valid "rarity" (one of Inferior/Common/Uncommon/Rare/Epic/Ancient/Legendary/Mythical/Sacred/Divine/Unique)'
      )
    }
    if (kind === "races" && isIncompleteRaceConfig(config)) {
      // raceType / naturalGrade are either present-but-invalid or missing
      // entirely. An explicitly-provided invalid value is rejected outright;
      // a missing value is allowed only when the EXISTING config already
      // carries a valid one (preserved into the new config, the same way a
      // raceType is preserved). This keeps a config-changing PATCH on an
      // already-typed race from silently erasing its naturalGrade into the
      // legacy F fallback. A config-changing PATCH on a legacy race that never
      // declared either field is rejected - there is nothing to preserve, so
      // both must be supplied.
      if (hasInvalidRaceTypeConfig(config)) {
        throw badRequest(
          "invalid_config",
          'Race config has an invalid "raceType": expected "enlightened" or "monster"'
        )
      }
      if (hasInvalidNaturalGradeConfig(config)) {
        throw badRequest(
          "invalid_config",
          'Race config has an invalid "naturalGrade": expected one of "G","F","E","D","C","B","A","S"'
        )
      }
      const merged = { ...config }
      const existingParsed = parseCatalogConfig("races", existing.config ?? {})
      const existingRaceType = existingParsed.raceType
      if (
        merged.raceType == null &&
        (existingRaceType === "enlightened" || existingRaceType === "monster")
      ) {
        merged.raceType = existingRaceType as RaceType
      }
      const existingNaturalGrade = existingParsed.naturalGrade
      if (
        merged.naturalGrade == null &&
        gradeSchema.safeParse(existingNaturalGrade).success
      ) {
        merged.naturalGrade = existingNaturalGrade as Grade
      }
      // After preservation, a legacy row that never declared an authoritative
      // type or natural grade must supply BOTH explicitly.
      if (
        (merged.raceType !== "enlightened" && merged.raceType !== "monster") ||
        !gradeSchema.safeParse(merged.naturalGrade).success
      ) {
        throw badRequest(
          "invalid_config",
          'Race config must declare a valid "raceType" ("enlightened"/"monster") and a valid "naturalGrade" ("G","F","E","D","C","B","A","S")'
        )
      }
      config = merged
    }
    if (kind === "bloodlines" && isLegacyBloodlineConfig(config)) {
      throw badRequest(
        "invalid_config",
        'Bloodline config is missing required "effects" field'
      )
    }
    if (
      kind === "transcendent_skills" &&
      isLegacyTranscendentSkillConfig(config)
    ) {
      throw badRequest(
        "invalid_config",
        'Transcendent skill config is missing required "passiveEffects" field'
      )
    }
    // A config-changing equipment PATCH, like a new POST, requires the modern
    // full shape: a valid slot AND a valid rarity. Legacy configs remain
    // editable for metadata-only PATCHes (no `config` in the payload).
    if (kind === "equipment" && isIncompleteEquipmentConfig(config)) {
      throw badRequest(
        "invalid_config",
        'Equipment config requires a valid "slot" (one of Head/Chest/Back/Arms/Hands/Legs/Feet/Neck/Ring/Weapon, or a documented legacy alias) and a valid "rarity"'
      )
    }
    // A config-changing equipment PATCH must also persist the CANONICAL
    // requirement keys, never the legacy `minRaceLevel` / `requiredRaceType`
    // (the editor migrates them); an existing row that carries them stays
    // readable and enforced, but a config change may not reintroduce them.
    if (kind === "equipment" && hasLegacyEquipmentRequirements(config)) {
      throw badRequest(
        "invalid_config",
        'Equipment config uses the legacy "minRaceLevel"/"requiredRaceType"; use the canonical "minimumLevel"/"requiredLevelType"'
      )
    }
    // A config-changing equipment write must not reference a missing/archived
    // divine patron.
    if (kind === "equipment") await assertEquipmentGodRef(tx, config)
    // A config-changing equipment write must not grant a missing/archived
    // passive skill.
    if (kind === "equipment") await assertEquipmentGrantedSkillsRefs(tx, config)
    // A config-changing title write must not grant a missing/archived passive
    // skill.
    if (kind === "titles") await assertTitleGrantedSkillsRefs(tx, config)
    // A config-changing race/class/profession write must not reference a
    // missing/archived grade-granted skill.
    if (kind === "races" || kind === "classes" || kind === "professions") {
      await assertGradeGrantedSkillsRefs(tx, config)
    }
    // A config-changing skill write that declares an optional class tie must
    // reference an existing class. A NEW selection (a value differing from the
    // existing config) must be ACTIVE; an unchanged prior reference to an
    // archived class is tolerated.
    if (kind === "skills") {
      await assertSkillClassRef(
        tx,
        config,
        parseCatalogConfig("skills", existing.config ?? {})
      )
    }
  }
  const finalConfig = config ?? parseCatalogConfig(kind, existing.config ?? {})
  const finalArchived =
    patch.archived != null ? patch.archived : existing.archived
  // A race's `raceType` is a mechanical advancement-mode fact: it governs how
  // a character advances and what tracks it may carry. A legacy config missing
  // `raceType` is interpreted as "enlightened" (the same non-authoritative
  // default used everywhere else). When the effective type would change and
  // any character still references this race as its raceId, reject BEFORE the
  // write (no silent conversion of those characters); metadata, archival /
  // unarchival and same-type config edits are allowed.
  if (kind === "races") {
    const currentEffectiveType =
      (parseCatalogConfig("races", existing.config ?? {}).raceType as
        RaceType | undefined) ?? "enlightened"
    const proposedType =
      (finalConfig.raceType as RaceType | undefined) ?? "enlightened"
    if (currentEffectiveType !== proposedType) {
      const references = await tx.character.findMany({
        where: { raceId: id },
      })
      if (references.length > 0) {
        throw conflict(
          "race_type_in_use",
          `Race "${existing.name}" is referenced by ${references.length} character(s); its type cannot change from "${currentEffectiveType}" to "${proposedType}" without an explicit conversion`
        )
      }
    }
  }
  // A config-changing equipment PATCH, like a new POST, requires the modern
  // category while any character still links it: a linked ring has no slot to
  // fall back to on a non-Ring item, and a linked non-Ring item cannot carry a
  // ring position. Allowed once the item is unequipped (no links). Ring legacy
  // ("Ring 1"/"Ring 2") -> canonical "Ring" is a same-category edit and is NOT
  // blocked here; it preserves each link's position and is checked for
  // duplicate active occupied positions by assertNoLinkCollision below.
  if (kind === "equipment") {
    const existingConfig = parseCatalogConfig(
      "equipment",
      existing.config ?? {}
    )
    const existingIsRing = slotForConfig(existingConfig) === "Ring"
    const finalIsRing = slotForConfig(finalConfig) === "Ring"
    if (existingIsRing !== finalIsRing) {
      const links = await tx.characterAssociation.findMany({
        where: { definitionId: id },
      })
      if (links.length > 0) {
        throw conflict(
          "equipment_position_conflict",
          `Catalog "${existing.name}" would change from ${existingIsRing ? "a Ring slot" : "a non-Ring slot"} to ${finalIsRing ? "a Ring slot" : "a non-Ring slot"} but is equipped by ${links.length} character(s); unequip it first`
        )
      }
    }
  }
  await assertNoLinkCollision(tx, kind, id, finalConfig, finalArchived)
  // Renaming a god's stableId must not leave any equipment config referencing
  // the old id dangling (a dangling patron would render the item permanently
  // ineligible). Archiving is always allowed.
  await assertGodStableIdRename(tx, kind, existing.stableId, patch.stableId)
  // Renaming a skill's stableId must not leave any equipment config's
  // granted-skill list referencing the old id dangling (a dangling grant would
  // silently drop the item's synthesized passive). Archiving is always allowed.
  await assertSkillStableIdRename(tx, kind, existing.stableId, patch.stableId)
  // Renaming a class's stableId must not leave any skill config whose optional
  // `classStableId` names the old id dangling (a dangling class tie would
  // quietly drop the skill's class-priority sorting). Archiving is always
  // allowed.
  await assertClassStableIdRename(tx, kind, existing.stableId, patch.stableId)
  if (kind === "titles") {
    await assertTitleImprovementStable(
      tx,
      id,
      parseCatalogConfig("titles", existing.config ?? {}),
      finalConfig
    )
  }
  if (kind === "skills") {
    await assertSkillAssociationStable(
      tx,
      id,
      parseCatalogConfig("skills", existing.config ?? {}),
      finalConfig
    )
    // A config-changing skill PATCH must also keep the global skill upgrade graph
    // valid: newly added / changed outgoing edges must target a currently ACTIVE
    // skill (an unchanged archived-target reference may remain), and no edge may
    // be a self-link, a missing/wrong-kind target, or part of a cycle. A patch
    // that only edits metadata (no `config`) does not change the graph and is
    // not re-validated here. Skipped only when the caller prevalidated the final
    // full graph in the same SERIALIZABLE transaction
    // (`skillGraphValidatedInBatch`); the linked rarity/upgrade-group immutability
    // check above still runs.
    if (patch.config != null && options?.skillGraphValidatedInBatch !== true) {
      await assertSkillUpgradeGraph(tx, {
        sourceRowId: id,
        sourceStableId: patch.stableId ?? existing.stableId,
        sourceConfig: finalConfig,
        sourceArchived: finalArchived,
        previousConfig: parseCatalogConfig("skills", existing.config ?? {}),
      })
    }
  }
  // The clone path (`preserveRawSkillConfig`) keeps the supplied RAW JSON config
  // so unknown nested fields inside `effects` / `condition` survive verbatim; every
  // OTHER caller persists the parsed normalized config. Both paths have been fully
  // validated above - this only changes what is WRITTEN, never what is checked.
  const persistedConfig =
    kind === "skills" &&
    options?.preserveRawSkillConfig === true &&
    patch.config != null
      ? patch.config
      : config
  const row = await tx.catalogDefinition.update({
    where: { id },
    data: {
      ...(patch.stableId != null ? { stableId: patch.stableId } : {}),
      ...(patch.name != null ? { name: patch.name } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description }
        : {}),
      ...(patch.grade !== undefined ? { grade: patch.grade } : {}),
      ...(patch.sourceUrl !== undefined ? { sourceUrl: patch.sourceUrl } : {}),
      ...(patch.archived != null ? { archived: patch.archived } : {}),
      ...(persistedConfig != null
        ? { config: persistedConfig as Prisma.InputJsonValue }
        : {}),
      ...(patch.gradeDescriptions !== undefined
        ? {
            gradeDescriptions: patch.gradeDescriptions as Prisma.InputJsonValue,
          }
        : {}),
    },
  })
  return catalogItem(row)
}

export async function updateCatalogItem(
  kind: string,
  id: string,
  patch: UpdateCatalogItemPatch
): Promise<CatalogItem> {
  const normalizedKind = normalizeCatalogKind(kind)
  // A god stableId change, a race `raceType` change, every blessing / bloodline
  // config change, and every ranked-title identity guard (which reads the linked
  // character associations) read the existing row and then write it, so they run
  // under SERIALIZABLE isolation: two concurrent edits that race on the same
  // catalog row cannot both commit, and the loser surfaces as P2034 which we map
  // to a 409. A race type change is serializable so it also conflicts correctly
  // with an in-flight `createCharacter` that has read the race row (a serializable
  // read / write dependency), instead of silently allowing a character built from
  // a stale `raceType`. Equipment, race/class/profession config-changing PATCHes
  // are serializable too: they re-validate catalog references (god patron,
  // granted/graded skills) against the live catalog inside the transaction, so
  // they must run SERIALIZABLE to abort (P2034 -> 409) instead of persisting a
  // reference to a god/skill that a concurrent rename stableId-changed away.
  const serializable =
    normalizedKind === "gods" ||
    normalizedKind === "races" ||
    normalizedKind === "classes" ||
    normalizedKind === "professions" ||
    normalizedKind === "bloodlines" ||
    normalizedKind === "titles" ||
    normalizedKind === "skills" ||
    normalizedKind === "equipment"
      ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      : undefined
  try {
    return await prisma.$transaction(
      (tx) => updateCatalogItemInTransaction(tx, kind, id, patch),
      serializable
    )
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict(
        "catalog_stable_id_conflict",
        `Catalog entry with stableId "${patch.stableId}" already exists`
      )
    }
    if (isSerializationFailure(err)) {
      throw conflict(
        "catalog_serialization_conflict",
        "Concurrent catalog write conflict; retry the change"
      )
    }
    throw err
  }
}

// ------------------------------------------------------------------ //
// Skill variant cloning (admin upgrade-branch creation)
// ------------------------------------------------------------------ //

/** The validated clone-a-variant payload from `skillUpgradeCloneSchema`. */
export type SkillUpgradeCloneInput = z.infer<typeof skillUpgradeCloneSchema>

/**
 * Clone an ACTIVE `skills` catalog entry into a full mechanical copy at the
 * requested `rarity`, and link it as a DIRECT successor of the source, all inside
 * ONE SERIALIZABLE transaction.
 *
 * The clone is an exact copy of the source's identity (name/description/sourceUrl)
 * and a DEEP copy of its full RAW persisted catalog `config` (effects, conditions,
 * `track`, `classStableId`, `upgradeGroup` and every unknown passthrough key -
 * INCLUDING unknown nested metadata inside an `effect` or an `effect.condition`,
 * which Zod strips even though the top-level schema is `.passthrough()`). The
 * write payloads are built from a deep clone of the RAW `source.config`, never from
 * the Zod-parsed shape, and are persisted verbatim via
 * `preserveRawSkillConfig: true`; the parsed shape is consulted ONLY for the
 * known-field validation/rank/group/edge extraction. It differs only in:
 *   - `config.rarity` is set to the requested `input.rarity`;
 *   - `config.upgradeToStableIds` is set to `[]`, so the clone is explicitly
 *     terminal and never copies the source's outgoing edges.
 * The clone carries no catalog grade (`grade: null`) and no grade-specific prose
 * (`gradeDescriptions: {}`), matching the skills invariant (a skill has no grade
 * band).
 *
 * The source is then atomically linked as the clone's direct predecessor: its
 * `config.upgradeToStableIds` is rewritten to include the new clone stableId.
 *   - If the source ALREADY declares its own explicit `upgradeToStableIds` list
 *     (including `[]`), the new stableId is APPENDED at the end, preserving the
 *     declared order. A multi-branching skill therefore gains the new branch
 *     without disturbing its existing outgoing edges.
 *   - If the source is LEGACY (no own `upgradeToStableIds` field), the legacy
 *     `upgradeGroup` + `rarity` fallback successor set is preserved verbatim from
 *     the old runtime ONLY when the source declares BOTH a nonempty `upgradeGroup`
 *     AND a comparable ordered rarity: every currently ACTIVE skill in the same
 *     `upgradeGroup` whose rarity is STRICTLY higher than the source's ordered
 *     rarity (regardless of gap; the incomparable `Unique` and missing/unrecognized
 *     rarities never count) is sorted by rarity order then stableId, deduplicated,
 *     and the clone stableId is APPENDED last. A legacy source with NO group (its
 *     null group would otherwise match every unrelated ungrouped skill) or with an
 *     incomparable/missing rarity has no higher candidates - its only successor is
 *     the freshly cloned child (`[newChildStableId]`).
 *
 * Preconditions, all enforced inside the same transaction (so a failure leaves no
 * orphan clone and no half-linked source):
 *   - the source must exist, be a `skills` entry (404 otherwise), and be ACTIVE
 *     (400 `skill_archived` when archived);
 *   - the derived stableId (`deriveCatalogStableId(name + '-' + rarity)`) must be
 *     free (409 `catalog_stable_id_conflict` when a skill already owns the slug);
 *   - the cloned `classStableId` must resolve to an existing class: an archived
 *     class tie is rejected with 400 before/during the create (never silently
 *     dropped), rolling the whole transaction back;
 *   - the full skill upgrade graph must stay valid (targets exist, no self-link,
 *     no cycle) - validated via the shared helpers by the create and the source
 *     update, so a broken pre-existing graph aborts with 400 and rolls back;
 *   - the computed source successor set must fit within
 *     `SKILL_UPGRADE_TARGET_LIMIT`: when a legacy group (or an explicit edge list)
 *     would resolve to MORE than the limit, the clone fails EARLY with 409
 *     `skill_upgrade_group_too_large` (with guidance to restructure the group),
 *     before any row is written.
 *
 * The source's own `rarity` and `upgradeGroup` are never changed by the link, so
 * the linked-skill immutability guards remain satisfied. Character progression
 * events, status and character rows are never touched - only catalog rows.
 *
 * A concurrent unique (P2002) or serialization (P2034) conflict is surfaced as a
 * retryable 409, never a raw 500.
 */
export async function createSkillUpgradeVariant(
  sourceId: string,
  input: SkillUpgradeCloneInput
): Promise<{ source: CatalogItem; item: CatalogItem }> {
  const serializable = {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  }
  // Captured across the transaction boundary so a P2002 from the concurrent
  // create window can still report the real slug the clone was creating.
  let resolvedName = input.name ?? ""
  try {
    return await prisma.$transaction(async (tx) => {
      // Find the source by id: a wrong-kind / missing row is 404, an archived
      // skill is 400 (only an ACTIVE skill may be cloned).
      const source = await tx.catalogDefinition.findUnique({
        where: { id: sourceId },
      })
      if (!source || source.kind !== "skills") {
        throw notFound("catalog_not_found", "Skill source not found")
      }
      if (source.archived) {
        throw badRequest(
          "skill_archived",
          "Source skill is archived; clone an active skill"
        )
      }

      const sourceConfig = parseConfigOr400("skills", source.config ?? {})
      const name = input.name ?? source.name
      resolvedName = name
      const rarity = input.rarity
      const stableId = deriveCatalogStableId(`${name}-${rarity.toLowerCase()}`)

      // Duplicate variant guard: the derived slug (name + rarity) is globally
      // unique, so a same-name / same-rarity variant anywhere in the tree - or any
      // other skill already owning the slug - is a 409, never silently suffixed.
      const existing = await tx.catalogDefinition.findUnique({
        where: { kind_stableId: { kind: "skills", stableId } },
      })
      if (existing) {
        throw conflict(
          "catalog_stable_id_conflict",
          `A skill variant with stableId "${stableId}" already exists`
        )
      }

      // Compute the source's new outgoing targets BEFORE creating the clone so the
      // legacy fallback set is read against the pre-clone catalog (the clone itself
      // is appended last and never sorted into the legacy list).
      const sourceTargets = skillUpgradeTargets(sourceConfig)
      let outgoingTargets: string[]
      if (sourceTargets !== undefined) {
        // Declared explicit list (including `[]`): append the clone, preserving the
        // declared order. The clone is new, so it is never already present, but a
        // defensive dedup is cheap and harmless.
        outgoingTargets = Array.from(new Set([...sourceTargets, stableId]))
      } else {
        // Legacy source. Enumerate the legacy `upgradeGroup` + `rarity` fallback
        // successor set ONLY when the source declares BOTH a nonempty group AND a
        // comparable ordered rarity. A source with NO group must never gather every
        // unrelated ungrouped skill in the catalog (its null group would match
        // every null-group skill), and a source with an incomparable/missing rarity
        // has nothing strictly higher - in both cases the only successor is the
        // freshly cloned child.
        const group = upgradeGroupForConfig(sourceConfig)
        const sourceRarityIndex = rarityOrderIndex(sourceConfig.rarity)
        if (group != null && sourceRarityIndex != null) {
          const activeRows = await tx.catalogDefinition.findMany({
            where: { kind: "skills", archived: false },
          })
          const higher: Array<{ stableId: string; rarityIndex: number }> = []
          for (const row of activeRows) {
            if (row.stableId === stableId) continue
            const cfg = parseCatalogConfig("skills", row.config ?? {})
            if (upgradeGroupForConfig(cfg) !== group) continue
            const index = rarityOrderIndex(cfg.rarity)
            if (index == null) continue
            if (index <= sourceRarityIndex) continue
            higher.push({ stableId: row.stableId, rarityIndex: index })
          }
          higher.sort((a, b) => {
            if (a.rarityIndex !== b.rarityIndex)
              return a.rarityIndex - b.rarityIndex
            return a.stableId < b.stableId
              ? -1
              : a.stableId > b.stableId
                ? 1
                : 0
          })
          const seen = new Set<string>()
          const targets: string[] = []
          for (const h of higher) {
            if (seen.has(h.stableId)) continue
            seen.add(h.stableId)
            targets.push(h.stableId)
          }
          targets.push(stableId)
          outgoingTargets = targets
        } else {
          outgoingTargets = [stableId]
        }
      }

      // A legacy source group with a huge strictly-higher set would write a source
      // `upgradeToStableIds` beyond `SKILL_UPGRADE_TARGET_LIMIT`, which the update
      // guard would reject AFTER the clone row was already inserted. Fail EARLY,
      // before any write, with an actionable 409 so the admin knows to restructure
      // the group rather than seeing a cryptic 400.
      if (outgoingTargets.length > SKILL_UPGRADE_TARGET_LIMIT) {
        throw conflict(
          "skill_upgrade_group_too_large",
          `Skill "${source.stableId}" would resolve to ${outgoingTargets.length} successor skills, exceeding the maximum of ${SKILL_UPGRADE_TARGET_LIMIT}. Restructure this upgrade group (e.g. split it into smaller groups) before cloning`
        )
      }

      // Deep copy the source's RAW persisted `config` so effects/conditions/track/
      // classStableId/upgradeGroup and every unknown nested passthrough key (even
      // inside an `effect.condition`) are cloned verbatim. `sourceConfig` (the
      // Zod-validated shape) is used ONLY above for the known-field extraction
      // (rarity/rank/group/edges) - never as the write payload, because Zod strips
      // unknown nested fields inside `effects` / `condition`. The clone never
      // copies the source's outgoing edges (terminal `[]`) and carries the requested
      // rarity.
      const childConfig = JSON.parse(
        JSON.stringify(source.config ?? {})
      ) as Record<string, unknown>
      childConfig.rarity = rarity
      childConfig.upgradeToStableIds = []

      const item = await createCatalogItemInTransaction(
        tx,
        "skills",
        {
          stableId,
          name,
          description: source.description,
          sourceUrl: source.sourceUrl,
          grade: null,
          config: childConfig,
          gradeDescriptions: {},
        },
        { preserveRawSkillConfig: true }
      )

      // Link the source as the clone's direct predecessor. Rarity/upgradeGroup are
      // untouched, so the linked-skill immutability guards still pass; the global
      // skill upgrade graph is revalidated against the same transaction snapshot
      // (which now includes the clone). The source write payload is likewise a deep
      // clone of the RAW persisted config (not `sourceConfig`) so the source's own
      // unknown nested metadata survives the link exactly.
      const sourceWriteConfig = JSON.parse(
        JSON.stringify(source.config ?? {})
      ) as Record<string, unknown>
      sourceWriteConfig.upgradeToStableIds = outgoingTargets
      const updatedSource = await updateCatalogItemInTransaction(
        tx,
        "skills",
        sourceId,
        {
          config: sourceWriteConfig,
        },
        { preserveRawSkillConfig: true }
      )

      return { source: updatedSource, item }
    }, serializable)
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict(
        "catalog_stable_id_conflict",
        `A skill variant with stableId "${deriveCatalogStableId(
          `${resolvedName}-${input.rarity.toLowerCase()}`
        )}" already exists`
      )
    }
    if (isSerializationFailure(err)) {
      throw conflict(
        "catalog_serialization_conflict",
        "Concurrent catalog write conflict; retry the change"
      )
    }
    throw err
  }
}
