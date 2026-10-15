import { describe, expect, it } from "vitest"
import {
  advanceQuarter,
  advanceRaceQuarter,
  allocatePoints,
  availablePoints,
  deriveRaceLevel,
  evolveGrade,
  evolveTrackGrade,
  experiencePercentFor,
  gradeLevelUpBlockReason,
  gradeLevelUpBlockers,
  levelUpFromExperience,
  setExperiencePercent,
} from "./progression"
import { calculateStatus } from "./calculate"
import { character, config, trackDef } from "./testUtils"
import { vec } from "./testUtils"
import {
  createCharacterState,
  type CharacterState,
  type Grade,
  zeroVector,
} from "./types"

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

describe("graded track ceiling (class / profession)", () => {
  const raceDefsF = {
    raceDefinitions: {
      F: { id: "race-f", perLevel: { strength: 1 }, freePerLevel: 1 },
    },
  }

  it("permits a graded class to reach the next grade's entry level (F24->25)", () => {
    const state = character({ classLevel: 24, professionLevel: 24 })
    state.tracks["class"].grade = "F"
    state.tracks["class"].quarter = 3
    const cfg = config(raceDefsF)
    const result = advanceQuarter(
      state,
      "class",
      trackDef("class-def", { strength: 1 }, 0),
      cfg
    )
    expect(result.journal.leveledUp).toBe(true)
    expect(result.state.tracks["class"].level).toBe(25)
    // The track stays graded F; evolution is still explicit.
    expect(result.state.tracks["class"].grade).toBe("F")
  })

  it("blocks a graded class from advancing past the next entry level until track evolution", () => {
    const state = character({ classLevel: 25, professionLevel: 24 })
    state.tracks["class"].grade = "F"
    state.tracks["class"].quarter = 3
    const cfg = config(raceDefsF)
    const def = trackDef("class-def", { strength: 1 }, 0)
    expect(() => advanceQuarter(state, "class", def, cfg)).toThrow(/threshold/)
  })

  it("caps the profession track independently with its own grade", () => {
    const state = character({ classLevel: 24, professionLevel: 24 })
    state.tracks["profession"].grade = "F"
    state.tracks["profession"].quarter = 3
    const cfg = config(raceDefsF)
    const result = advanceQuarter(
      state,
      "profession",
      trackDef("prof-def", { strength: 1 }, 0),
      cfg
    )
    expect(result.journal.leveledUp).toBe(true)
    expect(result.state.tracks["profession"].level).toBe(25)
    // The class track is untouched by a profession advance.
    expect(result.state.tracks["class"].level).toBe(24)
    // And a further profession level-up is capped by ITS OWN grade, not the class.
    const blocked = character({ classLevel: 24, professionLevel: 25 })
    blocked.tracks["profession"].grade = "F"
    blocked.tracks["profession"].quarter = 3
    expect(() =>
      advanceQuarter(
        blocked,
        "profession",
        trackDef("prof-def", { strength: 1 }, 0),
        cfg
      )
    ).toThrow(/threshold/)
  })

  it("keeps class and profession grades independent across track evolution", () => {
    const state = character({ classLevel: 25, professionLevel: 25 })
    state.tracks["class"].grade = "F"
    state.tracks["profession"].grade = "F"
    const result = evolveTrackGrade(
      state,
      "profession",
      "E",
      "prof-e",
      config()
    )
    expect(result.ok).toBe(true)
    expect(result.state?.tracks["profession"].grade).toBe("E")
    expect(result.state?.tracks["profession"].definitionId).toBe("prof-e")
    // The class grade and definition are untouched by the profession evolution.
    expect(result.state?.tracks["class"].grade).toBe("F")
    expect(result.state?.tracks["class"].definitionId).toBe("class-def")
  })

  it("lets a derived race gate block independently of the class track ceiling", () => {
    // Class track is already past its own ceiling (grade E at level 28), so the
    // track ceiling would NOT block. The derived race still closes over the F->E
    // threshold (25) and must block on its own.
    const state = character({ classLevel: 28, professionLevel: 23 })
    state.tracks["class"].grade = "E"
    state.tracks["class"].quarter = 3
    const cfg = config(raceDefsF)
    const def = trackDef("class-def", { strength: 1 }, 0)
    expect(() => advanceQuarter(state, "class", def, cfg)).toThrow(/threshold/)
  })

  it("leaves ungraded tracks unaffected by the track ceiling", () => {
    // No track grade is set (legacy state), so a class can advance past the E
    // entry level (25) freely even though the room is past it.
    const state = character({
      classLevel: 26,
      professionLevel: 26,
      raceGrade: "E",
    })
    state.tracks["class"].quarter = 3
    const cfg = config({
      raceDefinitions: {
        E: { id: "race-e", perLevel: { strength: 1 }, freePerLevel: 1 },
      },
    })
    const result = advanceQuarter(
      state,
      "class",
      trackDef("class-def", { strength: 1 }, 0),
      cfg
    )
    expect(result.journal.leveledUp).toBe(true)
    expect(result.state.tracks["class"].level).toBe(27)
  })

  it("evolves a graded track definition while old awards stay snapshotted", () => {
    const state = character({ classLevel: 25, professionLevel: 25 })
    state.tracks["class"].grade = "F"
    state.tracks["class"].definitionId = "class-f"
    state.historicalLevelAwards.push({
      track: "class",
      level: 24,
      definitionId: "class-f",
      fixed: vec({ strength: 3 }),
      free: 2,
    })
    const result = evolveTrackGrade(state, "class", "E", "class-e", config())
    expect(result.ok).toBe(true)
    expect(result.state?.tracks["class"].grade).toBe("E")
    expect(result.state?.tracks["class"].definitionId).toBe("class-e")
    expect(result.state?.tracks["class"].level).toBe(25)
    // Old awards remain snapshotted, unchanged by the evolution.
    expect(result.state?.historicalLevelAwards).toHaveLength(1)
    expect(result.state?.historicalLevelAwards[0]).toEqual(
      state.historicalLevelAwards[0]
    )
    expect(result.journal).toEqual({
      track: "class",
      from: "F",
      to: "E",
      level: 25,
      oldDefinitionId: "class-f",
      newDefinitionId: "class-e",
    })
  })

  it("evolveTrackGrade rejects an unknown track", () => {
    const state = character()
    const result = evolveTrackGrade(state, "bogus", "E", "x", config())
    expect(result.ok).toBe(false)
    expect(result.errors.join(" ")).toMatch(/unknown track/)
  })

  it("evolveTrackGrade rejects an ungraded track", () => {
    const state = character()
    const result = evolveTrackGrade(state, "class", "E", "x", config())
    expect(result.ok).toBe(false)
    expect(result.errors.join(" ")).toMatch(/no explicit grade/)
  })

  it("evolveTrackGrade rejects a target that is not the next grade", () => {
    const state = character({ classLevel: 25, professionLevel: 25 })
    state.tracks["class"].grade = "F"
    const result = evolveTrackGrade(state, "class", "D", "class-d", config())
    expect(result.ok).toBe(false)
    expect(result.errors.join(" ")).toMatch(/not the next grade/)
  })

  it("evolveTrackGrade rejects a track level outside the target band", () => {
    const state = character({ classLevel: 4, professionLevel: 4 })
    state.tracks["class"].grade = "G"
    const result = evolveTrackGrade(state, "class", "F", "class-f", config())
    expect(result.ok).toBe(false)
    expect(result.errors.join(" ")).toMatch(/does not qualify/)
  })

  it("evolveTrackGrade rejects a closed grade gate", () => {
    const state = character({ classLevel: 25, professionLevel: 25 })
    state.tracks["class"].grade = "F"
    const result = evolveTrackGrade(
      state,
      "class",
      "E",
      "class-e",
      config({ gradeGates: { E: false } })
    )
    expect(result.ok).toBe(false)
    expect(result.errors.join(" ")).toMatch(/grade gate closed/)
  })

  it("evolveTrackGrade rejects an empty target definition id", () => {
    const state = character({ classLevel: 25, professionLevel: 25 })
    state.tracks["class"].grade = "F"
    const result = evolveTrackGrade(state, "class", "E", "", config())
    expect(result.ok).toBe(false)
    expect(result.errors.join(" ")).toMatch(/nonempty target definition id/)
  })
})

