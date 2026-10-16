import { describe, expect, it } from "vitest"
import {
  DEFAULT_HOUSE_RULES_CONFIG,
  HOUSE_RULES_ID,
  houseRulesConfigSchema,
  loadHouseRules,
  type HouseRulesConfig,
  type HouseRulesDbClient,
} from "./ruleset"

describe("houseRulesConfigSchema", () => {
  // A complete, valid config; each test overrides only the field it exercises.
  // `overrides` is intentionally loose (`Record<string, unknown>`) so a test that
  // rejects an unknown top-level key or an unknown consumable grade key can still
  // pass that key through to the strict schema without a type error.
  function cfg(overrides: Record<string, unknown> = {}) {
    return {
      ...DEFAULT_HOUSE_RULES_CONFIG,
      ...overrides,
    } as HouseRulesConfig
  }

  it("accepts the documented default shape", () => {
    const parsed = houseRulesConfigSchema.parse(DEFAULT_HOUSE_RULES_CONFIG)
    expect(parsed).toEqual(DEFAULT_HOUSE_RULES_CONFIG)
  })

  it("rejects a percentage below 0", () => {
    expect(() =>
      houseRulesConfigSchema.parse(cfg({ equipmentIndividualCapPercent: -1 }))
    ).toThrow()
  })

  it("rejects a percentage above 100", () => {
    expect(() =>
      houseRulesConfigSchema.parse(cfg({ equipmentIndividualCapPercent: 101 }))
    ).toThrow()
  })

  it("rejects a non-integer percentage", () => {
    expect(() =>
      houseRulesConfigSchema.parse(cfg({ equipmentIndividualCapPercent: 20.5 }))
    ).toThrow()
  })

  it("rejects a maxTranscendentSkills below 0", () => {
    expect(() =>
      houseRulesConfigSchema.parse(cfg({ maxTranscendentSkills: -1 }))
    ).toThrow()
  })

  it("rejects a maxTranscendentSkills above 8", () => {
    expect(() =>
      houseRulesConfigSchema.parse(cfg({ maxTranscendentSkills: 9 }))
    ).toThrow()
  })

  it("rejects a non-integer maxTranscendentSkills", () => {
    expect(() =>
      houseRulesConfigSchema.parse(cfg({ maxTranscendentSkills: 2.5 }))
    ).toThrow()
  })

  it("accepts the documented default maxTranscendentSkills", () => {
    const parsed = houseRulesConfigSchema.parse(cfg({}))
    expect(parsed.maxTranscendentSkills).toBe(3)
  })

  it("rejects a grade rate above 100000", () => {
    expect(() =>
      houseRulesConfigSchema.parse(
        cfg({ consumableGradeRates: { F: 100001, E: 5, D: 15, C: 45 } })
      )
    ).toThrow()
  })

  it("rejects a negative grade rate", () => {
    expect(() =>
      houseRulesConfigSchema.parse(
        cfg({ consumableGradeRates: { F: 3, E: -1, D: 15, C: 45 } })
      )
    ).toThrow()
  })

  it("rejects an unknown top-level key (strict)", () => {
    expect(() => houseRulesConfigSchema.parse(cfg({ futureKnob: 1 }))).toThrow()
  })

  it("rejects an unknown consumable grade key (strict)", () => {
    expect(() =>
      houseRulesConfigSchema.parse(
        cfg({ consumableGradeRates: { F: 3, E: 5, D: 15, C: 45, B: 1 } })
      )
    ).toThrow()
  })

  it("rejects a missing required key", () => {
    expect(() =>
      houseRulesConfigSchema.parse(
        cfg({ equipmentCombinedCapPercent: undefined as never })
      )
    ).toThrow()
  })

  it("rejects a missing consumable grade key", () => {
    expect(() =>
      houseRulesConfigSchema.parse(
        cfg({ consumableGradeRates: { F: 3, E: 5, C: 45 } })
      )
    ).toThrow()
  })

  it("rejects a skill-choice interval below 1", () => {
    expect(() =>
      houseRulesConfigSchema.parse(
        cfg({ skillChoiceIntervals: { ...cfg({}).skillChoiceIntervals, F: 0 } })
      )
    ).toThrow()
  })

  it("rejects a skill-choice interval above 250", () => {
    expect(() =>
      houseRulesConfigSchema.parse(
        cfg({
          skillChoiceIntervals: { ...cfg({}).skillChoiceIntervals, S: 251 },
        })
      )
    ).toThrow()
  })

  it("rejects a non-integer skill-choice interval", () => {
    expect(() =>
      houseRulesConfigSchema.parse(
        cfg({
          skillChoiceIntervals: { ...cfg({}).skillChoiceIntervals, D: 20.5 },
        })
      )
    ).toThrow()
  })

  it("rejects a missing skill-choice interval key", () => {
    const intervals: Partial<HouseRulesConfig["skillChoiceIntervals"]> = {
      ...cfg({}).skillChoiceIntervals,
    }
    delete intervals.F
    expect(() =>
      houseRulesConfigSchema.parse(cfg({ skillChoiceIntervals: intervals }))
    ).toThrow()
  })
})

describe("loadHouseRules", () => {
  function inMemoryDb(
    row: {
      version: number
      config: unknown
      updatedAt: Date
    } | null
  ): HouseRulesDbClient {
    return {
      houseRules: {
        findUnique: async ({ where }) => {
          if (where.id !== HOUSE_RULES_ID) return null
          return row ? { id: HOUSE_RULES_ID, ...row } : null
        },
      },
    }
  }

  it("returns a validated row for the singleton id", async () => {
    const updatedAt = new Date("2026-01-01T00:00:00.000Z")
    const db = inMemoryDb({
      version: 4,
      config: DEFAULT_HOUSE_RULES_CONFIG,
      updatedAt,
    })
    const loaded = await loadHouseRules(db)
    expect(loaded).toEqual({
      version: 4,
      config: DEFAULT_HOUSE_RULES_CONFIG,
      updatedAt,
    })
  })

  it("throws a 503 ruleset_unavailable when the singleton row is absent", async () => {
    const db = inMemoryDb(null)
    await expect(loadHouseRules(db)).rejects.toMatchObject({
      status: 503,
      code: "ruleset_unavailable",
    })
  })

  it("throws on a malformed persisted config instead of defaulting", async () => {
    const db = inMemoryDb({
      version: 1,
      config: { equipmentIndividualCapPercent: 20, weird: true },
      updatedAt: new Date(),
    })
    await expect(loadHouseRules(db)).rejects.toThrow()
  })
})
