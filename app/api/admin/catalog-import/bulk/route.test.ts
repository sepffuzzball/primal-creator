import { beforeEach, describe, expect, it, vi } from "vitest"
import { POST as previewPost } from "./preview/route"
import { POST as applyPost } from "./apply/route"
import { createSessionToken } from "@/lib/auth/session"
import { computeBulkRequestDigest } from "@/lib/db/bulk-catalog-import"

// Real-jose unit tests against the in-memory Prisma mock. The mock backs the
// `@/lib/db/client` export that BOTH the routes and `lib/auth/session` import, so
// an issued session token verifies against the seeded fixture user.
type TestStore = import("@/lib/db/testPrisma").TestPrismaInstance["store"]
const dbMock = vi.hoisted(() => ({ store: undefined as unknown as TestStore }))

vi.mock("@/lib/db/client", async () => {
  const { createTestPrisma } = await import("@/lib/db/testPrisma")
  const instance = createTestPrisma()
  dbMock.store = instance.store
  return { prisma: instance.prisma, default: instance.prisma }
})

// Session signing/verification requires a >=32 character shared secret.
process.env.AUTH_SECRET = "test-secret-that-is-at-least-32-chars-long!!"

const ORIGIN = "http://localhost"
const URL = "http://localhost/api/admin/catalog-import/bulk/preview"

function makeReq(
  method: "POST",
  opts: {
    origin?: string | null
    cookie?: string
    body?: unknown
    contentLength?: string | null
    stream?: boolean
  } = {}
): Request {
  const headers = new Headers()
  if (opts.origin != null) headers.set("origin", opts.origin)
  if (opts.cookie) headers.set("cookie", opts.cookie)
  if (opts.contentLength != null)
    headers.set("content-length", opts.contentLength)

  const base = {
    method: "POST",
    headers,
  }

  if (opts.stream) {
    const text = opts.body == null ? "" : JSON.stringify(opts.body)
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
    return new Request(URL, init)
  }

  return new Request(URL, {
    ...base,
    body: opts.body == null ? undefined : JSON.stringify(opts.body),
  })
}

function validContent(): string {
  return JSON.stringify([
    {
      kind: "skills",
      stableId: "route-skill",
      name: "Route Skill",
      provenance: "house",
      sourceUrl: "https://example.com/route-skill",
      config: { track: "race", effects: [], rarity: "Common" },
    },
  ])
}