describe("advanceRaceQuarter (monster race-only cadence)", () => {
  // A monster advances on an independent race-only track with no class or
  // profession tracks. Build the raw state by hand (the `character` builder
  // always adds class/profession tracks).
  function monsterState(
    overrides: { level?: number; quarter?: number; grade?: Grade } = {}
  ): CharacterState {
    return createCharacterState({
      baseAttributes: zeroVector(),
      tracks: {},
      race: {
        level: overrides.level ?? 0,
        grade: overrides.grade ?? "F",
        mode: "independent",
        quarter: overrides.quarter ?? 0,
      },
    })
  }

  const raceDef = {
    id: "monster:F",
    perLevel: { strength: 2 },
    freePerLevel: 1,
  }
  const raceConfig = config({ raceDefinitions: { F: raceDef } })

  it("advances a quarter without leveling up, snapshoting no starter award", () => {
    const result = advanceRaceQuarter(
      monsterState({ grade: "F" }),
      raceDef,
      raceConfig
    )
    expect(result.state.race.quarter).toBe(1)
    expect(result.state.race.level).toBe(0)
    expect(result.state.turn).toBe(1)
    expect(result.state.historicalLevelAwards).toEqual([])
    expect(result.journal.leveledUp).toBe(false)
    expect(result.journal.track).toBe("race")
    expect(result.journal.raceGain).toBeNull()
  })

  it("levels up on the fourth quarter and snapshots the race award", () => {
    let s: CharacterState = monsterState({ grade: "F" })
    let leveledUp = false
    for (let i = 0; i < 4; i++) {
      const r = advanceRaceQuarter(s, raceDef, raceConfig)
      s = r.state
      leveledUp = r.journal.leveledUp
    }
    expect(s.race.level).toBe(1)
    expect(s.race.quarter).toBe(0)
    expect(s.turn).toBe(4)
    // Only an actual level-up snapshots; never a fabricated starter award.
    expect(s.historicalLevelAwards).toHaveLength(1)
    expect(s.historicalLevelAwards[0].track).toBe("race")
    expect(s.historicalLevelAwards[0].level).toBe(1)
    expect(s.historicalLevelAwards[0].definitionId).toBe("monster:F")
    expect(s.historicalLevelAwards[0].fixed.strength).toBe(2)
    expect(s.historicalLevelAwards[0].free).toBe(1)
    expect(leveledUp).toBe(true)
  })

  it("rejects an invalid (negative) race level and an out-of-range quarter", () => {
    expect(() =>
      advanceRaceQuarter(monsterState({ level: -1 }), raceDef, raceConfig)
    ).toThrow(/nonnegative integer/)
    expect(() =>
      advanceRaceQuarter(monsterState({ quarter: 4 }), raceDef, raceConfig)
    ).toThrow(/integer in 0\.\.3/)
  })

  it("rejects a level-up that would push race level past the next-grade threshold", () => {
    // At grade F the next band (E) entry level is 25. Reaching exactly 25 is legal;
    // pushing to 26 is rejected without a completed evolution.
    const atThreshold = monsterState({ grade: "F", level: 24, quarter: 3 })
    const reached = advanceRaceQuarter(atThreshold, raceDef, raceConfig)
    expect(reached.state.race.level).toBe(25)
    expect(reached.state.race.quarter).toBe(0)
    expect(reached.journal.leveledUp).toBe(true)

    // Pushing past the E threshold (25) is rejected while the grade stays F.
    const justPast = monsterState({ grade: "F", level: 25, quarter: 3 })
    expect(() => advanceRaceQuarter(justPast, raceDef, raceConfig)).toThrow(
      /past the F->E threshold/
    )
  })

  it("offers evolution when a level-up crosses into a higher grade", () => {
    // G-grade monster at level 9: the next advance to level 10 reaches F's entry
    // level (10) and offers evolution to F (manual, gate open).
    const atG = monsterState({ grade: "G", level: 9, quarter: 3 })
    const result = advanceRaceQuarter(
      atG,
      { id: "monster:G", perLevel: { strength: 1 }, freePerLevel: 1 },
      config({
        raceDefinitions: {
          G: { id: "monster:G", perLevel: { strength: 1 }, freePerLevel: 1 },
        },
      })
    )
    expect(result.journal.leveledUp).toBe(true)
    expect(result.journal.evolutionOffer).toEqual({
      grade: "F",
      available: true,
    })
    expect(result.state.race.level).toBe(10)
  })
})

