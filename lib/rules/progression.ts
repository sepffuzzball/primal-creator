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
  SKILL_CHOICE_ENTRY,
  type SkillChoiceIntervals,
  bandForGrade,
  gradeForLevel,
  gradeOrderIndex,
  makeVector,
  nextGrade,
  vectorSum,
  zeroVector,
} from "./types"

/* ------------------------------------------------------------------ *
 * Skill-choice milestone schedule
 * ------------------------------------------------------------------ */

/**
 * Whether a class/profession (or race) track level-up to `level` awards a
 * skill-choice credit for `grade` under the configured `intervals` schedule.
 *
 * A credit is earned when ALL of these hold:
 *   - `grade` has a skill-choice entry point (every grade G..S now has one);
 *   - `level` is strictly ABOVE the grade's entry point;
 *   - `(level - entry) % interval === 0` (a whole number of intervals above the
 *     entry point);
 *   - `level` is within the grade's applicable band, where the upper bound is
 *     EXCLUSIVE of the NEXT grade's skill-choice entry (so reaching that boundary
 *     level, e.g. 100 for E, does NOT credit this grade), while the grade's own
 *     entry point never counts. The top grade S has no next entry and caps at its
 *     own inclusive band max (999).
 *
 * The "applicable band" uses the published grade table bands, but the upper bound
 * for a non-S grade is exclusive of the next grade's skill-choice entry, so a
 * credit is awarded only strictly below that boundary (never at the next grade's
 * own entry). This prevents an E-grade level-100 from awarding an E credit and a
 * D-grade level-200 from awarding a D credit. A grade never awards merely for
 * reaching its own entry point (`level > entry` is required), and never awards at
 * or past the next grade's entry point.
 *
 * G is special: its next grade is F, and F's skill-choice entry is 0 - the same as
 * G's own - so using the "next grade's entry" as the upper bound would cap every G
 * level (no level is below 0). Instead G caps at the F band's published max (24),
 * exclusive. This deliberately differs from the grade-band `entryLevel` (which is
 * 0 for G and 10 for F); the skill-choice schedule overlays its own semantics.
 *
 * This is a pure read of `grade`, `level`, and `intervals`; it never consults
 * state or a database.
 */
export function isSkillChoiceMilestone(
  grade: Grade,
  level: number,
  intervals: SkillChoiceIntervals
): boolean {
  if (!Number.isInteger(level) || level < 0) return false
  const entry = SKILL_CHOICE_ENTRY[grade]
  if (entry == null) return false
  const interval = intervals[grade as keyof SkillChoiceIntervals]
  if (
    typeof interval !== "number" ||
    !Number.isInteger(interval) ||
    interval < 1 ||
    interval > 250
  ) {
    return false
  }
  if (level <= entry) return false
  if ((level - entry) % interval !== 0) return false
  // "Within the applicable grade band": the upper bound is EXCLUSIVE of the next
  // grade's skill-choice entry, so reaching that boundary level belongs to the
  // next grade (E-level-100 / D-level-200 never credit this grade). The top grade
  // S has no next entry and instead caps at its own inclusive band max (999).
  //
  // For the G/F overlap, the next grade's skill-choice entry (F = 0) is not
  // strictly ahead of the current grade's entry (G = 0), so it cannot be used as
  // the upper bound - it would cap every G level. Instead G caps at the next
  // grade's published band max (F = 24), exclusive, so a G track credits through
  // the F band and never at the move into the next band (level 25).
  const next = nextGrade(grade)
  let hi: number | null | undefined
  if (next == null) {
    hi = bandForGrade(grade)?.max
  } else {
    const nextEntry = SKILL_CHOICE_ENTRY[next]
    if (nextEntry != null && nextEntry > entry) {
      hi = nextEntry
    } else {
      hi = bandForGrade(next)?.max
    }
  }
  if (hi == null) return false
  if (next != null ? level >= hi : level > hi) return false
  return true
}

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
 * Grade ceiling level-up blockers
 * ------------------------------------------------------------------ */

