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

import { Prisma } from "@prisma/client"
import {
  advanceQuarter,
  allocatePoints,
  calculateStatus,
  defaultRulesConfig,
  evolveGrade,
  gradeOrderIndex,
  makeVector,
  zeroVector,
  type CharacterState,
  type Grade,
  type PartialVector,
  type RaceDefinition,
  type RulesConfig,
  type StatusResult,
  type TrackDefinition,
  type TrackId,
} from "@/lib/rules"
import { prisma } from "@/lib/db/client"
import { characterStateSchema, parseCatalogConfig } from "@/lib/server/schemas"
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
} as const

type CharacterWithCatalog = Prisma.CharacterGetPayload<{
  include: typeof characterInclude
}>

type DbClient = Prisma.TransactionClient | typeof prisma

export interface CharacterAssociationView {
  id: string
  definitionId: string
  kind: "title" | "equipment"
  name: string
  slot?: string
  upgradeGroup?: string
  /** Whether the linked catalog definition is currently archived. */
  definitionArchived: boolean
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
  createdAt: string
  updatedAt: string
  associations: CharacterAssociationView[]
  status?: StatusResult
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
 */
export function buildRulesConfig(raceRow: CatalogRow | null): RulesConfig {
  const config = defaultRulesConfig()
  if (raceRow) {
    const parsed = parseCatalogConfig(raceRow.kind, raceRow.config ?? {})
    const defs = raceDefinitionsFrom(parsed)
    if (Object.keys(defs).length > 0) config.raceDefinitions = defs
  }
  // resourceMultipliers stay null (derived resources unresolved -> max null).
  // consumable rates and equipment caps stay at engine defaults.
  // gradeGates stay open ({}).
  return config
}

/** The grade table order index, used only for choosing a fallback definition. */
function gradeIndex(grade: string): number {
  const idx = gradeOrderIndex(grade as Grade)
  return Number.isFinite(idx) ? idx : 0
}

/**
 * Resolve the track definition to use for advancing `trackId`. The definition is
 * chosen by the character's current race grade; if that grade has no definition
 * in the catalog row, the lowest-defined grade is used. Returns null when the
 * catalog row defines no per-grade track gains.
 */
export function resolveTrackDefinition(
  row: CatalogRow | null,
  state: CharacterState
): TrackDefinition | null {
  if (!row) return null
  const config = parseCatalogConfig(row.kind, row.config ?? {})
  const grades = (config.grades ?? {}) as Record<
    string,
    { fixed?: Partial<Record<string, number>>; free?: number }
  >
  const entries = Object.entries(grades)
  if (entries.length === 0) return null
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
 */
export function createInitialState(
  origin: "integrated" | "born",
  raceRow: CatalogRow | null,
  professionRow: CatalogRow | null
): CharacterState {
  const tracks: CharacterState["tracks"] = {}
  const classLevel = 0
  const professionLevel = 0

  tracks["class"] = {
    level: classLevel,
    quarter: 0,
    definitionId: "",
  }
  if (professionRow) {
    tracks["profession"] = {
      level: professionLevel,
      quarter: 0,
      definitionId: "",
    }
  }

  return {
    baseAttributes: zeroVector(),
    tracks,
    race: {
      level: 0,
      grade: origin === "born" ? "F" : "G",
      mode: "derived",
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
  let next = state
  // After an evolution the character's grade changes and the correct track
  // definition for the new grade differs. Update the recorded definitionId so
  // the engine's consistency guard is satisfied before advancing.
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

function configFor(character: CharacterWithCatalog): RulesConfig {
  return buildRulesConfig(character.race)
}

function associationView(
  link: CharacterWithCatalog["associations"][number]
): CharacterAssociationView {
  const config = parseCatalogConfig(
    link.definition.kind,
    link.definition.config ?? {}
  )
  const kind = link.kind === "TITLE" ? "title" : "equipment"
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
  if (kind === "title") {
    const upgradeGroup = config.upgradeGroup as string | undefined
    if (upgradeGroup) view.upgradeGroup = upgradeGroup
  }
  return view
}

function toDetail(
  character: CharacterWithCatalog,
  withStatus: boolean
): CharacterDetail {
  const config = configFor(character)
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
    createdAt: character.createdAt.toISOString(),
    updatedAt: character.updatedAt.toISOString(),
    associations: character.associations.map(associationView),
    status: withStatus ? statusFor(character, config) : undefined,
  }
}

function toListItem(
  character: CharacterWithCatalog,
  withStatus: boolean
): CharacterListItem {
  const config = configFor(character)
  return {
    id: character.id,
    name: character.name,
    description: character.description,
    raceName: character.race?.name ?? null,
    className: character.class?.name ?? null,
    professionName: character.profession?.name ?? null,
    updatedAt: character.updatedAt.toISOString(),
    archived: character.archived,
    status: withStatus ? statusFor(character, config) : undefined,
  }
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

export async function listCharacters(
  user: SessionUser,
  opts?: { withStatus?: boolean; includeArchived?: boolean }
): Promise<CharacterListItem[]> {
  const where = {
    ...ownedWhere(user),
    ...(opts?.includeArchived ? {} : { archived: false }),
  }
  const rows = await prisma.character.findMany({
    where,
    include: characterInclude,
    orderBy: { updatedAt: "desc" },
  })
  return rows.map((row) => toListItem(row, opts?.withStatus ?? false))
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
  return toDetail(row, opts?.withStatus ?? true)
}

export async function createCharacter(
  input: {
    name: string
    description?: string
    origin: "integrated" | "born"
    raceId: string
    classId: string
    professionId?: string
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

  const state = createInitialState(input.origin, race, profession)
  const serialized = serializeState(state)

  // Create the character and append the "create" progression event atomically: a
  // character row must never exist without its corresponding journal entry.
  return prisma.$transaction(async (tx) => {
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
        } as Prisma.InputJsonValue,
      },
    })

    return toDetail(created, true)
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
    return toDetail(updated, true)
  })
}

export async function archiveCharacter(
  id: string,
  user: SessionUser
): Promise<CharacterDetail> {
  return prisma.$transaction(async (tx) => {
    const row = await assertOwner(tx, id, user)
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
    return toDetail(updated, true)
  })
}

export async function advanceCharacter(
  id: string,
  body: { track: "class" | "profession"; version: number },
  user: SessionUser
): Promise<{ character: CharacterDetail; journal: unknown }> {
  return prisma.$transaction(async (tx) => {
    const row = await assertOwner(tx, id, user)
    const state = deserializeState(row.state)
    const config = configFor(row)
    const trackRow = body.track === "class" ? row.class : row.profession
    const definition = resolveTrackDefinition(trackRow, state)
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
    await tx.progressionEvent.create({
      data: {
        characterId: id,
        kind: "advance",
        payload: {
          track: body.track,
          definitionId: definition.id,
          journal: result.journal,
        } as unknown as Prisma.InputJsonValue,
      },
    })
    const updated = (await tx.character.findUnique({
      where: { id },
      include: characterInclude,
    }))!
    return { character: toDetail(updated, true), journal: result.journal }
  })
}

export async function allocateCharacter(
  id: string,
  body: { allocation: Partial<Record<string, number>>; version: number },
  user: SessionUser
): Promise<{ character: CharacterDetail; status: StatusResult }> {
  return prisma.$transaction(async (tx) => {
    const row = await assertOwner(tx, id, user)
    const state = deserializeState(row.state)
    const config = configFor(row)
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
      character: toDetail(updated, true),
      status: statusFor(updated, config),
    }
  })
}

export async function evolveCharacter(
  id: string,
  body: { grade: Grade; version: number },
  user: SessionUser
): Promise<{ character: CharacterDetail; journal: unknown }> {
  return prisma.$transaction(async (tx) => {
    const row = await assertOwner(tx, id, user)
    const state = deserializeState(row.state)
    const config = configFor(row)
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
    return { character: toDetail(updated, true), journal: result.journal }
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

export async function associateCharacter(
  id: string,
  body: {
    kind: "title" | "equipment"
    definitionId: string
    operation: "add" | "remove"
    version: number
  },
  user: SessionUser
): Promise<{ character: CharacterDetail }> {
  return prisma.$transaction(async (tx) => {
    const row = await assertOwner(tx, id, user)

    const definition = await tx.catalogDefinition.findUnique({
      where: { id: body.definitionId },
    })
    if (!definition) {
      throw notFound("catalog_not_found", "Catalog entry not found")
    }
    const expectedKind = body.kind === "title" ? "titles" : "equipment"
    if (definition.kind !== expectedKind) {
      throw badRequest(
        "wrong_kind",
        `Catalog entry has wrong kind (expected "${expectedKind}")`
      )
    }

    const assocKind = body.kind === "title" ? "TITLE" : "EQUIPMENT"
    const existing = row.associations
    const existingLink = existing.find(
      (l) =>
        l.definitionId === body.definitionId &&
        (body.kind === "title" ? l.kind === "TITLE" : l.kind === "EQUIPMENT")
    )

    // Links the operation displaces: for an add, every existing link that shares
    // the equipment slot / title upgrade group; for a remove, the single link
    // being removed (an archived linked entry is always removable).
    const displaced: Array<{ id: string; definitionId: string; name: string }> =
      []

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
          `This ${body.kind === "title" ? "title" : "equipment piece"} is already attached`
        )
      }

      const config = parseCatalogConfig(
        definition.kind,
        definition.config ?? {}
      )

      // Equipment add replaces whatever currently occupies the SAME slot. Remove
      // every such link atomically - never leave a second effective item in a
      // slot.
      if (body.kind === "equipment") {
        const slot = config.slot as string | undefined
        if (slot) {
          const sameSlotLinks = existing.filter(
            (l) =>
              l.kind === "EQUIPMENT" && definitionSlot(l.definition) === slot
          )
          for (const link of sameSlotLinks) {
            displaced.push({
              id: link.id,
              definitionId: link.definitionId,
              name: link.definition.name,
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

      await tx.characterAssociation.create({
        data: {
          characterId: id,
          definitionId: definition.id,
          kind: assocKind as never,
        },
      })
    } else {
      if (!existingLink) {
        throw badRequest(
          "not_linked",
          `This ${body.kind === "title" ? "title" : "equipment piece"} is not attached to the character`
        )
      }
      displaced.push({
        id: existingLink.id,
        definitionId: existingLink.definitionId,
        name: existingLink.definition.name,
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

    const config = parseCatalogConfig(definition.kind, definition.config ?? {})
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
            ...(body.kind === "equipment"
              ? {
                  slot: (config.slot as string | undefined) ?? null,
                }
              : {}),
            ...(body.kind === "title"
              ? {
                  upgradeGroup:
                    (config.upgradeGroup as string | undefined) ?? null,
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
    return { character: toDetail(updated, true) }
  })
}

export async function exportCharacter(
  id: string,
  user: SessionUser
): Promise<Record<string, unknown>> {
  const row = await assertOwner(prisma, id, user)
  const config = configFor(row)
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
    kind: a.kind === "TITLE" ? "title" : "equipment",
    createdAt: a.createdAt.toISOString(),
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
  return {
    schema: "primal-character/2",
    character: toListItem(row, true),
    state,
    liveState: live,
    status: statusFor(row, config),
    associations,
    events: events.map((e) => ({
      kind: e.kind,
      payload: e.payload,
      createdAt: e.createdAt.toISOString(),
    })),
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
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
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

export async function listCatalog(kind: string): Promise<CatalogItem[]> {
  const rows = await prisma.catalogDefinition.findMany({
    where: { kind: kind as never, archived: false },
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
  let stableId = input.stableId
  if (!stableId) {
    stableId =
      input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "entry"
  }
  try {
    const row = await prisma.catalogDefinition.create({
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
      },
    })
    return catalogItem(row)
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict(
        "catalog_stable_id_conflict",
        `Catalog entry with stableId "${stableId}" already exists`
      )
    }
    throw err
  }
}

/**
 * Reject a catalog update that would make an equipment `slot` or a title
 * `upgradeGroup` collide on an EXISTING character link. The rule is that a
 * character can never have two effective (non-archived) effects in the same
 * group/slot, so a config edit that introduces such a collision is rejected with
 * 409 and the whole update is rolled back. Archived definitions are inert and
 * never collide. The check runs inside the same transaction as the update.
 */
async function assertNoLinkCollision(
  tx: DbClient,
  kind: string,
  definitionId: string,
  finalConfig: Record<string, unknown>,
  finalArchived: boolean
): Promise<void> {
  // Only slots (equipment) and upgrade groups (titles) can collide; archived
  // definitions synthesise no effect so they cannot conflict.
  if (kind !== "equipment" && kind !== "titles") return
  if (finalArchived) return

  const slot = kind === "equipment" ? slotForConfig(finalConfig) : undefined
  const group =
    kind === "titles" ? upgradeGroupForConfig(finalConfig) : undefined
  const value = slot ?? group
  if (!value) return

  const expectedAssocKind = kind === "equipment" ? "EQUIPMENT" : "TITLE"
  const links = await tx.characterAssociation.findMany({
    where: { definitionId },
    include: {
      character: {
        include: { associations: { include: { definition: true } } },
      },
    },
  })

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
  const existing = await prisma.catalogDefinition.findUnique({ where: { id } })
  if (!existing || existing.kind !== kind) {
    throw notFound("catalog_not_found", "Catalog entry not found")
  }
  const config =
    patch.config != null ? parseConfigOr400(kind, patch.config) : undefined
  const finalConfig = config ?? parseCatalogConfig(kind, existing.config ?? {})
  const finalArchived =
    patch.archived != null ? patch.archived : existing.archived
  return prisma.$transaction(async (tx) => {
    await assertNoLinkCollision(tx, kind, id, finalConfig, finalArchived)
    try {
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
        },
      })
      return catalogItem(row)
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw conflict(
          "catalog_stable_id_conflict",
          `Catalog entry with stableId "${patch.stableId}" already exists`
        )
      }
      throw err
    }
  })
}
