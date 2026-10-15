import { describe, expect, it } from "vitest"
import { calculateStatus } from "./calculate"
import { allocatePoints } from "./progression"
import { character, config, vec } from "./testUtils"
import { makeVector } from "./types"

describe("calculateStatus base pipeline", () => {
  it("returns base attributes when there are no modifiers", () => {
    const state = character()
    const result = calculateStatus(state, config())
    expect(result.attributes.strength).toBe(10)
    expect(result.attributes.agility).toBe(10)
    // All phases after initial are zero deltas.
    const trace = result.traces.find((t) => t.attribute === "strength")
    expect(trace?.phases[0].phase).toBe("initial")
    expect(trace?.phases[0].value).toBe(10)
    expect(trace?.final).toBe(10)
    expect(result.availablePoints).toBe(0)
  })

  it("computes initial + historical fixed + allocation + permanent in order", () => {
    const state = character()
    state.historicalLevelAwards.push({
      track: "class",
      level: 2,
      definitionId: "d",
      fixed: vec({ strength: 5, agility: 3 }),
      free: 0,
    })
    state.allocations.push({
      id: "a1",
      source: "free",
      at: 0,
      points: vec({ strength: 2 }),
    })
    state.permanentGains.push({
      id: "p1",
      source: "path",
      kind: "buff",
      vector: { strength: 4 },
    })

    const result = calculateStatus(state, config())
    expect(result.attributes.strength).toBe(10 + 5 + 2 + 4)
    expect(result.attributes.agility).toBe(10 + 3)
    expect(result.attributes.endurance).toBe(10)
  })

  it("records per-phase traces for each attribute", () => {
    const state = character()
    state.historicalLevelAwards.push({
      track: "class",
      level: 2,
      definitionId: "d",
      fixed: vec({ strength: 5 }),
      free: 0,
    })
    const result = calculateStatus(state, config())
    const trace = result.traces.find((t) => t.attribute === "strength")
    const phases = trace?.phases.map((p) => p.phase) ?? []
    expect(phases).toEqual([
      "initial",
      "historical-fixed",
      "allocation",
      "permanent",
      "flat",
      "percent",
      "equipment",
      "temporary",
    ])
  })
})

describe("available points / allocation", () => {
  it("accumulates free points from historical awards and subtracts allocations", () => {
    const state = character()
    state.historicalLevelAwards.push(
      {
        track: "class",
        level: 1,
        definitionId: "d",
        fixed: vec({ strength: 1 }),
        free: 5,
      },
      {
        track: "class",
        level: 2,
        definitionId: "d",
        fixed: vec({ strength: 1 }),
        free: 6,
      }
    )
    state.allocations.push({
      id: "a1",
      source: "free",
      at: 0,
      points: vec({ strength: 4 }),
    })

    const result = calculateStatus(state, config())
    expect(result.totalFreePoints).toBe(11)
    expect(result.allocatedPoints).toBe(4)
    expect(result.availablePoints).toBe(7)
  })

  it("allocatePoints validates the full available budget", () => {
    const state = character()
    state.historicalLevelAwards.push({
      track: "class",
      level: 1,
      definitionId: "d",
      fixed: vec({ strength: 1 }),
      free: 11,
    })

    // Overspend rejected.
    const over = allocatePoints(state, { strength: 12 })
    expect(over.ok).toBe(false)
    expect(over.errors.length).toBeGreaterThan(0)

    // Full budget accepted.
    const full = allocatePoints(state, { strength: 11 })
    expect(full.ok).toBe(true)
    if (full.state) {
      expect(full.state.allocations.length).toBe(1)
    }
    expect(
      full.state ? calculateStatus(full.state, config()).availablePoints : -1
    ).toBe(0)

    // Negative rejected.
    const neg = allocatePoints(state, { strength: -1 })
    expect(neg.ok).toBe(false)
  })

  it("allocatePoints allows spending less than the available budget", () => {
    const state = character()
    state.historicalLevelAwards.push({
      track: "class",
      level: 1,
      definitionId: "d",
      fixed: vec({ strength: 1 }),
      free: 10,
    })
    const partial = allocatePoints(state, { strength: 4 })
    expect(partial.ok).toBe(true)
    const after = partial.state
      ? calculateStatus(partial.state, config()).availablePoints
      : -1
    expect(after).toBe(6)
  })
})

