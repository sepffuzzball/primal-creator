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
  type CharacterState,
  type EffectCondition,
  type Grade,
  type GradeBand,
  type PartialVector,
  type RaceDefinition,
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
  hasInvalidSkillTrack,
  isIncompleteSkillConfig,
  isLegacyBlessingConfig,
  isLegacyBloodlineConfig,
  isLegacyConsumableConfig,
  isLegacyTranscendentSkillConfig,
  isValidEvolutionConfig,
  isValidRaceEvolutionConfig,
  isValidTrackEvolutionConfig,
  parseCatalogConfig,
} from "@/lib/server/schemas"
import {
  IMPORT_RULESET_VERSION,
  IMPORT_SCHEMA_V4,
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
  /** Provenance label of the linked definition. */
  provenance?: string
  /** Whether the linked catalog definition is currently archived. */
  definitionArchived: boolean
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
  /** Provenance label of the linked definition. */
  provenance: string
}

export interface SkillOfferOptionView {
  definitionId: string
  nameSnapshot: string
  /** Whether the offered option's catalog definition is currently archived. */
  archived: boolean
  /** Catalog tier grade of the offered definition, when set. */
  grade?: string
  /** Provenance label of the offered definition. */
  provenance?: string
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
  origin: "integrated" | "born"
  raceId: string | null
  classId: string | null
  professionId: string | null
  raceName: string | null
  className: string | null
  professionName: string | null
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
  provenance: "verified" | "inferred" | "house"
  sourceUrl: string | null
  archived: boolean
  config: Record<string, unknown>
  createdAt: string
  updatedAt: string
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
 *   provenance-driven starting grade, not derived from level.
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

  tracks["class"] = {
    level: classLevel,
    quarter: 0,
    definitionId: classRow ? `${classRow.stableId}:F` : "",
    ...(classRow ? { grade: "F" as const } : {}),
  }
  if (professionRow) {
    tracks["profession"] = {
      level: professionLevel,
      quarter: 0,
      definitionId: classRow ? `${professionRow.stableId}:F` : "",
      ...(classRow ? { grade: "F" as const } : {}),
    }
  }

