/**
 * Deterministic stat calculation engine.
 *
 * Everything in this module is a pure function of its inputs. Given the same
 * CharacterState and RulesConfig, the output is identical. No randomness, no
 * time dependence (state.turn is explicit), no hidden state.
 *
 * Attribute calculation ordering (documented contract):
 *   initial (base)
 *   + historical fixed awards
 *   + allocations
 *   + permanent gains
 *   + flat effects
 *   ~ percent effects (integer basis points, floors each application)
 *   + equipment (capped: per-attribute aggregate + overall sum)
 *   + temporary effects (consumables use only effect duration; no grade-rate cap)
 *
 * Percent effects are stored and applied as integer basis points; each
 * documented phase floors the result.
 */

import {
  ATTRIBUTES,
  type Attribute,
  type AttributeVector,
  type CharacterState,
  type EffectCondition,
  type EquipmentBonus,
  type GameEffect,
  type Grade,
  type PermanentGain,
  type ResourceStatus,
  type RulesConfig,
  type StatusResult,
  type AttributeTrace,
  type PhaseTrace,
  type CapUsage,
  type EquipmentItemStatus,
  type EquipmentStatus,
  gradeOrderIndex,
  vectorSum,
  zeroVector,
} from "./types"
import { computeConsumables } from "./consumables"

/* ------------------------------------------------------------------ *
 * Effects: activation, conditions, stacking / replacement
 * ------------------------------------------------------------------ */

export function conditionMet(
  condition: EffectCondition | undefined,
  state: CharacterState,
  grade: Grade
): boolean {
  if (!condition) return true
  switch (condition.kind) {
    case "always":
      return true
    case "levelAtLeast": {
      const track = state.tracks[condition.track]
      return !!track && track.level >= condition.level
    }
    case "gradeAtLeast":
      return gradeOrderIndex(grade) >= gradeOrderIndex(condition.grade)
  }
}

function isExpired(effect: GameEffect, state: CharacterState): boolean {
  return effect.expiresAt != null && effect.expiresAt <= state.turn
}

/**
 * Resolve the active effect list: drop expired effects, drop effects whose
 * condition is not met, and apply stacking / replacement groups.
 *
 * Replacement groups: if an effect in a group uses `replace`, only the last
 * (highest insertion index) effect in that group applies. `stack` keeps every
 * effect in the group. `stackCapped` keeps every effect (caps are handled by
 * the consuming phase). Effects without a group are treated as `stack`.
 */
export function resolveActiveEffects(
  effects: GameEffect[],
  state: CharacterState,
  grade: Grade
): GameEffect[] {
  const active = effects.filter(
    (e) => !isExpired(e, state) && conditionMet(e.condition, state, grade)
  )

  const groups = new Map<string, GameEffect[]>()
  const hungrig: GameEffect[] = []
  for (const e of active) {
    if (e.group) {
      const arr = groups.get(e.group)
      if (arr) {
        arr.push(e)
      } else {
        groups.set(e.group, [e])
      }
    } else {
      hungrig.push(e)
    }
  }

  const result: GameEffect[] = [...hungrig]
  for (const arr of groups.values()) {
    const hasReplace = arr.some((e) => e.stacking === "replace")
    if (hasReplace) {
      // Later (higher insertion index) replaces earlier.
      result.push(arr[arr.length - 1])
    } else {
      for (const e of arr) result.push(e)
    }
  }
  return result
}

function sortBySourceId<T extends { source: string; id: string }>(
  arr: T[]
): T[] {
  return [...arr].sort((a, b) =>
    a.source < b.source
      ? -1
      : a.source > b.source
        ? 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0
  )
}

/* ------------------------------------------------------------------ *
 * Percent application
 * ------------------------------------------------------------------ */

/** Apply an integer-basis-point multiplier, flooring the result. */
function applyPercent(value: number, basisPoints: number): number {
  return Math.floor((value * (10000 + basisPoints)) / 10000)
}

/* ------------------------------------------------------------------ *
 * Residential / permanent gain cap
 * ------------------------------------------------------------------ */

export interface PermanentResolution {
  applied: AttributeVector
  rejected: Array<{ id: string; reason: string }>
  capUsage: CapUsage[]
}

