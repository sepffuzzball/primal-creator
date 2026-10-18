import { describe, expect, it } from "vitest"
import {
  advanceSchema,
  allGradeGrantedSkillStableIds,
  associationSchema,
  BLESSING_TIER_ORDER,
  blessingTierAtLeast,
  bloodlineConfigSchema,
  characterCreateSchema,
  characterStateSchema,
  characterUpdateSchema,
  catalogKindSchema,
  currencyConfigSchema,
  currencyGradeDescriptionsForbidden,
  currencyGradeForbidden,
  EQUIPMENT_RARITIES,
  EQUIPMENT_SLOTS,
  EQUIPMENT_UNIQUE_RARITY,
  equipmentConfigSchema,
  equipmentPositionSchema,
  equipmentRaritySchema,
  evolveSchema,
  experienceSchema,
  godConfigSchema,
  gradeDescriptionsSchema,
  gradeGrantedSkillStableIdsSchema,
  gradeSkillStableIdsFor,
  godGradeForbidden,
  hasInvalidNaturalGradeConfig,
  hasInvalidRaceTypeConfig,
  hasInvalidSkillTrack,
  hasLegacyEquipmentRequirements,
  inventoryPostSchema,
  isCanonicalEquipmentSlot,
  isIncompleteEquipmentConfig,
  isIncompleteRaceConfig,
  isIncompleteSkillConfig,
  isIncompleteSkillRarity,
  isLegacyBloodlineConfig,
  isLegacyTranscendentSkillConfig,
  itemConfigSchema,
  legacyRingPositionForConfig,
  normalizeCatalogKind,
  normalizeEquipmentSlot,
  professionSetSchema,
  raceConfigSchema,
  rarityOrderIndex,
  raritySchema,
  requiredGradeNullForbidden,
  skillClassStableIdOf,
  skillConfigSchema,
  skillGradeDescriptionsForbidden,
  skillGradeForbidden,
  skillUpgradeCloneSchema,
  skillUpgradeSchema,
  specialAbilitiesSchema,
  titleConfigSchema,
  titleImprovementSchema,
  trackConfigSchema,
  transcendentSkillConfigSchema,
} from "@/lib/server/schemas"

// A valid fully-allocated initial stat vector for a derived (enlightened) race
// create payload. Sums to 70 (9 base +61); the API schema only validates the
// nine-key >=1 shape (not the total), so this is shape-valid regardless.
const validInitialAttributes = {
  strength: 1,
  agility: 1,
  endurance: 1,
  vitality: 1,
  toughness: 1,
  wisdom: 1,
  intelligence: 1,
  perception: 1,
  willpower: 62,
}

describe("evolveSchema (single evolution choice)", () => {
  it("parses a race choice with track: 'race'", () => {
    const parsed = evolveSchema.safeParse({
      track: "race",
      optionId: "dest-race-1",
      version: 0,
      reason: "story",
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).toEqual({
        track: "race",
        optionId: "dest-race-1",
        version: 0,
        reason: "story",
      })
    }
  })

  it("preserves track on a class choice", () => {
    const parsed = evolveSchema.safeParse({
      track: "class",
      optionId: "dest-class-1",
      version: 0,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).toEqual({
        track: "class",
        optionId: "dest-class-1",
        version: 0,
      })
      expect(parsed.data.track).toBe("class")
    }
  })

  it("preserves track on a profession choice", () => {
    const parsed = evolveSchema.safeParse({
      track: "profession",
      optionId: "dest-prof-1",
      version: 0,
      reason: "story",
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).toEqual({
        track: "profession",
        optionId: "dest-prof-1",
        version: 0,
        reason: "story",
      })
    }
  })

  it("requires an explicit track (no legacy grade-only path)", () => {
    // The retired grade-only shape `{grade, version}` no longer parses.
    const gradeOnly = evolveSchema.safeParse({ grade: "F", version: 0 })
    expect(gradeOnly.success).toBe(false)
    const noTrack = evolveSchema.safeParse({ optionId: "dest-1", version: 0 })
    expect(noTrack.success).toBe(false)
  })

  it("rejects a payload with no recognized evolution shape", () => {
    const parsed = evolveSchema.safeParse({})
    expect(parsed.success).toBe(false)
  })

  it("rejects an unknown track value", () => {
    const parsed = evolveSchema.safeParse({
      track: "gods",
      optionId: "dest-1",
      version: 0,
    })
    expect(parsed.success).toBe(false)
  })
})

