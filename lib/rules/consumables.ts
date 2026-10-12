/**
 * Consumables engine.
 *
 * Consumables are modeled as temporary effects. The grade-based rates
 * (assumption: F3 / E5 / D15 / C45, from `docs/rules/assumptions.md`) are used
 * as cumulative caps: a character may benefit from at most `rate` units of
 * consumable-derived bonus per attribute, keyed by the character's current
 * grade. Anything above the cap is suppressed and reported.
 *
 * These are house assumptions, not canon, so the output provenance tags them as
 * assumptions.
 */

import {
  ATTRIBUTES,
  type CharacterState,
  type ConsumableStatus,
  type GameEffect,
  type Grade,
  type PartialVector,
  type RulesConfig,
  type CapUsage,
  type TrackId,
  zeroVector,
} from "./types"

/** A discrete consumable definition consumed by a participant. */
export interface ConsumableDef {
  id: string
  name: string
  /** Stacking group for the resulting effect. */
  group: string
  /** Base attribute bonus before grade scaling. */
  amount: PartialVector
  /** Number of quarters the effect lasts; null/undefined = permanent until replaced. */
  durationQuarters?: number
  /** Grade at which the consumable was crafted/consumed (for provenance). */
  grade?: Grade
}

/** The cap for a grade, or the configured fallback rate. */
export function consumableCapForGrade(
  grade: Grade,
  config: RulesConfig
): number {
  const rate =
    config.consumableGradeRates[grade] ?? config.consumableFallbackRate
  if (!Number.isFinite(rate) || rate < 0) {
    throw new Error(
      `consumableCapForGrade: negative or non-finite rate ${rate} for grade ${grade}`
    )
  }
  return rate
}

/**
 * Convert a consumed consumable into a temporary GameEffect. The effect is
 * assigned the character's current grade so the cumulative cap reflects the
 * character's present grade band (documented house rule).
 */
export function consumableToEffect(
  consumable: ConsumableDef,
  state: CharacterState
): GameEffect {
  if (
    typeof consumable.durationQuarters === "number" &&
    (!Number.isInteger(consumable.durationQuarters) ||
      consumable.durationQuarters < 0)
  ) {
    throw new Error(
      `consumableToEffect: durationQuarters must be a non-negative integer (got ${consumable.durationQuarters})`
    )
  }
  const expiresAt =
    typeof consumable.durationQuarters === "number"
      ? state.turn + consumable.durationQuarters
      : undefined
  return {
    id: consumable.id,
    source: "consumable",
    provenance: "assumption: consumable grade rate",
    phase: "temporary",
    amount: consumable.amount,
    group: consumable.group,
    stacking: "stackCapped",
    expiresAt,
  }
}

/**
 * Compute the consumable status for a set of active temporary consumable
 * effects, applying the cumulative grade-rate cap per attribute.
 */
export function computeConsumables(
  effects: GameEffect[],
  grade: Grade,
  config: RulesConfig
): ConsumableStatus {
  const rate = consumableCapForGrade(grade, config)

  const requested = zeroVector()
  const applied = zeroVector()
  const suppressed = zeroVector()
  const capUsage: CapUsage[] = []

  for (const e of effects) {
    if (e.phase !== "temporary") continue
    for (const attr of ATTRIBUTES) {
      const v = e.amount[attr]
      if (typeof v === "number" && Number.isFinite(v)) requested[attr] += v
    }
  }

  for (const attr of ATTRIBUTES) {
    const req = requested[attr]
    if (req <= 0) continue
    const cap = rate
    const app = Math.min(req, cap)
    applied[attr] = app
    suppressed[attr] = req - app
    capUsage.push({
      name: "consumable-cumulative",
      attribute: attr,
      cap,
      requested: req,
      applied: app,
      suppressed: req - app,
    })
  }

  return { requested, applied, suppressed, capUsage }
}

/** Convenience: consume a def, returning the resulting temporary effect. */
export function consume(
  consumable: ConsumableDef,
  state: CharacterState
): GameEffect {
  return consumableToEffect(consumable, state)
}

/**
 * Helper to resolve a character's current grade for the consumable cap. Exposed
 * so callers and tests can look it up without importing the whole engine.
 */
export function currentConsumableGrade(state: CharacterState): Grade {
  return state.race.grade
}

/** Re-export type used elsewhere for convenience. */
export type { TrackId }
