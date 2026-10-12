import { beforeEach, describe, expect, it, vi } from "vitest"
import { GET, PATCH } from "./route"
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

const ORIGIN = "http://localhost"
const URL = "http://localhost/api/admin/rules"

function rulesReq(method: "GET" | "PATCH", body?: unknown) {
  const init: RequestInit = { method }
  if (method === "PATCH") {
    init.headers = { origin: ORIGIN }
    init.body = JSON.stringify(body)
  }
  return new Request(URL, init)
}

describe("api/admin/rules (unit, mocked db)", () => {
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

  function seedRules() {
    return dbMock.store.addHouseRules({
      id: "active",
      version: 0,
      config: DEFAULT_HOUSE_RULES_CONFIG,
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
    // Build the authenticated request explicitly: spreading a undici Request
    // does NOT copy `method`/`body`, which would silently drop a PATCH body. A
    // stream body additionally requires `duplex: "half"`.
    return new Request(req.url, {
      method: req.method,
      headers,
      body: req.body,
      duplex: "half",
    } as RequestInit)
  }

  it("GET requires an authenticated admin (401 when anonymous)", async () => {
    const res = await GET(rulesReq("GET"))
    expect(res.status).toBe(401)
  })

  it("GET rejects a non-admin with 403", async () => {
    const token = await regularCookie()
    const res = await GET(authed(rulesReq("GET"), token))
    expect(res.status).toBe(403)
  })

  it("GET returns the current validated version, config and updatedAt for an admin", async () => {
    seedRules()
    const token = await adminCookie()
    const res = await GET(authed(rulesReq("GET"), token))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      version: number
      config: typeof DEFAULT_HOUSE_RULES_CONFIG
      updatedAt: string
    }
    expect(body.version).toBe(0)
    expect(body.config).toEqual(DEFAULT_HOUSE_RULES_CONFIG)
    expect(typeof body.updatedAt).toBe("string")
  })

  it("PATCH requires an authenticated admin (401 when anonymous)", async () => {
    seedRules()
    const res = await PATCH(
      rulesReq("PATCH", { version: 0, config: DEFAULT_HOUSE_RULES_CONFIG })
    )
    expect(res.status).toBe(401)
  })

  it("PATCH rejects a non-admin with 403", async () => {
    seedRules()
    const token = await regularCookie()
    const res = await PATCH(
      authed(
        rulesReq("PATCH", { version: 0, config: DEFAULT_HOUSE_RULES_CONFIG }),
        token
      )
    )
    expect(res.status).toBe(403)
  })

  it("PATCH applies a full config and bumps the version (optimistic CAS)", async () => {
    seedRules()
    const token = await adminCookie()
    const nextConfig = {
      equipmentIndividualCapPercent: 25,
      equipmentCombinedCapPercent: 20,
      consumableGradeRates: { F: 4, E: 6, D: 18, C: 50 },
    }
    const res = await PATCH(
      authed(rulesReq("PATCH", { version: 0, config: nextConfig }), token)
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      version: number
      config: typeof nextConfig
    }
    expect(body.version).toBe(1)
    expect(body.config).toEqual(nextConfig)
  })

  it("PATCH rejects a stale version with 409 (never silently clobbers)", async () => {
    seedRules()
    const token = await adminCookie()
    // Bump to version 5 through two successful writes.
    await PATCH(
      authed(
        rulesReq("PATCH", { version: 0, config: DEFAULT_HOUSE_RULES_CONFIG }),
        token
      )
    )
    const res = await PATCH(
      authed(
        rulesReq("PATCH", { version: 0, config: DEFAULT_HOUSE_RULES_CONFIG }),
        token
      )
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("version_conflict")
  })

  it("PATCH returns 503 when the singleton row is missing (never defaults)", async () => {
    // The mock seeds the singleton by default; clear it to exercise the missing
    // path explicitly.
    dbMock.store.houseRules.clear()
    const token = await adminCookie()
    const res = await PATCH(
      authed(
        rulesReq("PATCH", { version: 0, config: DEFAULT_HOUSE_RULES_CONFIG }),
        token
      )
    )
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("ruleset_unavailable")
  })

  it("GET returns 503 when the singleton row is missing (never defaults)", async () => {
    dbMock.store.houseRules.clear()
    const token = await adminCookie()
    const res = await GET(authed(rulesReq("GET"), token))
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("ruleset_unavailable")
  })

  it("interleaved admin updates each return their own committed result", async () => {
    seedRules()
    const token = await adminCookie()

    const firstConfig = {
      equipmentIndividualCapPercent: 25,
      equipmentCombinedCapPercent: 20,
      consumableGradeRates: { F: 4, E: 6, D: 18, C: 50 },
    }
    const first = await PATCH(
      authed(rulesReq("PATCH", { version: 0, config: firstConfig }), token)
    )
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as {
      version: number
      config: typeof firstConfig
    }
    expect(firstBody.version).toBe(1)
    expect(firstBody.config).toEqual(firstConfig)

    // The second edit uses the version the first committed update returned, so it
    // must succeed and return ITS OWN committed version/config, not the first's.
    const secondConfig = {
      equipmentIndividualCapPercent: 30,
      equipmentCombinedCapPercent: 25,
      consumableGradeRates: { F: 5, E: 7, D: 20, C: 55 },
    }
    const second = await PATCH(
      authed(
        rulesReq("PATCH", { version: firstBody.version, config: secondConfig }),
        token
      )
    )
    expect(second.status).toBe(200)
    const secondBody = (await second.json()) as {
      version: number
      config: typeof secondConfig
    }
    expect(secondBody.version).toBe(2)
    expect(secondBody.config).toEqual(secondConfig)
  })

  it("PATCH rejects a malformed config with 400", async () => {
    seedRules()
    const token = await adminCookie()
    const res = await PATCH(
      authed(
        rulesReq("PATCH", {
          version: 0,
          config: { equipmentIndividualCapPercent: 20 },
        }),
        token
      )
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("validation")
  })

  it("PATCH rejects a negative percentage with 400", async () => {
    seedRules()
    const token = await adminCookie()
    const res = await PATCH(
      authed(
        rulesReq("PATCH", {
          version: 0,
          config: {
            equipmentIndividualCapPercent: -1,
            equipmentCombinedCapPercent: 15,
            consumableGradeRates: { F: 3, E: 5, D: 15, C: 45 },
          },
        }),
        token
      )
    )
    expect(res.status).toBe(400)
  })

  it("PATCH rejects an unknown config key with 400 (strict shape)", async () => {
    seedRules()
    const token = await adminCookie()
    const res = await PATCH(
      authed(
        rulesReq("PATCH", {
          version: 0,
          config: {
            ...DEFAULT_HOUSE_RULES_CONFIG,
            futureKnob: 1,
          },
        }),
        token
      )
    )
    expect(res.status).toBe(400)
  })
})
