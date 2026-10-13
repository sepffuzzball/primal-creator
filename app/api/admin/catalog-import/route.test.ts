import { beforeEach, describe, expect, it, vi } from "vitest"
import { GET, POST } from "./route"
import { createSessionToken } from "@/lib/auth/session"

// Real-jose unit tests against the in-memory Prisma mock. The mock backs the
// `@/lib/db/client` export that BOTH the route and `lib/auth/session` import, so
// an issued session token verifies against the seeded fixture user. The route uses
// the fixed production manifest; the edge-case manifests are exercised in
// `lib/db/catalog-import.test.ts`.
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
const URL = "http://localhost/api/admin/catalog-import"

function makeReq(
  method: "GET" | "POST",
  opts: { origin?: string | null; cookie?: string } = {}
): Request {
  const headers = new Headers()
  if (opts.origin != null) headers.set("origin", opts.origin)
  if (opts.cookie) headers.set("cookie", opts.cookie)
  return new Request(URL, { method, headers })
}

describe("api/admin/catalog-import (unit, mocked db)", () => {
  beforeEach(() => {
    dbMock.store.reset()
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

  it("GET requires an authenticated admin (401 when anonymous)", async () => {
    const res = await GET(makeReq("GET"))
    expect(res.status).toBe(401)
  })

  it("GET rejects a non-admin with 403", async () => {
    const token = await regularCookie()
    const res = await GET(makeReq("GET", { cookie: `primal_session=${token}` }))
    expect(res.status).toBe(403)
  })

  it("GET returns a preview without mutating the catalog for an admin", async () => {
    const token = await adminCookie()
    const res = await GET(makeReq("GET", { cookie: `primal_session=${token}` }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      source: string
      createCount: number
      skipCount: number
      entries: Array<{ status: string }>
    }
    expect(body.source).toBe("wiki-reviewed")
    expect(body.createCount).toBe(6)
    expect(body.skipCount).toBe(0)
    expect(body.entries).toHaveLength(6)
    expect(body.entries.every((e) => e.status === "create")).toBe(true)
    // GET must never write.
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("POST requires an authenticated admin (401 when anonymous, same-origin)", async () => {
    const res = await POST(makeReq("POST", { origin: ORIGIN }))
    expect(res.status).toBe(401)
  })

  it("POST rejects a non-admin with 403", async () => {
    const token = await regularCookie()
    const res = await POST(
      makeReq("POST", { origin: ORIGIN, cookie: `primal_session=${token}` })
    )
    expect(res.status).toBe(403)
  })

  it("POST creates the six curated entries for an admin", async () => {
    const token = await adminCookie()
    const res = await POST(
      makeReq("POST", { origin: ORIGIN, cookie: `primal_session=${token}` })
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      source: string
      createCount: number
      skipCount: number
      createdIds: string[]
    }
    expect(body.source).toBe("wiki-reviewed")
    expect(body.createCount).toBe(6)
    expect(body.skipCount).toBe(0)
    expect(body.createdIds).toHaveLength(6)
    expect(dbMock.store.catalog.size).toBe(6)
  })

  it("GET and POST report the actual metadata of a skipped existing house row", async () => {
    const token = await adminCookie()
    dbMock.store.addCatalog({
      id: "house-title",
      kind: "titles",
      stableId: "legendary-prodigy",
      name: "Old Legendary Prodigy",
      config: { houseNote: true },
      provenance: "house",
      sourceUrl: "https://house.example/old",
      archived: false,
    })
    type SkipEntry = {
      status: string
      existing?: {
        name: string
        provenance: string
        sourceUrl: string | null
        archived: boolean
      }
    }
    // GET: skipped entry keeps the proposed manifest name/source but reports the
    // actual house row metadata under `existing`, and never writes.
    const getRes = await GET(
      makeReq("GET", { cookie: `primal_session=${token}` })
    )
    expect(getRes.status).toBe(200)
    const getBody = (await getRes.json()) as {
      createCount: number
      skipCount: number
      entries: SkipEntry[]
    }
    expect(getBody.createCount).toBe(5)
    expect(getBody.skipCount).toBe(1)
    const getSkipped = getBody.entries.find(
      (e) => e.status === "skip_existing"
    )!
    expect(getSkipped.existing).toEqual({
      id: "house-title",
      name: "Old Legendary Prodigy",
      provenance: "house",
      sourceUrl: "https://house.example/old",
      archived: false,
    })
    expect(dbMock.store.catalog.size).toBe(1)

    // POST: the apply response reports the same actual metadata for the skipped
    // row and never overwrites the pre-existing house row.
    const postRes = await POST(
      makeReq("POST", { origin: ORIGIN, cookie: `primal_session=${token}` })
    )
    expect(postRes.status).toBe(200)
    const postBody = (await postRes.json()) as {
      createCount: number
      skipCount: number
      entries: SkipEntry[]
    }
    expect(postBody.createCount).toBe(5)
    expect(postBody.skipCount).toBe(1)
    const postSkipped = postBody.entries.find(
      (e) => e.status === "skip_existing"
    )!
    expect(postSkipped.existing).toEqual({
      id: "house-title",
      name: "Old Legendary Prodigy",
      provenance: "house",
      sourceUrl: "https://house.example/old",
      archived: false,
    })
    const row = [...dbMock.store.catalog.values()].find(
      (r) => r.id === "house-title"
    )!
    expect(row.provenance).toBe("house")
    expect(row.name).toBe("Old Legendary Prodigy")
  })

  it("POST is idempotent: an identical repeated apply skips all existing rows", async () => {
    const token = await adminCookie()
    const first = await POST(
      makeReq("POST", { origin: ORIGIN, cookie: `primal_session=${token}` })
    )
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as { createCount: number }
    expect(firstBody.createCount).toBe(6)

    const second = await POST(
      makeReq("POST", { origin: ORIGIN, cookie: `primal_session=${token}` })
    )
    expect(second.status).toBe(200)
    const secondBody = (await second.json()) as {
      createCount: number
      skipCount: number
      createdIds: string[]
    }
    expect(secondBody.createCount).toBe(0)
    expect(secondBody.skipCount).toBe(6)
    expect(secondBody.createdIds).toHaveLength(0)
    expect(dbMock.store.catalog.size).toBe(6)
  })

  it("POST rejects a missing Origin on an admin call with 403 bad_origin", async () => {
    const token = await adminCookie()
    const res = await POST(
      makeReq("POST", { cookie: `primal_session=${token}` })
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("bad_origin")
  })

  it("POST rejects a cross-origin admin call with 403 bad_origin", async () => {
    const token = await adminCookie()
    const res = await POST(
      makeReq("POST", {
        origin: "https://evil.example",
        cookie: `primal_session=${token}`,
      })
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("bad_origin")
  })
})
