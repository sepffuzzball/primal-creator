import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GET } from "./route"
import { GET as entryGet } from "./entry/route"
import { POST as previewPost } from "./preview/route"
import { POST as applyPost } from "./apply/route"

// Real unit tests against the in-memory Prisma mock. The mock backs the
// `@/lib/db/client` export that BOTH the routes and the managed publisher import,
// so preview/apply (which drive SERIALIZABLE transactions) run against an in-memory
// catalog definition store without a running Postgres.
type TestStore = import("@/lib/db/testPrisma").TestPrismaInstance["store"]
const dbMock = vi.hoisted(() => ({ store: undefined as unknown as TestStore }))

vi.mock("@/lib/db/client", async () => {
  const { createTestPrisma } = await import("@/lib/db/testPrisma")
  const instance = createTestPrisma()
  dbMock.store = instance.store
  return { prisma: instance.prisma, default: instance.prisma }
})

// ------------------------------------------------------------------ //
// Environment: publisher bearer hash (MCP_CATALOG_TOKEN_SHA256) + AUTH_SECRET
// ------------------------------------------------------------------ //

const AUTH_SECRET = "test-auth-secret-that-is-at-least-32-chars-long!!"

// A base64url token that legally contains `-` and `_` (43 chars = 256 bits),
// proving the charset gate accepts the full unpadded base64url alphabet.
const BEARER_TOKEN = "A".repeat(19) + "-" + "B".repeat(19) + "_" + "C".repeat(3)
const TOKEN_HASH = createHash("sha256")
  .update(BEARER_TOKEN, "utf8")
  .digest("hex")

type EnvSnapshot = { auth: string | undefined; hash: string | undefined }
const originalEnv: EnvSnapshot = {
  auth: process.env.AUTH_SECRET,
  hash: process.env.MCP_CATALOG_TOKEN_SHA256,
}

function applyEnv(snap: EnvSnapshot): void {
  if (snap.auth === undefined) delete process.env.AUTH_SECRET
  else process.env.AUTH_SECRET = snap.auth
  if (snap.hash === undefined) delete process.env.MCP_CATALOG_TOKEN_SHA256
  else process.env.MCP_CATALOG_TOKEN_SHA256 = snap.hash
}

beforeEach(() => {
  process.env.AUTH_SECRET = AUTH_SECRET
  process.env.MCP_CATALOG_TOKEN_SHA256 = TOKEN_HASH
  dbMock.store.reset()
})

afterEach(() => {
  applyEnv(originalEnv)
})

// ------------------------------------------------------------------ //
// Request helpers
// ------------------------------------------------------------------ //

const BASE = "http://localhost/api/mcp/catalog"
const PREVIEW_URL = `${BASE}/preview`
const APPLY_URL = `${BASE}/apply`
const ENTRY_URL = `${BASE}/entry`

function authHeaders(
  token: string | null = BEARER_TOKEN,
  cookie?: string
): Headers {
  const headers = new Headers()
  if (token !== null) headers.set("authorization", `Bearer ${token}`)
  if (cookie) headers.set("cookie", cookie)
  return headers
}

function getReq(
  query = "",
  token: string | null = BEARER_TOKEN,
  cookie?: string
): Request {
  return new Request(`${BASE}${query}`, {
    method: "GET",
    headers: authHeaders(token, cookie),
  })
}

function getEntryReq(
  query = "",
  token: string | null = BEARER_TOKEN,
  cookie?: string
): Request {
  return new Request(`${ENTRY_URL}${query}`, {
    method: "GET",
    headers: authHeaders(token, cookie),
  })
}

function postReq(
  url: string,
  body?: unknown,
  opts: {
    token?: string | null
    cookie?: string
    stream?: boolean
    contentLength?: string
  } = {}
): Request {
  const token = opts.token === undefined ? BEARER_TOKEN : opts.token
  const headers = authHeaders(token, opts.cookie)
  if (opts.contentLength != null)
    headers.set("content-length", opts.contentLength)
  const base = { method: "POST" as const, headers }

  if (opts.stream) {
    const text = body == null ? "" : JSON.stringify(body)
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text))
        controller.close()
      },
    })
    const init = {
      ...base,
      body: stream,
      duplex: "half" as const,
    } as RequestInit & { duplex: "half" }
    return new Request(url, init)
  }

  return new Request(url, {
    ...base,
    body: body == null ? undefined : JSON.stringify(body),
  })
}

// A minimal managed entry for the `items` kind (no cross-kind references), which
// the publisher can create/update without triggering a reference guard.
function managedEntry(stableId: string, extra: Record<string, unknown> = {}) {
  return {
    kind: "items",
    stableId,
    name: `Item ${stableId}`,
    config: { magnitude: 3 },
    ...extra,
  }
}