describe("flat / percent phase ordering", () => {
  it("applies flat before percent, flooring each percent application", () => {
    const state = character()
    state.baseAttributes = makeVector({ strength: 100 })
    state.activeEffects.push({
      id: "flat1",
      source: "buff",
      provenance: "assumption",
      phase: "flat",
      amount: { strength: 10 },
      stacking: "stack",
    })
    state.activeEffects.push({
      id: "pct1",
      source: "buff",
      provenance: "assumption",
      phase: "percent",
      basisPoints: { strength: 1000 },
      stacking: "stack",
    })

    const result = calculateStatus(state, config())
    // 100 -> +10 flat = 110 -> +10% = floor(121) = 121
    expect(result.attributes.strength).toBe(121)
  })

  it("floors after each sequential percent application", () => {
    const state = character()
    state.baseAttributes = makeVector({ strength: 100 })
    state.activeEffects.push(
      {
        id: "pctA",
        source: "buff",
        provenance: "assumption",
        phase: "percent",
        basisPoints: { strength: 1000 },
        stacking: "stack",
      },
      {
        id: "pctB",
        source: "buff",
        provenance: "assumption",
        phase: "percent",
        basisPoints: { strength: 1000 },
        stacking: "stack",
      }
    )
    // Sequential: 100 -> 110 -> 121. (Combined would be 120.)
    const result = calculateStatus(state, config())
    expect(result.attributes.strength).toBe(121)
  })

  it("rounds down on percentage reduction", () => {
    const state = character()
    state.baseAttributes = makeVector({ strength: 100 })
    state.activeEffects.push({
      id: "pctNeg",
      source: "buff",
      provenance: "assumption",
      phase: "percent",
      basisPoints: { strength: -2500 },
      stacking: "stack",
    })
    const result = calculateStatus(state, config())
    expect(result.attributes.strength).toBe(75)
  })
})

describe("equipment caps", () => {
  it("applies per-attribute aggregate and overall caps to the request", () => {
    const state = character()
    state.baseAttributes = makeVector({ strength: 100 })
    state.equipment.push(
      {
        id: "eq1",
        name: "Sword",
        slot: "weapon",
        source: "assumption",
        bonus: { strength: 30 },
      },
      {
        id: "eq2",
        name: "Pauldron",
        slot: "armor",
        source: "assumption",
        bonus: { strength: 30 },
      }
    )

    const result = calculateStatus(state, config())
    expect(result.equipment.requested.strength).toBe(60)
    // ref=100; per-attribute aggregate 20% cap = 20 (NOT per item); overall sum
    // 15% cap (floor(100*0.15)) = 15 total.
    expect(result.equipment.applied.strength).toBe(15)
    expect(result.equipment.suppressed.strength).toBe(45)
    // Attributes reflect only the applied cap.
    expect(result.attributes.strength).toBe(115)

    // Per-item: deterministic largest-remainder apportionment of 15 across
    // [30,30] yields [8,7] (tie on remainder broken by source order).
    const eq1 = result.equipment.items.find((i) => i.id === "eq1")
    const eq2 = result.equipment.items.find((i) => i.id === "eq2")
    expect(eq1?.applied.strength).toBe(8)
    expect(eq2?.applied.strength).toBe(7)
    expect(eq1?.reasons.join(" ")).toContain("individual cap")
    expect(eq1?.reasons.join(" ")).toContain("overall cap")
  })

  it("lets the individual cap bind when it is stricter than the combined cap", () => {
    const state = character()
    state.baseAttributes = makeVector({ strength: 100 })
    state.equipment.push({
      id: "eq1",
      name: "Sword",
      slot: "weapon",
      source: "assumption",
      bonus: { strength: 30 },
    })
    const cfg = config({
      equipmentIndividualCapPercent: 10,
      equipmentCombinedCapPercent: 15,
    })
    const result = calculateStatus(state, cfg)
    // per-attribute aggregate 10% cap = 10 binds before the overall sum 15% cap = 15.
    expect(result.equipment.applied.strength).toBe(10)
    expect(result.attributes.strength).toBe(110)
    expect(result.equipment.items[0].reasons.join(" ")).toContain(
      "individual cap"
    )
  })
})

