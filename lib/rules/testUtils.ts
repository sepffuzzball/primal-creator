/**
 * Shared test fixtures and builders for the rules engine test suites.
 *
 * Not a test file itself (no describe/it); it only builds deterministic inputs.
 */

import {
  ATTRIBUTES,
  type AttributeVector,
  type CharacterState,
  type Grade,
  type PartialVector,
  type RaceMode,
  type RulesConfig,
  createCharacterState,
  defaultRulesConfig,
  makeVector,
  zeroVector,
} from "./types"

export function vec(p: PartialVector): AttributeVector {
  return makeVector(p)
}

export function allZero(): AttributeVector {
  return zeroVector()
}

export type CharacterOptions = {
  classLevel?: number
  professionLevel?: number
  raceMode?: RaceMode
  raceLevel?: number
  raceGrade?: Grade
  intLevel?: number
  dexLevel?: number
  base?: PartialVector
}

/**
 * Build a minimal character with a class track and a profession track. The
 * derived race level is floor((class + profession) / 2); if `raceLevel` is not
 * provided it is computed from those levels so derived mode is self-consistent.
 */
export function character(opts: CharacterOptions = {}): CharacterState {
  const classLevel = opts.classLevel ?? 10
  const professionLevel = opts.professionLevel ?? 10
  const raceMode = opts.raceMode ?? "derived"
  const computedRace =
    raceMode === "derived"
      ? Math.floor((classLevel + professionLevel) / 2)
      : (opts.raceLevel ?? 10)
  const raceLevel = opts.raceLevel ?? computedRace
  const raceGrade = opts.raceGrade ?? "F"
  const base = opts.base ?? {}

  const baseAttributes = makeVector(base) || allZero()
  // Default all attributes to 10 so fractional caps are non-trivial.
  if (Object.keys(base).length === 0) {
    for (const attr of ATTRIBUTES) baseAttributes[attr] = 10
  }

  const state = createCharacterState({
    baseAttributes,
    tracks: {
      class: { level: classLevel, quarter: 0, definitionId: "class-def" },
      profession: {
        level: professionLevel,
        quarter: 0,
        definitionId: "prof-def",
      },
    },
    race: { level: raceLevel, grade: raceGrade, mode: raceMode },
  })

  if (opts.intLevel != null) baseAttributes.intelligence = opts.intLevel
  if (opts.dexLevel != null) baseAttributes.agility = opts.dexLevel

  return state
}

export function config(overrides: Partial<RulesConfig> = {}): RulesConfig {
  return {
    ...defaultRulesConfig(),
    ...overrides,
  }
}

export function trackDef(id: string, fixed: PartialVector, free: number) {
  return { id, name: id, fixed, free }
}