/**
 * The tracks a +Level control can target and the map of grade-ceiling block
 * reasons keyed by track. A track is present in the returned map only when a
 * level-up on it is blocked by the authoritative current grade ceiling. A value
 * of `null`/absent means a level-up is allowed (or the track cannot be leveled).
 */
export type LevelUpBlockedMap = Partial<
  Record<"race" | "class" | "profession", string>
>

/**
 * The entry level of the grade band immediately above `grade`, or `null` when
 * there is no next grade (the top grade S) or the table configures no band for
 * it. A `null` threshold means no ceiling, exactly as the engine treats a
 * next-grade lookup that yields no band - such a track is never capped.
 */
function nextGradeEntry(grade: Grade, config: RulesConfig): number | null {
  const next = nextGrade(grade)
  if (!next) return null
  const band = bandForGrade(next, config.gradeTable)
  return band ? band.entryLevel : null
}

/**
 * The reason a level-up that projects the race level to `projectedRaceLevel`
 * would be blocked by the current race grade ceiling, or `null` when it is
 * allowed. This mirrors the engine's race grade-ceiling gate exactly: a level-up
 * may reach exactly the NEXT grade's entry level but may not push past it until
 * the caller evolves the race grade. `raceGrade` is the authoritative stored
 * grade (`state.race.grade`), never derived from level.
 */
function raceCeilingReason(
  projectedRaceLevel: number,
  raceGrade: Grade,
  config: RulesConfig
): string | null {
  const entry = nextGradeEntry(raceGrade, config)
  if (entry == null) return null
  const next = nextGrade(raceGrade)!
  if (projectedRaceLevel > entry) {
    return `Race level-up would reach ${projectedRaceLevel}, past the ${raceGrade}->${next} ceiling (${entry}); evolve the race grade first`
  }
  return null
}

/**
 * The reason a level-up on a graded class/profession track would be blocked by
 * the track's OWN grade ceiling, or `null` when it is allowed. Identical to the
 * engine's independent track-grade ceiling in `advanceQuarter`: a graded track
 * may reach exactly the next grade's entry level but may not push past it until
 * the caller explicitly evolves the track grade (it never uses the broad band
 * max). An ungraded track is never capped here.
 */
function trackCeilingReason(
  track: TrackId,
  currentLevel: number,
  trackGrade: Grade,
  config: RulesConfig
): string | null {
  const entry = nextGradeEntry(trackGrade, config)
  if (entry == null) return null
  const next = nextGrade(trackGrade)!
  const newLevel = currentLevel + 1
  if (newLevel > entry) {
    return `${track} level-up would reach ${newLevel}, past the ${trackGrade}->${next} ceiling (${entry}); evolve the ${track} grade first`
  }
  return null
}

/**
 * Project the derived race level after a hypothetical level-up on `track`. The
 * projection uses the exact same `config.raceDerivationStrategy` the engine uses,
 * treating only the target track as incremented (the engine advances exactly one
 * track per quarter advance). Only meaningful for a derived race; an independent
 * race carries its own level and is not derived.
 */
function projectedRaceLevelAfterTrackLevelUp(
  state: CharacterState,
  track: TrackId,
  config: RulesConfig
): number {
  const existing = state.tracks[track]
  const tracks = {
    ...state.tracks,
    [track]: { ...existing, level: existing.level + 1 },
  }
  return deriveRaceLevel({ ...state, tracks }, config)
}

/**
 * The grade-ceiling reason a +Level on `track` is blocked, or `null` when a
 * level-up is allowed (or the track cannot be leveled). This is a read-only
 * projection of the engine's actual grade gates - it never mutates state and
 * takes no definition/config beyond `config`.
 *
 * - `race` is gated only for an independent (monster) race whose own level may
 *   not push past the next grade band's entry level.
 * - `class` / `profession` are gated for a derived (enlightened) race. The
 *   derived race gate is evaluated FIRST using the projected race level after the
 *   track level-up, so it is reported ahead of the track ceiling; then the track
 *   grade ceiling applies only to a graded track. A legacy ungraded track carries
 *   no track gate.
 */
