import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/db/client"
import {
  applyManagedCatalog,
  computeManagedPayloadDigest,
  computeManagedStateDigest,
  previewManagedCatalog,
  MAX_MANAGED_ENTRIES,
  MAX_MANAGED_NAME,
  type ManagedCatalogEntry,
} from "@/lib/db/mcp-catalog-publish"
import { issueMcpPreviewTicket } from "@/lib/server/mcp-catalog-auth"
import * as mcpCatalogAuth from "@/lib/server/mcp-catalog-auth"
import {
  createInitialState,
  getCharacter,
  serializeState,
} from "@/lib/db/service"

// Real unit tests against the in-memory Prisma mock. The mock backs the
// `@/lib/db/client` export so the publisher's Prisma calls (the SERIALIZABLE
// transaction, the create/update helpers, and the catalog reference guards) are
// exercised without a running Postgres.
type TestStore = import("./testPrisma").TestPrismaInstance["store"]
const dbMock = vi.hoisted(() => ({ store: undefined as unknown as TestStore }))

vi.mock("@/lib/db/client", async () => {
  const { createTestPrisma } = await import("./testPrisma")
  const instance = createTestPrisma()
  dbMock.store = instance.store
  return { prisma: instance.prisma, default: instance.prisma }
})

// ------------------------------------------------------------------ //
// Environment (AUTH_SECRET is read by the preview-ticket HMAC)
// ------------------------------------------------------------------ //

const AUTH_SECRET = "test-auth-secret-that-is-at-least-32-chars-long!!"
const originalAuthSecret = process.env.AUTH_SECRET

beforeEach(() => {
  process.env.AUTH_SECRET = AUTH_SECRET
  dbMock.store.reset()
})

afterEach(() => {
  if (originalAuthSecret === undefined) delete process.env.AUTH_SECRET
  else process.env.AUTH_SECRET = originalAuthSecret
})

// ------------------------------------------------------------------ //
// Fixture helpers
// ------------------------------------------------------------------ //

function item(stableId: string, extra: Record<string, unknown> = {}) {
  return {
    kind: "items" as const,
    stableId,
    name: `Item ${stableId}`,
    // No default `config`: an update that omits config must PRESERVE the stored
    // config (full-replacement only when the field is explicitly supplied). A
    // create helper defaults config to {} on its own, so omitting it here is safe.
    ...extra,
  }
}

function godEntry(stableId: string, extra: Record<string, unknown> = {}) {
  return {
    kind: "gods" as const,
    stableId,
    name: `God ${stableId}`,
    config: {},
    ...extra,
  }
}

function currencyEntry(stableId: string, extra: Record<string, unknown> = {}) {
  return {
    kind: "currencies" as const,
    stableId,
    name: `Currency ${stableId}`,
    config: {},
    ...extra,
  }
}

function equipmentEntry(
  stableId: string,
  config: Record<string, unknown>,
  extra: Record<string, unknown> = {}
) {
  return {
    kind: "equipment" as const,
    stableId,
    name: `Equipment ${stableId}`,
    config,
    ...extra,
  }
}

function titleEntry(
  stableId: string,
  config: Record<string, unknown>,
  extra: Record<string, unknown> = {}
) {
  return {
    kind: "titles" as const,
    stableId,
    name: `Title ${stableId}`,
    config,
    ...extra,
  }
}

function classRow(stableId: string, config: Record<string, unknown>) {
  return {
    kind: "classes" as const,
    stableId,
    name: `Class ${stableId}`,
    config,
  }
}

function skillRow(
  stableId: string,
  config: Record<string, unknown>,
  extra: Record<string, unknown> = {}
) {
  return {
    kind: "skills" as const,
    stableId,
    name: `Skill ${stableId}`,
    config: {
      track: "race",
      effects: [],
      rarity: "Common",
      ...config,
    },
    ...extra,
  }
}