describe("experiencePercentFor (authoritative EXP percent)", () => {
  it("returns the explicit percent when present", () => {
    const state = character({ classLevel: 1, professionLevel: 1 })
    state.tracks["class"].experiencePercent = 37
    state.tracks["class"].quarter = 1
    expect(experiencePercentFor(state, "class")).toBe(37)
  })

  it("legacy quarter 3 displays 75 via quarter*25 fallback", () => {
    const state = character({ classLevel: 1, professionLevel: 1 })
    state.tracks["class"].quarter = 3
    // No explicit experiencePercent is set, so the legacy quarter cadence is used.
    expect(experiencePercentFor(state, "class")).toBe(75)
  })

  it("falls back to 0 for a missing race quarter and a missing track", () => {
    const state = character({ classLevel: 1, professionLevel: 1 })
    expect(experiencePercentFor(state, "race")).toBe(0)
    expect(experiencePercentFor(state, "bogus")).toBe(0)
  })

  it("exposes the explicit percent of an independent race", () => {
    const state = character({
      classLevel: 1,
      professionLevel: 1,
      raceMode: "independent",
      raceLevel: 0,
      raceGrade: "F",
    })
    state.race.experiencePercent = 50
    state.race.quarter = 2
    expect(experiencePercentFor(state, "race")).toBe(50)
  })
})

