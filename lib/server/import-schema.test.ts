import { describe, expect, it } from "vitest"
import {
  characterImportDocumentSchema,
  IMPORT_RULESET_VERSION,
  IMPORT_SCHEMA_V3,
  IMPORT_SCHEMA_V6,
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
  schema: typeof IMPORT_SCHEMA_V3 | typeof IMPORT_SCHEMA_V6,
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
  if (schema === IMPORT_SCHEMA_V6) doc.inventory = []
  return doc
}

describe("import document skill-offer canceledAt validation", () => {
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
