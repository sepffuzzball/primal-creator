import { describe, expect, it } from "vitest"
import { calculateStatus } from "./calculate"
import {
  applyPermanentConsumable,
  computeConsumables,
  consumableToEffect,
  consumableCapForGrade,
  consume,
  permanentConsumableCap,
} from "./consumables"
import { character, config } from "./testUtils"

function consumableEffect(amount: number, turnsUntilExpiry?: number) {
  return consumableToEffect(
    {
      id: "potion",
      name: "Potion",
      group: "potion",
      amount: { strength: amount },
      durationQuarters: turnsUntilExpiry,
    },
    character()
  )
}

describe("permanent consumable grade rates / cumulative cap", () => {
  it("sums per-level rates cumulatively and steps at the F24->E25 boundary", () => {
    const cfg = config()
    const born = { origin: "born" as const }
    const capAt24 = permanentConsumableCap(24, cfg, born)
    const capAt25 = permanentConsumableCap(25, cfg, born)
    // Born-F: every level 1..24 is F rate 3 (24 * 3 = 72); at 25 the E rate of 5
    // adds, stepping the capacity from 72 to 77.
    expect(capAt24.strength).toBe(72)
    expect(capAt25.strength).toBe(77)
  })

  it("counts born-F levels 1..9 at the F rate, integrated-G at the G rate", () => {
    const cfg = config()
    expect(permanentConsumableCap(0, cfg, { origin: "born" }).strength).toBe(0)
    expect(permanentConsumableCap(1, cfg, { origin: "born" }).strength).toBe(3)
    expect(permanentConsumableCap(1, cfg).strength).toBe(0)
    expect(
      permanentConsumableCap(1, cfg, { origin: "integrated" }).strength
    ).toBe(0)
  })

  it("applies permanent consumable gains to attributes without re-capping", () => {
    const state = character({
      raceGrade: "F",
      raceLevel: 10,
      raceOrigin: "born",
    })
    const applied = applyPermanentConsumable(
      state,
      "potion",
      { strength: 4 },
      config()
    )
    expect(applied.ok).toBe(true)
    const result = calculateStatus(applied.state, config())
    expect(result.attributes.strength).toBe(14)
  })

  it("does not re-cap a recorded permanent gain on later config changes", () => {
    const state = character({
      raceGrade: "F",
      raceLevel: 10,
      raceOrigin: "born",
    })
    const applied = applyPermanentConsumable(
      state,
      "potion",
      { strength: 25 },
      config()
    )
    expect(applied.ok).toBe(true)
    // A later tighter config would now cap at 10, but the +25 is a historical
    // fact and must be preserved verbatim.
    const tight = config({ consumableGradeRates: { F: 1 } })
    const result = calculateStatus(applied.state, tight)
    expect(result.attributes.strength).toBe(35)
  })
})