describe("setExperiencePercent (authoritative EXP percent)", () => {
  function monsterState(
    overrides: { level?: number; quarter?: number; grade?: Grade } = {}
  ): CharacterState {
    return createCharacterState({
      baseAttributes: zeroVector(),
      tracks: {},
      race: {
        level: overrides.level ?? 0,
        grade: overrides.grade ?? "F",
        mode: "independent",
        quarter: overrides.quarter ?? 0,
      },
    })
  }

  const monsterRaceDef = {
    id: "monster:F",
    perLevel: { strength: 2 },
    freePerLevel: 1,
  }
  const monsterCfg = config({ raceDefinitions: { F: monsterRaceDef } })

  it("advances 24% -> 25% with a single turn and no level-up", () => {
    const state = character({ classLevel: 1, professionLevel: 1 })
    state.tracks["class"].experiencePercent = 24
    state.tracks["class"].quarter = 0
    const result = setExperiencePercent(
      state,
      "class",
      25,
      trackDef("class-def", { strength: 1 }, 0),
      config()
    )
    expect(result.journal.turnsAdvanced).toBe(1)
    expect(result.journal.leveledUp).toBe(false)
    expect(result.state.turn).toBe(state.turn + 1)
    expect(result.state.tracks["class"].experiencePercent).toBe(25)
    expect(result.state.tracks["class"].quarter).toBe(1)
    expect(result.state.tracks["class"].level).toBe(1)
  })

  it("levels up exactly once from 75% -> 100% and awards once", () => {
    const state = character({ classLevel: 1, professionLevel: 1 })
    state.tracks["class"].experiencePercent = 75
    state.tracks["class"].quarter = 3
    const result = setExperiencePercent(
      state,
      "class",
      100,
      trackDef("class-def", { strength: 3, agility: 2 }, 5),
      config()
    )
    expect(result.journal.turnsAdvanced).toBe(1)
    expect(result.journal.leveledUp).toBe(true)
    expect(result.state.turn).toBe(state.turn + 1)
    expect(result.state.tracks["class"].level).toBe(2)
    expect(result.state.tracks["class"].experiencePercent).toBe(0)
    expect(result.state.tracks["class"].quarter).toBe(0)
    expect(result.state.historicalLevelAwards).toHaveLength(1)
    expect(result.state.historicalLevelAwards[0].track).toBe("class")
    expect(result.state.historicalLevelAwards[0].fixed.strength).toBe(3)
    expect(result.state.historicalLevelAwards[0].free).toBe(5)
  })

  it("ticks exactly 3 turns from 40% -> 100% (crossing 50/75/100)", () => {
    const state = character({ classLevel: 1, professionLevel: 1 })
    state.tracks["class"].experiencePercent = 40
    state.tracks["class"].quarter = 1
    const result = setExperiencePercent(
      state,
      "class",
      100,
      trackDef("class-def", { strength: 3, agility: 2 }, 5),
      config()
    )
    expect(result.journal.turnsAdvanced).toBe(3)
    expect(result.state.turn).toBe(state.turn + 3)
    expect(result.state.tracks["class"].level).toBe(2)
    expect(result.state.tracks["class"].experiencePercent).toBe(0)
    expect(result.state.tracks["class"].quarter).toBe(0)
  })

  it("aggregates the journal across a 0->100 level-up (initial before values retained)", () => {
    const state = character({ classLevel: 1, professionLevel: 1 })
    const result = setExperiencePercent(
      state,
      "class",
      100,
      trackDef("class-def", { strength: 3, agility: 2 }, 5),
      config()
    )
    const j = result.journal
    // The journal must describe the WHOLE operation, not the last 25% step.
    expect(j.levelBefore).toBe(1)
    expect(j.quarterBefore).toBe(0)
    expect(j.raceLevelBefore).toBe(state.race.level)
    expect(j.turnsAdvanced).toBe(4)
    expect(j.percentBefore).toBe(0)
    expect(j.percentAfter).toBe(0)
    // Final after / award / offer values are retained from the last engine step.
    expect(j.leveledUp).toBe(true)
    expect(j.levelAfter).toBe(2)
    expect(j.quarterAfter).toBe(0)
    expect(j.raceLevelAfter).toBe(j.raceLevelBefore)
    expect(j.award).toBeDefined()
    expect(j.award?.definitionId).toBe("class-def")
    expect(j.levelAfter).toBeGreaterThan(j.levelBefore)
  })

  it("aggregates the journal across a 40->100 level-up (initial before values retained)", () => {
    const state = character({ classLevel: 1, professionLevel: 1 })
    state.tracks["class"].experiencePercent = 40
    state.tracks["class"].quarter = 1
    const result = setExperiencePercent(
      state,
      "class",
      100,
      trackDef("class-def", { strength: 3, agility: 2 }, 5),
      config()
    )
    const j = result.journal
    // The journal must describe the WHOLE operation, not the last 25% step.
    expect(j.levelBefore).toBe(1)
    expect(j.quarterBefore).toBe(1)
    expect(j.raceLevelBefore).toBe(state.race.level)
    expect(j.turnsAdvanced).toBe(3)
    expect(j.percentBefore).toBe(40)
    expect(j.percentAfter).toBe(0)
    // Final after / award / offer values are retained from the last engine step.
    expect(j.leveledUp).toBe(true)
    expect(j.levelAfter).toBe(2)
    expect(j.quarterAfter).toBe(0)
    expect(j.award).toBeDefined()
    expect(j.award?.definitionId).toBe("class-def")
    expect(j.levelAfter).toBeGreaterThan(j.levelBefore)
  })

  it("lowers 70% -> 10% (quarter 0) without advancing the turn or revoking awards", () => {
    const state = character({ classLevel: 5, professionLevel: 5 })
    state.tracks["class"].experiencePercent = 70
    state.tracks["class"].quarter = 2
    const def = trackDef("class-def", { strength: 1 }, 0)
    const result = setExperiencePercent(state, "class", 10, def, config())
    expect(result.journal.turnsAdvanced).toBe(0)
    expect(result.journal.leveledUp).toBe(false)
    expect(result.state.turn).toBe(state.turn)
    expect(result.state.tracks["class"].experiencePercent).toBe(10)
    expect(result.state.tracks["class"].quarter).toBe(0)
    expect(result.journal.levelBefore).toBe(5)
    expect(result.journal.levelAfter).toBe(5)
    // Awards are never revoked by a backward set.
    expect(result.state.historicalLevelAwards).toEqual(
      state.historicalLevelAwards
    )
  })

  it("is a no-op (no turn change) when target equals current", () => {
    const state = character({ classLevel: 1, professionLevel: 1 })
    state.tracks["class"].experiencePercent = 25
    state.tracks["class"].quarter = 1
    const result = setExperiencePercent(
      state,
      "class",
      25,
      trackDef("class-def", { strength: 1 }, 0),
      config()
    )
    expect(result.journal.turnsAdvanced).toBe(0)
    expect(result.state).toBe(state)
    expect(result.state.turn).toBe(state.turn)
  })

  it("sets EXP percent on an independent (monster) race, and rejects a derived race", () => {
    const state = monsterState({ grade: "F" })
    const result = setExperiencePercent(
      state,
      "race",
      25,
      monsterRaceDef,
      monsterCfg
    )
    expect(result.state.race.experiencePercent).toBe(25)
    expect(result.state.race.quarter).toBe(1)
    expect(result.state.turn).toBe(1)
    expect(result.journal.turnsAdvanced).toBe(1)

    const derived = character({ classLevel: 1, professionLevel: 1 })
    expect(() =>
      setExperiencePercent(derived, "race", 25, monsterRaceDef, monsterCfg)
    ).toThrow(/independent race mode/)
  })

  it("fails atomically (no partial state) when a 100% level-up would push past a closed grade gate", () => {
    // Monster at grade F, level 25, quarter 3 (75%): the next level-up pushes to
    // 26, past E's entry (25), while still grade F => advanceRaceQuarter throws.
    const state = monsterState({ grade: "F", level: 25, quarter: 3 })
    expect(() =>
      setExperiencePercent(state, "race", 100, monsterRaceDef, monsterCfg)
    ).toThrow(/past the F->E threshold/)
    // The input state is untouched (the engine is pure).
    expect(state.race.level).toBe(25)
    expect(state.race.quarter).toBe(3)
  })

  it("snapshots the level award immutably when leveling via EXP percent", () => {
    const state = character({ classLevel: 1, professionLevel: 1 })
    state.tracks["class"].experiencePercent = 75
    state.tracks["class"].quarter = 3
    const def = {
      id: "class-def",
      name: "class-def",
      fixed: { strength: 7 },
      free: 0,
    }
    const result = setExperiencePercent(state, "class", 100, def, config())
    const snapshot = result.state.historicalLevelAwards[0].fixed
    expect(snapshot.strength).toBe(7)
    // Mutating the source definition must not change the stored snapshot.
    ;(def.fixed as { strength: number }).strength = 99
    expect(result.state.historicalLevelAwards[0].fixed.strength).toBe(7)
  })
})

