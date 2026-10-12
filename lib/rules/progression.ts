/**
 * Progression engine: quarterly advancement, race derivation, grade evolution,
 * and free-point allocation.
 *
 * All functions are pure: they return a new CharacterState plus a journal delta
 * describing what changed. They never mutate their inputs.
 */

import {
  ATTRIBUTES,
  type AllocationEntry,
  type AttributeVector,
  type CharacterState,
  type Grade,
  type PartialVector,
  type RaceDefinition,
  type RulesConfig,
  type TrackDefinition,
  type TrackId,
  bandForGrade,
  gradeForLevel,
  gradeOrderIndex,
  makeVector,
  nextGrade,
  vectorSum,
  zeroVector,
} from "./types"

/* ------------------------------------------------------------------ *
 * Race level derivation
 * ------------------------------------------------------------------ */

/**
 * Compute the derived race level from the class and profession tracks using the
 * configured strategy. "floorHalfAvg" floors the average of class and profession
 * and treats a missing track as level 0 (documented house assumption). The
 * alternative strategies are configurable but are still project assumptions.
 */
export function deriveRaceLevel(
  state: CharacterState,
  config: RulesConfig
): number {
  // Independent race mode: the race level is tracked directly and is not derived.
  if (state.race.mode === "independent") return state.race.level
  const classLevel = state.tracks["class"]?.level ?? 0
  const professionLevel = state.tracks["profession"]?.level ?? 0
  switch (config.raceDerivationStrategy) {
    case "floorHalfAvg":
      return Math.floor((classLevel + professionLevel) / 2)
    case "maxOf":
      return Math.max(classLevel, professionLevel)
    case "sum":
      return classLevel + professionLevel
    case "none":
      return state.race.level
  }
}

/* ------------------------------------------------------------------ *
 * Available points
 * ------------------------------------------------------------------ */

export function totalFreePoints(state: CharacterState): number {
  let free = 0
  for (const a of state.historicalLevelAwards) free += a.free
  return free
}

export function allocatedPoints(state: CharacterState): number {
  let alloc = 0
  for (const a of state.allocations) alloc += vectorSum(a.points)
  return alloc
}

export function availablePoints(state: CharacterState): number {
  return totalFreePoints(state) - allocatedPoints(state)
}

/* ------------------------------------------------------------------ *
 * Journal / result types
 * ------------------------------------------------------------------ */

export interface RaceGainJournal {
  grade: Grade
  levelsGained: number
  fixed: AttributeVector
  free: number
}

export interface JournalDelta {
  track: TrackId
  levelBefore: number
  levelAfter: number
  quarterBefore: number
  quarterAfter: number
  leveledUp: boolean
  award?: { definitionId: string; fixed: AttributeVector; free: number }
  raceLevelBefore: number
  raceLevelAfter: number
  evolutionOffer?: { grade: Grade; available: boolean } | null
  evolutionBlocked?: Grade | null
  raceGain?: RaceGainJournal | null
  notes: string[]
}

export interface AdvanceResult {
  state: CharacterState
  journal: JournalDelta
}

export interface AllocateResult {
  ok: boolean
  errors: string[]
  state?: CharacterState
}

export interface EvolveResult {
  ok: boolean
  errors: string[]
  state?: CharacterState
  journal?: { from: Grade; to: Grade; level: number }
}

/* ------------------------------------------------------------------ *
 * advanceQuarter
 * ------------------------------------------------------------------ */