describe("bloodline / god catalog config", () => {
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

  it("accepts an explicit empty grade-replacement list (suppresses base effects)", () => {
    const parsed = bloodlineConfigSchema.safeParse({
      effects: [{ phase: "flat", amount: { strength: 1 } }],
      gradeEffects: {
        G: [],
      },
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.gradeEffects?.G).toEqual([])
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

  it("parses a god blessingEffects map keyed by the eight blessing tiers", () => {
    const parsed = godConfigSchema.safeParse({
      blessingEffects: {
        True: [{ phase: "flat", amount: { strength: 5 } }],
        Minor: [],
      },
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.blessingEffects?.True).toHaveLength(1)
      expect(parsed.data.blessingEffects?.Minor).toEqual([])
    }
  })

  it("rejects a blessingEffects key outside the eight-tier vocabulary", () => {
    // "minor" is a typo for "Minor"; the tier keys are strict.
    expect(
      godConfigSchema.safeParse({ blessingEffects: { minor: [] } }).success
    ).toBe(false)
  })

  it("rejects a non-integer blessing effect amount in a god blessingEffects entry", () => {
    expect(
      godConfigSchema.safeParse({
        blessingEffects: {
          Major: [{ phase: "flat", amount: { strength: 1.5 } }],
        },
      }).success
    ).toBe(false)
  })

  it("accepts a god with no blessingEffects (a tiered link synthesizes no bonus)", () => {
    const parsed = godConfigSchema.safeParse({ divineRank: "God" })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.blessingEffects).toBeUndefined()
    }
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

describe("title granted passive skills (grantedSkillStableIds)", () => {
  it("accepts an empty grantedSkillStableIds list (a narrative-only title)", () => {
    const parsed = titleConfigSchema.safeParse({
      flat: { strength: 3 },
      grantedSkillStableIds: [],
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.grantedSkillStableIds).toEqual([])
    }
  })

  it("accepts a nonempty, internally unique grantedSkillStableIds list", () => {
    const parsed = titleConfigSchema.safeParse({
      flat: { strength: 3 },
      grantedSkillStableIds: ["skill-a", "skill-b"],
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.grantedSkillStableIds).toEqual(["skill-a", "skill-b"])
    }
  })

  it("rejects a duplicate grantedSkillStableIds entry", () => {
    const parsed = titleConfigSchema.safeParse({
      flat: { strength: 3 },
      grantedSkillStableIds: ["skill-a", "skill-a"],
    })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((i) => i.path[0] === "grantedSkillStableIds")
      ).toBe(true)
    }
  })

  it("rejects a blank grantedSkillStableIds entry", () => {
    expect(
      titleConfigSchema.safeParse({
        flat: { strength: 3 },
        grantedSkillStableIds: [""],
      }).success
    ).toBe(false)
  })

  it("reads a legacy title config without grantedSkillStableIds as undefined (no fabricated list)", () => {
    const parsed = titleConfigSchema.safeParse({
      flat: { strength: 3 },
      improvement: {
        seriesId: "dungeon-pioneer",
        rank: 1,
        minRaceGrade: "E",
      },
      upgradeGroup: "dungeon-pioneer",
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.grantedSkillStableIds).toBeUndefined()
    }
  })

  it("still rejects a ranked title whose upgradeGroup differs from improvement.seriesId when granting skills", () => {
    const parsed = titleConfigSchema.safeParse({
      upgradeGroup: "hero",
      grantedSkillStableIds: ["skill-a"],
      improvement: {
        seriesId: "dungeon-pioneer",
        rank: 1,
        minRaceGrade: "E",
      },
    })
    expect(parsed.success).toBe(false)
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

  it("parses a valid use payload with quantity exactly 1", () => {
    const parsed = inventoryPostSchema.safeParse({
      operation: "use",
      definitionId: "pot-1",
      quantity: 1,
      version: 0,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).toEqual({
        operation: "use",
        definitionId: "pot-1",
        quantity: 1,
        version: 0,
      })
    }
  })

  it("rejects a use with quantity other than exactly 1", () => {
    for (const quantity of [0, 2, -1]) {
      const parsed = inventoryPostSchema.safeParse({
        operation: "use",
        definitionId: "pot-1",
        quantity,
        version: 0,
      })
      expect(parsed.success).toBe(false)
    }
  })

  it("accepts a use with an optional (ignored) sourceNote", () => {
    // An omitted sourceNote is valid.
    expect(
      inventoryPostSchema.safeParse({
        operation: "use",
        definitionId: "pot-1",
        quantity: 1,
        version: 0,
      }).success
    ).toBe(true)
    // A supplied sourceNote (even an empty one) is accepted and ignored.
    expect(
      inventoryPostSchema.safeParse({
        operation: "use",
        definitionId: "pot-1",
        quantity: 1,
        version: 0,
        sourceNote: "",
      }).success
    ).toBe(true)
    expect(
      inventoryPostSchema.safeParse({
        operation: "use",
        definitionId: "pot-1",
        quantity: 1,
        version: 0,
        sourceNote: "x".repeat(500),
      }).success
    ).toBe(true)
    // But an over-long sourceNote is still rejected.
    expect(
      inventoryPostSchema.safeParse({
        operation: "use",
        definitionId: "pot-1",
        quantity: 1,
        version: 0,
        sourceNote: "x".repeat(501),
      }).success
    ).toBe(false)
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
        initialAttributes: validInitialAttributes,
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
      initialAttributes: validInitialAttributes,
      specialAbilities: {
        blessing: { godId: "god-1", tier: "Major" },
        bloodlineIds: ["blood-1"],
        transcendentSkillIds: ["trans-1"],
      },
    })
    expect(parsed.success).toBe(true)
  })

  it("rejects a blessing with an empty godId", () => {
    expect(
      specialAbilitiesSchema.safeParse({
        blessing: { godId: "", tier: "True" },
      }).success
    ).toBe(false)
  })

  it("rejects a blessing with an invalid tier", () => {
    expect(
      specialAbilitiesSchema.safeParse({
        blessing: { godId: "god-1", tier: "minor" },
      }).success
    ).toBe(false)
  })

  it("rejects a bloodline array with more than 1 id", () => {
    const ids = Array.from({ length: 2 }, (_, i) => `blood-${i}`)
    expect(
      specialAbilitiesSchema.safeParse({ bloodlineIds: ids }).success
    ).toBe(false)
  })

  it("rejects an id selected in more than one field (cross-field overlap)", () => {
    const parsed = specialAbilitiesSchema.safeParse({
      blessing: { godId: "bless-1", tier: "Minor" },
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

describe("initialAttributes at the API boundary (shape only)", () => {
  const base = {
    name: "Kael",
    origin: "integrated" as const,
    raceId: "race-1",
    classId: "cls-1",
  }

  it("requires the initialAttributes field (a missing field is rejected before the service)", () => {
    expect(characterCreateSchema.safeParse(base).success).toBe(false)
  })

  it("accepts a valid full nine-key vector with each integer >= 1", () => {
    expect(
      characterCreateSchema.safeParse({
        ...base,
        initialAttributes: validInitialAttributes,
      }).success
    ).toBe(true)
  })

  it("rejects a value below 1", () => {
    expect(
      characterCreateSchema.safeParse({
        ...base,
        initialAttributes: { ...validInitialAttributes, strength: 0 },
      }).success
    ).toBe(false)
  })

  it("rejects a non-integer value", () => {
    expect(
      characterCreateSchema.safeParse({
        ...base,
        initialAttributes: { ...validInitialAttributes, agility: 1.5 },
      }).success
    ).toBe(false)
  })

  it("rejects a missing attribute key", () => {
    const partial = { ...validInitialAttributes } as Record<string, unknown>
    delete (partial as Record<string, unknown>)["willpower"]
    expect(
      characterCreateSchema.safeParse({
        ...base,
        initialAttributes: partial,
      }).success
    ).toBe(false)
  })

  it("rejects an extra (unknown) key strictly", () => {
    expect(
      characterCreateSchema.safeParse({
        ...base,
        initialAttributes: { ...validInitialAttributes, luck: 1 },
      }).success
    ).toBe(false)
  })
})

describe("character profile metadata schema bounds", () => {
  const base = {
    name: "Kael",
    origin: "integrated" as const,
    raceId: "race-1",
    classId: "cls-1",
    initialAttributes: validInitialAttributes,
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

  it("experienceSchema accepts a set operation with a percent", () => {
    const parsed = experienceSchema.safeParse({
      operation: "set",
      track: "class",
      percent: 50,
      version: 0,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).toEqual({
        operation: "set",
        track: "class",
        percent: 50,
        version: 0,
      })
    }
  })

  it("experienceSchema accepts the percent bounds 0 and 100", () => {
    expect(
      experienceSchema.safeParse({
        operation: "set",
        track: "race",
        percent: 0,
        version: 0,
      }).success
    ).toBe(true)
    expect(
      experienceSchema.safeParse({
        operation: "set",
        track: "profession",
        percent: 100,
        version: 0,
      }).success
    ).toBe(true)
  })

  it("experienceSchema accepts a levelUp operation with no percent", () => {
    const parsed = experienceSchema.safeParse({
      operation: "levelUp",
      track: "race",
      version: 2,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).toMatchObject({
        operation: "levelUp",
        track: "race",
        version: 2,
      })
      expect((parsed.data as { percent?: number }).percent).toBeUndefined()
    }
  })

  it("experienceSchema accepts an undo operation with no percent", () => {
    const parsed = experienceSchema.safeParse({
      operation: "undo",
      track: "class",
      version: 3,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).toMatchObject({
        operation: "undo",
        track: "class",
        version: 3,
      })
      expect((parsed.data as { percent?: number }).percent).toBeUndefined()
    }
  })

  it("experienceSchema rejects an undo operation carrying a percent", () => {
    expect(
      experienceSchema.safeParse({
        operation: "undo",
        track: "profession",
        percent: 75,
        version: 0,
      }).success
    ).toBe(false)
  })

  it("experienceSchema rejects an undo operation with a non-integer or negative version", () => {
    expect(
      experienceSchema.safeParse({
        operation: "undo",
        track: "class",
        version: -1,
      }).success
    ).toBe(false)
    expect(
      experienceSchema.safeParse({
        operation: "undo",
        track: "class",
        version: 1.5,
      }).success
    ).toBe(false)
  })

  it("experienceSchema rejects a set operation with no percent", () => {
    expect(
      experienceSchema.safeParse({
        operation: "set",
        track: "class",
        version: 0,
      }).success
    ).toBe(false)
  })

  it("experienceSchema rejects a levelUp operation carrying a percent", () => {
    expect(
      experienceSchema.safeParse({
        operation: "levelUp",
        track: "class",
        percent: 75,
        version: 0,
      }).success
    ).toBe(false)
  })

  it("experienceSchema rejects a percent outside 0..100", () => {
    expect(
      experienceSchema.safeParse({
        operation: "set",
        track: "class",
        percent: 101,
        version: 0,
      }).success
    ).toBe(false)
    expect(
      experienceSchema.safeParse({
        operation: "set",
        track: "class",
        percent: -1,
        version: 0,
      }).success
    ).toBe(false)
  })

  it("experienceSchema rejects a non-integer percent", () => {
    expect(
      experienceSchema.safeParse({
        operation: "set",
        track: "class",
        percent: 33.5,
        version: 0,
      }).success
    ).toBe(false)
  })

  it("experienceSchema rejects an unknown operation", () => {
    expect(
      experienceSchema.safeParse({
        operation: "grant",
        track: "class",
        percent: 25,
        version: 0,
      }).success
    ).toBe(false)
  })

  it("experienceSchema rejects an unknown track", () => {
    expect(
      experienceSchema.safeParse({
        operation: "set",
        track: "monster",
        percent: 25,
        version: 0,
      }).success
    ).toBe(false)
  })

  it("characterCreateSchema accepts a null class and profession (a monster)", () => {
    const parsed = characterCreateSchema.safeParse({
      name: "Kael",
      origin: "integrated",
      raceId: "race-1",
      classId: null,
      professionId: null,
      initialAttributes: validInitialAttributes,
    })
    expect(parsed.success).toBe(true)
  })

  it("characterCreateSchema accepts an omitted class and profession (treated as null)", () => {
    const parsed = characterCreateSchema.safeParse({
      name: "Kael",
      origin: "integrated",
      raceId: "race-1",
      initialAttributes: validInitialAttributes,
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

  it("equipmentConfigSchema reads and preserves the canonical minimumLevel / requiredLevelType", () => {
    const parsed = equipmentConfigSchema.safeParse({
      slot: "Head",
      rarity: "Common",
      minimumLevel: 45,
      requiredLevelType: "humanoidRace",
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).toMatchObject({
        minimumLevel: 45,
        requiredLevelType: "humanoidRace",
      })
    }
  })

  it("equipmentConfigSchema requires requiredLevelType when minimumLevel is set", () => {
    expect(
      equipmentConfigSchema.safeParse({ slot: "Head", minimumLevel: 5 }).success
    ).toBe(false)
    expect(
      equipmentConfigSchema.safeParse({
        slot: "Head",
        minimumLevel: 5,
        requiredLevelType: "class",
      }).success
    ).toBe(true)
  })

  it("equipmentConfigSchema allows requiredLevelType alone (type restriction at level 0)", () => {
    const parsed = equipmentConfigSchema.safeParse({
      slot: "Head",
      requiredLevelType: "monstrousRace",
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.requiredLevelType).toBe("monstrousRace")
      expect(parsed.data.minimumLevel).toBeUndefined()
    }
  })

  it("equipmentConfigSchema rejects an invalid requiredLevelType / negative minimumLevel", () => {
    expect(
      equipmentConfigSchema.safeParse({
        slot: "Head",
        requiredLevelType: "race",
      }).success
    ).toBe(false)
    expect(
      equipmentConfigSchema.safeParse({
        slot: "Head",
        minimumLevel: -1,
        requiredLevelType: "class",
      }).success
    ).toBe(false)
  })

  it("equipmentConfigSchema requires requiredGodStableId when minimumBlessingTier is set", () => {
    expect(
      equipmentConfigSchema.safeParse({
        slot: "Head",
        minimumBlessingTier: "Minor",
      }).success
    ).toBe(false)
    expect(
      equipmentConfigSchema.safeParse({
        slot: "Head",
        minimumBlessingTier: "Minor",
        requiredGodStableId: "odin",
      }).success
    ).toBe(true)
  })

  it("equipmentConfigSchema allows requiredGodStableId alone (tier defaults to Baptism at runtime)", () => {
    const parsed = equipmentConfigSchema.safeParse({
      slot: "Head",
      requiredGodStableId: "odin",
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).toMatchObject({ requiredGodStableId: "odin" })
      expect(parsed.data.minimumBlessingTier).toBeUndefined()
    }
  })

  it("equipmentConfigSchema accepts grantedSkillStableIds (empty, nonempty, unique)", () => {
    const empty = equipmentConfigSchema.safeParse({
      slot: "Head",
      rarity: "Common",
      grantedSkillStableIds: [],
    })
    expect(empty.success).toBe(true)

    const nonempty = equipmentConfigSchema.safeParse({
      slot: "Head",
      rarity: "Common",
      grantedSkillStableIds: ["skill-a", "skill-b"],
    })
    expect(nonempty.success).toBe(true)
    if (nonempty.success) {
      expect(nonempty.data.grantedSkillStableIds).toEqual([
        "skill-a",
        "skill-b",
      ])
    }

    // Absent (legacy config) reads back as undefined, never a fabricated list.
    const absent = equipmentConfigSchema.safeParse({ slot: "Head" })
    expect(absent.success).toBe(true)
    if (absent.success) {
      expect(absent.data.grantedSkillStableIds).toBeUndefined()
    }
  })

  it("equipmentConfigSchema rejects a duplicate grantedSkillStableIds entry", () => {
    const parsed = equipmentConfigSchema.safeParse({
      slot: "Head",
      rarity: "Common",
      grantedSkillStableIds: ["skill-a", "skill-a"],
    })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((i) => i.path[0] === "grantedSkillStableIds")
      ).toBe(true)
    }
  })

  it("equipmentConfigSchema rejects a blank grantedSkillStableIds entry", () => {
    expect(
      equipmentConfigSchema.safeParse({
        slot: "Head",
        rarity: "Common",
        grantedSkillStableIds: [""],
      }).success
    ).toBe(false)
  })

  it("hasLegacyEquipmentRequirements detects legacy keys and not canonical ones", () => {
    expect(hasLegacyEquipmentRequirements({ minRaceLevel: 5 })).toBe(true)
    expect(
      hasLegacyEquipmentRequirements({ requiredRaceType: "enlightened" })
    ).toBe(true)
    expect(
      hasLegacyEquipmentRequirements({
        minimumLevel: 5,
        requiredLevelType: "class",
      })
    ).toBe(false)
    expect(hasLegacyEquipmentRequirements({ slot: "Head" })).toBe(false)
  })

  it("BLESSING_TIER_ORDER is the canonical tier ladder", () => {
    expect(BLESSING_TIER_ORDER).toEqual([
      "Baptism",
      "Minor",
      "Lesser",
      "Intermediate",
      "Major",
      "Greater",
      "Divine",
      "True",
    ])
  })

  it("blessingTierAtLeast orders tiers by the canonical ladder", () => {
    expect(blessingTierAtLeast("Baptism", "Baptism")).toBe(true)
    expect(blessingTierAtLeast("Minor", "Baptism")).toBe(true)
    expect(blessingTierAtLeast("Baptism", "Minor")).toBe(false)
    expect(blessingTierAtLeast("Lesser", "Minor")).toBe(true)
    expect(blessingTierAtLeast("True", "Divine")).toBe(true)
  })

  it("EQUIPMENT_SLOTS lists exactly the canonical slots (Ring is a single slot)", () => {
    expect(EQUIPMENT_SLOTS).toEqual([
      "Head",
      "Chest",
      "Back",
      "Arms",
      "Hands",
      "Legs",
      "Feet",
      "Neck",
      "Ring",
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
    // Legacy ring per-position slots all normalize to the single canonical Ring slot.
    expect(normalizeEquipmentSlot("Ring")).toBe("Ring")
    expect(normalizeEquipmentSlot("ring1")).toBe("Ring")
    expect(normalizeEquipmentSlot("ring2")).toBe("Ring")
    expect(normalizeEquipmentSlot("ring 1")).toBe("Ring")
    expect(normalizeEquipmentSlot("ring 2")).toBe("Ring")
    // A lowercased canonical value maps to the canonical slot too.
    expect(normalizeEquipmentSlot("feet")).toBe("Feet")
    expect(normalizeEquipmentSlot("weapon")).toBe("Weapon")
    expect(normalizeEquipmentSlot("body")).toBeUndefined()
    expect(normalizeEquipmentSlot(undefined)).toBeUndefined()
  })

  it("equipmentPositionSchema accepts only the two physical ring positions", () => {
    expect(equipmentPositionSchema.safeParse("Ring 1").success).toBe(true)
    expect(equipmentPositionSchema.safeParse("Ring 2").success).toBe(true)
    // The canonical catalog slot is NOT a position; only the two physical positions.
    expect(equipmentPositionSchema.safeParse("Ring").success).toBe(false)
    expect(equipmentPositionSchema.safeParse("ring 1").success).toBe(false)
    expect(equipmentPositionSchema.safeParse("Head").success).toBe(false)
    expect(equipmentPositionSchema.safeParse(undefined).success).toBe(false)
  })

  it("legacyRingPositionForConfig derives a position from a legacy Ring 1/2 slot only", () => {
    expect(legacyRingPositionForConfig({ slot: "Ring 1" })).toBe("Ring 1")
    expect(legacyRingPositionForConfig({ slot: "Ring 2" })).toBe("Ring 2")
    // Case/spacing aliases are recognized.
    expect(legacyRingPositionForConfig({ slot: "ring1" })).toBe("Ring 1")
    expect(legacyRingPositionForConfig({ slot: "ring 2" })).toBe("Ring 2")
    expect(legacyRingPositionForConfig({ slot: "RING1" })).toBe("Ring 1")
    // The canonical slot carries no positional info.
    expect(legacyRingPositionForConfig({ slot: "Ring" })).toBeUndefined()
    // Non-ring slots are not positions.
    expect(legacyRingPositionForConfig({ slot: "Head" })).toBeUndefined()
    expect(legacyRingPositionForConfig({ slot: "weapon" })).toBeUndefined()
    // A missing/invalid slot yields no position either.
    expect(legacyRingPositionForConfig({})).toBeUndefined()
    expect(legacyRingPositionForConfig({ slot: 42 })).toBeUndefined()
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

describe("equipment percent basis points", () => {
  it("equipmentConfigSchema accepts a valid nonnegative-integer percentBasisPoints", () => {
    const parsed = equipmentConfigSchema.safeParse({
      slot: "Head",
      rarity: "Ancient",
      bonus: { strength: 10 },
      percentBasisPoints: { strength: 1000, agility: 500 },
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).toMatchObject({
        percentBasisPoints: { strength: 1000, agility: 500 },
      })
    }
  })

  it("equipmentConfigSchema rejects a negative percentBasisPoints value", () => {
    const parsed = equipmentConfigSchema.safeParse({
      slot: "Head",
      rarity: "Ancient",
      percentBasisPoints: { strength: -5 },
    })
    expect(parsed.success).toBe(false)
  })

  it("equipmentConfigSchema rejects a fractional percentBasisPoints value", () => {
    const parsed = equipmentConfigSchema.safeParse({
      slot: "Head",
      rarity: "Ancient",
      percentBasisPoints: { strength: 10.5 },
    })
    expect(parsed.success).toBe(false)
  })

  it("accepts an equipment config with no percentBasisPoints (legacy readable)", () => {
    const parsed = equipmentConfigSchema.safeParse({
      slot: "Head",
      rarity: "Common",
      bonus: { strength: 5 },
    })
    expect(parsed.success).toBe(true)
  })

  it("characterStateSchema round-trips an equipment bonus carrying percentBasisPoints", () => {
    const state = {
      baseAttributes: {
        strength: 0,
        agility: 0,
        endurance: 0,
        vitality: 0,
        toughness: 0,
        wisdom: 0,
        intelligence: 0,
        perception: 0,
        willpower: 0,
      },
      tracks: {},
      race: { level: 0, grade: "F", mode: "derived" },
      historicalLevelAwards: [],
      allocations: [],
      permanentGains: [],
      activeEffects: [],
      equipment: [
        {
          id: "gear-1",
          name: "Sword",
          slot: "Weapon",
          source: "s",
          bonus: { strength: 10 },
          percentBasisPoints: { strength: 1000 },
        },
      ],
      currentResources: {},
      turn: 0,
    }
    const parsed = characterStateSchema.safeParse(state)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.equipment[0].percentBasisPoints).toEqual({
        strength: 1000,
      })
    }
  })

  it("characterStateSchema accepts a legacy equipment bonus without percentBasisPoints", () => {
    const state = {
      baseAttributes: {
        strength: 0,
        agility: 0,
        endurance: 0,
        vitality: 0,
        toughness: 0,
        wisdom: 0,
        intelligence: 0,
        perception: 0,
        willpower: 0,
      },
      tracks: {},
      race: { level: 0, grade: "F", mode: "derived" },
      historicalLevelAwards: [],
      allocations: [],
      permanentGains: [],
      activeEffects: [],
      equipment: [
        {
          id: "gear-1",
          name: "Sword",
          slot: "Weapon",
          source: "s",
          bonus: { strength: 10 },
        },
      ],
      currentResources: {},
      turn: 0,
    }
    const parsed = characterStateSchema.safeParse(state)
    expect(parsed.success).toBe(true)
  })
})

describe("equipment derived resource bonuses (HP/MP/SP maxima)", () => {
  it("equipmentConfigSchema accepts valid nonnegative-integer derivedFlat / derivedPercentBasisPoints", () => {
    const parsed = equipmentConfigSchema.safeParse({
      slot: "Head",
      rarity: "Ancient",
      bonus: { strength: 10 },
      derivedFlat: { hp: 50, mp: 25, sp: 0 },
      derivedPercentBasisPoints: { hp: 1000, mp: 2000 },
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).toMatchObject({
        derivedFlat: { hp: 50, mp: 25, sp: 0 },
        derivedPercentBasisPoints: { hp: 1000, mp: 2000 },
      })
    }
  })

  it("equipmentConfigSchema rejects a negative derivedFlat value", () => {
    const parsed = equipmentConfigSchema.safeParse({
      slot: "Head",
      rarity: "Ancient",
      derivedFlat: { hp: -5 },
    })
    expect(parsed.success).toBe(false)
  })

  it("equipmentConfigSchema rejects a fractional derivedPercentBasisPoints value", () => {
    const parsed = equipmentConfigSchema.safeParse({
      slot: "Head",
      rarity: "Ancient",
      derivedPercentBasisPoints: { mp: 10.5 },
    })
    expect(parsed.success).toBe(false)
  })

  it("equipmentConfigSchema accepts a config with no derived fields (legacy readable)", () => {
    const parsed = equipmentConfigSchema.safeParse({
      slot: "Head",
      rarity: "Common",
      bonus: { strength: 5 },
    })
    expect(parsed.success).toBe(true)
  })

  it("characterStateSchema round-trips an equipment bonus carrying derivedFlat / derivedPercentBasisPoints", () => {
    const state = {
      baseAttributes: {
        strength: 0,
        agility: 0,
        endurance: 0,
        vitality: 0,
        toughness: 0,
        wisdom: 0,
        intelligence: 0,
        perception: 0,
        willpower: 0,
      },
      tracks: {},
      race: { level: 0, grade: "F", mode: "derived" },
      historicalLevelAwards: [],
      allocations: [],
      permanentGains: [],
      activeEffects: [],
      equipment: [
        {
          id: "gear-1",
          name: "Sword",
          slot: "Weapon",
          source: "s",
          bonus: { strength: 10 },
          derivedFlat: { hp: 50, mp: 25 },
          derivedPercentBasisPoints: { hp: 1000, mp: 2000 },
        },
      ],
      currentResources: {},
      turn: 0,
    }
    const parsed = characterStateSchema.safeParse(state)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.equipment[0].derivedFlat).toEqual({ hp: 50, mp: 25 })
      expect(parsed.data.equipment[0].derivedPercentBasisPoints).toEqual({
        hp: 1000,
        mp: 2000,
      })
    }
  })

  it("characterStateSchema accepts a legacy equipment bonus without derived fields", () => {
    const state = {
      baseAttributes: {
        strength: 0,
        agility: 0,
        endurance: 0,
        vitality: 0,
        toughness: 0,
        wisdom: 0,
        intelligence: 0,
        perception: 0,
        willpower: 0,
      },
      tracks: {},
      race: { level: 0, grade: "F", mode: "derived" },
      historicalLevelAwards: [],
      allocations: [],
      permanentGains: [],
      activeEffects: [],
      equipment: [
        {
          id: "gear-1",
          name: "Sword",
          slot: "Weapon",
          source: "s",
          bonus: { strength: 10 },
        },
      ],
      currentResources: {},
      turn: 0,
    }
    const parsed = characterStateSchema.safeParse(state)
    expect(parsed.success).toBe(true)
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

  it("isIncompleteSkillConfig requires a track on a NEW or config-changing skill", () => {
    // A skill without any track is incomplete (must be typed).
    expect(isIncompleteSkillConfig({})).toBe(true)
    expect(isIncompleteSkillConfig({ milestone: 4 })).toBe(true)
    expect(isIncompleteSkillConfig({ rarity: "Common" })).toBe(true)
    // Any declared track satisfies the requirement; validity is checked separately.
    expect(isIncompleteSkillConfig({ track: "race" })).toBe(false)
    expect(isIncompleteSkillConfig({ track: "class", milestone: 4 })).toBe(
      false
    )
    expect(isIncompleteSkillConfig({ track: "profession" })).toBe(false)
  })

  it("hasInvalidSkillTrack accepts race/class/profession and rejects anything else", () => {
    expect(hasInvalidSkillTrack({ track: "race" })).toBe(false)
    expect(hasInvalidSkillTrack({ track: "class" })).toBe(false)
    expect(hasInvalidSkillTrack({ track: "profession" })).toBe(false)
    expect(hasInvalidSkillTrack({ track: "spells" })).toBe(true)
    expect(hasInvalidSkillTrack({ track: "" })).toBe(true)
    // A missing track is not invalid (isIncompleteSkillConfig owns that check).
    expect(hasInvalidSkillTrack({})).toBe(false)
  })

  it("skillConfigSchema accepts a classStableId and rejects an empty one", () => {
    expect(
      skillConfigSchema.safeParse({
        track: "class",
        milestone: 4,
        classStableId: "archer",
      }).success
    ).toBe(true)
    // A nonempty-required classStableId must not be blank.
    expect(
      skillConfigSchema.safeParse({
        track: "class",
        classStableId: "",
      }).success
    ).toBe(false)
  })

  it("skillClassStableIdOf extracts a trimmed nonempty classStableId or returns null", () => {
    expect(skillClassStableIdOf({ classStableId: "  archer  " })).toBe("archer")
    expect(skillClassStableIdOf({ classStableId: "archer" })).toBe("archer")
    expect(skillClassStableIdOf({})).toBeNull()
    expect(skillClassStableIdOf({ classStableId: "" })).toBeNull()
    expect(skillClassStableIdOf({ classStableId: "   " })).toBeNull()
    // Unknown / malformed keys are ignored (legacy passthrough).
    expect(skillClassStableIdOf({ classStableId: 42 })).toBeNull()
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

  it("skillUpgradeSchema accepts an optional nonempty sourceDefinitionId", () => {
    // Omitted source is valid (legacy target-only flow).
    const omitted = skillUpgradeSchema.safeParse({
      definitionId: "sk-2",
      version: 1,
      reason: "because",
    })
    expect(omitted.success).toBe(true)
    if (omitted.success) expect(omitted.data.sourceDefinitionId).toBeUndefined()

    // A present source must be a nonempty string.
    const present = skillUpgradeSchema.safeParse({
      sourceDefinitionId: "sk-low",
      definitionId: "sk-high",
      version: 1,
      reason: "because",
    })
    expect(present.success).toBe(true)
    if (present.success) {
      expect(present.data.sourceDefinitionId).toBe("sk-low")
    }

    expect(
      skillUpgradeSchema.safeParse({
        sourceDefinitionId: "",
        definitionId: "sk-high",
        version: 1,
        reason: "because",
      }).success
    ).toBe(false)
  })
})

describe("skillUpgradeCloneSchema (admin variant-clone payload)", () => {
  it("requires rarity and accepts every rarity from the shared vocabulary", () => {
    for (const rarity of [
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
      "Unique",
    ]) {
      const parsed = skillUpgradeCloneSchema.safeParse({ rarity })
      expect(parsed.success).toBe(true)
      if (parsed.success) expect(parsed.data.rarity).toBe(rarity)
    }
    expect(skillUpgradeCloneSchema.safeParse({}).success).toBe(false)
    expect(
      skillUpgradeCloneSchema.safeParse({ rarity: "Mythic" }).success
    ).toBe(false)
    expect(skillUpgradeCloneSchema.safeParse({ rarity: 5 }).success).toBe(false)
  })

  it("trims a supplied name and enforces a 1..200 bound", () => {
    const parsed = skillUpgradeCloneSchema.safeParse({
      rarity: "Common",
      name: "  Sunfire  ",
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.name).toBe("Sunfire")

    // Blank after trimming is rejected.
    expect(
      skillUpgradeCloneSchema.safeParse({ rarity: "Common", name: "   " })
        .success
    ).toBe(false)
    expect(
      skillUpgradeCloneSchema.safeParse({ rarity: "Common", name: "" }).success
    ).toBe(false)
    // At most 200 chars.
    expect(
      skillUpgradeCloneSchema.safeParse({
        rarity: "Common",
        name: "x".repeat(200),
      }).success
    ).toBe(true)
    expect(
      skillUpgradeCloneSchema.safeParse({
        rarity: "Common",
        name: "x".repeat(201),
      }).success
    ).toBe(false)
  })

  it("defaults name to undefined so the service falls back to the source name", () => {
    const parsed = skillUpgradeCloneSchema.safeParse({ rarity: "Uncommon" })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.name).toBeUndefined()
  })
})

describe("skill upgradeToStableIds (local shape)", () => {
  it("reads a legacy config without upgradeToStableIds as undefined (fallback)", () => {
    const parsed = skillConfigSchema.safeParse({
      track: "class",
      milestone: 4,
      rarity: "Common",
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.upgradeToStableIds).toBeUndefined()
    }
  })

  it("accepts an explicit empty list (explicitly terminal)", () => {
    const parsed = skillConfigSchema.safeParse({
      track: "class",
      upgradeToStableIds: [],
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.upgradeToStableIds).toEqual([])
    }
  })

  it("accepts a nonempty, internally unique list", () => {
    const parsed = skillConfigSchema.safeParse({
      track: "class",
      upgradeToStableIds: ["skill-a", "skill-b"],
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.upgradeToStableIds).toEqual(["skill-a", "skill-b"])
    }
  })

  it("rejects a duplicate upgradeToStableIds entry", () => {
    const parsed = skillConfigSchema.safeParse({
      track: "class",
      upgradeToStableIds: ["skill-a", "skill-a"],
    })
    expect(parsed.success).toBe(false)
  })

  it("rejects a blank upgradeToStableIds entry", () => {
    const parsed = skillConfigSchema.safeParse({
      track: "class",
      upgradeToStableIds: [""],
    })
    expect(parsed.success).toBe(false)
  })

  it("accepts exactly 500 entries and rejects 501", () => {
    const fiveHundred = Array.from({ length: 500 }, (_, i) => `skill-${i}`)
    expect(
      skillConfigSchema.safeParse({
        track: "class",
        upgradeToStableIds: fiveHundred,
      }).success
    ).toBe(true)
    const fiveHundredOne = Array.from({ length: 501 }, (_, i) => `skill-${i}`)
    expect(
      skillConfigSchema.safeParse({
        track: "class",
        upgradeToStableIds: fiveHundredOne,
      }).success
    ).toBe(false)
  })
})

describe("gradeDescriptionsSchema (catalog grade-specific prose)", () => {
  it("accepts a valid grade-keyed map and trims values", () => {
    const res = gradeDescriptionsSchema.safeParse({
      G: "  hello  ",
      S: "world",
    })
    expect(res.success).toBe(true)
    if (res.success) expect(res.data).toEqual({ G: "hello", S: "world" })
  })

  it("accepts an empty map ({} means no authored grade text)", () => {
    const res = gradeDescriptionsSchema.safeParse({})
    expect(res.success).toBe(true)
    if (res.success) expect(res.data).toEqual({})
  })

  it("rejects an unknown grade key", () => {
    const res = gradeDescriptionsSchema.safeParse({ H: "nope" })
    expect(res.success).toBe(false)
  })

  it("rejects a blank (whitespace-only) value", () => {
    expect(gradeDescriptionsSchema.safeParse({ G: "   " }).success).toBe(false)
  })

  it("rejects an oversized value (over 8000 characters)", () => {
    expect(
      gradeDescriptionsSchema.safeParse({ G: "x".repeat(8001) }).success
    ).toBe(false)
  })

  it("rejects a non-object / array value", () => {
    expect(gradeDescriptionsSchema.safeParse([]).success).toBe(false)
  })
})

describe("gradeGrantedSkillStableIdsSchema (per-grade automatic skill grants)", () => {
  it("accepts a valid grade-keyed map of nonempty unique ids", () => {
    const res = gradeGrantedSkillStableIdsSchema.safeParse({
      G: ["blood-rage", "iron-skin"],
      S: ["final-form"],
    })
    expect(res.success).toBe(true)
    if (res.success)
      expect(res.data).toEqual({
        G: ["blood-rage", "iron-skin"],
        S: ["final-form"],
      })
  })

  it("accepts an empty map ({} means no authored grade grants)", () => {
    const res = gradeGrantedSkillStableIdsSchema.safeParse({})
    expect(res.success).toBe(true)
    if (res.success) expect(res.data).toEqual({})
  })

  it("raceConfigSchema accepts a legacy config without the field", () => {
    expect(
      raceConfigSchema.safeParse({ raceType: "enlightened", naturalGrade: "F" })
        .success
    ).toBe(true)
  })

  it("rejects an unknown grade key", () => {
    const res = gradeGrantedSkillStableIdsSchema.safeParse({ H: ["nope"] })
    expect(res.success).toBe(false)
    if (!res.success) {
      expect(
        res.error.issues.some((i) => /invalid grade key "H"/.test(i.message))
      ).toBe(true)
    }
  })

  it("rejects a duplicate id granted twice for the same grade", () => {
    const res = gradeGrantedSkillStableIdsSchema.safeParse({ G: ["a", "a"] })
    expect(res.success).toBe(false)
    if (!res.success) {
      expect(
        res.error.issues.some((i) => /granted more than once/.test(i.message))
      ).toBe(true)
    }
  })

  it("rejects an empty-string id", () => {
    expect(
      gradeGrantedSkillStableIdsSchema.safeParse({ G: [""] }).success
    ).toBe(false)
  })

  it("rejects an invalid grade key even when the other grades are valid", () => {
    const res = gradeGrantedSkillStableIdsSchema.safeParse({
      G: ["a"],
      X: ["b"],
    })
    expect(res.success).toBe(false)
  })
})

describe("grade skill stable-id config plumbing", () => {
  it("raceConfigSchema accepts a gradeGrantedSkillStableIds map", () => {
    const res = raceConfigSchema.safeParse({
      raceType: "enlightened",
      naturalGrade: "F",
      gradeGrantedSkillStableIds: { F: ["blood-rage"] },
    })
    expect(res.success).toBe(true)
  })

  it("trackConfigSchema accepts a gradeGrantedSkillStableIds map", () => {
    const res = trackConfigSchema.safeParse({
      grades: { F: { fixed: { agility: 1 }, free: 0 } },
      gradeGrantedSkillStableIds: { F: ["blood-rage"] },
    })
    expect(res.success).toBe(true)
  })

  it("trackConfigSchema rejects an invalid grade key in the map", () => {
    const res = trackConfigSchema.safeParse({
      gradeGrantedSkillStableIds: { Q: ["x"] },
    })
    expect(res.success).toBe(false)
  })

  it("gradeSkillStableIdsFor returns the declared list for a valid grade", () => {
    expect(
      gradeSkillStableIdsFor(
        { gradeGrantedSkillStableIds: { G: ["a", "b"] } },
        "G"
      )
    ).toEqual(["a", "b"])
  })

  it("gradeSkillStableIdsFor returns [] for a grade with no authored entry", () => {
    expect(
      gradeSkillStableIdsFor({ gradeGrantedSkillStableIds: { G: ["a"] } }, "F")
    ).toEqual([])
  })

  it("gradeSkillStableIdsFor returns [] for a legacy config missing the field", () => {
    expect(gradeSkillStableIdsFor({}, "G")).toEqual([])
  })

  it("gradeSkillStableIdsFor returns [] for a malformed (non-object) field", () => {
    expect(
      gradeSkillStableIdsFor({ gradeGrantedSkillStableIds: [] }, "G")
    ).toEqual([])
    expect(
      gradeSkillStableIdsFor({ gradeGrantedSkillStableIds: "nope" }, "G")
    ).toEqual([])
  })

  it("gradeSkillStableIdsFor filters non-string ids to strings", () => {
    expect(
      gradeSkillStableIdsFor(
        { gradeGrantedSkillStableIds: { G: ["a", 1, null] } },
        "G"
      )
    ).toEqual(["a"])
  })

  it("allGradeGrantedSkillStableIds collects ids across every grade", () => {
    const ids = allGradeGrantedSkillStableIds({
      gradeGrantedSkillStableIds: { G: ["a"], F: ["b", "c"] },
    })
    expect(ids.sort()).toEqual(["a", "b", "c"])
  })

  it("allGradeGrantedSkillStableIds returns [] for a legacy config missing the field", () => {
    expect(allGradeGrantedSkillStableIds({})).toEqual([])
  })

  it("allGradeGrantedSkillStableIds returns [] for a malformed field", () => {
    expect(
      allGradeGrantedSkillStableIds({ gradeGrantedSkillStableIds: [] })
    ).toEqual([])
  })
})

describe("godGradeForbidden (gods carry no catalog grade)", () => {
  it("allows a gods entry with a null grade and with a missing (undefined) grade", () => {
    expect(godGradeForbidden("gods", null)).toBe(false)
    expect(godGradeForbidden("gods", undefined)).toBe(false)
  })

  it("rejects a gods entry with any non-null grade value", () => {
    for (const grade of ["G", "F", "E", "D", "C", "B", "A", "S"]) {
      expect(godGradeForbidden("gods", grade)).toBe(true)
    }
  })

  it("is only triggered for the gods kind", () => {
    // A graded race/class/profession (and all other graded kinds) never trips the
    // god invariant.
    expect(godGradeForbidden("races", "S")).toBe(false)
    expect(godGradeForbidden("classes", "B")).toBe(false)
    expect(godGradeForbidden("professions", "A")).toBe(false)
    expect(godGradeForbidden("titles", "C")).toBe(false)
    expect(godGradeForbidden("skills", "D")).toBe(false)
    // A non-god kind with a null grade is also fine.
    expect(godGradeForbidden("items", null)).toBe(false)
    expect(godGradeForbidden("bloodlines", undefined)).toBe(false)
  })
})

describe("requiredGradeNullForbidden (races/classes/professions never clear grade to null)", () => {
  it("rejects an explicit null grade on a race, class or profession", () => {
    expect(requiredGradeNullForbidden("races", null)).toBe(true)
    expect(requiredGradeNullForbidden("classes", null)).toBe(true)
    expect(requiredGradeNullForbidden("professions", null)).toBe(true)
  })

  it("allows an omitted grade and a non-null grade on the graded kinds", () => {
    // Omitting grade (undefined) preserves the existing value - never rejected.
    expect(requiredGradeNullForbidden("races", undefined)).toBe(false)
    expect(requiredGradeNullForbidden("classes", undefined)).toBe(false)
    expect(requiredGradeNullForbidden("professions", undefined)).toBe(false)
    // A valid explicit grade is always legal.
    for (const grade of ["G", "F", "E", "D", "C", "B", "A", "S"]) {
      expect(requiredGradeNullForbidden("races", grade)).toBe(false)
      expect(requiredGradeNullForbidden("classes", grade)).toBe(false)
      expect(requiredGradeNullForbidden("professions", grade)).toBe(false)
    }
  })

  it("is only triggered for the graded kinds", () => {
    // The optional/clearable kinds (and gods) never trip the required-grade guard.
    expect(requiredGradeNullForbidden("items", null)).toBe(false)
    expect(requiredGradeNullForbidden("titles", null)).toBe(false)
    expect(requiredGradeNullForbidden("bloodlines", null)).toBe(false)
    expect(requiredGradeNullForbidden("transcendent_skills", null)).toBe(false)
    expect(requiredGradeNullForbidden("equipment", null)).toBe(false)
    expect(requiredGradeNullForbidden("skills", null)).toBe(false)
    expect(requiredGradeNullForbidden("gods", null)).toBe(false)
  })
})

describe("currencies catalog kind invariants", () => {
  it("treats currencies as a canonical catalog kind", () => {
    expect(catalogKindSchema.safeParse("currencies").success).toBe(true)
    // The legacy `consumables` alias is NOT a canonical kind (it normalizes to items).
    expect(catalogKindSchema.safeParse("consumables").success).toBe(false)
  })

  describe("currencyGradeForbidden (currencies carry no catalog grade)", () => {
    it("allows a currencies entry with a null grade and with a missing (undefined) grade", () => {
      expect(currencyGradeForbidden("currencies", null)).toBe(false)
      expect(currencyGradeForbidden("currencies", undefined)).toBe(false)
    })

    it("rejects a currencies entry with any non-null grade value", () => {
      for (const grade of ["G", "F", "E", "D", "C", "B", "A", "S"]) {
        expect(currencyGradeForbidden("currencies", grade)).toBe(true)
      }
    })

    it("is only triggered for the currencies kind", () => {
      // A graded race/class/profession (and all other graded kinds, incl. gods)
      // never trips the currency invariant.
      expect(currencyGradeForbidden("races", "S")).toBe(false)
      expect(currencyGradeForbidden("classes", "B")).toBe(false)
      expect(currencyGradeForbidden("professions", "A")).toBe(false)
      expect(currencyGradeForbidden("gods", "C")).toBe(false)
      expect(currencyGradeForbidden("items", null)).toBe(false)
    })
  })

  describe("currencyGradeDescriptionsForbidden (currencies carry no grade ladder)", () => {
    it("allows a currencies entry with omitted, null, or empty gradeDescriptions", () => {
      expect(currencyGradeDescriptionsForbidden("currencies", undefined)).toBe(
        false
      )
      expect(currencyGradeDescriptionsForbidden("currencies", null)).toBe(false)
      expect(currencyGradeDescriptionsForbidden("currencies", {})).toBe(false)
    })

    it("rejects a currencies entry with a non-empty gradeDescriptions map", () => {
      expect(
        currencyGradeDescriptionsForbidden("currencies", { G: "text" })
      ).toBe(true)
      expect(
        currencyGradeDescriptionsForbidden("currencies", { S: "top" })
      ).toBe(true)
    })

    it("is only triggered for the currencies kind", () => {
      expect(currencyGradeDescriptionsForbidden("gods", { G: "text" })).toBe(
        false
      )
      expect(currencyGradeDescriptionsForbidden("titles", { A: "text" })).toBe(
        false
      )
    })
  })

  describe("currencyConfigSchema (strict empty config)", () => {
    it("accepts the empty object", () => {
      expect(currencyConfigSchema.safeParse({}).success).toBe(true)
    })

    it("rejects any non-empty config", () => {
      expect(currencyConfigSchema.safeParse({ rarity: "Common" }).success).toBe(
        false
      )
      expect(currencyConfigSchema.safeParse({ grade: "S" }).success).toBe(false)
    })

    it("rejects a non-object config", () => {
      expect(currencyConfigSchema.safeParse([]).success).toBe(false)
      expect(currencyConfigSchema.safeParse(null).success).toBe(false)
    })
  })
})

describe("skills catalog kind invariants", () => {
  describe("skillGradeForbidden (skills carry no catalog grade)", () => {
    it("allows a skills entry with a null grade and with a missing (undefined) grade", () => {
      expect(skillGradeForbidden("skills", null)).toBe(false)
      expect(skillGradeForbidden("skills", undefined)).toBe(false)
    })

    it("rejects a skills entry with any non-null grade value", () => {
      for (const grade of ["G", "F", "E", "D", "C", "B", "A", "S"]) {
        expect(skillGradeForbidden("skills", grade)).toBe(true)
      }
    })

    it("is only triggered for the skills kind", () => {
      // A graded race/class/profession (and all other graded kinds) never trips
      // the skill invariant.
      expect(skillGradeForbidden("races", "S")).toBe(false)
      expect(skillGradeForbidden("classes", "B")).toBe(false)
      expect(skillGradeForbidden("professions", "A")).toBe(false)
      expect(skillGradeForbidden("titles", "C")).toBe(false)
      expect(skillGradeForbidden("equipment", "D")).toBe(false)
      expect(skillGradeForbidden("gods", "C")).toBe(false)
      expect(skillGradeForbidden("currencies", "A")).toBe(false)
      // A non-skill kind with a null grade is also fine.
      expect(skillGradeForbidden("items", null)).toBe(false)
      expect(skillGradeForbidden("bloodlines", undefined)).toBe(false)
    })
  })

  describe("skillGradeDescriptionsForbidden (skills carry no grade ladder)", () => {
    it("allows a skills entry with omitted, null, or empty gradeDescriptions", () => {
      expect(skillGradeDescriptionsForbidden("skills", undefined)).toBe(false)
      expect(skillGradeDescriptionsForbidden("skills", null)).toBe(false)
      expect(skillGradeDescriptionsForbidden("skills", {})).toBe(false)
    })

    it("rejects a skills entry with a non-empty gradeDescriptions map", () => {
      expect(skillGradeDescriptionsForbidden("skills", { G: "text" })).toBe(
        true
      )
      expect(skillGradeDescriptionsForbidden("skills", { S: "top" })).toBe(true)
    })

    it("is only triggered for the skills kind", () => {
      expect(skillGradeDescriptionsForbidden("gods", { G: "text" })).toBe(false)
      expect(skillGradeDescriptionsForbidden("titles", { A: "text" })).toBe(
        false
      )
      expect(skillGradeDescriptionsForbidden("currencies", { G: "text" })).toBe(
        false
      )
    })
  })
})

describe("characterStateSchema experiencePercent validation", () => {
  function baseState(overrides: Record<string, unknown> = {}) {
    return {
      baseAttributes: {
        strength: 0,
        agility: 0,
        endurance: 0,
        vitality: 0,
        toughness: 0,
        wisdom: 0,
        intelligence: 0,
        perception: 0,
        willpower: 0,
      },
      tracks: {},
      race: { level: 0, grade: "F", mode: "derived" },
      historicalLevelAwards: [],
      allocations: [],
      permanentGains: [],
      activeEffects: [],
      equipment: [],
      currentResources: {},
      turn: 0,
      ...overrides,
    }
  }

  it("accepts a track with a matching explicit experiencePercent and quarter", () => {
    const state = baseState({
      tracks: {
        class: {
          level: 1,
          quarter: 1,
          definitionId: "d",
          experiencePercent: 25,
        },
      },
    })
    expect(characterStateSchema.safeParse(state).success).toBe(true)
  })

  it("rejects a track whose quarter does not match experiencePercent", () => {
    const state = baseState({
      tracks: {
        class: {
          level: 1,
          quarter: 2,
          definitionId: "d",
          experiencePercent: 25,
        },
      },
    })
    expect(characterStateSchema.safeParse(state).success).toBe(false)
  })

  it("accepts an independent race with a matching experiencePercent and quarter", () => {
    const state = baseState({
      race: {
        level: 0,
        grade: "F",
        mode: "independent",
        quarter: 2,
        experiencePercent: 50,
      },
    })
    expect(characterStateSchema.safeParse(state).success).toBe(true)
  })

  it("rejects a race whose quarter does not match experiencePercent", () => {
    const state = baseState({
      race: {
        level: 0,
        grade: "F",
        mode: "independent",
        quarter: 1,
        experiencePercent: 50,
      },
    })
    expect(characterStateSchema.safeParse(state).success).toBe(false)
  })

  it("accepts legacy state with a quarter but no explicit experiencePercent", () => {
    const state = baseState({
      tracks: {
        class: { level: 1, quarter: 3, definitionId: "d" },
      },
      race: { level: 0, grade: "F", mode: "independent", quarter: 3 },
    })
    expect(characterStateSchema.safeParse(state).success).toBe(true)
  })

  it("rejects an experiencePercent outside 0..99 or non-integer", () => {
    const badTracks = [
      { level: 1, quarter: 0, definitionId: "d", experiencePercent: 100 },
      { level: 1, quarter: 0, definitionId: "d", experiencePercent: -1 },
      { level: 1, quarter: 0, definitionId: "d", experiencePercent: 25.5 },
    ]
    for (const track of badTracks) {
      const state = baseState({ tracks: { class: track } })
      expect(characterStateSchema.safeParse(state).success).toBe(false)
    }
  })
})

describe("historicalLevelAwards track literals (legacy permissiveness)", () => {
  it("accepts a known track literal and preserves it verbatim", () => {
    const state = {
      baseAttributes: {
        strength: 0,
        agility: 0,
        endurance: 0,
        vitality: 0,
        toughness: 0,
        wisdom: 0,
        intelligence: 0,
        perception: 0,
        willpower: 0,
      },
      tracks: {},
      race: { level: 0, grade: "F", mode: "derived" },
      historicalLevelAwards: [
        {
          track: "race",
          level: 1,
          definitionId: "d",
          fixed: {
            strength: 1,
            agility: 0,
            endurance: 0,
            vitality: 0,
            toughness: 0,
            wisdom: 0,
            intelligence: 0,
            perception: 0,
            willpower: 0,
          },
          free: 0,
        },
      ],
      allocations: [],
      permanentGains: [],
      activeEffects: [],
      equipment: [],
      currentResources: {},
      turn: 0,
    }
    const parsed = characterStateSchema.safeParse(state)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.historicalLevelAwards[0].track).toBe("race")
    }
  })

  it("accepts a genuinely unknown legacy track literal (no parser restriction)", () => {
    // The engine splits unknown track literals evenly across applicable tracks;
    // the state schema must not reject such a literal on read.
    const state = {
      baseAttributes: {
        strength: 0,
        agility: 0,
        endurance: 0,
        vitality: 0,
        toughness: 0,
        wisdom: 0,
        intelligence: 0,
        perception: 0,
        willpower: 0,
      },
      tracks: {},
      race: { level: 0, grade: "F", mode: "derived" },
      historicalLevelAwards: [
        {
          track: "mystic-path",
          level: 1,
          definitionId: "d",
          fixed: {
            strength: 1,
            agility: 0,
            endurance: 0,
            vitality: 0,
            toughness: 0,
            wisdom: 0,
            intelligence: 0,
            perception: 0,
            willpower: 0,
          },
          free: 0,
        },
      ],
      allocations: [],
      permanentGains: [],
      activeEffects: [],
      equipment: [],
      currentResources: {},
      turn: 0,
    }
    const parsed = characterStateSchema.safeParse(state)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.historicalLevelAwards[0].track).toBe("mystic-path")
    }
  })
})

describe("itemConfigSchema / normalizeCatalogKind (items catalog kind)", () => {
  it("accepts an empty item config", () => {
    expect(itemConfigSchema.safeParse({}).success).toBe(true)
  })

  it("accepts an item config with optional narrative keys and passes unknown keys through", () => {
    const parsed = itemConfigSchema.parse({
      narrative: "A field ration.",
      description: "Keeps hunger at bay.",
      grade: "D",
      // Unknown/legacy keys pass through unchanged (no mandatory mechanical fields).
      type: "permanent",
      amount: { strength: 1 },
      durationQuarters: 3,
    })
    expect(parsed).toEqual({
      narrative: "A field ration.",
      description: "Keeps hunger at bay.",
      grade: "D",
      type: "permanent",
      amount: { strength: 1 },
      durationQuarters: 3,
    })
  })

  it("rejects a non-object item config", () => {
    expect(itemConfigSchema.safeParse("not-an-object").success).toBe(false)
  })

  it("normalizes the legacy `consumables` kind to `items`", () => {
    expect(normalizeCatalogKind("consumables")).toBe("items")
    expect(normalizeCatalogKind("items")).toBe("items")
    expect(normalizeCatalogKind("equipment")).toBe("equipment")
    expect(normalizeCatalogKind("races")).toBe("races")
  })
})

describe("associationSchema (blessing tier requirement)", () => {
  it("accepts a blessing add with an explicit valid tier", () => {
    const parsed = associationSchema.safeParse({
      kind: "blessing",
      definitionId: "god-1",
      operation: "add",
      version: 0,
      tier: "Minor",
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data).toMatchObject({ kind: "blessing", tier: "Minor" })
  })

  it("rejects a blessing add that omits the tier", () => {
    const parsed = associationSchema.safeParse({
      kind: "blessing",
      definitionId: "god-1",
      operation: "add",
      version: 0,
    })
    expect(parsed.success).toBe(false)
  })

  it("rejects a blessing add with an invalid tier value", () => {
    const parsed = associationSchema.safeParse({
      kind: "blessing",
      definitionId: "god-1",
      operation: "add",
      version: 0,
      tier: "minor",
    })
    expect(parsed.success).toBe(false)
  })

  it("accepts a blessing remove without a tier", () => {
    const parsed = associationSchema.safeParse({
      kind: "blessing",
      definitionId: "god-1",
      operation: "remove",
      version: 0,
    })
    expect(parsed.success).toBe(true)
  })

  it("accepts a non-blessing add without a tier", () => {
    const parsed = associationSchema.safeParse({
      kind: "bloodline",
      definitionId: "blood-1",
      operation: "add",
      version: 0,
    })
    expect(parsed.success).toBe(true)
  })
})
