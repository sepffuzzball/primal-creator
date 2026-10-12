import { describe, expect, it } from "vitest"
import { calculateStatus, resolveActiveEffects } from "./calculate"
import { advanceQuarter } from "./progression"
import { character, config } from "./testUtils"
import type { GameEffect } from "./types"

describe("title replacement (stacking group)", () => {
  it("replaces an earlier title in the same group with the later one", () => {
    const state = character()
    state.activeEffects.push(
      {
        id: "title-a",
        source: "title",
        provenance: "assumption",
        phase: "flat",
        amount: { strength: 5 },
        group: "title",
        stacking: "replace",
      },
      {
        id: "title-b",
        source: "title",
        provenance: "assumption",
        phase: "flat",
        amount: { strength: 9 },
        group: "title",
        stacking: "replace",
      }
    )
    const result = calculateStatus(state, config())
    // Only the later title applies (+9), not +5.
    expect(result.attributes.strength).toBe(19)
  })

  it("keeps the last effect in insertion order within a group", () => {
    const state = character()
    state.activeEffects.push(
      {
        id: "t1",
        source: "title",
        provenance: "assumption",
        phase: "flat",
        amount: { strength: 1 },
        group: "title",
        stacking: "replace",
      },
      {
        id: "t2",
        source: "title",
        provenance: "assumption",
        phase: "flat",
        amount: { strength: 2 },
        group: "title",
        stacking: "replace",
      },
      {
        id: "t3",
        source: "title",
        provenance: "assumption",
        phase: "flat",
        amount: { strength: 4 },
        group: "title",
        stacking: "replace",
      }
    )
    const result = calculateStatus(state, config())
    expect(result.attributes.strength).toBe(14)
  })
})

describe("stack vs replace", () => {
  it("stacks all effects in a 'stack' group", () => {
    const state = character()
    state.activeEffects.push(
      {
        id: "s1",
        source: "buff",
        provenance: "assumption",
        phase: "flat",
        amount: { strength: 3 },
        group: "buffs",
        stacking: "stack",
      },
      {
        id: "s2",
        source: "buff",
        provenance: "assumption",
        phase: "flat",
        amount: { strength: 4 },
        group: "buffs",
        stacking: "stack",
      }
    )
    const result = calculateStatus(state, config())
    expect(result.attributes.strength).toBe(17)
  })
})

describe("expiration", () => {
  it("drops effects that have expired", () => {
    const state = character()
    state.activeEffects.push({
      id: "temp",
      source: "buff",
      provenance: "assumption",
      phase: "temporary",
      amount: { strength: 7 },
      expiresAt: 3,
      stacking: "stack",
    })
    // At turn 0 the effect is active.
    expect(calculateStatus(state, config()).attributes.strength).toBe(17)
    // Once the turn reaches the expiry, the effect is gone.
    state.turn = 3
    expect(calculateStatus(state, config()).attributes.strength).toBe(10)
  })

  it("keeps effects whose expiry has not yet arrived", () => {
    const state = character()
    state.activeEffects.push({
      id: "temp",
      source: "buff",
      provenance: "assumption",
      phase: "temporary",
      amount: { strength: 7 },
      expiresAt: 5,
      stacking: "stack",
    })
    state.turn = 4
    expect(calculateStatus(state, config()).attributes.strength).toBe(17)
  })

  it("expires effects through natural quarter advancement", () => {
    const state = character()
    state.activeEffects.push({
      id: "buffed",
      source: "buff",
      provenance: "assumption",
      phase: "temporary",
      amount: { strength: 7 },
      expiresAt: 1,
      stacking: "stack",
    })
    expect(calculateStatus(state, config()).attributes.strength).toBe(17)
    const advanced = advanceQuarter(
      state,
      "class",
      { id: "class-def", name: "class-def", fixed: { strength: 0 }, free: 0 },
      config()
    )
    // One advance moved turn 0 -> 1, which is >= expiresAt, so the effect is gone.
    expect(calculateStatus(advanced.state, config()).attributes.strength).toBe(
      10
    )
  })
})

describe("conditions", () => {
  it("does not apply an effect whose condition is not met", () => {
    const state = character()
    state.activeEffects.push({
      id: "cond",
      source: "skill",
      provenance: "assumption",
      phase: "flat",
      amount: { strength: 5 },
      condition: { kind: "gradeAtLeast", grade: "S" },
      stacking: "stack",
    })
    const result = calculateStatus(state, config())
    expect(result.attributes.strength).toBe(10)
  })

  it("applies an effect whose condition is met", () => {
    const state = character({ raceGrade: "D" })
    state.activeEffects.push({
      id: "cond",
      source: "skill",
      provenance: "assumption",
      phase: "flat",
      amount: { strength: 5 },
      condition: { kind: "gradeAtLeast", grade: "D" },
      stacking: "stack",
    })
    const result = calculateStatus(state, config())
    expect(result.attributes.strength).toBe(15)
  })

  it("honors levelAtLeast conditions", () => {
    const state = character({ classLevel: 10 })
    state.activeEffects.push({
      id: "cond",
      source: "skill",
      provenance: "assumption",
      phase: "flat",
      amount: { strength: 5 },
      condition: { kind: "levelAtLeast", track: "class", level: 12 },
      stacking: "stack",
    })
    expect(calculateStatus(state, config()).attributes.strength).toBe(10)
  })
})

describe("resolveActiveEffects grouping", () => {
  it("resolveActiveEffects returns replacement groups collapsed and stack groups intact", () => {
    const state = character()
    const effects: GameEffect[] = [
      {
        id: "a",
        source: "title",
        provenance: "x",
        phase: "flat",
        amount: { strength: 1 },
        group: "title",
        stacking: "replace",
      },
      {
        id: "b",
        source: "title",
        provenance: "x",
        phase: "flat",
        amount: { strength: 2 },
        group: "title",
        stacking: "replace",
      },
      {
        id: "c",
        source: "buff",
        provenance: "x",
        phase: "flat",
        amount: { strength: 3 },
        group: "buffs",
        stacking: "stack",
      },
      {
        id: "d",
        source: "buff",
        provenance: "x",
        phase: "flat",
        amount: { strength: 4 },
        group: "buffs",
        stacking: "stack",
      },
    ]
    const resolved = resolveActiveEffects(effects, state, "F")
    // 1 replaced title (the later one) + 2 stacked buffs.
    expect(resolved.length).toBe(3)
    expect(resolved.some((e) => e.id === "b")).toBe(true)
    expect(resolved.some((e) => e.id === "a")).toBe(false)
    expect(resolved.some((e) => e.id === "c")).toBe(true)
    expect(resolved.some((e) => e.id === "d")).toBe(true)
  })
})
