/**
 * Tests for scripts/mcp/publish-skill-links.mjs - the guarded post-deployment
 * publisher for the committed skill upgrade-link plan.
 *
 * These tests never open a network socket and never touch a database: every
 * `fetch` is a mock, and the plan is read from the committed
 * `docs/catalog/skill-upgrade-link-plan.json` on disk. The module performs no
 * network request and no file read at import time, so importing it here is safe.
 */

import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  run,
  parseArgs,
  validateOrigin,
  validateToken,
  resolveConfigFromEnv,
  rarityOrderIndex,
  validatePlanShape,
  validatePreviewResponse,
  buildEntries,
  captureSourceSnapshot,
  safeErrorMessage,
  SKILLS_KIND,
  TARGET_LABEL,
  printResult,
  CONFIRM_PHRASE,
  CATALOG_LIST_PATH,
  CATALOG_ENTRY_PATH,
  CATALOG_PREVIEW_PATH,
  CATALOG_APPLY_PATH,
} from "./publish-skill-links.mjs"

const ORIGIN = "https://catalog.example.com"
const TOKEN = "A".repeat(43)

interface PlanItem {
  stableId: string
  name: string
  rarity: string
}

interface PlanLink {
  source: PlanItem
  targets: PlanItem[]
}

interface Plan {
  kind?: string
  snapshotCount?: number
  archivedCount?: number
  edgeCount?: number
  upgradeLinks: PlanLink[]
}

interface SkillConfig {
  track?: string
  rarity?: string
  upgradeToStableIds?: string[]
  effects?: unknown[]
  milestone?: number
  choiceGroup?: string
  upgradeGroup?: string
  [key: string]: unknown
}

interface SkillRecord {
  kind: string
  stableId: string
  name: string
  description: string | null
  grade: string | null
  sourceUrl: string | null
  archived: boolean
  config: SkillConfig
  gradeDescriptions: Record<string, string>
}

interface CatalogListItem {
  kind: string
  stableId: string
  name: string
  grade: string | null
  sourceUrl: string | null
  archived: boolean
}

interface BatchEntry {
  kind: string
  stableId: string
  name: string
  config: SkillConfig
  [key: string]: unknown
}

// ------------------------------------------------------------------ //
// Fixtures
// ------------------------------------------------------------------ //

function validEnv(
  overrides: Record<string, string | undefined> = {}
): Record<string, string | undefined> {
  return {
    PRIMAL_CATALOG_URL: ORIGIN,
    PRIMAL_CATALOG_TOKEN: TOKEN,
    ...overrides,
  }
}

function executeArgs() {
  return ["--execute", "--confirm", CONFIRM_PHRASE]
}

