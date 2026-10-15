/**
 * Real-Postgres integration tests for the wiki-reviewed catalog import.
 *
 * Exercises the importer against a live database: applying a manifest creates the
 * six curated entries, a repeat apply is idempotent (skips every existing row), a
 * pre-existing house row with a conflicting stableId is retained unchanged, and an
 * invalid `gods` config rejects the whole import before any row is written (no
 * partial rows). Runs ONLY when explicitly opted in (see `resolveDbIntegration`);
 * a normal `pnpm test` skips this file.
 *
 * These tests never delete pre-existing catalog rows. Every stableId this suite
 * uses is run-suffixed with a fresh `randomUUID`, and cleanup deletes only the
 * exact row ids this run created (never by fixed (kind, stableId) pairs). If a run
 * crashes before cleanup, the leftover rows are harmless: the next run uses a
 * different suffix and cannot collide with them.
 */

import { afterAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { prisma } from "@/lib/db/client"
import {
  applyWikiReviewedImport,
  previewWikiReviewedImport,
  type WikiReviewedEntry,
} from "@/lib/db/catalog-import"
import { WIKI_REVIEWED_ENTRIES } from "@/prisma/catalog/wiki-reviewed"
import { resolveDbIntegration } from "@/lib/test/db-integration"

const gate = await resolveDbIntegration()

describe.skipIf(!gate.run)("wiki-reviewed catalog import (real PG)", () => {
  // Run-specific suffix. Reusing the production fixed stableIds would delete or
  // overwrite any pre-existing catalog row that happens to share a key; a fresh
  // random suffix guarantees collision-free keys so nothing already in the
  // database is touched.
  const runSuffix = randomUUID()

  // Clone the production manifest with each stableId run-suffixed. kind, config
  // and sourceUrl are preserved exactly, so validation and the modern-shape
  // guards behave identically to the real manifest.
  const clonedEntries = WIKI_REVIEWED_ENTRIES.map((entry) => ({
    ...entry,
    stableId: `${entry.stableId}__${runSuffix}`,
  })) satisfies readonly WikiReviewedEntry[]

  const clonedRows = clonedEntries.map((entry) => ({
    kind: entry.kind as never,
    stableId: entry.stableId,
  }))

  // Row ids created by THIS suite only. afterAll deletes exactly these; any row
  // that pre-existed (or a house row owned by another task) is never touched.
  const createdIds: string[] = []

  afterAll(async () => {
    if (createdIds.length > 0) {
      await prisma.catalogDefinition.deleteMany({
        where: { id: { in: createdIds } },
      })
    }
  })

  it("applies the six curated entries and is idempotent on reapply", async () => {
    const result = await applyWikiReviewedImport(clonedEntries)
    createdIds.push(...result.createdIds)
    expect(result.source).toBe("wiki-reviewed")
    expect(result.createCount).toBe(6)
    expect(result.createdIds).toHaveLength(6)

    const persisted = await prisma.catalogDefinition.findMany({
      where: { OR: clonedRows },
    })
    expect(persisted).toHaveLength(6)
    expect(persisted.every((row) => row.archived === false)).toBe(true)

    const reapply = await applyWikiReviewedImport(clonedEntries)
    expect(reapply.createCount).toBe(0)
    expect(reapply.skipCount).toBe(6)
    expect(reapply.createdIds).toHaveLength(0)
  })

  it("preview reflects the applied state without writing", async () => {
    // Guarantee the cloned rows exist whether or not the apply test ran first
    // (idempotent, so it never changes the counts), then confirm the read-only
    // preview agrees without mutating anything.
    const ensure = await applyWikiReviewedImport(clonedEntries)
    createdIds.push(...ensure.createdIds)
    const preview = await previewWikiReviewedImport(clonedEntries)
    expect(preview.createCount).toBe(0)
    expect(preview.skipCount).toBe(6)
  })

  it("product manifest validates read-only without writing", async () => {
    const preview = await previewWikiReviewedImport(WIKI_REVIEWED_ENTRIES)
    expect(preview.source).toBe("wiki-reviewed")
    expect(preview.createCount + preview.skipCount).toBe(
      WIKI_REVIEWED_ENTRIES.length
    )
  })

  it("retains an existing house row with a conflicting stableId unchanged", async () => {
    // Use a SEPARATE run-specific key for the house row so this test never
    // replaces or deletes a row created earlier in this suite (or any pre-existing
    // catalog row).
    const houseStableId = `house-collision__${runSuffix}`
    const houseRow = await prisma.catalogDefinition.create({
      data: {
        kind: "titles",
        stableId: houseStableId,
        name: "House Title",
        config: { houseStub: true },
      },
    })
    createdIds.push(houseRow.id)

    // The manifest entry occupying that key (carrying the same config shape as the
    // production titles entry) must not overwrite the pre-existing house row.
    const productionTitle = WIKI_REVIEWED_ENTRIES.find(
      (entry) => entry.kind === "titles"
    )
    if (!productionTitle) {
      throw new Error("wiki-reviewed manifest is missing its titles entry")
    }
    const houseEntry: WikiReviewedEntry = {
      ...productionTitle,
      stableId: houseStableId,
      name: "Imported Title",
      description: "d",
    }

    const result = await applyWikiReviewedImport([houseEntry])
    createdIds.push(...result.createdIds)
    expect(result.createCount).toBe(0)
    expect(result.skipCount).toBe(1)
    const skipped = result.entries.find((e) => e.status === "skip_existing")!
    // The entry keeps the PROPOSED manifest values...
    expect(skipped.name).toBe("Imported Title")
    // ...and reports the ACTUAL existing house row metadata, never the manifest.
    expect(skipped.existing).toMatchObject({
      name: "House Title",
    })

    const row = await prisma.catalogDefinition.findUnique({
      where: { kind_stableId: { kind: "titles", stableId: houseStableId } },
    })
    expect(row?.name).toBe("House Title")
    expect(row?.config).toEqual({ houseStub: true })
  })

  it("rejects an invalid gods config with no partial rows", async () => {
    // The first entry is valid and would be created; the second is a `gods` entry
    // whose `blessingEffects` names an unrecognized tier ("minor"), which fails
    // config validation BEFORE any write. No row is created, so the valid first
    // entry does not leak a partial write. Run-specific ids mean no pre-delete is
    // needed and a non-empty DB is safe.
    const preSkillId = `pg-pre-skill__${runSuffix}`
    const bad: WikiReviewedEntry[] = [
      {
        kind: "skills",
        stableId: preSkillId,
        name: "PG Pre",
        description: "d",
        sourceUrl: "https://example.com/pre",
        config: { effects: [], rarity: "Common" },
      },
      {
        kind: "gods",
        stableId: `pg-ghost-god__${runSuffix}`,
        name: "Ghost",
        description: "d",
        sourceUrl: "https://example.com/ghost",
        config: { blessingEffects: { minor: [] } },
      },
    ]
    await expect(applyWikiReviewedImport(bad)).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
    const pre = await prisma.catalogDefinition.findUnique({
      where: { kind_stableId: { kind: "skills", stableId: preSkillId } },
    })
    expect(pre).toBeNull()
  })
})
