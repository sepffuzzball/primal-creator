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
