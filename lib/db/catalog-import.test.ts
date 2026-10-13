import { beforeEach, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/db/client"
import {
  applyWikiReviewedImport,
  previewWikiReviewedImport,
  type WikiReviewedEntry,
} from "@/lib/db/catalog-import"
import { WIKI_REVIEWED_ENTRIES } from "@/prisma/catalog/wiki-reviewed"

// Real unit tests against the in-memory Prisma mock. The mock backs the
// `@/lib/db/client` export so the importer's Prisma calls are exercised without a
// running Postgres. The production manifest is fixed; edge-case manifests (invalid
// duplicate, legacy config, patron failure) are injected into the pure functions
// only, exactly as the spec requires.
type TestStore = import("./testPrisma").TestPrismaInstance["store"]
const dbMock = vi.hoisted(() => ({ store: undefined as unknown as TestStore }))

vi.mock("@/lib/db/client", async () => {
  const { createTestPrisma } = await import("./testPrisma")
  const instance = createTestPrisma()
  dbMock.store = instance.store
  return { prisma: instance.prisma, default: instance.prisma }
})

function skillEntry(stableId: string, name = stableId): WikiReviewedEntry {
  return {
    kind: "skills",
    stableId,
    name,
    description: `Description for ${name}`,
    provenance: "inferred",
    sourceUrl: `https://example.com/${stableId}`,
    config: { effects: [] },
  }
}

describe("catalog import (unit, mocked db)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  it("preview computes statuses against the DB and writes nothing", async () => {
    const result = await previewWikiReviewedImport(WIKI_REVIEWED_ENTRIES)
    expect(result.source).toBe("wiki-reviewed")
    expect(result.createCount).toBe(6)
    expect(result.skipCount).toBe(0)
    expect(result.entries).toHaveLength(6)
    expect(result.entries.every((e) => e.status === "create")).toBe(true)
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("apply creates all six curated entries with inferred provenance and archived=false", async () => {
    const result = await applyWikiReviewedImport(WIKI_REVIEWED_ENTRIES)
    expect(result.source).toBe("wiki-reviewed")
    expect(result.createCount).toBe(6)
    expect(result.skipCount).toBe(0)
    expect(result.createdIds).toHaveLength(6)
    expect(dbMock.store.catalog.size).toBe(6)
    for (const row of dbMock.store.catalog.values()) {
      expect(row.provenance).toBe("inferred")
      expect(row.archived).toBe(false)
    }
    // Spot-check the kind-specific configs that must round-trip exactly.
    const alchemist = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "alchemist-of-the-malefic-viper"
    )!
    expect(alchemist.kind).toBe("professions")
    expect(alchemist.grade).toBe("F")
    expect(alchemist.config).toMatchObject({
      grades: {
        F: {
          fixed: { vitality: 2, wisdom: 2, willpower: 1, toughness: 1 },
          free: 2,
        },
      },
    })
    const blessing = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "true-blessing-malefic-viper"
    )!
    expect(blessing.kind).toBe("blessings")
    expect(blessing.config).toMatchObject({ tier: "True", effects: [] })
    const bloodline = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "bloodline-primal-hunter"
    )!
    expect(bloodline.kind).toBe("bloodlines")
    expect(bloodline.config).toMatchObject({ effects: [], gradeEffects: {} })
    const title = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "legendary-prodigy"
    )!
    expect(title.kind).toBe("titles")
    expect(title.config).toMatchObject({
      flat: { strength: 10, agility: 10 },
      percentBasisPoints: { strength: 1000, agility: 1000 },
    })
  })

  it("reapplying the identical manifest skips every existing row", async () => {
    await applyWikiReviewedImport(WIKI_REVIEWED_ENTRIES)
    const before = dbMock.store.catalog.size
    const result = await applyWikiReviewedImport(WIKI_REVIEWED_ENTRIES)
    expect(result.createCount).toBe(0)
    expect(result.skipCount).toBe(6)
    expect(result.createdIds).toHaveLength(0)
    // Every skipped entry reports the ACTUAL existing row (the rows created by
    // the first apply, all inferred), not the manifest's proposed values.
    const skipped = result.entries.filter((e) => e.status === "skip_existing")
    expect(skipped).toHaveLength(6)
    for (const entry of skipped) {
      expect(entry.existing).toBeDefined()
      expect(entry.existing?.provenance).toBe("inferred")
      expect(entry.existing?.archived).toBe(false)
      expect(entry.existing?.id).toBeTruthy()
    }
    expect(dbMock.store.catalog.size).toBe(before)
  })

  it("leaves an existing house row with a conflicting stableId unchanged and reports its actual metadata", async () => {
    dbMock.store.addCatalog({
      id: "house-title",
      kind: "titles",
      stableId: "legendary-prodigy",
      name: "Old Legendary Prodigy",
      config: { houseNote: true, flat: { strength: 0 } },
      provenance: "house",
      grade: "C",
      sourceUrl: "https://house.example/old",
      archived: true,
    })
    // GET preview: the entry keeps the PROPOSED manifest values and adds the
    // actual existing row metadata, and must write nothing.
    const preview = await previewWikiReviewedImport(WIKI_REVIEWED_ENTRIES)
    expect(preview.createCount).toBe(5)
    expect(preview.skipCount).toBe(1)
    const skipped = preview.entries.find((e) => e.status === "skip_existing")!
    expect(skipped.name).toBe("Legendary Prodigy")
    expect(skipped.sourceUrl).toBe(
      "https://the-primal-hunter.fandom.com/wiki/Legendary_Prodigy"
    )
    expect(skipped.provenance).toBe("inferred")
    expect(skipped.existing).toEqual({
      id: "house-title",
      name: "Old Legendary Prodigy",
      sourceUrl: "https://house.example/old",
      provenance: "house",
      archived: true,
    })
    // Created entries never carry `existing`.
    expect(
      preview.entries
        .filter((e) => e.status === "create")
        .every((e) => e.existing === undefined)
    ).toBe(true)
    expect(dbMock.store.catalog.size).toBe(1)

    // POST apply: the same actual metadata is reported for the skipped row and
    // the pre-existing row is never touched.
    const result = await applyWikiReviewedImport(WIKI_REVIEWED_ENTRIES)
    expect(result.createCount).toBe(5)
    expect(result.skipCount).toBe(1)
    const appliedSkipped = result.entries.find(
      (e) => e.status === "skip_existing"
    )!
    expect(appliedSkipped.existing).toEqual({
      id: "house-title",
      name: "Old Legendary Prodigy",
      sourceUrl: "https://house.example/old",
      provenance: "house",
      archived: true,
    })
    const row = [...dbMock.store.catalog.values()].find(
      (r) => r.id === "house-title"
    )!
    expect(row.provenance).toBe("house")
    expect(row.grade).toBe("C")
    expect(row.name).toBe("Old Legendary Prodigy")
    expect(row.config).toEqual({ houseNote: true, flat: { strength: 0 } })
  })

  it("rejects a duplicate (kind, stableId) within the manifest before any write", async () => {
    const dup: WikiReviewedEntry[] = [
      skillEntry("one-step-mile", "One"),
      skillEntry("one-step-mile", "Two"),
    ]
    await expect(previewWikiReviewedImport(dup)).rejects.toMatchObject({
      status: 400,
      code: "duplicate_manifest_entry",
    })
    await expect(applyWikiReviewedImport(dup)).rejects.toMatchObject({
      status: 400,
      code: "duplicate_manifest_entry",
    })
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("rejects a blessing with a legacy config (missing tier/effects) and writes nothing", async () => {
    const bad: WikiReviewedEntry[] = [
      {
        kind: "blessings",
        stableId: "legacy-bless",
        name: "Legacy",
        description: "A legacy blessing",
        provenance: "inferred",
        sourceUrl: "https://example.com/x",
        config: { grade: "F", effect: {} },
      },
    ]
    await expect(applyWikiReviewedImport(bad)).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("rejects a config that fails the per-kind schema (negative title flat)", async () => {
    const bad: WikiReviewedEntry[] = [
      {
        kind: "titles",
        stableId: "bad-title",
        name: "Bad",
        description: "A bad title",
        provenance: "inferred",
        sourceUrl: "https://example.com/bad",
        config: { flat: { strength: -1 } },
      },
    ]
    await expect(applyWikiReviewedImport(bad)).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("rejects an unknown catalog kind", async () => {
    const bad = [
      {
        kind: "spells",
        stableId: "x",
        name: "X",
        description: "d",
        provenance: "inferred",
        sourceUrl: "https://example.com/x",
        config: {},
      },
    ] as unknown as WikiReviewedEntry[]
    await expect(previewWikiReviewedImport(bad)).rejects.toMatchObject({
      status: 400,
      code: "invalid_kind",
    })
  })

  it("rejects an entry whose provenance is not inferred", async () => {
    const bad = [
      {
        kind: "titles",
        stableId: "x",
        name: "X",
        description: "d",
        provenance: "house",
        sourceUrl: "https://example.com/x",
        config: {},
      },
    ] as unknown as WikiReviewedEntry[]
    await expect(previewWikiReviewedImport(bad)).rejects.toMatchObject({
      status: 400,
      code: "validation",
    })
  })

  it("rejects a non-https or hostless sourceUrl in preview and apply, writing nothing", async () => {
    const bad: WikiReviewedEntry[] = [
      // An `http:` link is a valid URL to catalogCreateSchema, so the HTTPS
      // evidence requirement must reject it even though the schema would accept it.
      {
        kind: "titles",
        stableId: "http-title",
        name: "Http",
        description: "A title cited with an http source",
        provenance: "inferred",
        sourceUrl: "http://example.com/http-title",
        config: {},
      },
      // A scheme without a host is not evidence, https or not.
      {
        kind: "titles",
        stableId: "hostless-title",
        name: "Hostless",
        description: "A title cited with a hostless source",
        provenance: "inferred",
        sourceUrl: "https://",
        config: {},
      },
    ]
    for (const entry of bad) {
      await expect(previewWikiReviewedImport([entry])).rejects.toMatchObject({
        status: 400,
        code: "validation",
      })
      await expect(applyWikiReviewedImport([entry])).rejects.toMatchObject({
        status: 400,
        code: "validation",
      })
    }
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("rolls back the whole import when a mid-transaction patron resolution fails", async () => {
    const bad: WikiReviewedEntry[] = [
      skillEntry("pre-skill", "Pre"),
      {
        kind: "blessings",
        stableId: "ghost-bless",
        name: "Ghost",
        description: "A blessing naming a missing god",
        provenance: "inferred",
        sourceUrl: "https://example.com/ghost",
        config: {
          tier: "Minor",
          effects: [],
          patronGodStableId: "no-such-god",
        },
      },
    ]
    await expect(applyWikiReviewedImport(bad)).rejects.toMatchObject({
      status: 400,
      code: "patron_god_not_found",
    })
    // The first (valid) skill insertion was rolled back with the failure.
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("maps a P2034 serialization conflict to 409 without partial writes", async () => {
    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce({
      name: "PrismaClientKnownRequestError",
      code: "P2034",
    })
    try {
      await expect(
        applyWikiReviewedImport(WIKI_REVIEWED_ENTRIES)
      ).rejects.toMatchObject({
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
      await expect(
        applyWikiReviewedImport(WIKI_REVIEWED_ENTRIES)
      ).rejects.toMatchObject({
        status: 409,
        code: "catalog_stable_id_conflict",
      })
    } finally {
      spy.mockRestore()
    }
    expect(dbMock.store.catalog.size).toBe(0)
  })
})
