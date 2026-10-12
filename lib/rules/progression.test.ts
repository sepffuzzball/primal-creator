import { describe, expect, it } from "vitest"
import {
  advanceQuarter,
  allocatePoints,
  availablePoints,
  deriveRaceLevel,
  evolveGrade,
} from "./progression"
import { calculateStatus } from "./calculate"
import { character, config, trackDef } from "./testUtils"
import { vec } from "./testUtils"

function advanceN(
  state: ReturnType<typeof character>,
  track: string,
  def: ReturnType<typeof trackDef>,
  cfg: ReturnType<typeof config>,
  n: number
): ReturnType<typeof character> {
  let s = state
  for (let i = 0; i < n; i++) {
    const r = advanceQuarter(s, track, def, cfg)
    s = r.state
  }
  return s
}

describe("advanceQuarter", () => {
  it("advances a quarter without leveling up", () => {
    const state = character({ classLevel: 1, professionLevel: 1 })
    const result = advanceQuarter(
      state,
      "class",
      trackDef("class-def", { strength: 1 }, 0),
      config()
    )
    expect(result.journal.leveledUp).toBe(false)
    expect(result.journal.levelBefore).toBe(1)
    expect(result.journal.levelAfter).toBe(1)
    expect(result.journal.quarterAfter).toBe(1)
    expect(result.state.tracks["class"].quarter).toBe(1)
    expect(result.state.tracks["class"].level).toBe(1)
  })

  it("levels up after the fourth quarter and snapshots the award", () => {
    const state = character({ classLevel: 1, professionLevel: 1 })
    const def = trackDef("class-def", { strength: 3, agility: 2 }, 5)
    let s = state
    let last: ReturnType<typeof advanceQuarter> | null = null
    for (let i = 0; i < 4; i++) {
      last = advanceQuarter(s, "class", def, config())
      s = last.state
    }
    expect(last?.journal.leveledUp).toBe(true)
    expect(last?.journal.levelAfter).toBe(2)
    expect(last?.journal.quarterAfter).toBe(0)
    expect(s.historicalLevelAwards.length).toBe(1)
    expect(s.historicalLevelAwards[0].track).toBe("class")
    expect(s.historicalLevelAwards[0].level).toBe(2)
    expect(s.historicalLevelAwards[0].fixed.strength).toBe(3)
    expect(s.historicalLevelAwards[0].fixed.agility).toBe(2)
    expect(s.historicalLevelAwards[0].free).toBe(5)
  })

  it("snapshots fixed awards immutably (copy, not reference)", () => {
    const state = character({ classLevel: 1, professionLevel: 1 })
    const def = {
      id: "class-def",
      name: "class-def",
      fixed: { strength: 7 },
      free: 0,
    }
    let s = state
    for (let i = 0; i < 4; i++) {
      s = advanceQuarter(s, "class", def, config()).state
    }
    const snapshot = s.historicalLevelAwards[0].fixed
    expect(snapshot.strength).toBe(7)
    // Mutating the source definition must not change the stored snapshot.
    ;(def.fixed as { strength: number }).strength = 99
    expect(s.historicalLevelAwards[0].fixed.strength).toBe(7)
  })

  it("does not award on non-level-up advances", () => {
    const state = character({ classLevel: 1, professionLevel: 1 })
    const result = advanceQuarter(
      state,
      "class",
      trackDef("class-def", { strength: 1 }, 0),
      config()
    )
    expect(result.state.historicalLevelAwards.length).toBe(0)
  })
})

