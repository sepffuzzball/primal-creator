import { beforeEach, describe, expect, it, vi } from "vitest"
import { GET } from "./route"
import { createSessionToken } from "@/lib/auth/session"

// Real-jose unit tests against the in-memory Prisma mock. The mock backs the
// `@/lib/db/client` export that BOTH the route and `lib/auth/session` import, so
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

const BASE = "http://localhost/api/catalog/races"

function catalogReq(query = "") {
  return new Request(`${BASE}${query}`, { method: "GET" })
}

describe("api/catalog/[kind] GET (unit, mocked db)", () => {
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

  function seedCatalog() {
    dbMock.store.addCatalog({
      id: "race-active",
      kind: "races",
      stableId: "race-active",
      name: "Active race",
      config: {},
      archived: false,
    })
    dbMock.store.addCatalog({
      id: "race-archived",
      kind: "races",
      stableId: "race-archived",
      name: "Archived race",
      config: {},
      archived: true,
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

  function authed(req: Request, token: string): Request {
    const headers = new Headers(req.headers)
    headers.set("cookie", `primal_session=${token}`)
    return new Request(req.url, {
      method: req.method,
      headers,
      body: req.body,
      duplex: "half",
    } as RequestInit)
  }

  it("rejects includeArchived=1 for an anonymous caller with 401", async () => {
    seedCatalog()
    const res = await GET(catalogReq("?includeArchived=1"), {
      params: Promise.resolve({ kind: "races" }),
    })
    expect(res.status).toBe(401)
  })

  it("rejects includeArchived=1 for a non-admin with 403", async () => {
    seedCatalog()
    const token = await regularCookie()
    const res = await GET(authed(catalogReq("?includeArchived=1"), token), {
      params: Promise.resolve({ kind: "races" }),
    })
    expect(res.status).toBe(403)
  })

  it("returns active and archived items for an admin with includeArchived=1", async () => {
    seedCatalog()
    const token = await adminCookie()
    const res = await GET(authed(catalogReq("?includeArchived=1"), token), {
      params: Promise.resolve({ kind: "races" }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      kind: string
      items: Array<{ stableId: string; archived: boolean }>
    }
    expect(body.kind).toBe("races")
    const ids = body.items.map((i) => i.stableId).sort()
    expect(ids).toEqual(["race-active", "race-archived"])
    expect(
      body.items.find((i) => i.stableId === "race-archived")?.archived
    ).toBe(true)
  })

  it("default GET (no query) returns only active items", async () => {
    seedCatalog()
    const token = await adminCookie()
    const res = await GET(authed(catalogReq(), token), {
      params: Promise.resolve({ kind: "races" }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: Array<{ stableId: string; archived: boolean }>
    }
    expect(body.items.map((i) => i.stableId)).toEqual(["race-active"])
    expect(body.items.every((i) => i.archived === false)).toBe(true)
  })

  it("treats a non-'1' includeArchived value as false (ignored) for a non-admin", async () => {
    seedCatalog()
    const token = await regularCookie()
    const res = await GET(authed(catalogReq("?includeArchived=0"), token), {
      params: Promise.resolve({ kind: "races" }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: Array<{ stableId: string; archived: boolean }>
    }
    expect(body.items.map((i) => i.stableId)).toEqual(["race-active"])
  })
})