export function advanceQuarter(
  state: CharacterState,
  track: TrackId,
  definition: TrackDefinition,
  config: RulesConfig
): AdvanceResult {
  const existing = state.tracks[track]
  if (!existing) {
    throw new Error(`advanceQuarter: unknown track "${track}"`)
  }

  // Bounds validation: level is a non-negative integer, quarter is one of 0..3.
  if (!Number.isInteger(existing.level) || existing.level < 0) {
    throw new Error(
      `advanceQuarter: track "${track}" has invalid level ${existing.level}`
    )
  }
  if (
    !Number.isInteger(existing.quarter) ||
    existing.quarter < 0 ||
    existing.quarter > 3
  ) {
    throw new Error(
      `advanceQuarter: track "${track}" has invalid quarter ${existing.quarter}`
    )
  }

  // The track records the definition that granted its level. Rather than silently
  // switching `definitionId`, reject an advancing definition that does not match.
  if (existing.definitionId && existing.definitionId !== definition.id) {
    throw new Error(
      `advanceQuarter: definition "${definition.id}" does not match track "${track}"'s definition "${existing.definitionId}"`
    )
  }

  const quarterBefore = existing.quarter
  const levelBefore = existing.level
  let newQuarter = quarterBefore + 1
  let newLevel = levelBefore
  let leveledUp = false

  if (newQuarter > 3) {
    leveledUp = true
    newLevel = levelBefore + 1
    newQuarter = 0
  }

  const newState: CharacterState = {
    ...state,
    baseAttributes: { ...state.baseAttributes },
    tracks: { ...state.tracks },
    race: { ...state.race },
    historicalLevelAwards: [...state.historicalLevelAwards],
    allocations: [...state.allocations],
    permanentGains: [...state.permanentGains],
    activeEffects: [...state.activeEffects],
    equipment: [...state.equipment],
    currentResources: { ...state.currentResources },
    turn: state.turn + 1,
  }

  newState.tracks[track] = {
    ...existing,
    level: newLevel,
    quarter: newQuarter,
    definitionId: definition.id,
  }

  const journal: JournalDelta = {
    track,
    levelBefore,
    levelAfter: newLevel,
    quarterBefore,
    quarterAfter: newQuarter,
    leveledUp,
    raceLevelBefore: state.race.level,
    raceLevelAfter: state.race.level,
    notes: [],
  }

  if (leveledUp) {
    const fixed = makeVector(definition.fixed)
    const free = definition.free
    newState.historicalLevelAwards.push({
      track,
      level: newLevel,
      definitionId: definition.id,
      fixed,
      free,
    })
    journal.award = { definitionId: definition.id, fixed, free }
    journal.notes.push(
      `level-up ${track} to ${newLevel}; award snapshotted (fixed + ${free} free)`
    )
  } else {
    journal.notes.push(`quarter advanced for ${track}; no level-up`)
  }

  // Race recomputation (derived mode only).
  if (state.race.mode === "derived") {
    const oldRaceLevel = newState.race.level
    const newRaceLevel = deriveRaceLevel(newState, config)
    journal.raceLevelBefore = oldRaceLevel
    journal.raceLevelAfter = newRaceLevel
    newState.race.level = newRaceLevel

    if (newRaceLevel > oldRaceLevel) {
      const gained = newRaceLevel - oldRaceLevel
      const currentGrade = newState.race.grade
      const raceDef: RaceDefinition | undefined =
        config.raceDefinitions?.[currentGrade]
      // A derived race level gain must have a definition to snapshot; never award
      // a silent zero to the historical ledger.
      if (!raceDef) {
        throw new Error(
          `advanceQuarter: derived race level gain (${oldRaceLevel} -> ${newRaceLevel}) has no race definition for grade ${currentGrade}`
        )
      }
      const perLevel = makeVector(raceDef.perLevel)
      const gainVec = zeroVector()
      for (const attr of ATTRIBUTES) gainVec[attr] = perLevel[attr] * gained
      const fixed = gainVec
      const free = raceDef.freePerLevel * gained
      // Derived race automatic gains are historical (immutable snapshots) and are
      // recorded in the historicalLevelAwards ledger, never in permanentGains.
      newState.historicalLevelAwards.push({
        track: "race",
        level: newRaceLevel,
        definitionId: raceDef.id,
        fixed,
        free,
      })
      journal.raceGain = {
        grade: currentGrade,
        levelsGained: gained,
        fixed,
        free,
      }
      journal.notes.push(
        `derived race level ${oldRaceLevel} -> ${newRaceLevel}; snapshotted ${gained} level(s) at grade ${currentGrade}`
      )
    } else {
      journal.raceGain = null
    }
  }

  // Grade-ceiling gate: a level-up may not push the character past the entry
  // level of the NEXT grade until that next grade has been acquired (manual
  // evolveGrade). The character is permitted to reach exactly the next grade's
  // entry level (the threshold level-up, e.g. G9->10 or F24->25); any level-up
  // that would push race level PAST that threshold is rejected while the current
  // grade remains below it (evolution not completed). The top grade (S) has no
  // higher band, so it is not gated.
  if (leveledUp) {
    const next = nextGrade(newState.race.grade)
    if (next) {
      const nextBand = bandForGrade(next, config.gradeTable)
      if (nextBand && newState.race.level > nextBand.entryLevel) {
        throw new Error(
          `advanceQuarter: level-up on "${track}" would push race level past the ${newState.race.grade}->${next} threshold (${nextBand.entryLevel}) without completed evolution`
        )
      }
    }
  }

  // Grade evolution offer.
  const table = config.gradeTable
  const targetGrade = gradeForLevel(newState.race.level, table)
  if (
    targetGrade != null &&
    gradeOrderIndex(targetGrade) > gradeOrderIndex(newState.race.grade)
  ) {
    const gateOpen = config.gradeGates[targetGrade] !== false
    journal.evolutionOffer = { grade: targetGrade, available: gateOpen }
    if (gateOpen) {
      journal.notes.push(`evolution offered to ${targetGrade} (manual)`)
    } else {
      journal.evolutionBlocked = targetGrade
      journal.notes.push(`evolution to ${targetGrade} blocked by grade gate`)
    }
  } else {
    journal.evolutionOffer = null
    journal.evolutionBlocked = null
  }

  return { state: newState, journal }
}