/**
 * Resolve the permanent-gains ledger against the cumulative per-grade-band race
 * level caps. A `raceLevel` gain carries a `grade` and a `count` of levels.
 * When a grade band's cumulative `count` exceeds `config.permanentRaceGradeCaps`,
 * the excess gains are rejected whole (later insertion-order gains rejected
 * first). Non-race gains always apply; `buff` and `consumable` gains are
 * permanent and applied verbatim (a `consumable` gain was already capped at
 * application time and is never re-capped by later config changes).
 */
export function resolvePermanentGains(
  state: CharacterState,
  config: RulesConfig
): PermanentResolution {
  const raceGains = state.permanentGains.filter((g) => g.kind === "raceLevel")
  const otherGains = state.permanentGains.filter((g) => g.kind !== "raceLevel")

  const accepted: PermanentGain[] = []
  const rejected: Array<{ id: string; reason: string }> = []
  const capUsage: CapUsage[] = []

  const used = new Map<Grade, number>()
  for (const g of raceGains) {
    const grade = g.grade
    if (!grade) {
      accepted.push(g)
      continue
    }
    const cap = config.permanentRaceGradeCaps[grade]
    const count = g.count ?? 1
    if (cap == null) {
      accepted.push(g)
      used.set(grade, (used.get(grade) ?? 0) + count)
      continue
    }
    const soFar = used.get(grade) ?? 0
    if (soFar + count <= cap) {
      accepted.push(g)
      used.set(grade, soFar + count)
    } else {
      rejected.push({
        id: g.id,
        reason: `exceeds permanent race-level cap ${cap} for grade ${grade}`,
      })
    }
  }

  for (const g of otherGains) accepted.push(g)

  // Build applied vector.
  const applied = zeroVector()
  for (const g of accepted) {
    for (const attr of ATTRIBUTES) {
      const v = g.vector[attr]
      if (typeof v === "number" && Number.isFinite(v)) applied[attr] += v
    }
  }

  for (const grade of used.keys()) {
    const cap = config.permanentRaceGradeCaps[grade]
    if (cap == null) continue
    const appliedCount = used.get(grade) ?? 0
    if (appliedCount > cap) {
      capUsage.push({
        name: "permanent-race-grade",
        attribute: null,
        cap,
        requested: appliedCount,
        applied: cap,
        suppressed: appliedCount - cap,
      })
    }
  }

  return { applied, rejected, capUsage }
}

/* ------------------------------------------------------------------ *
 * Largest remainder apportionment
 * ------------------------------------------------------------------ */

/**
 * Deterministically distributes `total` whole units across `weights`
 * proportionally to each weight, using the largest remainder method. Ties
 * between equal remainders are broken by the supplied tie-break comparator.
 * The result always sums exactly to `total` (when 0 < total <= sum(weights)).
 */
export function apportionLargestRemainder(
  total: number,
  weights: number[],
  tieBreak: (index: number) => number
): number[] {
  const n = weights.length
  const out = new Array<number>(n).fill(0)
  if (n === 0 || total <= 0) return out
  const totalWeight = weights.reduce((a, b) => a + b, 0)
  if (totalWeight <= 0) return out
  if (total >= totalWeight) {
    for (let i = 0; i < n; i++) out[i] = weights[i]
    return out
  }

  const quotas = weights.map((w) => (total * w) / totalWeight)
  const base = quotas.map((q) => Math.floor(q))
  const rem = quotas.map((q, i) => q - base[i])
  const allocated = base.reduce((a, b) => a + b, 0)
  const deficit = total - allocated

  const order = weights
    .map((_, i) => i)
    .sort((x, y) => {
      if (rem[y] !== rem[x]) return rem[y] - rem[x]
      return tieBreak(x) - tieBreak(y)
    })

  let remaining = deficit
  for (const idx of order) {
    if (remaining <= 0) break
    base[idx] += 1
    remaining -= 1
  }
  return base
}

