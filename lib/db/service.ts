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
  applyPermanentConsumable,
  ATTRIBUTES,
  bandForGrade,
  calculateStatus,
  consumableToEffect,
  defaultRulesConfig,
  deriveRaceLevel,
  evolveGrade,
  evolveTrackGrade,
  gradeOrderIndex,
  makeVector,
  nextGrade,
  permanentConsumableCap,
  totalFreePoints,
  zeroVector,
  type AttributeVector,
  type AdvanceResult,
  type CharacterState,
  type EffectCondition,
  type Grade,
  type GradeBand,
  type PartialVector,
  type RaceDefinition,
  type RaceType,
  type RulesConfig,
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
  characterStateSchema,
  gradeSchema,
  hasInvalidNaturalGradeConfig,
  hasInvalidRaceTypeConfig,
  hasInvalidSkillTrack,
  isIncompleteRaceConfig,
  isIncompleteSkillConfig,
  isIncompleteSkillRarity,
  isLegacyBlessingConfig,
  isLegacyBloodlineConfig,
  isLegacyConsumableConfig,
  isIncompleteEquipmentConfig,
  isLegacyTranscendentSkillConfig,
  isValidEvolutionConfig,
  isValidRaceEvolutionConfig,
  isValidTrackEvolutionConfig,
  normalizeEquipmentSlot,
  parseCatalogConfig,
  rarityOrderIndex,
  titleImprovementSchema,
  legacyRingPositionForConfig,
  type TitleImprovement,
} from "@/lib/server/schemas"
import {
  IMPORT_RULESET_VERSION,
  IMPORT_SCHEMA_V4,
  IMPORT_SCHEMA_V5,
  MAX_IMPORT_INVENTORY,
  type CharacterImportDocument,
} from "@/lib/server/import-schema"
import { badRequest, conflict, forbidden, notFound } from "@/lib/server/errors"
import type { SessionUser } from "@/lib/auth/session"

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
} as const

type CharacterWithCatalog = Prisma.CharacterGetPayload<{
  include: typeof characterInclude
}>

type DbClient = Prisma.TransactionClient | typeof prisma

