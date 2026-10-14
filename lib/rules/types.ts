/**
 * Shared domain types, constants, and vector helpers for the deterministic
 * progression/stat rules engine.
 *
 * The engine is a pure TypeScript module. It never imports React or Prisma and
 * never executes JS against external state. Every number that is not sourced is
 * a documented house assumption and is carried in output provenance as
 * "assumption" (see docs/rules/assumptions.md).
 */

/* ------------------------------------------------------------------ *
 * Attribute set
 * ------------------------------------------------------------------ */

/**
 * The nine canonical attribute keys used by the engine.
 *
 * These are the user-specified canonical set (house rule), matching the
 * wiki-inferred attribute names recorded in `docs/rules/attributes.md`:
 * Strength, Agility, Endurance, Vitality, Toughness, Wisdom, Intelligence,
 * Perception, Willpower. The wiki also shows "Spirit" in at least one profession
 * line, but it is deliberately **excluded** from the canonical nine (no canonical
 * spirit). Order is the tie-break order for deterministic apportionment.
 */
export const ATTRIBUTES = [
  "strength",
  "agility",
  "endurance",
  "vitality",
  "toughness",
  "wisdom",
  "intelligence",
  "perception",
  "willpower",
] as const

export type Attribute = (typeof ATTRIBUTES)[number]

/** A full vector of attribute values, one entry per canonical attribute. */
export type AttributeVector = Record<Attribute, number>

/** A sparse attribute patch; unspecified keys default to zero. */
export type PartialVector = Partial<Record<Attribute, number>>

export function hasAllKeys(partial: PartialVector): partial is AttributeVector {
  return ATTRIBUTES.every((attr) => typeof partial[attr] === "number")
}

export function zeroVector(): AttributeVector {
  const out = {} as AttributeVector
  for (const attr of ATTRIBUTES) out[attr] = 0
  return out
}

export function makeVector(partial: PartialVector): AttributeVector {
  const out = zeroVector()
  for (const attr of ATTRIBUTES) {
    const v = partial[attr]
    if (typeof v === "number" && Number.isFinite(v)) out[attr] = v
  }
  return out
}

export function addVectors(
  a: AttributeVector,
  b: PartialVector
): AttributeVector {
  const out = { ...a }
  for (const attr of ATTRIBUTES) {
    const bv = b[attr]
    if (typeof bv === "number" && Number.isFinite(bv)) out[attr] += bv
  }
  return out
}

export function scaleVector(a: AttributeVector, f: number): AttributeVector {
  const out = zeroVector()
  for (const attr of ATTRIBUTES) out[attr] = a[attr] * f
  return out
}

export function floorVector(a: AttributeVector): AttributeVector {
  const out = zeroVector()
  for (const attr of ATTRIBUTES) out[attr] = Math.floor(a[attr])
  return out
}

export function subVectors(
  a: AttributeVector,
  b: AttributeVector
): AttributeVector {
  const out = zeroVector()
  for (const attr of ATTRIBUTES) out[attr] = a[attr] - b[attr]
  return out
}

export function vectorSum(a: AttributeVector): number {
  let s = 0
  for (const attr of ATTRIBUTES) s += a[attr]
  return s
}

/* ------------------------------------------------------------------ *
 * Grades
 * ------------------------------------------------------------------ */

/**
 * The grade ladder, ordered low -> high. The overlap between G (0-9) and
 * F (0-24) is intentional in the source: G-grade is assigned to newly
 * integrated races and F-grade to anyone born into the system. The engine
 * resolves the overlap by provenance (the starting grade is tracked state, not
 * derived from level).
 */
export const GRADE_ORDER = ["G", "F", "E", "D", "C", "B", "A", "S"] as const
export type Grade = (typeof GRADE_ORDER)[number]

