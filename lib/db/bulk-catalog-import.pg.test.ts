/**
 * Real-Postgres integration tests for the admin bulk catalog upload.
 *
 * Exercises the importer against a live database: applying an upload creates the
 * entries, a repeat apply is idempotent (skips every existing row), a pre-existing
 * row with a conflicting stableId is retained unchanged, and a `gods` entry with
 * `blessingEffects` is created regardless of row order (there is no patron FK
 * anymore - a blessing is a god + tier on a character association, not a catalog
 * kind). Runs ONLY when explicitly opted in (see `resolveDbIntegration`); a normal
 * `pnpm test` skips this file.
 *
 * These tests never delete pre-existing catalog rows. Every stableId this suite
 * uses is run-suffixed with a fresh `randomUUID`, and cleanup deletes only the
 * exact row ids this run created (never by fixed (kind, stableId) pairs).
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
    // Delete only the exact row ids this suite created. There is no patron FK to
    // order around (a blessing is a god + tier on a character association), so all
    // created rows are removed together. This runs even when an earlier assertion
    // failed, and targets only the exact ids this suite made.
    await prisma.catalogDefinition.deleteMany({
      where: { id: { in: [...createdIds] } },
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
        config: { track: "race", effects: [], rarity: "Common" },
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

  it("creates gods entries with blessingEffects regardless of row order", async () => {
    const godId = stable("pg-odin")
    const godId2 = stable("pg-thor")
    const upload = JSON.stringify([
      {
        kind: "gods",
        stableId: godId,
        name: "Odin",
        description: "d",
        provenance: "house",
        sourceUrl: null,
        config: { pantheon: "Aesir", blessingEffects: { True: [] } },
      },
      {
        kind: "gods",
        stableId: godId2,
        name: "Thor",
        description: "d",
        provenance: "house",
        sourceUrl: null,
        config: { pantheon: "Aesir", divineRank: "God" },
      },
    ])
    const entries = parseBulkEntries("json", upload)
    const result = await applyBulkImport(
      entries,
      computeBulkRequestDigest("json", upload)
    )
    createdIds.push(...result.createdIds)
    expect(result.createCount).toBe(2)

    // A blessing is a god + tier on a character association, so there is no patron
    // FK to resolve and no row ordering dependency.
    const odin = await prisma.catalogDefinition.findUnique({
      where: { kind_stableId: { kind: "gods", stableId: godId } },
    })
    const thor = await prisma.catalogDefinition.findUnique({
      where: { kind_stableId: { kind: "gods", stableId: godId2 } },
    })
    expect(odin).not.toBeNull()
    expect(thor).not.toBeNull()
    expect(
      (odin?.config as { blessingEffects?: unknown }).blessingEffects
    ).toMatchObject({ True: [] })
    expect((thor?.config as Record<string, unknown>).divineRank).toBe("God")
  })

  it("rejects an equipment entry whose required god does not exist and writes nothing", async () => {
    const godStable = stable("pg-no-god")
    const equipStable = stable("pg-no-god-ring")
    const upload = JSON.stringify([
      {
        kind: "equipment",
        stableId: equipStable,
        name: "Ring of Nowhere",
        description: "d",
        provenance: "house",
        sourceUrl: null,
        config: {
          slot: "Ring",
          rarity: "Common",
          requiredGodStableId: godStable,
        },
      },
    ])
    const entries = parseBulkEntries("json", upload)
    await expect(
      applyBulkImport(entries, computeBulkRequestDigest("json", upload))
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    // No god row exists, so nothing was created (the equipment row was never made).
    const ring = await prisma.catalogDefinition.findUnique({
      where: { kind_stableId: { kind: "equipment", stableId: equipStable } },
    })
    expect(ring).toBeNull()
  })

  it("accepts an equipment entry whose required god is created by the same upload", async () => {
    const godStable = stable("pg-created-god")
    const equipStable = stable("pg-created-god-ring")
    const upload = JSON.stringify([
      {
        kind: "gods",
        stableId: godStable,
        name: "Created God",
        description: "d",
        provenance: "house",
        sourceUrl: null,
        config: { blessingEffects: { True: [] } },
      },
      {
        kind: "equipment",
        stableId: equipStable,
        name: "Created God Ring",
        description: "d",
        provenance: "house",
        sourceUrl: null,
        config: {
          slot: "Ring",
          rarity: "Common",
          requiredGodStableId: godStable,
        },
      },
    ])
    const entries = parseBulkEntries("json", upload)
    const result = await applyBulkImport(
      entries,
      computeBulkRequestDigest("json", upload)
    )
    createdIds.push(...result.createdIds)
    expect(result.createCount).toBe(2)
    const ring = await prisma.catalogDefinition.findUnique({
      where: { kind_stableId: { kind: "equipment", stableId: equipStable } },
    })
    expect(ring?.config).toMatchObject({ requiredGodStableId: godStable })
    const god = await prisma.catalogDefinition.findUnique({
      where: { kind_stableId: { kind: "gods", stableId: godStable } },
    })
    expect(god?.archived).toBe(false)
  })

  it("rejects an equipment entry whose required god is archived and writes nothing", async () => {
    const godStable = stable("pg-archived-god")
    const godRow = await prisma.catalogDefinition.create({
      data: {
        kind: "gods",
        stableId: godStable,
        name: "Archived God",
        config: {},
        archived: true,
      },
    })
    createdIds.push(godRow.id)
    const equipStable = stable("pg-archived-god-ring")
    const upload = JSON.stringify([
      {
        kind: "equipment",
        stableId: equipStable,
        name: "Archived God Ring",
        description: "d",
        provenance: "house",
        sourceUrl: null,
        config: {
          slot: "Ring",
          rarity: "Common",
          requiredGodStableId: godStable,
        },
      },
    ])
    const entries = parseBulkEntries("json", upload)
    await expect(
      applyBulkImport(entries, computeBulkRequestDigest("json", upload))
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    // The equipment row was never created; the archived god is untouched.
    const ring = await prisma.catalogDefinition.findUnique({
      where: { kind_stableId: { kind: "equipment", stableId: equipStable } },
    })
    expect(ring).toBeNull()
    const god = await prisma.catalogDefinition.findUnique({
      where: { id: godRow.id },
    })
    expect(god?.archived).toBe(true)
  })

  it("apply re-reads the god state inside the transaction and rejects when the patron is archived concurrently after preview", async () => {
    const godStable = stable("pg-concurrent-god")
    const godRow = await prisma.catalogDefinition.create({
      data: {
        kind: "gods",
        stableId: godStable,
        name: "Concurrent God",
        config: {},
        archived: false,
      },
    })
    createdIds.push(godRow.id)
    const equipStable = stable("pg-concurrent-god-ring")
    const upload = JSON.stringify([
      {
        kind: "equipment",
        stableId: equipStable,
        name: "Concurrent God Ring",
        description: "d",
        provenance: "house",
        sourceUrl: null,
        config: {
          slot: "Ring",
          rarity: "Common",
          requiredGodStableId: godStable,
        },
      },
    ])
    const entries = parseBulkEntries("json", upload)
    // Preview reads the god as active and would create the equipment row.
    const preview = await previewBulkImport(
      entries,
      computeBulkRequestDigest("json", upload)
    )
    expect(preview.createCount).toBe(1)
    // A concurrent write archives the patron between preview and apply, so the
    // apply SERIALIZABLE transaction must reject rather than trust the stale
    // preview result.
    await prisma.catalogDefinition.update({
      where: { id: godRow.id },
      data: { archived: true },
    })
    await expect(
      applyBulkImport(entries, computeBulkRequestDigest("json", upload))
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    const ring = await prisma.catalogDefinition.findUnique({
      where: { kind_stableId: { kind: "equipment", stableId: equipStable } },
    })
    expect(ring).toBeNull()
  })

  it("skips an existing race whose grade-granted skill was archived instead of rejecting it", async () => {
    const raceStable = stable("pg-existing-race")
    const skillStable = stable("pg-existing-arch-skill")
    const raceRow = await prisma.catalogDefinition.create({
      data: {
        kind: "races",
        stableId: raceStable,
        name: "Existing Race",
        config: {
          raceType: "enlightened",
          naturalGrade: "F",
          gradeGrantedSkillStableIds: { F: [skillStable] },
        },
      },
    })
    createdIds.push(raceRow.id)
    const skillRow = await prisma.catalogDefinition.create({
      data: {
        kind: "skills",
        stableId: skillStable,
        name: "Archived Skill",
        config: { effects: [], rarity: "Common" },
        archived: true,
      },
    })
    createdIds.push(skillRow.id)

    const upload = JSON.stringify([
      {
        kind: "races",
        stableId: raceStable,
        name: "Existing Race",
        description: "d",
        provenance: "house",
        sourceUrl: null,
        config: {
          raceType: "enlightened",
          naturalGrade: "F",
          gradeGrantedSkillStableIds: { F: [skillStable] },
        },
      },
    ])
    const entries = parseBulkEntries("json", upload)
    const result = await applyBulkImport(
      entries,
      computeBulkRequestDigest("json", upload)
    )
    expect(result.createCount).toBe(0)
    expect(result.skipCount).toBe(1)
    expect(result.createdIds).toHaveLength(0)
    const persisted = await prisma.catalogDefinition.findUnique({
      where: { kind_stableId: { kind: "races", stableId: raceStable } },
    })
    expect(persisted?.config).toMatchObject({
      gradeGrantedSkillStableIds: { F: [skillStable] },
    })
    expect(persisted?.archived).toBe(false)
  })
})
