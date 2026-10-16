/**
 * Typed client-side API helper for the primal-creator UI.
 *
 * Every server route returns either the documented JSON shape or a uniform
 * `{ error: { code, message } }` body (see lib/server/errors.ts). This module
 * centralizes that contract so components never have to hand-parse errors.
 *
 * It is intentionally free of Next.js internals: it is fetch-based, works in the
 * browser, and is used only by client components.
 */

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
  }
}

export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)

  if (!res.ok) {
    let code = "http_error"
    let message = res.statusText || "Request failed"
    try {
      const data = (await res.json()) as {
        error?: { code?: string; message?: string }
      }
      if (data?.error?.code) code = data.error.code
      if (data?.error?.message) message = data.error.message
    } catch {
      // Not JSON; keep statusText.
    }
    throw new ApiError(res.status, code, message)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** Build a JSON request init with the given method and body (if any). */
export function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }
}

// ------------------------------------------------------------------ //
// Auth
// ------------------------------------------------------------------ //

export interface SessionUser {
  id: string
  email: string
  isAdmin: boolean
}

export interface MeResponse {
  user: SessionUser
}

export interface LoginResponse {
  user: SessionUser
}

/** A user as returned by the admin user routes. Never includes the password hash. */
export interface AdminUser {
  id: string
  email: string
  isAdmin: boolean
  disabled: boolean
  createdAt: string
  updatedAt: string
}

export interface AdminUsersResponse {
  users: AdminUser[]
}

export interface AdminUserResponse {
  user: AdminUser
}

export interface AdminUserCreateRequest {
  email: string
  password: string
  isAdmin?: boolean
}

export interface AdminUserPatchRequest {
  isAdmin?: boolean
  disabled?: boolean
  password?: string
}

export interface PasswordChangeRequest {
  currentPassword: string
  newPassword: string
}

export interface PasswordChangeResponse {
  user: SessionUser
}

// ------------------------------------------------------------------ //
// House rules (admin-only)
// ------------------------------------------------------------------ //

/**
 * The validated, server-wide house-rules config. EXACT shape - the admin Settings
 * form edits exactly these fields; anything else is rejected.
 */
export interface AdminHouseRulesConfig {
  equipmentIndividualCapPercent: number
  equipmentCombinedCapPercent: number
  consumableGradeRates: {
    F: number
    E: number
    D: number
    C: number
  }
  /**
   * The maximum number of transcendent skills a single character may carry,
   * configured by an admin (default 3, bounded 0..8). Enforced at create, on
   * association add, and on backup import - not just in the UI.
   */
  maxTranscendentSkills: number
  /**
   * The configurable number of levels between skill-choice CREDITS, per grade
   * (default G:5, F:5, E:5, D:20, C:30, B:40, A:50, S:60). G earns credits on
   * the same cadence as F but is capped by the F band (see
   * `isSkillChoiceMilestone`). Each value is an integer 1..250.
   */
  skillChoiceIntervals: {
    G: number
    F: number
    E: number
    D: number
    C: number
    B: number
    A: number
    S: number
  }
}

/** GET /api/admin/rules - current validated house rules plus the CAS version. */
export interface AdminHouseRulesResponse {
  version: number
  config: AdminHouseRulesConfig
  updatedAt: string
}

/** PATCH /api/admin/rules - full-shape optimistic-concurrency update. */
export interface HouseRulesPatchRequest {
  version: number
  config: AdminHouseRulesConfig
}

// ------------------------------------------------------------------ //
// Catalog
// ------------------------------------------------------------------ //

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

export interface CatalogListResponse {
  kind: string
  items: CatalogItem[]
}

// ------------------------------------------------------------------ //
// Character status (mirrors lib/rules/types.ts StatusResult)
// ------------------------------------------------------------------ //