describe("applyPermanentConsumable", () => {
  it("supports multiple distinct consumptions", () => {
    const state = character({
      raceGrade: "F",
      raceLevel: 10,
      raceOrigin: "born",
    })
    const first = applyPermanentConsumable(
      state,
      "potion-a",
      { strength: 5 },
      config()
    )
    expect(first.ok).toBe(true)
    const second = applyPermanentConsumable(
      first.state,
      "potion-b",
      { agility: 3 },
      config()
    )
    expect(second.ok).toBe(true)
    expect(second.state.permanentGains.length).toBe(2)
    expect(second.remaining.strength).toBe(25)
    expect(second.remaining.agility).toBe(27)
  })

  it("rejects the whole gain atomically when any attribute exceeds its cap", () => {
    const state = character({
      raceGrade: "F",
      raceLevel: 10,
      raceOrigin: "born",
    })
    const first = applyPermanentConsumable(
      state,
      "a",
      { strength: 20 },
      config()
    )
    expect(first.ok).toBe(true)
    // strength remaining 10, agility remaining 30. Request agility 35 (over) with
    // strength 5 (within) -> the whole gain is rejected, not partially applied.
    const over = applyPermanentConsumable(
      first.state,
      "b",
      { strength: 5, agility: 35 },
      config()
    )
    expect(over.ok).toBe(false)
    expect(over.state.permanentGains.length).toBe(1)
    expect(over.entry).toBeNull()
    expect(over.remaining.strength).toBe(10)
    expect(over.remaining.agility).toBe(30)
  })

  it("rejects an out-of-cap gain without modifying the state or entry", () => {
    const state = character({
      raceGrade: "F",
      raceLevel: 10,
      raceOrigin: "born",
    })
    const over = applyPermanentConsumable(
      state,
      "potion",
      { strength: 31 },
      config()
    )
    // cap 30 at born-F level 10.
    expect(over.ok).toBe(false)
    expect(over.state.permanentGains.length).toBe(0)
    expect(over.entry).toBeNull()
  })

  it("rejects negative and fractional request values", () => {
    const state = character()
    expect(
      applyPermanentConsumable(state, "p", { strength: -1 }, config()).ok
    ).toBe(false)
    expect(
      applyPermanentConsumable(state, "p", { strength: 2.5 }, config()).ok
    ).toBe(false)
    expect(applyPermanentConsumable(state, "p", {}, config()).ok).toBe(false)
  })

  it("records strict provenance fields on a new consumable entry", () => {
    const state = character({
      raceGrade: "F",
      raceLevel: 10,
      raceOrigin: "born",
    })
    const applied = applyPermanentConsumable(
      state,
      "potion",
      { strength: 6 },
      config()
    )
    expect(applied.ok).toBe(true)
    const entry = applied.state.permanentGains[0]
    expect(entry.kind).toBe("consumable")
    expect(entry.source).toBe("potion")
    expect(entry.vector).toEqual({ strength: 6 })
    expect(entry.requested).toEqual({ strength: 6 })
    expect(entry.gradeAtApplication).toBe("F")
    expect(entry.raceLevelAtApplication).toBe(10)
    expect(entry.capRemainingAfter).toMatchObject({
      strength: 24,
      agility: 30,
      endurance: 30,
    })
    expect(typeof entry.appliedAt).toBe("number")
  })
})

describe("legacy no-origin state resolves conservatively to integrated", () => {
  it("never infers a legacy no-origin non-G grade as born (F level 10 cap 3, not 30)", () => {
    const cfg = config()
    // No origin option -> conservative integrated: only level 10 counts at the F
    // rate (levels 1..9 stay G rate 0), so the capacity is 3, not the born 30.
    expect(permanentConsumableCap(10, cfg).strength).toBe(3)
    expect(permanentConsumableCap(10, cfg, { origin: "born" }).strength).toBe(
      30
    )
  })

  it("rejects an over-cap grant for a legacy no-origin F state (integrated default)", () => {
    const state = character({ raceGrade: "F", raceLevel: 10 })
    // Simulate a legacy state created before race.origin was tracked.
    delete state.race.origin
    const over = applyPermanentConsumable(
      state,
      "potion",
      { strength: 4 },
      config()
    )
    expect(over.ok).toBe(false)
    expect(over.errors.join("; ")).toMatch(
      /exceeds remaining permanent-consumable cap/
    )
    // A request inside the integrated capacity is accepted.
    const within = applyPermanentConsumable(
      state,
      "potion",
      { strength: 3 },
      config()
    )
    expect(within.ok).toBe(true)
    expect(within.entry?.vector).toEqual({ strength: 3 })
  })

  it("still grants the full born capacity when origin is explicitly recorded", () => {
    const state = character({
      raceGrade: "F",
      raceLevel: 10,
      raceOrigin: "born",
    })
    const applied = applyPermanentConsumable(
      state,
      "potion",
      { strength: 4 },
      config()
    )
    expect(applied.ok).toBe(true)
    expect(applied.remaining.strength).toBe(26)
  })
})