describe("race deriviation", () => {
  it("derives race level as floor((class+profession)/2)", () => {
    const state = character({ classLevel: 10, professionLevel: 10 })
    expect(deriveRaceLevel(state, config())).toBe(10)
  })

  it("treats a missing profession as zero", () => {
    const state = character({ classLevel: 10, professionLevel: 10 })
    delete state.tracks["profession"]
    expect(deriveRaceLevel(state, config())).toBe(5)
  })

  it("supports alternative derivation strategies", () => {
    const state = character({ classLevel: 10, professionLevel: 6 })
    expect(
      deriveRaceLevel(state, config({ raceDerivationStrategy: "maxOf" }))
    ).toBe(10)
    expect(
      deriveRaceLevel(state, config({ raceDerivationStrategy: "sum" }))
    ).toBe(16)
  })

  it("supports independent race mode (no derivation)", () => {
    const state = character({
      classLevel: 10,
      professionLevel: 10,
      raceMode: "independent",
      raceLevel: 20,
      raceGrade: "E",
    })
    expect(deriveRaceLevel(state, config())).toBe(20)
  })
})

describe("race gain snapshot on derived level increase", () => {
  it("snapshots race gains according to the grade definition", () => {
    const state = character({
      classLevel: 11,
      professionLevel: 10,
      raceLevel: 10,
      raceGrade: "F",
    })
    const cfg = config({
      raceDefinitions: {
        F: { id: "race-f", perLevel: { strength: 1 }, freePerLevel: 1 },
      },
    })
    const def = trackDef("class-def", { strength: 1 }, 0)
    // 4 advances move class 11 -> 12, which pushes derived race to 11.
    const s = advanceN(state, "class", def, cfg, 4)
    expect(s.race.level).toBe(11)
    // Derived race gains live in the historical ledger (immutable snapshot), not
    // in the permanent-gains ledger.
    expect(s.permanentGains.filter((g) => g.kind === "raceLevel").length).toBe(
      0
    )
    const raceAward = s.historicalLevelAwards.find((a) => a.track === "race")
    expect(raceAward).toBeDefined()
    expect(raceAward?.fixed.strength).toBe(1)
    expect(raceAward?.free).toBe(1)
    expect(raceAward?.definitionId).toBe("race-f")
  })

  it("does not snapshot race gains when the derived race level is unchanged", () => {
    const state = character({
      classLevel: 11,
      professionLevel: 10,
      raceLevel: 10,
      raceGrade: "F",
    })
    const cfg = config({
      raceDefinitions: {
        F: { id: "race-f", perLevel: { strength: 1 }, freePerLevel: 1 },
      },
    })
    const def = trackDef("class-def", { strength: 1 }, 0)
    // 3 advances move class 11 -> 11? no: 3 advances keep level 11 (quarter 0->3).
    const s = advanceN(state, "class", def, cfg, 3)
    expect(s.race.level).toBe(10)
    expect(
      s.historicalLevelAwards.filter((a) => a.track === "race").length
    ).toBe(0)
  })
})