/* ------------------------------------------------------------------ *
 * Equipment caps (house rule: per-attribute aggregate 20% / overall sum 15%)
 *
 * Two caps are enforced, both higher-level assumptions:
 *   - Per-attribute aggregate cap (20%): the SUM of all equipment bonuses on a
 *     single attribute may not exceed 20% of that attribute's pre-equipment
 *     value. This is NOT a per-item cap.
 *   - Overall sum cap (15%): the SUM of effective equipment bonuses across all
 *     attributes may not exceed 15% of the SUM of all pre-equipment values.
 *     This is NOT a per-attribute cap.
 *
 * If the total exceeds the overall cap, the cap is distributed deterministically
 * across attributes and items using a proportional largest-remainder
 * apportionment (ties broken by canonical attribute / equipment order). Traces
 * distinguish individual (per-attribute aggregate) suppression from overall
 * (sum) suppression; there is no per-item cap.
 * ------------------------------------------------------------------ */

export function applyEquipmentCaps(
  ref: AttributeVector,
  items: EquipmentBonus[],
  config: RulesConfig
): { applied: AttributeVector; status: EquipmentStatus } {
  const requested = zeroVector()
  const applied = zeroVector()
  const suppressed = zeroVector()
  const itemStatus: EquipmentItemStatus[] = []
  const capUsage: CapUsage[] = []
  const reasonsByItem = new Map<string, Map<Attribute, string[]>>()
  // Per-attribute, per-source applied contribution (populated from the actual
  // apportionment so per-item status is internally consistent).
  const sourceApplied = new Map<
    Attribute,
    Map<string, { requested: number; applied: number; name: string }>
  >()

  const pushReason = (itemId: string, attr: Attribute, reason: string) => {
    let m = reasonsByItem.get(itemId)
    if (!m) {
      m = new Map()
      reasonsByItem.set(itemId, m)
    }
    const arr = m.get(attr)
    if (arr) arr.push(reason)
    else m.set(attr, [reason])
  }

  const individualPct = config.equipmentIndividualCapPercent
  const overallPct = config.equipmentCombinedCapPercent

  // Collect the raw requested contribution per attribute, keyed by item so the
  // apportionment can be attributed back for per-item status.
  const contributions: Array<
    Array<{ id: string; name: string; amount: number }>
  > = ATTRIBUTES.map(() => [])
  for (const item of items) {
    for (const attr of ATTRIBUTES) {
      const amount =
        typeof item.bonus[attr] === "number" ? (item.bonus[attr] as number) : 0
      if (amount === 0) continue
      contributions[ATTRIBUTES.indexOf(attr)].push({
        id: item.id,
        name: item.name,
        amount,
      })
      requested[attr] += amount
    }
  }

  // Overall cap: 15% of the SUM of all pre-equipment attribute values.
  const sumRef = vectorSum(ref)
  const overallCap = Math.floor((sumRef * overallPct) / 100)

  // Per-attribute aggregate cap (20%): the SUM of equipment bonuses on a single
  // attribute may not exceed 20% of that attribute's pre-equipment value. This is
  // NOT a per-item cap. Items are never individually clamped.
  const cappedAttr = zeroVector()
  const indivCap = zeroVector()
  for (const attr of ATTRIBUTES) {
    if (requested[attr] === 0) continue
    indivCap[attr] = Math.floor((ref[attr] * individualPct) / 100)
    cappedAttr[attr] = Math.min(requested[attr], indivCap[attr])
    capUsage.push({
      name: "equipment-individual",
      attribute: attr,
      cap: indivCap[attr],
      requested: requested[attr],
      applied: cappedAttr[attr],
      suppressed: requested[attr] - cappedAttr[attr],
    })
  }

  const sumCapped = vectorSum(cappedAttr)
  const attrApplied = zeroVector()
  if (sumCapped <= overallCap) {
    for (const attr of ATTRIBUTES) attrApplied[attr] = cappedAttr[attr]
  } else {
    // Distribute the overall cap deterministically across attributes with a
    // proportional largest-remainder apportionment, weighted by each attribute's
    // post-individual-cap contribution. Ties are broken by canonical attribute
    // order.
    const dist = apportionLargestRemainder(
      overallCap,
      ATTRIBUTES.map((attr) => cappedAttr[attr]),
      (i) => i
    )
    for (let i = 0; i < ATTRIBUTES.length; i++)
      attrApplied[ATTRIBUTES[i]] = dist[i]
    capUsage.push({
      name: "equipment-overall",
      attribute: null,
      cap: overallCap,
      requested: sumCapped,
      applied: overallCap,
      suppressed: sumCapped - overallCap,
    })
  }

  // Distribute each attribute's applied budget across the items that contributed
  // to it, using the same deterministic largest-remainder apportionment. Ties are
  // broken by equipment array order (stable).
  for (const attr of ATTRIBUTES) {
    const list = contributions[ATTRIBUTES.indexOf(attr)]
    if (list.length === 0) continue
    const attrRequested = requested[attr]
    const attrBudget = attrApplied[attr]
    const itemApplied = apportionLargestRemainder(
      attrBudget,
      list.map((c) => c.amount),
      (i) => i
    )
    // Distinguish individual (per-attribute aggregate) from overall (sum)
    // suppression so the traces are unambiguous.
    const individualSuppressed = attrRequested - cappedAttr[attr]
    const overallSuppressed = cappedAttr[attr] - attrApplied[attr]
    let per = sourceApplied.get(attr)
    if (!per) {
      per = new Map()
      sourceApplied.set(attr, per)
    }
    for (let i = 0; i < list.length; i++) {
      per.set(list[i].id, {
        requested: list[i].amount,
        applied: itemApplied[i],
        name: list[i].name,
      })
      if (individualSuppressed > 0) {
        pushReason(
          list[i].id,
          attr,
          `individual cap ${individualPct}% per-attribute aggregate (${indivCap[attr]}) applied`
        )
      }
      if (overallSuppressed > 0) {
        pushReason(
          list[i].id,
          attr,
          `overall cap ${overallPct}% of total pre-equipment (${overallCap}) applied`
        )
      }
    }
    applied[attr] = attrBudget
    suppressed[attr] = attrRequested - attrBudget
  }

  // Build per-item status from the per-attribute per-source applied map.
  for (const item of items) {
    const req = zeroVector()
    const app = zeroVector()
    const sup = zeroVector()
    for (const attr of ATTRIBUTES) {
      const r =
        typeof item.bonus[attr] === "number" ? (item.bonus[attr] as number) : 0
      req[attr] = r
      const per = sourceApplied.get(attr)
      const entry = per?.get(item.id)
      const a = entry?.applied ?? 0
      app[attr] = a
      sup[attr] = r - a
    }

    const reasons: string[] = []
    const byAttr = reasonsByItem.get(item.id)
    if (byAttr) {
      for (const attr of ATTRIBUTES) {
        const rs = byAttr.get(attr)
        if (rs) for (const r of rs) reasons.push(`${attr}: ${r}`)
      }
    }

    itemStatus.push({
      id: item.id,
      name: item.name,
      requested: req,
      applied: app,
      suppressed: sup,
      reasons,
    })
  }

  return {
    applied,
    status: {
      requested,
      applied,
      suppressed,
      items: itemStatus,
      capUsage,
    },
  }
}