export interface GradeBand {
  grade: Grade
  /** Inclusive lower bound of the published level band. */
  min: number
  /** Inclusive upper bound of the published level band. */
  max: number
  /**
   * Minimum level required to evolve INTO this grade. This is a house rule
   * needed because the G/F band overlap means the starting grade is provenance
   * driven, not level driven. The source states a newly integrated race
   * auto-advances to F-grade at level 10, so F's entry level is 10 (G origin).
   */
  entryLevel: number
}

export const DEFAULT_GRADE_TABLE: GradeBand[] = [
  { grade: "G", min: 0, max: 9, entryLevel: 0 },
  { grade: "F", min: 0, max: 24, entryLevel: 10 },
  { grade: "E", min: 25, max: 99, entryLevel: 25 },
  { grade: "D", min: 100, max: 199, entryLevel: 100 },
  { grade: "C", min: 200, max: 349, entryLevel: 200 },
  { grade: "B", min: 350, max: 499, entryLevel: 350 },
  { grade: "A", min: 500, max: 749, entryLevel: 500 },
  { grade: "S", min: 750, max: 999, entryLevel: 750 },
]

export function gradeOrderIndex(grade: Grade): number {
  return GRADE_ORDER.indexOf(grade)
}

export function nextGrade(grade: Grade): Grade | null {
  const i = GRADE_ORDER.indexOf(grade)
  if (i < 0 || i === GRADE_ORDER.length - 1) return null
  return GRADE_ORDER[i + 1]
}

export function previousGrade(grade: Grade): Grade | null {
  const i = GRADE_ORDER.indexOf(grade)
  if (i <= 0) return null
  return GRADE_ORDER[i - 1]
}

/**
 * The highest grade a character is eligible to evolve to based on their level.
 * A grade qualifies only if the level falls inside its published band AND the
 * level has reached the band's entry level. The overlap between G and F is
 * resolved by entry level, so a G-origin character is not eligible for F until
 * level 10 (the source-verified auto-advance boundary).
 */
export function gradeForLevel(
  level: number,
  table: GradeBand[] = DEFAULT_GRADE_TABLE
): Grade | null {
  let best: Grade | null = null
  for (const band of table) {
    if (level >= band.min && level <= band.max && level >= band.entryLevel) {
      // table is ordered low -> high, so keep the last qualifying band.
      best = band.grade
    }
  }
  return best
}

export function bandForGrade(
  grade: Grade,
  table: GradeBand[] = DEFAULT_GRADE_TABLE
): GradeBand | undefined {
  return table.find((b) => b.grade === grade)
}

/* ------------------------------------------------------------------ *
 * Tracks (class / profession) and race
 * ------------------------------------------------------------------ */

export type TrackId = string

export interface TrackState {
  level: number
  /** Quarter index within the level: 0 = 0%, 1 = 25%, 2 = 50%, 3 = 75%. */
  quarter: number
  definitionId: string
  /**
   * Optional explicit class/profession grade state. When present the track is
   * "graded": its level-up is independently capped at the entry level of the NEXT
   * grade (it may reach exactly that threshold but may not pass it) until the
   * caller explicitly evolves the track grade via `evolveTrackGrade`. This is
   * separate from the derived race grade, so a class/profession may evolve ahead
   * of the race when the race level is below its own boundary. Absent on legacy
   * states; the engine never infers a grade for a missing field.
   */
  grade?: Grade
}

export type RaceMode = "derived" | "independent"

/** How a race advances: whether it is a human-like track race or a monster. */
export type RaceType = "enlightened" | "monster"

export interface RaceState {
  level: number
  grade: Grade
  mode: RaceMode
  definitionId?: string
  /**
   * Quarter index within the current race level (0 = 0%, 1 = 25%, 2 = 50%,
   * 3 = 75%). Present on monsters (independent race mode) that advance on a
   * four-quarter cadence via `advanceRaceQuarter`; absent on legacy states, in
   * which case the engine treats it as 0. Enlightened (derived) races never
   * use it - their race level is derived from the class/profession tracks.
   */
  quarter?: number
  /**
   * Provenance of the starting grade, recorded at character creation: `born`
   * races enter at F-grade, `integrated` races at G-grade. Used to resolve the
   * G/F overlapping band when applying the permanent consumable cap (a born
   * race counts levels 1..9 at the F rate, not the G rate). Optional for
   * backward compatibility with states created before this was tracked; when
   * absent the engine defaults conservatively to `integrated` (never infers
   * `born` from a non-G grade), and the DB service reconstructs the
   * authoritative value from `Character.origin` on reads and before application.
   */
  origin?: "born" | "integrated"
}