export interface CharacterAssociationView {
  id: string
  definitionId: string
  kind:
    "title" | "equipment" | "skill" | "blessing" | "bloodline" | "transcendent"
  name: string
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
  /** Rarity tier, present on equipment and skill links that declare one. */
  rarity?: string
  /** Whether an equipment link is soulbound (metadata only; no transfer mechanic). */
  soulbound?: boolean
  /** Level / race-type requirements an equipment link declares, when any. */
  requirements?: {
    minRaceLevel?: number
    requiredRaceType?: "enlightened" | "monster"
  }
  /**
   * Live eligibility of an equipment link against the character's current race
   * level / race type. An ineligible item stays linked (and shown) but its
   * equipment bonus is not synthesized until the character qualifies.
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
 * kind of the linked definition - always `"equipment"` or `"consumables"`, since
 * no other kind can be added to inventory.
 */
export interface CharacterInventoryItemView {
  id: string
  definitionId: string
  name: string
  kind: "equipment" | "consumables"
  quantity: number
  /** Whether the linked catalog definition is currently archived. */
  archived: boolean
  /** Equipment slot, when the linked definition declares one. */
  slot?: string
  /** Equipment rarity tier, present only on equipment definitions. */
  rarity?: string
  /** Whether an equipment definition is soulbound (metadata only). */
  soulbound?: boolean
  /** Level / race-type requirements an equipment definition declares, when any. */
  requirements?: {
    minRaceLevel?: number
    requiredRaceType?: "enlightened" | "monster"
  }
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
  /** Catalog tier grade of the offered definition, when set. */
  grade?: string
}

export interface SkillOfferView {
  id: string
  track: string
  level: number
  choiceGroup: string
  options: SkillOfferOptionView[]
  selectedDefinitionId: string | null
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
   * Owned inventory quantities (equipment + consumables), including archived
   * catalog stock. Absent = zero owned stock of that definition.
   */
  inventory: CharacterInventoryItemView[]
  /** Pending + selected skill offers (milestone choices) for this character. */
  skillOffers: SkillOfferView[]
  status?: StatusResult
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
  classRow?: CatalogRow | null
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
    baseAttributes: zeroVector(),
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
 * the definition id, and for a bloodline's grade-scaled effects it is
 * `def.id:grade-<grade>` so a base effect and a grade effect never share an id.
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
 * Whether a character currently meets an equipment config's level / race-type
 * eligibility requirements. `enlightened` maps to humanoid races and `monster`
 * to monstrous races. `minRaceLevel` is checked against the character's RACE
 * level (never the total/class level); a missing `requiredRaceType` imposes no
 * type restriction. Returns a human-readable reason when ineligible. This gates
 * only the live equipment bonus: a linked-but-ineligible item stays linked and
 * is still shown, just synthesized without its bonus.
 */
function equipmentEligibilityFor(
  config: Record<string, unknown>,
  state: CharacterState,
  character: { race?: { config?: unknown } | null }
): { eligible: boolean; reason?: string } {
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
  return { eligible: true }
}

/**
 * Build a read-time "live" CharacterState by merging the immutable stored state
 * with equipment and effects synthesized from the character's currently linked,
 * unarchived catalog definitions. The stored `state` is never mutated, so
 * history stays immutable; catalog edits recalculate live effects without
 * rewriting historical awards. Existing stored effects/equipment are respected
 * (they are never overwritten, only appended).
 */
function liveState(character: CharacterWithCatalog): CharacterState {
  const state = deserializeState(character.state)
  const equipment = [...state.equipment]
  const activeEffects = [...state.activeEffects]
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
      })
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
    } else if (def.kind === "blessings") {
      // A blessing's modern `effects` are declared in the catalog config and are
      // synthesized live. The legacy `{ grade, effect }` config carries no
      // `effects`, so it contributes nothing (no invented numeric bonus). Archived
      // definitions are skipped earlier, so an archived link is inert.
      appendDeclarativeEffects(
        activeEffects,
        def,
        (config.effects ?? []) as DeclarativeEffect[],
        def.id
      )
    } else if (def.kind === "bloodlines") {
      // Bloodlines apply their declared `effects` live AND, EXACTLY when the
      // character's current race grade matches a key in `gradeEffects`, apply that
      // grade's effects on top (no fallback to another grade - a mismatched grade
      // contributes nothing rather than inferring a bonus). The grade effects use
      // a distinct id prefix so a base effect and a grade-scaled effect never
      // share an id. Legacy `{ grade, vector }` config contributes nothing.
      appendDeclarativeEffects(
        activeEffects,
        def,
        (config.effects ?? []) as DeclarativeEffect[],
        def.id
      )
      const gradeEffects = (config.gradeEffects ?? {}) as Record<
        string,
        DeclarativeEffect[]
      >
      const gradeEff = gradeEffects[state.race.grade]
      if (gradeEff && gradeEff.length > 0) {
        appendDeclarativeEffects(
          activeEffects,
          def,
          gradeEff,
          `${def.id}:grade-${state.race.grade}`
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

function statusFor(
  character: CharacterWithCatalog,
  config: RulesConfig
): StatusResult {
  return calculateStatus(liveState(character), config)
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
 * The subset of a character row needed to compute equipment eligibility metadata.
 */
type EquipmentViewContext = {
  state: unknown
  race?: { config?: unknown } | null
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
  requirements?: {
    minRaceLevel?: number
    requiredRaceType?: "enlightened" | "monster"
  }
  equipmentEligibility: { eligible: boolean; reason?: string }
} {
  const state = deserializeState(context.state)
  const metadata: {
    rarity?: string
    soulbound?: boolean
    requirements?: {
      minRaceLevel?: number
      requiredRaceType?: "enlightened" | "monster"
    }
    equipmentEligibility: { eligible: boolean; reason?: string }
  } = { equipmentEligibility: equipmentEligibilityFor(config, state, context) }
  if (config.rarity != null) metadata.rarity = config.rarity as string
  if (config.soulbound != null) metadata.soulbound = config.soulbound as boolean
  const requirements: {
    minRaceLevel?: number
    requiredRaceType?: "enlightened" | "monster"
  } = {}
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
  if (kind === "skill" || kind === "transcendent") {
    if (link.definition.grade) view.grade = link.definition.grade
  }
  if (kind === "skill") {
    const rarity = config.rarity as string | undefined
    if (rarity) view.rarity = rarity
  }
  // Authored grade prose at the definition's OWN grade band, for any graded
  // linked definition (skills/equipment/titles/etc). Never the character race
  // grade; a null definition grade or an empty map leaves the field absent.
  const associationGrade = associationGradeDescription(link.definition)
  if (associationGrade != null) view.gradeDescription = associationGrade
  return view
}

/** Build the read-time skill-offer view with the current archived status of each option. */
function skillOfferView(
  offer: CharacterWithCatalog["skillOffers"][number]
): SkillOfferView {
  return {
    id: offer.id,
    track: offer.track,
    level: offer.level,
    choiceGroup: offer.choiceGroup,
    options: offer.options.map((o) => ({
      definitionId: o.definitionId,
      nameSnapshot: o.nameSnapshot,
      archived: o.definition?.archived ?? false,
      ...(o.definition?.grade ? { grade: o.definition.grade } : {}),
    })),
    selectedDefinitionId: offer.selectedDefinitionId,
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
 * the linked definition's catalog kind (equipment or consumables); the slot is
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
    kind: def.kind === "consumables" ? "consumables" : "equipment",
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

function toDetail(
  character: CharacterWithCatalog,
  withStatus: boolean,
  config: RulesConfig,
  rulesetVersion?: number
): CharacterDetail {
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
    status: withStatus ? statusFor(character, config) : undefined,
    permanentConsumableCap: consumableInfo.cap,
    permanentConsumableRemaining: consumableInfo.remaining,
    ...(rulesetVersion != null ? { rulesetVersion } : {}),
  }
}

function toListItem(
  character: CharacterWithCatalog,
  withStatus: boolean,
  config: RulesConfig,
  rulesetVersion?: number
): CharacterListItem {
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
    status: withStatus ? statusFor(character, config) : undefined,
    ...(rulesetVersion != null ? { rulesetVersion } : {}),
  }
}

/**
 * Build a full character detail from a loaded row AND a single in-request
 * house-rules row, deriving the rules config ONCE and passing it through the
 * status / consumable-cap helpers (no hidden DB lookups inside).
 */
function detailFor(
  character: CharacterWithCatalog,
  houseRules: HouseRulesRow
): CharacterDetail {
  const config = buildRulesConfig(character.race, houseRules.config)
  return toDetail(character, true, config, houseRules.version)
}

/**
 * Build a character list item from a loaded row AND a single in-request
 * house-rules row, deriving the config once and passing it through the helpers.
 */
function listItemFor(
  character: CharacterWithCatalog,
  houseRules: HouseRulesRow,
  withStatus: boolean
): CharacterListItem {
  const config = buildRulesConfig(character.race, houseRules.config)
  return toListItem(character, withStatus, config, houseRules.version)
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
  blessingId?: string | null
  bloodlineIds?: string[]
  transcendentSkillIds?: string[]
}

type ResolvedSpecialAbilities = {
  associations: Array<{
    definitionId: string
    kind: "BLESSING" | "BLOODLINE" | "TRANSCENDENT"
  }>
  journal: Record<string, unknown> | null
}

/**
 * Resolve the explicit special-ability selections against the catalog and
 * validate their invariants, all inside the create transaction so any failure
 * 400s/409s with NO character, event, links or draft deletion.
 *
 * - Every id must resolve to an existing catalog definition of the CORRESPONDING
 *   kind (`blessings` / `bloodlines` / `transcendent_skills`), and that
 *   definition must be unarchived (an archived entry is inert and cannot be
 *   newly linked).
 * - A blessing is limited to one by the single `blessingId` field.
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

  // Blessing - single field, so at most one may be selected.
  const blessing =
    selection.blessingId != null
      ? await resolve(selection.blessingId, "blessings", "Blessing")
      : null
  journal.blessing = blessing ? specialAbilitySnapshot(blessing) : null
  if (blessing) {
    associations.push({ definitionId: blessing.id, kind: "BLESSING" })
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
  return rows.map((row) =>
    listItemFor(row, houseRules, opts?.withStatus ?? false)
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
  return toDetail(row, opts?.withStatus ?? true, config, houseRules.version)
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
    // Explicit special-ability selections. When supplied, the referenced
    // blessing/bloodline/transcendent-skill catalog definitions are resolved by
    // kind, validated (unarchived, no collision) and linked atomically with the
    // create. Omitted/empty grants no ability.
    specialAbilities?: {
      blessingId?: string | null
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

      const state = createInitialState(input.origin, race, profession, cls)
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
            ...(suppliedMetadataFields.length
              ? { metadataFields: suppliedMetadataFields }
              : {}),
          } as Prisma.InputJsonValue,
        },
      })

      // Insert the resolved associations atomically with the create + event. Each
      // link is persisted with the exact catalog kind, so a stored BLESSING /
      // BLOODLINE / TRANSCENDENT link is never mislabelled by a later read.
      for (const assoc of special.associations) {
        await tx.characterAssociation.create({
          data: {
            characterId: created.id,
            definitionId: assoc.definitionId,
            kind: assoc.kind,
          },
        })
      }

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
      return detailFor(withAssociations, houseRules)
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
    return detailFor(updated, houseRules)
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
    return detailFor(updated, houseRules)
  })
}

/**
 * Create ONE skill offer per choice group for a character that just leveled a
 * track. It queries the unarchived `skills` catalog and keeps only the entries
 * whose config `track` / `milestone` exactly match the advanced track/level, whose
 * explicit `grade` (when set) equals the OFFER grade (no inferred compatibility).
 * For a graded class/profession track the offer grade is the TRACK's own grade;
 * the caller falls back to the character's race grade only for an ungraded
 * legacy track. `eligibleDefinitionStableIds` (when present)
 * includes the character's selected track catalog stableId. The surviving
 * entries are grouped by `choiceGroup ?? "standard"`; a single offer with
 * read-only option snapshots is created per group. A pre-existing offer for the
 * same (character, track, level, choiceGroup) is left untouched (unique guard).
 * Returns the created offers (id + choiceGroup) so the caller can surface them.
 */
async function createSkillOffersForAdvance(
  tx: DbClient,
  characterId: string,
  track: "class" | "profession",
  newLevel: number,
  offerGrade: string,
  trackStableId: string | undefined
): Promise<Array<{ id: string; choiceGroup: string }>> {
  const skillDefs = await tx.catalogDefinition.findMany({
    where: { kind: "skills", archived: false },
  })
  const eligible: Array<{
    def: {
      id: string
      name: string
      grade: string | null
      config: unknown
    }
    choiceGroup: string
  }> = []

  for (const def of skillDefs) {
    const config = parseCatalogConfig("skills", def.config ?? {})
    if (config.track !== track) continue
    const milestone = Number(config.milestone)
    if (!Number.isFinite(milestone) || milestone !== newLevel) continue
    // Grade, when specified, must match the offer grade exactly. For a graded
    // class/profession track this is the TRACK's own grade (independent of the
    // race grade); for an ungraded legacy track it falls back to the race grade.
    if (def.grade && def.grade !== offerGrade) continue
    // Filter to the selected track's catalog stableId when the skill constrains
    // its eligible class/profession definitions. When `eligibleDefinitionStableIds`
    // is present - even as an empty array - the restriction applies via `includes`:
    // an empty list offers nothing (no selected stableId can be included), while an
    // absent list imposes no restriction.
    const stableIds = config.eligibleDefinitionStableIds
    if (
      Array.isArray(stableIds) &&
      (!trackStableId || !stableIds.includes(trackStableId))
    ) {
      continue
    }
    const group =
      typeof config.choiceGroup === "string" && config.choiceGroup.length > 0
        ? config.choiceGroup
        : "standard"
    eligible.push({
      def: { id: def.id, name: def.name, grade: def.grade, config: def.config },
      choiceGroup: group,
    })
  }

  const byGroup = new Map<string, typeof eligible>()
  for (const e of eligible) {
    const arr = byGroup.get(e.choiceGroup)
    if (arr) arr.push(e)
    else byGroup.set(e.choiceGroup, [e])
  }

  const created: Array<{ id: string; choiceGroup: string }> = []
  for (const [choiceGroup, entries] of byGroup) {
    // Enforce the unique identity (characterId, track, level, choiceGroup) by
    // checking for a pre-existing offer BEFORE creating, inside this live
    // transaction. A pre-existing offer (e.g. a prior advance) is left untouched
    // and never duplicated, so a re-advance produces no duplicate. If a concurrent
    // request inserts the same identity between this check and the create, the
    // resulting unique violation is NOT swallowed here - it propagates and aborts
    // the entire transaction (no silent skip, no half-applied advance).
    const existing = await tx.skillOffer.findUnique({
      where: {
        characterId_track_level_choiceGroup: {
          characterId,
          track,
          level: newLevel,
          choiceGroup,
        },
      },
    })
    if (existing) continue
    const offer = await tx.skillOffer.create({
      data: {
        characterId,
        track,
        level: newLevel,
        choiceGroup,
        options: {
          create: entries.map((e) => ({
            definitionId: e.def.id,
            nameSnapshot: e.def.name,
            configSnapshot: (e.def.config ?? {}) as Prisma.InputJsonValue,
          })),
        },
      },
    })
    created.push({ id: offer.id, choiceGroup })
  }
  return created
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

    // Skills are offered, never auto-awarded: on a CLASS/PROFESSION LEVEL-UP only,
    // generate one offer per choice group from the current unarchived skills
    // catalog. A quarter-only advance (no level up) and a race-only advance (which
    // has no skill offers) produce none. The offers are created inside the same
    // transaction as the CAS state write and the immutable advance event, so a
    // conflict rolls all of them back together.
    let skillOffers: Array<{ id: string; choiceGroup: string }> = []
    if (!isRaceTrack && body.track !== "race" && result.journal.leveledUp) {
      const newLevel = result.journal.levelAfter
      const raceGrade = result.state.race.grade
      // A graded class/profession track filters milestone offers by the track's OWN
      // grade (independent of the race grade); an ungraded legacy track uses the
      // race grade.
      const trackGrade = result.state.tracks[body.track]?.grade ?? raceGrade
      const trackStableId =
        body.track === "class" ? row.class?.stableId : row.profession?.stableId
      skillOffers = await createSkillOffersForAdvance(
        tx,
        id,
        body.track,
        newLevel,
        trackGrade,
        trackStableId ?? undefined
      )
    }

    const advanceJournal: Record<string, unknown> = { ...result.journal }
    if (skillOffers.length > 0) {
      advanceJournal.skillOffers = skillOffers
      advanceJournal.skillOfferIds = skillOffers.map((o) => o.id)
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
      character: toDetail(updated, true, config, houseRules.version),
      journal: advanceJournal,
    }
  })
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
export async function skillCharacter(
  id: string,
  input: SkillActionInput,
  user: SessionUser
): Promise<{ character: CharacterDetail }> {
  return prisma.$transaction(async (tx) => {
    const row = await assertOwner(tx, id, user)
    const houseRules = await loadHouseRules(tx)

    if (input.operation === "select") {
      const offer = await tx.skillOffer.findUnique({
        where: { id: input.offerId },
        include: { options: { include: { definition: true } } },
      })
      if (!offer || offer.characterId !== id) {
        throw notFound("offer_not_found", "Skill offer not found")
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
      return { character: detailFor(updated, houseRules) }
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
    return { character: detailFor(updated, houseRules) }
  })
}

type SkillUpgradeInput = {
  definitionId: string
  version: number
  reason: string
}

/**
 * Upgrade a character's linked skill to a strictly higher-ordered rarity variant
 * of the same `upgradeGroup`.
 *
 * The owner or an admin supplies the id of an ACTIVE (unarchived) `skills` entry
 * that carries BOTH a valid `rarity` and a nonempty `upgradeGroup`, plus a
 * mandatory reason. The character must currently hold EXACTLY ONE other linked
 * skill in that same upgrade group with a strictly LOWER ordered rarity; that
 * existing link is replaced (never stacked). Rejections are all 400
 * `skill_rarity_not_higher`:
 *   - the target name is not an active skills entry, lacks a rarity / group, or
 *     is itself already linked,
 *   - the target rarity is missing or incomparable (`Unique`),
 *   - the character holds zero same-group links (nothing to upgrade) or more
 *     than one (ambiguous), or
 *   - the (single) same-group link's rarity is missing/incomparable or not
 *     strictly lower.
 *
 * The replacement runs under SERIALIZABLE isolation with the same CAS version
 * increment as select/grant; there is no XP cost. The removed source link may be
 * an ARCHIVED catalog entry - its config is still read to determine its rarity /
 * group so an archived source can be upgraded away from. The immutable
 * `skill_upgrade` event snapshots the from/to stable ids, names, rarities,
 * descriptions, the reason, and the removed-link record.
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
        if (targetGroup == null) {
          throw badRequest(
            "skill_rarity_not_higher",
            `Skill "${def.name}" has no "upgradeGroup", so it cannot upgrade a linked skill`
          )
        }
        const targetRarity = skillRarityOf({
          kind: "skills",
          config: def.config ?? {},
        })
        if (targetRarity == null) {
          throw badRequest(
            "skill_rarity_not_higher",
            `Skill "${def.name}" has no ordered "rarity" (missing or incomparable "Unique"), so it cannot upgrade a linked skill`
          )
        }
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
        const source = sources[0]
        const sourceDef = source.definition
        const sourceRarity = skillRarityOf(sourceDef)
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

        const removed = await removeSameUpgradeGroupSkills(
          tx,
          id,
          row.associations,
          def.id,
          targetGroup
        )
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
                definitionId: sourceDef.id,
                stableId: sourceDef.stableId,
                name: sourceDef.name,
                rarity: sourceRarity ?? null,
                description: sourceDef.description,
              },
              to: {
                definitionId: def.id,
                stableId: def.stableId,
                name: def.name,
                rarity: targetRarity,
                description: def.description,
              },
              upgradeGroup: targetGroup,
              removed,
              upgradedAt: new Date().toISOString(),
            } as unknown as Prisma.InputJsonValue,
          },
        })

        const updated = (await tx.character.findUnique({
          where: { id },
          include: characterInclude,
        }))!
        return { character: detailFor(updated, houseRules) }
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
      character: toDetail(updated, true, config, houseRules.version),
      status: statusFor(updated, config),
    }
  })
}

export type EvolveCharacterInput =
  | {
      // A race path choice. `track` is `"race"` only when an explicit new client
      // sends it; old clients omit the key entirely. Either way this is NOT a
      // class/profession track, so it must never be routed to evolveTrackCharacter.
      track?: "race"
      optionId: string
      version: number
      reason?: string
    }
  | { grade: Grade; version: number; track?: undefined }
  | {
      track: "class" | "profession"
      optionId: string
      version: number
      reason?: string
    }

export interface EvolutionOptionView {
  id: string
  name: string
  description: string | null
  fromGrade: Grade
  toGrade: Grade
  /** Destination display name (race, class, or profession name). */
  toTrackName: string
  /** The track this evolution path targets. */
  track: "race" | "class" | "profession"
  sourceUrl: string | null
  eligible: boolean
  blockers: string[]
  manualReview: boolean
}

export interface EvolutionOptionsResult {
  options: EvolutionOptionView[]
  legacyAvailable: boolean
}

/**
 * A parsed, validated race evolution path from an `evolutions` catalog row's
 * config. Only set when `isValidRaceEvolutionConfig` passes; a legacy
 * metadata-only config yields null (readable but not a usable path).
 */
interface RaceEvolutionPath {
  id: string
  name: string
  description: string | null
  sourceUrl: string | null
  fromRaceStableId: string
  toRaceStableId: string
  fromGrade: Grade
  toGrade: Grade
  minRaceLevel: number | undefined
  requiredTitleStableIds: string[]
  requiredSkillStableIds: string[]
  manualRequirementsText: string | undefined
}

function parseRaceEvolutionPath(row: {
  id: string
  name: string
  description: string | null
  sourceUrl: string | null
  config: unknown
}): RaceEvolutionPath | null {
  const config = parseCatalogConfig("evolutions", row.config ?? {})
  if (!isValidRaceEvolutionConfig(config)) return null
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sourceUrl: row.sourceUrl,
    fromRaceStableId: config.fromRaceStableId as string,
    toRaceStableId: config.toRaceStableId as string,
    fromGrade: config.fromGrade as Grade,
    toGrade: config.toGrade as Grade,
    minRaceLevel:
      typeof config.minRaceLevel === "number"
        ? (config.minRaceLevel as number)
        : undefined,
    requiredTitleStableIds: Array.isArray(config.requiredTitleStableIds)
      ? (config.requiredTitleStableIds as string[])
      : [],
    requiredSkillStableIds: Array.isArray(config.requiredSkillStableIds)
      ? (config.requiredSkillStableIds as string[])
      : [],
    manualRequirementsText:
      typeof config.manualRequirementsText === "string"
        ? (config.manualRequirementsText as string)
        : undefined,
  }
}

/**
 * A parsed, validated class/profession evolution path from an `evolutions` catalog
 * row's config. Only set when `isValidTrackEvolutionConfig` passes; a legacy
 * metadata-only config yields null (readable but not a usable path).
 */
interface TrackEvolutionPath {
  id: string
  name: string
  description: string | null
  sourceUrl: string | null
  track: "class" | "profession"
  fromDefinitionStableId: string
  toDefinitionStableId: string
  fromGrade: Grade
  toGrade: Grade
  minTrackLevel: number | undefined
  requiredTitleStableIds: string[]
  requiredSkillStableIds: string[]
  manualRequirementsText: string | undefined
}

function parseTrackEvolutionPath(row: {
  id: string
  name: string
  description: string | null
  sourceUrl: string | null
  config: unknown
}): TrackEvolutionPath | null {
  const config = parseCatalogConfig("evolutions", row.config ?? {})
  if (!isValidTrackEvolutionConfig(config)) return null
  const track = config.track === "profession" ? "profession" : "class"
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sourceUrl: row.sourceUrl,
    track,
    fromDefinitionStableId: config.fromDefinitionStableId as string,
    toDefinitionStableId: config.toDefinitionStableId as string,
    fromGrade: config.fromGrade as Grade,
    toGrade: config.toGrade as Grade,
    minTrackLevel:
      typeof config.minTrackLevel === "number"
        ? (config.minTrackLevel as number)
        : undefined,
    requiredTitleStableIds: Array.isArray(config.requiredTitleStableIds)
      ? (config.requiredTitleStableIds as string[])
      : [],
    requiredSkillStableIds: Array.isArray(config.requiredSkillStableIds)
      ? (config.requiredSkillStableIds as string[])
      : [],
    manualRequirementsText:
      typeof config.manualRequirementsText === "string"
        ? (config.manualRequirementsText as string)
        : undefined,
  }
}

interface EvolutionEligibilityContext {
  currentRaceStableId: string | null
  currentGrade: Grade
  raceLevel: number
  linkedTitleStableIds: Set<string>
  linkedSkillStableIds: Set<string>
}

/**
 * Evaluate the mechanical (hard) requirements of a race path. Only race/grade
 * match, the minimum race level and the explicitly required title/skill
 * associations (linked, unarchived definitions) count here; the narrative
 * `manualRequirementsText` gate is tracked separately via `manualReview`.
 */
function evaluateRacePathEligibility(
  path: RaceEvolutionPath,
  ctx: EvolutionEligibilityContext
): { eligible: boolean; blockers: string[] } {
  const blockers: string[] = []
  if (
    ctx.currentRaceStableId == null ||
    path.fromRaceStableId !== ctx.currentRaceStableId
  ) {
    blockers.push(`Requires race "${path.fromRaceStableId}"`)
  }
  if (path.fromGrade !== ctx.currentGrade) {
    blockers.push(`Requires current grade ${path.fromGrade}`)
  }
  if (path.minRaceLevel != null && ctx.raceLevel < path.minRaceLevel) {
    blockers.push(
      `Requires race level ${path.minRaceLevel} or higher (currently ${ctx.raceLevel})`
    )
  }
  for (const stableId of path.requiredTitleStableIds) {
    if (!ctx.linkedTitleStableIds.has(stableId)) {
      blockers.push(`Requires title "${stableId}"`)
    }
  }
  for (const stableId of path.requiredSkillStableIds) {
    if (!ctx.linkedSkillStableIds.has(stableId)) {
      blockers.push(`Requires skill "${stableId}"`)
    }
  }
  return { eligible: blockers.length === 0, blockers }
}

interface ValidRacePath {
  path: RaceEvolutionPath
  destRace: CatalogLookupRow
}

/**
 * Collect the UNARCHIVED `evolutions` catalog entries whose config is a valid
 * full race path matching the character's current race stableId and grade AND
 * targeting `targetGrade`, where the destination race exists, is enabled and
 * defines a `raceDefinitions[targetGrade]`. A malformed, archived, wrong-race,
 * wrong-grade, non-target-grade or missing-destination entry is ignored. The
 * returned paths are the authoritative set used both to build the choice list and
 * to decide whether a legacy grade-only request must be rejected.
 */
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

async function collectValidRacePathsForTarget(
  db: DbClient,
  currentRaceStableId: string | null,
  currentGrade: Grade,
  targetGrade: Grade,
  currentRaceType: RaceType | null
): Promise<ValidRacePath[]> {
  const rows = await db.catalogDefinition.findMany({
    where: { kind: "evolutions", archived: false },
  })
  const out: ValidRacePath[] = []
  for (const row of rows) {
    const path = parseRaceEvolutionPath(row)
    if (!path) continue
    if (path.fromRaceStableId !== currentRaceStableId) continue
    if (path.fromGrade !== currentGrade) continue
    if (path.toGrade !== targetGrade) continue
    const destRace = await findCatalogByStableId(
      db,
      "races",
      path.toRaceStableId
    )
    if (!destRace || destRace.archived) continue
    // An evolution must never cross raceType without an explicit conversion: only
    // collect a path whose destination advances in the same mode as the current
    // race. A cross-type path is not offered (and never accepted), so the
    // grade-only house fallback remains available for a character that cannot
    // convert.
    if (
      currentRaceType != null &&
      raceTypeForRow(destRace) !== currentRaceType
    ) {
      continue
    }
    const destConfig = parseCatalogConfig("races", destRace.config ?? {})
    const defs = (destConfig.raceDefinitions ?? {}) as Record<string, unknown>
    if (!(path.toGrade in defs)) continue
    out.push({ path, destRace })
  }
  return out
}

interface TrackEvolutionEligibilityContext {
  currentDefinitionStableId: string | null
  currentGrade: Grade
  trackLevel: number
  linkedTitleStableIds: Set<string>
  linkedSkillStableIds: Set<string>
}

/**
 * Evaluate the mechanical (hard) requirements of a class/profession path. Only the
 * definition-stableId match, the track grade match, the minimum track level, and
 * the explicitly required title/skill associations (linked, unarchived
 * definitions) count here; the narrative `manualRequirementsText` gate is tracked
 * separately via `manualReview`.
 */
function evaluateTrackPathEligibility(
  path: TrackEvolutionPath,
  ctx: TrackEvolutionEligibilityContext
): { eligible: boolean; blockers: string[] } {
  const blockers: string[] = []
  if (
    ctx.currentDefinitionStableId == null ||
    path.fromDefinitionStableId !== ctx.currentDefinitionStableId
  ) {
    blockers.push(`Requires ${path.track} "${path.fromDefinitionStableId}"`)
  }
  if (path.fromGrade !== ctx.currentGrade) {
    blockers.push(`Requires current grade ${path.fromGrade}`)
  }
  if (path.minTrackLevel != null && ctx.trackLevel < path.minTrackLevel) {
    blockers.push(
      `Requires ${path.track} level ${path.minTrackLevel} or higher (currently ${ctx.trackLevel})`
    )
  }
  for (const stableId of path.requiredTitleStableIds) {
    if (!ctx.linkedTitleStableIds.has(stableId)) {
      blockers.push(`Requires title "${stableId}"`)
    }
  }
  for (const stableId of path.requiredSkillStableIds) {
    if (!ctx.linkedSkillStableIds.has(stableId)) {
      blockers.push(`Requires skill "${stableId}"`)
    }
  }
  return { eligible: blockers.length === 0, blockers }
}

/**
 * Engine-level grade-band / grade-gate blockers for a class/profession evolution,
 * mirroring exactly what the pure `evolveTrackGrade` rejects (a missing band, a
 * track level below the target band's entry level or above its max, and a closed
 * grade gate). GET must agree with POST, so the choice list surfaces these reasons
 * up front rather than reporting a falsely-eligible option that the POST would
 * then reject. The destination definition/grade gating is handled separately by
 * `collectValidTrackPathsForTarget` and `evaluateTrackPathEligibility`.
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
 * separately by `collectValidRacePathsForTarget` and `evaluateRacePathEligibility`.
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

interface ValidTrackPath {
  path: TrackEvolutionPath
  destDefinition: CatalogLookupRow
}

/**
 * Collect the UNARCHIVED `evolutions` catalog entries whose config is a valid full
 * class/profession path for the given `track`, matching the character's current
 * class/profession definition stableId and grade AND targeting `targetGrade`,
 * where the destination definition exists, is enabled and defines a
 * `grades[targetGrade]` gain. A malformed, archived, wrong-track, wrong-definition,
 * wrong-grade, non-target-grade or missing-destination entry is ignored.
 */
async function collectValidTrackPathsForTarget(
  db: DbClient,
  track: "class" | "profession",
  currentDefinitionStableId: string | null,
  currentGrade: Grade,
  targetGrade: Grade
): Promise<ValidTrackPath[]> {
  const rows = await db.catalogDefinition.findMany({
    where: { kind: "evolutions", archived: false },
  })
  const destKind = track === "class" ? "classes" : "professions"
  const out: ValidTrackPath[] = []
  for (const row of rows) {
    const path = parseTrackEvolutionPath(row)
    if (!path) continue
    if (path.track !== track) continue
    if (path.fromDefinitionStableId !== currentDefinitionStableId) continue
    if (path.fromGrade !== currentGrade) continue
    if (path.toGrade !== targetGrade) continue
    const destDefinition = await findCatalogByStableId(
      db,
      destKind,
      path.toDefinitionStableId
    )
    if (!destDefinition || destDefinition.archived) continue
    const destConfig = parseCatalogConfig(
      destDefinition.kind,
      destDefinition.config ?? {}
    )
    const grades = (destConfig.grades ?? {}) as Record<string, unknown>
    if (!(path.toGrade in grades)) continue
    out.push({ path, destDefinition })
  }
  return out
}

function linkedStableIds(
  row: CharacterWithCatalog,
  kind: "TITLE" | "SKILL"
): Set<string> {
  const set = new Set<string>()
  for (const link of row.associations) {
    const def = link.definition
    if (!def || def.archived) continue
    if (link.kind === kind) set.add(def.stableId)
  }
  return set
}

/**
 * GET /api/characters/[id]/evolutions?track=race|class|profession (owner/admin,
 * default race). Returns contextual next-grade-only evolution options for the
 * selected track derived from the editable `evolutions` catalog.
 *
 * - For `race`, the options are derived from the character's current race
 *   stableId/grade/level, and `legacyAvailable` is true only when NO valid
 *   catalog race path matches (the grade-only house fallback is then offered).
 *   Each option is additionally marked ineligible with grade-band / grade-gate
 *   blockers when the race level does not qualify for the target grade, matching
 *   exactly what the pure evolveGrade engine would reject at POST time.
 * - For `class`/`profession`, the options are derived from the current class or
 *   profession definition stableId, the track's own grade and track level, and
 *   the linked unarchived titles/skills. There is NO class/profession legacy
 *   grade-only fallback, so `legacyAvailable` is always false. A track without an
 *   explicit grade (`TrackState.grade` absent - a legacy graded-unknown state)
 *   returns no options and no fallback.
 */
export async function getEvolutionOptions(
  id: string,
  user: SessionUser,
  track: "race" | "class" | "profession" = "race"
): Promise<EvolutionOptionsResult> {
  const row = await assertOwner(prisma, id, user)
  const state = deserializeState(row.state)
  const linkedTitleStableIds = linkedStableIds(row, "TITLE")
  const linkedSkillStableIds = linkedStableIds(row, "SKILL")

  // Build the rules config ONCE, shared by BOTH the track and race branches, so
  // both surfaces the same grade-band / grade-gate blockers that the pure
  // evolveTrackGrade / evolveGrade engine would reject at POST time. The grade
  // table and gates are engine defaults that the house rules never override, but
  // they are still resolved through the same configFor path the POST uses so the
  // two sides cannot drift.
  const houseRules = await loadHouseRules(prisma)
  const config = buildRulesConfig(row.race, houseRules.config)

  if (track !== "race") {
    return getTrackEvolutionOptions(
      row,
      state,
      track,
      {
        linkedTitleStableIds,
        linkedSkillStableIds,
      },
      config
    )
  }

  const currentGrade = state.race.grade
  const currentRaceStableId = row.race?.stableId ?? null
  const currentRaceType: RaceType | null = row.race
    ? raceTypeForRow(row.race)
    : null
  const targetGrade = nextGrade(currentGrade)

  const valid =
    targetGrade == null
      ? []
      : await collectValidRacePathsForTarget(
          prisma,
          currentRaceStableId,
          currentGrade,
          targetGrade,
          currentRaceType
        )

  // The race level resolved exactly as the pure evolveGrade engine does for its
  // band check (derived in derived mode, stored otherwise), so GET and POST cannot
  // disagree about whether the level qualifies for the target band.
  const raceLevel =
    state.race.mode === "derived"
      ? deriveRaceLevel(state, config)
      : state.race.level

  const options: EvolutionOptionView[] = []
  for (const { path, destRace } of valid) {
    const { blockers } = evaluateRacePathEligibility(path, {
      currentRaceStableId,
      currentGrade,
      raceLevel: state.race.level,
      linkedTitleStableIds,
      linkedSkillStableIds,
    })
    // GET must agree with POST: surface the same grade-band / grade-gate blockers
    // that the pure evolveGrade engine would reject at POST time, so a choice never
    // appears eligible when the POST would reject it.
    const gradeBlockers = raceGradeBandBlockers(path.toGrade, raceLevel, config)
    const allBlockers = [...blockers, ...gradeBlockers]
    options.push({
      id: path.id,
      name: path.name,
      description: path.description,
      fromGrade: path.fromGrade,
      toGrade: path.toGrade,
      toTrackName: destRace.name,
      track: "race",
      sourceUrl: path.sourceUrl,
      eligible: allBlockers.length === 0,
      blockers: allBlockers,
      manualReview: path.manualRequirementsText != null,
    })
  }

  return {
    options,
    legacyAvailable: targetGrade != null && valid.length === 0,
  }
}

/**
 * Build class/profession evolution options for the selected track. Because there
 * is no class/profession grade-only legacy fallback, `legacyAvailable` is always
 * false.
 */
async function getTrackEvolutionOptions(
  row: CharacterWithCatalog,
  state: CharacterState,
  track: "class" | "profession",
  links: {
    linkedTitleStableIds: Set<string>
    linkedSkillStableIds: Set<string>
  },
  config: RulesConfig
): Promise<EvolutionOptionsResult> {
  const trackGrade = state.tracks[track]?.grade
  if (!trackGrade) {
    return { options: [], legacyAvailable: false }
  }
  const currentDefinitionStableId =
    track === "class"
      ? (row.class?.stableId ?? null)
      : (row.profession?.stableId ?? null)
  const targetGrade = nextGrade(trackGrade)

  const valid =
    targetGrade == null
      ? []
      : await collectValidTrackPathsForTarget(
          prisma,
          track,
          currentDefinitionStableId,
          trackGrade,
          targetGrade
        )

  const options: EvolutionOptionView[] = []
  for (const { path, destDefinition } of valid) {
    const { blockers } = evaluateTrackPathEligibility(path, {
      currentDefinitionStableId,
      currentGrade: trackGrade,
      trackLevel: state.tracks[track]?.level ?? 0,
      linkedTitleStableIds: links.linkedTitleStableIds,
      linkedSkillStableIds: links.linkedSkillStableIds,
    })
    // GET must agree with POST: surface the same grade-band / grade-gate blockers
    // that the pure evolveTrackGrade engine would reject at POST time, so a choice
    // never appears eligible when the POST would reject it.
    const gradeBlockers = trackGradeBandBlockers(
      track,
      path.toGrade,
      state.tracks[track]?.level ?? 0,
      config
    )
    const allBlockers = [...blockers, ...gradeBlockers]
    options.push({
      id: path.id,
      name: path.name,
      description: path.description,
      fromGrade: path.fromGrade,
      toGrade: path.toGrade,
      toTrackName: destDefinition.name,
      track,
      sourceUrl: path.sourceUrl,
      eligible: allBlockers.length === 0,
      blockers: allBlockers,
      manualReview: path.manualRequirementsText != null,
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
      const currentGrade = state.race.grade
      const currentRaceStableId = row.race?.stableId ?? null
      const currentRaceType: RaceType | null = row.race
        ? raceTypeForRow(row.race)
        : null

      // ---- Class/profession track evolution path --------------------------- //
      // Discriminated on the track value, not on key presence: a race path may carry
      // an explicit `track: "race"` (new clients) or omit the key (legacy clients),
      // so `"track" in body` would wrongly route a `track: "race"` body here. Only a
      // `"class"` / `"profession"` value is a track evolution.
      if (body.track === "class" || body.track === "profession") {
        return evolveTrackCharacter(tx, row, state, body, user, houseRules)
      }

      // ---- Legacy grade-only path (house fallback) ------------------------- //
      if ("grade" in body) {
        // Only the NEXT grade may be evolved into. A skip grade (e.g. G->E while
        // the race level already falls in E's published band) is rejected up front
        // here, before any option/path gating, even though the engine's level check
        // alone would accept it - the character must never jump a grade.
        const targetGrade = nextGrade(currentGrade)
        if (body.grade !== targetGrade) {
          throw badRequest(
            "invalid_evolution_grade",
            `Character is grade ${currentGrade}; can only evolve to the next grade ${targetGrade ?? "(none)"}, got ${body.grade}`
          )
        }
        // If ANY valid, unarchived catalog path to the NEXT grade exists (even when
        // every such path is currently blocked), the client must choose a path.
        // Cross-type paths are not collected, so a character that cannot convert is
        // still offered the grade-only fallback.
        const valid = await collectValidRacePathsForTarget(
          tx,
          currentRaceStableId,
          currentGrade,
          targetGrade,
          currentRaceType
        )
        if (valid.length > 0) {
          throw conflict(
            "evolution_choice_required",
            `Catalog defines race evolution path(s) to grade ${targetGrade}; submit an optionId choice`
          )
        }
        const config = configFor(row, houseRules.config)
        const result = applyEvolve(state, body.grade, config)
        const serialized = serializeState(result.state)
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
            kind: "evolve",
            payload: {
              grade: body.grade,
              journal: result.journal,
            } as Prisma.InputJsonValue,
          },
        })
        const updated = (await tx.character.findUnique({
          where: { id },
          include: characterInclude,
        }))!
        return {
          character: toDetail(updated, true, config, houseRules.version),
          journal: result.journal,
        }
      }

      // ---- Catalog race path choice ---------------------------------------- //
      const optionId = body.optionId
      const evo = await tx.catalogDefinition.findUnique({
        where: { id: optionId },
      })
      if (!evo || evo.kind !== "evolutions") {
        throw notFound("evolution_not_found", "Evolution path not found")
      }
      if (evo.archived) {
        throw badRequest(
          "catalog_archived",
          `Evolution path "${evo.name}" is archived`
        )
      }
      const path = parseRaceEvolutionPath(evo)
      if (!path) {
        throw badRequest(
          "evolution_invalid_config",
          `Evolution path "${evo.name}" has no usable race config`
        )
      }
      if (
        currentRaceStableId == null ||
        path.fromRaceStableId !== currentRaceStableId
      ) {
        throw badRequest(
          "evolution_race_mismatch",
          `Path requires race "${path.fromRaceStableId}", character is "${currentRaceStableId ?? "(none)"}"`
        )
      }
      if (path.fromGrade !== currentGrade) {
        throw badRequest(
          "evolution_grade_mismatch",
          `Path requires current grade ${path.fromGrade}, character is ${currentGrade}`
        )
      }

      // Only the NEXT grade may be targeted. A skip-grade path (e.g. G->E while the
      // race level already falls in E's published band) is rejected up front, before
      // destination resolution and eligibility gating, even though every other gate
      // would pass - the character must never jump a grade.
      const targetGrade = nextGrade(currentGrade)
      if (path.toGrade !== targetGrade) {
        throw badRequest(
          "invalid_evolution_grade",
          `Path evolves to grade ${path.toGrade}; character is grade ${currentGrade} and can only evolve to the next grade ${targetGrade ?? "(none)"}`
        )
      }

      // Destination race must exist, be enabled, and define the target grade.
      const destRace = await findCatalogByStableId(
        tx,
        "races",
        path.toRaceStableId
      )
      if (!destRace) {
        throw badRequest(
          "evolution_destination_missing",
          `Destination race "${path.toRaceStableId}" is not in the catalog`
        )
      }
      if (destRace.archived) {
        throw badRequest(
          "evolution_destination_archived",
          `Destination race "${destRace.name}" is archived`
        )
      }
      // An evolution must never cross raceType without an explicit conversion. The
      // GET options (and the grade-only fallback filter) never offer a cross-type
      // path, so a client normally cannot land here, but a direct optionId choice
      // to a differently-typed destination is rejected up front rather than
      // silently mutating the race mode.
      const destRaceType = raceTypeForRow(destRace)
      if (currentRaceType != null && destRaceType !== currentRaceType) {
        throw badRequest(
          "race_type_mismatch",
          `Evolution would change race type from "${currentRaceType}" to "${destRaceType}"; a race cannot cross its advancement mode without an explicit conversion`
        )
      }
      const destConfigParsed = parseCatalogConfig(
        "races",
        destRace.config ?? {}
      )
      const defs = (destConfigParsed.raceDefinitions ?? {}) as Record<
        string,
        unknown
      >
      if (!(path.toGrade in defs)) {
        throw badRequest(
          "evolution_destination_definition_missing",
          `Destination race "${destRace.name}" has no ${path.toGrade}-grade race definition`
        )
      }

      // Re-evaluate eligibility INSIDE the transaction. A user or admin reason can
      // never bypass a mechanical blocker; manualRequirementsText can be overridden
      // only by a nonempty admin reason.
      const { eligible, blockers } = evaluateRacePathEligibility(path, {
        currentRaceStableId,
        currentGrade,
        raceLevel: state.race.level,
        linkedTitleStableIds: linkedStableIds(row, "TITLE"),
        linkedSkillStableIds: linkedStableIds(row, "SKILL"),
      })
      if (!eligible) {
        throw badRequest("evolution_prerequisites", blockers.join("; "))
      }
      if (path.manualRequirementsText != null) {
        const canBypass =
          user.isAdmin &&
          typeof body.reason === "string" &&
          body.reason.trim().length > 0
        if (!canBypass) {
          throw badRequest(
            "evolution_manual_required",
            user.isAdmin
              ? `A reason is required to override manual requirements: ${path.manualRequirementsText}`
              : `Requires manual (admin) review: ${path.manualRequirementsText}`
          )
        }
      }

      // Run the pure engine (evolveGrade) with the TARGET race's rules config, only
      // after validating both current and destination. No rewards/skills are
      // invented: class/profession tracks, historical awards and allocations are
      // preserved.
      const destRulesConfig = buildRulesConfig(destRace, houseRules.config)
      const result = applyEvolve(state, path.toGrade, destRulesConfig)
      const serialized = serializeState(result.state)
      const updatedMany = await tx.character.updateMany({
        where: { id, version: body.version },
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

      const reason =
        typeof body.reason === "string" && body.reason.trim().length > 0
          ? body.reason.trim()
          : null
      const journal: Record<string, unknown> = {
        ...result.journal,
        source: "catalog",
        optionId: evo.id,
        option: { id: evo.id, name: evo.name, stableId: evo.stableId },
        prerequisites: {
          fromRaceStableId: path.fromRaceStableId,
          toRaceStableId: path.toRaceStableId,
          fromGrade: path.fromGrade,
          toGrade: path.toGrade,
          minRaceLevel: path.minRaceLevel ?? null,
          requiredTitleStableIds: path.requiredTitleStableIds,
          requiredSkillStableIds: path.requiredSkillStableIds,
        },
        destinationRace: {
          id: destRace.id,
          stableId: destRace.stableId,
          name: destRace.name,
        },
        reason,
      }

      await tx.progressionEvent.create({
        data: {
          characterId: id,
          kind: "evolve",
          payload: {
            optionId: evo.id,
            journal,
            reason,
          } as Prisma.InputJsonValue,
        },
      })
      const updated = (await tx.character.findUnique({
        where: { id },
        include: characterInclude,
      }))!
      const updatedConfig = buildRulesConfig(updated.race, houseRules.config)
      return {
        character: toDetail(updated, true, updatedConfig, houseRules.version),
        journal,
      }
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
 * POST /api/characters/[id]/evolve (track branch).
 *
 * Evolve a graded class/profession track to the next grade via a catalog path
 * choice. This is the class/profession analogue of the race catalog path
 * evolution: only the target track's `grade` and `definitionId` change, and the
 * race grade is never touched. There is no class/profession grade-only legacy
 * fallback here - a track path choice is always required.
 */
async function evolveTrackCharacter(
  tx: DbClient,
  row: CharacterWithCatalog,
  state: CharacterState,
  body: Extract<EvolveCharacterInput, { track: "class" | "profession" }>,
  user: SessionUser,
  houseRules: HouseRulesRow
): Promise<{ character: CharacterDetail; journal: unknown }> {
  const track = body.track

  // The selected evolutions catalog entry must exist and be an unarchived
  // class/profession evolution path.
  const evo = await tx.catalogDefinition.findUnique({
    where: { id: body.optionId },
  })
  if (!evo || evo.kind !== "evolutions") {
    throw notFound("evolution_not_found", "Evolution path not found")
  }
  if (evo.archived) {
    throw badRequest(
      "catalog_archived",
      `Evolution path "${evo.name}" is archived`
    )
  }
  const path = parseTrackEvolutionPath(evo)
  if (!path) {
    throw badRequest(
      "evolution_invalid_config",
      `Evolution path "${evo.name}" has no usable ${track} config`
    )
  }
  if (path.track !== track) {
    throw badRequest(
      "evolution_track_mismatch",
      `Path targets ${path.track}; character is evolving ${track}`
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

  const currentDefinitionStableId =
    track === "class"
      ? (row.class?.stableId ?? null)
      : (row.profession?.stableId ?? null)
  if (
    currentDefinitionStableId == null ||
    path.fromDefinitionStableId !== currentDefinitionStableId
  ) {
    throw badRequest(
      "evolution_track_mismatch",
      `Path requires ${track} "${path.fromDefinitionStableId}", character is "${currentDefinitionStableId ?? "(none)"}"`
    )
  }
  if (path.fromGrade !== trackGrade) {
    throw badRequest(
      "evolution_grade_mismatch",
      `Path requires current grade ${path.fromGrade}, character ${track} is ${trackGrade}`
    )
  }

  // Only the NEXT grade may be targeted. A skip-grade path (e.g. F->D while the
  // track level already qualifies for D) is rejected up front - the character must
  // never jump a grade.
  const targetGrade = nextGrade(trackGrade)
  if (path.toGrade !== targetGrade) {
    throw badRequest(
      "invalid_evolution_grade",
      `Path evolves to grade ${path.toGrade}; character ${track} is grade ${trackGrade} and can only evolve to the next grade ${targetGrade ?? "(none)"}`
    )
  }

  // Destination definition must exist, be enabled and define the target grade.
  const destKind = track === "class" ? "classes" : "professions"
  const destDefinition = await findCatalogByStableId(
    tx,
    destKind,
    path.toDefinitionStableId
  )
  if (!destDefinition) {
    throw badRequest(
      "evolution_destination_missing",
      `Destination ${track} "${path.toDefinitionStableId}" is not in the catalog`
    )
  }
  if (destDefinition.archived) {
    throw badRequest(
      "evolution_destination_archived",
      `Destination ${track} "${destDefinition.name}" is archived`
    )
  }
  const destConfig = parseCatalogConfig(destKind, destDefinition.config ?? {})
  const destGrades = (destConfig.grades ?? {}) as Record<string, unknown>
  if (!(path.toGrade in destGrades)) {
    throw badRequest(
      "evolution_destination_definition_missing",
      `Destination ${track} "${destDefinition.name}" has no ${path.toGrade}-grade track definition`
    )
  }

  // Re-evaluate eligibility INSIDE the transaction. A user or admin reason can
  // never bypass a mechanical blocker; manualRequirementsText can be overridden
  // only by a nonempty admin reason.
  const { eligible, blockers } = evaluateTrackPathEligibility(path, {
    currentDefinitionStableId,
    currentGrade: trackGrade,
    trackLevel: trackState.level,
    linkedTitleStableIds: linkedStableIds(row, "TITLE"),
    linkedSkillStableIds: linkedStableIds(row, "SKILL"),
  })
  if (!eligible) {
    throw badRequest("evolution_prerequisites", blockers.join("; "))
  }
  if (path.manualRequirementsText != null) {
    const canBypass =
      user.isAdmin &&
      typeof body.reason === "string" &&
      body.reason.trim().length > 0
    if (!canBypass) {
      throw badRequest(
        "evolution_manual_required",
        user.isAdmin
          ? `A reason is required to override manual requirements: ${path.manualRequirementsText}`
          : `Requires manual (admin) review: ${path.manualRequirementsText}`
      )
    }
  }

  // Run the pure engine (evolveTrackGrade) with the character's rules config. Only
  // the target track's grade/definitionId change; the race grade and every other
  // ledger (historical awards, allocations, associations) are preserved.
  const config = configFor(row, houseRules.config)
  const result = evolveTrackGrade(
    state,
    track,
    path.toGrade,
    `${destDefinition.stableId}:${path.toGrade}`,
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

  const reason =
    typeof body.reason === "string" && body.reason.trim().length > 0
      ? body.reason.trim()
      : null
  const journal: Record<string, unknown> = {
    ...result.journal,
    source: "track",
    track,
    optionId: evo.id,
    option: { id: evo.id, name: evo.name, stableId: evo.stableId },
    prerequisites: {
      fromDefinitionStableId: path.fromDefinitionStableId,
      toDefinitionStableId: path.toDefinitionStableId,
      fromGrade: path.fromGrade,
      toGrade: path.toGrade,
      minTrackLevel: path.minTrackLevel ?? null,
      requiredTitleStableIds: path.requiredTitleStableIds,
      requiredSkillStableIds: path.requiredSkillStableIds,
    },
    destination: {
      id: destDefinition.id,
      stableId: destDefinition.stableId,
      name: destDefinition.name,
      grade: path.toGrade,
    },
    reason,
  }

  await tx.progressionEvent.create({
    data: {
      characterId: row.id,
      kind: "evolve",
      payload: {
        optionId: evo.id,
        track,
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
    character: toDetail(updated, true, updatedConfig, houseRules.version),
    journal,
  }
}

/**
 * Consume a catalog consumable onto a character.
 *
 * The consumer must be the owner or an admin, the target catalog entry must be
 * an unarchived `consumables` definition, and the character must not be archived.
 * Two kinds are supported, mirroring the consumable engine:
 *   - `permanent`: `applyPermanentConsumable()` rejects the request in whole when
 *     any attribute exceeds the cumulative per-attribute capacity (the grade-based
 *     race-level cap). A recorded gain is immutable.
 *   - `temporary`: `consumableToEffect()` produces a temporary effect with a unique
 *     id and an `expiresAt` of `state.turn + durationQuarters`; it is NOT capped by
 *     the grade rates. Expiry is automatic on quarter advancement (the engine drops
 *     effects whose `expiresAt <= state.turn`).
 *
 * The mutation runs in a transaction that CASes the client-supplied `version`
 * (a stale value 409s and rolls back the state write and the journal entry), then
 * persists the new state, logs a `consume` progression event carrying a definition
 * snapshot plus applied/requested/capRemainingAfter, the acting user id, and a
 * timestamp, and returns the updated character, its live status, and the event.
 */
export async function consumeCharacter(
  id: string,
  body: { definitionId: string; version: number },
  user: SessionUser
): Promise<{
  character: CharacterDetail
  status: StatusResult
  event: unknown
}> {
  return prisma
    .$transaction(
      async (tx) => {
        const row = await assertOwner(tx, id, user)
        const houseRules = await loadHouseRules(tx)
        // A consumed item mutates the character, so an archived character is inert.
        if (row.archived) {
          throw badRequest(
            "character_archived",
            "Archived character cannot consume a consumable"
          )
        }

        const definition = await tx.catalogDefinition.findUnique({
          where: { id: body.definitionId },
        })
        if (!definition) {
          throw notFound("catalog_not_found", "Catalog entry not found")
        }
        if (definition.kind !== "consumables") {
          throw badRequest(
            "wrong_kind",
            `Catalog entry has wrong kind (expected "consumables")`
          )
        }
        if (definition.archived) {
          throw badRequest(
            "catalog_archived",
            "Catalog entry is archived and cannot be consumed"
          )
        }

        const config = parseCatalogConfig(
          definition.kind,
          definition.config ?? {}
        )
        const state = deserializeState(row.state)
        const rulesConfig = configFor(row, houseRules.config)

        // The engine never guesses the origin from the grade: origin is always
        // reconstructed from the authoritative Character.origin column before any
        // apply, and the mutation persists it so the ledger state becomes
        // self-describing. This both fixes legacy states that predate origin
        // tracking and guards against any drift between the state and the row.
        const stateWithOrigin: CharacterState = {
          ...state,
          race: { ...state.race, origin: row.origin },
        }

        // A legacy catalog consumable config carries no usable type/amount and is
        // metadata-only. It stays editable but must be rejected here with an
        // actionable 400 rather than silently granted a fabricated default amount
        // (an empty vector would otherwise be misreported as an over-cap error) or
        // blow up as a 500 during config parsing.
        if (
          definition.kind === "consumables" &&
          isLegacyConsumableConfig(config)
        ) {
          throw badRequest(
            "legacy_consumable_config",
            `Consumable "${definition.name}" has no usable "type"/"amount" in its catalog config; add both to consume it`
          )
        }

        // Consuming requires OWNED stock, checked and decremented/removed INSIDE the
        // same transaction as the cap/duration validation, CAS, and journal: a failed
        // cap, duration, or stale version rolls back the stock change, the state and
        // the event together. An absent row (or a quantity below 1) means zero stock.
        const stockRow = await tx.characterInventoryItem.findUnique({
          where: {
            characterId_definitionId: {
              characterId: id,
              definitionId: definition.id,
            },
          },
        })
        const stockPrior = stockRow?.quantity ?? 0
        if (stockPrior < 1) {
          throw badRequest(
            "inventory_insufficient",
            `You own no "${definition.name}" to consume; add it to your inventory first`
          )
        }

        const type = config.type === "temporary" ? "temporary" : "permanent"
        const amount = (config.amount ?? {}) as PartialVector
        const snapshot = {
          id: definition.id,
          name: definition.name,
          stableId: definition.stableId,
          kind: definition.kind,
          config: (definition.config ?? {}) as Record<string, unknown>,
          provenance: "catalog",
          grade: definition.grade,
          archived: definition.archived,
        }

        let nextState: CharacterState
        let eventPayload: Record<string, unknown>

        if (type === "permanent") {
          const result = applyPermanentConsumable(
            stateWithOrigin,
            definition.name,
            amount,
            rulesConfig
          )
          if (!result.ok || !result.entry) {
            throw badRequest(
              "consumable_cap_exceeded",
              result.errors.join("; ") || "Permanent consumable exceeds its cap"
            )
          }
          nextState = result.state
          eventPayload = {
            definitionId: definition.id,
            definition: snapshot,
            type: "permanent",
            amount,
            applied: result.entry.vector,
            requested: result.entry.requested ?? result.entry.vector,
            capRemainingAfter: result.entry.capRemainingAfter ?? {},
            stockPrior,
            stockAfter: stockPrior - 1,
            appliedAt: new Date().toISOString(),
            actorId: user.id,
          }
        } else {
          const durationQuarters = config.durationQuarters as number | undefined
          if (durationQuarters == null) {
            throw badRequest(
              "validation",
              "Temporary consumable requires durationQuarters"
            )
          }
          // A unique effect id per consumption so repeated applications never collide.
          const effectId = `${definition.id}:cons-${stateWithOrigin.turn}-${stateWithOrigin.activeEffects.length}`
          const effect = consumableToEffect(
            {
              id: effectId,
              name: definition.name,
              group: (config.group as string | undefined) ?? "",
              amount,
              durationQuarters,
              ...(definition.grade ? { grade: definition.grade as Grade } : {}),
            },
            stateWithOrigin
          )
          nextState = {
            ...stateWithOrigin,
            activeEffects: [...stateWithOrigin.activeEffects, effect],
          }
          eventPayload = {
            definitionId: definition.id,
            definition: snapshot,
            type: "temporary",
            amount,
            applied: amount,
            requested: amount,
            effectId,
            durationQuarters,
            expiresAt: effect.expiresAt,
            capRemainingAfter: {},
            stockPrior,
            stockAfter: stockPrior - 1,
            appliedAt: new Date().toISOString(),
            actorId: user.id,
          }
        }

        // Consume exactly ONE owned unit. The final unit removes the whole row (the
        // CHECK constraint forbids quantity 0), so an absent row again means zero.
        const stockAfter = stockPrior - 1
        if (stockAfter === 0) {
          await tx.characterInventoryItem.deleteMany({
            where: { characterId: id, definitionId: definition.id },
          })
        } else {
          await tx.characterInventoryItem.updateMany({
            where: { characterId: id, definitionId: definition.id },
            data: { quantity: { decrement: 1 } },
          })
        }

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
            kind: "consume",
            payload: eventPayload as Prisma.InputJsonValue,
          },
        })

        const updated = (await tx.character.findUnique({
          where: { id },
          include: characterInclude,
        }))!
        return {
          character: toDetail(updated, true, rulesConfig, houseRules.version),
          status: statusFor(updated, rulesConfig),
          event: { kind: "consume", payload: eventPayload },
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )
    .catch((err) => {
      // A concurrent consume that cannot serialize (two requests racing on the
      // same final stock unit / version) surfaces as P2034; map it to a 409
      // rather than a raw 500 so the client retries.
      if (isSerializationFailure(err)) {
        throw conflict(
          "catalog_serialization_conflict",
          "Concurrent character write conflict; retry the change"
        )
      }
      throw err
    })
}

// ------------------------------------------------------------------ //
// Character inventory
// ------------------------------------------------------------------ //

/**
 * Read a character's owned inventory (equipment + consumables, including
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
 * Add or remove owned inventory quantity for a character.
 *
 * This is the user's manual bookkeeping path for acquisition (no acquisition
 * economy is invented here): the client states how many units were obtained or
 * spent and a mandatory source note, and the service records the prior/new
 * quantity in the `inventory_adjust` journal along with a definition snapshot and
 * the acting user id.
 *
 * - Only `equipment` / `consumables` definitions may be inventoried. Adding
 *   requires an ACTIVE (unarchived) definition; removing is permitted for
 *   archived definitions (owned stock may be spent even when new stock cannot be
 *   acquired).
 * - `quantity` is bounded 1..999999. A remove down to zero deletes the row (an
 *   absent row means zero stock); a remove beyond owned stock is rejected. A new
 *   distinct definition can be added only while the character owns fewer than
 *   MAX_IMPORT_INVENTORY distinct definitions (the trusted-backup roundtrip cap);
 *   exceeding it is a 409.
 * - Ownership invariant: a removal that would take an equipped item's stock to
 *   zero is rejected with a 409 `inventory_equipped` (no auto-unequip). This
 *   applies to any EQUIPMENT association for the definition (legacyUnowned true
 *   or false, and including archived linked definitions) that currently owns
 *   stock; a grandfathered link already at zero stock has no inventory row to
 *   remove, so it never hits this branch and stays equipped. A removal that
 *   leaves at least one unit is always allowed.
 * - The write runs under SERIALIZABLE isolation, CASes the character version, and
 *   maps a P2034 (cannot-serialize concurrent write) to a 409. A stale version
 *   409s and rolls back the inventory change and the journal.
 */
export async function adjustCharacterInventory(
  id: string,
  body: {
    operation: "add" | "remove"
    definitionId: string
    quantity: number
    version: number
    sourceNote: string
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
        if (
          definition.kind !== "equipment" &&
          definition.kind !== "consumables"
        ) {
          throw badRequest(
            "wrong_kind",
            `Catalog entry has wrong kind (expected "equipment" or "consumables")`
          )
        }
        if (body.operation === "add" && definition.archived) {
          throw badRequest(
            "catalog_archived",
            "Catalog entry is archived and cannot be added to inventory"
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

        await tx.progressionEvent.create({
          data: {
            characterId: id,
            kind: "inventory_adjust",
            payload: {
              operation: body.operation,
              definitionId: definition.id,
              definition: {
                id: definition.id,
                name: definition.name,
                kind: definition.kind,
                stableId: definition.stableId,
                grade: definition.grade,

                archived: definition.archived,
              },
              quantity: body.quantity,
              priorQuantity: prior,
              newQuantity: next,
              sourceNote: body.sourceNote,
              actorId: user.id,
              at: new Date().toISOString(),
            } as Prisma.InputJsonValue,
          },
        })

        const updated = (await tx.character.findUnique({
          where: { id },
          include: characterInclude,
        }))!
        return {
          character: detailFor(updated, houseRules),
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
                      upgradeGroup:
                        (config.upgradeGroup as string | undefined) ?? null,
                      tier: (config.tier as string | undefined) ?? null,
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
        return { character: detailFor(updated, houseRules) }
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
            } as Prisma.InputJsonValue,
          },
        })

        const updated = (await tx.character.findUnique({
          where: { id },
          include: characterInclude,
        }))!
        return { character: detailFor(updated, houseRules) }
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
  const live = liveState(row)
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
  // that can be inventoried (equipment / consumables) are emitted; the quantity is
  // the owned count, never 0 (an absent entry means zero owned stock).
  const inventory = row.inventory.map((item) => ({
    definition: {
      kind:
        item.definition.kind === "consumables" ? "consumables" : "equipment",
      stableId: item.definition.stableId,
    },
    quantity: item.quantity,
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
  // `offeredAt` is emitted as an ISO string; the importer parses it back to a Date.
  const skillOffers = row.skillOffers.map((offer) => {
    const selectedOption = offer.options.find(
      (o) => o.definitionId === offer.selectedDefinitionId
    )
    return {
      track: offer.track,
      level: offer.level,
      choiceGroup: offer.choiceGroup,
      offeredAt: offer.offeredAt.toISOString(),
      selectedStableId: selectedOption?.definition?.stableId ?? null,
      selectedAt: offer.selectedAt ? offer.selectedAt.toISOString() : null,
      options: offer.options.map((o) => ({
        stableId: o.definition?.stableId ?? "",
        nameSnapshot: o.nameSnapshot,
        configSnapshot: (o.configSnapshot ?? {}) as Record<string, unknown>,
      })),
    }
  })
  return {
    schema: IMPORT_SCHEMA_V5,
    rulesetVersion: IMPORT_RULESET_VERSION,
    identity,
    character: listItemFor(row, houseRules, true),
    state,
    liveState: live,
    status: statusFor(row, config),
    // Informational derived quality for the exporting UI; NOT authoritative on
    // import (the importer recomputes it from the re-linked associations).
    isTranscendent: isTranscendentFor(row),
    associations,
    inventory,
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

/**
 * Resolve a blessing config's `patronGodStableId` to the FK `patronId`, or null
 * when no patron is configured. The referenced definition MUST be an unarchived
 * `gods` entry; a missing definition (including a wrong-kind stableId, because
 * the lookup is scoped to `gods`) or an archived god is rejected with an
 * actionable 400, never a dangling FK. Phase 2 will synthesize the god's
 * metadata when the blessing is linked to a character; the FK is the only
 * authoritative reference stored for now.
 */
async function resolveBlessingPatronId(
  db: DbClient,
  config: Record<string, unknown>
): Promise<string | null> {
  const stableId = config.patronGodStableId
  if (typeof stableId !== "string" || stableId.length === 0) return null
  const god = await findCatalogByStableId(db, "gods", stableId)
  if (!god) {
    throw badRequest(
      "patron_god_not_found",
      `Patron god "${stableId}" is not in the catalog`
    )
  }
  if (god.archived) {
    throw badRequest(
      "patron_god_archived",
      `Patron god "${god.name}" is archived; unarchive it before granting its blessing`
    )
  }
  return god.id
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
  blessing: "blessings",
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
    { schema: typeof IMPORT_SCHEMA_V4 | typeof IMPORT_SCHEMA_V5 }
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
  offeredAt: Date
  selectedDefinitionId: string | null
  selectedAt: Date | null
  options: ResolvedOfferOption[]
}

function parseOfferDate(value: string | number | null | undefined): Date {
  if (value == null) return new Date()
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed
}

async function resolveSkillOfferRefs(
  db: DbClient,
  offers: CharacterImportDocument["skillOffers"]
): Promise<ResolvedOffer[]> {
  const seen = new Set<string>()
  const result: ResolvedOffer[] = []
  for (const o of offers) {
    const key = `${o.track}:${o.level}:${o.choiceGroup}`
    if (seen.has(key)) {
      throw badRequest(
        "import_duplicate_offer",
        `Duplicate skill offer for ${o.track} level ${o.level} choice group "${o.choiceGroup}"`
      )
    }
    seen.add(key)

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

    result.push({
      track: o.track,
      level: o.level,
      choiceGroup: o.choiceGroup,
      offeredAt: parseOfferDate(o.offeredAt),
      selectedDefinitionId,
      selectedAt: selectedDefinitionId ? parseOfferDate(o.selectedAt) : null,
      options,
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
        input.schema === IMPORT_SCHEMA_V4 || input.schema === IMPORT_SCHEMA_V5
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
          // definition.config.slot snapshot; a v5 document carries the position
          // explicitly and never trusts the snapshot.
          allowConfigSnapshotPosition: input.schema !== IMPORT_SCHEMA_V5,
        }
      )
      assertAssocCollisions(
        resolvedAssocs,
        houseRules.config.maxTranscendentSkills
      )
      const resolvedOffers = await resolveSkillOfferRefs(tx, input.skillOffers)

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
          },
        })
      }

      // Import owned stock. Only reached for a v4 document (v3 imports no stock, so
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

      for (const o of resolvedOffers) {
        await tx.skillOffer.create({
          data: {
            characterId: created.id,
            track: o.track,
            level: o.level,
            choiceGroup: o.choiceGroup,
            offeredAt: o.offeredAt,
            selectedDefinitionId: o.selectedDefinitionId,
            selectedAt: o.selectedAt,
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
            // stock definitions were restored, so the marker is an auditable record
            // of the backup's origin (never verified source provenance itself).
            backupSchema: input.schema,
            inventoryCount: resolvedInventory.length,
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

      return detailFor(refetched, houseRules)
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
 * Detect a Prisma serialization/deadlock failure (P2034). Under SERIALIZABLE
 * isolation two concurrent catalog writes that race on the same row (e.g. two
 * concurrent blessing creates with the same stableId, or two concurrent god
 * stableId changes) cannot both commit; the loser surfaces as P2034 and we map
 * it to a 409 rather than a raw 500.
 */
function isSerializationFailure(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { code?: string }).code === "P2034"
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
  const includeArchived = opts.includeArchived === true
  const rows = await prisma.catalogDefinition.findMany({
    where: {
      kind: kind as never,
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
  const row = await prisma.catalogDefinition.findUnique({ where: { id } })
  if (!row || row.kind !== kind) {
    throw notFound("catalog_not_found", "Catalog entry not found")
  }
  return catalogItem(row)
}

export async function createCatalogItem(
  kind: string,
  input: {
    stableId?: string
    name: string
    description?: string | null
    grade?: string | null
    sourceUrl?: string | null
    archived?: boolean
    config?: Record<string, unknown>
    gradeDescriptions?: Partial<Record<Grade, string>>
  }
): Promise<CatalogItem> {
  const config = parseConfigOr400(kind, input.config ?? {})
  // A new consumable requires the modern full shape; legacy metadata-only configs
  // are accepted only for existing entries whose config is not being changed.
  if (kind === "consumables" && isLegacyConsumableConfig(config)) {
    throw badRequest(
      "invalid_config",
      'Consumable config is missing required "type" and "amount" fields'
    )
  }
  if (kind === "skills" && isIncompleteSkillConfig(config)) {
    throw badRequest(
      "invalid_config",
      'Skill config is offer-incomplete: an offer-eligible milestone skill requires both a "track" and a "milestone"'
    )
  }
  if (kind === "skills" && hasInvalidSkillTrack(config)) {
    throw badRequest(
      "invalid_config",
      'Skill config has an invalid "track": expected "class" or "profession"'
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
  // A NEW evolutions entry must be a valid full race OR class/profession path; a
  // legacy metadata-only config cannot be used as an optionId choice.
  if (kind === "evolutions" && !isValidEvolutionConfig(config)) {
    throw badRequest(
      "invalid_config",
      'Evolution config is not a valid path: it must be a complete race path (track "race", fromRaceStableId, toRaceStableId, fromGrade, toGrade) OR a complete class/profession path (track "class"/"profession", fromDefinitionStableId, toDefinitionStableId, fromGrade, toGrade)'
    )
  }
  // A NEW blessing must carry the modern `tier` + `effects` shape; a legacy
  // metadata-only config is accepted only for existing entries, never here.
  if (kind === "blessings" && isLegacyBlessingConfig(config)) {
    throw badRequest(
      "invalid_config",
      'Blessing config is missing required "tier" and "effects" fields'
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
  let stableId = input.stableId
  if (!stableId) {
    stableId =
      input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "entry"
  }
  // A blessing's configured patron god resolves to the FK `patronId`; every other
  // kind keeps it null. Resolution is a READ, so it happens inside the SAME
  // transaction as the create so an invalid/archived patron is rejected up front
  // (never a dangling FK) and the read never races the write.
  //
  // Blessings and bloodlines run under SERIALIZABLE isolation: two concurrent
  // creates that race on the same (kind, stableId) cannot both commit, and the
  // loser surfaces as P2034 which we map to a 409 rather than a silent 500.
  const serializable =
    kind === "blessings" || kind === "bloodlines"
      ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      : undefined
  try {
    return await prisma.$transaction(async (tx) => {
      const patronData: { patronId?: string | null } =
        kind === "blessings"
          ? { patronId: await resolveBlessingPatronId(tx, config) }
          : {}
      const row = await tx.catalogDefinition.create({
        data: {
          kind: kind as never,
          stableId,
          name: input.name,
          description: input.description ?? null,
          grade: input.grade ?? null,
          sourceUrl: input.sourceUrl ?? null,
          archived: input.archived ?? false,
          config: config as Prisma.InputJsonValue,
          ...(input.gradeDescriptions != null
            ? {
                gradeDescriptions:
                  input.gradeDescriptions as Prisma.InputJsonValue,
              }
            : {}),
          ...patronData,
        },
      })
      return catalogItem(row)
    }, serializable)
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict(
        "catalog_stable_id_conflict",
        `Catalog entry with stableId "${stableId}" already exists`
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
 * character:
 *   - an equipment `slot`, a title `upgradeGroup`, a skill `upgradeGroup`, or a
 *     bloodline `upgradeGroup` collision (a character can never have two effective
 *     non-archived links in the same slot/group), or
 *   - a blessing that would leave a character with more than one ACTIVE
 *     (unarchived) blessing link.
 * A config edit / unarchive that introduces such a collision is rejected with 409
 * and the whole update is rolled back. Archived definitions are inert and never
 * collide. The check runs inside the same transaction as the update.
 */
async function assertNoLinkCollision(
  tx: DbClient,
  kind: string,
  definitionId: string,
  finalConfig: Record<string, unknown>,
  finalArchived: boolean
): Promise<void> {
  // Only slots (equipment), upgrade groups (titles/skills/bloodlines) and the
  // single-active-blessing invariant can collide. Archived definitions synthesise
  // no effect so they cannot conflict.
  if (
    kind !== "equipment" &&
    kind !== "titles" &&
    kind !== "skills" &&
    kind !== "bloodlines" &&
    kind !== "blessings"
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

  // A blessing is a "one active at a time" link: unarchiving or editing a linked
  // blessing must not leave its character with more than one active blessing.
  if (kind === "blessings") {
    for (const link of links) {
      const character = link.character
      if (!character) continue
      let otherActive: string | null = null
      for (const other of character.associations ?? []) {
        if (other.definitionId === definitionId) continue
        if (other.kind !== "BLESSING") continue
        const def = other.definition
        if (!def || def.archived) continue
        otherActive = def.name
        break
      }
      if (otherActive != null) {
        throw conflict(
          "link_collision",
          `Catalog edit would leave "${character.name}" with more than one active blessing: "${otherActive}" already occupies the active blessing slot`
        )
      }
    }
    return
  }

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

export async function updateCatalogItem(
  kind: string,
  id: string,
  patch: {
    stableId?: string
    name?: string
    description?: string | null
    grade?: string | null
    sourceUrl?: string | null
    archived?: boolean
    config?: Record<string, unknown>
    gradeDescriptions?: Partial<Record<Grade, string>>
  }
): Promise<CatalogItem> {
  // A god stableId change, a race `raceType` change, every blessing / bloodline
  // config change, and every ranked-title identity guard (which reads the linked
  // character associations) read the existing row and then write it, so they run
  // under SERIALIZABLE isolation: two concurrent edits that race on the same
  // catalog row cannot both commit, and the loser surfaces as P2034 which we map
  // to a 409. A race type change is serializable so it also conflicts correctly
  // with an in-flight `createCharacter` that has read the race row (a serializable
  // read / write dependency), instead of silently allowing a character built from
  // a stale `raceType`.
  const serializable =
    kind === "gods" ||
    kind === "races" ||
    kind === "blessings" ||
    kind === "bloodlines" ||
    kind === "titles" ||
    kind === "skills"
      ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      : undefined
  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.catalogDefinition.findUnique({
        where: { id },
      })
      if (!existing || existing.kind !== kind) {
        throw notFound("catalog_not_found", "Catalog entry not found")
      }
      // Legacy consumable configs remain editable for metadata-only PATCHes (no
      // `config` in the payload): the existing config is re-parsed permissively. A
      // config-changing PATCH, like a new POST, requires the modern full shape.
      let config: Record<string, unknown> | undefined
      if (patch.config != null) {
        config = parseConfigOr400(kind, patch.config)
        if (kind === "consumables" && isLegacyConsumableConfig(config)) {
          throw badRequest(
            "invalid_config",
            'Consumable config is missing required "type" and "amount" fields'
          )
        }
        if (kind === "skills" && isIncompleteSkillConfig(config)) {
          throw badRequest(
            "invalid_config",
            'Skill config is offer-incomplete: an offer-eligible milestone skill requires both a "track" and a "milestone"'
          )
        }
        if (kind === "skills" && hasInvalidSkillTrack(config)) {
          throw badRequest(
            "invalid_config",
            'Skill config has an invalid "track": expected "class" or "profession"'
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
          const existingParsed = parseCatalogConfig(
            "races",
            existing.config ?? {}
          )
          const existingRaceType = existingParsed.raceType
          if (
            merged.raceType == null &&
            (existingRaceType === "enlightened" ||
              existingRaceType === "monster")
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
            (merged.raceType !== "enlightened" &&
              merged.raceType !== "monster") ||
            !gradeSchema.safeParse(merged.naturalGrade).success
          ) {
            throw badRequest(
              "invalid_config",
              'Race config must declare a valid "raceType" ("enlightened"/"monster") and a valid "naturalGrade" ("G","F","E","D","C","B","A","S")'
            )
          }
          config = merged
        }
        if (kind === "evolutions" && !isValidEvolutionConfig(config)) {
          throw badRequest(
            "invalid_config",
            'Evolution config is not a valid path: it must be a complete race path (track "race", fromRaceStableId, toRaceStableId, fromGrade, toGrade) OR a complete class/profession path (track "class"/"profession", fromDefinitionStableId, toDefinitionStableId, fromGrade, toGrade)'
          )
        }
        if (kind === "blessings" && isLegacyBlessingConfig(config)) {
          throw badRequest(
            "invalid_config",
            'Blessing config is missing required "tier" and "effects" fields'
          )
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
      }
      const finalConfig =
        config ?? parseCatalogConfig(kind, existing.config ?? {})
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
      // A god's stableId cannot change while any blessing still names it as its
      // patron (via the FK patronId): the JSON `patronGodStableId` in that blessing
      // config would go stale and diverge from the FK, so reject the change (409)
      // rather than silently breaking the reference.
      if (
        kind === "gods" &&
        patch.stableId != null &&
        patch.stableId !== existing.stableId
      ) {
        const patronizing = await tx.catalogDefinition.findMany({
          where: { kind: "blessings", patronId: id },
        })
        if (patronizing.length > 0) {
          throw conflict(
            "patron_stable_id_in_use",
            `God "${existing.name}" is the patron of ${patronizing.length} blessing(s); its stableId cannot change while they reference it`
          )
        }
      }
      // A config-changing blessing PATCH must update the FK in the SAME transaction
      // as the config, so the JSON `patronGodStableId` and the stored `patronId`
      // always agree (a change to the stableId repoints the FK; a removal clears it).
      const patronData: { patronId?: string | null } =
        kind === "blessings" && config != null
          ? { patronId: await resolveBlessingPatronId(tx, config) }
          : {}
      // A Ring-slot item may not be converted to/from a different equipment
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
      }
      const row = await tx.catalogDefinition.update({
        where: { id },
        data: {
          ...(patch.stableId != null ? { stableId: patch.stableId } : {}),
          ...(patch.name != null ? { name: patch.name } : {}),
          ...(patch.description != null
            ? { description: patch.description }
            : {}),
          ...(patch.grade != null ? { grade: patch.grade } : {}),
          ...(patch.sourceUrl != null ? { sourceUrl: patch.sourceUrl } : {}),
          ...(patch.archived != null ? { archived: patch.archived } : {}),
          ...(config != null
            ? { config: config as Prisma.InputJsonValue }
            : {}),
          ...(patch.gradeDescriptions !== undefined
            ? {
                gradeDescriptions:
                  patch.gradeDescriptions as Prisma.InputJsonValue,
              }
            : {}),
          ...patronData,
        },
      })
      return catalogItem(row)
    }, serializable)
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
