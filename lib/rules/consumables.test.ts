import { describe, expect, it } from "vitest"
import { calculateStatus } from "./calculate"
import {
  computeConsumables,
  consumableToEffect,
  consumableCapForGrade,
  consume,
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

describe("consumable grade rates / cumulative cap", () => {
  it("caps cumulative consumable bonus at the grade rate", () => {
    const state = character({ raceGrade: "F" })
    state.baseAttributes = { ...state.baseAttributes, strength: 100 }
    state.activeEffects.push(consumableEffect(2), consumableEffect(2))

    const result = calculateStatus(state, config())
    // F-grade rate = 3 -> requested 4, applied 3, suppressed 1.
    expect(result.consumables.requested.strength).toBe(4)
    expect(result.consumables.applied.strength).toBe(3)
    expect(result.consumables.suppressed.strength).toBe(1)
    expect(result.attributes.strength).toBe(103)
  })

  it("uses the grade-band-specific cumulative cap", () => {
    const state = character({ raceGrade: "D" })
    state.baseAttributes = { ...state.baseAttributes, strength: 100 }
    state.activeEffects.push(
      consumableToEffect(
        { id: "p1", name: "p1", group: "potion", amount: { strength: 10 } },
        state
      ),
      consumableToEffect(
        { id: "p2", name: "p2", group: "potion", amount: { strength: 10 } },
        state
      )
    )
    const result = calculateStatus(state, config())
    // D-grade rate = 15 -> requested 20, applied 15, suppressed 5.
    expect(result.consumables.applied.strength).toBe(15)
    expect(result.consumables.suppressed.strength).toBe(5)
  })

  it("applies the fallback rate when the grade has no rate", () => {
    const state = character({ raceGrade: "G" })
    state.baseAttributes = { ...state.baseAttributes, strength: 100 }
    state.activeEffects.push(consumableEffect(4))
    const cfg = config({ consumableFallbackRate: 2 })
    const result = calculateStatus(state, cfg)
    // G-grade has no default rate; fallback 2 caps the +4 to 2.
    expect(result.consumables.applied.strength).toBe(2)
    expect(result.consumables.suppressed.strength).toBe(2)
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
    expect(() =>
      consume(
        { id: "x", name: "x", group: "g", amount: { strength: 1 } },
        character()
      )
    ).not.toThrow()
  })
})

describe("cumulative consumable cap via computeConsumables", () => {
  it("applies the cumulative cap per attribute", () => {
    const effects = [consumableEffect(4), consumableEffect(4)]
    const status = computeConsumables(effects, "F", config())
    expect(status.requested.strength).toBe(8)
    expect(status.applied.strength).toBe(3)
    expect(status.suppressed.strength).toBe(5)
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
})