export type RaceDerivationStrategy = "floorHalfAvg" | "maxOf" | "sum" | "none"

/* ------------------------------------------------------------------ *
 * Ledgers and awards
 * ------------------------------------------------------------------ */

/** A historical level award, snapshotted at the moment of level-up. */
export interface LevelAward {
  track: TrackId
  level: number
  definitionId: string
  /** Snapshot of the fixed attribute vector granted at this level-up. */
  fixed: AttributeVector
  /** Free (unspent) points granted, which carry forward. */
  free: number
}

/** A single allocation entry in the allocations ledger. */
export interface AllocationEntry {
  id: string
  source: string
  /** Sequence/order marker used for deterministic ordering. */
  at: number
  points: AttributeVector
}

/** What a permanent gain modifies, used for race-level cap accounting. */
export type PermanentKind = "raceLevel" | "buff" | "consumable"

export interface PermanentGain {
  id: string
  source: string
  kind: PermanentKind
  /** Grade band this gain is attributed to (for cumulative race-level caps). */
  grade?: Grade
  /** Number of race levels this gain represents (for cumulative caps). */
  count?: number
  /**
   * Applied attribute vector. For `consumable` gains this is the accepted amount
   * (immutable once recorded); it is only ever less than `requested` when a cap
   * enforces rejection in whole, and accepted entries therefore always equal it.
   */
  vector: PartialVector
  /**
   * Requested attribute vector at the moment of application. Present (strictly)
   * on new `consumable` entries so the pre-cap request is preserved as history;
   * optional for backward compatibility with existing `raceLevel`/`buff` entries.
   */
  requested?: PartialVector
  /** The character's grade when this gain was applied (consumable provenance). */
  gradeAtApplication?: Grade
  /** The character's race level when this gain was applied (consumable cap). */
  raceLevelAtApplication?: number
  /**
   * Vector of remaining permanent-consumable capacity after this gain was
   * applied, snapshotted so later config changes never re-cap historical facts.
   */
  capRemainingAfter?: PartialVector
  /** ISO date string or numeric timestamp at which the gain was applied. */
  appliedAt?: string | number
}

export interface EquipmentBonus {
  id: string
  name: string
  slot: string
  source: string
  bonus: PartialVector
}

export type ResourceId = string

/* ------------------------------------------------------------------ *
 * Effects
 * ------------------------------------------------------------------ */

export type EffectCondition =
  | { kind: "always" }
  | { kind: "levelAtLeast"; track: TrackId; level: number }
  | { kind: "gradeAtLeast"; grade: Grade }

export type EffectPhase = "flat" | "percent" | "temporary"
export type EffectStacking = "replace" | "stack" | "stackCapped"

interface EffectBase {
  id: string
  source: string
  provenance: string
  condition?: EffectCondition
  /** Sequence number at which this effect expires; if set and <= current turn, expired. */
  expiresAt?: number
  /** Stacking / replacement group. */
  group?: string
  stacking: EffectStacking
}

export type GameEffect =
  | (EffectBase & { phase: "flat"; amount: PartialVector })
  | (EffectBase & { phase: "percent"; basisPoints: PartialVector })
  | (EffectBase & { phase: "temporary"; amount: PartialVector })

/* ------------------------------------------------------------------ *
 * Character state
 * ------------------------------------------------------------------ */