  return {
    baseAttributes: zeroVector(),
    tracks,
    race: {
      level: 0,
      grade: origin === "born" ? "F" : "G",
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
 * `provenance` and `source` always come from the catalog row.
 */
function appendDeclarativeEffects(
  activeEffects: CharacterState["activeEffects"],
  def: { id: string; name: string; provenance: string },
  effects: DeclarativeEffect[],
  idBase: string
): void {
  for (let i = 0; i < effects.length; i++) {
    const eff = effects[i]
    const group = eff.group
    const base = {
      id: `${idBase}:eff-${i}`,
      source: def.name,
      provenance: def.provenance,
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
      equipment.push({
        id: def.id,
        name: def.name,
        slot,
        source: def.name,
        bonus: makeVector((config.bonus ?? {}) as PartialVector),
      })
    } else if (def.kind === "titles") {
      const flat = config.flat as PartialVector | undefined
      if (flat) {
        activeEffects.push({
          id: `${def.id}:flat`,
          source: def.name,
          provenance: def.provenance,
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
          provenance: def.provenance,
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

function associationView(
  link: CharacterWithCatalog["associations"][number]
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
    if (slot) view.slot = slot
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
  if (kind === "skill" || kind === "transcendent") {
    if (link.definition.grade) view.grade = link.definition.grade
    view.provenance = link.definition.provenance
  }
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
      ...(o.definition?.provenance
        ? { provenance: o.definition.provenance }
        : {}),
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
  item: CharacterWithCatalog["inventory"][number]
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
    provenance: def.provenance,
  }
  if (def.kind === "equipment") {
    const slot = config.slot as string | undefined
    if (slot) view.slot = slot
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
  return {
    id: character.id,
    name: character.name,
    description: character.description,
    origin: character.origin,
    raceId: character.raceId,
    classId: character.classId,
    professionId: character.professionId,
    raceName: character.race?.name ?? null,
    className: character.class?.name ?? null,
    professionName: character.profession?.name ?? null,
    state: character.state,
    version: character.version,
    archived: character.archived,
    imported: character.imported,
    isTranscendent: isTranscendentFor(character),
    createdAt: character.createdAt.toISOString(),
    updatedAt: character.updatedAt.toISOString(),
    associations: character.associations.map(associationView),
    inventory: character.inventory.map(inventoryView),
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
  provenance: string
}): Record<string, unknown> {
  return {
    id: def.id,
    name: def.name,
    stableId: def.stableId,
    provenance: def.provenance,
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
 * - Two selected bloodlines may not share the same nonempty `upgradeGroup`
 *   (group replacement semantics would silently collapse them).
 * - Transcendent skills are distinct; no id may appear in more than one field.
 */
async function resolveSpecialAbilities(
  tx: DbClient,
  selection: SpecialAbilitiesSelection | undefined
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
    provenance: string
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
      provenance: def.provenance,
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

  // Bloodlines - distinct and never sharing a nonempty upgradeGroup.
  const bloodlineGroups = new Map<string, string>()
  const bloodlines: Array<Record<string, unknown>> = []
  for (const id of selection.bloodlineIds ?? []) {
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

  // Transcendent skills - distinct, coexisting with no singleton or group rule.
  const transcendents: Array<Record<string, unknown>> = []
  for (const id of selection.transcendentSkillIds ?? []) {
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
    origin: "integrated" | "born"
    raceId: string
    classId: string
    professionId?: string
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
  const [race, cls, profession] = await Promise.all([
    prisma.catalogDefinition.findUnique({ where: { id: input.raceId } }),
    prisma.catalogDefinition.findUnique({ where: { id: input.classId } }),
    input.professionId
      ? prisma.catalogDefinition.findUnique({
          where: { id: input.professionId },
        })
      : Promise.resolve(null),
  ])
  if (!race) throw notFound("race_not_found", "Race not found")
  if (!cls) throw notFound("class_not_found", "Class not found")
  if (input.professionId && !profession) {
    throw notFound("profession_not_found", "Profession not found")
  }
  if (race.kind !== "races")
    throw badRequest("invalid_race", "Race catalog entry has wrong kind")
  if (cls.kind !== "classes")
    throw badRequest("invalid_class", "Class catalog entry has wrong kind")
  if (profession && profession.kind !== "professions") {
    throw badRequest(
      "invalid_profession",
      "Profession catalog entry has wrong kind"
    )
  }

  // A graded new character requires an explicit F-grade per-level config for the
  // selected class (and profession when one is chosen). Without it the class track
  // cannot be stamped with its `stableId:F` definition and would fail to advance.
  if (!trackHasGradeConfig(cls, "F")) {
    throw badRequest(
      "invalid_class_grade",
      `Class "${cls.name}" defines no F-grade per-level config; add a "grades.F" entry to create it`
    )
  }
  if (profession && !trackHasGradeConfig(profession, "F")) {
    throw badRequest(
      "invalid_profession_grade",
      `Profession "${profession.name}" defines no F-grade per-level config; add a "grades.F" entry to create it`
    )
  }

  const state = createInitialState(input.origin, race, profession, cls)
  const serialized = serializeState(state)

  // Create the character and append the "create" progression event atomically: a
  // character row must never exist without its corresponding journal entry.
  return prisma.$transaction(async (tx) => {
    // Load the house rules ONCE for this mutation, through the SAME tx client.
    const houseRules = await loadHouseRules(tx)
    // Resolve the explicit special-ability selections INSIDE the transaction so a
    // wrong-kind / archived / collision / missing failure rolls back the whole
    // create (no character, no event, no links, no draft deletion). Omitted or
    // empty grants nothing (no inferred power from a legacy `special` bool).
    const special = await resolveSpecialAbilities(tx, input.specialAbilities)

    const created = await tx.character.create({
      data: {
        ownerId: user.id,
        name: input.name,
        description: input.description ?? null,
        origin: input.origin,
        raceId: race.id,
        classId: cls.id,
        professionId: profession?.id ?? null,
        state: serialized as Prisma.InputJsonValue,
        version: 0,
      },
      include: characterInclude,
    })

    await tx.progressionEvent.create({
      data: {
        characterId: created.id,
        kind: "create",
        payload: {
          origin: input.origin,
          raceId: race.id,
          classId: cls.id,
          professionId: profession?.id ?? null,
          // Selection snapshots + provenance, present only when the caller supplied
          // a non-empty special-ability selection.
          ...(special.journal ? { specialAbilities: special.journal } : {}),
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
  })
}

export async function updateCharacter(
  id: string,
  patch: {
    name?: string
    description?: string | null
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

    await tx.progressionEvent.create({
      data: {
        characterId: id,
        kind: "update",
        payload: {
          name: patch.name,
          description: patch.description,
          archived: patch.archived,
          currentResources: patch.currentResources,
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
  body: { track: "class" | "profession"; version: number },
  user: SessionUser
): Promise<{ character: CharacterDetail; journal: unknown }> {
  return prisma.$transaction(async (tx) => {
    const row = await assertOwner(tx, id, user)
    const houseRules = await loadHouseRules(tx)
    const state = deserializeState(row.state)
    const config = configFor(row, houseRules.config)
    const trackRow = body.track === "class" ? row.class : row.profession
    const definition = resolveTrackDefinition(trackRow, state, body.track)
    if (!definition) {
      throw badRequest(
        "no_definition",
        `No supported track definition for ${body.track}`
      )
    }
    const result = applyAdvance(state, body.track, definition, config)
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

    // Skills are offered, never auto-awarded: on a LEVEL-UP only, generate one
    // offer per choice group from the current unarchived skills catalog. A
    // quarter-only advance (no level up) produces no offers. The offers are
    // created inside the same transaction as the CAS state write and the
    // immutable advance event, so a conflict rolls all of them back together.
    let skillOffers: Array<{ id: string; choiceGroup: string }> = []
    if (result.journal.leveledUp) {
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
          definitionId: definition.id,
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
              provenance: def.provenance,
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
            provenance: def.provenance,
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
  provenance: string
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
  provenance: string
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
  provenance: string
  sourceUrl: string | null
  config: unknown
}): RaceEvolutionPath | null {
  const config = parseCatalogConfig("evolutions", row.config ?? {})
  if (!isValidRaceEvolutionConfig(config)) return null
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    provenance: row.provenance,
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
  provenance: string
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
  provenance: string
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
    provenance: row.provenance,
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
async function collectValidRacePathsForTarget(
  db: DbClient,
  currentRaceStableId: string | null,
  currentGrade: Grade,
  targetGrade: Grade
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
  const targetGrade = nextGrade(currentGrade)

  const valid =
    targetGrade == null
      ? []
      : await collectValidRacePathsForTarget(
          prisma,
          currentRaceStableId,
          currentGrade,
          targetGrade
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
      provenance: path.provenance,
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
      provenance: path.provenance,
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
  return prisma.$transaction(async (tx) => {
    const row = await assertOwner(tx, id, user)
    const houseRules = await loadHouseRules(tx)
    const state = deserializeState(row.state)
    const currentGrade = state.race.grade
    const currentRaceStableId = row.race?.stableId ?? null

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
      const valid = await collectValidRacePathsForTarget(
        tx,
        currentRaceStableId,
        currentGrade,
        targetGrade
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
    const destConfigParsed = parseCatalogConfig("races", destRace.config ?? {})
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
  })
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

        // The engine never guesses provenance from the grade: origin is always
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
          provenance: definition.provenance,
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
    include: { inventory: { include: { definition: true } } },
  })
  if (!row) throw notFound("character_not_found", "Character not found")
  if (!user.isAdmin && row.ownerId !== user.id) {
    throw forbidden("forbidden", "You do not own this character")
  }
  return {
    inventory: row.inventory.map(inventoryView),
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
                provenance: definition.provenance,
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
          inventory: updated.inventory.map(inventoryView),
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

/** Decode the equipment slot from a catalog definition's parsed config. */
function definitionSlot(def: {
  kind: string
  config?: unknown
}): string | undefined {
  const slot = parseCatalogConfig(def.kind, def.config ?? {}).slot
  return typeof slot === "string" && slot.length > 0 ? slot : undefined
}

/** Decode the title upgrade group from a catalog definition's parsed config. */
function definitionUpgradeGroup(def: {
  kind: string
  config?: unknown
}): string | undefined {
  const group = parseCatalogConfig(def.kind, def.config ?? {}).upgradeGroup
  return typeof group === "string" && group.length > 0 ? group : undefined
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
 * - **bloodline**: bloodlines coexist. An add with NO `upgradeGroup` appends
 *   without displacing anything; an add that DOES declare an `upgradeGroup`
 *   atomically replaces every existing bloodline link sharing that group. The
 *   group is only an add/select replacement group - never an effect stacking
 *   group.
 * - **transcendent**: transcendent skills coexist freely. There is no blessing
 *   singleton and no `upgradeGroup` replacement, so an add simply appends a new
 *   distinct skill link and a remove detaches only the named link.
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
  },
  user: SessionUser
): Promise<{ character: CharacterDetail }> {
  return prisma
    .$transaction(
      async (tx) => {
        const row = await assertOwner(tx, id, user)
        const houseRules = await loadHouseRules(tx)

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

          // Equipment add replaces whatever currently occupies the SAME slot.
          // Remove every such link atomically - never leave a second effective
          // item in a slot.
          if (body.kind === "equipment") {
            const slot = config.slot as string | undefined
            if (slot) {
              const sameSlotLinks = existing.filter(
                (l) =>
                  l.kind === "EQUIPMENT" &&
                  definitionSlot(l.definition) === slot
              )
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

          // Bloodlines coexist: a new bloodline with NO upgradeGroup is added
          // without displacing anything. One that DOES declare an upgradeGroup
          // atomically replaces every existing bloodline link sharing that group
          // (the group is only an add/select replacement group, never an effect
          // stacking group).
          if (body.kind === "bloodline") {
            const upgradeGroup = config.upgradeGroup as string | undefined
            if (upgradeGroup) {
              const sameGroupLinks = existing.filter(
                (l) =>
                  l.kind === "BLOODLINE" &&
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
        await tx.progressionEvent.create({
          data: {
            characterId: id,
            kind: "associate",
            payload: {
              operation: body.operation,
              kind: body.kind,
              definitionId: definition.id,
              definition: {
                id: definition.id,
                name: definition.name,
                kind: definition.kind,
                stableId: definition.stableId,
                grade: definition.grade,
                provenance: definition.provenance,
                ...(body.kind === "equipment"
                  ? {
                      slot: (config.slot as string | undefined) ?? null,
                    }
                  : {}),
                ...(body.kind === "title" || body.kind === "bloodline"
                  ? {
                      upgradeGroup:
                        (config.upgradeGroup as string | undefined) ?? null,
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
    // Only equipment links carry the grandfathered marker; non-equipment links
    // never export the flag (they cannot be grandfathered).
    ...(a.kind === "EQUIPMENT" ? { legacyUnowned: a.legacyUnowned } : {}),
    definition: {
      id: a.definition.id,
      name: a.definition.name,
      kind: a.definition.kind,
      config: (a.definition.config ?? {}) as Record<string, unknown>,
      provenance: a.definition.provenance,
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
    schema: IMPORT_SCHEMA_V4,
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
  provenance: string
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
    { schema: typeof IMPORT_SCHEMA_V4 }
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

async function resolveAssociationRefs(
  db: DbClient,
  assocs: CharacterImportDocument["associations"],
  opts: ResolveAssocOpts
): Promise<ResolvedAssoc[]> {
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

    let legacyUnowned: boolean
    if (a.kind === "equipment") {
      // v3 backups have no inventory model and no marker: a grandfathered link may
      // stay equipped regardless of stock. v4 carries the exported marker verbatim;
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
 */
function assertAssocCollisions(resolved: ResolvedAssoc[]): void {
  const slots = new Map<string, string>()
  const titleGroups = new Map<string, string>()
  const skillGroups = new Map<string, string>()
  const bloodlineGroups = new Map<string, string>()
  let activeBlessingName: string | null = null
  for (const r of resolved) {
    if (r.definition.archived) continue
    const config = parseCatalogConfig(
      r.definition.kind,
      r.definition.config ?? {}
    )
    if (r.sourceKind === "equipment") {
      const slot = slotForConfig(config)
      if (slot) {
        const existing = slots.get(slot)
        if (existing) {
          throw badRequest(
            "import_link_collision",
            `Equipment slot "${slot}" is occupied by both "${existing}" and "${r.definition.name}"`
          )
        }
        slots.set(slot, r.definition.name)
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
    } else if (r.sourceKind === "blessing") {
      if (activeBlessingName != null) {
        throw badRequest(
          "import_link_collision",
          `More than one active blessing: "${activeBlessingName}" and "${r.definition.name}"`
        )
      }
      activeBlessingName = r.definition.name
    } else if (r.sourceKind === "bloodline") {
      const group = upgradeGroupForConfig(config)
      if (group) {
        const existing = bloodlineGroups.get(group)
        if (existing) {
          throw badRequest(
            "import_link_collision",
            `Bloodline upgrade group "${group}" is occupied by both "${existing}" and "${r.definition.name}"`
          )
        }
        bloodlineGroups.set(group, r.definition.name)
      }
    }
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
  classRow: CatalogLookupRow,
  profRow: CatalogLookupRow | null
): CharacterState {
  const grade = state.race.grade
  // Normalize the race part first so the track definitions below are resolved
  // against the same state (and grade) the advance flow will use; the grade is
  // unchanged by normalization but the resolution must be identical.
  const raceState: CharacterState["race"] = {
    ...state.race,
    origin: identity.origin,
  }
  const resolvedState: CharacterState = { ...state, race: raceState }

  const tracks: CharacterState["tracks"] = { ...state.tracks }
  if (tracks["class"]) {
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
  config: RulesConfig
): void {
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
  return prisma.$transaction(async (tx) => {
    const houseRules = await loadHouseRules(tx)
    const race = await resolveIdentityRef(
      tx,
      "races",
      input.identity.race.stableId,
      "race"
    )
    const cls = await resolveIdentityRef(
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
    // backup whose state.race.origin disagrees with identity.origin.
    assertImportState(rawState, input.identity, config)
    const state = normalizeImportedState(
      rawState,
      input.identity,
      race,
      cls,
      prof
    )

    // A v3 doc has no inventory model; a v4 doc carries owned stock (which is
    // validated and resolved before any DB write). The resolved stock map is what
    // the association resolver consults to enforce the ownership invariant on
    // non-grandfathered equipment links.
    const isV4 = input.schema === IMPORT_SCHEMA_V4
    let resolvedInventory: ResolvedInventoryItem[] = []
    let ownedStockByDefId = new Map<string, number>()
    if (isV4) {
      resolvedInventory = await resolveInventoryRefs(tx, input.inventory)
      ownedStockByDefId = new Map(
        resolvedInventory.map((i) => [i.definitionId, i.quantity])
      )
    }

    const resolvedAssocs = await resolveAssociationRefs(
      tx,
      input.associations,
      {
        enforceOwnership: isV4,
        ownedStockByDefId,
      }
    )
    assertAssocCollisions(resolvedAssocs)
    const resolvedOffers = await resolveSkillOfferRefs(tx, input.skillOffers)

    const serialized = serializeState(state)
    const created = await tx.character.create({
      data: {
        ownerId: user.id,
        name: input.identity.name,
        description: input.identity.description ?? null,
        origin: input.identity.origin,
        raceId: race.id,
        classId: cls.id,
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
          classStableId: cls.stableId,
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
  })
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
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  )
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

function catalogItem(row: {
  id: string
  kind: string
  stableId: string
  name: string
  description: string | null
  grade: string | null
  provenance: "verified" | "inferred" | "house"
  sourceUrl: string | null
  archived: boolean
  config: unknown
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
    provenance: row.provenance,
    sourceUrl: row.sourceUrl,
    archived: row.archived,
    config: (row.config ?? {}) as Record<string, unknown>,
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
    provenance?: "verified" | "inferred" | "house"
    sourceUrl?: string | null
    archived?: boolean
    config?: Record<string, unknown>
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
          provenance: input.provenance ?? "house",
          sourceUrl: input.sourceUrl ?? null,
          archived: input.archived ?? false,
          config: config as Prisma.InputJsonValue,
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
    for (const other of character.associations ?? []) {
      if (other.definitionId === definitionId) continue
      if (other.kind !== expectedAssocKind) continue
      const def = other.definition
      if (!def || def.archived) continue
      const otherConfig = parseCatalogConfig(def.kind, def.config ?? {})
      const otherValue =
        kind === "equipment"
          ? slotForConfig(otherConfig)
          : upgradeGroupForConfig(otherConfig)
      if (otherValue === value) {
        throw conflict(
          "link_collision",
          `Catalog edit would put "${character.name}" in conflict: "${def.name}" already occupies the same ${kind === "equipment" ? "slot" : "upgrade group"}`
        )
      }
    }
  }
}

function slotForConfig(config: Record<string, unknown>): string | undefined {
  const slot = config.slot
  return typeof slot === "string" && slot.length > 0 ? slot : undefined
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
    provenance?: "verified" | "inferred" | "house"
    sourceUrl?: string | null
    archived?: boolean
    config?: Record<string, unknown>
  }
): Promise<CatalogItem> {
  // A god stableId change and every blessing / bloodline config change read the
  // existing row and then write it, so they run under SERIALIZABLE isolation:
  // two concurrent edits that race on the same catalog row cannot both commit,
  // and the loser surfaces as P2034 which we map to a 409.
  const serializable =
    kind === "gods" || kind === "blessings" || kind === "bloodlines"
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
      }
      const finalConfig =
        config ?? parseCatalogConfig(kind, existing.config ?? {})
      const finalArchived =
        patch.archived != null ? patch.archived : existing.archived
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
      await assertNoLinkCollision(tx, kind, id, finalConfig, finalArchived)
      const row = await tx.catalogDefinition.update({
        where: { id },
        data: {
          ...(patch.stableId != null ? { stableId: patch.stableId } : {}),
          ...(patch.name != null ? { name: patch.name } : {}),
          ...(patch.description != null
            ? { description: patch.description }
            : {}),
          ...(patch.grade != null ? { grade: patch.grade } : {}),
          ...(patch.provenance != null ? { provenance: patch.provenance } : {}),
          ...(patch.sourceUrl != null ? { sourceUrl: patch.sourceUrl } : {}),
          ...(patch.archived != null ? { archived: patch.archived } : {}),
          ...(config != null
            ? { config: config as Prisma.InputJsonValue }
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
