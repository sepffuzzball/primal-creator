import { describe, expect, it } from "vitest"
import {
  advanceSchema,
  blessingConfigSchema,
  bloodlineConfigSchema,
  characterCreateSchema,
  characterUpdateSchema,
  EQUIPMENT_RARITIES,
  EQUIPMENT_SLOTS,
  EQUIPMENT_UNIQUE_RARITY,
  equipmentConfigSchema,
  equipmentRaritySchema,
  evolveSchema,
  godConfigSchema,
  hasInvalidNaturalGradeConfig,
  hasInvalidRaceTypeConfig,
  inventoryPostSchema,
  isCanonicalEquipmentSlot,
  isIncompleteEquipmentConfig,
  isIncompleteRaceConfig,
  isIncompleteSkillRarity,
  isLegacyBlessingConfig,
  isLegacyBloodlineConfig,
  isLegacyTranscendentSkillConfig,
  normalizeEquipmentSlot,
  professionSetSchema,
  raceConfigSchema,
  rarityOrderIndex,
  raritySchema,
  skillConfigSchema,
  skillUpgradeSchema,
  specialAbilitiesSchema,
  titleConfigSchema,
  titleImprovementSchema,
  transcendentSkillConfigSchema,
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

  it("accepts the Baptism tier (below Minor) with no invented numeric effect", () => {
    // Baptism is the lowest entry tier; a baptism blessing carries no fabricated
    // numeric bonus, so `effects` is empty.
    const parsed = blessingConfigSchema.safeParse({
      tier: "Baptism",
      effects: [],
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.tier).toBe("Baptism")
      expect(parsed.data.effects).toEqual([])
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

describe("title catalog config (improvement)", () => {
  it("parses a ranked title config with a valid improvement descriptor", () => {
    const parsed = titleConfigSchema.safeParse({
      upgradeGroup: "dungeon-pioneer",
      flat: { strength: 3, agility: 3 },
      improvement: {
        seriesId: "dungeon-pioneer",
        rank: 3,
        minRaceGrade: "D",
      },
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.improvement).toEqual({
        seriesId: "dungeon-pioneer",
        rank: 3,
        minRaceGrade: "D",
      })
      expect(parsed.data.upgradeGroup).toBe("dungeon-pioneer")
    }
  })

  it("rejects a ranked title whose upgradeGroup differs from improvement.seriesId", () => {
    const parsed = titleConfigSchema.safeParse({
      upgradeGroup: "hero",
      improvement: {
        seriesId: "dungeon-pioneer",
        rank: 1,
        minRaceGrade: "E",
      },
    })
    expect(parsed.success).toBe(false)
  })

  it("accepts an ordinary title config with no improvement descriptor", () => {
    const parsed = titleConfigSchema.safeParse({
      flat: { strength: 5 },
      upgradeGroup: "hero",
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.improvement).toBeUndefined()
    }
  })

  it("titleImprovementSchema is a strict subobject (rejects unknown keys)", () => {
    const parsed = titleImprovementSchema.safeParse({
      seriesId: "dungeon-pioneer",
      rank: 1,
      minRaceGrade: "E",
      minGrade: "E", // typo
    })
    expect(parsed.success).toBe(false)
  })

  it("rejects an improvement with a rank outside 1..100 or a bad grade", () => {
    expect(
      titleImprovementSchema.safeParse({
        seriesId: "dungeon-pioneer",
        rank: 0,
        minRaceGrade: "E",
      }).success
    ).toBe(false)
    expect(
      titleImprovementSchema.safeParse({
        seriesId: "dungeon-pioneer",
        rank: 101,
        minRaceGrade: "E",
      }).success
    ).toBe(false)
    expect(
      titleImprovementSchema.safeParse({
        seriesId: "dungeon-pioneer",
        rank: 1,
        minRaceGrade: "Z",
      }).success
    ).toBe(false)
  })
})

describe("inventoryPostSchema", () => {
  it("parses a valid add payload", () => {
    const parsed = inventoryPostSchema.safeParse({
      operation: "add",
      definitionId: "gear-1",
      quantity: 5,
      version: 0,
      sourceNote: "bought a few",
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).toEqual({
        operation: "add",
        definitionId: "gear-1",
        quantity: 5,
        version: 0,
        sourceNote: "bought a few",
      })
    }
  })

  it("rejects a remove with a quantity outside 1..999999", () => {
    for (const quantity of [0, -1, 1000000]) {
      const parsed = inventoryPostSchema.safeParse({
        operation: "remove",
        definitionId: "pot-1",
        quantity,
        version: 0,
        sourceNote: "x",
      })
      expect(parsed.success).toBe(false)
    }
  })

  it("rejects a non-integer quantity", () => {
    const parsed = inventoryPostSchema.safeParse({
      operation: "add",
      definitionId: "gear-1",
      quantity: 1.5,
      version: 0,
      sourceNote: "x",
    })
    expect(parsed.success).toBe(false)
  })

  it("rejects an empty or over-long sourceNote", () => {
    expect(
      inventoryPostSchema.safeParse({
        operation: "add",
        definitionId: "gear-1",
        quantity: 1,
        version: 0,
        sourceNote: "",
      }).success
    ).toBe(false)
    const long = "x".repeat(501)
    expect(
      inventoryPostSchema.safeParse({
        operation: "add",
        definitionId: "gear-1",
        quantity: 1,
        version: 0,
        sourceNote: long,
      }).success
    ).toBe(false)
  })

  it("rejects an unknown operation", () => {
    const parsed = inventoryPostSchema.safeParse({
      operation: "buy",
      definitionId: "gear-1",
      quantity: 1,
      version: 0,
      sourceNote: "x",
    })
    expect(parsed.success).toBe(false)
  })

  it("rejects a negative version", () => {
    const parsed = inventoryPostSchema.safeParse({
      operation: "add",
      definitionId: "gear-1",
      quantity: 1,
      version: -1,
      sourceNote: "x",
    })
    expect(parsed.success).toBe(false)
  })
})

describe("professionSetSchema", () => {
  it("parses a valid set-once profession payload", () => {
    const parsed = professionSetSchema.safeParse({
      professionId: "prof-f",
      version: 0,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).toEqual({ professionId: "prof-f", version: 0 })
    }
  })

  it("rejects an empty professionId", () => {
    expect(
      professionSetSchema.safeParse({ professionId: "", version: 0 }).success
    ).toBe(false)
  })

  it("rejects a missing professionId", () => {
    expect(professionSetSchema.safeParse({ version: 0 }).success).toBe(false)
  })

  it("rejects a negative version", () => {
    expect(
      professionSetSchema.safeParse({ professionId: "prof-f", version: -1 })
        .success
    ).toBe(false)
  })

  it("rejects a non-integer version", () => {
    expect(
      professionSetSchema.safeParse({ professionId: "prof-f", version: 1.5 })
        .success
    ).toBe(false)
  })
})

describe("transcendent_skills catalog config", () => {
  it("parses a modern transcendent config and preserves its typed passive effects", () => {
    const parsed = transcendentSkillConfigSchema.safeParse({
      costDescription: "Loses a Path level to use",
      acquisitionNotes: "Granted after reaching S-grade",
      passiveEffects: [
        { phase: "flat", amount: { strength: 5, wisdom: -2 } },
        {
          phase: "percent",
          basisPoints: { perception: 500 },
          condition: { kind: "gradeAtLeast", grade: "C" },
          stacking: "stackCapped",
          group: "holyland",
        },
      ],
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.passiveEffects).toHaveLength(2)
      expect(parsed.data.passiveEffects?.[0]).toMatchObject({
        phase: "flat",
      })
      expect(parsed.data.passiveEffects?.[1]).toMatchObject({
        phase: "percent",
        group: "holyland",
      })
    }
  })

  it("reads a legacy transcendent config (no passiveEffects) without error", () => {
    const parsed = transcendentSkillConfigSchema.safeParse({
      costDescription: "Heavy cost",
    })
    expect(parsed.success).toBe(true)
  })

  it("detects a legacy vs modern transcendent config", () => {
    expect(isLegacyTranscendentSkillConfig({ costDescription: "x" })).toBe(true)
    expect(isLegacyTranscendentSkillConfig({ passiveEffects: [] })).toBe(false)
  })

  it("rejects a flat passive effect vector that is not a finite integer", () => {
    const parsed = transcendentSkillConfigSchema.safeParse({
      passiveEffects: [{ phase: "flat", amount: { strength: 1.5 } }],
    })
    expect(parsed.success).toBe(false)
  })

  it("rejects a percent passive effect with negative basis points", () => {
    const parsed = transcendentSkillConfigSchema.safeParse({
      passiveEffects: [{ phase: "percent", basisPoints: { perception: -5 } }],
    })
    expect(parsed.success).toBe(false)
  })

  it("parses a narrative-only transcendent with an empty passiveEffects list", () => {
    const parsed = transcendentSkillConfigSchema.safeParse({
      passiveEffects: [],
      acquisitionNotes: "A punch that ignores durability.",
    })
    expect(parsed.success).toBe(true)
  })
})

describe("specialAbilitiesSchema / characterCreateSchema", () => {
  it("accepts an omitted or empty special-ability selection", () => {
    expect(specialAbilitiesSchema.safeParse({}).success).toBe(true)
    expect(
      characterCreateSchema.safeParse({
        name: "Kael",
        origin: "integrated",
        raceId: "race-1",
        classId: "cls-1",
        specialAbilities: {},
      }).success
    ).toBe(true)
  })

  it("accepts an explicit selection of a blessing, a bloodline and a transcendent skill", () => {
    const parsed = characterCreateSchema.safeParse({
      name: "Kael",
      origin: "integrated",
      raceId: "race-1",
      classId: "cls-1",
      specialAbilities: {
        blessingId: "bless-1",
        bloodlineIds: ["blood-1"],
        transcendentSkillIds: ["trans-1"],
      },
    })
    expect(parsed.success).toBe(true)
  })

  it("rejects an empty blessingId", () => {
    expect(specialAbilitiesSchema.safeParse({ blessingId: "" }).success).toBe(
      false
    )
  })

  it("rejects a bloodline array with more than 1 id", () => {
    const ids = Array.from({ length: 2 }, (_, i) => `blood-${i}`)
    expect(
      specialAbilitiesSchema.safeParse({ bloodlineIds: ids }).success
    ).toBe(false)
  })

  it("rejects an id selected in more than one field (cross-field overlap)", () => {
    const parsed = specialAbilitiesSchema.safeParse({
      blessingId: "bless-1",
      bloodlineIds: ["bless-1"],
    })
    expect(parsed.success).toBe(false)
  })

  it("rejects a duplicate id within a single array", () => {
    const parsed = specialAbilitiesSchema.safeParse({
      bloodlineIds: ["blood-1", "blood-1"],
    })
    expect(parsed.success).toBe(false)
  })

  it("rejects an empty-string id inside an array", () => {
    expect(
      specialAbilitiesSchema.safeParse({ transcendentSkillIds: [""] }).success
    ).toBe(false)
  })
})

describe("character profile metadata schema bounds", () => {
  const base = {
    name: "Kael",
    origin: "integrated" as const,
    raceId: "race-1",
    classId: "cls-1",
  }

  it("accepts all six metadata fields on create and preserves them", () => {
    const parsed = characterCreateSchema.safeParse({
      ...base,
      nickname: "Kael",
      pronouns: "they/them",
      ageDescription: "A youthful 30",
      appearance: "Tall, dark hair",
      biography: "Grew up in the lowlands",
      notes: "Private GM notes",
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.nickname).toBe("Kael")
      expect(parsed.data.pronouns).toBe("they/them")
      expect(parsed.data.ageDescription).toBe("A youthful 30")
      expect(parsed.data.appearance).toBe("Tall, dark hair")
      expect(parsed.data.biography).toBe("Grew up in the lowlands")
      expect(parsed.data.notes).toBe("Private GM notes")
    }
  })

  it("accepts null or omitted metadata fields on create (missing -> null)", () => {
    const omitted = characterCreateSchema.safeParse(base)
    expect(omitted.success).toBe(true)
    if (omitted.success) {
      expect(omitted.data.nickname).toBeUndefined()
    }
    const nulled = characterCreateSchema.safeParse({
      ...base,
      nickname: null,
      appearance: null,
    })
    expect(nulled.success).toBe(true)
  })

  it("rejects metadata fields that exceed their per-field bounds", () => {
    const cases: Array<[string, number, string]> = [
      ["nickname", 200, "n".repeat(201)],
      ["pronouns", 100, "p".repeat(101)],
      ["ageDescription", 4000, "a".repeat(4001)],
      ["appearance", 8000, "b".repeat(8001)],
      ["biography", 8000, "c".repeat(8001)],
      ["notes", 4000, "d".repeat(4001)],
    ]
    for (const [field, bound, tooLong] of cases) {
      const parsed = characterCreateSchema.safeParse({
        ...base,
        [field]: tooLong,
      })
      expect(parsed.success, `${field} > ${bound} must reject`).toBe(false)
    }
  })

  it("accepts a metadata field exactly at its bound", () => {
    const parsed = characterCreateSchema.safeParse({
      ...base,
      nickname: "n".repeat(200),
      notes: "d".repeat(4000),
    })
    expect(parsed.success).toBe(true)
  })

  it("update schema accepts metadata fields and allows clearing with null", () => {
    const parsed = characterUpdateSchema.safeParse({
      nickname: "Renamed",
      pronouns: null,
      ageDescription: null,
      biography: "new bio",
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.nickname).toBe("Renamed")
      expect(parsed.data.pronouns).toBeNull()
    }
  })

  it("update schema rejects metadata fields that exceed their bound", () => {
    expect(
      characterUpdateSchema.safeParse({ notes: "x".repeat(4001) }).success
    ).toBe(false)
  })
})

describe("race advancement (raceType / quarter / track)", () => {
  it("advanceSchema accepts a race track", () => {
    const parsed = advanceSchema.safeParse({ track: "race", version: 0 })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.track).toBe("race")
  })

  it("advanceSchema rejects an unknown track", () => {
    expect(
      advanceSchema.safeParse({ track: "monster", version: 0 }).success
    ).toBe(false)
  })

  it("characterCreateSchema accepts a null class and profession (a monster)", () => {
    const parsed = characterCreateSchema.safeParse({
      name: "Kael",
      origin: "integrated",
      raceId: "race-1",
      classId: null,
      professionId: null,
    })
    expect(parsed.success).toBe(true)
  })

  it("characterCreateSchema accepts an omitted class and profession (treated as null)", () => {
    const parsed = characterCreateSchema.safeParse({
      name: "Kael",
      origin: "integrated",
      raceId: "race-1",
    })
    expect(parsed.success).toBe(true)
  })

  it("raceConfigSchema accepts an enlightened or monster raceType", () => {
    expect(
      raceConfigSchema.safeParse({ raceType: "enlightened" }).success
    ).toBe(true)
    expect(raceConfigSchema.safeParse({ raceType: "monster" }).success).toBe(
      true
    )
  })

  it("raceConfigSchema accepts a legacy config without raceType", () => {
    expect(raceConfigSchema.safeParse({ naturalGrade: "F" }).success).toBe(true)
  })

  it("raceConfigSchema rejects an unknown raceType", () => {
    expect(raceConfigSchema.safeParse({ raceType: "humanoid" }).success).toBe(
      false
    )
  })

  it("hasInvalidRaceTypeConfig detects only a present-but-invalid raceType", () => {
    expect(hasInvalidRaceTypeConfig({})).toBe(false)
    expect(hasInvalidRaceTypeConfig({ naturalGrade: "F" })).toBe(false)
    expect(hasInvalidRaceTypeConfig({ raceType: "enlightened" })).toBe(false)
    expect(hasInvalidRaceTypeConfig({ raceType: "monster" })).toBe(false)
    expect(hasInvalidRaceTypeConfig({ raceType: "humanoid" })).toBe(true)
  })

  it("hasInvalidNaturalGradeConfig detects only a present-but-invalid naturalGrade", () => {
    expect(hasInvalidNaturalGradeConfig({})).toBe(false)
    expect(hasInvalidNaturalGradeConfig({ raceType: "enlightened" })).toBe(
      false
    )
    expect(hasInvalidNaturalGradeConfig({ naturalGrade: "F" })).toBe(false)
    expect(hasInvalidNaturalGradeConfig({ naturalGrade: "S" })).toBe(false)
    expect(hasInvalidNaturalGradeConfig({ naturalGrade: "Z" })).toBe(true)
  })

  it("isIncompleteRaceConfig requires BOTH a valid raceType and a valid naturalGrade", () => {
    expect(isIncompleteRaceConfig({})).toBe(true)
    expect(isIncompleteRaceConfig({ naturalGrade: "F" })).toBe(true)
    expect(isIncompleteRaceConfig({ raceType: "enlightened" })).toBe(true)
    expect(isIncompleteRaceConfig({ raceType: "monster" })).toBe(true)
    expect(isIncompleteRaceConfig({ raceType: "humanoid" })).toBe(true)
    expect(
      isIncompleteRaceConfig({ raceType: "humanoid", naturalGrade: "F" })
    ).toBe(true)
    expect(
      isIncompleteRaceConfig({ raceType: "enlightened", naturalGrade: "Z" })
    ).toBe(true)
    expect(
      isIncompleteRaceConfig({ raceType: "enlightened", naturalGrade: "F" })
    ).toBe(false)
    expect(
      isIncompleteRaceConfig({ raceType: "monster", naturalGrade: "S" })
    ).toBe(false)
  })
})

describe("equipment metadata (rarity / slot / soulbound / requirements)", () => {
  it("exports the ordered rarity ladder plus the incomparable Unique tier separately", () => {
    expect(EQUIPMENT_RARITIES).toEqual([
      "Inferior",
      "Common",
      "Uncommon",
      "Rare",
      "Epic",
      "Ancient",
      "Legendary",
      "Mythical",
      "Sacred",
      "Divine",
    ])
    expect(EQUIPMENT_UNIQUE_RARITY).toBe("Unique")
    // Unique is NOT part of the ordered comparable ladder.
    expect(EQUIPMENT_RARITIES).not.toContain(EQUIPMENT_UNIQUE_RARITY)
  })

  it("accepts every rarity in the vocabulary (incl. Unique)", () => {
    for (const rarity of [...EQUIPMENT_RARITIES, EQUIPMENT_UNIQUE_RARITY]) {
      expect(equipmentRaritySchema.safeParse(rarity).success).toBe(true)
    }
    expect(equipmentRaritySchema.safeParse("Commoner").success).toBe(false)
  })

  it("equipmentConfigSchema reads a full modern config and preserves optional metadata", () => {
    const parsed = equipmentConfigSchema.safeParse({
      slot: "Head",
      rarity: "Ancient",
      soulbound: true,
      minRaceLevel: 45,
      requiredRaceType: "enlightened",
      bonus: { strength: 10 },
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).toMatchObject({
        slot: "Head",
        rarity: "Ancient",
        soulbound: true,
        minRaceLevel: 45,
        requiredRaceType: "enlightened",
        bonus: { strength: 10 },
      })
    }
  })

  it("equipmentConfigSchema reads a legacy config (lowercase alias slot, no rarity)", () => {
    const parsed = equipmentConfigSchema.safeParse({ slot: "head" })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data).toMatchObject({ slot: "head" })
  })

  it("equipmentConfigSchema rejects an invalid rarity / negative minRaceLevel", () => {
    expect(
      equipmentConfigSchema.safeParse({ slot: "Head", rarity: "Commoner" })
        .success
    ).toBe(false)
    expect(
      equipmentConfigSchema.safeParse({ slot: "Head", minRaceLevel: -1 })
        .success
    ).toBe(false)
    expect(
      equipmentConfigSchema.safeParse({
        slot: "Head",
        requiredRaceType: "humanoid",
      }).success
    ).toBe(false)
  })

  it("EQUIPMENT_SLOTS lists exactly the canonical slots", () => {
    expect(EQUIPMENT_SLOTS).toEqual([
      "Head",
      "Chest",
      "Back",
      "Arms",
      "Hands",
      "Legs",
      "Feet",
      "Neck",
      "Ring 1",
      "Ring 2",
      "Weapon",
    ])
  })

  it("normalizeEquipmentSlot maps canonical + legacy aliases and rejects unknown slots", () => {
    expect(normalizeEquipmentSlot("Head")).toBe("Head")
    expect(normalizeEquipmentSlot("head")).toBe("Head")
    expect(normalizeEquipmentSlot("chest")).toBe("Chest")
    expect(normalizeEquipmentSlot("cloak")).toBe("Back")
    expect(normalizeEquipmentSlot("bracers")).toBe("Arms")
    expect(normalizeEquipmentSlot("gloves")).toBe("Hands")
    expect(normalizeEquipmentSlot("boots")).toBe("Feet")
    expect(normalizeEquipmentSlot("necklace")).toBe("Neck")
    expect(normalizeEquipmentSlot("ring1")).toBe("Ring 1")
    expect(normalizeEquipmentSlot("ring2")).toBe("Ring 2")
    // A lowercased canonical value maps to the canonical slot too.
    expect(normalizeEquipmentSlot("feet")).toBe("Feet")
    expect(normalizeEquipmentSlot("weapon")).toBe("Weapon")
    expect(normalizeEquipmentSlot("ring 1")).toBe("Ring 1")
    expect(normalizeEquipmentSlot("body")).toBeUndefined()
    expect(normalizeEquipmentSlot(undefined)).toBeUndefined()
  })

  it("isCanonicalEquipmentSlot accepts only canonical values", () => {
    expect(isCanonicalEquipmentSlot("Head")).toBe(true)
    expect(isCanonicalEquipmentSlot("Weapon")).toBe(true)
    expect(isCanonicalEquipmentSlot("head")).toBe(false)
    expect(isCanonicalEquipmentSlot("body")).toBe(false)
  })

  it("isIncompleteEquipmentConfig requires a normalizable slot AND a valid rarity", () => {
    expect(isIncompleteEquipmentConfig({})).toBe(true)
    expect(isIncompleteEquipmentConfig({ slot: "Head" })).toBe(true)
    expect(isIncompleteEquipmentConfig({ rarity: "Common" })).toBe(true)
    expect(
      isIncompleteEquipmentConfig({ slot: "body", rarity: "Common" })
    ).toBe(true)
    expect(
      isIncompleteEquipmentConfig({ slot: "Head", rarity: "Common" })
    ).toBe(false)
    // A legacy alias slot is accepted IF it normalizes to a canonical slot.
    expect(isIncompleteEquipmentConfig({ slot: "head", rarity: "Rare" })).toBe(
      false
    )
    expect(
      isIncompleteEquipmentConfig({ slot: "Head", rarity: "Commoner" })
    ).toBe(true)
  })
})

describe("skill rarity (shared vocabulary + monotonic ordering)", () => {
  it("shares the equipment rarity vocabulary via raritySchema", () => {
    for (const rarity of [...EQUIPMENT_RARITIES, EQUIPMENT_UNIQUE_RARITY]) {
      expect(raritySchema.safeParse(rarity).success).toBe(true)
    }
    expect(raritySchema.safeParse("Commoner").success).toBe(false)
    // raritySchema is the same enum as equipmentRaritySchema.
    expect(raritySchema).toEqual(equipmentRaritySchema)
  })

  it("rarityOrderIndex returns the 0-based comparable ladder order only", () => {
    expect(rarityOrderIndex("Inferior")).toBe(0)
    expect(rarityOrderIndex("Common")).toBe(1)
    expect(rarityOrderIndex("Uncommon")).toBe(2)
    expect(rarityOrderIndex("Rare")).toBe(3)
    expect(rarityOrderIndex("Divine")).toBe(9)
    // Unique is incomparable: NOT on the ladder.
    expect(rarityOrderIndex("Unique")).toBeUndefined()
    expect(rarityOrderIndex(undefined)).toBeUndefined()
    expect(rarityOrderIndex("Commoner")).toBeUndefined()
    expect(rarityOrderIndex(42)).toBeUndefined()
  })

  it("skillConfigSchema reads a rarity and rejects an invalid one", () => {
    expect(
      skillConfigSchema.safeParse({
        track: "class",
        milestone: 4,
        rarity: "Rare",
        effects: [],
      }).success
    ).toBe(true)
    expect(
      skillConfigSchema.safeParse({
        track: "class",
        milestone: 4,
        rarity: "Commoner",
      }).success
    ).toBe(false)
    // A legacy config without rarity still parses (readable).
    expect(
      skillConfigSchema.safeParse({ track: "class", milestone: 4 }).success
    ).toBe(true)
  })

  it("isIncompleteSkillRarity rejects a missing or invalid rarity", () => {
    expect(isIncompleteSkillRarity({})).toBe(true)
    expect(isIncompleteSkillRarity({ track: "class", milestone: 4 })).toBe(true)
    expect(
      isIncompleteSkillRarity({
        track: "class",
        milestone: 4,
        rarity: "Common",
      })
    ).toBe(false)
    expect(isIncompleteSkillRarity({ tag: "x", rarity: "Unique" })).toBe(false)
    expect(isIncompleteSkillRarity({ rarity: "Commoner" })).toBe(true)
  })

  it("skillUpgradeSchema requires definitionId, version and a 1..500 reason", () => {
    expect(
      skillUpgradeSchema.safeParse({
        definitionId: "sk-1",
        version: 3,
        reason: "because",
      }).success
    ).toBe(true)
    expect(
      skillUpgradeSchema.safeParse({ definitionId: "sk-1", version: 0 }).success
    ).toBe(false)
    expect(
      skillUpgradeSchema.safeParse({
        definitionId: "sk-1",
        version: 0,
        reason: "",
      }).success
    ).toBe(false)
    expect(
      skillUpgradeSchema.safeParse({
        definitionId: "sk-1",
        version: 0,
        reason: "x".repeat(501),
      }).success
    ).toBe(false)
    expect(
      skillUpgradeSchema.safeParse({
        definitionId: "",
        version: 0,
        reason: "x",
      }).success
    ).toBe(false)
  })
})
