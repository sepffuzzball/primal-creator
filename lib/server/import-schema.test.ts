import { describe, expect, it } from "vitest"
import {
  characterImportDocumentSchema,
  IMPORT_RULESET_VERSION,
  IMPORT_SCHEMA_V3,
  IMPORT_SCHEMA_V4,
  IMPORT_SCHEMA_V5,
  IMPORT_SCHEMA_V6,
  IMPORT_SCHEMA_V7,
} from "@/lib/server/import-schema"

/**
 * Schema-layer tests for the trusted-backup skill-offer `canceledAt` timestamp.
 *
 * These build minimal valid documents (all non-skill-offer fields are valid) and
 * assert ONLY the `canceledAt` acceptance/rejection behavior, so a failure is
 * attributable to the timestamp, not to some other required field.
 */

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
  tracks: { class: { level: 0, quarter: 0, definitionId: "" } },
  race: { level: 0, grade: "G", mode: "derived", origin: "integrated" },
  historicalLevelAwards: [],
  allocations: [],
  permanentGains: [],
  activeEffects: [],
  equipment: [],
  currentResources: {},
  turn: 0,
}

const identity = {
  name: "Imported",
  origin: "integrated" as const,
  race: { stableId: "human" },
  class: { stableId: "archer" },
  profession: null,
}

function baseDoc(
  schema:
    typeof IMPORT_SCHEMA_V3 | typeof IMPORT_SCHEMA_V6 | typeof IMPORT_SCHEMA_V7,
  skillOffers: unknown[]
): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    schema,
    rulesetVersion: IMPORT_RULESET_VERSION,
    identity,
    state,
    liveState: {},
    status: {},
    events: [],
    associations: [],
    skillOffers,
  }
  if (schema === IMPORT_SCHEMA_V6 || schema === IMPORT_SCHEMA_V7)
    doc.inventory = []
  return doc
}