describe("equipment cap correctness (regression)", () => {
  it("applies the per-attribute cap to the AGGREGATE, not per item", () => {
    const state = character()
    state.baseAttributes = makeVector({ strength: 100 })
    // No single item exceeds 20% of base, but the SUM does. With a per-item cap
    // neither item would be suppressed; with an aggregate per-attribute cap the
    // attribute total is clamped to 20 before the overall cap is applied.
    state.equipment.push(
      {
        id: "eq1",
        name: "Sword",
        slot: "weapon",
        source: "assumption",
        bonus: { strength: 15 },
      },
      {
        id: "eq2",
        name: "Pauldron",
        slot: "armor",
        source: "assumption",
        bonus: { strength: 15 },
      }
    )

    const result = calculateStatus(state, config())
    expect(result.equipment.requested.strength).toBe(30)
    expect(result.equipment.applied.strength).toBe(15)
    expect(result.equipment.suppressed.strength).toBe(15)
    // Individual (per-attribute aggregate) suppression is reported even though no
    // single item exceeds 20% - proving the cap is aggregate, not per-item.
    const eq1 = result.equipment.items.find((i) => i.id === "eq1")
    expect(eq1?.reasons.join(" ")).toContain("individual cap")
    expect(eq1?.reasons.join(" ")).toContain("overall cap")
  })

  it("distributes the overall cap across attributes deterministically and reports it", () => {
    const state = character()
    state.baseAttributes = makeVector({ strength: 100, agility: 100 })
    state.equipment.push(
      {
        id: "sword",
        name: "Sword",
        slot: "weapon",
        source: "assumption",
        bonus: { strength: 40 },
      },
      {
        id: "boots",
        name: "Boots",
        slot: "feet",
        source: "assumption",
        bonus: { agility: 40 },
      }
    )

    const result = calculateStatus(state, config())
    // sumRef = 200 -> overall sum 15% cap = 30. Each attribute is clamped to its
    // 20% aggregate cap (20), so sumCapped = 40 > 30, and 30 is apportioned
    // proportionally across [20, 20] -> [15, 15].
    expect(result.equipment.applied.strength).toBe(15)
    expect(result.equipment.applied.agility).toBe(15)
    expect(result.equipment.suppressed.strength).toBe(25)
    expect(result.equipment.suppressed.agility).toBe(25)
    const overall = result.equipment.capUsage.find(
      (c) => c.name === "equipment-overall"
    )
    expect(overall).toBeDefined()
    expect(overall?.attribute).toBeNull()
    expect(overall?.cap).toBe(30)
    expect(overall?.applied).toBe(30)
    expect(overall?.suppressed).toBe(10)
  })

  it("records distinct individual and overall cap usage entries", () => {
    const state = character()
    state.baseAttributes = makeVector({ strength: 100 })
    state.equipment.push({
      id: "sword",
      name: "Sword",
      slot: "weapon",
      source: "assumption",
      bonus: { strength: 60 },
    })

    const result = calculateStatus(state, config())
    const individual = result.equipment.capUsage.find(
      (c) => c.name === "equipment-individual" && c.attribute === "strength"
    )
    const overall = result.equipment.capUsage.find(
      (c) => c.name === "equipment-overall"
    )
    expect(individual).toBeDefined()
    expect(individual?.cap).toBe(20) // 20% aggregate of strength 100
    expect(individual?.suppressed).toBe(40) // 60 -> 20
    expect(overall).toBeDefined()
    expect(overall?.applied).toBe(15) // 15% of sum(pre-equipment) = 15
  })
})