describe("POST /api/admin/catalog-import/bulk/preview and /apply (mocked db)", () => {
  beforeEach(() => {
    dbMock.store.reset()
    delete process.env.APP_ORIGIN
  })

  async function seedAdmin() {
    return dbMock.store.addUser({
      id: "admin-1",
      email: "admin@example.com",
      isAdmin: true,
      sessionVersion: 0,
    })
  }

  async function seedRegular() {
    return dbMock.store.addUser({
      id: "user-1",
      email: "user@example.com",
      isAdmin: false,
      sessionVersion: 0,
    })
  }

  async function adminCookie() {
    const row = await seedAdmin()
    return createSessionToken(
      { id: row.id, email: row.email, isAdmin: true },
      row.sessionVersion
    )
  }

  async function regularCookie() {
    const row = await seedRegular()
    return createSessionToken(
      { id: row.id, email: row.email, isAdmin: false },
      row.sessionVersion
    )
  }

  it("preview requires an authenticated admin (401 when anonymous)", async () => {
    const res = await previewPost(
      makeReq("POST", {
        origin: ORIGIN,
        body: { format: "json", content: validContent() },
      })
    )
    expect(res.status).toBe(401)
  })

  it("apply requires an authenticated admin (401 when anonymous)", async () => {
    const res = await applyPost(
      makeReq("POST", {
        origin: ORIGIN,
        body: { format: "json", content: validContent(), previewDigest: "x" },
      })
    )
    expect(res.status).toBe(401)
  })

  it("preview rejects a non-admin with 403", async () => {
    const token = await regularCookie()
    const res = await previewPost(
      makeReq("POST", {
        origin: ORIGIN,
        cookie: `primal_session=${token}`,
        body: { format: "json", content: validContent() },
      })
    )
    expect(res.status).toBe(403)
  })

  it("apply rejects a non-admin with 403", async () => {
    const token = await regularCookie()
    const res = await applyPost(
      makeReq("POST", {
        origin: ORIGIN,
        cookie: `primal_session=${token}`,
        body: { format: "json", content: validContent(), previewDigest: "x" },
      })
    )
    expect(res.status).toBe(403)
  })

  it("rejects a missing Origin on an admin POST with 403 bad_origin", async () => {
    const token = await adminCookie()
    const preview = await previewPost(
      makeReq("POST", {
        cookie: `primal_session=${token}`,
        body: { format: "json", content: validContent() },
      })
    )
    expect(preview.status).toBe(403)
    const pb = (await preview.json()) as { error: { code: string } }
    expect(pb.error.code).toBe("bad_origin")

    const apply = await applyPost(
      makeReq("POST", {
        cookie: `primal_session=${token}`,
        body: { format: "json", content: validContent(), previewDigest: "x" },
      })
    )
    expect(apply.status).toBe(403)
    const ab = (await apply.json()) as { error: { code: string } }
    expect(ab.error.code).toBe("bad_origin")
  })

  it("rejects a cross-origin admin POST with 403 bad_origin", async () => {
    const token = await adminCookie()
    const res = await previewPost(
      makeReq("POST", {
        origin: "https://evil.example",
        cookie: `primal_session=${token}`,
        body: { format: "json", content: validContent() },
      })
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("bad_origin")
  })

  it("preview returns a bulk result with a digest and never mutates the catalog", async () => {
    const token = await adminCookie()
    const res = await previewPost(
      makeReq("POST", {
        origin: ORIGIN,
        cookie: `primal_session=${token}`,
        body: { format: "json", content: validContent() },
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      source: string
      previewDigest: string
      createCount: number
      skipCount: number
      entries: Array<{ status: string }>
    }
    expect(body.source).toBe("bulk")
    expect(body.previewDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(body.createCount).toBe(1)
    expect(body.skipCount).toBe(0)
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0].status).toBe("create")
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("preview reports an entry that would be skipped without writing", async () => {
    const token = await adminCookie()
    dbMock.store.addCatalog({
      id: "existing-skill",
      kind: "skills",
      stableId: "route-skill",
      name: "Old Skill",
      config: { track: "race", effects: [], rarity: "Common" },
      archived: false,
    })
    const res = await previewPost(
      makeReq("POST", {
        origin: ORIGIN,
        cookie: `primal_session=${token}`,
        body: { format: "json", content: validContent() },
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      createCount: number
      skipCount: number
      entries: Array<{
        status: string
        existing?: { id: string; name: string }
      }>
    }
    expect(body.createCount).toBe(0)
    expect(body.skipCount).toBe(1)
    expect(body.entries[0].status).toBe("skip_existing")
    expect(body.entries[0].existing?.id).toBe("existing-skill")
    expect(dbMock.store.catalog.size).toBe(1)
  })

  it("apply creates the uploaded entry for an admin", async () => {
    const token = await adminCookie()
    const content = validContent()
    const preview = await previewPost(
      makeReq("POST", {
        origin: ORIGIN,
        cookie: `primal_session=${token}`,
        body: { format: "json", content },
      })
    )
    const previewBody = (await preview.json()) as { previewDigest: string }

    const res = await applyPost(
      makeReq("POST", {
        origin: ORIGIN,
        cookie: `primal_session=${token}`,
        body: {
          format: "json",
          content,
          previewDigest: previewBody.previewDigest,
        },
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      source: string
      createCount: number
      createdIds: string[]
    }
    expect(body.source).toBe("bulk")
    expect(body.createCount).toBe(1)
    expect(body.createdIds).toHaveLength(1)
    expect(dbMock.store.catalog.size).toBe(1)
  })

  it("apply rejects a digest mismatch with 400 before any write", async () => {
    const token = await adminCookie()
    const res = await applyPost(
      makeReq("POST", {
        origin: ORIGIN,
        cookie: `primal_session=${token}`,
        body: {
          format: "json",
          content: validContent(),
          previewDigest: "not-the-right-digest",
        },
      })
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("preview_digest_mismatch")
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("apply allows a direct call without previewDigest (preview is not a server gate)", async () => {
    const token = await adminCookie()
    const res = await applyPost(
      makeReq("POST", {
        origin: ORIGIN,
        cookie: `primal_session=${token}`,
        body: { format: "json", content: validContent() },
      })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      createCount: number
      previewDigest: string
    }
    expect(body.createCount).toBe(1)
    expect(body.previewDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(dbMock.store.catalog.size).toBe(1)
  })

  it("apply is idempotent: a repeated identical apply skips all rows", async () => {
    const token = await adminCookie()
    const content = validContent()
    const digest = computeBulkRequestDigest("json", content)
    const first = await applyPost(
      makeReq("POST", {
        origin: ORIGIN,
        cookie: `primal_session=${token}`,
        body: { format: "json", content, previewDigest: digest },
      })
    )
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as { createCount: number }
    expect(firstBody.createCount).toBe(1)

    const second = await applyPost(
      makeReq("POST", {
        origin: ORIGIN,
        cookie: `primal_session=${token}`,
        body: { format: "json", content, previewDigest: digest },
      })
    )
    expect(second.status).toBe(200)
    const secondBody = (await second.json()) as {
      createCount: number
      skipCount: number
      createdIds: string[]
    }
    expect(secondBody.createCount).toBe(0)
    expect(secondBody.skipCount).toBe(1)
    expect(secondBody.createdIds).toHaveLength(0)
    expect(dbMock.store.catalog.size).toBe(1)
  })

  it("rejects a streamed body that exceeds the request cap with 413 (no Content-Length)", async () => {
    const token = await adminCookie()
    const big = "x".repeat(5 * 1024 * 1024)
    const res = await previewPost(
      makeReq("POST", {
        origin: ORIGIN,
        cookie: `primal_session=${token}`,
        body: { format: "json", content: big },
        stream: true,
      })
    )
    expect(res.status).toBe(413)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("payload_too_large")
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("rejects a streamed body with a bogus Content-Length via the stream cap (413)", async () => {
    const token = await adminCookie()
    const big = "x".repeat(5 * 1024 * 1024)
    const res = await previewPost(
      makeReq("POST", {
        origin: ORIGIN,
        cookie: `primal_session=${token}`,
        body: { format: "json", content: big },
        contentLength: "not-a-length",
        stream: true,
      })
    )
    expect(res.status).toBe(413)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("payload_too_large")
  })

  it("rejects an advertised oversized Content-Length with 413 before reading the body", async () => {
    const token = await adminCookie()
    const res = await previewPost(
      makeReq("POST", {
        origin: ORIGIN,
        cookie: `primal_session=${token}`,
        body: { format: "json", content: validContent() },
        contentLength: "99999999",
      })
    )
    expect(res.status).toBe(413)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("payload_too_large")
  })

  it("rejects content that exceeds the 1 MiB decoded cap with 400 content_too_large", async () => {
    const token = await adminCookie()
    // A 1MiB + 1 byte content string, decoded from a small JSON envelope.
    const big = "z".repeat(1024 * 1024 + 1)
    const res = await previewPost(
      makeReq("POST", {
        origin: ORIGIN,
        cookie: `primal_session=${token}`,
        body: { format: "json", content: big },
      })
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("content_too_large")
  })
})