export function gradeLevelUpBlockReason(
  state: CharacterState,
  track: TrackId,
  config: RulesConfig
): string | null {
  if (track === "race") {
    if (state.race.mode !== "independent") return null
    return raceCeilingReason(state.race.level + 1, state.race.grade, config)
  }
  const existing = state.tracks[track]
  if (!existing) return null

  // Derived race gate first: an enlightened race derives its race level from the
  // class/profession tracks, so a class/profession level-up may be blocked by the
  // current race grade ceiling before any track-specific ceiling is considered.
  if (state.race.mode === "derived") {
    const raceReason = raceCeilingReason(
      projectedRaceLevelAfterTrackLevelUp(state, track, config),
      state.race.grade,
      config
    )
    if (raceReason) return raceReason
  }

  // Track-grade ceiling: only an explicitly graded track is capped.
  if (existing.grade) {
    return trackCeilingReason(track, existing.level, existing.grade, config)
  }
  return null
}

/**
 * The set of grade-ceiling blockers for every level-able track, keyed by track.
 * A track appears only when a +Level on it would be blocked; an absent key means
 * a level-up is allowed for that track (or the track is not level-able in the
 * character's current mode).
 *
 * - A monster (independent race mode) exposes only the `race` key; an enlightened
 *   (derived) race exposes only `class` / `profession`.
 * - This is a pure read of `state` + `config`; it never mutates either.
 */
