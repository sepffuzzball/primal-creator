/**
 * Real-Postgres integration tests for the MCP managed catalog publisher
 * (lib/db/mcp-catalog-publish.ts).
 *
 * Exercises the SERIALIZABLE preview/apply flow against a live database:
 *
 *   - `previewManagedCatalog` computes a state digest and materializes the same
 *     writes the apply would run, then rolls them ALL back (a real ROLLBACK, not a
 *     simulated "we did not write").
 *   - `applyManagedCatalog` verifies the preview ticket (both digests + expiry)
 *     BEFORE any write, commits all of a batch or none of it, and maps a P2002 /
 *     P2034 / SQLSTATE 40001 serialization conflict to 409 `catalog_conflict`.
 *   - A stale preview ticket (any unrelated catalog row changed, including a
 *     brand-new unrelated key) is rejected as 409 `preview_stale`.
 *   - A concurrent apply that races on the same new key is rejected as a 409,
 *     never a partial write and never a raw 500.
 *   - A mixed batch whose update hits the existing linked-title guard rolls back
 *     the whole apply (no partial rows).
 *
 * Runs ONLY when explicitly opted in (see `resolveDbIntegration`); a normal
 * `pnpm test` skips this file. The database must already have `prisma migrate
 * deploy` applied. Every stableId/id this suite uses is run-suffixed with a fresh
 * `randomUUID`, and cleanup deletes only the exact rows THIS run created (never
 * by fixed keys), so a pre-existing row or a concurrent suite is never touched.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { prisma } from "@/lib/db/client"
import {
  applyManagedCatalog,
  computeManagedPayloadDigest,
  computeManagedStateDigest,
  previewManagedCatalog,
  type ManagedCatalogEntry,
} from "@/lib/db/mcp-catalog-publish"
import { issueMcpPreviewTicket } from "@/lib/server/mcp-catalog-auth"
import { resolveDbIntegration } from "@/lib/test/db-integration"

const gate = await resolveDbIntegration()

const AUTH_SECRET = "test-auth-secret-that-is-at-least-32-chars-long!!"

describe.skipIf(!gate.run)("mcp managed catalog publish (real PG)", () => {
  const runSuffix = randomUUID()
  const stable = (name: string) => `${name}__${runSuffix}`

  // Row ids created by THIS suite only. afterAll deletes exactly these; a
  // pre-existing row (or a row owned by another task) is never touched.
  const createdIds: string[] = []
  const createdUserIds: string[] = []
  const createdCharacterIds: string[] = []

  beforeAll(() => {
    process.env.AUTH_SECRET = AUTH_SECRET
  })

  afterAll(async () => {
    if (createdIds.length === 0 && createdCharacterIds.length === 0) return
    // Drop the associations that reference a definition/character this suite
    // created, in FK-safe order: associations -> definitions -> characters ->
    // users. The title-guard test links a character to a title, so deleting the
    // title definition before its association would violate the
    // `character_associations_definitionId_fkey` constraint.
    await prisma.characterAssociation.deleteMany({
      where: {
        OR: [
          { definitionId: { in: [...createdIds] } },
          { characterId: { in: [...createdCharacterIds] } },
        ],
      },
    })
    await prisma.catalogDefinition.deleteMany({
      where: { id: { in: [...createdIds] } },
    })
    await prisma.character.deleteMany({
      where: { id: { in: [...createdCharacterIds] } },
    })
    await prisma.user.deleteMany({
      where: { id: { in: [...createdUserIds] } },
    })
  })

  async function seedItems(stableId: string, name: string) {
    const row = await prisma.catalogDefinition.create({
      data: {
        kind: "items",
        stableId,
        name,
        config: { seeded: true },
      },
    })
    createdIds.push(row.id)
    return row
  }

  async function seedGod(stableId: string, archived = false) {
    const row = await prisma.catalogDefinition.create({
      data: {
        kind: "gods",
        stableId,
        name: `God ${stableId}`,
        config: {},
        archived,
      },
    })
    createdIds.push(row.id)
    return row
  }

  async function seedUserChar() {
    const user = await prisma.user.create({
      data: {
        email: `mcp-publish-${runSuffix}-${createdIds.length}@example.com`,
        password: "x".repeat(12),
      },
    })
    createdUserIds.push(user.id)
    const char = await prisma.character.create({
      data: {
        ownerId: user.id,
        name: "MCP Character",
        origin: "integrated",
        state: {},
      },
    })
    createdCharacterIds.push(char.id)
    return { userId: user.id, characterId: char.id }
  }

  async function mintTicket(entries: ManagedCatalogEntry[]) {
    const payloadDigest = computeManagedPayloadDigest(entries)
    const rows = await prisma.catalogDefinition.findMany({})
    const stateDigest = computeManagedStateDigest(rows)
    return issueMcpPreviewTicket(payloadDigest, stateDigest)
  }

  function managedEntries(entries: unknown[]): ManagedCatalogEntry[] {
    return entries as ManagedCatalogEntry[]
  }

  it("preview writes nothing; apply commits; reapply is unchanged", async () => {
    const s = stable("preview-apply")
    const entries = managedEntries([
      {
        kind: "items",
        stableId: s,
        name: `Item ${s}`,
        config: { seeded: true },
      },
    ])

    const preview = await previewManagedCatalog(entries)
    expect(preview.changes).toHaveLength(1)
    expect(preview.changes[0].status).toBe("create")

    // The preview ROLLED BACK: no row persisted.
    const afterPreview = await prisma.catalogDefinition.findUnique({
      where: { kind_stableId: { kind: "items", stableId: s } },
    })
    expect(afterPreview).toBeNull()

    const applied = await applyManagedCatalog(entries, preview.previewTicket)
    expect(applied.changes[0].status).toBe("create")
    createdIds.push(applied.changes[0].after.id)

    const persisted = await prisma.catalogDefinition.findUnique({
      where: { id: applied.changes[0].after.id },
    })
    expect(persisted).not.toBeNull()
    expect(persisted?.archived).toBe(false)

    // Reapply the same batch. The apply committed rows, so the state digest
    // changed and the original ticket is now stale by design; a publisher must
    // re-preview against the post-apply state first. Re-preview sees the key
    // exists and is identical, so a fresh apply reports unchanged and writes
    // no second row.
    const refreshed = await previewManagedCatalog(entries)
    const reapplied = await applyManagedCatalog(
      entries,
      refreshed.previewTicket
    )
    expect(reapplied.changes[0].status).toBe("unchanged")
    expect(reapplied.changes[0].changedFields).toEqual([])
    expect(reapplied.stateDigest).toBe(refreshed.stateDigest)

    const sameCount = await prisma.catalogDefinition.count({
      where: { kind: "items", stableId: s },
    })
    expect(sameCount).toBe(1)
  })

  it("rejects a stale preview token when an unrelated new key is added", async () => {
    const s = stable("stale")
    const entries = managedEntries([
      { kind: "items", stableId: s, name: `Item ${s}`, config: {} },
    ])
    const preview = await previewManagedCatalog(entries)

    // An unrelated catalog edit lands between preview and apply.
    await seedItems(stable("unrelated"), "Unrelated")

    await expect(
      applyManagedCatalog(entries, preview.previewTicket)
    ).rejects.toMatchObject({ status: 409, code: "preview_stale" })
  })

  it("orders a valid forward reference so the referenced god is written first", async () => {
    const godStable = stable("fw-god")
    const equipStable = stable("fw-equip")
    const entries = managedEntries([
      {
        kind: "equipment",
        stableId: equipStable,
        name: `Gear ${equipStable}`,
        config: {
          slot: "Head",
          rarity: "Common",
          requiredGodStableId: godStable,
        },
      },
      {
        kind: "gods",
        stableId: godStable,
        name: `God ${godStable}`,
        config: {},
      },
    ])
    const preview = await previewManagedCatalog(entries)
    expect(preview.changes).toHaveLength(2)
    expect(preview.changes.every((c) => c.status === "create")).toBe(true)

    const applied = await applyManagedCatalog(entries, preview.previewTicket)
    for (const change of applied.changes) createdIds.push(change.after.id)

    const god = await prisma.catalogDefinition.findUnique({
      where: { kind_stableId: { kind: "gods", stableId: godStable } },
    })
    const equip = await prisma.catalogDefinition.findUnique({
      where: { kind_stableId: { kind: "equipment", stableId: equipStable } },
    })
    expect(god).not.toBeNull()
    expect(equip).not.toBeNull()
  })

  it("rejects an archived existing key with 409", async () => {
    const s = stable("archived")
    await seedGod(s, true)
    const entries = managedEntries([
      { kind: "gods", stableId: s, name: `God ${s}`, config: {} },
    ])
    await expect(previewManagedCatalog(entries)).rejects.toMatchObject({
      status: 409,
      code: "catalog_archived_conflict",
    })
  })

  it("rolls back the whole apply when a later guard fails (no partial rows)", async () => {
    const titleStable = stable("ranked")
    const itemStable = stable("new-item")
    const title = await prisma.catalogDefinition.create({
      data: {
        kind: "titles",
        stableId: titleStable,
        name: "Ranked",
        grade: "C",
        config: {
          improvement: { seriesId: "s1", rank: 1, minRaceGrade: "F" },
          upgradeGroup: "s1",
          flat: { strength: 2 },
        },
      },
    })
    createdIds.push(title.id)
    const { characterId } = await seedUserChar()
    await prisma.characterAssociation.create({
      data: { characterId, definitionId: title.id, kind: "TITLE" },
    })

    const entries = managedEntries([
      {
        kind: "items",
        stableId: itemStable,
        name: `Item ${itemStable}`,
        config: {},
      },
      {
        kind: "titles",
        stableId: titleStable,
        name: "Ranked",
        grade: "C",
        config: {
          improvement: { seriesId: "s2", rank: 1, minRaceGrade: "F" },
          upgradeGroup: "s2",
          flat: { strength: 2 },
        },
      },
    ])

    const ticket = await mintTicket(entries)
    await expect(applyManagedCatalog(entries, ticket)).rejects.toMatchObject({
      status: 409,
      code: "title_improvement_conflict",
    })

    // The item create rolled back with the title update: no row with that key.
    const item = await prisma.catalogDefinition.findUnique({
      where: { kind_stableId: { kind: "items", stableId: itemStable } },
    })
    expect(item).toBeNull()
    const persistedTitle = await prisma.catalogDefinition.findUnique({
      where: { id: title.id },
    })
    expect(persistedTitle?.config).toMatchObject({
      improvement: { seriesId: "s1", rank: 1, minRaceGrade: "F" },
    })
  })

  it("concurrent applies for the same new key: no partial write, never a 500", async () => {
    const s = stable("concurrent")
    const entries = managedEntries([
      { kind: "items", stableId: s, name: `Item ${s}`, config: {} },
    ])
    const preview = await previewManagedCatalog(entries)

    const results = await Promise.allSettled([
      applyManagedCatalog(entries, preview.previewTicket),
      applyManagedCatalog(entries, preview.previewTicket),
    ])

    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)

    const reason = (rejected[0] as PromiseRejectedResult).reason as {
      status?: number
      code?: string
    }
    // The loser must never surface as a raw 500 and must be a 409 conflict (a
    // serialization/unique conflict or, if the winner committed before the
    // loser's snapshot, a preview_stale - both are 409s).
    expect(reason.status).toBe(409)
    expect([409]).toContain(reason.status)

    const rowCount = await prisma.catalogDefinition.count({
      where: { kind: "items", stableId: s },
    })
    expect(rowCount).toBe(1)
    const winner = fulfilled[0] as PromiseFulfilledResult<
      Awaited<ReturnType<typeof applyManagedCatalog>>
    >
    createdIds.push(winner.value.changes[0].after.id)
  })
})