describe("equipment percent bonuses", () => {
  it("applies equipment percentage after capped flat, sharing the individual budget", () => {
    const state = character()
    state.baseAttributes = makeVector({ strength: 100 })
    state.equipment.push({
      id: "eq1",
      name: "Sword",
      slot: "weapon",
      source: "assumption",
      bonus: { strength: 15 },
      percentBasisPoints: { strength: 1000 }, // 10%
    })
    const cfg = config({
      equipmentIndividualCapPercent: 20,
      equipmentCombinedCapPercent: 30,
    })
    const result = calculateStatus(state, cfg)
    // ref strength = 100 (no other attrs). flat 15 within individual 20.
    const item = result.equipment.items.find((i) => i.id === "eq1")!
    // percent request = floor((100 + 15) * 0.10) = 11.
    // remaining individual = 20 - 15 = 5 -> apply 5, suppress 6.
    expect(item.requested.strength).toBe(15 + 11)
    expect(item.applied.strength).toBe(15 + 5)
    expect(item.suppressed.strength).toBe(6)
    // Aggregated status carries the combined flat + percent contribution.
    expect(result.equipment.requested.strength).toBe(15 + 11)
    expect(result.equipment.applied.strength).toBe(20)
    expect(result.equipment.suppressed.strength).toBe(6)
    // The percent cap is explicitly distinguished from the flat cap.
    const pctIndiv = result.equipment.capUsage.find(
      (c) => c.name === "equipment-percent-individual"
    )
    expect(pctIndiv).toBeDefined()
    expect(pctIndiv?.attribute).toBe("strength")
    expect(pctIndiv?.cap).toBe(5)
    expect(pctIndiv?.requested).toBe(11)
    expect(pctIndiv?.applied).toBe(5)
    expect(pctIndiv?.suppressed).toBe(6)
    expect(item.reasons.join(" ")).toContain("equipment-percent individual cap")
    // The phase trace records flat then percent, before temporary.
    const trace = result.traces.find((t) => t.attribute === "strength")
    const phases = trace?.phases.map((p) => p.phase) ?? []
    expect(phases).toEqual([
      "initial",
      "historical-fixed",
      "allocation",
      "permanent",
      "flat",
      "percent",
      "equipment",
      "equipment-percent",
      "temporary",
    ])
    const eq = trace?.phases.find((p) => p.phase === "equipment")
    const eqPct = trace?.phases.find((p) => p.phase === "equipment-percent")
    expect(eq?.delta).toBe(15)
    expect(eqPct?.delta).toBe(5)
    expect(result.attributes.strength).toBe(100 + 15 + 5)
  })

  it("lets the individual cap bind when the flat bonus fills the budget", () => {
    const state = character()
    state.baseAttributes = makeVector({ strength: 100 })
    state.equipment.push({
      id: "eq1",
      name: "Sword",
      slot: "weapon",
      source: "assumption",
      bonus: { strength: 20 },
      percentBasisPoints: { strength: 1000 }, // 10%
    })
    const cfg = config({ equipmentCombinedCapPercent: 30 })
    const result = calculateStatus(state, cfg)
    // flat 20 fills the 20% individual cap, so the percent base is 120 -> request 12,
    // but the remaining individual budget is 0 -> percent suppressed entirely.
    const item = result.equipment.items.find((i) => i.id === "eq1")!
    expect(item.requested.strength).toBe(20 + 12)
    expect(item.applied.strength).toBe(20)
    expect(item.suppressed.strength).toBe(12)
    const pctIndiv = result.equipment.capUsage.find(
      (c) => c.name === "equipment-percent-individual"
    )
    expect(pctIndiv).toBeDefined()
    expect(pctIndiv?.applied).toBe(0)
    expect(pctIndiv?.suppressed).toBe(12)
    const trace = result.traces.find((t) => t.attribute === "strength")
    const eqPct = trace?.phases.find((p) => p.phase === "equipment-percent")
    expect(eqPct?.delta).toBe(0)
    expect(result.attributes.strength).toBe(120)
  })

  it("lets the overall cap further suppress a percent bonus", () => {
    const state = character()
    state.baseAttributes = makeVector({ strength: 100 })
    state.equipment.push({
      id: "eq1",
      name: "Sword",
      slot: "weapon",
      source: "assumption",
      bonus: { strength: 15 },
      percentBasisPoints: { strength: 1000 }, // 10%
    })
    // Default caps: individual 20%, combined 15%. The flat 15 consumes the entire
    // combined budget (15% of sum 100 = 15), so the percent request is suppressed.
    const result = calculateStatus(state, config())
    const item = result.equipment.items.find((i) => i.id === "eq1")!
    expect(item.applied.strength).toBe(15)
    expect(item.suppressed.strength).toBe(11)
    const pctOverall = result.equipment.capUsage.find(
      (c) => c.name === "equipment-percent-overall"
    )
    expect(pctOverall).toBeDefined()
    expect(pctOverall?.cap).toBe(0)
    expect(pctOverall?.requested).toBe(5)
    expect(pctOverall?.applied).toBe(0)
    expect(pctOverall?.suppressed).toBe(5)
    expect(item.reasons.join(" ")).toContain("equipment-percent overall cap")
    const trace = result.traces.find((t) => t.attribute === "strength")
    const eqPct = trace?.phases.find((p) => p.phase === "equipment-percent")
    expect(eqPct?.delta).toBe(0)
    expect(result.attributes.strength).toBe(115)
  })

  it("allocates percent across multiple items on the same attribute deterministically", () => {
    const state = character()
    state.baseAttributes = makeVector({ strength: 100 })
    state.equipment.push(
      {
        id: "eq1",
        name: "Sword",
        slot: "weapon",
        source: "assumption",
        bonus: { strength: 5 },
        percentBasisPoints: { strength: 1000 }, // 10%
      },
      {
        id: "eq2",
        name: "Pauldron",
        slot: "armor",
        source: "assumption",
        bonus: { strength: 5 },
        percentBasisPoints: { strength: 1000 }, // 10%
      }
    )
    const cfg = config({
      equipmentIndividualCapPercent: 20,
      equipmentCombinedCapPercent: 30,
    })
    const result = calculateStatus(state, cfg)
    // flat 10 total (5 + 5). remaining individual = 20 - 10 = 10. Each item's
    // percent request = floor((100 + 10) * 0.1) = 11 -> aggregate 22, capped to 10.
    // Equal weights [11,11] apportion 10 as [5,5].
    const eq1 = result.equipment.items.find((i) => i.id === "eq1")!
    const eq2 = result.equipment.items.find((i) => i.id === "eq2")!
    expect(eq1.applied.strength).toBe(5 + 5)
    expect(eq2.applied.strength).toBe(5 + 5)
    expect(eq1.suppressed.strength).toBe(6)
    expect(eq2.suppressed.strength).toBe(6)
    expect(result.equipment.applied.strength).toBe(20)
    expect(result.attributes.strength).toBe(120)
  })

  it("contributes no percent when the equipment is disabled (zero caps)", () => {
    const state = character()
    state.baseAttributes = makeVector({ strength: 100 })
    state.equipment.push({
      id: "eq1",
      name: "Sword",
      slot: "weapon",
      source: "assumption",
      bonus: { strength: 15 },
      percentBasisPoints: { strength: 1000 }, // 10%
    })
    const cfg = config({
      equipmentIndividualCapPercent: 0,
      equipmentCombinedCapPercent: 0,
    })
    const result = calculateStatus(state, cfg)
    const item = result.equipment.items.find((i) => i.id === "eq1")!
    // No cap budget exists, so neither flat nor percent applies. The percent base
    // is ref + flatApplied = 100 + 0 (flat is capped to zero), so request = 10.
    expect(item.applied.strength).toBe(0)
    expect(item.requested.strength).toBe(15 + 10)
    expect(item.suppressed.strength).toBe(25)
    expect(result.equipment.applied.strength).toBe(0)
    expect(result.attributes.strength).toBe(100)
  })

  it("keeps legacy zero-percent status identical (no equipment-percent phase)", () => {
    const state = character()
    state.baseAttributes = makeVector({ strength: 100 })
    state.equipment.push({
      id: "eq1",
      name: "Sword",
      slot: "weapon",
      source: "assumption",
      bonus: { strength: 15 },
    })
    const result = calculateStatus(
      state,
      config({ equipmentCombinedCapPercent: 30 })
    )
    const item = result.equipment.items.find((i) => i.id === "eq1")!
    expect(item.requested.strength).toBe(15)
    expect(item.applied.strength).toBe(15)
    expect(item.suppressed.strength).toBe(0)
    expect(result.equipment.requested.strength).toBe(15)
    expect(result.equipment.applied.strength).toBe(15)
    expect(result.equipment.suppressed.strength).toBe(0)
    const trace = result.traces.find((t) => t.attribute === "strength")
    const phases = trace?.phases.map((p) => p.phase) ?? []
    expect(phases).toEqual([
      "initial",
      "historical-fixed",
      "allocation",
      "permanent",
      "flat",
      "percent",
      "equipment",
      "temporary",
    ])
    expect(result.attributes.strength).toBe(115)
  })
})