export function gradeLevelUpBlockers(
  state: CharacterState,
  config: RulesConfig
): LevelUpBlockedMap {
  const out: LevelUpBlockedMap = {}
  if (state.race.mode === "independent") {
    const reason = gradeLevelUpBlockReason(state, "race", config)
    if (reason) out.race = reason
    return out
  }
  for (const track of ["class", "profession"] as const) {
    const reason = gradeLevelUpBlockReason(state, track, config)
    if (reason) out[track] = reason
  }
  return out
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
  /**
   * Authoritative experience percentage before the operation (0..99, or 100 when
   * the caller targeted a level-up). Present only on journals produced by
   * `setExperiencePercent` / `levelUpFromExperience`; null/undefined on journals
   * from the raw `advanceQuarter` / `advanceRaceQuarter` calls.
   */
  percentBefore?: number
  /**
   * Authoritative experience percentage stored in the result state after the
   * operation. For a level-up (target 100) this is 0 (the new level starts at 0%),
   * otherwise it is the requested target. Present only on journals produced by
   * `setExperiencePercent` / `levelUpFromExperience`.
   */
  percentAfter?: number
  /**
   * Number of quarter advances (turn increments) the operation performed. 0 for a
   * backward set or a no-op. Present only on journals produced by
   * `setExperiencePercent` / `levelUpFromExperience`.
   */
  turnsAdvanced?: number
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
    // The engine always carries the authoritative EXP percent explicitly on any
    // track it mutates. Synced to the quarter boundary so quarter and percent stay
    // consistent (`quarter === floor(experiencePercent / 25)`).
    experiencePercent: newQuarter * 25,
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

  // Independent track-grade ceiling: when a track carries an explicit grade
  // (graded class/profession state), a level-up may reach exactly the NEXT grade's
  // entry level but may not push past it until the caller explicitly evolves the
  // track grade via `evolveTrackGrade`. This is deliberately independent of the
  // race gate below, so a class/profession may evolve ahead of the race when the
  // derived race level is still below its own boundary. Legacy ungraded tracks
  // (no `grade`) are unaffected by this gate.
  if (leveledUp && existing.grade) {
    const trackNext = nextGrade(existing.grade)
    if (trackNext) {
      const trackNextBand = bandForGrade(trackNext, config.gradeTable)
      if (trackNextBand && newLevel > trackNextBand.entryLevel) {
        throw new Error(
          `advanceQuarter: level-up on "${track}" would push ${track} level past the ${existing.grade}->${trackNext} threshold (${trackNextBand.entryLevel}) without completed track evolution`
        )
      }
    }
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
 * evolveTrackGrade (explicit class/profession grade evolution)
 * ------------------------------------------------------------------ */

export interface EvolveTrackJournal {
  track: TrackId
  from: Grade
  to: Grade
  level: number
  oldDefinitionId: string
  newDefinitionId: string
}

export interface EvolveTrackResult {
  ok: boolean
  errors: string[]
  state?: CharacterState
  journal?: EvolveTrackJournal
}

/**
 * Explicitly evolve a graded class/profession track to the NEXT grade, switching
 * its recorded definition and un-capping the track-grade ceiling established in
 * `advanceQuarter`. This differs from `evolveGrade`, which acts on the derived
 * race grade. It only ever changes the target track's `grade` and `definitionId`;
 * historical awards and every other ledger are left untouched (the caller must
 * resolve a missing `grade` on a legacy state separately).
 */
export function evolveTrackGrade(
  state: CharacterState,
  track: TrackId,
  targetGrade: Grade,
  targetDefinitionId: string,
  config: RulesConfig
): EvolveTrackResult {
  const errors: string[] = []
  const existing = state.tracks[track]
  if (!existing) {
    errors.push(`evolveTrackGrade: unknown track "${track}"`)
    return { ok: false, errors }
  }

  const from = existing.grade
  if (!from) {
    errors.push(
      `evolveTrackGrade: track "${track}" has no explicit grade to evolve`
    )
    return { ok: false, errors }
  }

  const expected = nextGrade(from)
  if (expected !== targetGrade) {
    errors.push(
      `target grade ${targetGrade} is not the next grade after ${from} (expected ${expected ?? "none"})`
    )
  }

  const gate = config.gradeGates[targetGrade]
  if (gate === false) {
    errors.push(`grade gate closed for ${targetGrade}`)
  }

  const band = bandForGrade(targetGrade, config.gradeTable)
  if (!band) {
    errors.push(`no grade band defined for ${targetGrade}`)
  } else if (existing.level < band.entryLevel || existing.level > band.max) {
    errors.push(
      `track "${track}" level ${existing.level} does not qualify for ${targetGrade} (needs ${band.entryLevel}-${band.max})`
    )
  }

  if (targetDefinitionId.length === 0) {
    errors.push(
      `evolveTrackGrade: track "${track}" requires a nonempty target definition id`
    )
  }

  if (errors.length > 0) return { ok: false, errors }

  const newState: CharacterState = {
    ...state,
    tracks: {
      ...state.tracks,
      [track]: {
        ...existing,
        grade: targetGrade,
        definitionId: targetDefinitionId,
      },
    },
  }

  return {
    ok: true,
    errors: [],
    state: newState,
    journal: {
      track,
      from,
      to: targetGrade,
      level: existing.level,
      oldDefinitionId: existing.definitionId,
      newDefinitionId: targetDefinitionId,
    },
  }
}

/* ------------------------------------------------------------------ *
 * race-only advancement (monsters / independent race mode)
 * ------------------------------------------------------------------ */

/**
 * Advance an independent (monster) race by one quarter.
 *
 * A monster race does not derive its race level from class/profession tracks;
 * it tracks its own race level directly and advances on a four-quarter cadence.
 * This function is the race-only analogue of `advanceQuarter`:
 *
 * - It increments `race.quarter` 0..3. A quarter advance alone never levels up.
 * - The fourth quarter (quarter 3 -> level-up, back to quarter 0) advances
 *   `race.level` by exactly one and snapshots the race fixed/free award at the
 *   CURRENT race grade into `historicalLevelAwards` (`track: "race"`). It never
 *   fabricates a starter award - only an actual level-up snapshots anything.
 * - It enforces the same NEXT-grade entry threshold as the derived race gate: a
 *   level-up may reach exactly the next grade's entry level but may not push the
 *   race level past it until the caller explicitly evolves the grade.
 * - It offers evolution exactly like the derived engine (grade-gate aware).
 *
 * The `raceDefinition` is the per-level race definition for the character's
 * CURRENT race grade (from `config.raceDefinitions[grade]`). It must be supplied;
 * when missing the caller should reject the advance rather than award a silent
 * zero. Like every engine function it is pure and never mutates its inputs.
 */
export function advanceRaceQuarter(
  state: CharacterState,
  raceDefinition: RaceDefinition,
  config: RulesConfig
): AdvanceResult {
  const race = state.race

  // Bounds validation: race level is a non-negative integer, quarter is 0..3.
  if (!Number.isInteger(race.level) || race.level < 0) {
    throw new Error(
      `advanceRaceQuarter: race level ${race.level} is invalid (must be a nonnegative integer)`
    )
  }
  const quarter = race.quarter ?? 0
  if (!Number.isInteger(quarter) || quarter < 0 || quarter > 3) {
    throw new Error(
      `advanceRaceQuarter: race quarter ${quarter} is invalid (must be an integer in 0..3)`
    )
  }

  const quarterBefore = quarter
  const levelBefore = race.level
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
    // The engine always carries the authoritative EXP percent explicitly on any
    // race state it mutates. Synced to the quarter boundary so quarter and percent
    // stay consistent (`quarter === floor(experiencePercent / 25)`). Only set on
    // independent (monster) races; derived races never get their own percent.
    race: {
      ...race,
      level: newLevel,
      quarter: newQuarter,
      experiencePercent: newQuarter * 25,
    },
    historicalLevelAwards: [...state.historicalLevelAwards],
    allocations: [...state.allocations],
    permanentGains: [...state.permanentGains],
    activeEffects: [...state.activeEffects],
    equipment: [...state.equipment],
    currentResources: { ...state.currentResources },
    turn: state.turn + 1,
  }

  const journal: JournalDelta = {
    track: "race",
    levelBefore,
    levelAfter: newLevel,
    quarterBefore,
    quarterAfter: newQuarter,
    leveledUp,
    raceLevelBefore: levelBefore,
    raceLevelAfter: newLevel,
    notes: [],
  }

  if (leveledUp) {
    const perLevel = makeVector(raceDefinition.perLevel)
    const fixed = perLevel
    const free = raceDefinition.freePerLevel
    newState.historicalLevelAwards.push({
      track: "race",
      level: newLevel,
      definitionId: raceDefinition.id,
      fixed,
      free,
    })
    journal.award = { definitionId: raceDefinition.id, fixed, free }
    journal.raceGain = {
      grade: race.grade,
      levelsGained: 1,
      fixed: { ...fixed },
      free,
    }
    journal.notes.push(
      `race level-up to ${newLevel}; award snapshotted at grade ${race.grade} (fixed + ${free} free)`
    )
    // Never fabricate a starter award: only an actual level-up snapshots.
  } else {
    journal.raceGain = null
    journal.notes.push(`quarter advanced for race; no level-up`)
  }

  // Grade-ceiling gate: a level-up may not push the character past the entry
  // level of the NEXT grade until that next grade has been acquired (manual
  // evolveGrade). The character is permitted to reach exactly the next grade's
  // entry level; any level-up that would push race level PAST that threshold is
  // rejected while the current grade remains below it. The top grade (S) has no
  // higher band, so it is not gated.
  if (leveledUp) {
    const next = nextGrade(newState.race.grade)
    if (next) {
      const nextBand = bandForGrade(next, config.gradeTable)
      if (nextBand && newLevel > nextBand.entryLevel) {
        throw new Error(
          `advanceRaceQuarter: race level-up would push race level past the ${newState.race.grade}->${next} threshold (${nextBand.entryLevel}) without completed evolution`
        )
      }
    }
  }

  // Grade evolution offer (identical to the derived engine).
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
 * Convenience reference for the next grade after a given one.
 * ------------------------------------------------------------------ */

export function nextGradeFor(grade: Grade): Grade | null {
  return nextGrade(grade)
}

/* ------------------------------------------------------------------ *
 * Authoritative experience percentage
 * ------------------------------------------------------------------ */

/**
 * Resolve the authoritative experience percentage of a track (or the race). When
 * the state carries an explicit `experiencePercent` that is the source of truth
 * and is returned verbatim. Otherwise the engine falls back to the legacy quarter
 * cadence (`quarter * 25`, defaulting a missing race quarter to 0). This is a
 * read-only helper: it never rewrites the absent field on a legacy state - an old
 * state is only given an explicit percent when it is advanced.
 */
export function experiencePercentFor(
  state: CharacterState,
  track: TrackId
): number {
  if (track === "race") {
    if (state.race.experiencePercent != null) {
      return state.race.experiencePercent
    }
    return (state.race.quarter ?? 0) * 25
  }
  const existing = state.tracks[track]
  if (!existing) return 0
  if (existing.experiencePercent != null) return existing.experiencePercent
  return existing.quarter * 25
}

/**
 * Build a journal for an operation that performed no quarter advance (a backward
 * set, a same-quarter forward set, or a no-op). All level/race-grade fields are
 * unchanged; `turnsAdvanced` is 0 and the EXP percent fields are recorded.
 */
function staticPercentJournal(
  state: CharacterState,
  track: TrackId,
  levelBefore: number,
  quarterBefore: number,
  quarterAfter: number,
  percentBefore: number,
  percentAfter: number,
  turnsAdvanced: number
): JournalDelta {
  return {
    track,
    levelBefore,
    levelAfter: levelBefore,
    quarterBefore,
    quarterAfter,
    leveledUp: false,
    raceLevelBefore: state.race.level,
    raceLevelAfter: state.race.level,
    evolutionOffer: null,
    evolutionBlocked: null,
    raceGain: null,
    notes: [],
    percentBefore,
    percentAfter,
    turnsAdvanced,
  }
}

function withTrackPercent(
  state: CharacterState,
  track: TrackId,
  percent: number,
  quarter: number
): CharacterState {
  return {
    ...state,
    tracks: {
      ...state.tracks,
      [track]: {
        ...state.tracks[track],
        experiencePercent: percent,
        quarter,
      },
    },
  }
}

function withRacePercent(
  state: CharacterState,
  percent: number,
  quarter: number
): CharacterState {
  return {
    ...state,
    race: {
      ...state.race,
      experiencePercent: percent,
      quarter,
    },
  }
}

/**
 * Set the authoritative experience percentage of a track (class/profession) or of
 * an independent (monster) race, reusing the existing quarter engine for 25% turn
 * boundaries and level awards.
 *
 * - The race track requires `state.race.mode === "independent"`; a class or
 *   profession track must already exist.
 * - `target` is an integer 0..100. A target of 100 requests a level-up; a target
 *   of 0..99 sets the percentage within the current level.
 * - Backward (`target < current`): set `experiencePercent` to `target` and
 *   `quarter` to `floor(target / 25)`, never decrement `state.turn`, never revoke
 *   awards. The journal reports `turnsAdvanced: 0`.
 * - No-op (`target === current`): returns the input state unchanged (no turn
 *   change) with a `turnsAdvanced: 0` journal.
 * - Forward (`target > current`): for each crossed 25/50/75/100 boundary, call
 *   the existing `advanceQuarter` / `advanceRaceQuarter` exactly once (each
 *   increments `state.turn` and applies its own expiry/alternative logic). At 100
 *   the final call levels up (or fails atomically on a grade gate). A target below
 *   100 ends with `experiencePercent = target` and `quarter = floor(target / 25)`.
 *
 * The function is pure: on any engine rejection (e.g. a closed grade gate) it
 * throws without returning a partial state.
 */
export function setExperiencePercent(
  state: CharacterState,
  track: TrackId,
  target: number,
  definition: TrackDefinition,
  config: RulesConfig
): AdvanceResult
export function setExperiencePercent(
  state: CharacterState,
  track: "race",
  target: number,
  definition: RaceDefinition,
  config: RulesConfig
): AdvanceResult
export function setExperiencePercent(
  state: CharacterState,
  track: TrackId,
  target: number,
  definition: TrackDefinition | RaceDefinition,
  config: RulesConfig
): AdvanceResult {
  if (!Number.isInteger(target) || target < 0 || target > 100) {
    throw new Error(
      `setExperiencePercent: target must be an integer in 0..100 (got ${String(target)})`
    )
  }

  const isRace = track === "race"
  const existingTrack = state.tracks[track]

  if (isRace) {
    if (state.race.mode !== "independent") {
      throw new Error(
        `setExperiencePercent: race track "${track}" requires independent race mode (got "${state.race.mode}")`
      )
    }
  } else if (!existingTrack) {
    throw new Error(`setExperiencePercent: unknown track "${track}"`)
  }

  const current = experiencePercentFor(state, track)
  const currentQ = Math.floor(current / 25)
  const targetQ = Math.floor(target / 25)
  const storedPercent = target === 100 ? 0 : target
  const storedQuarter = target === 100 ? 0 : targetQ
  const level = isRace ? state.race.level : existingTrack!.level

  // No-op: target equals the current authoritative percent. No turn, no state change.
  if (target === current) {
    return {
      state,
      journal: staticPercentJournal(
        state,
        track,
        level,
        currentQ,
        currentQ,
        current,
        current,
        0
      ),
    }
  }

  // Backward set: only ever lower the percent/quarter; never decrement the turn or
  // revoke awards.
  if (target < current) {
    const next = isRace
      ? withRacePercent(state, storedPercent, storedQuarter)
      : withTrackPercent(state, track, storedPercent, storedQuarter)
    return {
      state: next,
      journal: staticPercentJournal(
        state,
        track,
        level,
        currentQ,
        storedQuarter,
        current,
        storedPercent,
        0
      ),
    }
  }

  // Forward set. Determine how many quarter boundaries are crossed.
  const advancesNeeded = target === 100 ? 4 - currentQ : targetQ - currentQ

  if (advancesNeeded === 0) {
    // Same quarter, higher percent: no boundary crossed, so no engine advance. Only
    // the authoritative percent/quarter is updated; the turn is untouched.
    const next = isRace
      ? withRacePercent(state, storedPercent, storedQuarter)
      : withTrackPercent(state, track, storedPercent, storedQuarter)
    return {
      state: next,
      journal: staticPercentJournal(
        state,
        track,
        level,
        currentQ,
        storedQuarter,
        current,
        storedPercent,
        0
      ),
    }
  }

  let s = state
  let lastJournal: JournalDelta | null = null
  for (let i = 0; i < advancesNeeded; i++) {
    const r = isRace
      ? advanceRaceQuarter(s, definition as RaceDefinition, config)
      : advanceQuarter(s, track, definition as TrackDefinition, config)
    s = r.state
    lastJournal = r.journal
  }

  // Override the synced quarter*25 percent with the authoritative requested value.
  const next = isRace
    ? withRacePercent(s, storedPercent, storedQuarter)
    : withTrackPercent(s, track, storedPercent, storedQuarter)

  // The journal must describe the WHOLE operation, not the last 25% step. The
  // engine's `advanceQuarter` / `advanceRaceQuarter` journals only carry the values
  // immediately before the final step, so override the "before" fields with the
  // initial state captured above and retain the final "after" / award / race gain /
  // evolution offer from the last engine step.
  const journal: JournalDelta = {
    ...(lastJournal ??
      staticPercentJournal(
        state,
        track,
        level,
        currentQ,
        storedQuarter,
        current,
        storedPercent,
        advancesNeeded
      )),
    levelBefore: level,
    quarterBefore: currentQ,
    raceLevelBefore: state.race.level,
    percentBefore: current,
    percentAfter: storedPercent,
    turnsAdvanced: advancesNeeded,
  }

  return { state: next, journal }
}

/**
 * Level a track (or race) up from experience. A thin wrapper over
 * `setExperiencePercent(..., 100)`: it may level from ANY percentage (including 0)
 * and resets the percent to 0 after the level-up. The journal carries the
 * percent-before/after and the merged final level/award/race-gain/evolution offer
 * from the final engine step; skill offers are NOT synthesized by the engine (the
 * service adds them only on an actual level-up).
 */
export function levelUpFromExperience(
  state: CharacterState,
  track: TrackId,
  definition: TrackDefinition,
  config: RulesConfig
): AdvanceResult
export function levelUpFromExperience(
  state: CharacterState,
  track: "race",
  definition: RaceDefinition,
  config: RulesConfig
): AdvanceResult
export function levelUpFromExperience(
  state: CharacterState,
  track: TrackId,
  definition: TrackDefinition | RaceDefinition,
  config: RulesConfig
): AdvanceResult {
  return track === "race"
    ? setExperiencePercent(
        state,
        "race",
        100,
        definition as RaceDefinition,
        config
      )
    : setExperiencePercent(
        state,
        track,
        100,
        definition as TrackDefinition,
        config
      )
}