function jsonResponse(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function loadRealPlan(): Plan {
  const file = fileURLToPath(
    new URL("../../docs/catalog/skill-upgrade-link-plan.json", import.meta.url)
  )
  return JSON.parse(readFileSync(file, "utf8")) as Plan
}

/** Build a stableId -> { name, rarity } index from the plan. */
function buildPlanIndex(plan: Plan): Map<string, PlanItem> {
  const index = new Map<string, PlanItem>()
  for (const link of plan.upgradeLinks) {
    index.set(link.source.stableId, {
      stableId: link.source.stableId,
      name: link.source.name,
      rarity: link.source.rarity,
    })
    for (const target of link.targets) {
      index.set(target.stableId, {
        stableId: target.stableId,
        name: target.name,
        rarity: target.rarity,
      })
    }
  }
  return index
}

function recordFor(item: PlanItem, track = "profession"): SkillRecord {
  return {
    kind: "skills",
    stableId: item.stableId,
    name: item.name,
    description: `Description of ${item.name}.`,
    grade: null,
    sourceUrl: "https://example.com/skills",
    archived: false,
    config: {
      track,
      rarity: item.rarity,
      effects: [
        { kind: "damage", amount: 10, text: `Effect of ${item.name}.` },
      ],
      milestone: 1,
      choiceGroup: "choice",
      upgradeGroup: "family",
    },
    gradeDescriptions: {},
  }
}

/** Build the full mock catalog from the committed plan, then apply overrides. */
function buildCatalog(overrides: Record<string, Partial<SkillRecord>> = {}): {
  plan: Plan
  records: Record<string, SkillRecord>
  listItems: CatalogListItem[]
} {
  const plan = loadRealPlan()
  const index = buildPlanIndex(plan)
  const records: Record<string, SkillRecord> = {}
  for (const id of index.keys()) {
    const item = index.get(id)!
    records[id] = recordFor(item)
  }
  for (const [id, patch] of Object.entries(overrides)) {
    const rec = records[id]
    if (!rec) continue
    const merged: SkillRecord = {
      ...rec,
      ...patch,
      config: { ...rec.config, ...(patch.config ?? {}) },
    }
    records[id] = merged
  }
  const listItems: CatalogListItem[] = Object.values(records).map((r) => ({
    kind: r.kind,
    stableId: r.stableId,
    name: r.name,
    grade: r.grade,
    sourceUrl: r.sourceUrl,
    archived: r.archived,
  }))
  return { plan, records, listItems }
}

/**
 * A fetch mock that serves list + entry + preview + apply for the plan catalog.
 * The apply step mutates `records` so post-apply verification GETs reflect the
 * written edges. Returns the captured calls for assertions.
 */
interface CapturedCall {
  url: string
  method: string
  headers: Headers
  body: string | null
}

/** Build the `after` snapshot a preview/apply change carries for a batch entry. */
function afterForEntry(e: BatchEntry) {
  return {
    name: e.name,
    description: e.description ?? null,
    grade: e.grade ?? null,
    sourceUrl: e.sourceUrl ?? null,
    archived: false,
    config: e.config,
    gradeDescriptions: e.gradeDescriptions ?? {},
  }
}

/** Build the `before` snapshot a preview/apply change carries for a source record. */
function beforeForRecord(rec: SkillRecord | undefined) {
  if (!rec) {
    return {
      name: null,
      description: null,
      sourceUrl: null,
      archived: false,
      grade: null,
      gradeDescriptions: {},
      config: {},
    }
  }
  return {
    name: rec.name,
    description: rec.description,
    sourceUrl: rec.sourceUrl,
    archived: rec.archived,
    grade: rec.grade,
    gradeDescriptions: structuredClone(rec.gradeDescriptions ?? {}),
    config: structuredClone(rec.config ?? {}),
  }
}

/**
 * A fetch mock that serves list + entry + preview + apply for the plan catalog.
 * The apply step mutates `records` so post-apply verification GETs reflect the
 * written edges. Returns the captured calls for assertions.
 */
function makeFetch(
  records: Record<string, SkillRecord>,
  listItems: CatalogListItem[],
  hooks: { list?: () => Response } = {}
): { calls: CapturedCall[]; fetchImpl: typeof fetch } {
  const calls: CapturedCall[] = []
  const fetchImpl = vi.fn(
    async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const u = typeof url === "string" ? url : url.toString()
      const method = init?.method ?? "GET"
      calls.push({
        url: u,
        method,
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : null,
      })
      const parsed = new URL(u)
      const pathname = parsed.pathname
      if (hooks.list && pathname === CATALOG_LIST_PATH) {
        return hooks.list()
      }
      if (pathname === CATALOG_LIST_PATH) {
        return jsonResponse(200, { entries: listItems.map((i) => ({ ...i })) })
      }
      if (pathname === CATALOG_ENTRY_PATH) {
        const stableId = parsed.searchParams.get("stableId") ?? ""
        const rec = records[stableId]
        if (!rec) {
          return jsonResponse(404, {
            error: { code: "catalog_not_found", message: "not found" },
          })
        }
        return jsonResponse(200, { item: rec })
      }
      if (pathname === CATALOG_PREVIEW_PATH) {
        const body = JSON.parse((init?.body as string | undefined) ?? "{}") as {
          entries: BatchEntry[]
        }
        return jsonResponse(200, {
          changes: body.entries.map((e) => ({
            kind: e.kind,
            stableId: e.stableId,
            status: "update",
            changedFields: ["config"],
            before: beforeForRecord(records[e.stableId]),
            after: afterForEntry(e),
          })),
          payloadDigest: "p".repeat(64),
          stateDigest: "s".repeat(64),
          previewTicket: "ticket-1",
        })
      }
      if (pathname === CATALOG_APPLY_PATH) {
        const body = JSON.parse((init?.body as string | undefined) ?? "{}") as {
          entries: BatchEntry[]
        }
        for (const entry of body.entries) {
          if (records[entry.stableId]) {
            records[entry.stableId].config = {
              ...records[entry.stableId].config,
              upgradeToStableIds: entry.config.upgradeToStableIds,
            }
          }
        }
        return jsonResponse(200, {
          changes: body.entries.map((e) => ({
            kind: e.kind,
            stableId: e.stableId,
            status: "update",
            changedFields: ["config"],
            after: afterForEntry(e),
          })),
          payloadDigest: "p".repeat(64),
          stateDigest: "s".repeat(64),
        })
      }
      return jsonResponse(200, [])
    }
  )
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch }
}

function harness(
  overrides: Record<string, Partial<SkillRecord>> = {},
  hooks: { list?: () => Response } = {}
): {
  plan: Plan
  records: Record<string, SkillRecord>
  listItems: CatalogListItem[]
  calls: CapturedCall[]
  fetchImpl: typeof fetch
} {
  const catalog = buildCatalog(overrides)
  const { calls, fetchImpl } = makeFetch(
    catalog.records,
    catalog.listItems,
    hooks
  )
  return { ...catalog, calls, fetchImpl }
}

/** Extract the POST body entries from a captured request matching a path. */
function bodyOf(
  calls: CapturedCall[],
  pathname: string
): { entries: BatchEntry[] } {
  const req = calls.find(
    (c) => c.method === "POST" && new URL(c.url).pathname === pathname
  )
  if (!req) return { entries: [] }
  const parsed = JSON.parse(req.body ?? "{}") as { entries?: BatchEntry[] }
  return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] }
}