export interface CharacterState {
  baseAttributes: AttributeVector
  tracks: Record<TrackId, TrackState>
  race: RaceState
  historicalLevelAwards: LevelAward[]
  allocations: AllocationEntry[]
  permanentGains: PermanentGain[]
  activeEffects: GameEffect[]
  equipment: EquipmentBonus[]
  currentResources: Record<ResourceId, number>
  /**
   * Monotonic turn/sequence counter, incremented by advanceQuarter. Used for
   * effect expiry and ledger ordering.
   */
  turn: number
}

/* ------------------------------------------------------------------ *
 * Rules config
 * ------------------------------------------------------------------ */

export interface RulesConfig {
  /** Grade band table (ordered low -> high). Defaults to DEFAULT_GRADE_TABLE. */
  gradeTable: GradeBand[]

  /** How the derived race level is computed from class/profession levels. */
  raceDerivationStrategy: RaceDerivationStrategy

  /**
   * Whether a grade's definition is available (gate open). `undefined` is
   * treated as open (available). Set a grade to `false` to model an evolution
   * gate that blocks progression beyond that grade.
   */
  gradeGates: Partial<Record<Grade, boolean>>

  /**
   * Per-attribute aggregate equipment cap, expressed as a percentage of the
   * pre-equipment value of that single attribute. This bounds the SUM of all
   * equipment bonuses applied to one attribute (not a per-item cap). Assumption,
   * default 20.
   */
  equipmentIndividualCapPercent: number

  /**
   * Overall equipment cap, expressed as a percentage of the SUM of all
   * pre-equipment attribute values. This bounds the SUM of all effective
   * equipment bonuses across every attribute (not a per-attribute cap).
   * Assumption, default 15.
   */
  equipmentCombinedCapPercent: number

  /**
   * Permanent consumable cumulative grade rates (assumption F3 / E5 / D15 / C45).
   * These are PER-LEVEL rates on permanent external stat gains acquired from
   * consumables, summed cumulatively across every race level attained through the
   * grade bands. They do NOT cap temporary potions (which use only their effect
   * duration). A grade not present in the map falls back to
   * `consumableFallbackRate`; an unknown grade with no rate behaves as rate 0
   * (a positive gain is then rejected against zero capacity).
   */
  consumableGradeRates: Partial<Record<Grade, number>>

  /**
   * Fallback rate for a grade with no configured consumable grade rate. Default 0,
   * so unknown grades (B/A/S and G unless configured) reject positive permanent
   * consumable gains rather than inventing a canonical multiplier.
   */
  consumableFallbackRate: number

  /**
   * Derived resource multipliers, or `null` when no formula/multiplier is known.
   * A resource with no multiplier or no formula yields a `null` max (never a
   * fabricated number).
   */
  resourceMultipliers: Record<ResourceId, number> | null

  /**
   * Optional per-resource linear formulas; unknown formulas yield `null` max.
   */
  resourceFormulas?: Partial<Record<ResourceId, ResourceFormula>>

  /**
   * Per-grade race definitions used to snapshot race gains when a derived race
   * level is gained. A derived race level gain **requires** a definition for the
   * current grade; if it is missing, `advanceQuarter` rejects the gain rather than
   * silently awarding zero. Every grade used by a derived race must be defined.
   */
  raceDefinitions?: Partial<Record<Grade, RaceDefinition>>

  /**
   * Cumulative cap on race levels that were recorded as `raceLevel` entries in
   * the permanent-gains ledger (externally supplied, not derived by the engine).
   * When a grade band has more externally-supplied race-level gains than its cap,
   * the excess is rejected (not applied). Derived race gains are NOT capped here;
   * they are snapshotted directly into `historicalLevelAwards`.
   */
  permanentRaceGradeCaps: Partial<Record<Grade, number>>
}

export interface ResourceFormula {
  coefficients: PartialVector
  constant?: number
}

/**
 * A race's per-grade definition: the per-level fixed attribute vector and the
 * free points granted per level gained within that grade band.
 */
export interface RaceDefinition {
  id: string
  /** Per-level fixed attribute vector granted while in this grade band. */
  perLevel: PartialVector
  /** Free points granted per level gained while in this grade band. */
  freePerLevel: number
}