/* ------------------------------------------------------------------ *
 * allocatePoints
 * ------------------------------------------------------------------ */

export function allocatePoints(
  state: CharacterState,
  allocation: PartialVector
): AllocateResult {
  const available = availablePoints(state)
  const errors: string[] = []
  let sum = 0

  for (const attr of ATTRIBUTES) {
    const v = allocation[attr] ?? 0
    if (typeof v !== "number" || !Number.isInteger(v)) {
      errors.push(`${attr}: allocation must be an integer (got ${String(v)})`)
      continue
    }
    if (v < 0) {
      errors.push(`${attr}: allocation cannot be negative (got ${v})`)
      continue
    }
    sum += v
  }

  if (sum > available) {
    errors.push(`allocation of ${sum} exceeds available points (${available})`)
  }

  if (errors.length > 0) return { ok: false, errors }

  const entry: AllocationEntry = {
    id: `alloc-${state.turn}-${state.allocations.length}`,
    source: "available-points",
    at: state.turn,
    points: makeVector(allocation),
  }

  const newState: CharacterState = {
    ...state,
    allocations: [...state.allocations, entry],
  }

  return { ok: true, errors: [], state: newState }
}

/* ------------------------------------------------------------------ *
 * evolveGrade (manual evolution at a level threshold)
 * ------------------------------------------------------------------ */

export function evolveGrade(
  state: CharacterState,
  targetGrade: Grade,
  config: RulesConfig
): EvolveResult {
  const errors: string[] = []
  const from = state.race.grade

  if (gradeOrderIndex(targetGrade) <= gradeOrderIndex(from)) {
    errors.push(
      `target grade ${targetGrade} is not above current grade ${from}`
    )
  }

  const gate = config.gradeGates[targetGrade]
  if (gate === false) {
    errors.push(`grade gate closed for ${targetGrade}`)
  }

  const level =
    state.race.mode === "derived"
      ? deriveRaceLevel(state, config)
      : state.race.level
  const band = bandForGrade(targetGrade, config.gradeTable)
  if (!band) {
    errors.push(`no grade band defined for ${targetGrade}`)
  } else if (level < band.entryLevel || level > band.max) {
    errors.push(
      `race level ${level} does not qualify for ${targetGrade} (needs ${band.entryLevel}-${band.max})`
    )
  }

  if (errors.length > 0) return { ok: false, errors }

  const raceDef = config.raceDefinitions?.[targetGrade]
  const newState: CharacterState = {
    ...state,
    race: {
      ...state.race,
      grade: targetGrade,
      definitionId: raceDef?.id ?? state.race.definitionId,
    },
  }

  return {
    ok: true,
    errors: [],
    state: newState,
    journal: { from, to: targetGrade, level },
  }
}

/* ------------------------------------------------------------------ *
 * Convenience reference for the next grade after a given one.
 * ------------------------------------------------------------------ */

export function nextGradeFor(grade: Grade): Grade | null {
  return nextGrade(grade)
}