describe("levelUpFromExperience", () => {
  it("levels a track from any percentage (including 0) and resets percent to 0", () => {
    const state = character({ classLevel: 1, professionLevel: 1 })
    state.tracks["class"].experiencePercent = 0
    state.tracks["class"].quarter = 0
    const result = levelUpFromExperience(
      state,
      "class",
      trackDef("class-def", { strength: 3, agility: 2 }, 5),
      config()
    )
    expect(result.journal.leveledUp).toBe(true)
    expect(result.journal.turnsAdvanced).toBe(4)
    expect(result.state.turn).toBe(state.turn + 4)
    expect(result.state.tracks["class"].level).toBe(2)
    expect(result.state.tracks["class"].experiencePercent).toBe(0)
    expect(result.state.tracks["class"].quarter).toBe(0)
    expect(result.state.historicalLevelAwards).toHaveLength(1)
    // The journal merges the final engine step's award snapshot.
    expect(result.journal.award?.definitionId).toBe("class-def")
  })
})

describe("grade ceiling level-up blockers", () => {
  const blockerConfig = config({
    raceDefinitions: {
      F: { id: "race-f", perLevel: { strength: 1 }, freePerLevel: 1 },
    },
  })

  function monsterState(
    overrides: { level?: number; grade?: Grade } = {}
  ): CharacterState {
    return createCharacterState({
      baseAttributes: zeroVector(),
      tracks: {},
      race: {
        level: overrides.level ?? 0,
        grade: overrides.grade ?? "F",
        mode: "independent",
        quarter: 0,
      },
    })
  }

  it("allows a monster race level-up exactly at the next grade threshold (F24->25)", () => {
    const state = monsterState({ level: 24, grade: "F" })
    expect(gradeLevelUpBlockReason(state, "race", blockerConfig)).toBeNull()
    expect(gradeLevelUpBlockers(state, blockerConfig)).toEqual({})
  })

  it("blocks a monster race level-up one above the next grade threshold", () => {
    const state = monsterState({ level: 25, grade: "F" })
    const reason = gradeLevelUpBlockReason(state, "race", blockerConfig)
    expect(reason).toContain("F->E")
    expect(reason).toContain("26")
    expect(gradeLevelUpBlockers(state, blockerConfig)).toEqual({
      race: expect.stringContaining("race"),
    })
  })

  it("exposes only the race key for a monster and only class/profession for a derived race", () => {
    const monster = monsterState({ level: 25, grade: "F" })
    expect(Object.keys(gradeLevelUpBlockers(monster, blockerConfig))).toEqual([
      "race",
    ])
    // An enlightened race at the F->E threshold (class 25 -> 26 gives derived race
    // 25, not past E entry 25) blocks nothing, so the map carries no keys.
    const enlightened = character({ classLevel: 25, professionLevel: 24 })
    expect(Object.keys(gradeLevelUpBlockers(enlightened, config()))).toEqual([])
  })

  it("blocks an enlightened class when the derived race gate crosses the threshold", () => {
    const state = character({ classLevel: 27, professionLevel: 24 })
    state.race.grade = "F"
    // derived race floor((27+24)/2)=25; class 27 -> 28 gives floor((28+24)/2)=26 > 25.
    const reason = gradeLevelUpBlockReason(state, "class", blockerConfig)
    expect(reason).toContain("F->E")
    expect(reason).toContain("26")
    // The derived race level is the symmetric average of both tracks, so a class
    // and a profession level-up project the SAME race level and both are blocked
    // when that projection crosses the ceiling.
    expect(gradeLevelUpBlockers(state, blockerConfig)).toEqual({
      class: expect.stringContaining("race"),
      profession: expect.stringContaining("race"),
    })
  })

  it("does not block when the derived race reaches the threshold exactly", () => {
    const state = character({ classLevel: 25, professionLevel: 24 })
    state.race.grade = "F"
    // class 25 -> 26 gives floor((26+24)/2)=25, exactly E's entry level (25).
    expect(gradeLevelUpBlockReason(state, "class", blockerConfig)).toBeNull()
  })

  it("reports the derived race gate before the track gate when both would block", () => {
    const state = character({ classLevel: 25, professionLevel: 100 })
    state.race.grade = "F"
    state.tracks["class"].grade = "F"
    // class 25 -> 26: the track gate (F->E entry 25) blocks AND the derived race
    // gate blocks (floor((26+100)/2)=63 > 25). The derived race gate must be
    // reported before the track gate.
    const reason = gradeLevelUpBlockReason(state, "class", blockerConfig)
    expect(reason).toContain("race")
    expect(gradeLevelUpBlockers(state, blockerConfig).class).toContain("race")
  })

  it("unblocks a class level-up after the race grade is evolved", () => {
    const state = character({ classLevel: 27, professionLevel: 24 })
    state.race.grade = "E"
    // class 27 -> 28 gives derived race 26, well inside E (next D entry 100).
    expect(gradeLevelUpBlockReason(state, "class", blockerConfig)).toBeNull()
  })

  it("never caps a track at grade S (no next band)", () => {
    const state = monsterState({ level: 1000, grade: "S" })
    expect(gradeLevelUpBlockReason(state, "race", config())).toBeNull()
    expect(gradeLevelUpBlockers(state, config())).toEqual({})
  })

  it("caps a graded track independently and leaves an ungraded track uncapped", () => {
    // Graded class at F, level 25 -> 26, past E's entry (25).
    const graded = character({ classLevel: 25, professionLevel: 0 })
    graded.tracks["class"].grade = "F"
    graded.race.grade = "F"
    const reason = gradeLevelUpBlockReason(graded, "class", blockerConfig)
    expect(reason).toContain("class")
    // An ungraded class at the same level carries no track gate.
    const ungraded = character({ classLevel: 25, professionLevel: 0 })
    ungraded.race.grade = "F"
    expect(gradeLevelUpBlockReason(ungraded, "class", blockerConfig)).toBeNull()
  })

  it("honors a custom grade table", () => {
    const custom = config({
      gradeTable: [
        { grade: "G", min: 0, max: 9, entryLevel: 0 },
        { grade: "F", min: 0, max: 24, entryLevel: 10 },
        { grade: "E", min: 20, max: 99, entryLevel: 20 },
        { grade: "D", min: 100, max: 199, entryLevel: 100 },
        { grade: "C", min: 200, max: 349, entryLevel: 200 },
        { grade: "B", min: 350, max: 499, entryLevel: 350 },
        { grade: "A", min: 500, max: 749, entryLevel: 500 },
        { grade: "S", min: 750, max: 999, entryLevel: 750 },
      ],
    })
    // Monster at F level 19: 19 -> 20 reaches the custom E entry (20), allowed.
    expect(
      gradeLevelUpBlockReason(
        monsterState({ level: 19, grade: "F" }),
        "race",
        custom
      )
    ).toBeNull()
    // Monster at F level 20: 20 -> 21 pushes past the custom E entry (20), blocked.
    const reason = gradeLevelUpBlockReason(
      monsterState({ level: 20, grade: "F" }),
      "race",
      custom
    )
    expect(reason).toContain("21")
    expect(reason).toContain("F->E")
  })
})