describe("temporary effects are uncapped", () => {
  it("does not truncate a large temporary consumable bonus", () => {
    const state = character({ raceGrade: "F" })
    state.baseAttributes = { ...state.baseAttributes, strength: 100 }
    state.activeEffects.push(consumableEffect(50))
    const result = calculateStatus(state, config())
    expect(result.consumables.requested.strength).toBe(50)
    expect(result.consumables.applied.strength).toBe(50)
    expect(result.consumables.suppressed.strength).toBe(0)
    expect(result.attributes.strength).toBe(150)
  })

  it("computeConsumables leaves temporary effects untruncated with no cap usage", () => {
    const effects = [consumableEffect(4), consumableEffect(4)]
    const status = computeConsumables(effects, "F", config())
    expect(status.requested.strength).toBe(8)
    expect(status.applied.strength).toBe(8)
    expect(status.suppressed.strength).toBe(0)
    expect(status.capUsage).toEqual([])
  })

  it("reports requested equal to applied for active temporary effects", () => {
    const state = character({ raceGrade: "F" })
    state.baseAttributes = { ...state.baseAttributes, strength: 100 }
    state.activeEffects.push(consumableEffect(6))
    const result = calculateStatus(state, config())
    expect(result.consumables.requested.strength).toBe(6)
    expect(result.consumables.applied.strength).toBe(6)
    expect(result.consumables.suppressed.strength).toBe(0)
  })

  it("does not cap non-consumable temporary effects", () => {
    const state = character({ raceGrade: "F" })
    state.baseAttributes = { ...state.baseAttributes, strength: 100 }
    state.activeEffects.push({
      id: "buff",
      source: "buff",
      provenance: "assumption",
      phase: "temporary",
      amount: { strength: 6 },
      group: "buffs",
      stacking: "stack",
    })
    const result = calculateStatus(state, config())
    expect(result.attributes.strength).toBe(106)
    expect(result.consumables.applied.strength).toBe(0)
  })
})

describe("legacy permanent gains unchanged", () => {
  it("applies buff permanent gains without a consumable cap", () => {
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

describe("consumable effect conversion", () => {
  it("converts a consumed consumable into a temporary effect", () => {
    const effect = consumableToEffect(
      { id: "c1", name: "Elixir", group: "potion", amount: { strength: 3 } },
      character()
    )
    expect(effect.phase).toBe("temporary")
    expect(effect.source).toBe("consumable")
    expect(effect.stacking).toBe("stackCapped")
    if (effect.phase === "temporary") {
      expect(effect.amount.strength).toBe(3)
    } else {
      throw new Error("expected a temporary effect")
    }
  })

  it("sets an expiry based on duration quarters", () => {
    const state = character()
    const effect = consumableToEffect(
      {
        id: "c2",
        name: "Elixir",
        group: "potion",
        amount: { strength: 1 },
        durationQuarters: 3,
      },
      state
    )
    expect(effect.expiresAt).toBe(state.turn + 3)
  })

  it("exposes consumableCapForGrade and consumableToEffect helpers", () => {
    const cfg = config()
    expect(consumableCapForGrade("F", cfg)).toBe(3)
    expect(consumableCapForGrade("E", cfg)).toBe(5)
    expect(consumableCapForGrade("D", cfg)).toBe(15)
    expect(consumableCapForGrade("C", cfg)).toBe(45)
    expect(
      consumableCapForGrade("G", config({ consumableFallbackRate: 2 }))
    ).toBe(2)
    expect(() =>
      consume(
        { id: "x", name: "x", group: "g", amount: { strength: 1 } },
        character()
      )
    ).not.toThrow()
  })
})

describe("consumable bounds (regression)", () => {
  it("rejects a negative durationQuarters", () => {
    const state = character()
    expect(() =>
      consumableToEffect(
        {
          id: "c",
          name: "c",
          group: "potion",
          amount: { strength: 1 },
          durationQuarters: -1,
        },
        state
      )
    ).toThrow(/durationQuarters/)
  })

  it("rejects a fractional durationQuarters", () => {
    const state = character()
    expect(() =>
      consumableToEffect(
        {
          id: "c",
          name: "c",
          group: "potion",
          amount: { strength: 1 },
          durationQuarters: 1.5,
        },
        state
      )
    ).toThrow(/durationQuarters/)
  })

  it("rejects a negative consumable grade rate", () => {
    expect(() =>
      consumableCapForGrade("F", config({ consumableGradeRates: { F: -1 } }))
    ).toThrow(/rate/)
    expect(() =>
      consumableCapForGrade("G", config({ consumableFallbackRate: -2 }))
    ).toThrow(/rate/)
  })

  it("rejects a non-integer race level for the cap", () => {
    expect(() => permanentConsumableCap(1.5, config())).toThrow(/raceLevel/)
  })
})
