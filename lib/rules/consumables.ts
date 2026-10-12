/**
 * Consumables engine.
 *
 * Consumable semantics are split into two distinct concerns:
 *
 * 1. **Permanent external stat gains.** The grade-based rates (assumption:
 *    F3 / E5 / D15 / C45, from `docs/rules/assumptions.md`) are PER-LEVEL rates
 *    applied to permanent external stat gains acquired from consumables. The
 *    cumulative capacity for an attribute is the sum of these rates across every
 *    positive race level attained through the grade bands. They are enforced at
 *    application time (`applyPermanentConsumable`) and reserved in the
 *    permanent-gains ledger; they are NOT a cap on temporary potions.
 * 2. **Temporary potion effects.** A consumed potion produces a temporary
 *    effect that lasts only its effect duration and is NOT capped by the F3 / E5
 *    / D15 / C45 grade rates. `computeConsumables` therefore reports requested
 *    equal to applied and an empty `capUsage` for active temporary effects.
 *
 * The grade rates are house assumptions, not canon, so the output provenance tags
 * them as assumptions.
 */

import {
  ATTRIBUTES,
  type AttributeVector,
  type CharacterState,
  type ConsumableStatus,
  type GameEffect,
  type Grade,
  type PartialVector,
  type PermanentGain,
  type RulesConfig,
  type TrackId,
  gradeForLevel,
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

/**
 * The per-level permanent rate for a grade, or the configured fallback rate.
 * This is the amount of permanent consumable capacity granted per race level
 * attained while in the grade band. Unknown grades with no configured rate and
 * no positive fallback behave as rate 0.
 */
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

export interface PermanentConsumableCapOptions {
  /**
   * Provenance of the starting grade. A `born` race enters at F-grade and counts
   * levels 1..9 at the F rate (not the G rate), resolving the G/F band overlap.
   * Defaults to `"integrated"`, which counts levels 1..9 at the G rate.
   */
  origin?: "born" | "integrated"
}

/**
 * Derive the per-attribute permanent consumable capacity for a race level by
 * summing the per-level grade rate across every positive race level attained.
 *
 * Band mapping (using the configured grade table):
 *   - G 1..9        rate 0 unless configured (born-F overrides to the F rate)
 *   - F 10..24      rate 3
 *   - E 25..99      rate 5
 *   - D 100..199    rate 15
 *   - C 200..349    rate 45
 *   - B / A / S     rate 0 unless configured (unknown grades reject positive gains)
 *
 * A `born` race counts levels 1..9 at the F rate according to its origin rather
 * than the G grade rate, because the overlapping G/F bands are resolved by
 * provenance (see `docs/rules/assumptions.md`).
 *
 * The resulting capacity is identical for every attribute: it is the total
 * number of permanent consumable units an attribute may carry at this race level.
 */
export function permanentConsumableCap(
  raceLevel: number,
  config: RulesConfig,
  options: PermanentConsumableCapOptions = {}
): AttributeVector {
  if (!Number.isInteger(raceLevel) || raceLevel < 0) {
    throw new Error(
      `permanentConsumableCap: raceLevel must be a non-negative integer (got ${raceLevel})`
    )
  }
  const origin = options.origin ?? "integrated"
  let total = 0
  for (let level = 1; level <= raceLevel; level++) {
    total += rateForLevel(level, config, origin)
  }
  const cap = zeroVector()
  for (const attr of ATTRIBUTES) cap[attr] = total
  return cap
}

/** The per-level permanent rate for a single race level, resolving G/F overlap. */
function rateForLevel(
  level: number,
  config: RulesConfig,
  origin: "born" | "integrated"
): number {
  const grade = gradeForLevel(level, config.gradeTable)
  // A born race never starts in G-grade; its levels 1..9 count the F rate.
  const effectiveGrade = grade === "G" && origin === "born" ? "F" : grade
  if (!effectiveGrade) {
    // Level outside every published band (e.g. beyond S): no rate unless a
    // positive fallback is explicitly configured.
    return config.consumableFallbackRate
  }
  return consumableCapForGrade(effectiveGrade, config)
}

/**
 * Convert a consumable def into a temporary GameEffect. Temporary potion effects
 * use only their effect duration and are NOT capped by the grade rates.
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
 * effects. Temporary effects are only bounded by their effect duration, so the
 * requested amount is applied in full and `capUsage` is empty. A separately
 * configured cap (none exists by default) could populate `capUsage` later; the
 * structure is left in place for that case.
 */
export function computeConsumables(
  effects: GameEffect[],
  _grade: Grade,
  _config: RulesConfig
): ConsumableStatus {
  // `_grade` and `_config` are reserved for an optional, explicitly configured
  // temporary-consumable cap; by default temporary effects are uncapped, so no
  // cap usage is emitted and requested equals applied.
  void _grade
  void _config
  const requested = zeroVector()
  for (const e of effects) {
    if (e.phase !== "temporary") continue
    for (const attr of ATTRIBUTES) {
      const v = e.amount[attr]
      if (typeof v === "number" && Number.isFinite(v)) requested[attr] += v
    }
  }

  return {
    requested,
    applied: { ...requested },
    suppressed: zeroVector(),
    capUsage: [],
  }
}

/** Fully populate the sparse, non-negative integer request into a full vector. */
function materializeRequest(requested: PartialVector): AttributeVector {
  const out = zeroVector()
  for (const attr of ATTRIBUTES) {
    const v = requested[attr]
    if (typeof v === "number" && Number.isFinite(v) && v !== 0) out[attr] = v
  }
  return out
}

/** Represent a full vector as a sparse non-zero `PartialVector`. */
function toSparse(vec: AttributeVector): PartialVector {
  const out: PartialVector = {}
  for (const attr of ATTRIBUTES) {
    if (vec[attr] !== 0) out[attr] = vec[attr]
  }
  return out
}

/**
 * Resolve the provenance origin for the permanent-consumable cap.
 *
 * A recorded origin is authoritative. A legacy state with no recorded origin
 * (created before `race.origin` was tracked) defaults conservatively to
 * "integrated", never to "born". In a born race every low level (1..9) counts
 * at the F rate, which would grant a maximal capacity to a state whose
 * provenance is unknown and silently accept an over-cap permanent gain. The
 * integrated default (G rate for those levels, F rate from level 10) is the
 * safe documented assumption.
 */
function resolveOrigin(state: CharacterState): "born" | "integrated" {
  if (state.race.origin === "born") return "born"
  // Recorded "integrated" and absent/missing both resolve to "integrated".
  return "integrated"
}

/** Current committed permanent-consumable usage per attribute from the ledger. */
function consumableUsed(state: CharacterState): AttributeVector {
  const used = zeroVector()
  for (const g of state.permanentGains) {
    if (g.kind !== "consumable") continue
    for (const attr of ATTRIBUTES) {
      const v = g.vector[attr]
      if (typeof v === "number" && Number.isFinite(v)) used[attr] += v
    }
  }
  return used
}

/** Available permanent-consumable capacity per attribute given the ledger. */
function consumableRemaining(
  state: CharacterState,
  config: RulesConfig
): AttributeVector {
  const cap = permanentConsumableCap(state.race.level, config, {
    origin: resolveOrigin(state),
  })
  const used = consumableUsed(state)
  const remaining = zeroVector()
  for (const attr of ATTRIBUTES) {
    remaining[attr] = Math.max(0, cap[attr] - used[attr])
  }
  return remaining
}

export interface PermanentConsumableApplyResult {
  ok: boolean
  errors: string[]
  state: CharacterState
  entry: PermanentGain | null
  remaining: PartialVector
}

/**
 * Apply a permanent consumable stat gain.
 *
 * The requested gain is rejected atomically (no partial application) if any
 * attribute's request exceeds the remaining permanent-consumable capacity for
 * that attribute, computed from the character's current race level and the
 * committed ledger. On success a new immutable state and a new `consumable`
 * ledger entry are returned along with the post-application remaining capacity.
 *
 * Historical facts are preserved: the applied `vector` is recorded verbatim and
 * never re-capped by later config changes. `capRemainingAfter` snapshots the
 * remaining capacity at the moment of application so the ledger is self-consistent.
 *
 * Multiple distinct consumptions are allowed; each call appends its own entry.
 */
export function applyPermanentConsumable(
  state: CharacterState,
  source: string,
  requested: PartialVector,
  config: RulesConfig
): PermanentConsumableApplyResult {
  const errors: string[] = []

  // Validate the request: every attribute must be a finite, non-negative whole
  // number; reject negative and fractional values. A request that names no
  // attribute is rejected as empty.
  const req = materializeRequest(requested)
  let hasAny = false
  for (const attr of ATTRIBUTES) {
    const v = requested[attr]
    if (v == null) continue
    if (typeof v !== "number" || !Number.isFinite(v)) {
      errors.push(`${attr}: request must be a finite number (got ${String(v)})`)
      continue
    }
    if (!Number.isInteger(v)) {
      errors.push(`${attr}: request must be a whole number (got ${v})`)
      continue
    }
    if (v < 0) {
      errors.push(`${attr}: request cannot be negative (got ${v})`)
      continue
    }
    hasAny = true
  }
  if (!hasAny) {
    errors.push("request is empty (no attribute requested)")
  }
  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      state,
      entry: null,
      remaining: toSparse(consumableRemaining(state, config)),
    }
  }

  const remaining = consumableRemaining(state, config)

  for (const attr of ATTRIBUTES) {
    if (req[attr] > remaining[attr]) {
      errors.push(
        `${attr}: requested ${req[attr]} exceeds remaining permanent-consumable cap (${remaining[attr]})`
      )
    }
  }
  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      state,
      entry: null,
      remaining: toSparse(remaining),
    }
  }

  const after = zeroVector()
  for (const attr of ATTRIBUTES) after[attr] = remaining[attr] - req[attr]

  const entry: PermanentGain = {
    id: `cons-${state.turn}-${state.permanentGains.length}`,
    source,
    kind: "consumable",
    vector: toSparse(req),
    requested: toSparse(req),
    gradeAtApplication: state.race.grade,
    raceLevelAtApplication: state.race.level,
    capRemainingAfter: toSparse(after),
    appliedAt: state.turn,
  }

  const newState: CharacterState = {
    ...state,
    permanentGains: [...state.permanentGains, entry],
  }

  return {
    ok: true,
    errors: [],
    state: newState,
    entry,
    remaining: toSparse(after),
  }
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
