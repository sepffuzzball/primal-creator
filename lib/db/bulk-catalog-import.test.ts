import { beforeEach, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/db/client"
import {
  applyBulkImport,
  computeBulkRequestDigest,
  parseBulkEntries,
  previewBulkImport,
  MAX_BULK_ENTRIES,
} from "@/lib/db/bulk-catalog-import"

// Real unit tests against the in-memory Prisma mock. The mock backs the
// `@/lib/db/client` export so the importer's Prisma calls are exercised without a
// running Postgres. Parser and validation tests are pure and exercise
// `parseBulkEntries` directly.
type TestStore = import("./testPrisma").TestPrismaInstance["store"]
const dbMock = vi.hoisted(() => ({ store: undefined as unknown as TestStore }))

vi.mock("@/lib/db/client", async () => {
  const { createTestPrisma } = await import("./testPrisma")
  const instance = createTestPrisma()
  dbMock.store = instance.store
  return { prisma: instance.prisma, default: instance.prisma }
})

// ------------------------------------------------------------------ //
// Fixtures
// ------------------------------------------------------------------ //

function skill(
  kind: string,
  stableId: string,
  extra: Record<string, unknown> = {}
) {
  return {
    kind,
    stableId,
    name: `Name of ${stableId}`,
    description: `Description of ${stableId}`,
    provenance: "house",
    sourceUrl: "https://example.com/" + stableId,
    config: { track: "race", effects: [], rarity: "Common" },
    ...extra,
  }
}

function god(stableId: string) {
  return {
    kind: "gods",
    stableId,
    name: `God ${stableId}`,
    description: `A god named ${stableId}`,
    provenance: "house",
    sourceUrl: "https://example.com/god/" + stableId,
    config: {},
  }
}

function currency(stableId: string, extra: Record<string, unknown> = {}) {
  return {
    kind: "currencies",
    stableId,
    name: `Currency ${stableId}`,
    description: `A tender named ${stableId}`,
    provenance: "house",
    sourceUrl: "https://example.com/currency/" + stableId,
    config: {},
    ...extra,
  }
}

function equipment(stableId: string, extra: Record<string, unknown> = {}) {
  return {
    kind: "equipment",
    stableId,
    name: `Equipment ${stableId}`,
    description: `Equipment of ${stableId}`,
    provenance: "house",
    sourceUrl: "https://example.com/equipment/" + stableId,
    config: { slot: "Ring", rarity: "Common", ...extra },
  }
}

function race(stableId: string, extra: Record<string, unknown> = {}) {
  return {
    kind: "races",
    stableId,
    name: `Race ${stableId}`,
    description: `Race of ${stableId}`,
    provenance: "house",
    sourceUrl: "https://example.com/race/" + stableId,
    config: { raceType: "enlightened", naturalGrade: "F", ...extra },
  }
}

function classRow(stableId: string, extra: Record<string, unknown> = {}) {
  return {
    kind: "classes",
    stableId,
    name: `Class ${stableId}`,
    description: `Class of ${stableId}`,
    provenance: "house",
    sourceUrl: "https://example.com/class/" + stableId,
    config: { grades: { F: { fixed: { agility: 1 }, free: 0 } }, ...extra },
  }
}

function professionRow(stableId: string, extra: Record<string, unknown> = {}) {
  return {
    kind: "professions",
    stableId,
    name: `Profession ${stableId}`,
    description: `Profession of ${stableId}`,
    provenance: "house",
    sourceUrl: "https://example.com/profession/" + stableId,
    config: { grades: { F: { fixed: { wisdom: 1 }, free: 0 } }, ...extra },
  }
}

function titleRow(stableId: string, extra: Record<string, unknown> = {}) {
  return {
    kind: "titles",
    stableId,
    name: `Title ${stableId}`,
    description: `Title of ${stableId}`,
    provenance: "house",
    sourceUrl: "https://example.com/title/" + stableId,
    config: { ...extra },
  }
}

function jsonContent(objs: unknown[]): string {
  return JSON.stringify(objs)
}

function csvContent(
  rows: Array<Record<string, string>>,
  opts: { bom?: boolean; crlf?: boolean } = {}
): string {
  const newline = opts.crlf === false ? "\n" : "\r\n"
  const header = [
    "kind",
    "stableId",
    "name",
    "config",
    "description",
    "grade",
    "provenance",
    "sourceUrl",
    "gradeDescriptions",
  ]
  const lines = [
    header.join(","),
    ...rows.map((row) =>
      header
        .map((h) => {
          const cell = row[h] ?? ""
          return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell
        })
        .join(",")
    ),
  ]
  const body = lines.join(newline)
  return opts.bom ? "\uFEFF" + body : body
}

// ------------------------------------------------------------------ //
// Digest
// ------------------------------------------------------------------ //

describe("bulk catalog import digest", () => {
  it("computes a deterministic hex SHA256 of format + NUL + content", () => {
    const a = computeBulkRequestDigest("json", "[]")
    const b = computeBulkRequestDigest("json", "[]")
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it("changes the digest when content or format changes", () => {
    const base = computeBulkRequestDigest("json", "[]")
    expect(computeBulkRequestDigest("json", "[1]")).not.toBe(base)
    expect(computeBulkRequestDigest("csv", "[]")).not.toBe(base)
  })
})

// ------------------------------------------------------------------ //
// JSON parser + validation
// ------------------------------------------------------------------ //

describe("bulk JSON parsing and validation", () => {
  it("parses a JSON array into rows with 1-based row numbers", () => {
    const entries = parseBulkEntries(
      "json",
      jsonContent([skill("skills", "a"), skill("skills", "b")])
    )
    expect(entries).toHaveLength(2)
    expect(entries[0].row).toBe(1)
    expect(entries[1].row).toBe(2)
    expect(entries[0].kind).toBe("skills")
    expect(entries[0].sourceUrl).toBe("https://example.com/a")
  })

  it("rejects content that is not valid JSON", () => {
    expect(() => parseBulkEntries("json", "{not json")).toThrowError(
      expect.objectContaining({ status: 400, code: "validation" })
    )
  })

  it("rejects a top-level non-array", () => {
    expect(() => parseBulkEntries("json", `{"kind":"gods"}`)).toThrowError(
      expect.objectContaining({ status: 400, code: "validation" })
    )
  })

  it("rejects an array element that is not a plain object with its row", () => {
    expect(() =>
      parseBulkEntries("json", `[${JSON.stringify(skill("skills", "a"))}, 42]`)
    ).toThrowError(expect.objectContaining({ status: 400, code: "validation" }))
  })

  it("rejects an unknown catalog kind", () => {
    const bad = { ...skill("skills", "a"), kind: "spells" }
    expect(() => parseBulkEntries("json", jsonContent([bad]))).toThrowError(
      expect.objectContaining({ status: 400, code: "invalid_kind" })
    )
  })

  it("rejects a non-https sourceUrl", () => {
    const bad = {
      ...skill("skills", "a"),
      sourceUrl: "http://example.com/a",
    }
    expect(() => parseBulkEntries("json", jsonContent([bad]))).toThrowError(
      expect.objectContaining({ status: 400, code: "validation" })
    )
  })

  it("rejects a missing nonempty name, kind and stableId", () => {
    const missingName = { ...skill("skills", "a"), name: "" }
    expect(() =>
      parseBulkEntries("json", jsonContent([missingName]))
    ).toThrowError(expect.objectContaining({ status: 400, code: "validation" }))
    expect(() =>
      parseBulkEntries(
        "json",
        jsonContent([{ ...skill("skills", "a"), stableId: "" }])
      )
    ).toThrowError(expect.objectContaining({ status: 400, code: "validation" }))
  })

  it("enforces stableId and name length bounds", () => {
    const longId = "x".repeat(129)
    const longName = "x".repeat(257)
    expect(() =>
      parseBulkEntries(
        "json",
        jsonContent([{ ...skill("skills", "a"), stableId: longId }])
      )
    ).toThrowError(expect.objectContaining({ status: 400, code: "validation" }))
    expect(() =>
      parseBulkEntries(
        "json",
        jsonContent([{ ...skill("skills", "a"), name: longName }])
      )
    ).toThrowError(expect.objectContaining({ status: 400, code: "validation" }))
  })

  it("rejects a god whose blessingEffects references an unknown tier", () => {
    const bad = {
      ...god("bad-god"),
      config: { blessingEffects: { minor: [] } },
    }
    expect(() => parseBulkEntries("json", jsonContent([bad]))).toThrowError(
      expect.objectContaining({ status: 400, code: "invalid_config" })
    )
  })

  it("reports the row number for an invalid god config", () => {
    const bad = {
      ...god("bad-god"),
      config: { blessingEffects: { minor: [] } },
    }
    expect(() => parseBulkEntries("json", jsonContent([bad]))).toThrowError(
      /Bulk row 1: invalid config/i
    )
  })

  it("rejects a gods entry that carries a non-null catalog grade", () => {
    const bad = { ...god("graded-god"), grade: "S" }
    expect(() => parseBulkEntries("json", jsonContent([bad]))).toThrowError(
      expect.objectContaining({ status: 400, code: "invalid_grade" })
    )
  })

  it("reports the row number for a graded gods entry", () => {
    const bad = { ...god("graded-god"), grade: "A" }
    expect(() => parseBulkEntries("json", jsonContent([bad]))).toThrowError(
      /Bulk row 1: a gods entry carries no catalog grade/i
    )
  })

  it("accepts a gods entry that omits grade (null) and normalizes it to null", () => {
    const entries = parseBulkEntries("json", jsonContent([god("odin")]))
    expect(entries[0].kind).toBe("gods")
    expect(entries[0].grade).toBeNull()
  })

  it("accepts a currencies entry with an empty config and no grade", () => {
    const entries = parseBulkEntries("json", jsonContent([currency("crowns")]))
    expect(entries[0].kind).toBe("currencies")
    expect(entries[0].grade).toBeNull()
    expect(entries[0].config).toEqual({})
  })

  it("rejects a currencies entry that carries a non-null catalog grade", () => {
    const bad = { ...currency("graded-crowns"), grade: "S" }
    expect(() => parseBulkEntries("json", jsonContent([bad]))).toThrowError(
      expect.objectContaining({ status: 400, code: "invalid_grade" })
    )
  })

  it("reports the row number for a graded currencies entry", () => {
    const bad = { ...currency("graded-crowns"), grade: "A" }
    expect(() => parseBulkEntries("json", jsonContent([bad]))).toThrowError(
      /Bulk row 1: a currencies entry carries no catalog grade/i
    )
  })

  it("rejects a currencies entry with a non-empty gradeDescriptions", () => {
    const bad = { ...currency("crowns"), gradeDescriptions: { G: "text" } }
    expect(() => parseBulkEntries("json", jsonContent([bad]))).toThrowError(
      expect.objectContaining({
        status: 400,
        code: "invalid_grade_descriptions",
      })
    )
  })

  it("rejects a currencies entry with a non-empty config", () => {
    const bad = { ...currency("crowns"), config: { rarity: "Common" } }
    expect(() => parseBulkEntries("json", jsonContent([bad]))).toThrowError(
      expect.objectContaining({ status: 400, code: "invalid_config" })
    )
  })

  it("rejects a duplicate (kind, stableId) with the row number", () => {
    const dup = [
      skill("skills", "a"),
      { ...skill("skills", "a"), name: "Other" },
    ]
    expect(() => parseBulkEntries("json", jsonContent(dup))).toThrowError(
      expect.objectContaining({ status: 400, code: "duplicate_bulk_entry" })
    )
  })

  it("rejects more than the maximum number of entries", () => {
    const many = Array.from({ length: MAX_BULK_ENTRIES + 1 }, (_, i) =>
      skill("skills", `s-${i}`)
    )
    expect(() => parseBulkEntries("json", jsonContent(many))).toThrowError(
      expect.objectContaining({ status: 400, code: "bulk_too_many_entries" })
    )
  })

  it("rejects a misspelled top-level field with the row number", () => {
    const bad = { ...skill("skills", "a"), descripton: "typo" }
    expect(() => parseBulkEntries("json", jsonContent([bad]))).toThrowError(
      expect.objectContaining({ status: 400, code: "validation" })
    )
    expect(() => parseBulkEntries("json", jsonContent([bad]))).toThrowError(
      /Bulk row 1: unknown field "descripton"/
    )
  })

  it("rejects an unsupported archived top-level field", () => {
    const bad = { ...skill("skills", "a"), archived: true }
    expect(() => parseBulkEntries("json", jsonContent([bad]))).toThrowError(
      expect.objectContaining({ status: 400, code: "validation" })
    )
    expect(() => parseBulkEntries("json", jsonContent([bad]))).toThrowError(
      /Bulk row 1: unknown field "archived"/
    )
  })

  it("parses an authored gradeDescriptions map from JSON and trims values", () => {
    const entries = parseBulkEntries(
      "json",
      jsonContent([
        {
          ...skill("skills", "a"),
          gradeDescriptions: { G: "  hello  ", S: "world" },
        },
      ])
    )
    expect(entries[0].gradeDescriptions).toEqual({ G: "hello", S: "world" })
  })

  it("defaults a JSON row without gradeDescriptions to an empty map (legacy rows)", () => {
    const entries = parseBulkEntries(
      "json",
      jsonContent([skill("skills", "a")])
    )
    expect(entries[0].gradeDescriptions).toEqual({})
  })

  it("rejects a JSON row with an invalid gradeDescriptions key", () => {
    const bad = { ...skill("skills", "a"), gradeDescriptions: { H: "nope" } }
    expect(() => parseBulkEntries("json", jsonContent([bad]))).toThrowError(
      expect.objectContaining({ status: 400, code: "validation" })
    )
  })

  it("rejects a JSON row with a blank gradeDescriptions value", () => {
    const bad = { ...skill("skills", "a"), gradeDescriptions: { G: "   " } }
    expect(() => parseBulkEntries("json", jsonContent([bad]))).toThrowError(
      expect.objectContaining({ status: 400, code: "validation" })
    )
  })

  it("rejects a JSON row with an oversized gradeDescriptions value", () => {
    const bad = {
      ...skill("skills", "a"),
      gradeDescriptions: { G: "x".repeat(8001) },
    }
    expect(() => parseBulkEntries("json", jsonContent([bad]))).toThrowError(
      expect.objectContaining({ status: 400, code: "validation" })
    )
  })
})

// ------------------------------------------------------------------ //
// CSV parser + validation
// ------------------------------------------------------------------ //

describe("bulk CSV parsing and validation", () => {
  it("parses RFC4180 content with BOM and CRLF, keeping physical row numbers", () => {
    const content = csvContent(
      [
        {
          kind: "skills",
          stableId: "a",
          name: "A",
          config: '{"track":"race","effects":[],"rarity":"Common"}',
        },
        {
          kind: "skills",
          stableId: "b",
          name: "B",
          config: '{"track":"race","effects":[],"rarity":"Common"}',
        },
      ],
      { bom: true, crlf: true }
    )
    const entries = parseBulkEntries("csv", content)
    expect(entries).toHaveLength(2)
    // Header is line 1, first data row is line 2.
    expect(entries[0].row).toBe(2)
    expect(entries[1].row).toBe(3)
    expect(entries[0].config).toEqual({
      track: "race",
      effects: [],
      rarity: "Common",
    })
  })

  it("handles a quoted config with an embedded comma and newline", () => {
    const content = csvContent([
      {
        kind: "titles",
        stableId: "t",
        name: "Title",
        config: '{"flat":{"strength":10,"agility":10}}',
      },
    ])
    const [entry] = parseBulkEntries("csv", content)
    expect(entry.config).toEqual({ flat: { strength: 10, agility: 10 } })
  })

  it("treats a doubled quote inside a quoted field as a literal quote", () => {
    // name = 'He said "hi"'
    const content =
      'kind,stableId,name,config\r\nskills,s,"He said ""hi""","{""track"":""race"",""effects"":[],""rarity"":""Common""}"\r\n'
    const [entry] = parseBulkEntries("csv", content)
    expect(entry.name).toBe('He said "hi"')
  })

  it("rejects a duplicate header", () => {
    const content = 'kind,kind,name,config\r\nskills,a,A,{"effects":[]}\r\n'
    expect(() => parseBulkEntries("csv", content)).toThrowError(
      expect.objectContaining({ status: 400, code: "validation" })
    )
  })

  it("rejects an unknown header", () => {
    const content =
      'kind,stableId,name,config,extra\r\nskills,a,A,{"effects":[]}\r\n'
    expect(() => parseBulkEntries("csv", content)).toThrowError(
      expect.objectContaining({ status: 400, code: "validation" })
    )
  })

  it("rejects a missing required header", () => {
    const content = "kind,stableId,name\r\nskills,a,A\r\n"
    expect(() => parseBulkEntries("csv", content)).toThrowError(
      expect.objectContaining({ status: 400, code: "validation" })
    )
  })

  it("rejects a wrong field count with the row number", () => {
    const content = "kind,stableId,name,config\r\nskills,a,A\r\n"
    expect(() => parseBulkEntries("csv", content)).toThrowError(
      expect.objectContaining({ status: 400, code: "validation" })
    )
  })

  it("rejects a non-object config JSON", () => {
    const content = "kind,stableId,name,config\r\nskills,a,A,[1,2]\r\n"
    expect(() => parseBulkEntries("csv", content)).toThrowError(
      expect.objectContaining({ status: 400, code: "validation" })
    )
  })

  it("rejects malformed config JSON in a CSV cell", () => {
    const content = "kind,stableId,name,config\r\nskills,a,A,{effects}\r\n"
    expect(() => parseBulkEntries("csv", content)).toThrowError(
      expect.objectContaining({ status: 400, code: "validation" })
    )
  })

  it("rejects an unterminated quoted cell with the row number", () => {
    const content = 'kind,stableId,name,config\r\nskills,a,A,"unterminated\r\n'
    expect(() => parseBulkEntries("csv", content)).toThrowError(
      /Bulk CSV row 2: unterminated quoted field/
    )
    expect(() => parseBulkEntries("csv", content)).toThrowError(
      expect.objectContaining({ status: 400, code: "validation" })
    )
  })

  it("rejects a non-delimiter character after a closing quote with the row number", () => {
    const content =
      'kind,stableId,name,config\r\nskills,a,"A name" x,{"effects":[]}\r\n'
    expect(() => parseBulkEntries("csv", content)).toThrowError(
      /Bulk CSV row 2: unexpected character " " after a closing quote/
    )
  })

  it("rejects an unescaped quote in an unquoted field with the row number", () => {
    const content =
      'kind,stableId,name,config\r\nskills,a,A"B,{"effects":[]}\r\n'
    expect(() => parseBulkEntries("csv", content)).toThrowError(
      /Bulk CSV row 2: unescaped quote in an unquoted field/
    )
    expect(() => parseBulkEntries("csv", content)).toThrowError(
      expect.objectContaining({ status: 400, code: "validation" })
    )
  })

  it("parses an authored gradeDescriptions JSON object cell from CSV and trims values", () => {
    const content = csvContent([
      {
        kind: "skills",
        stableId: "a",
        name: "A",
        config: '{"track":"race","effects":[],"rarity":"Common"}',
        gradeDescriptions: '{"G":"  hello  ","S":"world"}',
      },
    ])
    const entries = parseBulkEntries("csv", content)
    expect(entries[0].gradeDescriptions).toEqual({ G: "hello", S: "world" })
  })

  it("defaults a CSV row without a gradeDescriptions cell to an empty map (legacy rows)", () => {
    const content = csvContent([
      {
        kind: "skills",
        stableId: "a",
        name: "A",
        config: '{"track":"race","effects":[],"rarity":"Common"}',
      },
    ])
    const entries = parseBulkEntries("csv", content)
    expect(entries[0].gradeDescriptions).toEqual({})
  })

  it("rejects a CSV row with a malformed gradeDescriptions JSON cell", () => {
    const content = csvContent([
      {
        kind: "skills",
        stableId: "a",
        name: "A",
        config: '{"track":"race","effects":[],"rarity":"Common"}',
        gradeDescriptions: "{not json",
      },
    ])
    expect(() => parseBulkEntries("csv", content)).toThrowError(
      /Bulk CSV row 2: gradeDescriptions must be valid JSON/
    )
  })

  it("rejects a CSV row whose gradeDescriptions cell is a non-object JSON value", () => {
    const content = csvContent([
      {
        kind: "skills",
        stableId: "a",
        name: "A",
        config: '{"track":"race","effects":[],"rarity":"Common"}',
        gradeDescriptions: "42",
      },
    ])
    expect(() => parseBulkEntries("csv", content)).toThrowError(
      /Bulk CSV row 2: gradeDescriptions must be a JSON object/
    )
  })
})

// ------------------------------------------------------------------ //
// Preview / apply against the mocked database
// ------------------------------------------------------------------ //

describe("bulk catalog import preview/apply (unit, mocked db)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  it("preview computes statuses against the DB and writes nothing", async () => {
    const entries = parseBulkEntries(
      "json",
      jsonContent([skill("skills", "a"), skill("skills", "b")])
    )
    const digest = computeBulkRequestDigest("json", jsonContent([{}]))
    const result = await previewBulkImport(entries, digest)
    expect(result.source).toBe("bulk")
    expect(result.previewDigest).toBe(digest)
    expect(result.createCount).toBe(2)
    expect(result.skipCount).toBe(0)
    expect(result.entries.every((e) => e.status === "create")).toBe(true)
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("apply creates missing rows with an unarchived flag", async () => {
    const entries = parseBulkEntries(
      "json",
      jsonContent([skill("skills", "a")])
    )
    const result = await applyBulkImport(entries, "digest")
    expect(result.source).toBe("bulk")
    expect(result.createCount).toBe(1)
    expect(result.createdIds).toHaveLength(1)
    expect(dbMock.store.catalog.size).toBe(1)
    const row = [...dbMock.store.catalog.values()][0]
    expect(row.archived).toBe(false)
    expect(row.config).toEqual({ track: "race", effects: [], rarity: "Common" })
  })

  it("skips an existing row and reports its actual metadata without overwriting it", async () => {
    dbMock.store.addCatalog({
      id: "existing-1",
      kind: "skills",
      stableId: "a",
      name: "Old Name",
      config: { houseNote: true, effects: [] },

      sourceUrl: "https://house.example/old",
      archived: true,
    })
    const entries = parseBulkEntries(
      "json",
      jsonContent([{ ...skill("skills", "a"), name: "New Name" }])
    )
    const preview = await previewBulkImport(entries, "digest")
    expect(preview.createCount).toBe(0)
    expect(preview.skipCount).toBe(1)
    const skipped = preview.entries[0]
    expect(skipped.name).toBe("New Name")
    expect(skipped.status).toBe("skip_existing")
    expect(skipped.existing).toEqual({
      id: "existing-1",
      name: "Old Name",
      sourceUrl: "https://house.example/old",

      archived: true,
    })

    const result = await applyBulkImport(entries, "digest")
    expect(result.createCount).toBe(0)
    expect(result.skipCount).toBe(1)
    expect(result.createdIds).toHaveLength(0)
    const row = dbMock.store.catalog.get("existing-1")!
    expect(row.name).toBe("Old Name")
    expect(row.archived).toBe(true)
  })

  it("is idempotent: an identical repeated apply skips every existing row", async () => {
    const entries = parseBulkEntries(
      "json",
      jsonContent([skill("skills", "a"), skill("skills", "b")])
    )
    const first = await applyBulkImport(entries, "digest")
    expect(first.createCount).toBe(2)
    const second = await applyBulkImport(entries, "digest")
    expect(second.createCount).toBe(0)
    expect(second.skipCount).toBe(2)
    expect(second.createdIds).toHaveLength(0)
    expect(dbMock.store.catalog.size).toBe(2)
  })

  it("applies a gods entry and preserves its blessingEffects config", async () => {
    const godEntry = {
      ...god("odin"),
      config: { blessingEffects: { True: [], Minor: [] } },
    }
    const entries = parseBulkEntries("json", jsonContent([godEntry]))
    const result = await applyBulkImport(entries, "digest")
    expect(result.createCount).toBe(1)
    expect(result.createdIds).toHaveLength(1)
    const godRow = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "odin"
    )!
    expect(godRow.kind).toBe("gods")
    expect(godRow.config).toEqual({ blessingEffects: { True: [], Minor: [] } })
  })

  it("creates gods and non-god entries in any row order (no patron resolution)", async () => {
    // Order is irrelevant now that blessings live on character associations, not as
    // a patron FK; both rows exist and are created independently.
    const entries = parseBulkEntries(
      "json",
      jsonContent([god("odin"), skill("skills", "a")])
    )
    const result = await applyBulkImport(entries, "digest")
    expect(result.createCount).toBe(2)
    const ids = [...dbMock.store.catalog.values()].map((r) => r.stableId)
    expect(ids).toContain("odin")
    expect(ids).toContain("a")
  })

  it("maps a P2034 serialization conflict to 409 without partial writes", async () => {
    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce({
      name: "PrismaClientKnownRequestError",
      code: "P2034",
    })
    try {
      const entries = parseBulkEntries(
        "json",
        jsonContent([skill("skills", "a")])
      )
      await expect(applyBulkImport(entries, "digest")).rejects.toMatchObject({
        status: 409,
        code: "catalog_serialization_conflict",
      })
    } finally {
      spy.mockRestore()
    }
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("maps a P2002 unique conflict to 409 without partial writes", async () => {
    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce({
      name: "PrismaClientKnownRequestError",
      code: "P2002",
    })
    try {
      const entries = parseBulkEntries(
        "json",
        jsonContent([skill("skills", "a")])
      )
      await expect(applyBulkImport(entries, "digest")).rejects.toMatchObject({
        status: 409,
        code: "catalog_stable_id_conflict",
      })
    } finally {
      spy.mockRestore()
    }
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("writes nothing when a later entry carries an unknown top-level field", () => {
    // Row 1 is valid, but row 2 has an unsupported `archived` key. Validation is
    // all-or-nothing, so the valid row is not partially applied and the catalog
    // stays untouched.
    const entries = [
      skill("skills", "a"),
      { ...skill("skills", "b"), archived: true },
    ]
    expect(() => parseBulkEntries("json", jsonContent(entries))).toThrowError(
      /Bulk row 2: unknown field "archived"/
    )
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("apply persists an authored gradeDescriptions map for a created row", async () => {
    const entries = parseBulkEntries(
      "json",
      jsonContent([
        {
          ...skill("skills", "gd-skill"),
          gradeDescriptions: { G: "A grade G blurb" },
        },
      ])
    )
    await applyBulkImport(entries, "digest")
    const row = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "gd-skill"
    )!
    expect(row.gradeDescriptions).toEqual({ G: "A grade G blurb" })
  })

  it("apply stores an empty map for a created row that omitted gradeDescriptions", async () => {
    const entries = parseBulkEntries(
      "json",
      jsonContent([skill("skills", "plain-skill")])
    )
    await applyBulkImport(entries, "digest")
    const row = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "plain-skill"
    )!
    expect(row.gradeDescriptions).toEqual({})
  })

  it("apply persists gradeDescriptions from a CSV upload", async () => {
    const content = csvContent([
      {
        kind: "skills",
        stableId: "csv-gd",
        name: "Csv Gd",
        config: '{"track":"race","effects":[],"rarity":"Common"}',
        gradeDescriptions: '{"B":"A B-grade blurb"}',
      },
    ])
    const entries = parseBulkEntries("csv", content)
    await applyBulkImport(entries, "digest")
    const row = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "csv-gd"
    )!
    expect(row.gradeDescriptions).toEqual({ B: "A B-grade blurb" })
  })

  it("accepts an equipment entry whose required god exists unarchived already", async () => {
    dbMock.store.addCatalog({
      id: "god-viper",
      kind: "gods",
      stableId: "the-malefic-viper",
      name: "The Malefic Viper",
      config: { blessingEffects: {} },
      archived: false,
    })
    const entries = parseBulkEntries(
      "json",
      jsonContent([
        equipment("viper-ring", { requiredGodStableId: "the-malefic-viper" }),
      ])
    )
    const preview = await previewBulkImport(entries, "digest")
    expect(preview.createCount).toBe(1)
    expect(preview.entries[0].status).toBe("create")
    const applied = await applyBulkImport(entries, "digest")
    expect(applied.createCount).toBe(1)
    expect(applied.createdIds).toHaveLength(1)
    const ring = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "viper-ring"
    )!
    expect(ring.config).toMatchObject({
      requiredGodStableId: "the-malefic-viper",
    })
  })

  it("rejects an equipment entry with a dangling god reference and writes nothing", async () => {
    const entries = parseBulkEntries(
      "json",
      jsonContent([
        equipment("dangling-ring", { requiredGodStableId: "no-such-god" }),
      ])
    )
    await expect(previewBulkImport(entries, "digest")).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    await expect(applyBulkImport(entries, "digest")).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("rejects an equipment entry whose required god is archived", async () => {
    dbMock.store.addCatalog({
      id: "archived-god",
      kind: "gods",
      stableId: "a-sleeping-god",
      name: "A Sleeping God",
      config: { blessingEffects: {} },
      archived: true,
    })
    const entries = parseBulkEntries(
      "json",
      jsonContent([
        equipment("sleeping-god-ring", {
          requiredGodStableId: "a-sleeping-god",
        }),
      ])
    )
    await expect(previewBulkImport(entries, "digest")).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    await expect(applyBulkImport(entries, "digest")).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    // The pre-existing archived god is left untouched.
    expect(dbMock.store.catalog.size).toBe(1)
  })

  it("accepts an equipment entry whose required god is created by the same upload", async () => {
    const entries = parseBulkEntries(
      "json",
      jsonContent([
        god("manifest-god"),
        equipment("manifest-god-ring", {
          requiredGodStableId: "manifest-god",
        }),
      ])
    )
    const preview = await previewBulkImport(entries, "digest")
    expect(preview.createCount).toBe(2)
    expect(preview.skipCount).toBe(0)
    const applied = await applyBulkImport(entries, "digest")
    expect(applied.createCount).toBe(2)
    expect(applied.skipCount).toBe(0)
    const ring = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "manifest-god-ring"
    )!
    expect(ring.config).toMatchObject({ requiredGodStableId: "manifest-god" })
    const patron = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "manifest-god"
    )!
    expect(patron.archived).toBe(false)
  })

  it("rejects an equipment ref to a god that is archived even when the upload also lists that god (the upload god entry is skipped)", async () => {
    // A god row already exists archived, AND the upload also lists that same god.
    // Because existing rows are never overwritten, the upload god entry is
    // skipped (status skip_existing), so the god stays archived. The import must
    // NOT treat the merely-included upload god as unarchived, so an equipment
    // entry requiring it is rejected in BOTH preview and apply, with no write.
    dbMock.store.addCatalog({
      id: "dual-god",
      kind: "gods",
      stableId: "dual-god",
      name: "Dual God",
      config: { blessingEffects: {} },
      archived: true,
    })
    const entries = parseBulkEntries(
      "json",
      jsonContent([
        god("dual-god"),
        equipment("dual-god-relic", { requiredGodStableId: "dual-god" }),
      ])
    )
    await expect(previewBulkImport(entries, "digest")).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    await expect(applyBulkImport(entries, "digest")).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    // The pre-existing archived god is left untouched; nothing else was written.
    expect(dbMock.store.catalog.size).toBe(1)
    const row = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "dual-god"
    )!
    expect(row.archived).toBe(true)
  })

  it("apply rechecks the god ref inside the transaction and rejects when a god is archived concurrently after a passing preview", async () => {
    dbMock.store.addCatalog({
      id: "god-ok",
      kind: "gods",
      stableId: "god-ok",
      name: "God Ok",
      config: { blessingEffects: {} },
      archived: false,
    })
    const entries = parseBulkEntries(
      "json",
      jsonContent([
        equipment("ok-ring", { requiredGodStableId: "god-ok" }),
        skill("skills", "ok-skill"),
      ])
    )
    // Preview reads the god as active and would create both rows.
    const preview = await previewBulkImport(entries, "digest")
    expect(preview.createCount).toBe(2)

    // A concurrent write archives the god between preview and apply, so the
    // apply SERIALIZABLE transaction re-reads the god's archived state and must
    // reject rather than trust the stale preview result.
    dbMock.store.catalog.get("god-ok")!.archived = true
    await expect(applyBulkImport(entries, "digest")).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    // Nothing was written: neither the equipment nor the skill row, and the god
    // itself was never touched by apply (it pre-existed and is not overwritten).
    expect(dbMock.store.catalog.size).toBe(1)
    expect(dbMock.store.catalog.get("god-ok")!.archived).toBe(true)
  })

  it("writes nothing when a valid row precedes an equipment entry with a dangling god reference", async () => {
    const entries = parseBulkEntries(
      "json",
      jsonContent([
        skill("skills", "valid-skill"),
        equipment("bad-ring", { requiredGodStableId: "no-such-god" }),
      ])
    )
    await expect(applyBulkImport(entries, "digest")).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("accepts an equipment entry that grants an existing unarchived skill", async () => {
    dbMock.store.addCatalog({
      id: "existing-skill",
      kind: "skills",
      stableId: "existing-skill",
      name: "Existing Skill",
      config: { effects: [], rarity: "Common" },
      archived: false,
    })
    const entries = parseBulkEntries(
      "json",
      jsonContent([
        equipment("existing-skill-ring", {
          grantedSkillStableIds: ["existing-skill"],
        }),
      ])
    )
    const preview = await previewBulkImport(entries, "digest")
    expect(preview.createCount).toBe(1)
    expect(preview.entries[0].status).toBe("create")
    const applied = await applyBulkImport(entries, "digest")
    expect(applied.createCount).toBe(1)
    expect(applied.createdIds).toHaveLength(1)
    const ring = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "existing-skill-ring"
    )!
    expect(ring.config).toMatchObject({
      grantedSkillStableIds: ["existing-skill"],
    })
  })

  it("rejects an equipment entry that grants a missing skill and writes nothing", async () => {
    const entries = parseBulkEntries(
      "json",
      jsonContent([
        equipment("missing-skill-ring", {
          grantedSkillStableIds: ["no-such-skill"],
        }),
      ])
    )
    await expect(previewBulkImport(entries, "digest")).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    await expect(applyBulkImport(entries, "digest")).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("rejects an equipment entry that grants an archived skill and writes nothing", async () => {
    dbMock.store.addCatalog({
      id: "archived-skill",
      kind: "skills",
      stableId: "archived-skill",
      name: "Archived Skill",
      config: { effects: [], rarity: "Common" },
      archived: true,
    })
    const entries = parseBulkEntries(
      "json",
      jsonContent([
        equipment("archived-skill-ring", {
          grantedSkillStableIds: ["archived-skill"],
        }),
      ])
    )
    await expect(previewBulkImport(entries, "digest")).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    await expect(applyBulkImport(entries, "digest")).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    // The pre-existing archived skill is left untouched.
    expect(dbMock.store.catalog.size).toBe(1)
  })

  it("accepts an equipment entry that grants a skill created by the same upload", async () => {
    const entries = parseBulkEntries(
      "json",
      jsonContent([
        skill("skills", "manifest-skill"),
        equipment("manifest-skill-ring", {
          grantedSkillStableIds: ["manifest-skill"],
        }),
      ])
    )
    const preview = await previewBulkImport(entries, "digest")
    expect(preview.createCount).toBe(2)
    expect(preview.skipCount).toBe(0)
    const applied = await applyBulkImport(entries, "digest")
    expect(applied.createCount).toBe(2)
    expect(applied.skipCount).toBe(0)
    const ring = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "manifest-skill-ring"
    )!
    expect(ring.config).toMatchObject({
      grantedSkillStableIds: ["manifest-skill"],
    })
    const skillRow = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "manifest-skill"
    )!
    expect(skillRow.archived).toBe(false)
  })

  it("accepts a title that grants an existing unarchived skill", async () => {
    dbMock.store.addCatalog({
      id: "existing-skill",
      kind: "skills",
      stableId: "existing-skill",
      name: "Existing Skill",
      config: { effects: [], rarity: "Common" },
      archived: false,
    })
    const entries = parseBulkEntries(
      "json",
      jsonContent([
        titleRow("title-grant", {
          flat: { strength: 10 },
          grantedSkillStableIds: ["existing-skill"],
        }),
      ])
    )
    const preview = await previewBulkImport(entries, "digest")
    expect(preview.createCount).toBe(1)
    expect(preview.entries[0].status).toBe("create")
    const applied = await applyBulkImport(entries, "digest")
    expect(applied.createCount).toBe(1)
    expect(applied.createdIds).toHaveLength(1)
    const title = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "title-grant"
    )!
    expect(title.config).toMatchObject({
      grantedSkillStableIds: ["existing-skill"],
    })
  })

  it("accepts a title that grants no skills (empty grantedSkillStableIds list)", async () => {
    const entries = parseBulkEntries(
      "json",
      jsonContent([
        titleRow("empty-grant-title", { grantedSkillStableIds: [] }),
      ])
    )
    const applied = await applyBulkImport(entries, "digest")
    expect(applied.createCount).toBe(1)
    expect(applied.skipCount).toBe(0)
    const title = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "empty-grant-title"
    )!
    expect(title.config).toMatchObject({ grantedSkillStableIds: [] })
  })

  it("accepts a title that grants a skill created by the same upload", async () => {
    const entries = parseBulkEntries(
      "json",
      jsonContent([
        skill("skills", "manifest-skill"),
        titleRow("title-grant", {
          grantedSkillStableIds: ["manifest-skill"],
        }),
      ])
    )
    const preview = await previewBulkImport(entries, "digest")
    expect(preview.createCount).toBe(2)
    expect(preview.skipCount).toBe(0)
    const applied = await applyBulkImport(entries, "digest")
    expect(applied.createCount).toBe(2)
    expect(applied.skipCount).toBe(0)
    const title = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "title-grant"
    )!
    expect(title.config).toMatchObject({
      grantedSkillStableIds: ["manifest-skill"],
    })
    const skillRow = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "manifest-skill"
    )!
    expect(skillRow.archived).toBe(false)
  })

  it("rejects a title that grants a missing skill and writes nothing", async () => {
    const entries = parseBulkEntries(
      "json",
      jsonContent([
        titleRow("missing-skill-title", {
          grantedSkillStableIds: ["no-such-skill"],
        }),
      ])
    )
    await expect(previewBulkImport(entries, "digest")).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    await expect(applyBulkImport(entries, "digest")).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("rejects a title that grants an archived skill and writes nothing", async () => {
    dbMock.store.addCatalog({
      id: "archived-skill",
      kind: "skills",
      stableId: "archived-skill",
      name: "Archived Skill",
      config: { effects: [], rarity: "Common" },
      archived: true,
    })
    const entries = parseBulkEntries(
      "json",
      jsonContent([
        titleRow("archived-skill-title", {
          grantedSkillStableIds: ["archived-skill"],
        }),
      ])
    )
    await expect(previewBulkImport(entries, "digest")).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    await expect(applyBulkImport(entries, "digest")).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    // The pre-existing archived skill is left untouched.
    expect(dbMock.store.catalog.size).toBe(1)
  })

  it("skips an already-existing title whose granted skill was archived rather than rejecting the reference", async () => {
    dbMock.store.addCatalog({
      id: "existing-title",
      kind: "titles",
      stableId: "existing-title",
      name: "Existing Title",
      config: { grantedSkillStableIds: ["arch-skill"] },
      archived: false,
    })
    dbMock.store.addCatalog({
      id: "arch-skill",
      kind: "skills",
      stableId: "arch-skill",
      name: "Archived Skill",
      config: { effects: [], rarity: "Common" },
      archived: true,
    })
    const entries = parseBulkEntries(
      "json",
      jsonContent([
        titleRow("existing-title", {
          grantedSkillStableIds: ["arch-skill"],
        }),
      ])
    )
    const preview = await previewBulkImport(entries, "digest")
    expect(preview.createCount).toBe(0)
    expect(preview.skipCount).toBe(1)
    expect(preview.entries[0].status).toBe("skip_existing")
    const applied = await applyBulkImport(entries, "digest")
    expect(applied.createCount).toBe(0)
    expect(applied.skipCount).toBe(1)
    expect(applied.createdIds).toHaveLength(0)
    expect(dbMock.store.catalog.size).toBe(2)
    const titleRowStored = dbMock.store.catalog.get("existing-title")!
    expect(titleRowStored.archived).toBe(false)
    expect(titleRowStored.config).toMatchObject({
      grantedSkillStableIds: ["arch-skill"],
    })
  })

  it("writes nothing when a valid row precedes an equipment entry with a dangling skill grant", async () => {
    const entries = parseBulkEntries(
      "json",
      jsonContent([
        skill("skills", "valid-skill"),
        equipment("bad-ring", { grantedSkillStableIds: ["no-such-skill"] }),
      ])
    )
    await expect(applyBulkImport(entries, "digest")).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("rejects a race/class/profession row that grants a missing grade skill", async () => {
    const entries = parseBulkEntries(
      "json",
      jsonContent([
        race("race-g", {
          gradeGrantedSkillStableIds: { F: ["no-such-skill"] },
        }),
      ])
    )
    await expect(previewBulkImport(entries, "digest")).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    await expect(applyBulkImport(entries, "digest")).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("rejects a race/class/profession row that grants an archived grade skill", async () => {
    dbMock.store.addCatalog({
      id: "arch-skill",
      kind: "skills",
      stableId: "arch-skill",
      name: "Archived Skill",
      config: { effects: [], rarity: "Common" },
      archived: true,
    })
    const entries = parseBulkEntries(
      "json",
      jsonContent([
        classRow("cls-g", {
          gradeGrantedSkillStableIds: { F: ["arch-skill"] },
        }),
      ])
    )
    await expect(previewBulkImport(entries, "digest")).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    await expect(applyBulkImport(entries, "digest")).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    expect(dbMock.store.catalog.size).toBe(1)
  })

  it("rejects a grade-grant to a skill the upload also lists when the catalog skill is archived", async () => {
    dbMock.store.addCatalog({
      id: "dual-skill",
      kind: "skills",
      stableId: "dual-skill",
      name: "Dual Skill",
      config: { effects: [], rarity: "Common" },
      archived: true,
    })
    const entries = parseBulkEntries(
      "json",
      jsonContent([
        skill("skills", "dual-skill"),
        race("race-g", { gradeGrantedSkillStableIds: { F: ["dual-skill"] } }),
      ])
    )
    await expect(previewBulkImport(entries, "digest")).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    await expect(applyBulkImport(entries, "digest")).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    const row = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "dual-skill"
    )!
    expect(row.archived).toBe(true)
  })

  it("accepts a race/class/profession row that grants a grade skill created by the same upload", async () => {
    const entries = parseBulkEntries(
      "json",
      jsonContent([
        skill("skills", "manifest-skill"),
        race("race-g", {
          gradeGrantedSkillStableIds: { F: ["manifest-skill"] },
        }),
        classRow("cls-g", {
          gradeGrantedSkillStableIds: { F: ["manifest-skill"] },
        }),
        professionRow("prof-g", {
          gradeGrantedSkillStableIds: { F: ["manifest-skill"] },
        }),
      ])
    )
    const result = await applyBulkImport(entries, "digest")
    expect(result.createCount).toBe(4)
    expect(result.skipCount).toBe(0)
    const raceRow = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "race-g"
    )!
    expect(raceRow.config).toMatchObject({
      gradeGrantedSkillStableIds: { F: ["manifest-skill"] },
    })
  })

  it("accepts a race/class/profession row that grants an existing unarchived grade skill", async () => {
    dbMock.store.addCatalog({
      id: "existing-skill",
      kind: "skills",
      stableId: "existing-skill",
      name: "Existing Skill",
      config: { effects: [], rarity: "Common" },
      archived: false,
    })
    const entries = parseBulkEntries(
      "json",
      jsonContent([
        professionRow("prof-g", {
          gradeGrantedSkillStableIds: { F: ["existing-skill"] },
        }),
      ])
    )
    const result = await applyBulkImport(entries, "digest")
    expect(result.createCount).toBe(1)
    expect(result.skipCount).toBe(0)
    const profRow = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "prof-g"
    )!
    expect(profRow.config).toMatchObject({
      gradeGrantedSkillStableIds: { F: ["existing-skill"] },
    })
  })

  it("skips an already-existing race whose grade-granted skill was archived rather than rejecting the reference", async () => {
    dbMock.store.addCatalog({
      id: "existing-race",
      kind: "races",
      stableId: "existing-race",
      name: "Existing Race",
      config: {
        raceType: "enlightened",
        naturalGrade: "F",
        gradeGrantedSkillStableIds: { F: ["arch-skill"] },
      },
      archived: false,
    })
    dbMock.store.addCatalog({
      id: "arch-skill",
      kind: "skills",
      stableId: "arch-skill",
      name: "Archived Skill",
      config: { effects: [], rarity: "Common" },
      archived: true,
    })
    const entries = parseBulkEntries(
      "json",
      jsonContent([
        race("existing-race", {
          gradeGrantedSkillStableIds: { F: ["arch-skill"] },
        }),
      ])
    )
    const preview = await previewBulkImport(entries, "digest")
    expect(preview.createCount).toBe(0)
    expect(preview.skipCount).toBe(1)
    expect(preview.entries[0].status).toBe("skip_existing")
    const applied = await applyBulkImport(entries, "digest")
    expect(applied.createCount).toBe(0)
    expect(applied.skipCount).toBe(1)
    expect(applied.createdIds).toHaveLength(0)
    expect(dbMock.store.catalog.size).toBe(2)
    const raceRow = dbMock.store.catalog.get("existing-race")!
    expect(raceRow.archived).toBe(false)
    expect(raceRow.config).toMatchObject({
      gradeGrantedSkillStableIds: { F: ["arch-skill"] },
    })
  })

  it("skips an already-existing equipment row whose granted skill was archived rather than rejecting the reference", async () => {
    dbMock.store.addCatalog({
      id: "existing-ring",
      kind: "equipment",
      stableId: "existing-ring",
      name: "Existing Ring",
      config: {
        slot: "Ring",
        rarity: "Common",
        grantedSkillStableIds: ["arch-skill"],
      },
      archived: false,
    })
    dbMock.store.addCatalog({
      id: "arch-skill",
      kind: "skills",
      stableId: "arch-skill",
      name: "Archived Skill",
      config: { effects: [], rarity: "Common" },
      archived: true,
    })
    const entries = parseBulkEntries(
      "json",
      jsonContent([
        equipment("existing-ring", { grantedSkillStableIds: ["arch-skill"] }),
      ])
    )
    const preview = await previewBulkImport(entries, "digest")
    expect(preview.createCount).toBe(0)
    expect(preview.skipCount).toBe(1)
    const applied = await applyBulkImport(entries, "digest")
    expect(applied.createCount).toBe(0)
    expect(applied.skipCount).toBe(1)
    expect(applied.createdIds).toHaveLength(0)
    expect(dbMock.store.catalog.size).toBe(2)
  })

  it("skips an already-existing equipment row whose patron god was archived rather than rejecting the reference", async () => {
    dbMock.store.addCatalog({
      id: "existing-ring",
      kind: "equipment",
      stableId: "existing-ring",
      name: "Existing Ring",
      config: {
        slot: "Ring",
        rarity: "Common",
        requiredGodStableId: "arch-god",
      },
      archived: false,
    })
    dbMock.store.addCatalog({
      id: "arch-god",
      kind: "gods",
      stableId: "arch-god",
      name: "Archived God",
      config: { blessingEffects: {} },
      archived: true,
    })
    const entries = parseBulkEntries(
      "json",
      jsonContent([
        equipment("existing-ring", { requiredGodStableId: "arch-god" }),
      ])
    )
    const preview = await previewBulkImport(entries, "digest")
    expect(preview.createCount).toBe(0)
    expect(preview.skipCount).toBe(1)
    const applied = await applyBulkImport(entries, "digest")
    expect(applied.createCount).toBe(0)
    expect(applied.skipCount).toBe(1)
    expect(applied.createdIds).toHaveLength(0)
    expect(dbMock.store.catalog.size).toBe(2)
  })

  it("rejects a skills row that omits a track (parse-time, no write)", async () => {
    const bad = skill("skills", "untracked", {
      config: { effects: [], rarity: "Common" },
    })
    expect(() => parseBulkEntries("json", jsonContent([bad]))).toThrowError(
      expect.objectContaining({ status: 400, code: "invalid_config" })
    )
    expect(() => parseBulkEntries("json", jsonContent([bad]))).toThrowError(
      /Bulk row 1: .*"track"/i
    )
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("rejects a skills row carrying an invalid track value (parse-time, no write)", async () => {
    const bad = skill("skills", "bad-track", {
      config: { track: "Class", effects: [], rarity: "Common" },
    })
    expect(() => parseBulkEntries("json", jsonContent([bad]))).toThrowError(
      expect.objectContaining({ status: 400, code: "invalid_config" })
    )
    expect(() => parseBulkEntries("json", jsonContent([bad]))).toThrowError(
      /Bulk row 1: .*"track"/i
    )
    expect(dbMock.store.catalog.size).toBe(0)
  })
})