/* ------------------------------------------------------------------ *
 * Resources
 * ------------------------------------------------------------------ */

export function computeResources(
  state: CharacterState,
  config: RulesConfig,
  finalAttributes: AttributeVector
): ResourceStatus[] {
  const ids = Object.keys(state.currentResources)
  const out: ResourceStatus[] = []

  for (const id of ids) {
    const formula = config.resourceFormulas?.[id]
    const multiplier = config.resourceMultipliers?.[id] ?? null
    const current = state.currentResources[id] ?? 0

    if (!formula) {
      out.push({
        id,
        current,
        max: null,
        multiplier,
        provenance: "unresolved: no resource formula",
      })
      continue
    }
    if (multiplier == null) {
      out.push({
        id,
        current,
        max: null,
        multiplier: null,
        provenance: "unresolved: no resource multiplier",
      })
      continue
    }

    let base = formula.constant ?? 0
    for (const attr of ATTRIBUTES) {
      const c = formula.coefficients[attr]
      if (typeof c === "number" && Number.isFinite(c))
        base += c * finalAttributes[attr]
    }
    const max = Math.floor(base * multiplier)
    out.push({
      id,
      current,
      max,
      multiplier,
      provenance: "assumption: resource multiplier",
    })
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Main status calculation
 * ------------------------------------------------------------------ */

export function calculateStatus(
  state: CharacterState,
  config: RulesConfig
): StatusResult {
  const grade = state.race.grade
  const active = resolveActiveEffects(state.activeEffects, state, grade)
  const flatEffects = sortBySourceId(active.filter((e) => e.phase === "flat"))
  const percentEffects = sortBySourceId(
    active.filter((e) => e.phase === "percent")
  )
  const temporaryEffects = active.filter((e) => e.phase === "temporary")
  const consumableEffects = temporaryEffects.filter(
    (e) => e.source === "consumable"
  )
  const otherTemporaryEffects = temporaryEffects.filter(
    (e) => e.source !== "consumable"
  )

  const permanent = resolvePermanentGains(state, config)
  const consumables = computeConsumables(consumableEffects, grade, config)

  // Phase 1: compute value after permanent + flat + percent (pre-equipment ref).
  const ref = zeroVector()
  const flatVals = zeroVector()
  const percentVals = zeroVector()

  for (const attr of ATTRIBUTES) {
    let v = state.baseAttributes[attr]
    // historical fixed
    for (const a of state.historicalLevelAwards) v += a.fixed[attr]
    // allocations
    for (const al of state.allocations) v += al.points[attr]
    // permanent (capped)
    v += permanent.applied[attr]

    let flat = 0
    for (const e of flatEffects) {
      const amt = e.amount[attr]
      if (typeof amt === "number" && Number.isFinite(amt)) flat += amt
    }
    flatVals[attr] = flat
    v += flat

    let pct = v
    for (const e of percentEffects) {
      const bp = e.basisPoints[attr] ?? 0
      if (bp === 0) continue
      pct = applyPercent(pct, bp)
    }
    percentVals[attr] = pct
    ref[attr] = pct
  }

  // Phase 2: equipment caps use the pre-equipment value (after percent) as ref.
  const equipment = applyEquipmentCaps(ref, state.equipment, config)

  // Phase 3: final totals with traces.
  const traces: AttributeTrace[] = []
  const attributes = zeroVector()
  const capUsage: CapUsage[] = [
    ...permanent.capUsage,
    ...consumables.capUsage,
    ...equipment.status.capUsage,
  ]

  for (const attr of ATTRIBUTES) {
    const phases: PhaseTrace[] = []
    let value = 0
    const baseVal = state.baseAttributes[attr]

    let hist = 0
    for (const a of state.historicalLevelAwards) hist += a.fixed[attr]

    let alloc = 0
    for (const al of state.allocations) alloc += al.points[attr]

    const permApplied = permanent.applied[attr]

    value = baseVal
    phases.push({ phase: "initial", value, delta: baseVal })
    value += hist
    phases.push({ phase: "historical-fixed", value, delta: hist })
    value += alloc
    phases.push({ phase: "allocation", value, delta: alloc })
    value += permApplied
    phases.push({ phase: "permanent", value, delta: permApplied })
    value += flatVals[attr]
    phases.push({ phase: "flat", value, delta: flatVals[attr] })
    const pctDelta = percentVals[attr] - value
    value = percentVals[attr]
    phases.push({ phase: "percent", value, delta: pctDelta })

    const eqApplied = equipment.applied[attr]
    value += eqApplied
    phases.push({ phase: "equipment", value, delta: eqApplied })

    let tempDelta = consumables.applied[attr]
    for (const e of otherTemporaryEffects) {
      const amt = e.amount[attr]
      if (typeof amt === "number" && Number.isFinite(amt)) tempDelta += amt
    }
    value += tempDelta
    phases.push({ phase: "temporary", value, delta: tempDelta })

    attributes[attr] = value
    traces.push({ attribute: attr, phases, final: value })
  }

  // Available points.
  let totalFreePoints = 0
  for (const a of state.historicalLevelAwards) totalFreePoints += a.free
  let allocatedPoints = 0
  for (const al of state.allocations) {
    for (const attr of ATTRIBUTES) allocatedPoints += al.points[attr]
  }
  const availablePoints = totalFreePoints - allocatedPoints

  const resources = computeResources(state, config, attributes)

  return {
    attributes,
    traces,
    availablePoints,
    totalFreePoints,
    allocatedPoints,
    resources,
    equipment: equipment.status,
    consumables,
    capUsage,
  }
}