function seedCatalog() {
  dbMock.store.addCatalog({
    id: "item-active",
    kind: "items",
    stableId: "item-active",
    name: "Active item",
    description: "An active item description",
    config: { magnitude: 3 },
    grade: "B",
    sourceUrl: "https://example.com/item-active",
    gradeDescriptions: { B: "Active grade prose" },
    archived: false,
  })
  dbMock.store.addCatalog({
    id: "item-archived",
    kind: "items",
    stableId: "item-archived",
    name: "Archived item",
    description: "An archived item description",
    config: { magnitude: 7 },
    grade: "A",
    sourceUrl: "https://example.com/item-archived",
    gradeDescriptions: { A: "Archived grade prose" },
    archived: true,
  })
}

// ------------------------------------------------------------------ //
// GET /api/mcp/catalog
// ------------------------------------------------------------------ //

describe("GET /api/mcp/catalog", () => {
  it("rejects a request with no Authorization bearer with 401", async () => {
    const res = await GET(getReq("?kind=items", null))
    expect(res.status).toBe(401)
  })

  it("rejects a session-cookie-only request (no cookie privilege) with 401", async () => {
    const res = await GET(getReq("?kind=items", null, "primal_session=token"))
    expect(res.status).toBe(401)
  })

  it("rejects a request whose bearer hash does not match with 401", async () => {
    const res = await GET(getReq("?kind=items", "B".repeat(43)))
    expect(res.status).toBe(401)
  })

  it("returns default active summary items for a valid bearer (no includeArchived)", async () => {
    seedCatalog()
    const res = await GET(getReq("?kind=items"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      kind: string
      items: Array<{
        stableId: string
        archived: boolean
        config?: unknown
        description?: unknown
      }>
    }
    expect(body.kind).toBe("items")
    expect(body.items.map((i) => i.stableId).sort()).toEqual(["item-active"])
    expect(body.items.every((i) => i.archived === false)).toBe(true)
    // Summary objects never carry the heavy config/description payload.
    expect(
      body.items.every((i) => !("config" in i) && !("description" in i))
    ).toBe(true)
  })

  it("returns active AND archived summary items with includeArchived=1", async () => {
    seedCatalog()
    const res = await GET(getReq("?kind=items&includeArchived=1"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      kind: string
      items: Array<{
        stableId: string
        archived: boolean
        config?: unknown
        description?: unknown
      }>
    }
    expect(body.items.map((i) => i.stableId).sort()).toEqual([
      "item-active",
      "item-archived",
    ])
    expect(
      body.items.find((i) => i.stableId === "item-archived")?.archived
    ).toBe(true)
    // Summary objects never carry the heavy config/description payload.
    expect(
      body.items.every((i) => !("config" in i) && !("description" in i))
    ).toBe(true)
  })

  it("treats includeArchived=0 as active-only", async () => {
    seedCatalog()
    const res = await GET(getReq("?kind=items&includeArchived=0"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: Array<{ stableId: string }>
    }
    expect(body.items.map((i) => i.stableId)).toEqual(["item-active"])
  })

  it("rejects an unknown kind with 400 invalid_kind", async () => {
    const res = await GET(getReq("?kind=not-a-kind"))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("invalid_kind")
  })

  it("rejects the legacy consumables alias (canonical schema only) with 400 invalid_kind", async () => {
    const res = await GET(getReq("?kind=consumables"))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("invalid_kind")
  })

  it("rejects a missing kind with 400 invalid_kind", async () => {
    const res = await GET(getReq())
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("invalid_kind")
  })

  it("fails closed (503 publisher_unavailable) when MCP_CATALOG_TOKEN_SHA256 is unset", async () => {
    delete process.env.MCP_CATALOG_TOKEN_SHA256
    const res = await GET(getReq("?kind=items"))
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("publisher_unavailable")
  })

  it("never reflects the raw token or hash in an error body", async () => {
    const res = await GET(getReq("?kind=items"))
    expect(res.status).toBe(200)
    const ok = await res.json()
    expect(JSON.stringify(ok)).not.toContain(BEARER_TOKEN)

    const bad = await GET(getReq("?kind=items", null))
    expect(bad.status).toBe(401)
    const body = (await bad.json()) as { error: { message: string } }
    expect(body.error.message).not.toContain(BEARER_TOKEN)
  })

  it("sets Cache-Control: no-store on the GET response", async () => {
    seedCatalog()
    const res = await GET(getReq("?kind=items"))
    expect(res.headers.get("cache-control")).toBe("no-store")
  })
})

// ------------------------------------------------------------------ //
// GET /api/mcp/catalog/entry
// ------------------------------------------------------------------ //

describe("GET /api/mcp/catalog/entry", () => {
  it("rejects a request with no Authorization bearer with 401", async () => {
    const res = await entryGet(
      getEntryReq("?kind=items&stableId=item-active", null)
    )
    expect(res.status).toBe(401)
  })

  it("rejects a session-cookie-only request (no cookie privilege) with 401", async () => {
    const res = await entryGet(
      getEntryReq(
        "?kind=items&stableId=item-active",
        null,
        "primal_session=token"
      )
    )
    expect(res.status).toBe(401)
  })

  it("rejects a request whose bearer hash does not match with 401", async () => {
    const res = await entryGet(
      getEntryReq("?kind=items&stableId=item-active", "B".repeat(43))
    )
    expect(res.status).toBe(401)
  })

  it("returns the full active catalog entry for a valid bearer", async () => {
    seedCatalog()
    const res = await entryGet(getEntryReq("?kind=items&stableId=item-active"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      item: {
        kind: string
        stableId: string
        name: string
        description: string | null
        grade: string | null
        sourceUrl: string | null
        archived: boolean
        config: Record<string, unknown>
        gradeDescriptions: Record<string, string>
      }
    }
    expect(body.item.kind).toBe("items")
    expect(body.item.stableId).toBe("item-active")
    expect(body.item.name).toBe("Active item")
    expect(body.item.description).toBe("An active item description")
    expect(body.item.grade).toBe("B")
    expect(body.item.sourceUrl).toBe("https://example.com/item-active")
    expect(body.item.archived).toBe(false)
    expect(body.item.config).toEqual({ magnitude: 3 })
    expect(body.item.gradeDescriptions).toEqual({ B: "Active grade prose" })
  })

  it("returns the full archived catalog entry including archived=true", async () => {
    seedCatalog()
    const res = await entryGet(
      getEntryReq("?kind=items&stableId=item-archived")
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { item: { archived: boolean } }
    expect(body.item.archived).toBe(true)
  })

  it("rejects an unknown kind with 400 invalid_kind", async () => {
    seedCatalog()
    const res = await entryGet(
      getEntryReq("?kind=not-a-kind&stableId=item-active")
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("invalid_kind")
  })

  it("rejects a missing kind with 400 invalid_kind", async () => {
    const res = await entryGet(getEntryReq("?stableId=item-active"))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("invalid_kind")
  })

  it("rejects a missing stableId with 400 invalid_stable_id", async () => {
    const res = await entryGet(getEntryReq("?kind=items"))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("invalid_stable_id")
  })

  it("rejects an empty stableId with 400 invalid_stable_id", async () => {
    const res = await entryGet(getEntryReq("?kind=items&stableId="))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("invalid_stable_id")
  })

  it("rejects a stableId longer than 128 chars with 400 invalid_stable_id", async () => {
    const res = await entryGet(
      getEntryReq(`?kind=items&stableId=${"a".repeat(129)}`)
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("invalid_stable_id")
  })

  it("returns 404 catalog_not_found for a missing entry", async () => {
    seedCatalog()
    const res = await entryGet(getEntryReq("?kind=items&stableId=missing"))
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("catalog_not_found")
  })

  it("fails closed (503 publisher_unavailable) when MCP_CATALOG_TOKEN_SHA256 is unset", async () => {
    delete process.env.MCP_CATALOG_TOKEN_SHA256
    const res = await entryGet(getEntryReq("?kind=items&stableId=item-active"))
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("publisher_unavailable")
  })

  it("sets Cache-Control: no-store on the GET response", async () => {
    seedCatalog()
    const res = await entryGet(getEntryReq("?kind=items&stableId=item-active"))
    expect(res.headers.get("cache-control")).toBe("no-store")
  })
})

// ------------------------------------------------------------------ //
// POST /api/mcp/catalog/preview
// ------------------------------------------------------------------ //

describe("POST /api/mcp/catalog/preview", () => {
  it("rejects a request with no bearer with 401", async () => {
    const res = await previewPost(
      postReq(
        PREVIEW_URL,
        { entries: [managedEntry("route-item")] },
        { token: null }
      )
    )
    expect(res.status).toBe(401)
  })

  it("previews a create and writes nothing to the catalog", async () => {
    seedCatalog()
    const res = await previewPost(
      postReq(PREVIEW_URL, {
        entries: [managedEntry("route-item", { config: { magnitude: 9 } })],
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      changes: Array<{ stableId: string; status: string }>
      payloadDigest: string
      stateDigest: string
      previewTicket: string
    }
    expect(body.changes).toHaveLength(1)
    expect(body.changes[0].stableId).toBe("route-item")
    expect(body.changes[0].status).toBe("create")
    expect(body.payloadDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(body.stateDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(typeof body.previewTicket).toBe("string")
    expect(body.previewTicket.length).toBeGreaterThan(0)
    // Preview must not persist anything: the seeded row remains, no new row added.
    expect(dbMock.store.catalog.size).toBe(2)
  })

  it("rejects invalid JSON with 400 validation", async () => {
    const headers = authHeaders()
    const req = new Request(PREVIEW_URL, {
      method: "POST",
      headers,
      body: "{not-json",
    })
    const res = await previewPost(req)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("validation")
  })

  it("rejects an entries value that is not an array with 400 validation", async () => {
    const res = await previewPost(
      postReq(PREVIEW_URL, { entries: { not: "array" } })
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("validation")
  })

  it("rejects an unknown body key with 400 validation (strict schema)", async () => {
    const res = await previewPost(
      postReq(PREVIEW_URL, {
        entries: [managedEntry("route-item")],
        extra: true,
      })
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("validation")
  })

  it("rejects a malformed entry (non-canonical kind) with 400 validation", async () => {
    const res = await previewPost(
      postReq(PREVIEW_URL, {
        entries: [{ kind: "consumables", stableId: "x", name: "X" }],
      })
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("validation")
  })

  it("rejects a streamed body over the 1 MiB cap with 413 payload_too_large", async () => {
    const big = "z".repeat(1024 * 1024 + 1)
    const res = await previewPost(
      postReq(
        PREVIEW_URL,
        { entries: [managedEntry("route-item", { config: { blob: big } })] },
        { stream: true }
      )
    )
    expect(res.status).toBe(413)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("payload_too_large")
  })

  it("rejects an advertised oversized Content-Length with 413 before reading the body", async () => {
    const res = await previewPost(
      postReq(
        PREVIEW_URL,
        { entries: [managedEntry("route-item")] },
        { contentLength: "99999999" }
      )
    )
    expect(res.status).toBe(413)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("payload_too_large")
  })

  it("sets Cache-Control: no-store on the preview response", async () => {
    const res = await previewPost(
      postReq(PREVIEW_URL, { entries: [managedEntry("route-item")] })
    )
    expect(res.headers.get("cache-control")).toBe("no-store")
  })
})

// ------------------------------------------------------------------ //
// POST /api/mcp/catalog/apply
// ------------------------------------------------------------------ //

describe("POST /api/mcp/catalog/apply", () => {
  it("rejects a request with no bearer with 401", async () => {
    const res = await applyPost(
      postReq(
        APPLY_URL,
        { entries: [managedEntry("route-item")], previewTicket: "t" },
        { token: null }
      )
    )
    expect(res.status).toBe(401)
  })

  it("applies a previewed batch atomically and persists the row", async () => {
    const entries = [managedEntry("route-item", { config: { magnitude: 9 } })]
    const preview = await previewPost(postReq(PREVIEW_URL, { entries }))
    expect(preview.status).toBe(200)
    const previewBody = (await preview.json()) as { previewTicket: string }
    expect(previewBody.previewTicket.length).toBeGreaterThan(0)

    const res = await applyPost(
      postReq(APPLY_URL, { entries, previewTicket: previewBody.previewTicket })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      changes: Array<{ stableId: string; status: string }>
      payloadDigest: string
      stateDigest: string
    }
    expect(body.changes).toHaveLength(1)
    expect(body.changes[0].stableId).toBe("route-item")
    expect(body.changes[0].status).toBe("create")
    expect(body.payloadDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(body.stateDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(dbMock.store.catalog.size).toBe(1)
  })

  it("does not persist anything when the preview ticket is invalid (409 preview_stale)", async () => {
    const res = await applyPost(
      postReq(APPLY_URL, {
        entries: [managedEntry("route-item")],
        previewTicket: "not-a-real-ticket",
      })
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("preview_stale")
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("rejects a missing previewTicket with 400 validation", async () => {
    const res = await applyPost(
      postReq(APPLY_URL, { entries: [managedEntry("route-item")] })
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("validation")
  })

  it("rejects an empty previewTicket with 400 validation", async () => {
    const res = await applyPost(
      postReq(APPLY_URL, {
        entries: [managedEntry("route-item")],
        previewTicket: "",
      })
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("validation")
  })

  it("rejects a previewTicket longer than 2048 chars with 400 validation", async () => {
    const res = await applyPost(
      postReq(APPLY_URL, {
        entries: [managedEntry("route-item")],
        previewTicket: "t".repeat(2049),
      })
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("validation")
  })

  it("sets Cache-Control: no-store on the apply response", async () => {
    const res = await applyPost(
      postReq(APPLY_URL, {
        entries: [managedEntry("route-item")],
        previewTicket: "not-a-real-ticket",
      })
    )
    expect(res.headers.get("cache-control")).toBe("no-store")
  })
})
