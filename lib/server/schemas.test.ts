import { describe, expect, it } from "vitest"
import {
  blessingConfigSchema,
  bloodlineConfigSchema,
  evolveSchema,
  godConfigSchema,
  isLegacyBlessingConfig,
  isLegacyBloodlineConfig,
} from "@/lib/server/schemas"

describe("evolveSchema (evolution union)", () => {
  it("parses a legacy race path with no track key", () => {
    const parsed = evolveSchema.safeParse({ optionId: "evo-1", version: 0 })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      // No `track` is injected by the schema; the legacy race shape is preserved.
      expect(parsed.data).toEqual({ optionId: "evo-1", version: 0 })
      expect((parsed.data as { track?: string }).track).toBeUndefined()
    }
  })

  it("parses an explicit race path with track: 'race'", () => {
    const parsed = evolveSchema.safeParse({
      track: "race",
      optionId: "evo-1",
      version: 0,
      reason: "story",
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).toEqual({
        track: "race",
        optionId: "evo-1",
        version: 0,
        reason: "story",
      })
    }
  })

  it("preserves track on a class path instead of stripping it into a race path", () => {
    const parsed = evolveSchema.safeParse({
      track: "class",
      optionId: "evo-c",
      version: 0,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      // The bug: with a race schema that omitted `track`, a class/profession path
      // was matched and `track` silently stripped, so this parsed as a race path.
      expect(parsed.data).toEqual({
        track: "class",
        optionId: "evo-c",
        version: 0,
      })
      expect((parsed.data as { track?: string }).track).toBe("class")
    }
  })

  it("preserves track on a profession path", () => {
    const parsed = evolveSchema.safeParse({
      track: "profession",
      optionId: "evo-p",
      version: 0,
      reason: "story",
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).toEqual({
        track: "profession",
        optionId: "evo-p",
        version: 0,
        reason: "story",
      })
    }
  })

  it("parses a legacy grade-only path", () => {
    const parsed = evolveSchema.safeParse({ grade: "F", version: 0 })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).toEqual({ grade: "F", version: 0 })
    }
  })

  it("rejects a payload with no recognized evolution shape", () => {
    const parsed = evolveSchema.safeParse({})
    expect(parsed.success).toBe(false)
  })
})

describe("blessing / bloodline / god catalog config", () => {
  it("parses a modern blessing config and preserves its typed effects", () => {
    const parsed = blessingConfigSchema.safeParse({
      tier: "Major",
      effects: [{ phase: "flat", amount: { strength: 5 } }],
      compatibleBlessingStableIds: ["bless-2"],
      upgradeGroup: "viper",
      patronGodStableId: "malefic-viper",
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.tier).toBe("Major")
      expect(parsed.data.effects).toHaveLength(1)
    }
  })

  it("reads a legacy blessing config (grade/effect) without tier/effects", () => {
    const parsed = blessingConfigSchema.safeParse({
      grade: "F",
      effect: { strength: 3 },
    })
    expect(parsed.success).toBe(true)
  })

  it("detects a legacy blessing vs modern blessing config", () => {
    expect(
      isLegacyBlessingConfig({ grade: "F", effect: { strength: 3 } })
    ).toBe(true)
    expect(isLegacyBlessingConfig({ tier: "Minor", effects: [] })).toBe(false)
  })

  it("rejects a blessing effect vector that is not a finite integer", () => {
    const parsed = blessingConfigSchema.safeParse({
      tier: "Minor",
      effects: [{ phase: "flat", amount: { strength: 1.5 } }],
    })
    expect(parsed.success).toBe(false)
  })

  it("parses a modern bloodline config with narrative-only effects", () => {
    const parsed = bloodlineConfigSchema.safeParse({
      effects: [],
      gradeEffects: {
        G: [{ phase: "percent", basisPoints: { perception: 500 } }],
      },
      upgradeGroup: "primal-hunter",
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.gradeEffects).toHaveProperty("G")
    }
  })

  it("reads a legacy bloodline config (grade/vector) without effects", () => {
    const parsed = bloodlineConfigSchema.safeParse({
      grade: "F",
      vector: { strength: 2 },
    })
    expect(parsed.success).toBe(true)
  })

  it("detects a legacy bloodline vs modern bloodline config", () => {
    expect(
      isLegacyBloodlineConfig({ grade: "F", vector: { strength: 2 } })
    ).toBe(true)
    expect(isLegacyBloodlineConfig({ effects: [] })).toBe(false)
  })

  it("rejects an invalid grade key in a bloodline gradeEffects map", () => {
    const parsed = bloodlineConfigSchema.safeParse({
      effects: [],
      gradeEffects: { Z: [{ phase: "flat", amount: { strength: 1 } }] },
    })
    expect(parsed.success).toBe(false)
  })

  it("parses a god config with pantheon/divineRank metadata", () => {
    const parsed = godConfigSchema.safeParse({
      pantheon: "Void",
      divineRank: "God",
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data ?? {}).toMatchObject({
      pantheon: "Void",
      divineRank: "God",
    })
  })

  it("reads a god config that only carries unknown fields", () => {
    const parsed = godConfigSchema.safeParse({ realm: "the void" })
    expect(parsed.success).toBe(true)
  })
})
