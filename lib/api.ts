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
}

export interface RaceState {
  level: number
  grade: Grade
  mode: string
  definitionId?: string
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
  status?: StatusResult
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
  createdAt: string
  updatedAt: string
  status?: StatusResult
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
}

export interface AdvanceResponse {
  character: CharacterDetail
  journal: JournalDelta
}

export interface EvolveJournal {
  from: Grade
  to: Grade
  level: number
}

export interface EvolveResponse {
  character: CharacterDetail
  journal: EvolveJournal
}

export interface AllocateResponse {
  character: CharacterDetail
  status: StatusResult
}

export interface ProgressionEvent {
  kind: string
  payload: unknown
  createdAt: string
}

export interface ExportResponse {
  schema: string
  character: CharacterListItem
  state: CharacterState
  status: StatusResult
  events: ProgressionEvent[]
}