describe("import document skill-offer canceledAt validation", () => {
  it("accepts a v6 race-track offer (track 'race')", () => {
    const parsed = characterImportDocumentSchema.safeParse(
      baseDoc(IMPORT_SCHEMA_V6, [
        {
          track: "race",
          level: 5,
          choiceGroup: "standard",
          generation: 0,
          canceledAt: null,
          options: [],
        },
      ])
    )
    expect(parsed.success).toBe(true)
  })

  it("accepts a legacy v3 race-track offer (track 'race')", () => {
    const parsed = characterImportDocumentSchema.safeParse(
      baseDoc(IMPORT_SCHEMA_V3, [
        {
          track: "race",
          level: 5,
          choiceGroup: "standard",
          options: [],
        },
      ])
    )
    expect(parsed.success).toBe(true)
  })

  it("accepts a v6 offer with a null canceledAt (active offer)", () => {
    const parsed = characterImportDocumentSchema.safeParse(
      baseDoc(IMPORT_SCHEMA_V6, [
        {
          track: "class",
          level: 1,
          choiceGroup: "standard",
          generation: 0,
          canceledAt: null,
          options: [],
        },
      ])
    )
    expect(parsed.success).toBe(true)
  })

  it("accepts a v6 offer with a UTC ISO canceledAt (Z suffix)", () => {
    const parsed = characterImportDocumentSchema.safeParse(
      baseDoc(IMPORT_SCHEMA_V6, [
        {
          track: "class",
          level: 1,
          choiceGroup: "standard",
          generation: 1,
          canceledAt: "2026-03-03T12:00:00.000Z",
          options: [],
        },
      ])
    )
    expect(parsed.success).toBe(true)
  })

  it("accepts a v6 offer with an explicit timezone offset canceledAt", () => {
    const parsed = characterImportDocumentSchema.safeParse(
      baseDoc(IMPORT_SCHEMA_V6, [
        {
          track: "class",
          level: 1,
          choiceGroup: "standard",
          generation: 1,
          canceledAt: "2026-03-03T12:00:00.000+02:00",
          options: [],
        },
      ])
    )
    expect(parsed.success).toBe(true)
  })

  it("rejects a v6 offer whose canceledAt has no timezone", () => {
    const parsed = characterImportDocumentSchema.safeParse(
      baseDoc(IMPORT_SCHEMA_V6, [
        {
          track: "class",
          level: 1,
          choiceGroup: "standard",
          generation: 1,
          canceledAt: "2026-03-03T12:00:00.000",
          options: [],
        },
      ])
    )
    expect(parsed.success).toBe(false)
  })

  it.each(["not-a-date", ""])(
    "rejects a v6 offer with an invalid canceledAt %j",
    (bad) => {
      const parsed = characterImportDocumentSchema.safeParse(
        baseDoc(IMPORT_SCHEMA_V6, [
          {
            track: "class",
            level: 1,
            choiceGroup: "standard",
            generation: 1,
            canceledAt: bad,
            options: [],
          },
        ])
      )
      expect(parsed.success).toBe(false)
    }
  )

  it("accepts a legacy v3 offer that omits canceledAt (defaults to active)", () => {
    const parsed = characterImportDocumentSchema.safeParse(
      baseDoc(IMPORT_SCHEMA_V3, [
        {
          track: "class",
          level: 1,
          choiceGroup: "standard",
          options: [],
        },
      ])
    )
    expect(parsed.success).toBe(true)
  })

  it("accepts a legacy v3 offer with a null canceledAt", () => {
    const parsed = characterImportDocumentSchema.safeParse(
      baseDoc(IMPORT_SCHEMA_V3, [
        {
          track: "class",
          level: 1,
          choiceGroup: "standard",
          canceledAt: null,
          options: [],
        },
      ])
    )
    expect(parsed.success).toBe(true)
  })

  it("accepts a legacy v3 offer with a valid ISO canceledAt", () => {
    const parsed = characterImportDocumentSchema.safeParse(
      baseDoc(IMPORT_SCHEMA_V3, [
        {
          track: "class",
          level: 1,
          choiceGroup: "standard",
          canceledAt: "2026-03-03T12:00:00.000Z",
          options: [],
        },
      ])
    )
    expect(parsed.success).toBe(true)
  })

  it("accepts a legacy v3 offer with a Unix ms epoch number canceledAt", () => {
    const parsed = characterImportDocumentSchema.safeParse(
      baseDoc(IMPORT_SCHEMA_V3, [
        {
          track: "class",
          level: 1,
          choiceGroup: "standard",
          canceledAt: 1772625600000,
          options: [],
        },
      ])
    )
    expect(parsed.success).toBe(true)
  })

  it.each(["not-a-date", ""])(
    "rejects a legacy v3 offer with an invalid canceledAt %j",
    (bad) => {
      const parsed = characterImportDocumentSchema.safeParse(
        baseDoc(IMPORT_SCHEMA_V3, [
          {
            track: "class",
            level: 1,
            choiceGroup: "standard",
            canceledAt: bad,
            options: [],
          },
        ])
      )
      expect(parsed.success).toBe(false)
    }
  )
})

