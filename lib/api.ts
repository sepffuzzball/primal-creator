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
  provenance: "verified" | "inferred" | "house"
  sourceUrl: string | null
  archived: boolean
  config: Record<string, unknown>
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
  /** Provenance label of the linked definition. */
  provenance?: string
  /** Whether the linked catalog definition is currently archived. */
  definitionArchived: boolean
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

/**
 * An owned inventory row. Ownership is per-definition house bookkeeping (no item
 * instances, no capacity/stacking): only the integer `quantity` and the linked
 * definition's identity/metadata are exposed. `kind` is the catalog kind of the
 * linked definition - always `"equipment"` or `"consumables"`.
 */
export interface CharacterInventoryItem {
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

/** GET /api/characters/[id]/inventory - owned inventory plus the CAS version. */
export interface CharacterInventoryResponse {
  inventory: CharacterInventoryItem[]
  version: number
}

/**
 * Manual inventory bookkeeping. `quantity` is bounded 1..999999 (the same bound
 * the migration CHECK enforces); `sourceNote` is mandatory and at most 500 chars,
 * recorded into the `inventory_adjust` journal. Acquisition is manual here.
 */
export interface InventoryAdjustRequest {
  operation: "add" | "remove"
  definitionId: string
  quantity: number
  version: number
  sourceNote: string
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
  origin: "integrated" | "born"
  raceId: string | null
  classId: string | null
  professionId: string | null
  raceName: string | null
  className: string | null
  professionName: string | null
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
   * Owned inventory quantities (equipment + consumables), including archived
   * catalog stock. Absent = zero owned stock of that definition.
   */
  inventory: CharacterInventoryItem[]
  /** Pending + selected skill offers (milestone choices) for this character. */
  skillOffers: SkillOfferView[]
  status?: StatusResult
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
}

export interface AdvanceResponse {
  character: CharacterDetail
  journal: JournalDelta
}

export interface EvolveJournal {
  from: Grade
  to: Grade
  level: number
  /** Present when the evolution came from a catalog race or track path choice. */
  source?: "catalog" | "track"
  /** The class/profession track evolved (present on track evolutions). */
  track?: "class" | "profession"
  /** Catalog id of the chosen evolution path (present for path evolutions). */
  optionId?: string
  option?: { id: string; name: string; stableId: string }
  prerequisites?: {
    fromRaceStableId?: string
    toRaceStableId?: string
    fromGrade?: Grade
    toGrade?: Grade
    minRaceLevel?: number | null
    fromDefinitionStableId?: string
    toDefinitionStableId?: string
    minTrackLevel?: number | null
    requiredTitleStableIds?: string[]
    requiredSkillStableIds?: string[]
  }
  destinationRace?: { id: string; stableId: string; name: string }
  /** Destination definition snapshot for a class/profession track evolution. */
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

/** A contextual evolution option derived from an `evolutions` catalog entry. */
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
  /** Whether all mechanical (hard) requirements are met. */
  eligible: boolean
  /** Human-readable unmet mechanical requirements (empty when eligible). */
  blockers: string[]
  /** Whether the path declares a narrative `manualRequirementsText` hard gate. */
  manualReview: boolean
}

export interface EvolutionOptionsResult {
  options: EvolutionOptionView[]
  /**
   * True only when NO valid catalog race path targets the character's next grade,
   * i.e. the legacy grade-only house fallback is offered.
   */
  legacyAvailable: boolean
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

export interface AssociationRequest {
  kind: "title" | "equipment" | "blessing" | "bloodline" | "transcendent"
  definitionId: string
  operation: "add" | "remove"
  version: number
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
  provenance: string
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
  definition: ExportDefinitionSnapshot
}

/**
 * An exported owned-stock entry. `definition.kind` is always `"equipment"` or
 * `"consumables"` (the only kinds that can be inventoried); `quantity` is the
 * owned count, bounded 1..999999. The definition references the LOCAL catalog by
 * `kind` + `stableId`.
 */
export interface ExportInventoryItem {
  definition: { kind: "equipment" | "consumables"; stableId: string }
  quantity: number
}

/** The v3 trusted-backup identity block, using stable catalog identifiers. */
export interface CharacterIdentityExport {
  name: string
  description: string | null
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
  offeredAt: string
  selectedStableId: string | null
  options: SkillOfferOptionExport[]
}

export interface ExportResponse {
  /** "primal-character/4" - the current trusted-backup schema. */
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
  /** Owned stock (equipment + consumables) keyed by stable catalog identifier. */
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
  raceId?: string
  classId?: string
  professionId?: string | null
  /** "Has special abilities" informational flag - draft data only. */
  special?: boolean
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