/**
 * Wrap a harness fetch so the preview POST returns a caller-controlled
 * `changes` array while every other route stays the base mock. Used to exercise
 * the preview-validation gate without ever applying.
 */
function overridePreview(
  h: ReturnType<typeof harness>,
  buildChanges: (entries: BatchEntry[]) => Array<Record<string, unknown>>
): typeof fetch {
  const base = h.fetchImpl
  return vi.fn(async (url, init) => {
    const pathname = new URL(typeof url === "string" ? url : url.toString())
      .pathname
    if (pathname === CATALOG_PREVIEW_PATH) {
      const body = JSON.parse((init?.body as string | undefined) ?? "{}") as {
        entries: BatchEntry[]
      }
      const changes = buildChanges(body.entries)
      return jsonResponse(200, {
        changes: changes.map((change) => {
          const withBefore = change as Record<string, unknown>
          if (withBefore.before == null) {
            const sid = withBefore.stableId as string | undefined
            return {
              ...withBefore,
              before: beforeForRecord(sid ? h.records[sid] : undefined),
            }
          }
          return withBefore
        }),
        payloadDigest: "p".repeat(64),
        stateDigest: "s".repeat(64),
        previewTicket: "ticket-1",
      })
    }
    return base(url, init)
  })
}

// ------------------------------------------------------------------ //
// Config validation helpers
// ------------------------------------------------------------------ //

describe("validateOrigin", () => {
  it("accepts an HTTPS origin", () => {
    const res = validateOrigin(ORIGIN)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.origin).toBe(ORIGIN)
  })

  it("rejects a non-https URL", () => {
    const res = validateOrigin("http://catalog.example.com")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/https/)
  })

  it("rejects a URL with userinfo", () => {
    const res = validateOrigin("https://user:pass@catalog.example.com")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/userinfo/)
  })
})

describe("validateToken", () => {
  it("accepts a 43-char base64url token", () => {
    expect(validateToken("A".repeat(43)).ok).toBe(true)
  })

  it("rejects a short token", () => {
    const res = validateToken("A".repeat(42))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/too short/)
  })
})

describe("resolveConfigFromEnv", () => {
  it("falls back to the documented default origin", () => {
    const res = resolveConfigFromEnv({
      PRIMAL_CATALOG_TOKEN: TOKEN,
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.url).toMatch(/^https:\/\//)
  })

  it("never echoes the token", () => {
    const res = resolveConfigFromEnv({
      PRIMAL_CATALOG_URL: "http://catalog.example.com",
      PRIMAL_CATALOG_TOKEN: TOKEN,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).not.toContain(TOKEN)
  })
})

describe("rarityOrderIndex", () => {
  it("returns the comparable ladder index", () => {
    expect(rarityOrderIndex("Common")).toBe(1)
    expect(rarityOrderIndex("Ancient")).toBe(5)
    expect(rarityOrderIndex("Unique")).toBeUndefined()
    expect(rarityOrderIndex("Commoner")).toBeUndefined()
  })
})

describe("parseArgs", () => {
  it("defaults to a dry run (no execute)", () => {
    expect(parseArgs([])).toEqual({
      execute: false,
      confirm: null,
      help: false,
    })
  })

  it("parses --execute and --confirm", () => {
    expect(parseArgs(["--execute", "--confirm", CONFIRM_PHRASE])).toEqual({
      execute: true,
      confirm: CONFIRM_PHRASE,
      help: false,
    })
  })

  it("rejects an unknown flag", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/Unknown argument/)
  })
})

// ------------------------------------------------------------------ //
// Default dry run
// ------------------------------------------------------------------ //

describe("default dry run", () => {
  it("validates and previews but never applies", async () => {
    const h = harness()
    const result = await run({
      env: validEnv(),
      argv: [],
      fetchImpl: h.fetchImpl,
    })

    expect(result.ok).toBe(true)
    expect(result.mode).toBe("dry-run")
    expect(result.applied).toBeNull()
    expect(result.verification).toBeNull()
    expect(result.entries).toHaveLength(h.plan.upgradeLinks.length)
    expect(result.preview.previewTicket).toBe("ticket-1")

    // No apply POST.
    const applyPosts = h.calls.filter(
      (c) =>
        c.method === "POST" && new URL(c.url).pathname === CATALOG_APPLY_PATH
    )
    expect(applyPosts).toHaveLength(0)

    // Exactly one preview POST.
    const previewPosts = h.calls.filter(
      (c) =>
        c.method === "POST" && new URL(c.url).pathname === CATALOG_PREVIEW_PATH
    )
    expect(previewPosts).toHaveLength(1)

    // It did perform the authenticated GET list and per-entry GETs.
    const listGets = h.calls.filter(
      (c) => c.method === "GET" && new URL(c.url).pathname === CATALOG_LIST_PATH
    )
    expect(listGets).toHaveLength(1)
    const entryGets = h.calls.filter(
      (c) =>
        c.method === "GET" && new URL(c.url).pathname === CATALOG_ENTRY_PATH
    )
    expect(entryGets.length).toBeGreaterThan(0)
  })

  it("does not touch the network before config is resolved", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, []))
    await expect(
      run({
        env: { PRIMAL_CATALOG_URL: ORIGIN, PRIMAL_CATALOG_TOKEN: undefined },
        argv: [],
        fetchImpl,
      })
    ).rejects.toThrow(/PRIMAL_CATALOG_TOKEN/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

// ------------------------------------------------------------------ //
// Fail-closed configuration
// ------------------------------------------------------------------ //

describe("fail-closed configuration", () => {
  it("rejects a missing token without any network call", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, []))
    await expect(
      run({ env: { PRIMAL_CATALOG_URL: ORIGIN }, argv: [], fetchImpl })
    ).rejects.toThrow(/PRIMAL_CATALOG_TOKEN is not set/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("rejects an unsafe (non-https) origin", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, []))
    await expect(
      run({
        env: validEnv({ PRIMAL_CATALOG_URL: "http://catalog.example.com" }),
        argv: [],
        fetchImpl,
      })
    ).rejects.toThrow(/HTTPS/)
  })
})