describe("grade gating and evolution", () => {
  it("does not silently evolve when the grade gate is closed", () => {
    const state = character({
      classLevel: 30,
      professionLevel: 30,
      raceLevel: 30,
      raceGrade: "F",
    })
    const cfg = config({ gradeGates: { E: false } })
    const result = advanceQuarter(
      state,
      "class",
      trackDef("class-def", { strength: 1 }, 0),
      cfg
    )
    expect(result.journal.evolutionOffer).toEqual({
      grade: "E",
      available: false,
    })
    expect(result.journal.evolutionBlocked).toBe("E")
    expect(result.state.race.grade).toBe("F")
  })

  it("offers evolution when the gate is open, but keeps the grade lagging until manual evolve", () => {
    const state = character({
      classLevel: 30,
      professionLevel: 30,
      raceLevel: 30,
      raceGrade: "F",
    })
    const cfg = config({ gradeGates: { E: true } })
    const result = advanceQuarter(
      state,
      "class",
      trackDef("class-def", { strength: 1 }, 0),
      cfg
    )
    expect(result.journal.evolutionOffer).toEqual({
      grade: "E",
      available: true,
    })
    // Grade still lags (manual evolution) - not auto-evolved.
    expect(result.state.race.grade).toBe("F")
  })

  it("blocks progression beyond a closed grade ceiling", () => {
    const state = character({
      classLevel: 210,
      professionLevel: 210,
      raceLevel: 210,
      raceGrade: "D",
    })
    // level 210 qualifies for C (200-349); the C gate is closed, so the grade
    // cannot advance past D.
    const cfg = config({ gradeGates: { C: false } })
    const result = advanceQuarter(
      state,
      "class",
      trackDef("class-def", { strength: 1 }, 0),
      cfg
    )
    expect(result.journal.evolutionBlocked).toBe("C")
    expect(result.state.race.grade).toBe("D")
    expect(result.journal.evolutionOffer).toEqual({
      grade: "C",
      available: false,
    })
  })

  it("evolveGrade succeeds when the level qualifies and the gate is open", () => {
    const state = character({
      classLevel: 30,
      professionLevel: 30,
      raceLevel: 30,
      raceGrade: "F",
    })
    const cfg = config({ gradeGates: { E: true } })
    const result = evolveGrade(state, "E", cfg)
    expect(result.ok).toBe(true)
    expect(result.state?.race.grade).toBe("E")
  })

  it("evolveGrade rejects a target that is not a higher grade", () => {
    const state = character({
      classLevel: 30,
      professionLevel: 30,
      raceLevel: 30,
      raceGrade: "F",
    })
    const result = evolveGrade(state, "F", config())
    expect(result.ok).toBe(false)
  })

  it("evolveGrade rejects when level does not qualify", () => {
    const state = character({
      classLevel: 6,
      professionLevel: 6,
      raceLevel: 6,
      raceGrade: "G",
    })
    // level 6 does not qualify for E.
    const result = evolveGrade(state, "E", config())
    expect(result.ok).toBe(false)
  })

  it("evolveGrade rejects when the gate is closed", () => {
    const state = character({
      classLevel: 30,
      professionLevel: 30,
      raceLevel: 30,
      raceGrade: "F",
    })
    const result = evolveGrade(state, "E", config({ gradeGates: { E: false } }))
    expect(result.ok).toBe(false)
  })

  it("lets a G-origin character evolve to F only once their level qualifies", () => {
    const state = character({
      classLevel: 4,
      professionLevel: 4,
      raceLevel: 4,
      raceGrade: "G",
    })
    // level 4 -> only G qualifies (F entry level is 10).
    const result = advanceQuarter(
      state,
      "class",
      trackDef("class-def", { strength: 1 }, 0),
      config()
    )
    expect(result.journal.evolutionOffer).toBeNull()
  })
})

describe("allocatePoints (progression module)", () => {
  it("appends an allocation entry and recomputes available points", () => {
    const state = character({ classLevel: 1, professionLevel: 1 })
    state.historicalLevelAwards.push({
      track: "class",
      level: 1,
      definitionId: "d",
      fixed: vec({ strength: 1 }),
      free: 10,
    })
    const result = allocatePoints(state, { strength: 3, agility: 2 })
    expect(result.ok).toBe(true)
    expect(result.state?.allocations.length).toBe(1)
    if (result.state) {
      expect(availablePoints(result.state)).toBe(5)
    }
  })

  it("rejects an allocation that overspends", () => {
    const state = character()
    state.historicalLevelAwards.push({
      track: "class",
      level: 1,
      definitionId: "d",
      fixed: vec({ strength: 1 }),
      free: 4,
    })
    const result = allocatePoints(state, { strength: 9 })
    expect(result.ok).toBe(false)
  })
})

describe("calculateStatus after progression", () => {
  it("reflects snapshotted awards in the attribute totals", () => {
    const state = character({ classLevel: 1, professionLevel: 1 })
    let s = state
    const def = trackDef("class-def", { strength: 3 }, 2)
    for (let i = 0; i < 4; i++) {
      s = advanceQuarter(s, "class", def, config()).state
    }
    // base 10 + snapshotted 3 fixed + 2 free points (unallocated)
    const result = calculateStatus(s, config())
    expect(result.attributes.strength).toBe(13)
    expect(result.availablePoints).toBe(2)
  })
})