describe("permanent race-grade cap", () => {
  it("rejects race-level gains that exceed the cumulative per-grade cap", () => {
    const state = character()
    state.permanentGains.push(
      {
        id: "ra",
        source: "race",
        kind: "raceLevel",
        grade: "F",
        count: 3,
        vector: { strength: 3 },
      },
      {
        id: "rb",
        source: "race",
        kind: "raceLevel",
        grade: "F",
        count: 3,
        vector: { strength: 3 },
      }
    )
    const cfg = config({ permanentRaceGradeCaps: { F: 5 } })
    const result = calculateStatus(state, cfg)
    // 6 levels requested across 2 gains; cap 5 -> second gain rejected, only 3 apply.
    expect(result.attributes.strength).toBe(13)
  })

  it("applies non-race permanent gains without cap", () => {
    const state = character()
    state.permanentGains.push({
      id: "b1",
      source: "title",
      kind: "buff",
      vector: { wisdom: 7 },
    })
    const result = calculateStatus(state, config())
    expect(result.attributes.wisdom).toBe(17)
  })
})

describe("resources", () => {
  it("returns null max when there is no resource formula", () => {
    const state = character()
    state.currentResources = { hp: 50 }
    const result = calculateStatus(state, config())
    expect(result.resources[0].max).toBeNull()
    expect(result.resources[0].provenance).toContain("no resource formula")
  })

  it("returns null max when the multiplier is unresolved", () => {
    const state = character()
    state.currentResources = { mana: 10 }
    const cfg = config({
      resourceMultipliers: {},
      resourceFormulas: {
        mana: { coefficients: { intelligence: 1 }, constant: 5 },
      },
    })
    const result = calculateStatus(state, cfg)
    expect(result.resources[0].max).toBeNull()
    expect(result.resources[0].provenance).toContain("no resource multiplier")
  })

  it("computes max from a registered formula and multiplier", () => {
    const state = character()
    state.currentResources = { mana: 10 }
    const cfg = config({
      resourceMultipliers: { mana: 2 },
      resourceFormulas: {
        mana: { coefficients: { intelligence: 1 }, constant: 5 },
      },
    })
    const result = calculateStatus(state, cfg)
    // base = 1*10 + 5 = 15; max = floor(15 * 2) = 30
    expect(result.resources[0].max).toBe(30)
    expect(result.resources[0].current).toBe(10)
    expect(result.resources[0].provenance).toContain("assumption")
  })
})