export const ATTRIBUTE_KEYS = [
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

export type AttributeKey = (typeof ATTRIBUTE_KEYS)[number]

export type AttributeVector = Record<AttributeKey, number>

/** A sparse attribute patch; unspecified keys default to zero. */
export type PartialVector = Partial<Record<AttributeKey, number>>

export interface PhaseTrace {
  phase: string
  value: number
  delta: number
}

export interface AttributeTrace {
  attribute: string
  phases: PhaseTrace[]
  final: number
}

export interface CapUsage {
  name: string
  attribute: string | null
  cap: number | null
  requested: number
  applied: number
  suppressed: number
}

export interface ResourceStatus {
  id: string
  current: number
  max: number | null
  multiplier: number | null
  provenance: string
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

export interface ConsumableStatus {
  requested: AttributeVector
  applied: AttributeVector
  suppressed: AttributeVector
  capUsage: CapUsage[]
}

/** The three core derived resource pools (HP / MP / SP). Mirrors lib/rules/types.ts. */
export type DerivedResource = "hp" | "mp" | "sp"

/**
 * Per-resource breakdown of an authoritative derived HP/MP/SP maximum. Mirrors
 * lib/rules/types.ts; exposed so a consumer can distinguish the attribute-derived
 * base from the flat and percentage equipment contributions.
 */
export interface DerivedStatBreakdown {
  /** The attribute that drives this resource's base value. */
  attribute: AttributeKey
  /** Base value: finalAttributes[attribute] * 10 (may be negative). */
  base: number
  /** Sum of equipment `derivedFlat` contributions for this resource. */
  flat: number
  /** Sum of equipment `derivedPercentBasisPoints` contributions. */
  percentBasisPoints: number
  /** Floored percentage of the positive (base + flat) (0 when base + flat <= 0). */
  percentApplied: number
  /** Clamped final maximum. */
  max: number
}

/**
 * Authoritative maxima for the three core derived resource pools, always present
 * and never `null`. Derived from the FINAL attributes after every phase,
 * independent of the equipment cap budgets. Mirrors lib/rules/types.ts.
 */
export interface DerivedStats {
  hp: number
  mp: number
  sp: number
  /**
   * Optional per-resource breakdown, useful for provenance and tests. Always
   * computed by the engine; optional only so the type degrades to the literal
   * `{ hp; mp; sp }` shape for consumers that do not need it.
   */
  breakdown?: Record<DerivedResource, DerivedStatBreakdown>
}

/**
 * Source of the historical fixed attribute points, split per track
 * (race / class / profession). Mirrors lib/rules/types.ts. Each vector is the
 * SUM of the `fixed` vectors from `historicalLevelAwards` attributable to that
 * track: known track literals (`"race"` / `"class"` / `"profession"`) map
 * directly, while genuinely unknown legacy track strings are split evenly among
 * the applicable tracks in deterministic Race, Class, Profession order. The
 * three vectors sum, per attribute, exactly to the `historical-fixed` trace
 * delta.
 */
export interface HistoricalFixedByTrack {
  race: AttributeVector
  class: AttributeVector
  profession: AttributeVector
}

export interface StatusResult {
  attributes: AttributeVector
  traces: AttributeTrace[]
  availablePoints: number
  totalFreePoints: number
  allocatedPoints: number
  resources: ResourceStatus[]
  derivedStats: DerivedStats
  equipment: EquipmentStatus
  consumables: ConsumableStatus
  capUsage: CapUsage[]
  /** Historical fixed award points, sourced per track. See {@link HistoricalFixedByTrack}. */
  historicalFixedByTrack: HistoricalFixedByTrack
}

// ------------------------------------------------------------------ //
// Characters
// ------------------------------------------------------------------ //

/** Race grade ladder, from lowest to highest. Mirrors lib/rules/types.ts. */
export type Grade = "G" | "F" | "E" | "D" | "C" | "B" | "A" | "S"

export interface TrackState {
  level: number
  quarter: number
  definitionId: string
  /** Optional explicit class/profession grade state; absent on legacy states. */
  grade?: Grade
}

export interface RaceState {
  level: number
  grade: Grade
  mode: string
  definitionId?: string
  /**
   * Quarter index within the current race level (0 = 0%, 1 = 25%, 2 = 50%,
   * 3 = 75%). Present on monsters (independent race mode) that advance on a
   * four-quarter cadence; absent on legacy states and enlightened races.
   */
  quarter?: number
  origin?: "integrated" | "born"
}

export interface CharacterState {
  baseAttributes: AttributeVector
  tracks: Record<string, TrackState>
  race: RaceState
  historicalLevelAwards: unknown[]
  allocations: unknown[]
  permanentGains: unknown[]
  activeEffects: unknown[]
  equipment: unknown[]
  currentResources: Record<string, number>
  turn: number
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
  portrait: PortraitView | null
  status?: StatusResult
  /**
   * The version of the server-wide house-rules config this list item was derived
   * from. Present when the singleton house-rules row exists; omitted otherwise.
   */
  rulesetVersion?: number
}

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
  /**
   * The exact blessing tier a blessing link was granted at, present ONLY on a
   * blessing association (a blessing references a `gods` definition). The live
   * effect is synthesized from the god's `blessingEffects[tier]`; never inferred.
   */
  tier?: string
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

export interface SkillOfferOptionView {
  definitionId: string
  nameSnapshot: string
  /** Whether the offered option's catalog definition is currently archived. */
  archived: boolean
  /**
   * Live prose for the offered option, read from the CURRENT catalog definition
   * (never the immutable `nameSnapshot`). The authored grade-specific text at the
   * offer's snapshotted `earnedGrade` is preferred when it is nonempty; otherwise
   * the definition's legacy `description` is used. `null` when the linked
   * definition is missing (no catalog match) or carries no prose at all.
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
  /** Catalog tier grade of the offered definition, when set. */
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
   * Schedule-credit provenance: the grade whose skill-choice interval awarded this
   * offer. Present (with `trackDefinitionStableId`) only on a scheduled/milestone
   * offer; `null` when the offer predates provenance.
   */
  earnedGrade?: string | null
  /**
   * The selected track's catalog stableId captured at the moment the credit was
   * earned. Present (with `earnedGrade`) only on a scheduled/milestone offer;
   * `null` on a legacy offer.
   */
  trackDefinitionStableId?: string | null
  /**
   * Catalog stableId of the character's selected CLASS at the moment the credit
   * was earned, snapshotted at EARNING time for class/profession credits and null
   * for a monster race credit (which has no class). Present (with `earnedGrade`)
   * only on a scheduled/milestone offer; `null` on a legacy offer. Priority-only:
   * it drives deterministic option ordering (skills whose `classStableId` matches
   * sort first), never eligibility.
   */
  classStableIdAtEarn?: string | null
}

/**
 * An owned inventory row. Ownership is per-definition house bookkeeping (no item
 * instances, no capacity/stacking): only the integer `quantity` and the linked
 * definition's identity/metadata are exposed. `kind` is the catalog kind of the
 * linked definition - always `"equipment"` or `"items"`.
 */
export interface CharacterInventoryItem {
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
  /** Whether an equipment definition is soulbound (metadata only; no transfer mechanic). */
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

/** GET /api/characters/[id]/inventory - owned inventory plus the CAS version. */
export interface CharacterInventoryResponse {
  inventory: CharacterInventoryItem[]
  version: number
}

/**
 * Manual inventory bookkeeping plus a distinct stock-only `use` action for owned
 * Items. For `add` / `remove`, `quantity` is bounded 1..999999 (the same bound
 * the migration CHECK enforces) and `sourceNote` is mandatory and at most 500
 * chars, recorded into the `inventory_adjust` journal. Acquisition is manual
 * here. For `use`, `quantity` must be exactly 1 and `sourceNote` is optional and
 * ignored (the service journals the automatic note "Used item"); a use applies no
 * mechanical effect and records an `inventory_use` progression event.
 */
export interface InventoryAdjustRequest {
  operation: "add" | "remove" | "use"
  definitionId: string
  quantity: number
  version: number
  sourceNote?: string
}

/** POST /api/characters/[id]/inventory - refreshed detail plus inventory/version. */
export interface InventoryAdjustResponse {
  character: CharacterDetail
  inventory: CharacterInventoryItem[]
  version: number
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
  state: CharacterState
  version: number
  archived: boolean
  /** True when the character was created from a user-supplied trusted-backup import. */
  imported: boolean
  /**
   * Derived transcendent quality, recomputed server-side from the current
   * unarchived linked `transcendent_skills` definitions. Not a persisted flag.
   */
  isTranscendent: boolean
  createdAt: string
  updatedAt: string
  associations: CharacterAssociationView[]
  /**
   * Owned inventory quantities (equipment + items), including archived
   * catalog stock. Absent = zero owned stock of that definition.
   */
  inventory: CharacterInventoryItem[]
  /** Pending + selected skill offers (milestone choices) for this character. */
  skillOffers: SkillOfferView[]
  status?: StatusResult
  /**
   * Server-computed grade-ceiling blockers for a +Level on each level-able track,
   * keyed by track (`race` | `class` | `profession`). A track is present only when
   * a level-up on it is blocked by the authoritative current grade ceiling; an
   * absent key means a level-up is allowed on that track (or the track is not
   * level-able in the character's current mode). Computed server-side from the same
   * grade table and race derivation as the progression engine - never a second
   * query and never mutated state.
   */
  levelUpBlocked?: Partial<Record<"race" | "class" | "profession", string>>
  /**
   * Server-computed permanent-consumable capacity per attribute. Authoritative -
   * the UI must not recompute this.
   */
  permanentConsumableCap?: PartialVector
  /** Server-computed remaining permanent-consumable capacity per attribute. */
  permanentConsumableRemaining?: PartialVector
  /**
   * The version of the server-wide house-rules config this detail was derived
   * from. Present when the singleton house-rules row exists; omitted otherwise.
   */
  rulesetVersion?: number
}

export interface CharactersResponse {
  characters: CharacterListItem[]
}

export interface CharacterResponse {
  character: CharacterDetail
}

/**
 * Explicit special-ability selections accepted by the final character create
 * (and mirrored by the resumable draft). Every field is optional; an omitted or
 * empty selection grants nothing. `bloodlineIds` / `transcendentSkillIds` are
 * at most 8 unique nonempty ids, and no id may appear in more than one field.
 */
export interface SpecialAbilitiesSelection {
  blessing?: { godId: string; tier: string }
  bloodlineIds?: string[]
  transcendentSkillIds?: string[]
}

/** Request body for POST /api/characters (atomic create + optional draft consume). */
export interface CharacterCreateRequest {
  name: string
  description?: string
  // Character-profile metadata. Optional + nullable: an omitted/null field is
  // persisted as NULL. Bounds mirror the create schema (nickname 200, pronouns
  // 100, ageDescription 4000, appearance 8000, biography 8000, notes 4000).
  nickname?: string | null
  pronouns?: string | null
  ageDescription?: string | null
  appearance?: string | null
  biography?: string | null
  notes?: string | null
  origin: "integrated" | "born"
  raceId: string
  // `classId` is required (a nonempty string) for an enlightened race and must
  // be null for a monster; the authoritative per-raceType rule is enforced by
  // the service layer, which knows the resolved race config.
  classId: string | null
  // `professionId` is optional for an enlightened race and must be null for a
  // monster (see classId: enforcement lives in the service layer).
  professionId?: string | null
  specialAbilities?: SpecialAbilitiesSelection
  draftVersion?: number
}

export interface JournalDelta {
  track: string
  levelBefore: number
  levelAfter: number
  quarterBefore: number
  quarterAfter: number
  leveledUp: boolean
  raceLevelBefore: number
  raceLevelAfter: number
  award?: { definitionId: string; fixed: AttributeVector; free: number }
  raceGain?: {
    grade: string
    levelsGained: number
    fixed: AttributeVector
    free: number
  } | null
  evolutionOffer?: { grade: string; available: boolean } | null
  evolutionBlocked?: string | null
  notes: string[]
  /** Skill offers generated by this level-up, present only if any were created. */
  skillOffers?: Array<{ id: string; choiceGroup: string }>
  /** Ids of the generated skill offers (sugar for the above). */
  skillOfferIds?: string[]
  /** True on a level-up reversal (`operation: "undo"`) journal. */
  undone?: boolean
  /** Ids of the skill offers canceled by an undo (append-only `canceledAt` stamp). */
  canceledOfferIds?: string[]
  /** Id of the immutable `advance` event that this undo reversed. */
  originalEventId?: string
  /** The character CAS version committed after this (undo) event. */
  characterVersionAfter?: number
}

export interface AdvanceResponse {
  character: CharacterDetail
  journal: JournalDelta
}

/**
 * Request body for POST /api/characters/[id]/experience. Discriminated on
 * `operation`: a `set` settles the authoritative EXP percentage of a track
 * (`percent` 0..100, where 100 requests a level-up), while a `levelUp` is an
 * instant level-up from any percentage and carries no `percent`.
 */
export type ExperienceRequest =
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
    }

/** Response body for POST /api/characters/[id]/experience. Mirrors AdvanceResponse. */
export interface ExperienceResponse {
  character: CharacterDetail
  journal: JournalDelta
}

export interface EvolveJournal {
  from: Grade
  to: Grade
  level: number
  /** Present when the evolution came from a catalog race/track definition choice. */
  source?: "catalog" | "track"
  /** The track evolved (present on any evolution; "race" on a race evolution). */
  track?: "race" | "class" | "profession"
  /** Catalog id of the chosen destination definition (present on all evolutions). */
  optionId?: string
  option?: { id: string; name: string; stableId: string }
  /** Old race snapshot for a race evolution. */
  oldRace?: { id: string | null; stableId: string | null; name: string | null }
  /** Destination definition snapshot for the evolution. */
  destination?: { id: string; stableId: string; name: string; grade: Grade }
  /** Engine track-evolution journal fields: old/new track definition ids. */
  oldDefinitionId?: string
  newDefinitionId?: string
  /** Admin narrative reason recorded for the evolution (null when none). */
  reason?: string | null
}

export interface EvolveResponse {
  character: CharacterDetail
  journal: EvolveJournal
}

/** A contextual next-grade evolution option derived from the definitions catalog. */
export interface EvolutionOptionView {
  /**
   * The DESTINATION catalog definition id (a races/classes/professions row). The
   * client submits this id as `optionId` on POST /evolve.
   */
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
  /** Whether all mechanical (hard) requirements are met. */
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

export interface AllocateResponse {
  character: CharacterDetail
  status: StatusResult
}

export interface ConsumeRequest {
  definitionId: string
  version: number
}

export interface ConsumeResponse {
  character: CharacterDetail
  status: StatusResult
  event: { kind: string; payload: unknown }
}

/** POST /api/characters/[id]/profession - set a set-once profession (after creation). */
export interface ProfessionSetRequest {
  professionId: string
  version: number
}

export interface ProfessionSetResponse {
  character: CharacterDetail
}

export interface AssociationRequest {
  kind: "title" | "equipment" | "blessing" | "bloodline" | "transcendent"
  definitionId: string
  operation: "add" | "remove"
  version: number
  /** Self-reported qualifying reason. Required for a ranked title add. */
  reason?: string
  /**
   * The physical ring position, REQUIRED when adding a Ring-slot equipment item
   * (the single canonical "Ring" catalog slot is worn in two positions). Forbidden
   * on a non-ring equipment add and ignored on a remove. Never required on a
   * non-equipment kind.
   */
  equipmentPosition?: "Ring 1" | "Ring 2"
  /**
   * The exact blessing tier, meaningful only on a `blessing` operation (the
   * `definitionId` names the god that granted it; the tier is persisted verbatim
   * and the live effect is synthesized from the god's `blessingEffects[tier]`).
   */
  tier?: string
}

export interface AssociationResponse {
  character: CharacterDetail
}

export type SkillSelectRequest = {
  operation: "select"
  offerId: string
  definitionId: string
  version: number
}

export type SkillGrantRequest = {
  operation: "grant"
  definitionId: string
  version: number
  reason: string
}

export type SkillRequest = SkillSelectRequest | SkillGrantRequest

export interface SkillResponse {
  character: CharacterDetail
}

/**
 * An explicit skill-upgrade request from the owner or an admin. Upgrades the
 * character's linked skill in an `upgradeGroup` to a strictly higher-ordered
 * rarity variant; `reason` is mandatory and recorded into the `skill_upgrade`
 * journal.
 */
export type SkillUpgradeRequest = {
  definitionId: string
  version: number
  reason: string
}

export interface SkillUpgradeResponse {
  character: CharacterDetail
}

/**
 * POST /api/characters/[id]/skills/refresh - the reloaded character detail after
 * appending any newly eligible skill options to still-pending scheduled offers.
 * The character version and journal are not bumped (refresh only appends snapshot
 * rows), so the detail reflects the new option rows without a CAS advance.
 */
export interface SkillRefreshResponse {
  character: CharacterDetail
}

export interface ProgressionEvent {
  kind: string
  payload: unknown
  createdAt: string
}

/** A snapshot of a linked catalog definition captured at export time. */
export interface ExportDefinitionSnapshot {
  id: string
  name: string
  kind: string
  config: Record<string, unknown>
  archived: boolean
  stableId: string
  updatedAt: string
}

/** An exported character association plus the snapshot of its definition. */
export interface ExportAssociation {
  id: string
  definitionId: string
  kind:
    "title" | "equipment" | "skill" | "blessing" | "bloodline" | "transcendent"
  createdAt: string
  /**
   * Present ONLY on equipment links: true when the link predates the
   * inventory-ownership model and may stay equipped with zero owned stock. Absent
   * on non-equipment links (they cannot be grandfathered).
   */
  legacyUnowned?: boolean
  /**
   * The physical ring position for a Ring-slot equipment link (`'Ring 1'` /
   * `'Ring 2'`), and `null` for a non-ring equipment link (the single canonical
   * "Ring" catalog slot is worn in two positions). Present only on equipment
   * links in the current backup; absent on the legacy v3/v4 shapes.
   */
  equipmentPosition?: "Ring 1" | "Ring 2" | null
  /**
   * The exact blessing tier a blessing link was granted at, present ONLY on a
   * blessing association (which references a `gods` definition). The current
   * backup emits it so the god + tier relationship round-trips exactly.
   */
  tier?: string
  definition: ExportDefinitionSnapshot
}

/**
 * An exported owned-stock entry. `definition.kind` is always `"equipment"` or
 * `"items"` (the only kinds that can be inventoried - `items` replaces the legacy
 * `consumables` kind); `quantity` is the owned count, bounded 1..999999. The
 * definition references the LOCAL catalog by `kind` + `stableId`.
 */
export interface ExportInventoryItem {
  definition: { kind: "equipment" | "items"; stableId: string }
  quantity: number
}

/** The v3 trusted-backup identity block, using stable catalog identifiers. */
export interface CharacterIdentityExport {
  name: string
  description: string | null
  // Profile metadata, exported verbatim (nullable) so a backup round-trips the
  // exact stored values; an absent field exports as null.
  nickname: string | null
  pronouns: string | null
  ageDescription: string | null
  appearance: string | null
  biography: string | null
  notes: string | null
  origin: "integrated" | "born"
  race: { stableId: string | null }
  class: { stableId: string | null }
  profession: { stableId: string } | null
}

/** A read-only snapshotted skill option in an exported offer. */
export interface SkillOfferOptionExport {
  stableId: string
  nameSnapshot: string
  configSnapshot: Record<string, unknown>
}

/** An exported skill offer (milestone choice), keyed by stable identifiers. */
export interface SkillOfferExport {
  track: string
  level: number
  choiceGroup: string
  /** Sequential offer generation for this base key (0 = initial offer). */
  generation: number
  /** Cancellation timestamp (ISO), null while the offer is still active. */
  canceledAt: string | null
  offeredAt: string
  selectedStableId: string | null
  options: SkillOfferOptionExport[]
  /**
   * Schedule-credit provenance (nullable on legacy/imported offers): the grade
   * whose skill-choice interval awarded this offer. Present only on a
   * scheduled/milestone offer.
   */
  earnedGrade?: string | null
  /**
   * Catalog stableId of the selected track at the moment the credit was earned.
   * Present (with `earnedGrade`) only on a scheduled/milestone offer.
   */
  trackDefinitionStableId?: string | null
  /**
   * Catalog stableId of the character's selected CLASS at the moment the credit
   * was earned, snapshotted at EARNING time for class/profession credits and null
   * for a monster race credit. Present (with `earnedGrade`) only on a
   * scheduled/milestone offer; null on legacy offers. Priority-only, never
   * eligibility.
   */
  classStableIdAtEarn?: string | null
}

export interface ExportResponse {
  /** "primal-character/7" - the current trusted-backup schema. */
  schema: string
  rulesetVersion: string
  identity: CharacterIdentityExport
  character: CharacterListItem
  /** The immutable, stored base state (no synthesized effects/equipment). */
  state: CharacterState
  /**
   * The synthesized live state used by `status` (stored state merged with the
   * effects/equipment from currently linked, unarchived definitions). Advisory
   * on import - status is recomputed server-side.
   */
  liveState: CharacterState
  status: StatusResult
  /**
   * Informational derived quality for the exporting UI. Advisory on import - the
   * importer recomputes it from the re-linked associations.
   */
  isTranscendent: boolean
  associations: ExportAssociation[]
  /** Owned stock (equipment + items) keyed by stable catalog identifier. */
  inventory: ExportInventoryItem[]
  events: ProgressionEvent[]
  skillOffers: SkillOfferExport[]
}

// ------------------------------------------------------------------ //
// Drafts (character-creation resumable snapshot)
// ------------------------------------------------------------------ //

/**
 * Whitelisted draft payload for PUT /api/drafts. A draft is resumable creation
 * state, NOT authoritative character state: the only fields stored are the ones
 * the server whitelists (see lib/server/draft-schema.ts), so binaries and
 * stat/award/effect fields never sneak in. All fields are optional and a strict
 * object - anything not listed here is rejected with a 400.
 */
export interface DraftData {
  /** The 0-based questionnaire step index. The client owns step progression. */
  step?: number
  name?: string
  description?: string | null
  origin?: "integrated" | "born"
  /**
   * Draft-only branch choice captured before a race is selected, so the wizard
   * can resume the correct branch. NOT part of the final character create - the
   * server derives the race type from the selected catalog race, so a client can
   * never spoof it.
   */
  raceType?: "enlightened" | "monster"
  raceId?: string
  classId?: string
  professionId?: string | null
  /** "Has special abilities" informational flag - draft data only. */
  special?: boolean
  /**
   * Explicit blessing / bloodline / transcendent-skill selections for the final
   * create. Draft data only for resumability - the legacy `special` boolean does
   * NOT imply a power, so an absent `specialAbilities` grants nothing.
   */
  specialAbilities?: SpecialAbilitiesSelection
  /** Selected catalog stableIds/ids for equipment - draft data only. */
  equipment?: string[]
  nickname?: string | null
  pronouns?: string | null
  ageDescription?: string | null
  appearance?: string | null
  biography?: string | null
  notes?: string | null
}

export interface DraftView {
  id: string
  data: DraftData
  version: number
  updatedAt: string
}

export interface DraftResponse {
  draft: DraftView | null
}

export interface SaveDraftRequest {
  data: DraftData
  /**
   * CAS token. Omitting `version` only creates the draft (when none exists);
   * updating an existing draft requires the exact current version.
   */
  version?: number
}

export interface DeleteDraftResponse {
  deleted: boolean
}

// ------------------------------------------------------------------ //
// Portraits (authenticated character avatar assets)
// ------------------------------------------------------------------ //

/** A portrait asset's public view. `url` is always `/api/assets/{id}`. */
export interface PortraitView {
  assetId: string
  url: string
}

/** GET /api/characters/[id]/portrait - `portrait` is null when none uploaded. */
export interface PortraitResponse {
  portrait: PortraitView | null
}