describe("import document inventory kind normalization", () => {
  it.each([IMPORT_SCHEMA_V4, IMPORT_SCHEMA_V5, IMPORT_SCHEMA_V6])(
    "normalizes a legacy inventory `consumables` kind to `items` (schema %s)",
    (schema) => {
      const parsed = characterImportDocumentSchema.safeParse({
        schema,
        rulesetVersion: IMPORT_RULESET_VERSION,
        identity,
        state,
        liveState: {},
        status: {},
        events: [],
        associations: [],
        skillOffers: [],
        inventory: [
          {
            definition: { kind: "consumables", stableId: "ration-1" },
            quantity: 3,
          },
        ],
      })
      expect(parsed.success).toBe(true)
      if (parsed.success) {
        const doc = parsed.data as {
          schema:
            | typeof IMPORT_SCHEMA_V4
            | typeof IMPORT_SCHEMA_V5
            | typeof IMPORT_SCHEMA_V6
          inventory: Array<{
            definition: { kind: string; stableId: string }
            quantity: number
          }>
        }
        expect(doc.inventory[0].definition.kind).toBe("items")
      }
    }
  )

  it("keeps an `items` inventory kind unchanged", () => {
    const parsed = characterImportDocumentSchema.safeParse({
      schema: IMPORT_SCHEMA_V6,
      rulesetVersion: IMPORT_RULESET_VERSION,
      identity,
      state,
      liveState: {},
      status: {},
      events: [],
      associations: [],
      skillOffers: [],
      inventory: [
        {
          definition: { kind: "items", stableId: "ration-1" },
          quantity: 3,
        },
      ],
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      const doc = parsed.data as {
        schema: typeof IMPORT_SCHEMA_V6
        inventory: Array<{
          definition: { kind: string; stableId: string }
          quantity: number
        }>
      }
      expect(doc.inventory[0].definition.kind).toBe("items")
    }
  })
})

describe("import document v7 blessing association / inventory", () => {
  function v7Doc(overrides: {
    associations?: unknown[]
    inventory?: unknown[]
  }): Record<string, unknown> {
    return {
      schema: IMPORT_SCHEMA_V7,
      rulesetVersion: IMPORT_RULESET_VERSION,
      identity,
      state,
      liveState: {},
      status: {},
      events: [],
      associations: overrides.associations ?? [],
      skillOffers: [],
      inventory: overrides.inventory ?? [],
    }
  }

  it("accepts a v7 blessing association referencing a gods definition with a valid tier", () => {
    const parsed = characterImportDocumentSchema.safeParse(
      v7Doc({
        associations: [
          {
            kind: "blessing",
            definition: { kind: "gods", stableId: "the-malefic-viper" },
            tier: "True",
          },
        ],
      })
    )
    expect(parsed.success).toBe(true)
  })

  it("rejects a v7 blessing association whose definition is not a gods kind", () => {
    // A stale legacy `blessings` kind is rejected at the schema boundary.
    const parsed = characterImportDocumentSchema.safeParse(
      v7Doc({
        associations: [
          {
            kind: "blessing",
            definition: { kind: "blessings", stableId: "true-blessing" },
            tier: "Minor",
          },
        ],
      })
    )
    expect(parsed.success).toBe(false)
  })

  it("rejects a v7 blessing association with a missing tier", () => {
    const parsed = characterImportDocumentSchema.safeParse(
      v7Doc({
        associations: [
          {
            kind: "blessing",
            definition: { kind: "gods", stableId: "the-malefic-viper" },
          },
        ],
      })
    )
    expect(parsed.success).toBe(false)
  })

  it("rejects a v7 blessing association with an invalid tier", () => {
    const parsed = characterImportDocumentSchema.safeParse(
      v7Doc({
        associations: [
          {
            kind: "blessing",
            definition: { kind: "gods", stableId: "the-malefic-viper" },
            tier: "minor",
          },
        ],
      })
    )
    expect(parsed.success).toBe(false)
  })

  it("rejects a v7 inventory `consumables` kind (not normalized)", () => {
    const parsed = characterImportDocumentSchema.safeParse(
      v7Doc({
        inventory: [
          {
            definition: { kind: "consumables", stableId: "ration-1" },
            quantity: 3,
          },
        ],
      })
    )
    expect(parsed.success).toBe(false)
  })

  it("accepts a v7 inventory with equipment/items kinds only", () => {
    const parsed = characterImportDocumentSchema.safeParse(
      v7Doc({
        inventory: [
          {
            definition: { kind: "equipment", stableId: "gear-1" },
            quantity: 1,
          },
          {
            definition: { kind: "items", stableId: "ration-1" },
            quantity: 3,
          },
        ],
      })
    )
    expect(parsed.success).toBe(true)
  })
})

describe("import document state equipment derived bonuses", () => {
  it("round-trips an equipment bonus carrying derivedFlat / derivedPercentBasisPoints", () => {
    const withEquipment = {
      ...state,
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
    }
    const doc = {
      schema: IMPORT_SCHEMA_V6,
      rulesetVersion: IMPORT_RULESET_VERSION,
      identity,
      state: withEquipment,
      liveState: {},
      status: {},
      events: [],
      associations: [],
      skillOffers: [],
      inventory: [],
    }
    const parsed = characterImportDocumentSchema.safeParse(doc)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      const equipment = parsed.data.state.equipment as Array<{
        derivedFlat?: Record<string, number>
        derivedPercentBasisPoints?: Record<string, number>
      }>
      expect(equipment[0].derivedFlat).toEqual({ hp: 50, mp: 25 })
      expect(equipment[0].derivedPercentBasisPoints).toEqual({
        hp: 1000,
        mp: 2000,
      })
    }
  })
})