describe("correctness fixes (regression)", () => {
  it("rejects a definition that does not match the track's record", () => {
    const state = character({ classLevel: 1, professionLevel: 1 })
    const def = trackDef("wrong-id", { strength: 1 }, 0)
    expect(() => advanceQuarter(state, "class", def, config())).toThrow(
      /does not match/
    )
  })

  it("rejects a level-up that would push race past the next grade threshold without evolution", () => {
    // class 27 + profession 24 -> derived race level 25, which is exactly the
    // F->E threshold (E entry 25). Advancing the class to 28 pushes the derived
    // race level to 26, past E's entry, while the grade is still F (evolution not
    // completed). The quarter advancement must be rejected rather than silently
    // exceeding the threshold.
    const state = character({
      classLevel: 27,
      professionLevel: 24,
      raceGrade: "F",
    })
    state.tracks["class"].quarter = 3
    const cfg = config({
      raceDefinitions: {
        F: { id: "race-f", perLevel: { strength: 1 }, freePerLevel: 1 },
      },
    })
    const def = trackDef("class-def", { strength: 1 }, 0)
    expect(() => advanceQuarter(state, "class", def, cfg)).toThrow(/threshold/)
  })

  it("allows a level-up within the current grade band", () => {
    // class 12 + profession 10 -> derived race 11, inside F band (0-24). No reject.
    const state = character({
      classLevel: 12,
      professionLevel: 10,
      raceGrade: "F",
    })
    state.tracks["class"].quarter = 3
    const cfg = config({
      raceDefinitions: {
        F: { id: "race-f", perLevel: { strength: 1 }, freePerLevel: 1 },
      },
    })
    const def = trackDef("class-def", { strength: 1 }, 0)
    const result = advanceQuarter(state, "class", def, cfg)
    expect(result.journal.leveledUp).toBe(true)
  })

  it("rejects a derived race level gain with no race definition (never awards zero)", () => {
    const state = character({
      classLevel: 11,
      professionLevel: 10,
      raceLevel: 10,
      raceGrade: "F",
    })
    const def = trackDef("class-def", { strength: 1 }, 0)
    // 4 advances level the class to 12, pushing the derived race level to 11.
    expect(() => advanceN(state, "class", def, config(), 4)).toThrow(
      /no race definition/
    )
  })

  it("validates the track level and quarter bounds", () => {
    const badLevel = character({ classLevel: 1, professionLevel: 1 })
    ;(badLevel.tracks["class"] as { level: number }).level = -1
    expect(() =>
      advanceQuarter(
        badLevel,
        "class",
        trackDef("class-def", { strength: 1 }, 0),
        config()
      )
    ).toThrow(/level/)

    const badQuarter = character({ classLevel: 1, professionLevel: 1 })
    ;(badQuarter.tracks["class"] as { quarter: number }).quarter = 4
    expect(() =>
      advanceQuarter(
        badQuarter,
        "class",
        trackDef("class-def", { strength: 1 }, 0),
        config()
      )
    ).toThrow(/quarter/)
  })

  it("separates derived race fixed into historical awards and never the permanent ledger", () => {
    const state = character({
      classLevel: 11,
      professionLevel: 10,
      raceLevel: 10,
      raceGrade: "F",
    })
    const cfg = config({
      raceDefinitions: {
        F: { id: "race-f", perLevel: { strength: 1 }, freePerLevel: 1 },
      },
    })
    const def = trackDef("class-def", { strength: 1 }, 0)
    const s = advanceN(state, "class", def, cfg, 4)
    expect(s.permanentGains.filter((g) => g.kind === "raceLevel").length).toBe(
      0
    )
    const race = s.historicalLevelAwards.find((a) => a.track === "race")
    expect(race?.fixed.strength).toBe(1)
  })

  it("does not double count derived race gain in calculateStatus", () => {
    const state = character({
      classLevel: 11,
      professionLevel: 10,
      raceLevel: 10,
      raceGrade: "F",
    })
    const cfg = config({
      raceDefinitions: {
        F: { id: "race-f", perLevel: { strength: 1 }, freePerLevel: 1 },
      },
    })
    const def = trackDef("class-def", { strength: 1 }, 0)
    const s = advanceN(state, "class", def, cfg, 4)
    const result = calculateStatus(s, cfg)
    // base 10 + class award 1 + race award 1 = 12; the race fixed is counted once.
    expect(result.attributes.strength).toBe(12)
  })
})