// ------------------------------------------------------------------ //
// Validation gates
// ------------------------------------------------------------------ //

describe("validation gates", () => {
  it("rejects a listed skill that still carries a grade (migration not deployed)", async () => {
    const h = harness({
      "alchemical-flame": { grade: "B", gradeDescriptions: { B: "good" } },
    })
    // The fail-closed entry read now catches a non-null grade as malformed
    // before any plan validation runs.
    const err = await run({
      env: validEnv(),
      argv: [],
      fetchImpl: h.fetchImpl,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/incomplete or malformed/)
  })

  it("rejects a listed skill with non-empty gradeDescriptions", async () => {
    const h = harness({
      "alchemical-flame": { grade: null, gradeDescriptions: { B: "good" } },
    })
    await expect(
      run({ env: validEnv(), argv: [], fetchImpl: h.fetchImpl })
    ).rejects.toThrow(/migration/)
  })

  it("refuses to overwrite an existing explicit list that differs from the plan", async () => {
    const h = harness({
      "alchemical-flame": {
        config: { upgradeToStableIds: ["some-other-target"] },
      },
    })
    const err = await run({
      env: validEnv(),
      argv: [],
      fetchImpl: h.fetchImpl,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(
      /Existing explicit skill upgrade paths differ from the approved plan/
    )
  })

  it("rejects an archived source", async () => {
    const h = harness({ "alchemical-flame": { archived: true } })
    await expect(
      run({ env: validEnv(), argv: [], fetchImpl: h.fetchImpl })
    ).rejects.toThrow(/archived/)
  })

  it("rejects a name mismatch", async () => {
    const h = harness({ "alchemical-flame": { name: "Wrong Name" } })
    await expect(
      run({ env: validEnv(), argv: [], fetchImpl: h.fetchImpl })
    ).rejects.toThrow(/name mismatch/)
  })

  it("rejects a rarity mismatch", async () => {
    const h = harness({
      "alchemical-flame": { config: { rarity: "Commoner" } },
    })
    await expect(
      run({ env: validEnv(), argv: [], fetchImpl: h.fetchImpl })
    ).rejects.toThrow(/rarity/)
  })

  it("rejects a missing stableId in the catalog", async () => {
    const h = harness({ "alchemical-flame": { archived: false } })
    delete h.records["alchemical-flame"]
    const err = await run({
      env: validEnv(),
      argv: [],
      fetchImpl: h.fetchImpl,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.status).toBe(404)
    expect(err.code).toBe("catalog_not_found")
    // A fixed safe message carries the numeric status, never the untrusted
    // server `.message` ("not found").
    expect(err.message).toMatch(/404/)
  })
})

// ------------------------------------------------------------------ //
// Config preservation
// ------------------------------------------------------------------ //

describe("config preservation", () => {
  it("preserves full source config/effects and changes only upgradeToStableIds", async () => {
    const h = harness()
    await run({
      env: validEnv(),
      argv: [],
      fetchImpl: h.fetchImpl,
    })

    const previewBody = bodyOf(h.calls, CATALOG_PREVIEW_PATH)
    expect(previewBody).not.toBeNull()

    const first = previewBody.entries[0]
    expect(first.kind).toBe("skills")
    expect(first).not.toHaveProperty("archived")

    // The config keeps every existing field and only replaces the edge list.
    expect(typeof first.config).toBe("object")
    expect(first.config.track).toBe("profession")
    expect(Array.isArray(first.config.effects)).toBe(true)
    expect(first.config.effects).toHaveLength(1)
    expect(first.config.milestone).toBe(1)
    expect(first.config.choiceGroup).toBe("choice")
    expect(first.config.upgradeGroup).toBe("family")
    expect(first.config.rarity).toBeTruthy()
    expect(Array.isArray(first.config.upgradeToStableIds)).toBe(true)
    expect(first.config.upgradeToStableIds).toHaveLength(1)
  })
})

// ------------------------------------------------------------------ //
// Execute + confirmation
// ------------------------------------------------------------------ //

describe("execute and confirmation", () => {
  it("refuses --execute without the exact confirmation phrase", async () => {
    const h = harness()
    const err = await run({
      env: validEnv(),
      argv: ["--execute", "--confirm", "PUBLISH SOMETHING ELSE"],
      fetchImpl: h.fetchImpl,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(
      /Exact confirmation phrase required for --execute/
    )
    // The printed safe message never echoes any value, token or origin.
    expect(safeErrorMessage(err)).toBe("Catalog operation failed")
    expect(safeErrorMessage(err)).not.toContain(TOKEN)
    // A wrong confirmation aborts before any write route is reached.
    const applyPosts = h.calls.filter(
      (c) =>
        c.method === "POST" && new URL(c.url).pathname === CATALOG_APPLY_PATH
    )
    expect(applyPosts).toHaveLength(0)
  })

  it("applies when --execute is given with the exact confirmation", async () => {
    const h = harness()
    const result = await run({
      env: validEnv(),
      argv: executeArgs(),
      fetchImpl: h.fetchImpl,
    })

    expect(result.ok).toBe(true)
    expect(result.mode).toBe("applied")
    expect(result.applied).not.toBeNull()
    expect(Array.isArray(result.verification)).toBe(true)
    expect(result.verification?.length).toBe(h.plan.upgradeLinks.length)

    const applyPosts = h.calls.filter(
      (c) =>
        c.method === "POST" && new URL(c.url).pathname === CATALOG_APPLY_PATH
    )
    expect(applyPosts).toHaveLength(1)
  })

  it("sends the same entries payload to preview and apply", async () => {
    const h = harness()
    await run({
      env: validEnv(),
      argv: executeArgs(),
      fetchImpl: h.fetchImpl,
    })

    const previewBody = bodyOf(h.calls, CATALOG_PREVIEW_PATH)
    const applyBody = bodyOf(h.calls, CATALOG_APPLY_PATH)
    expect(previewBody).not.toBeNull()
    expect(applyBody).not.toBeNull()
    expect(applyBody.entries).toEqual(previewBody.entries)
  })
})

// ------------------------------------------------------------------ //
// Post-apply verification
// ------------------------------------------------------------------ //

describe("post-apply verification", () => {
  it("re-GETs each source after apply and confirms the planned targets", async () => {
    const h = harness()
    const result = await run({
      env: validEnv(),
      argv: executeArgs(),
      fetchImpl: h.fetchImpl,
    })

    // Each source should be verified with the planned target list.
    for (const link of h.plan.upgradeLinks) {
      const target = link.targets.map((t) => t.stableId)
      const line = `verified skills/${link.source.stableId}: upgradeToStableIds=${JSON.stringify(target)}`
      expect(result.verification).toContain(line)
    }

    // The apply mutated the mock records so a follow-up GET returns the edge.
    const sourceId = h.plan.upgradeLinks[0].source.stableId
    const target = h.plan.upgradeLinks[0].targets.map((t) => t.stableId)
    expect(h.records[sourceId].config.upgradeToStableIds).toEqual(target)
  })
})

// ------------------------------------------------------------------ //
// Safe errors / no auto retry
// ------------------------------------------------------------------ //

describe("safe errors and no auto retry", () => {
  it("surfaces a 409 on apply without retrying", async () => {
    const h = harness()
    const base = h.fetchImpl
    const fetchImpl = vi.fn(async (url, init) => {
      const pathname = new URL(typeof url === "string" ? url : url.toString())
        .pathname
      if (pathname === CATALOG_APPLY_PATH) {
        return jsonResponse(409, {
          error: { code: "preview_stale", message: "catalog changed" },
        })
      }
      return base(url, init)
    })
    const err = await run({
      env: validEnv(),
      argv: executeArgs(),
      fetchImpl,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.status).toBe(409)
    expect(err.message).toMatch(/re-preview and retry/)
  })

  it("never leaks the token in a server error", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(503, {
        error: {
          code: "publisher_unavailable",
          message: `catalog is down (bearer ${TOKEN})`,
        },
      })
    )
    const err = await run({
      env: validEnv(),
      argv: [],
      fetchImpl,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.status).toBe(503)
    expect(err.code).toBe("publisher_unavailable")
    // The untrusted server message (which embeds the token) is never echoed;
    // only the fixed safe message with the numeric status is surfaced.
    expect(err.message).toMatch(/503/)
    expect(err.message).not.toContain("catalog is down")
    expect(err.message).not.toContain(TOKEN)
  })

  it("sanitizes the token out of a config error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, []))
    const err = await run({
      env: validEnv({ PRIMAL_CATALOG_URL: "http://catalog.example.com" }),
      argv: [],
      fetchImpl,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).not.toContain(TOKEN)
  })

  it("does not leak the origin/token from a thrown fetch error", async () => {
    // A raw network/undici Error whose message embeds the full origin and token.
    const fetchImpl = vi.fn(async () => {
      throw new Error(`fetch ${ORIGIN} failed for bearer ${TOKEN}`)
    })
    const err = await run({
      env: validEnv(),
      argv: [],
      fetchImpl,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.status).toBe(0)
    // Only the FIXED safe message is surfaced; neither the origin nor the token
    // nor the untrusted `.message` leaks.
    expect(err.message).toBe("Request to the catalog failed")
    expect(err.message).not.toContain(ORIGIN)
    expect(err.message).not.toContain(TOKEN)
  })

  it("does not leak a server message that embeds the token", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(502, {
        error: {
          code: "publisher_unavailable",
          message: `Prisma: query catalog failed for ${TOKEN} at ${ORIGIN}`,
        },
      })
    )
    const err = await run({
      env: validEnv(),
      argv: [],
      fetchImpl,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.status).toBe(502)
    expect(err.message).toMatch(/502/)
    expect(err.message).not.toContain(TOKEN)
    expect(err.message).not.toContain(ORIGIN)
    expect(err.message).not.toContain("Prisma")
  })

  it("does not leak a token via a crafted existing upgrade list", async () => {
    // The prior detailed message interpolated JSON.stringify(existing); craft an
    // existing list that embeds the token to prove the fixed message never echoes
    // a raw value.
    const h = harness({
      "alchemical-flame": { config: { upgradeToStableIds: [TOKEN] } },
    })
    const err = await run({
      env: validEnv(),
      argv: executeArgs(),
      fetchImpl: h.fetchImpl,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(
      /Existing explicit skill upgrade paths differ from the approved plan/
    )
    expect(safeErrorMessage(err)).toBe("Catalog operation failed")
    expect(safeErrorMessage(err)).not.toContain(TOKEN)
    const applyPosts = h.calls.filter(
      (c) =>
        c.method === "POST" && new URL(c.url).pathname === CATALOG_APPLY_PATH
    )
    expect(applyPosts).toHaveLength(0)
  })

  it("does not leak a token on a malformed entry GET", async () => {
    const h = harness()
    const base = h.fetchImpl
    const fetchImpl = vi.fn(async (url, init) => {
      const parsed = new URL(typeof url === "string" ? url : url.toString())
      if (parsed.pathname === CATALOG_ENTRY_PATH) {
        const stableId = parsed.searchParams.get("stableId") ?? ""
        const rec = h.records[stableId]
        if (rec) {
          // Omit `gradeDescriptions` so the entry read fails closed.
          const rest: SkillRecord = { ...rec }
          delete (rest as Partial<SkillRecord>).gradeDescriptions
          return jsonResponse(200, { item: rest })
        }
      }
      return base(url, init)
    })
    const err = await run({
      env: validEnv(),
      argv: executeArgs(),
      fetchImpl,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/incomplete or malformed/)
    expect(safeErrorMessage(err)).toBe("Catalog operation failed")
    expect(safeErrorMessage(err)).not.toContain(TOKEN)
    const applyPosts = h.calls.filter(
      (c) =>
        c.method === "POST" && new URL(c.url).pathname === CATALOG_APPLY_PATH
    )
    expect(applyPosts).toHaveLength(0)
  })

  it("aborts when a preview `before` changes an effect while AFTER still matches", async () => {
    const h = harness()
    const fetchImpl = overridePreview(h, (entries) =>
      entries.map((e) => {
        const before = beforeForRecord(h.records[e.stableId])
        return {
          kind: e.kind,
          stableId: e.stableId,
          status: "update",
          changedFields: ["config"],
          before: { ...before, config: { ...before.config, effects: [] } },
          after: afterForEntry(e),
        }
      })
    )
    const err = await run({
      env: validEnv(),
      argv: executeArgs(),
      fetchImpl,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(
      /Preview source changed since the full catalog read/
    )
    expect(safeErrorMessage(err)).toBe("Catalog operation failed")
    expect(safeErrorMessage(err)).not.toContain(TOKEN)
    const applyPosts = h.calls.filter(
      (c) =>
        c.method === "POST" && new URL(c.url).pathname === CATALOG_APPLY_PATH
    )
    expect(applyPosts).toHaveLength(0)
  })
})

// ------------------------------------------------------------------ //
// Plan preflight (blocker: reject a malformed plan before preview)
// ------------------------------------------------------------------ //

describe("plan preflight", () => {
  it("accepts the committed plan", () => {
    expect(() => validatePlanShape(loadRealPlan())).not.toThrow()
  })

  it("rejects a duplicate source stableId", () => {
    const plan = loadRealPlan()
    plan.upgradeLinks[1].source = plan.upgradeLinks[0].source
    expect(() => validatePlanShape(plan)).toThrow(/more than once/)
  })

  it("rejects an empty source stableId", () => {
    const plan = loadRealPlan()
    plan.upgradeLinks[0].source = {
      ...plan.upgradeLinks[0].source,
      stableId: "",
    }
    expect(() => validatePlanShape(plan)).toThrow(/empty\/missing/)
  })

  it("rejects a link with no targets", () => {
    const plan = loadRealPlan()
    plan.upgradeLinks[0].targets = []
    expect(() => validatePlanShape(plan)).toThrow(/no targets/)
  })

  it("rejects an inconsistent edgeCount", () => {
    const plan = loadRealPlan()
    plan.edgeCount = 31
    expect(() => validatePlanShape(plan)).toThrow(/inconsistent/)
  })
})

// ------------------------------------------------------------------ //
// Preview validation (blocker: never apply on a malformed preview)
// ------------------------------------------------------------------ //

describe("preview validation gate", () => {
  it("accepts a well-formed preview via validatePreviewResponse", () => {
    const h = harness()
    const entries = buildEntries(h.plan, h.records)
    const preview = {
      changes: entries.map((e) => ({
        kind: e.kind,
        stableId: e.stableId,
        status: "update",
        changedFields: ["config"],
        before: beforeForRecord(h.records[e.stableId]),
        after: afterForEntry(e),
      })),
      payloadDigest: "p".repeat(64),
      stateDigest: "s".repeat(64),
      previewTicket: "ticket-1",
    }
    const sourceSnapshot = captureSourceSnapshot(h.records, h.plan)
    expect(() =>
      validatePreviewResponse(preview, h.plan, entries, sourceSnapshot)
    ).not.toThrow()
  })

  it("aborts and never applies when preview changes omit a planned source", async () => {
    const h = harness()
    const fetchImpl = overridePreview(h, (entries) =>
      entries.slice(0, -1).map((e) => ({
        kind: e.kind,
        stableId: e.stableId,
        status: "update",
        changedFields: ["config"],
        after: afterForEntry(e),
      }))
    )
    const err = await run({
      env: validEnv(),
      argv: executeArgs(),
      fetchImpl,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/missing/)
    const applyPosts = h.calls.filter(
      (c) =>
        c.method === "POST" && new URL(c.url).pathname === CATALOG_APPLY_PATH
    )
    expect(applyPosts).toHaveLength(0)
  })

  it("aborts and never applies when a change reports status `create`", async () => {
    const h = harness()
    const fetchImpl = overridePreview(h, (entries) =>
      entries.map((e) => ({
        kind: e.kind,
        stableId: e.stableId,
        status: "create",
        changedFields: ["config"],
        after: afterForEntry(e),
      }))
    )
    const err = await run({
      env: validEnv(),
      argv: executeArgs(),
      fetchImpl,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/status/)
    const applyPosts = h.calls.filter(
      (c) =>
        c.method === "POST" && new URL(c.url).pathname === CATALOG_APPLY_PATH
    )
    expect(applyPosts).toHaveLength(0)
  })

  it("aborts and never applies when a change reports an unexpected changed field", async () => {
    const h = harness()
    const fetchImpl = overridePreview(h, (entries) =>
      entries.map((e) => ({
        kind: e.kind,
        stableId: e.stableId,
        status: "update",
        changedFields: ["config", "name"],
        after: afterForEntry(e),
      }))
    )
    const err = await run({
      env: validEnv(),
      argv: executeArgs(),
      fetchImpl,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/changed field/)
    const applyPosts = h.calls.filter(
      (c) =>
        c.method === "POST" && new URL(c.url).pathname === CATALOG_APPLY_PATH
    )
    expect(applyPosts).toHaveLength(0)
  })

  it("aborts and never applies when the after.config does not match", async () => {
    const h = harness()
    const fetchImpl = overridePreview(h, (entries) =>
      entries.map((e) => {
        const config = { ...e.config }
        delete config.effects
        return {
          kind: e.kind,
          stableId: e.stableId,
          status: "update",
          changedFields: ["config"],
          after: afterForEntry({ ...e, config }),
        }
      })
    )
    const err = await run({
      env: validEnv(),
      argv: executeArgs(),
      fetchImpl,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/after\.config/)
    const applyPosts = h.calls.filter(
      (c) =>
        c.method === "POST" && new URL(c.url).pathname === CATALOG_APPLY_PATH
    )
    expect(applyPosts).toHaveLength(0)
  })

  it("aborts and never applies when a change is for an unexpected skill", async () => {
    const h = harness()
    const fetchImpl = overridePreview(h, (entries) => [
      ...entries.slice(0, -1).map((e) => ({
        kind: e.kind,
        stableId: e.stableId,
        status: "update",
        changedFields: ["config"],
        after: afterForEntry(e),
      })),
      {
        kind: "skills",
        stableId: "not-a-source",
        status: "update",
        changedFields: ["config"],
        after: afterForEntry(entries[0]),
      },
    ])
    const err = await run({
      env: validEnv(),
      argv: executeArgs(),
      fetchImpl,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/unexpected/)
    const applyPosts = h.calls.filter(
      (c) =>
        c.method === "POST" && new URL(c.url).pathname === CATALOG_APPLY_PATH
    )
    expect(applyPosts).toHaveLength(0)
  })

  it("aborts before apply and never leaks a token in a crafted preview kind", async () => {
    const h = harness()
    // Every change is otherwise valid (stableId, status, changedFields,
    // before/after all correct) but the remote `kind` embeds the bearer token.
    // The kind guard must reject it BEFORE any apply, and the safe error messaged
    // to the CLI must never echo the token.
    const fetchImpl = overridePreview(h, (entries) =>
      entries.map((e) => ({
        kind: `skills ${TOKEN}`,
        stableId: e.stableId,
        status: "update",
        changedFields: ["config"],
        before: beforeForRecord(h.records[e.stableId]),
        after: afterForEntry(e),
      }))
    )
    const err = await run({
      env: validEnv(),
      argv: executeArgs(),
      fetchImpl,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/kind/)
    expect(safeErrorMessage(err)).toBe("Catalog operation failed")
    expect(safeErrorMessage(err)).not.toContain(TOKEN)
    const applyPosts = h.calls.filter(
      (c) =>
        c.method === "POST" && new URL(c.url).pathname === CATALOG_APPLY_PATH
    )
    expect(applyPosts).toHaveLength(0)
  })
})

// ------------------------------------------------------------------ //
// Post-apply full-config verification (blocker: abort on lost effects)
// ------------------------------------------------------------------ //

describe("post-apply full-config verification", () => {
  it("aborts when apply loses an existing config field", async () => {
    const h = harness()
    const base = h.fetchImpl
    const fetchImpl = vi.fn(async (url, init) => {
      const pathname = new URL(typeof url === "string" ? url : url.toString())
        .pathname
      if (pathname === CATALOG_APPLY_PATH) {
        const body = JSON.parse((init?.body as string | undefined) ?? "{}") as {
          entries: BatchEntry[]
        }
        for (const entry of body.entries) {
          const rec = h.records[entry.stableId]
          if (rec) {
            const config = {
              ...rec.config,
              upgradeToStableIds: entry.config.upgradeToStableIds,
            }
            // Simulate the apply dropping the existing `effects` field.
            delete config.effects
            rec.config = config
          }
        }
        return jsonResponse(200, {
          changes: body.entries.map((e) => ({
            kind: e.kind,
            stableId: e.stableId,
            status: "update",
            changedFields: ["config"],
            after: afterForEntry(e),
          })),
          payloadDigest: "p".repeat(64),
          stateDigest: "s".repeat(64),
        })
      }
      return base(url, init)
    })
    const err = await run({
      env: validEnv(),
      argv: executeArgs(),
      fetchImpl,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/lost config field/)
  })
})

// ------------------------------------------------------------------ //
// Read-back exactness (blocker: validate GET stableId matches request)
// ------------------------------------------------------------------ //

describe("entry read-back exactness", () => {
  it("aborts when a GET returns a record for a different stableId", async () => {
    const h = harness()
    const base = h.fetchImpl
    const fetchImpl = vi.fn(async (url, init) => {
      const parsed = new URL(typeof url === "string" ? url : url.toString())
      if (parsed.pathname === CATALOG_ENTRY_PATH) {
        const requested = parsed.searchParams.get("stableId") ?? ""
        if (requested === "alchemical-flame") {
          const rec = h.records["alchemical-flame"]
          return jsonResponse(200, {
            item: { ...rec, stableId: "some-other-record" },
          })
        }
      }
      return base(url, init)
    })
    const err = await run({
      env: validEnv(),
      argv: [],
      fetchImpl,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/Catalog entry identity mismatch/)
  })
})

// ------------------------------------------------------------------ //
// Non-identifying target label (blocker: never print the origin)
// ------------------------------------------------------------------ //

describe("target label", () => {
  it("prints a non-identifying label and never the origin", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      printResult({
        mode: "dry-run",
        targetUrl: ORIGIN,
        activeCount: 1,
        sourceCount: 2,
        targetCount: 2,
        entries: [],
        preview: { changes: [] },
        applied: null,
        verification: null,
      })
      expect(spy).toHaveBeenCalledWith(`Target: ${TARGET_LABEL}`)
      const output = spy.mock.calls.map((c) => String(c[0])).join("\n")
      expect(output).not.toContain(ORIGIN)
    } finally {
      spy.mockRestore()
    }
  })
})

// ------------------------------------------------------------------ //
// Preview kind in summary (blocker: never echo an unvalidated remote kind)
// ------------------------------------------------------------------ //

describe("preview kind in summary", () => {
  it("prints the fixed SKILLS_KIND and never a crafted remote kind", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      printResult({
        mode: "dry-run",
        targetUrl: ORIGIN,
        activeCount: 1,
        sourceCount: 1,
        targetCount: 1,
        entries: [{ kind: SKILLS_KIND, stableId: "abc", name: "abc" }],
        preview: {
          changes: [
            {
              kind: `skills ${TOKEN}`,
              stableId: "abc",
              status: "update",
              changedFields: ["config"],
            },
          ],
        },
        applied: null,
        verification: null,
      })
      const output = spy.mock.calls.map((c) => String(c[0])).join("\n")
      // The fixed kind is printed, never the remote token-embedding kind.
      expect(output).toContain(`${SKILLS_KIND}/abc`)
      expect(output).not.toContain(`${TOKEN}/abc`)
      expect(output).not.toContain(TOKEN)
    } finally {
      spy.mockRestore()
    }
  })
})