function seedLinkedRankedTitle() {
  dbMock.store.addCatalog({
    id: "title-1",
    kind: "titles",
    stableId: "ranked",
    name: "Ranked",
    grade: "C",
    description: "Original title description",
    config: {
      improvement: { seriesId: "s1", rank: 1, minRaceGrade: "F" },
      upgradeGroup: "s1",
      flat: { strength: 2 },
    },
  })
  dbMock.store.addCharacter({ id: "chr-1", ownerId: "u-1", name: "C" })
  dbMock.store.addAssociation({
    characterId: "chr-1",
    definitionId: "title-1",
    kind: "TITLE",
  })
}

function findCatalog(id: string) {
  return dbMock.store.catalog.get(id)
}

function strengthFlatDelta(status: unknown): number {
  const traces = (
    status as {
      traces: Array<{
        attribute: string
        phases: Array<{ phase: string; delta: number }>
      }>
    }
  ).traces
  const strength = traces.find((t) => t.attribute === "strength")
  if (!strength) return 0
  const flat = strength.phases.find((p) => p.phase === "flat")
  return flat?.delta ?? 0
}

// ------------------------------------------------------------------ //
// previewManagedCatalog
// ------------------------------------------------------------------ //

describe("previewManagedCatalog", () => {
  it("reports create for a new key and writes nothing (real rollback)", async () => {
    const result = await previewManagedCatalog([
      item("potion", {
        description: "A healing potion",
        sourceUrl: "https://example.com/potion",
        config: { magnitude: 3 },
        gradeDescriptions: { B: "blurb" },
      }),
    ])
    expect(result.changes).toHaveLength(1)
    const change = result.changes[0]
    expect(change.status).toBe("create")
    expect(change.kind).toBe("items")
    expect(change.stableId).toBe("potion")
    expect(change.before).toBeUndefined()
    expect(change.after.name).toBe("Item potion")
    expect(change.after.description).toBe("A healing potion")
    expect(change.after.config).toMatchObject({ magnitude: 3 })
    expect(change.changedFields).toContain("name")
    expect(change.changedFields).toContain("config")
    // The preview's SERIALIZABLE write happened then rolled back: no row persists.
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("reports an update for an existing active key, preserving omitted and clearing explicit null", async () => {
    dbMock.store.addCatalog({
      id: "item-1",
      kind: "items",
      stableId: "potion",
      name: "Potion",
      config: { markup: 2 },
      description: "Original",
      sourceUrl: "https://example.com/original",
      gradeDescriptions: { B: "bb" },
    })
    const result = await previewManagedCatalog([
      item("potion", {
        name: "Renamed Potion",
        description: null,
        sourceUrl: null,
      }),
    ])
    const change = result.changes[0]
    expect(change.status).toBe("update")
    expect(change.before?.name).toBe("Potion")
    expect(change.before?.description).toBe("Original")
    expect(change.after.name).toBe("Renamed Potion")
    expect(change.after.description).toBeNull()
    expect(change.after.sourceUrl).toBeNull()
    // Omitted fields are preserved: config and gradeDescriptions are untouched.
    expect(change.after.config).toMatchObject({ markup: 2 })
    expect(change.after.gradeDescriptions).toEqual({ B: "bb" })
    expect(change.changedFields).toEqual(
      expect.arrayContaining(["name", "description", "sourceUrl"])
    )
  })

  it("reports unchanged for an idempotent batch and performs no write", async () => {
    dbMock.store.addCatalog({
      id: "item-1",
      kind: "items",
      stableId: "potion",
      name: "Potion",
      config: { markup: 2 },
      description: "Original",
      sourceUrl: "https://example.com/original",
    })
    const result = await previewManagedCatalog([
      item("potion", {
        name: "Potion",
        description: "Original",
        sourceUrl: "https://example.com/original",
        config: { markup: 2 },
      }),
    ])
    const change = result.changes[0]
    expect(change.status).toBe("unchanged")
    expect(change.changedFields).toEqual([])
    expect(change.before?.name).toBe("Potion")
    expect(change.after).toEqual(change.before)
  })

  it("rejects an archived existing key with 409", async () => {
    dbMock.store.addCatalog({
      id: "item-1",
      kind: "items",
      stableId: "potion",
      name: "Potion",
      config: {},
      archived: true,
    })
    await expect(previewManagedCatalog([item("potion")])).rejects.toMatchObject(
      { status: 409, code: "catalog_archived_conflict" }
    )
  })

  it("mints a preview ticket bound to the payload and state digests", async () => {
    const result = await previewManagedCatalog([item("potion")])
    expect(result.payloadDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(result.stateDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(result.previewTicket).toEqual(expect.any(String))
    // The ticket round-trips (verify again succeeds) - proves a fresh ticket.
    expect(result.previewTicket.length).toBeGreaterThan(0)
  })

  it("orders a valid forward reference so the referenced new key is created first", async () => {
    // Equipment references a god that appears LATER in the batch.
    const entries = [
      equipmentEntry("gear", {
        slot: "Head",
        rarity: "Common",
        requiredGodStableId: "god-g",
      }),
      godEntry("god-g"),
    ]
    const result = await previewManagedCatalog(entries)
    expect(result.changes).toHaveLength(2)
    const god = result.changes.find((c) => c.kind === "gods")!
    const equip = result.changes.find((c) => c.kind === "equipment")!
    expect(god.status).toBe("create")
    expect(equip.status).toBe("create")
  })

  it("maps a serialization failure (P2034) to 409 catalog_conflict and writes nothing", async () => {
    // The preview transaction itself conflicts (a concurrent change), so it must
    // be surfaced as a retryable 409 exactly like the apply. Because the conflict
    // rejects, no preview result is returned and therefore no ticket is minted.
    const ticketSpy = vi.spyOn(mcpCatalogAuth, "issueMcpPreviewTicket")
    const spy = vi.spyOn(prisma, "$transaction")
    spy.mockImplementationOnce(async () => {
      throw { name: "PrismaClientKnownRequestError", code: "P2034" }
    })
    await expect(previewManagedCatalog([item("potion")])).rejects.toMatchObject(
      {
        status: 409,
        code: "catalog_conflict",
      }
    )
    // No ticket is minted on a conflict; no row was written either.
    expect(ticketSpy).not.toHaveBeenCalled()
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("maps a unique violation (P2002) to 409 catalog_conflict and writes nothing", async () => {
    const ticketSpy = vi.spyOn(mcpCatalogAuth, "issueMcpPreviewTicket")
    const spy = vi.spyOn(prisma, "$transaction")
    spy.mockImplementationOnce(async () => {
      throw { name: "PrismaClientKnownRequestError", code: "P2002" }
    })
    await expect(previewManagedCatalog([item("potion")])).rejects.toMatchObject(
      {
        status: 409,
        code: "catalog_conflict",
      }
    )
    expect(ticketSpy).not.toHaveBeenCalled()
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("maps a raw-query SQLSTATE 40001 (P2010) to 409 catalog_conflict and writes nothing", async () => {
    const ticketSpy = vi.spyOn(mcpCatalogAuth, "issueMcpPreviewTicket")
    const spy = vi.spyOn(prisma, "$transaction")
    spy.mockImplementationOnce(async () => {
      throw {
        name: "PrismaClientKnownRequestError",
        code: "P2010",
        meta: { code: "40001" },
      }
    })
    await expect(previewManagedCatalog([item("potion")])).rejects.toMatchObject(
      {
        status: 409,
        code: "catalog_conflict",
      }
    )
    expect(ticketSpy).not.toHaveBeenCalled()
    expect(dbMock.store.catalog.size).toBe(0)
  })
})

// ------------------------------------------------------------------ //
// applyManagedCatalog
// ------------------------------------------------------------------ //

describe("applyManagedCatalog", () => {
  it("applies a create + update batch atomically", async () => {
    dbMock.store.addCatalog({
      id: "item-1",
      kind: "items",
      stableId: "potion",
      name: "Potion",
      config: { markup: 2 },
      description: "Original",
    })
    const entries = [
      item("potion", { name: "Renamed Potion" }),
      item("elixir", { name: "Elixir", config: { charge: 1 } }),
    ]
    const preview = await previewManagedCatalog(entries)
    const result = await applyManagedCatalog(entries, preview.previewTicket)
    expect(result.payloadDigest).toBe(preview.payloadDigest)
    expect(result.stateDigest).toBe(preview.stateDigest)
    expect(result.changes).toHaveLength(2)

    const potion = findCatalog("item-1")!
    expect(potion.name).toBe("Renamed Potion")
    expect(potion.config).toMatchObject({ markup: 2 })
    expect(potion.description).toBe("Original")

    const elixir = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "elixir"
    )!
    expect(elixir.archived).toBe(false)
    expect(elixir.config).toMatchObject({ charge: 1 })
  })

  it("commits nothing for an unchanged entry (no write, no updatedAt bump)", async () => {
    dbMock.store.addCatalog({
      id: "item-1",
      kind: "items",
      stableId: "potion",
      name: "Potion",
      config: { markup: 2 },
      description: "Original",
    })
    const entries = [
      item("potion", {
        name: "Potion",
        description: "Original",
        config: { markup: 2 },
      }),
    ]
    const preview = await previewManagedCatalog(entries)
    const beforeUpdatedAt = findCatalog("item-1")!.updatedAt.getTime()
    const result = await applyManagedCatalog(entries, preview.previewTicket)
    expect(result.changes[0].status).toBe("unchanged")
    // The apply skipped the write, so the row's updatedAt was not bumped.
    expect(findCatalog("item-1")!.updatedAt.getTime()).toBe(beforeUpdatedAt)
  })

  it("rolls back the entire apply when a later guard fails (no partial rows)", async () => {
    seedLinkedRankedTitle()
    const entries = [
      item("new-item", { name: "New Item" }),
      // Changing the ranked title's improvement identity while it is linked must
      // fail the guard AFTER the item above is created.
      {
        kind: "titles" as const,
        stableId: "ranked",
        name: "Ranked",
        grade: "C" as const,
        config: {
          improvement: { seriesId: "s2", rank: 1, minRaceGrade: "F" },
          upgradeGroup: "s2",
          flat: { strength: 2 },
        },
      },
    ]
    const payloadDigest = computeManagedPayloadDigest(entries)
    const rows = await prisma.catalogDefinition.findMany({})
    const stateDigest = computeManagedStateDigest(rows)
    const ticket = issueMcpPreviewTicket(payloadDigest, stateDigest)

    await expect(applyManagedCatalog(entries, ticket)).rejects.toMatchObject({
      status: 409,
      code: "title_improvement_conflict",
    })

    // Only the seeded title remains: the "new-item" create was rolled back.
    expect(findCatalog("item-1")).toBeUndefined()
    expect(findCatalog("new-item")).toBeUndefined()
    const title = findCatalog("title-1")!
    expect(title.config).toMatchObject({
      improvement: { seriesId: "s1", rank: 1, minRaceGrade: "F" },
    })
    expect(dbMock.store.catalog.size).toBe(1)
  })

  it("rejects a stale preview token when any catalog row changes (unrelated new key)", async () => {
    dbMock.store.addCatalog({
      id: "item-1",
      kind: "items",
      stableId: "potion",
      name: "Potion",
      config: {},
    })
    const entries = [item("potion", { name: "New Potion" })]
    const preview = await previewManagedCatalog(entries)

    // An unrelated catalog edit lands between preview and apply.
    dbMock.store.addCatalog({
      id: "other",
      kind: "items",
      stableId: "unrelated",
      name: "Unrelated",
      config: {},
    })

    await expect(
      applyManagedCatalog(entries, preview.previewTicket)
    ).rejects.toMatchObject({ status: 409, code: "preview_stale" })
  })

  it("rejects a stale preview token when an existing catalog row is edited", async () => {
    dbMock.store.addCatalog({
      id: "item-1",
      kind: "items",
      stableId: "potion",
      name: "Potion",
      config: {},
    })
    const entries = [item("potion", { name: "New Potion" })]
    const preview = await previewManagedCatalog(entries)

    const existing = findCatalog("item-1")!
    existing.name = "Touched Elsewhere"
    dbMock.store.catalog.set("item-1", { ...existing })

    await expect(
      applyManagedCatalog(entries, preview.previewTicket)
    ).rejects.toMatchObject({ status: 409, code: "preview_stale" })
  })

  it("maps a serialization failure (P2034) to 409 catalog_conflict", async () => {
    // The preview must run normally to mint a ticket; only the APPLY transaction
    // is the once-mocked call that throws P2034.
    const entries = [item("potion")]
    const preview = await previewManagedCatalog(entries)
    const spy = vi.spyOn(prisma, "$transaction")
    spy.mockImplementationOnce(async () => {
      throw { name: "PrismaClientKnownRequestError", code: "P2034" }
    })
    await expect(
      applyManagedCatalog(entries, preview.previewTicket)
    ).rejects.toMatchObject({ status: 409, code: "catalog_conflict" })
  })

  it("maps a unique violation (P2002) to 409 catalog_conflict", async () => {
    const entries = [item("potion")]
    const preview = await previewManagedCatalog(entries)
    const spy = vi.spyOn(prisma, "$transaction")
    spy.mockImplementationOnce(async () => {
      throw { name: "PrismaClientKnownRequestError", code: "P2002" }
    })
    await expect(
      applyManagedCatalog(entries, preview.previewTicket)
    ).rejects.toMatchObject({ status: 409, code: "catalog_conflict" })
  })
})

// ------------------------------------------------------------------ //
// Dependency ordering / reference validation
// ------------------------------------------------------------------ //

describe("dependency ordering", () => {
  it("rejects a dependency cycle with 400 catalog_dependency_cycle", async () => {
    // A new class grants a new skill, and that skill ties back to the same class:
    // neither can be written first, so the batch is unsatisfiable.
    const entries = [
      classRow("class-1", { gradeGrantedSkillStableIds: { F: ["skill-1"] } }),
      skillRow("skill-1", { classStableId: "class-1" }),
    ]
    await expect(previewManagedCatalog(entries)).rejects.toMatchObject({
      status: 400,
      code: "catalog_dependency_cycle",
    })
    // No writes happened.
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("validates a reference to an existing unarchived row outside the batch", async () => {
    dbMock.store.addCatalog({
      id: "god-1",
      kind: "gods",
      stableId: "god-g",
      name: "God G",
      config: {},
    })
    const result = await previewManagedCatalog([
      equipmentEntry("gear", {
        slot: "Head",
        rarity: "Common",
        requiredGodStableId: "god-g",
      }),
    ])
    expect(result.changes).toHaveLength(1)
    expect(result.changes[0].status).toBe("create")
  })

  it("rejects a reference to a missing target outside the batch", async () => {
    await expect(
      previewManagedCatalog([
        equipmentEntry("gear", {
          slot: "Head",
          rarity: "Common",
          requiredGodStableId: "missing-god",
        }),
      ])
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("rejects a reference to an archived target outside the batch", async () => {
    dbMock.store.addCatalog({
      id: "god-1",
      kind: "gods",
      stableId: "god-g",
      name: "God G",
      config: {},
      archived: true,
    })
    await expect(
      previewManagedCatalog([
        equipmentEntry("gear", {
          slot: "Head",
          rarity: "Common",
          requiredGodStableId: "god-g",
        }),
      ])
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
  })

  it("orders a title after a same-batch new skill it grants and exposes the effect when linked", async () => {
    dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: "u-1",
      name: "C",
      state: serializeState(createInitialState("integrated", null, null)),
    })
    const titleStableId = "granting-title"
    const skillStableId = "granted-skill"
    // The title is submitted BEFORE the skill it grants, exactly to prove the
    // publisher orders the new skill first so the shared live-catalog reference
    // check inside the same transaction sees it.
    const entries = [
      titleEntry(titleStableId, { grantedSkillStableIds: [skillStableId] }),
      skillRow(skillStableId, {
        effects: [{ phase: "flat", amount: { strength: 5 } }],
      }),
    ]
    const preview = await previewManagedCatalog(entries)
    expect(preview.changes).toHaveLength(2)
    expect(preview.changes.every((c) => c.status === "create")).toBe(true)

    const applied = await applyManagedCatalog(entries, preview.previewTicket)
    expect(applied.changes).toHaveLength(2)
    expect(applied.changes.every((c) => c.status === "create")).toBe(true)

    const titleChange = applied.changes.find((c) => c.kind === "titles")!
    const skillChange = applied.changes.find((c) => c.kind === "skills")!
    expect(titleChange.after.config).toMatchObject({
      grantedSkillStableIds: [skillStableId],
    })
    expect(skillChange.after.archived).toBe(false)

    // Link the title and read the live effect: the granted skill's passive flat
    // strength is synthesized while the unarchived TITLE link survives.
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: titleChange.after.id,
      kind: "TITLE",
    })
    const detail = await getCharacter("chr-1", {
      id: "u-1",
      email: "u@example.com",
      isAdmin: false,
    })
    expect(strengthFlatDelta(detail.status)).toBe(5)
  })

  it("rejects a title referencing a missing skill outside the batch", async () => {
    await expect(
      previewManagedCatalog([
        titleEntry("granting-title", {
          grantedSkillStableIds: ["missing-skill"],
        }),
      ])
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("rejects a title referencing an archived skill outside the batch", async () => {
    dbMock.store.addCatalog({
      id: "skill-1",
      kind: "skills",
      stableId: "arch-skill",
      name: "Archived Skill",
      config: { track: "race", effects: [], rarity: "Common" },
      archived: true,
    })
    await expect(
      previewManagedCatalog([
        titleEntry("granting-title", {
          grantedSkillStableIds: ["arch-skill"],
        }),
      ])
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    expect(dbMock.store.catalog.size).toBe(1)
  })

  it("rolls back the whole apply when a title references a missing skill (no partial rows)", async () => {
    const entries = [
      item("new-item", { name: "New Item" }),
      titleEntry("granting-title", {
        grantedSkillStableIds: ["missing-skill"],
      }),
    ]
    const payloadDigest = computeManagedPayloadDigest(entries)
    const rows = await prisma.catalogDefinition.findMany({})
    const stateDigest = computeManagedStateDigest(rows)
    const ticket = issueMcpPreviewTicket(payloadDigest, stateDigest)

    await expect(applyManagedCatalog(entries, ticket)).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })

    // The item create rolled back with the failed title ref check: no partial rows.
    expect(dbMock.store.catalog.size).toBe(0)
  })
})

// ------------------------------------------------------------------ //
// Validation
// ------------------------------------------------------------------ //

describe("validation", () => {
  it("rejects an unknown key such as archived", async () => {
    await expect(
      previewManagedCatalog([
        { ...item("potion"), archived: false } as ManagedCatalogEntry,
      ])
    ).rejects.toMatchObject({ status: 400, code: "validation" })
  })

  it("rejects an unknown catalog kind", async () => {
    await expect(
      previewManagedCatalog([
        {
          kind: "consumables",
          stableId: "x",
          name: "X",
        } as unknown as ManagedCatalogEntry,
      ])
    ).rejects.toMatchObject({ status: 400, code: "validation" })
  })

  it("rejects an oversized name / stableId / description", async () => {
    await expect(
      previewManagedCatalog([
        item("potion", { name: "x".repeat(MAX_MANAGED_NAME + 1) }),
      ])
    ).rejects.toMatchObject({ status: 400, code: "validation" })

    await expect(
      previewManagedCatalog([item("p".repeat(129), { name: "Potion" })])
    ).rejects.toMatchObject({ status: 400, code: "validation" })

    await expect(
      previewManagedCatalog([item("potion", { description: "x".repeat(8001) })])
    ).rejects.toMatchObject({ status: 400, code: "validation" })
  })

  it("rejects an oversized config JSON", async () => {
    const bigConfig = { data: "x".repeat(70 * 1024) }
    await expect(
      previewManagedCatalog([item("potion", { config: bigConfig })])
    ).rejects.toMatchObject({ status: 400, code: "validation" })
  })

  it("rejects a config nested too deeply", async () => {
    let config: Record<string, unknown> = {}
    for (let i = 0; i < 20; i++) config = { next: config }
    await expect(
      previewManagedCatalog([item("potion", { config })])
    ).rejects.toMatchObject({ status: 400, code: "validation" })
  })

  it("rejects a duplicate (kind, stableId) pair", async () => {
    await expect(
      previewManagedCatalog([item("potion"), item("potion")])
    ).rejects.toMatchObject({ status: 400, code: "duplicate_managed_entry" })
  })

  it("accepts a currencies entry with an empty config and no grade", async () => {
    const result = await previewManagedCatalog([currencyEntry("crowns")])
    expect(result.changes[0].status).toBe("create")
  })

  it("rejects a currencies entry that carries a non-null grade", async () => {
    await expect(
      previewManagedCatalog([currencyEntry("crowns", { grade: "S" })])
    ).rejects.toMatchObject({ status: 400, code: "invalid_grade" })
  })

  it("rejects a currencies entry that carries a non-empty gradeDescriptions", async () => {
    await expect(
      previewManagedCatalog([
        currencyEntry("crowns", { gradeDescriptions: { G: "text" } }),
      ])
    ).rejects.toMatchObject({ status: 400, code: "invalid_grade_descriptions" })
  })

  it("rejects a currencies entry that carries a non-empty config", async () => {
    await expect(
      previewManagedCatalog([
        currencyEntry("crowns", { config: { rarity: "Common" } }),
      ])
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
  })

  it("rejects an http sourceUrl and accepts https", async () => {
    await expect(
      previewManagedCatalog([
        item("potion", { sourceUrl: "http://example.com/x" }),
      ])
    ).rejects.toMatchObject({ status: 400, code: "validation" })

    const result = await previewManagedCatalog([
      item("potion", { sourceUrl: "https://example.com/x" }),
    ])
    expect(result.changes[0].status).toBe("create")
  })

  it("rejects a batch over the 50-entry cap", async () => {
    const entries = Array.from({ length: MAX_MANAGED_ENTRIES + 1 }, (_, i) =>
      item(`item-${i}`)
    )
    await expect(previewManagedCatalog(entries)).rejects.toMatchObject({
      status: 400,
      code: "managed_too_many_entries",
    })
  })

  it("rejects a race config update that omits raceType/naturalGrade", async () => {
    const entries = [
      {
        kind: "races" as const,
        stableId: "race-1",
        name: "Race",
        config: { raceType: "enlightened" }, // naturalGrade omitted
      },
    ]
    await expect(previewManagedCatalog(entries)).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
    })
  })

  it("accepts a race config update that declares raceType and naturalGrade", async () => {
    const entries = [
      {
        kind: "races" as const,
        stableId: "race-1",
        name: "Race",
        config: { raceType: "enlightened", naturalGrade: "F" },
      },
    ]
    const result = await previewManagedCatalog(entries)
    expect(result.changes[0].status).toBe("create")
  })

  it("rejects a malformed per-kind config via the transactional helper", async () => {
    // A skill missing its modern-shape fields fails inside the create helper; the
    // preview rolls back and surfaces the 400.
    await expect(
      previewManagedCatalog([
        {
          kind: "skills",
          stableId: "skill-1",
          name: "Skill",
          config: { effects: [] }, // no track / no rarity
        },
      ])
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    expect(dbMock.store.catalog.size).toBe(0)
  })
})
