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
    config: { effects: [], rarity: "Common" },
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

function blessing(
  stableId: string,
  patronGodStableId?: string,
  extra: Record<string, unknown> = {}
) {
  return {
    kind: "blessings",
    stableId,
    name: `Blessing ${stableId}`,
    description: `A blessing named ${stableId}`,
    provenance: "house",
    sourceUrl: "https://example.com/bless/" + stableId,
    config: {
      tier: "Minor",
      effects: [],
      ...(patronGodStableId ? { patronGodStableId } : {}),
    },
    ...extra,
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

  it("rejects a legacy blessing config missing tier/effects", () => {
    const bad = {
      ...blessing("legacy-bless"),
      config: { grade: "F", effect: {} },
    }
    expect(() => parseBulkEntries("json", jsonContent([bad]))).toThrowError(
      expect.objectContaining({ status: 400, code: "invalid_config" })
    )
  })

  it("reports the row number for a modern-config failure", () => {
    const bad = {
      ...blessing("legacy-bless"),
      config: { grade: "F", effect: {} },
    }
    expect(() => parseBulkEntries("json", jsonContent([bad]))).toThrowError(
      /Bulk row 1: Blessing config is missing required "tier" and "effects" fields/
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
          config: '{"effects":[],"rarity":"Common"}',
        },
        {
          kind: "skills",
          stableId: "b",
          name: "B",
          config: '{"effects":[],"rarity":"Common"}',
        },
      ],
      { bom: true, crlf: true }
    )
    const entries = parseBulkEntries("csv", content)
    expect(entries).toHaveLength(2)
    // Header is line 1, first data row is line 2.
    expect(entries[0].row).toBe(2)
    expect(entries[1].row).toBe(3)
    expect(entries[0].config).toEqual({ effects: [], rarity: "Common" })
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
      'kind,stableId,name,config\r\nskills,s,"He said ""hi""","{""effects"":[],""rarity"":""Common""}"\r\n'
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
    expect(row.config).toEqual({ effects: [], rarity: "Common" })
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

  it("inserts gods first, so a blessing may name a god created later in the upload", async () => {
    // Blessing references the god BEFORE the god appears in the upload.
    const entries = parseBulkEntries(
      "json",
      jsonContent([blessing("bless-one", "odin"), god("odin")])
    )
    const result = await applyBulkImport(entries, "digest")
    expect(result.createCount).toBe(2)
    expect(result.createdIds).toHaveLength(2)
    const blessingRow = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "bless-one"
    )!
    const godRow = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "odin"
    )!
    expect(blessingRow.patronId).toBe(godRow.id)
  })

  it("rolls back the whole import when a would-create blessing names a missing god", async () => {
    const entries = parseBulkEntries(
      "json",
      jsonContent([skill("skills", "pre"), blessing("ghost", "no-such-god")])
    )
    await expect(previewBulkImport(entries, "digest")).rejects.toMatchObject({
      status: 400,
      code: "patron_god_not_found",
    })
    await expect(applyBulkImport(entries, "digest")).rejects.toMatchObject({
      status: 400,
      code: "patron_god_not_found",
    })
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("rejects a would-create blessing whose patron god exists but is archived", async () => {
    dbMock.store.addCatalog({
      id: "archived-god",
      kind: "gods",
      stableId: "odin",
      name: "Odin",
      config: {},

      archived: true,
    })
    const entries = parseBulkEntries(
      "json",
      jsonContent([blessing("bless-one", "odin")])
    )
    await expect(previewBulkImport(entries, "digest")).rejects.toMatchObject({
      status: 400,
      code: "patron_god_archived",
    })
    await expect(applyBulkImport(entries, "digest")).rejects.toMatchObject({
      status: 400,
      code: "patron_god_archived",
    })
    expect(dbMock.store.catalog.size).toBe(1)
  })

  it("allows a would-create blessing whose patron is an existing unarchived god", async () => {
    dbMock.store.addCatalog({
      id: "live-god",
      kind: "gods",
      stableId: "odin",
      name: "Odin",
      config: {},

      archived: false,
    })
    const entries = parseBulkEntries(
      "json",
      jsonContent([blessing("bless-one", "odin")])
    )
    const result = await applyBulkImport(entries, "digest")
    expect(result.createCount).toBe(1)
    const blessingRow = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "bless-one"
    )!
    expect(blessingRow.patronId).toBe("live-god")
  })

  it("does not revalidate a skip-existing blessing's patron", async () => {
    // The blessing already exists, so its (missing) patron is not re-checked.
    dbMock.store.addCatalog({
      id: "bless-existing",
      kind: "blessings",
      stableId: "bless-one",
      name: "Existing Blessing",
      config: { tier: "Minor", effects: [], patronGodStableId: "no-such-god" },

      archived: false,
    })
    const entries = parseBulkEntries(
      "json",
      jsonContent([blessing("bless-one", "no-such-god")])
    )
    const result = await applyBulkImport(entries, "digest")
    expect(result.createCount).toBe(0)
    expect(result.skipCount).toBe(1)
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
})
