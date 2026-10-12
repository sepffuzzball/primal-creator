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
  calculateStatus,
  consumableToEffect,
  defaultRulesConfig,
  deriveRaceLevel,
  evolveGrade,
  gradeOrderIndex,
  makeVector,
  permanentConsumableCap,
  totalFreePoints,
  zeroVector,
  type AttributeVector,
  type CharacterState,
  type EffectCondition,
  type Grade,
  type PartialVector,
  type RaceDefinition,
  type RulesConfig,
  type StatusResult,
  type TrackDefinition,
  type TrackId,
} from "@/lib/rules"
import { prisma } from "@/lib/db/client"
import {
  characterStateSchema,
  hasInvalidSkillTrack,
  isIncompleteSkillConfig,
  isLegacyConsumableConfig,
  parseCatalogConfig,
} from "@/lib/server/schemas"
import {
  IMPORT_RULESET_VERSION,
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
  kind: "title" | "equipment" | "skill"
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
  createdAt: string
  updatedAt: string
  associations: CharacterAssociationView[]
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
    } else if (def.kind === "skills") {
      // Synthesize each declarative passive effect from the current catalog
      // config. History stays immutable; editing a skill's effects recalculates
      // the live status without rewriting the stored state or the journal.
      const effects = (config.effects ?? []) as Array<{
        phase: string
        amount?: PartialVector
        basisPoints?: PartialVector
        condition?: EffectCondition
        stacking?: "replace" | "stack" | "stackCapped"
        group?: string
      }>
      for (let i = 0; i < effects.length; i++) {
        const eff = effects[i]
        // Each effect retains its OWN stacking/replace group. The skill's
        // `upgradeGroup` is used only on select/grant to remove superseded linked
        // skills - it is never an effect replace group, so a single skill's flat
        // AND percent effects both apply (they never collapse into one another).
        const group = eff.group
        const base = {
          id: `${def.id}:eff-${i}`,
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
function permanentConsumableInfo(character: CharacterWithCatalog): {
  cap: PartialVector
  remaining: PartialVector
} {
  const state = deserializeState(character.state)
  const config = configFor(character)
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
  if (kind === "title" || kind === "skill") {
    const upgradeGroup = config.upgradeGroup as string | undefined
    if (upgradeGroup) view.upgradeGroup = upgradeGroup
  }
  if (kind === "skill") {
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

function toDetail(
  character: CharacterWithCatalog,
  withStatus: boolean
): CharacterDetail {
  const config = configFor(character)
  const consumableInfo = permanentConsumableInfo(character)
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
    createdAt: character.createdAt.toISOString(),
    updatedAt: character.updatedAt.toISOString(),
    associations: character.associations.map(associationView),
    skillOffers: character.skillOffers.map(skillOfferView),
    status: withStatus ? statusFor(character, config) : undefined,
    permanentConsumableCap: consumableInfo.cap,
    permanentConsumableRemaining: consumableInfo.remaining,
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
    imported: character.imported,
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

/**
 * Create ONE skill offer per choice group for a character that just leveled a
 * track. It queries the unarchived `skills` catalog and keeps only the entries
 * whose config `track` / `milestone` exactly match the advanced track/level, whose
 * explicit `grade` (when set) equals the character's current race grade (no
 * inferred compatibility), and whose `eligibleDefinitionStableIds` (when present)
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
  raceGrade: string,
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
    // Grade, when specified, must match the character's current grade exactly.
    if (def.grade && def.grade !== raceGrade) continue
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

    // Skills are offered, never auto-awarded: on a LEVEL-UP only, generate one
    // offer per choice group from the current unarchived skills catalog. A
    // quarter-only advance (no level up) produces no offers. The offers are
    // created inside the same transaction as the CAS state write and the
    // immutable advance event, so a conflict rolls all of them back together.
    let skillOffers: Array<{ id: string; choiceGroup: string }> = []
    if (result.journal.leveledUp) {
      const newLevel = result.journal.levelAfter
      const raceGrade = result.state.race.grade
      const trackStableId =
        body.track === "class" ? row.class?.stableId : row.profession?.stableId
      skillOffers = await createSkillOffersForAdvance(
        tx,
        id,
        body.track,
        newLevel,
        raceGrade,
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
      character: toDetail(updated, true),
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
      return { character: toDetail(updated, true) }
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
    return { character: toDetail(updated, true) }
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
 * snapshot plus applied/requested/capRemainingAfter and a timestamp, and returns
 * the updated character, its live status, and the event.
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
  return prisma.$transaction(async (tx) => {
    const row = await assertOwner(tx, id, user)
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

    const config = parseCatalogConfig(definition.kind, definition.config ?? {})
    const state = deserializeState(row.state)
    const rulesConfig = configFor(row)

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
    if (definition.kind === "consumables" && isLegacyConsumableConfig(config)) {
      throw badRequest(
        "legacy_consumable_config",
        `Consumable "${definition.name}" has no usable "type"/"amount" in its catalog config; add both to consume it`
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
        appliedAt: new Date().toISOString(),
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
        appliedAt: new Date().toISOString(),
      }
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
      character: toDetail(updated, true),
      status: statusFor(updated, rulesConfig),
      event: { kind: "consume", payload: eventPayload },
    }
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
    kind: associationViewKind(a.kind),
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
    schema: "primal-character/3",
    rulesetVersion: IMPORT_RULESET_VERSION,
    identity,
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
    skillOffers,
  }
}

// ------------------------------------------------------------------ //
// Trusted-backup import (v3)
// ------------------------------------------------------------------ //
//
// A v3 document is a *trusted backup*, not authoritative server-verified state.
// Every catalog reference (identity race/class/profession, each association
// definition, each skill-offer option/selection) is resolved by `kind` +
// `stableId` to an EXISTING catalog definition; no catalog content is
// auto-created, and a missing/mismatched/archived required definition is
// rejected with an actionable 400. `liveState` / `status` in the document are
// advisory and are ignored - status is recomputed from the imported state. The
// imported history is stored as `import_history` events (source provenance, not
// valid live IDs) and an `import` marker event is appended.

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
} as const

const ASSOC_KIND_TO_DEF_KIND = {
  title: "titles",
  equipment: "equipment",
  skill: "skills",
} as const

type ResolvedAssoc = {
  sourceKind: "title" | "equipment" | "skill"
  dbKind: "TITLE" | "EQUIPMENT" | "SKILL"
  definitionId: string
  definition: CatalogLookupRow
}

async function resolveAssociationRefs(
  db: DbClient,
  assocs: CharacterImportDocument["associations"]
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
    resolved.push({
      sourceKind: a.kind,
      dbKind: ASSOC_KIND_TO_DB[a.kind] as "TITLE" | "EQUIPMENT" | "SKILL",
      definitionId: def.id,
      definition: def,
    })
  }
  return resolved
}

/**
 * Reject a pair of active (unarchived) associations that would collide: two
 * equipment links sharing a slot, or two title / skill links sharing an upgrade
 * group. Archived definitions are inert and never collide. This mirrors the
 * runtime invariant enforced by `associateCharacter` and `assertNoLinkCollision`.
 */
function assertAssocCollisions(resolved: ResolvedAssoc[]): void {
  const slots = new Map<string, string>()
  const titleGroups = new Map<string, string>()
  const skillGroups = new Map<string, string>()
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
    } else {
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
    const def = resolveTrackDefinition(classRow, resolvedState)
    if (!def) {
      throw badRequest(
        "invalid_import",
        `Class "${classRow.name}" (${classRow.stableId}) defines no track level-up; advancing class would fail`
      )
    }
    tracks["class"] = { ...tracks["class"], definitionId: def.id }
  }
  if (profRow && tracks["profession"]) {
    const def = resolveTrackDefinition(profRow, resolvedState)
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
 * Validate the imported state's self-consistency before persisting. Rejects a
 * backup that (after Zod shape validation) has the wrong track set, out-of-range
 * track levels/quarters, disagrees on origin, carries negative or non-integer
 * attribute/allocation values, over-allocates free points, or (for a derived
 * race) declares a race level inconsistent with the track levels. Every failure
 * is a 400 `invalid_import` raised BEFORE any DB write. No automatic
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
    const config = buildRulesConfig(race)
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

    const resolvedAssocs = await resolveAssociationRefs(tx, input.associations)
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

    return toDetail(refetched, true)
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
 * Reject a catalog update that would make an equipment `slot`, a title
 * `upgradeGroup`, or a skill `upgradeGroup` collide on an EXISTING character
 * link. The rule is that a character can never have two effective (non-archived)
 * effects in the same group/slot, so a config edit that introduces such a
 * collision is rejected with 409 and the whole update is rolled back. Archived
 * definitions are inert and never collide. The check runs inside the same
 * transaction as the update.
 */
async function assertNoLinkCollision(
  tx: DbClient,
  kind: string,
  definitionId: string,
  finalConfig: Record<string, unknown>,
  finalArchived: boolean
): Promise<void> {
  // Only slots (equipment) and upgrade groups (titles/skills) can collide;
  // archived definitions synthesise no effect so they cannot conflict.
  if (kind !== "equipment" && kind !== "titles" && kind !== "skills") return
  if (finalArchived) return

  const slot = kind === "equipment" ? slotForConfig(finalConfig) : undefined
  const group =
    kind === "titles" || kind === "skills"
      ? upgradeGroupForConfig(finalConfig)
      : undefined
  const value = slot ?? group
  if (!value) return

  const expectedAssocKind =
    kind === "equipment" ? "EQUIPMENT" : kind === "titles" ? "TITLE" : "SKILL"
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
  }
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