describe("derived stats (HP / MP / SP maxima)", () => {
  it("reflects temporary attribute effects in derived stats", () => {
    const state = character()
    state.activeEffects.push({
      id: "tmp1",
      source: "buff",
      provenance: "assumption",
      phase: "temporary",
      amount: { vitality: 5, wisdom: 3, endurance: 2 },
      stacking: "stack",
    })
    const result = calculateStatus(state, config())
    expect(result.attributes.vitality).toBe(15)
    expect(result.attributes.wisdom).toBe(13)
    expect(result.attributes.endurance).toBe(12)
    expect(result.derivedStats.hp).toBe(150)
    expect(result.derivedStats.mp).toBe(130)
    expect(result.derivedStats.sp).toBe(120)
  })

  it("stacks derived flat and percent contributions without compounding", () => {
    const state = character()
    state.equipment.push(
      {
        id: "d1",
        name: "Vital Charm",
        slot: "trinket",
        source: "assumption",
        bonus: {},
        derivedFlat: { hp: 20 },
      },
      {
        id: "d2",
        name: "Warding Sigil",
        slot: "trinket",
        source: "assumption",
        bonus: {},
        derivedPercentBasisPoints: { hp: 1000 },
      },
      {
        id: "d3",
        name: "Vital Rune",
        slot: "trinket",
        source: "assumption",
        bonus: {},
        derivedPercentBasisPoints: { hp: 2000 },
      }
    )
    const result = calculateStatus(state, config())
    // base = 10vitality * 10 = 100; flat = 20; pct = 1000 + 2000 = 3000 (summed,
    // never compounded). max = max(0, 120 + floor(120 * 3000 / 10000)) = 120 + 36.
    expect(result.derivedStats.hp).toBe(156)
    expect(result.derivedStats.breakdown!.hp.base).toBe(100)
    expect(result.derivedStats.breakdown!.hp.flat).toBe(20)
    expect(result.derivedStats.breakdown!.hp.percentBasisPoints).toBe(3000)
    expect(result.derivedStats.breakdown!.hp.percentApplied).toBe(36)
    expect(result.derivedStats.breakdown!.hp.max).toBe(156)
    // A sequential (compounding) application would give floor(132 * 1.2) = 158.
    expect(result.derivedStats.hp).not.toBe(158)
  })

  it("does not consume attribute equipment cap budgets for derived bonuses", () => {
    const state = character()
    state.baseAttributes = makeVector({ strength: 100, vitality: 50 })
    state.equipment.push({
      id: "sword",
      name: "Sword",
      slot: "weapon",
      source: "assumption",
      bonus: { strength: 100 },
      derivedFlat: { hp: 30 },
    })
    const result = calculateStatus(state, config())
    // strength flat 100 is clamped: individual 20% cap is 20, and the overall
    // sum cap (floor(150 * 0.15) = 22) does not bind below it, so 20 applies.
    expect(result.equipment.applied.strength).toBe(20)
    expect(result.attributes.strength).toBe(120)
    // The derived hp flat applies in full, unaffected by the strength cap.
    expect(result.derivedStats.hp).toBe(530)
  })

  it("leaves the legacy configurable resources untouched", () => {
    const state = character()
    state.baseAttributes = makeVector({ vitality: 50 })
    state.currentResources = { hp: 42 }
    const result = calculateStatus(state, config())
    // Legacy configurable path is unchanged: no formula -> null max, current kept.
    expect(result.resources[0].id).toBe("hp")
    expect(result.resources[0].current).toBe(42)
    expect(result.resources[0].max).toBeNull()
    // Derived values are computed independently of the legacy path.
    expect(result.derivedStats.hp).toBe(500)
  })

  it("clamps a negative derived resource at zero", () => {
    const state = character()
    state.baseAttributes = makeVector({ vitality: 1 })
    state.activeEffects.push({
      id: "negFlat",
      source: "buff",
      provenance: "assumption",
      phase: "flat",
      amount: { vitality: -20 },
      stacking: "stack",
    })
    const result = calculateStatus(state, config())
    expect(result.attributes.vitality).toBe(-19)
    expect(result.derivedStats.hp).toBe(0)
    expect(result.derivedStats.breakdown!.hp.base).toBe(-190)
    expect(result.derivedStats.breakdown!.hp.percentApplied).toBe(0)
    expect(result.derivedStats.breakdown!.hp.max).toBe(0)
  })

  it("keeps legacy equipment without derived fields contributing nothing (no regression)", () => {
    const state = character()
    state.baseAttributes = makeVector({ strength: 100, vitality: 50 })
    state.equipment.push({
      id: "sword",
      name: "Sword",
      slot: "weapon",
      source: "assumption",
      bonus: { strength: 30 },
    })
    const result = calculateStatus(state, config())
    // Legacy item contributes no derived flat/percent.
    expect(result.derivedStats.hp).toBe(500)
    expect(result.derivedStats.mp).toBe(0)
    // The attribute equipment path is unchanged.
    expect(result.equipment.requested.strength).toBe(30)
    expect(result.attributes.strength).toBe(120)
  })
})