describe("grade threshold level-up (G9->10 / F24->25)", () => {
  it("permits the G9->10 threshold level-up (reaching F's entry level)", () => {
    // Class 11 + profession 8 -> derived race 9. Advancing the class to 12 pushes
    // the derived race level to 10, which is exactly F's entry level (the
    // G->F threshold). This threshold level-up must be permitted even though the
    // character has not yet evolved out of grade G.
    const state = character({
      classLevel: 11,
      professionLevel: 8,
      raceGrade: "G",
    })
    state.tracks["class"].quarter = 3
    const cfg = config({
      raceDefinitions: {
        G: { id: "race-g", perLevel: { strength: 1 }, freePerLevel: 1 },
      },
    })
    const def = trackDef("class-def", { strength: 1 }, 0)
    const result = advanceQuarter(state, "class", def, cfg)
    expect(result.journal.leveledUp).toBe(true)
    expect(result.state.race.level).toBe(10)
    // Still grade G - evolution to F is offered, not automatic.
    expect(result.state.race.grade).toBe("G")
    expect(result.journal.evolutionOffer).toEqual({
      grade: "F",
      available: true,
    })
  })

  it("prevents the NEXT level-up beyond G9->10 while still grade G (not evolved)", () => {
    // Class 13 + profession 8 -> derived race 10, already at the G->F threshold.
    // Advancing the class to 14 pushes the derived race to 11, past F's entry
    // level (10), which must be rejected until the character evolves to F.
    const state = character({
      classLevel: 13,
      professionLevel: 8,
      raceGrade: "G",
    })
    state.tracks["class"].quarter = 3
    const cfg = config({
      raceDefinitions: {
        G: { id: "race-g", perLevel: { strength: 1 }, freePerLevel: 1 },
      },
    })
    const def = trackDef("class-def", { strength: 1 }, 0)
    expect(() => advanceQuarter(state, "class", def, cfg)).toThrow(/threshold/)
  })

  it("permits the F24->25 threshold level-up (reaching E's entry level)", () => {
    // Class 26 + profession 23 -> derived race 24. Advancing the class to 27
    // pushes the derived race to 25, which is exactly E's entry level (the
    // F->E threshold). Must be permitted even though the character has not yet
    // evolved out of grade F.
    const state = character({
      classLevel: 26,
      professionLevel: 23,
      raceGrade: "F",
    })
    state.tracks["class"].quarter = 3
    const cfg = config({
      raceDefinitions: {
        F: { id: "race-f", perLevel: { strength: 1 }, freePerLevel: 1 },
      },
    })
    const def = trackDef("class-def", { strength: 1 }, 0)
    const result = advanceQuarter(state, "class", def, cfg)
    expect(result.journal.leveledUp).toBe(true)
    expect(result.state.race.level).toBe(25)
    // Still grade F - evolution to E is offered, not automatic.
    expect(result.state.race.grade).toBe("F")
    expect(result.journal.evolutionOffer).toEqual({
      grade: "E",
      available: true,
    })
  })

  it("prevents the NEXT level-up beyond F24->25 while still grade F (not evolved)", () => {
    // Class 28 + profession 23 -> derived race 25, already at the F->E threshold.
    // Advancing the class to 29 pushes the derived race to 26, past E's entry
    // level (25), which must be rejected until the character evolves to E.
    const state = character({
      classLevel: 28,
      professionLevel: 23,
      raceGrade: "F",
    })
    state.tracks["class"].quarter = 3
    const cfg = config({
      raceDefinitions: {
        F: { id: "race-f", perLevel: { strength: 1 }, freePerLevel: 1 },
      },
    })
    const def = trackDef("class-def", { strength: 1 }, 0)
    expect(() => advanceQuarter(state, "class", def, cfg)).toThrow(/threshold/)
  })
})
