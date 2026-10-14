import { beforeEach, describe, expect, it, vi } from "vitest"
import { GET } from "./route"
import { createSessionToken } from "@/lib/auth/session"
import { DEFAULT_HOUSE_RULES_CONFIG } from "@/lib/db/ruleset"

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

const URL = "http://localhost/api/rules/creation"

function rulesReq(method: "GET") {
  return new Request(URL, { method })
}

describe("api/rules/creation (unit, mocked db)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function seedRules() {
    return dbMock.store.addHouseRules({
      id: "active",
      version: 0,
      config: DEFAULT_HOUSE_RULES_CONFIG,
    })
  }

  async function userCookie() {
    const row = await dbMock.store.addUser({
      id: "user-1",
      email: "user@example.com",
      isAdmin: false,
      sessionVersion: 0,
    })
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
    })
  }

  it("GET requires an authenticated user (401 when anonymous)", async () => {
    const res = await GET(rulesReq("GET"))
    expect(res.status).toBe(401)
  })

  it("GET returns only maxTranscendentSkills from the persisted house rules", async () => {
    seedRules()
    const token = await userCookie()
    const res = await GET(authed(rulesReq("GET"), token))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { maxTranscendentSkills: number }
    expect(body).toEqual({ maxTranscendentSkills: 3 })
  })

  it("GET surfaces the admin-configured transcendent cap", async () => {
    dbMock.store.addHouseRules({
      id: "active",
      version: 0,
      config: {
        ...DEFAULT_HOUSE_RULES_CONFIG,
        maxTranscendentSkills: 6,
      },
    })
    const token = await userCookie()
    const res = await GET(authed(rulesReq("GET"), token))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { maxTranscendentSkills: number }
    expect(body).toEqual({ maxTranscendentSkills: 6 })
  })

  it("GET returns 503 when the singleton row is missing (never defaults)", async () => {
    // The mock seeds the singleton by default; clear it to exercise the missing
    // path explicitly.
    dbMock.store.houseRules.clear()
    const token = await userCookie()
    const res = await GET(authed(rulesReq("GET"), token))
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("ruleset_unavailable")
  })
})