describe("historicalFixedByTrack (source of historical fixed points per track)", () => {
  it("maps known track literals directly and preserves exact totals", () => {
    const state = character()
    state.historicalLevelAwards.push(
      {
        track: "race",
        level: 1,
        definitionId: "d",
        fixed: vec({ strength: 3, agility: 1 }),
        free: 2,
      },
      {
        track: "class",
        level: 2,
        definitionId: "d",
        fixed: vec({ strength: 5 }),
        free: 3,
      },
      {
        track: "profession",
        level: 3,
        definitionId: "d",
        fixed: vec({ strength: 7, endurance: 4 }),
        free: 4,
      }
    )
    const result = calculateStatus(state, config())
    // Known track literals map directly to their own bucket.
    expect(result.historicalFixedByTrack.race.strength).toBe(3)
    expect(result.historicalFixedByTrack.race.agility).toBe(1)
    expect(result.historicalFixedByTrack.class.strength).toBe(5)
    expect(result.historicalFixedByTrack.profession.strength).toBe(7)
    expect(result.historicalFixedByTrack.profession.endurance).toBe(4)
    // The three vectors sum, per attribute, to the historical-fixed trace delta.
    const trace = result.traces.find((t) => t.attribute === "strength")!
    const histPhase = trace.phases.find((p) => p.phase === "historical-fixed")!
    expect(histPhase.delta).toBe(3 + 5 + 7)
    const sum =
      result.historicalFixedByTrack.race.strength +
      result.historicalFixedByTrack.class.strength +
      result.historicalFixedByTrack.profession.strength
    expect(sum).toBe(histPhase.delta)
    // Status totals and final attributes are unchanged by the new field.
    expect(result.totalFreePoints).toBe(2 + 3 + 4)
    expect(result.attributes.strength).toBe(10 + 3 + 5 + 7)
    expect(result.attributes.agility).toBe(10 + 1)
    expect(result.attributes.endurance).toBe(10 + 4)
  })

  it("splits an unknown imported track evenly in Race, Class, Profession order", () => {
    const state = character() // derived (enlightened) mode, class + profession present
    state.historicalLevelAwards.push({
      track: "mystic-path", // genuinely unknown legacy literal
      level: 1,
      definitionId: "legacy:award",
      fixed: vec({ strength: 5 }),
      free: 1,
    })
    const result = calculateStatus(state, config())
    // Applicable = [race, class, profession]; 5 split 2/2/1 in that order.
    expect(result.historicalFixedByTrack.race.strength).toBe(2)
    expect(result.historicalFixedByTrack.class.strength).toBe(2)
    expect(result.historicalFixedByTrack.profession.strength).toBe(1)
    const histPhase = result.traces
      .find((t) => t.attribute === "strength")!
      .phases.find((p) => p.phase === "historical-fixed")!
    const sum =
      result.historicalFixedByTrack.race.strength +
      result.historicalFixedByTrack.class.strength +
      result.historicalFixedByTrack.profession.strength
    expect(sum).toBe(5)
    expect(histPhase.delta).toBe(5)
    // The fixed amount is counted exactly once in the final attribute.
    expect(result.attributes.strength).toBe(10 + 5)
    // Free points are not grouped into the fixed split.
    expect(result.totalFreePoints).toBe(1)
  })

  it("splits an unknown track to race only when profession is absent", () => {
    const state = character()
    delete state.tracks["profession"]
    state.historicalLevelAwards.push({
      track: "mystic-path",
      level: 1,
      definitionId: "legacy:award",
      fixed: vec({ strength: 3 }),
      free: 0,
    })
    const result = calculateStatus(state, config())
    // Applicable = [race, class]; 3 split 2/1 in order, profession omitted.
    expect(result.historicalFixedByTrack.race.strength).toBe(2)
    expect(result.historicalFixedByTrack.class.strength).toBe(1)
    expect(result.historicalFixedByTrack.profession.strength).toBe(0)
    const sum =
      result.historicalFixedByTrack.race.strength +
      result.historicalFixedByTrack.class.strength +
      result.historicalFixedByTrack.profession.strength
    expect(sum).toBe(3)
  })

  it("splits an unknown track to race only for a monster", () => {
    const state = character({ raceMode: "independent", raceLevel: 10 })
    state.historicalLevelAwards.push({
      track: "beast", // unknown legacy literal on a monster
      level: 1,
      definitionId: "legacy:award",
      fixed: vec({ strength: 8, agility: 2 }),
      free: 0,
    })
    const result = calculateStatus(state, config())
    // A monster is race-only: the whole amount lands in the race bucket.
    expect(result.historicalFixedByTrack.race.strength).toBe(8)
    expect(result.historicalFixedByTrack.race.agility).toBe(2)
    expect(result.historicalFixedByTrack.class.strength).toBe(0)
    expect(result.historicalFixedByTrack.profession.strength).toBe(0)
    const histPhase = result.traces
      .find((t) => t.attribute === "strength")!
      .phases.find((p) => p.phase === "historical-fixed")!
    expect(histPhase.delta).toBe(8)
    expect(result.attributes.strength).toBe(10 + 8)
  })

  it("splits a negative fixed vector with signed remainder preserving the exact total", () => {
    const state = character()
    state.historicalLevelAwards.push({
      track: "mystic-path", // unknown literal carrying a negative vector
      level: 1,
      definitionId: "legacy:award",
      fixed: vec({ strength: -5 }),
      free: 0,
    })
    const result = calculateStatus(state, config())
    // -5 / 3 -> base -1 per bucket, remainder -2 applied to the first two buckets.
    expect(result.historicalFixedByTrack.race.strength).toBe(-2)
    expect(result.historicalFixedByTrack.class.strength).toBe(-2)
    expect(result.historicalFixedByTrack.profession.strength).toBe(-1)
    const sum =
      result.historicalFixedByTrack.race.strength +
      result.historicalFixedByTrack.class.strength +
      result.historicalFixedByTrack.profession.strength
    expect(sum).toBe(-5)
    const histPhase = result.traces
      .find((t) => t.attribute === "strength")!
      .phases.find((p) => p.phase === "historical-fixed")!
    expect(histPhase.delta).toBe(-5)
    expect(result.attributes.strength).toBe(10 - 5)
  })

  it("does not mutate stored awards and keeps historical-fixed trace totals unchanged", () => {
    const state = character()
    const awards = [
      {
        track: "class",
        level: 1,
        definitionId: "d",
        fixed: vec({ strength: 2, wisdom: 1 }),
        free: 5,
      },
      {
        track: "mystic-path",
        level: 1,
        definitionId: "legacy:award",
        fixed: vec({ strength: 6 }),
        free: 2,
      },
    ]
    state.historicalLevelAwards.push(...awards)
    const before = JSON.parse(JSON.stringify(state.historicalLevelAwards))
    const result = calculateStatus(state, config())
    // Stored awards are not mutated.
    expect(JSON.parse(JSON.stringify(state.historicalLevelAwards))).toEqual(
      before
    )
    // strength: class 2 + unknown split (6 among race/class/prof = 2/2/2).
    expect(result.historicalFixedByTrack.class.strength).toBe(2 + 2)
    expect(result.historicalFixedByTrack.race.strength).toBe(2)
    expect(result.historicalFixedByTrack.profession.strength).toBe(2)
    const histPhase = result.traces
      .find((t) => t.attribute === "strength")!
      .phases.find((p) => p.phase === "historical-fixed")!
    expect(histPhase.delta).toBe(2 + 6)
    const sum =
      result.historicalFixedByTrack.race.strength +
      result.historicalFixedByTrack.class.strength +
      result.historicalFixedByTrack.profession.strength
    expect(sum).toBe(histPhase.delta)
    // Available/free/allocated point totals are unaffected by the fixed split.
    expect(result.totalFreePoints).toBe(5 + 2)
    expect(result.allocatedPoints).toBe(0)
    expect(result.availablePoints).toBe(7)
  })
})
