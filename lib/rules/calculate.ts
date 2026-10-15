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
  type DerivedResource,
  type DerivedStatBreakdown,
  type DerivedStats,
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
): {
  applied: AttributeVector
  flatApplied: AttributeVector
  percentApplied: AttributeVector
  percentRequested: AttributeVector
  status: EquipmentStatus
} {
  const individualPct = config.equipmentIndividualCapPercent
  const overallPct = config.equipmentCombinedCapPercent

  const reasonsByItem = new Map<string, Map<Attribute, string[]>>()
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

  const capUsage: CapUsage[] = []

  /* ------------------------------------------------------------------ *
   * Flat equipment contribution (existing capping logic, preserved).
   * ------------------------------------------------------------------ */

  const flatRequested = zeroVector()
  // Per-attribute, per-source flat requested contribution (for apportionment).
  const flatContributions: Array<
    Array<{ id: string; name: string; amount: number }>
  > = ATTRIBUTES.map(() => [])
  for (const item of items) {
    for (const attr of ATTRIBUTES) {
      const amount =
        typeof item.bonus[attr] === "number" ? (item.bonus[attr] as number) : 0
      if (amount === 0) continue
      flatContributions[ATTRIBUTES.indexOf(attr)].push({
        id: item.id,
        name: item.name,
        amount,
      })
      flatRequested[attr] += amount
    }
  }

  // Overall cap: 15% of the SUM of all pre-equipment attribute values.
  const sumRef = vectorSum(ref)
  const overallCap = Math.floor((sumRef * overallPct) / 100)

  // Per-attribute aggregate cap (20%): the SUM of equipment bonuses on a single
  // attribute may not exceed 20% of that attribute's pre-equipment value. This is
  // NOT a per-item cap. Items are never individually clamped. `indivCap` is
  // computed for EVERY attribute (even ones with no flat request) so the percent
  // phase can use the per-attribute budget that flat did not consume.
  const cappedAttr = zeroVector()
  const indivCap = zeroVector()
  for (const attr of ATTRIBUTES) {
    indivCap[attr] = Math.floor((ref[attr] * individualPct) / 100)
  }
  for (const attr of ATTRIBUTES) {
    if (flatRequested[attr] === 0) continue
    cappedAttr[attr] = Math.min(flatRequested[attr], indivCap[attr])
    capUsage.push({
      name: "equipment-individual",
      attribute: attr,
      cap: indivCap[attr],
      requested: flatRequested[attr],
      applied: cappedAttr[attr],
      suppressed: flatRequested[attr] - cappedAttr[attr],
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

  // Per-attribute, per-source flat applied contribution (populated from the actual
  // apportionment so per-item status is internally consistent).
  const sourceApplied = new Map<
    Attribute,
    Map<string, { requested: number; applied: number; name: string }>
  >()
  const flatApplied = zeroVector()
  for (const attr of ATTRIBUTES) {
    const list = flatContributions[ATTRIBUTES.indexOf(attr)]
    if (list.length === 0) continue
    const attrRequested = flatRequested[attr]
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
    flatApplied[attr] = attrBudget
  }

  /* ------------------------------------------------------------------ *
   * Percent equipment contribution (shares the flat cap budgets).
   *
   * Each item's per-attribute percent request is
   *   floor((ref[attr] + flatApplied[attr]) * basisPoints / 10000)
   * (never compounded onto another item's percent, clamped to >= 0 when the base
   * is negative). The requests are capped by the REMAINING per-attribute and
   * overall budgets - the flat applied portion of each budget is consumed first -
   * using the same deterministic largest-remainder apportionment and tie ordering
   * as the flat phase. This intentionally does NOT run as a generic pre-equipment
   * percent phase, which would bypass the equipment caps entirely.
   * ------------------------------------------------------------------ */

  const percentRequested = zeroVector()
  const percentContributions: Array<
    Array<{ id: string; name: string; amount: number }>
  > = ATTRIBUTES.map(() => [])
  for (const item of items) {
    const pct = item.percentBasisPoints ?? {}
    for (const attr of ATTRIBUTES) {
      const bp = typeof pct[attr] === "number" ? (pct[attr] as number) : 0
      if (bp === 0) continue
      const base = ref[attr] + flatApplied[attr]
      const amount = Math.max(0, Math.floor((base * bp) / 10000))
      if (amount === 0) continue
      percentContributions[ATTRIBUTES.indexOf(attr)].push({
        id: item.id,
        name: item.name,
        amount,
      })
      percentRequested[attr] += amount
    }
  }

  // Remaining budgets after the flat phase consumed its share.
  const remIndividualCap = zeroVector()
  for (const attr of ATTRIBUTES) {
    remIndividualCap[attr] = Math.max(0, indivCap[attr] - flatApplied[attr])
  }
  const remOverallCap = Math.max(0, overallCap - vectorSum(flatApplied))

  const percentCappedAttr = zeroVector()
  for (const attr of ATTRIBUTES) {
    if (percentRequested[attr] === 0) continue
    percentCappedAttr[attr] = Math.min(
      percentRequested[attr],
      remIndividualCap[attr]
    )
    capUsage.push({
      name: "equipment-percent-individual",
      attribute: attr,
      cap: remIndividualCap[attr],
      requested: percentRequested[attr],
      applied: percentCappedAttr[attr],
      suppressed: percentRequested[attr] - percentCappedAttr[attr],
    })
  }

  const percentSumCapped = vectorSum(percentCappedAttr)
  const percentAttrApplied = zeroVector()
  if (percentSumCapped <= remOverallCap) {
    for (const attr of ATTRIBUTES)
      percentAttrApplied[attr] = percentCappedAttr[attr]
  } else {
    const dist = apportionLargestRemainder(
      remOverallCap,
      ATTRIBUTES.map((attr) => percentCappedAttr[attr]),
      (i) => i
    )
    for (let i = 0; i < ATTRIBUTES.length; i++)
      percentAttrApplied[ATTRIBUTES[i]] = dist[i]
    capUsage.push({
      name: "equipment-percent-overall",
      attribute: null,
      cap: remOverallCap,
      requested: percentSumCapped,
      applied: remOverallCap,
      suppressed: percentSumCapped - remOverallCap,
    })
  }

  const percentSourceApplied = new Map<
    Attribute,
    Map<string, { requested: number; applied: number; name: string }>
  >()
  const percentApplied = zeroVector()
  for (const attr of ATTRIBUTES) {
    const list = percentContributions[ATTRIBUTES.indexOf(attr)]
    if (list.length === 0) continue
    const attrRequested = percentRequested[attr]
    const attrBudget = percentAttrApplied[attr]
    const itemApplied = apportionLargestRemainder(
      attrBudget,
      list.map((c) => c.amount),
      (i) => i
    )
    const individualSuppressed = attrRequested - percentCappedAttr[attr]
    const overallSuppressed = percentCappedAttr[attr] - percentAttrApplied[attr]
    let per = percentSourceApplied.get(attr)
    if (!per) {
      per = new Map()
      percentSourceApplied.set(attr, per)
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
          `equipment-percent individual cap ${individualPct}% per-attribute aggregate remaining (${remIndividualCap[attr]}) applied`
        )
      }
      if (overallSuppressed > 0) {
        pushReason(
          list[i].id,
          attr,
          `equipment-percent overall cap ${overallPct}% of total remaining (${remOverallCap}) applied`
        )
      }
    }
    percentApplied[attr] = attrBudget
  }

  /* ------------------------------------------------------------------ *
   * Combine the flat + percent contributions into a single status.
   * ------------------------------------------------------------------ */

  const requested = zeroVector()
  const applied = zeroVector()
  const suppressed = zeroVector()
  for (const attr of ATTRIBUTES) {
    requested[attr] = flatRequested[attr] + percentRequested[attr]
    applied[attr] = flatApplied[attr] + percentApplied[attr]
    suppressed[attr] = requested[attr] - applied[attr]
  }

  // Build per-item combined status (flat + percent) from both applied maps.
  const itemStatus: EquipmentItemStatus[] = []
  for (const item of items) {
    const req = zeroVector()
    const app = zeroVector()
    const sup = zeroVector()
    const pct = item.percentBasisPoints ?? {}
    for (const attr of ATTRIBUTES) {
      const flatR =
        typeof item.bonus[attr] === "number" ? (item.bonus[attr] as number) : 0
      const flatEntry = sourceApplied.get(attr)?.get(item.id)
      const flatA = flatEntry?.applied ?? 0
      const bp = typeof pct[attr] === "number" ? (pct[attr] as number) : 0
      const percentR =
        bp === 0
          ? 0
          : Math.max(
              0,
              Math.floor(((ref[attr] + flatApplied[attr]) * bp) / 10000)
            )
      const percentEntry = percentSourceApplied.get(attr)?.get(item.id)
      const percentA = percentEntry?.applied ?? 0
      req[attr] = flatR + percentR
      app[attr] = flatA + percentA
      sup[attr] = req[attr] - app[attr]
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

  const status: EquipmentStatus = {
    requested,
    applied,
    suppressed,
    items: itemStatus,
    capUsage,
  }

  return {
    applied,
    flatApplied,
    percentApplied,
    percentRequested,
    status,
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
 * Derived HP / MP / SP maxima
 *
 * Authoritative maxima for the three core pools, derived from the FINAL
 * attributes after every phase (including temporary effects). Always present
 * and never null, unlike the legacy configurable `resources` engine. These are
 * deliberately independent of the equipment 20%/15% attribute cap budgets and
 * never compound across items: the percentage basis points are summed across
 * all equipment and applied once to the positive (base + flat) value.
 * ------------------------------------------------------------------ */

/** Which canonical attribute drives each derived resource's base value. */
const DERIVED_RESOURCE_ATTRIBUTE: Record<DerivedResource, Attribute> = {
  hp: "vitality",
  mp: "wisdom",
  sp: "endurance",
}

function deriveOneResource(
  finalAttributes: AttributeVector,
  equipment: EquipmentBonus[],
  resource: DerivedResource
): DerivedStatBreakdown {
  const attribute = DERIVED_RESOURCE_ATTRIBUTE[resource]
  const base = finalAttributes[attribute] * 10
  let flat = 0
  let percentBasisPoints = 0
  for (const item of equipment) {
    flat += item.derivedFlat?.[resource] ?? 0
    percentBasisPoints += item.derivedPercentBasisPoints?.[resource] ?? 0
  }
  const effectiveBase = Math.max(0, base + flat)
  const percentApplied = Math.floor(
    (effectiveBase * percentBasisPoints) / 10000
  )
  const max = Math.max(0, base + flat + percentApplied)
  return { attribute, base, flat, percentBasisPoints, percentApplied, max }
}

export function computeDerivedStats(
  finalAttributes: AttributeVector,
  equipment: EquipmentBonus[]
): DerivedStats {
  const hp = deriveOneResource(finalAttributes, equipment, "hp")
  const mp = deriveOneResource(finalAttributes, equipment, "mp")
  const sp = deriveOneResource(finalAttributes, equipment, "sp")
  return { hp: hp.max, mp: mp.max, sp: sp.max, breakdown: { hp, mp, sp } }
}

/* ------------------------------------------------------------------ *
 * Historical fixed source per track (race / class / profession)
 * ------------------------------------------------------------------ */

/**
 * The applicable tracks for splitting a genuinely unknown legacy award track,
 * in deterministic Race, Class, Profession order. A monster (independent race
 * mode) is race-only; an enlightened (derived) character always includes race
 * and adds any present class / profession tracks, omitting absent ones.
 */
function applicableTracksForSplit(
  state: CharacterState
): Array<"race" | "class" | "profession"> {
  const list: Array<"race" | "class" | "profession"> = ["race"]
  if (state.race.mode === "independent") return list
  if (state.tracks["class"]) list.push("class")
  if (state.tracks["profession"]) list.push("profession")
  return list
}

/**
 * Split a signed integer `total` as evenly as possible across `n` buckets, in
 * order, preserving the exact total. The base uses truncation toward zero; the
 * signed remainder is spread one unit per bucket starting from the first, so a
 * negative total distributes its remainder as `-1` to the earliest buckets.
 */
function splitSignedEvenly(total: number, n: number): number[] {
  if (n <= 0) return []
  const base = Math.trunc(total / n)
  const remainder = total - base * n
  const out = new Array<number>(n).fill(base)
  const step = remainder > 0 ? 1 : remainder < 0 ? -1 : 0
  const count = Math.min(Math.abs(remainder), n)
  for (let i = 0; i < count; i++) out[i] += step
  return out
}

function addFixedInto(dest: AttributeVector, src: AttributeVector): void {
  for (const attr of ATTRIBUTES) dest[attr] += src[attr]
}

/**
 * Compute the source of the historical fixed attribute points per track
 * (race / class / profession) from `state.historicalLevelAwards[].fixed`.
 *
 * Known track literals map directly; genuinely unknown legacy track strings are
 * split EACH stat value evenly among the applicable tracks in deterministic
 * Race, Class, Profession order (a monster is race-only; an enlightened
 * character uses race plus any present class/profession tracks, omitting absent
 * ones) using signed-integer remainder apportionment that keeps the exact total.
 * Stored awards are never mutated and free points are never grouped into fixed.
 */
function computeHistoricalFixedByTrack(state: CharacterState): {
  race: AttributeVector
  class: AttributeVector
  profession: AttributeVector
} {
  const race = zeroVector()
  const clazz = zeroVector()
  const profession = zeroVector()
  const buckets: Record<"race" | "class" | "profession", AttributeVector> = {
    race,
    class: clazz,
    profession,
  }

  const targets = applicableTracksForSplit(state)
  const n = targets.length

  for (const award of state.historicalLevelAwards) {
    const track = award.track
    if (track === "race") {
      addFixedInto(buckets.race, award.fixed)
      continue
    }
    if (track === "class") {
      addFixedInto(buckets.class, award.fixed)
      continue
    }
    if (track === "profession") {
      addFixedInto(buckets.profession, award.fixed)
      continue
    }
    // Genuinely unknown legacy track literal: split each stat evenly.
    if (n === 0) continue
    for (const attr of ATTRIBUTES) {
      const split = splitSignedEvenly(award.fixed[attr], n)
      for (let i = 0; i < n; i++) {
        buckets[targets[i]][attr] += split[i]
      }
    }
  }

  return {
    race: buckets.race,
    class: buckets.class,
    profession: buckets.profession,
  }
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

    const eqFlat = equipment.flatApplied[attr]
    value += eqFlat
    phases.push({ phase: "equipment", value, delta: eqFlat })

    // The equipment-percent phase follows the capped flat equipment phase and
    // precedes temporary effects. It is emitted only when an equipment item
    // declared a percent bonus for this attribute, so legacy zero-percent status
    // output stays identical (no phase for an attribute with no percent request).
    if (equipment.percentRequested[attr] !== 0) {
      const eqPct = equipment.percentApplied[attr]
      value += eqPct
      phases.push({ phase: "equipment-percent", value, delta: eqPct })
    }

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
  const derivedStats = computeDerivedStats(attributes, state.equipment)
  const historicalFixedByTrack = computeHistoricalFixedByTrack(state)

  return {
    attributes,
    traces,
    availablePoints,
    totalFreePoints,
    allocatedPoints,
    resources,
    derivedStats,
    equipment: equipment.status,
    consumables,
    capUsage,
    historicalFixedByTrack,
  }
}