describe("import document v7 skill-offer schedule provenance pair", () => {
  function v7Offer(
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      track: "class",
      level: 4,
      choiceGroup: "standard",
      generation: 0,
      canceledAt: null,
      offeredAt: "2026-03-03T12:00:00.000Z",
      selectedStableId: null,
      selectedAt: null,
      options: [],
      ...overrides,
    }
  }

  function parse(offers: unknown[]) {
    return characterImportDocumentSchema.safeParse(
      baseDoc(IMPORT_SCHEMA_V7, offers)
    )
  }

  it("accepts a scheduled offer carrying both provenance fields", () => {
    const parsed = parse([
      v7Offer({ earnedGrade: "F", trackDefinitionStableId: "archer" }),
    ])
    expect(parsed.success).toBe(true)
  })

  it("accepts a legacy offer that omits both provenance fields", () => {
    const parsed = parse([v7Offer()])
    expect(parsed.success).toBe(true)
  })

  it("accepts a scheduled offer with both provenance fields explicitly null (normalized legacy)", () => {
    const parsed = parse([
      v7Offer({ earnedGrade: null, trackDefinitionStableId: null }),
    ])
    expect(parsed.success).toBe(true)
  })

  it("accepts a scheduled monstrous race offer (track 'race')", () => {
    const parsed = parse([
      v7Offer({
        track: "race",
        earnedGrade: "G",
        trackDefinitionStableId: "wyrm",
      }),
    ])
    expect(parsed.success).toBe(true)
  })

  it("rejects a malformed grade even when the pair is otherwise complete", () => {
    const parsed = parse([
      v7Offer({ earnedGrade: "X", trackDefinitionStableId: "archer" }),
    ])
    expect(parsed.success).toBe(false)
  })

  it("rejects an empty trackDefinitionStableId even when the pair is otherwise complete", () => {
    const parsed = parse([
      v7Offer({ earnedGrade: "F", trackDefinitionStableId: "" }),
    ])
    expect(parsed.success).toBe(false)
  })

  it("rejects a mismatched pair: earnedGrade set without trackDefinitionStableId", () => {
    const parsed = parse([v7Offer({ earnedGrade: "F" })])
    expect(parsed.success).toBe(false)
  })

  it("rejects a mismatched pair: trackDefinitionStableId set without earnedGrade", () => {
    const parsed = parse([v7Offer({ trackDefinitionStableId: "archer" })])
    expect(parsed.success).toBe(false)
  })

  it("accepts a scheduled class offer with both provenance fields and the earning-time class snapshot", () => {
    const parsed = parse([
      v7Offer({
        earnedGrade: "F",
        trackDefinitionStableId: "archer",
        classStableIdAtEarn: "archer",
      }),
    ])
    expect(parsed.success).toBe(true)
  })

  it("accepts a scheduled profession offer with both provenance fields and the earning-time class snapshot", () => {
    const parsed = parse([
      v7Offer({
        track: "profession",
        earnedGrade: "F",
        trackDefinitionStableId: "alchemist",
        classStableIdAtEarn: "archer",
      }),
    ])
    expect(parsed.success).toBe(true)
  })

  it("accepts a scheduled class offer with both provenance fields and a null class snapshot", () => {
    const parsed = parse([
      v7Offer({
        earnedGrade: "F",
        trackDefinitionStableId: "archer",
        classStableIdAtEarn: null,
      }),
    ])
    expect(parsed.success).toBe(true)
  })

  it("rejects a legacy offer that omits provenance but carries a nonnull class snapshot", () => {
    const parsed = parse([v7Offer({ classStableIdAtEarn: "archer" })])
    expect(parsed.success).toBe(false)
  })

  it("rejects a race offer that carries a class snapshot even with both provenance fields", () => {
    const parsed = parse([
      v7Offer({
        track: "race",
        earnedGrade: "G",
        trackDefinitionStableId: "wyrm",
        classStableIdAtEarn: "archer",
      }),
    ])
    expect(parsed.success).toBe(false)
  })

  it("rejects a class snapshot on a half-provided pair", () => {
    const parsed = parse([
      v7Offer({ earnedGrade: "F", classStableIdAtEarn: "archer" }),
    ])
    expect(parsed.success).toBe(false)
  })

  it.each([IMPORT_SCHEMA_V3, IMPORT_SCHEMA_V6])(
    "accepts an older backup offer that has no class snapshot (schema %s)",
    (schema) => {
      const parsed = characterImportDocumentSchema.safeParse(
        baseDoc(schema, [
          schema === IMPORT_SCHEMA_V6
            ? {
                track: "class",
                level: 1,
                choiceGroup: "standard",
                generation: 0,
                canceledAt: null,
                options: [],
              }
            : {
                track: "class",
                level: 1,
                choiceGroup: "standard",
                options: [],
              },
        ])
      )
      expect(parsed.success).toBe(true)
    }
  )
})