/** A provided definition describing what a track level-up grants. */
export interface TrackDefinition {
  id: string
  name: string
  /** Snapshot of the fixed attribute vector granted at level-up. */
  fixed: PartialVector
  /** Free (unspent) points granted, which carry forward. */
  free: number
  /** Optional overall grade this definition belongs to (for provenance). */
  grade?: Grade
}

/* ------------------------------------------------------------------ *
 * Result types
 * ------------------------------------------------------------------ */

export interface PhaseTrace {
  phase: string
  /** Cumulative value at the end of the phase for the attribute. */
  value: number
  /** Delta introduced by this phase (may be negative). */
  delta: number
}

export interface AttributeTrace {
  attribute: Attribute
  phases: PhaseTrace[]
  final: number
}

export interface CapUsage {
  name: string
  /** Attribute the cap constrains (null for a global/total cap). */
  attribute: Attribute | null
  cap: number | null
  requested: number
  applied: number
  suppressed: number
}

export interface EquipmentItemStatus {
  id: string
  name: string
  requested: AttributeVector
  applied: AttributeVector
  suppressed: AttributeVector
  reasons: string[]
}

export interface EquipmentStatus {
  requested: AttributeVector
  applied: AttributeVector
  suppressed: AttributeVector
  items: EquipmentItemStatus[]
  capUsage: CapUsage[]
}

export interface ResourceStatus {
  id: ResourceId
  current: number
  /** Maximum; `null` when the formula or multiplier is unknown. */
  max: number | null
  multiplier: number | null
  provenance: string
}

export interface StatusResult {
  attributes: AttributeVector
  traces: AttributeTrace[]
  availablePoints: number
  totalFreePoints: number
  allocatedPoints: number
  resources: ResourceStatus[]
  equipment: EquipmentStatus
  consumables: ConsumableStatus
  capUsage: CapUsage[]
}

export interface ConsumableStatus {
  requested: AttributeVector
  applied: AttributeVector
  suppressed: AttributeVector
  capUsage: CapUsage[]
}

/* ------------------------------------------------------------------ *
 * Default builders
 * ------------------------------------------------------------------ */

export function defaultRulesConfig(): RulesConfig {
  return {
    gradeTable: DEFAULT_GRADE_TABLE,
    raceDerivationStrategy: "floorHalfAvg",
    gradeGates: {},
    equipmentIndividualCapPercent: 20,
    equipmentCombinedCapPercent: 15,
    consumableGradeRates: { F: 3, E: 5, D: 15, C: 45 },
    consumableFallbackRate: 0,
    resourceMultipliers: null,
    resourceFormulas: {},
    permanentRaceGradeCaps: {},
  }
}

/**
 * Build a minimal CharacterState with sane defaults, overriding any provided
 * fields. Useful for tests and for callers that do not want to fill every
 * ledger by hand.
 */
export function createCharacterState(
  overrides: Partial<CharacterState> & {
    baseAttributes: AttributeVector
    tracks: Record<TrackId, TrackState>
    race: RaceState
  }
): CharacterState {
  const out: CharacterState = {
    baseAttributes: overrides.baseAttributes,
    tracks: overrides.tracks,
    race: overrides.race,
    historicalLevelAwards: [],
    allocations: [],
    permanentGains: [],
    activeEffects: [],
    equipment: [],
    currentResources: {},
    turn: 0,
  }
  if (overrides.historicalLevelAwards)
    out.historicalLevelAwards = overrides.historicalLevelAwards
  if (overrides.allocations) out.allocations = overrides.allocations
  if (overrides.permanentGains) out.permanentGains = overrides.permanentGains
  if (overrides.activeEffects) out.activeEffects = overrides.activeEffects
  if (overrides.equipment) out.equipment = overrides.equipment
  if (overrides.currentResources)
    out.currentResources = overrides.currentResources
  if (typeof overrides.turn === "number") out.turn = overrides.turn
  return out
}
