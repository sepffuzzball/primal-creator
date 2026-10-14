/**
 * Real-Postgres integration tests for the admin bulk catalog upload.
 *
 * Exercises the importer against a live database: applying an upload creates the
 * entries, a repeat apply is idempotent (skips every existing row), a pre-existing
 * row with a conflicting stableId is retained unchanged, and a blessing that names
 * a god created by the same upload resolves its patron FK regardless of row order.
 * Runs ONLY when explicitly opted in (see `resolveDbIntegration`); a normal
 * `pnpm test` skips this file.
 *
 * These tests never delete pre-existing catalog rows. Every stableId this suite
 * uses is run-suffixed with a fresh `randomUUID`, and cleanup deletes only the
 * exact row ids this run created (never by fixed (kind, stableId) pairs), and it
 * deletes child `blessings` before their patron gods (the patronId FK is
 * RESTRICT, so a god cannot be removed while a blessing still references it).
 */

import { afterAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { prisma } from "@/lib/db/client"
import {
  applyBulkImport,
  computeBulkRequestDigest,
  parseBulkEntries,
  previewBulkImport,
} from "@/lib/db/bulk-catalog-import"
import { resolveDbIntegration } from "@/lib/test/db-integration"

const gate = await resolveDbIntegration()

describe.skipIf(!gate.run)("bulk catalog import (real PG)", () => {
  const runSuffix = randomUUID()
  const stable = (name: string) => `${name}__${runSuffix}`

  // Row ids created by THIS suite only. afterAll deletes exactly these; any row
  // that pre-existed (or a row owned by another task) is never touched.
  const createdIds: string[] = []

  afterAll(async () => {
    if (createdIds.length === 0) return
    const ids = [...createdIds]
    // Delete child blessings first: a blessing holds a RESTRICT FK (`patronId`)
    // to its patron god, so the god must not be removed before the referencing
    // blessing. Then delete every other created row. This runs even when an
    // earlier assertion failed, and targets only the exact ids this suite made.
    const blessingIds = (
      await prisma.catalogDefinition.findMany({
        where: { id: { in: ids }, kind: "blessings" },
        select: { id: true },
      })
    ).map((row) => row.id)
    if (blessingIds.length > 0) {
      await prisma.catalogDefinition.deleteMany({
        where: { id: { in: blessingIds } },
      })
    }
    await prisma.catalogDefinition.deleteMany({
      where: { id: { in: ids } },
    })
  })

  function skillContent(name: string): string {
    const s = stable(name)
    return JSON.stringify([
      {
        kind: "skills",
        stableId: s,
        name: `Skill ${s}`,
        description: "Description",
        provenance: "house",
        sourceUrl: `https://example.com/${s}`,
        config: { effects: [], rarity: "Common" },
      },
    ])
  }

  it("applies an upload and is idempotent on reapply", async () => {
    const content = skillContent("pg-skill")
    const entries = parseBulkEntries("json", content)
    const result = await applyBulkImport(
      entries,
      computeBulkRequestDigest("json", content)
    )
    createdIds.push(...result.createdIds)
    expect(result.source).toBe("bulk")
    expect(result.createCount).toBe(1)
    expect(result.createdIds).toHaveLength(1)

    const persisted = await prisma.catalogDefinition.findUnique({
      where: { id: result.createdIds[0] },
    })
    expect(persisted).not.toBeNull()
    expect(persisted?.archived).toBe(false)

    const reapply = await applyBulkImport(
      entries,
      computeBulkRequestDigest("json", content)
    )
    expect(reapply.createCount).toBe(0)
    expect(reapply.skipCount).toBe(1)
    expect(reapply.createdIds).toHaveLength(0)
  })

  it("preview reflects the applied state without writing", async () => {
    const content = skillContent("pg-preview")
    const entries = parseBulkEntries("json", content)
    const ensure = await applyBulkImport(
      entries,
      computeBulkRequestDigest("json", content)
    )
    createdIds.push(...ensure.createdIds)
    const preview = await previewBulkImport(
      entries,
      computeBulkRequestDigest("json", content)
    )
    expect(preview.createCount).toBe(0)
    expect(preview.skipCount).toBe(1)
  })

  it("never overwrites an existing row with a conflicting stableId", async () => {
    const s = stable("pg-title")
    const houseRow = await prisma.catalogDefinition.create({
      data: {
        kind: "titles",
        stableId: s,
        name: "House Title",
        config: { houseStub: true },
      },
    })
    createdIds.push(houseRow.id)

    const upload = JSON.stringify([
      {
        kind: "titles",
        stableId: s,
        name: "Imported Title",
        provenance: "house",
        sourceUrl: null,
        config: { flat: { strength: 10 } },
      },
    ])
    const entries = parseBulkEntries("json", upload)
    const result = await applyBulkImport(
      entries,
      computeBulkRequestDigest("json", upload)
    )
    createdIds.push(...result.createdIds)
    expect(result.createCount).toBe(0)
    expect(result.skipCount).toBe(1)
    const skipped = result.entries.find((e) => e.status === "skip_existing")!
    expect(skipped.existing?.name).toBe("House Title")

    const row = await prisma.catalogDefinition.findUnique({
      where: { kind_stableId: { kind: "titles", stableId: s } },
    })
    expect(row?.name).toBe("House Title")
  })

  it("creates gods first so a blessing can reference a god later in the upload", async () => {
    const godId = stable("pg-odin")
    const blessId = stable("pg-bless")
    const upload = JSON.stringify([
      {
        kind: "blessings",
        stableId: blessId,
        name: "Blessing",
        description: "d",
        provenance: "house",
        sourceUrl: null,
        config: { tier: "Minor", effects: [], patronGodStableId: godId },
      },
      {
        kind: "gods",
        stableId: godId,
        name: "God",
        description: "d",
        provenance: "house",
        sourceUrl: null,
        config: {},
      },
    ])
    const entries = parseBulkEntries("json", upload)
    const result = await applyBulkImport(
      entries,
      computeBulkRequestDigest("json", upload)
    )
    createdIds.push(...result.createdIds)
    expect(result.createCount).toBe(2)

    const god = await prisma.catalogDefinition.findUnique({
      where: { kind_stableId: { kind: "gods", stableId: godId } },
    })
    const blessing = await prisma.catalogDefinition.findUnique({
      where: { kind_stableId: { kind: "blessings", stableId: blessId } },
    })
    expect(god).not.toBeNull()
    expect(blessing).not.toBeNull()
    expect(blessing?.patronId).toBe(god?.id)
  })
})
