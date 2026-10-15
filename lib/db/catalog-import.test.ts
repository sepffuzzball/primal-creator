import { beforeEach, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/db/client"
import {
  applyWikiReviewedImport,
  previewWikiReviewedImport,
  type WikiReviewedEntry,
} from "@/lib/db/catalog-import"
import { WIKI_REVIEWED_ENTRIES } from "@/prisma/catalog/wiki-reviewed"
import type { Grade } from "@/lib/rules"

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
    sourceUrl: `https://example.com/${stableId}`,
    config: { effects: [], rarity: "Common" },
  }
}

function equipmentEntry(
  stableId: string,
  config: Record<string, unknown>,
  name = stableId
): WikiReviewedEntry {
  return {
    kind: "equipment",
    stableId,
    name,
    description: `Description for ${name}`,
    sourceUrl: `https://example.com/${stableId}`,
    config,
  }
}

/** A valid, canonical modern equipment config (slot + rarity + no legacy keys). */
function canonicalEquipmentConfig(
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { slot: "Ring", rarity: "Common", ...extra }
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

  it("apply creates all six curated entries with archived=false", async () => {
    const result = await applyWikiReviewedImport(WIKI_REVIEWED_ENTRIES)
    expect(result.source).toBe("wiki-reviewed")
    expect(result.createCount).toBe(6)
    expect(result.skipCount).toBe(0)
    expect(result.createdIds).toHaveLength(6)
    expect(dbMock.store.catalog.size).toBe(6)
    for (const row of dbMock.store.catalog.values()) {
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
    const god = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "the-malefic-viper"
    )!
    expect(god.kind).toBe("gods")
    expect(god.config).toMatchObject({ blessingEffects: { True: [] } })
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

  it("stores the exact reviewed rarity for both curated skills", async () => {
    // The manifest records the (kind, stableId)-specific rarity reviewed against
    // the wiki system description. One Step Mile is Ancient and Gaze of the Apex
    // Hunter is Legendary - neither is the Common default, so this guards the
    // curated values from a copy-paste regression.
    const oneStepMile = WIKI_REVIEWED_ENTRIES.find(
      (e) => e.stableId === "one-step-mile"
    )!
    expect(oneStepMile.config.rarity).toBe("Ancient")
    const gaze = WIKI_REVIEWED_ENTRIES.find(
      (e) => e.stableId === "gaze-of-the-apex-hunter"
    )!
    expect(gaze.config.rarity).toBe("Legendary")

    // The values must survive the import round-trip into the stored config.
    await applyWikiReviewedImport(WIKI_REVIEWED_ENTRIES)
    const storedOneStepMile = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "one-step-mile"
    )!
    expect(storedOneStepMile.config).toMatchObject({ rarity: "Ancient" })
    const storedGaze = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "gaze-of-the-apex-hunter"
    )!
    expect(storedGaze.config).toMatchObject({ rarity: "Legendary" })
  })

  it("reapplying the identical manifest skips every existing row", async () => {
    await applyWikiReviewedImport(WIKI_REVIEWED_ENTRIES)
    const before = dbMock.store.catalog.size
    const result = await applyWikiReviewedImport(WIKI_REVIEWED_ENTRIES)
    expect(result.createCount).toBe(0)
    expect(result.skipCount).toBe(6)
    expect(result.createdIds).toHaveLength(0)
    // Every skipped entry reports the ACTUAL existing row (the rows created by
    // the first apply), not the manifest's proposed values.
    const skipped = result.entries.filter((e) => e.status === "skip_existing")
    expect(skipped).toHaveLength(6)
    for (const entry of skipped) {
      expect(entry.existing).toBeDefined()
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
    expect(skipped.existing).toEqual({
      id: "house-title",
      name: "Old Legendary Prodigy",
      sourceUrl: "https://house.example/old",
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
      archived: true,
    })
    const row = [...dbMock.store.catalog.values()].find(
      (r) => r.id === "house-title"
    )!
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

  it("rejects a god whose blessingEffects references an unknown tier and writes nothing", async () => {
    const bad: WikiReviewedEntry[] = [
      {
        kind: "gods",
        stableId: "bad-god",
        name: "Bad God",
        description: "A god with a typo'd blessing tier key",

        sourceUrl: "https://example.com/bad-god",
        config: { blessingEffects: { minor: [] } },
      },
    ]
    await expect(applyWikiReviewedImport(bad)).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("rejects a race manifest entry without raceType (legacy config) and writes nothing", async () => {
    const bad: WikiReviewedEntry[] = [
      {
        kind: "races",
        stableId: "legacy-race",
        name: "Legacy Race",
        description: "A legacy race with no raceType",

        sourceUrl: "https://example.com/legacy-race",
        config: {
          naturalGrade: "F",
          raceDefinitions: {
            F: { id: "r:F", perLevel: { strength: 1 }, freePerLevel: 1 },
          },
        },
      },
    ]
    await expect(applyWikiReviewedImport(bad)).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("rejects a race manifest entry without naturalGrade (modern shape requires both) and writes nothing", async () => {
    const bad: WikiReviewedEntry[] = [
      {
        kind: "races",
        stableId: "no-grade-race",
        name: "No Grade Race",
        description: "A race that omits naturalGrade",

        sourceUrl: "https://example.com/no-grade-race",
        config: {
          raceType: "enlightened",
          raceDefinitions: {
            F: { id: "r:F", perLevel: { strength: 1 }, freePerLevel: 1 },
          },
        },
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
        sourceUrl: "https://example.com/x",
        config: {},
      },
    ] as unknown as WikiReviewedEntry[]
    await expect(previewWikiReviewedImport(bad)).rejects.toMatchObject({
      status: 400,
      code: "invalid_kind",
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

        sourceUrl: "http://example.com/http-title",
        config: {},
      },
      // A scheme without a host is not evidence, https or not.
      {
        kind: "titles",
        stableId: "hostless-title",
        name: "Hostless",
        description: "A title cited with a hostless source",

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

  it("rejects the whole manifest (no partial writes) when a later god entry is invalid", async () => {
    const bad: WikiReviewedEntry[] = [
      skillEntry("pre-skill", "Pre"),
      {
        kind: "gods",
        stableId: "ghost-god",
        name: "Ghost",
        description: "A god with an invalid blessing tier key",

        sourceUrl: "https://example.com/ghost-god",
        config: {
          blessingEffects: { minor: [] },
        },
      },
    ]
    await expect(applyWikiReviewedImport(bad)).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    // Validation runs before ANY write, so the first (valid) skill entry was never
    // persisted even though it precedes the bad god entry.
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

  it("apply persists an authored gradeDescriptions map for an entry that carries one", async () => {
    const entry: WikiReviewedEntry = {
      kind: "races",
      stableId: "graded-race",
      name: "Graded Race",
      description: "A race with independently authored grade descriptions",
      grade: null,
      sourceUrl: "https://example.com/graded-race",
      config: {
        raceType: "enlightened",
        naturalGrade: "B",
        raceDefinitions: {
          B: { id: "r:B", perLevel: { strength: 1 }, freePerLevel: 1 },
        },
      },
      gradeDescriptions: {
        G: "A G-grade blurb",
        S: "An S-grade blurb",
      },
    }
    await applyWikiReviewedImport([entry])
    const row = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "graded-race"
    )!
    expect(row.gradeDescriptions).toEqual({
      G: "A G-grade blurb",
      S: "An S-grade blurb",
    })
  })

  it("a manifest entry that omits gradeDescriptions stores an empty map (legacy rows)", async () => {
    await applyWikiReviewedImport([skillEntry("plain-skill")])
    const row = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "plain-skill"
    )!
    expect(row.gradeDescriptions).toEqual({})
  })

  it("rejects a manifest entry with an invalid gradeDescriptions key and writes nothing", async () => {
    const entry: WikiReviewedEntry = {
      ...skillEntry("bad-grade"),
      gradeDescriptions: { H: "nope" } as Partial<Record<Grade, string>>,
    }
    await expect(applyWikiReviewedImport([entry])).rejects.toMatchObject({
      status: 400,
      code: "validation",
    })
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("rejects an equipment entry carrying legacy requirement keys and writes nothing", async () => {
    // A NEW equipment manifest entry must persist the canonical
    // minimumLevel/requiredLevelType pair; the legacy minRaceLevel /
    // requiredRaceType keys are migrated by the editor and must never be stored.
    const legacy: WikiReviewedEntry[] = [
      equipmentEntry("legacy-ring", {
        slot: "Ring",
        rarity: "Common",
        minRaceLevel: 5,
        requiredRaceType: "enlightened",
      }),
    ]
    await expect(previewWikiReviewedImport(legacy)).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    await expect(applyWikiReviewedImport(legacy)).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("accepts an equipment entry with canonical requirement keys", async () => {
    const good: WikiReviewedEntry[] = [
      equipmentEntry("canonical-ring", canonicalEquipmentConfig({})),
      equipmentEntry(
        "level-gated-ring",
        canonicalEquipmentConfig({
          minimumLevel: 5,
          requiredLevelType: "humanoidRace",
        })
      ),
      equipmentEntry(
        "type-only-ring",
        canonicalEquipmentConfig({ requiredLevelType: "class" })
      ),
    ]
    const result = await applyWikiReviewedImport(good)
    expect(result.createCount).toBe(3)
    expect(result.skipCount).toBe(0)
    const stored = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "level-gated-ring"
    )!
    expect(stored.config).toMatchObject({
      minimumLevel: 5,
      requiredLevelType: "humanoidRace",
    })
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
    const good: WikiReviewedEntry[] = [
      equipmentEntry("viper-ring", canonicalEquipmentConfig({})),
      equipmentEntry(
        "viper-talisman",
        canonicalEquipmentConfig({
          requiredGodStableId: "the-malefic-viper",
          minimumBlessingTier: "Minor",
        })
      ),
    ]
    const result = await applyWikiReviewedImport(good)
    expect(result.createCount).toBe(2)
    expect(result.skipCount).toBe(0)
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
    const bad: WikiReviewedEntry[] = [
      equipmentEntry(
        "sleeping-god-ring",
        canonicalEquipmentConfig({ requiredGodStableId: "a-sleeping-god" })
      ),
    ]
    await expect(applyWikiReviewedImport(bad)).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    expect(dbMock.store.catalog.size).toBe(1)
  })

  it("rejects an equipment ref to a god that is archived even when the manifest also lists that god (the manifest entry is skipped)", async () => {
    // A god row already exists archived, AND the manifest also lists that same god.
    // Because existing rows are never overwritten, the manifest god entry is
    // skipped (status skip_existing), so the god stays archived. The import must
    // NOT treat the merely-included manifest god as unarchived, so an equipment
    // entry requiring it is rejected in BOTH preview and apply, with no write.
    dbMock.store.addCatalog({
      id: "dual-god",
      kind: "gods",
      stableId: "dual-god",
      name: "Dual God",
      config: { blessingEffects: {} },
      archived: true,
    })
    const manifest: WikiReviewedEntry[] = [
      {
        kind: "gods",
        stableId: "dual-god",
        name: "Dual God",
        description:
          "A god archived in the catalog and also present in the manifest",
        sourceUrl: "https://example.com/dual-god",
        config: { blessingEffects: {} },
      },
      equipmentEntry(
        "dual-god-relic",
        canonicalEquipmentConfig({ requiredGodStableId: "dual-god" })
      ),
    ]
    await expect(previewWikiReviewedImport(manifest)).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    await expect(applyWikiReviewedImport(manifest)).rejects.toMatchObject({
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

  it("rejects an equipment entry with a dangling god reference and writes nothing", async () => {
    const bad: WikiReviewedEntry[] = [
      equipmentEntry(
        "dangling-patron-ring",
        canonicalEquipmentConfig({ requiredGodStableId: "no-such-god" })
      ),
    ]
    await expect(previewWikiReviewedImport(bad)).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    await expect(applyWikiReviewedImport(bad)).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("accepts an equipment entry whose required god is created by the same manifest", async () => {
    // Import always creates rows with archived=false, so a god created by this
    // manifest satisfies the unarchived patron resolution required by equipment.
    const good: WikiReviewedEntry[] = [
      {
        kind: "gods",
        stableId: "manifest-god",
        name: "Manifest God",
        description: "A god authored in the same manifest",
        sourceUrl: "https://example.com/manifest-god",
        config: { blessingEffects: {} },
      },
      equipmentEntry(
        "manifest-god-ring",
        canonicalEquipmentConfig({ requiredGodStableId: "manifest-god" })
      ),
    ]
    const result = await applyWikiReviewedImport(good)
    expect(result.createCount).toBe(2)
    expect(result.skipCount).toBe(0)
    const ring = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "manifest-god-ring"
    )!
    expect(ring.config).toMatchObject({ requiredGodStableId: "manifest-god" })
  })

  it("rejects an equipment entry that grants a missing skill (preview and apply, no write)", async () => {
    const bad: WikiReviewedEntry[] = [
      equipmentEntry(
        "missing-skill-ring",
        canonicalEquipmentConfig({ grantedSkillStableIds: ["no-such-skill"] })
      ),
    ]
    await expect(previewWikiReviewedImport(bad)).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    await expect(applyWikiReviewedImport(bad)).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("rejects an equipment entry that grants an archived skill (preview and apply, no write)", async () => {
    dbMock.store.addCatalog({
      id: "archived-skill",
      kind: "skills",
      stableId: "archived-skill",
      name: "Archived Skill",
      config: { effects: [], rarity: "Common" },
      archived: true,
    })
    const bad: WikiReviewedEntry[] = [
      equipmentEntry(
        "archived-skill-ring",
        canonicalEquipmentConfig({ grantedSkillStableIds: ["archived-skill"] })
      ),
    ]
    await expect(previewWikiReviewedImport(bad)).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    await expect(applyWikiReviewedImport(bad)).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    expect(dbMock.store.catalog.size).toBe(1)
  })

  it("rejects an equipment grant to a skill the manifest also lists when the catalog skill is archived (manifest entry skipped)", async () => {
    // A skill row already exists archived, AND the manifest also lists that same
    // skill. Because existing rows are never overwritten, the manifest skill entry
    // is skipped (status skip_existing), so the skill stays archived. The import
    // must NOT treat the merely-included manifest skill as unarchived, so an
    // equipment entry granting it is rejected in BOTH preview and apply.
    dbMock.store.addCatalog({
      id: "dual-skill",
      kind: "skills",
      stableId: "dual-skill",
      name: "Dual Skill",
      config: { effects: [], rarity: "Common" },
      archived: true,
    })
    const manifest: WikiReviewedEntry[] = [
      skillEntry("dual-skill"),
      equipmentEntry(
        "dual-skill-relic",
        canonicalEquipmentConfig({ grantedSkillStableIds: ["dual-skill"] })
      ),
    ]
    await expect(previewWikiReviewedImport(manifest)).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    await expect(applyWikiReviewedImport(manifest)).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    expect(dbMock.store.catalog.size).toBe(1)
    const row = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "dual-skill"
    )!
    expect(row.archived).toBe(true)
  })

  it("accepts an equipment entry that grants a skill created by the same manifest", async () => {
    // Import always creates rows with archived=false, so a skill created by this
    // manifest satisfies the unarchived granted-skill resolution.
    const good: WikiReviewedEntry[] = [
      skillEntry("manifest-skill"),
      equipmentEntry(
        "manifest-skill-ring",
        canonicalEquipmentConfig({ grantedSkillStableIds: ["manifest-skill"] })
      ),
    ]
    const result = await applyWikiReviewedImport(good)
    expect(result.createCount).toBe(2)
    expect(result.skipCount).toBe(0)
    const ring = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "manifest-skill-ring"
    )!
    expect(ring.config).toMatchObject({
      grantedSkillStableIds: ["manifest-skill"],
    })
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
    const good: WikiReviewedEntry[] = [
      equipmentEntry(
        "existing-skill-ring",
        canonicalEquipmentConfig({ grantedSkillStableIds: ["existing-skill"] })
      ),
    ]
    const result = await applyWikiReviewedImport(good)
    expect(result.createCount).toBe(1)
    expect(result.skipCount).toBe(0)
    const ring = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "existing-skill-ring"
    )!
    expect(ring.config).toMatchObject({
      grantedSkillStableIds: ["existing-skill"],
    })
  })
})
