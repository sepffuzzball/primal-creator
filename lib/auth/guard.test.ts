import { describe, it, expect, vi, beforeEach } from "vitest"
import { assertOrigin, requireAdmin, requireUser } from "@/lib/auth/guard"
import { createSessionToken } from "@/lib/auth/session"

type TestStore = import("../db/testPrisma").TestPrismaInstance["store"]

const dbMock = vi.hoisted(() => ({
  store: undefined as unknown as TestStore,
}))

vi.mock("@/lib/db/client", async () => {
  const { createTestPrisma } = await import("../db/testPrisma")
  const instance = createTestPrisma()
  dbMock.store = instance.store
  return { prisma: instance.prisma, default: instance.prisma }
})

process.env.AUTH_SECRET = "x".repeat(40)

beforeEach(() => {
  dbMock.store.reset()
  delete process.env.APP_ORIGIN
  delete process.env.TRUST_PROXY_HEADERS
})

const BASE_URL = "http://localhost/api/test"

function req(
  method: string,
  origin: string | null,
  url: string = BASE_URL,
  cookie?: string
): Request {
  const headers: Record<string, string> = {}
  if (origin !== null) headers.origin = origin
  if (cookie) headers.cookie = cookie
  return new Request(url, { method, headers })
}

function reqFwd(
  method: string,
  origin: string | null,
  forwarded: { proto?: string | null; host?: string | null },
  url: string = BASE_URL
): Request {
  const headers: Record<string, string> = {}
  if (origin !== null) headers.origin = origin
  if (forwarded.proto != null) headers["x-forwarded-proto"] = forwarded.proto
  if (forwarded.host != null) headers["x-forwarded-host"] = forwarded.host
  return new Request(url, { method, headers })
}

function enableTrust(): void {
  process.env.TRUST_PROXY_HEADERS = "true"
}

function expectSyncError(fn: () => void, status: number, code: string): void {
  let caught: unknown
  try {
    fn()
  } catch (err) {
    caught = err
  }
  expect(caught).toMatchObject({ status, code })
}

describe("assertOrigin", () => {
  it("accepts a matching same-origin unsafe request", () => {
    expect(() => assertOrigin(req("POST", "http://localhost"))).not.toThrow()
  })

  it("rejects a missing Origin on an unsafe method with 403 bad_origin", () => {
    expectSyncError(() => assertOrigin(req("POST", null)), 403, "bad_origin")
  })

  it("rejects a cross-origin mismatch with 403 bad_origin", () => {
    expectSyncError(
      () => assertOrigin(req("DELETE", "https://evil.example")),
      403,
      "bad_origin"
    )
  })

  it("rejects a sibling subdomain (no suffix wildcard)", () => {
    expectSyncError(
      () => assertOrigin(req("PATCH", "http://sub.localhost")),
      403,
      "bad_origin"
    )
  })

  it("accepts a safe method (GET) with no Origin header", () => {
    expect(() => assertOrigin(req("GET", null))).not.toThrow()
    expect(() => assertOrigin(req("HEAD", null))).not.toThrow()
    expect(() => assertOrigin(req("OPTIONS", null))).not.toThrow()
  })

  it("uses APP_ORIGIN when configured and rejects any other origin", () => {
    process.env.APP_ORIGIN = "https://app.example.com"
    expect(() =>
      assertOrigin(req("POST", "https://app.example.com"))
    ).not.toThrow()
    expectSyncError(
      () => assertOrigin(req("POST", "http://localhost")),
      403,
      "bad_origin"
    )
    // A trailing slash on APP_ORIGIN is normalized; a sibling subdomain still fails.
    process.env.APP_ORIGIN = "https://app.example.com/"
    expect(() =>
      assertOrigin(req("POST", "https://app.example.com"))
    ).not.toThrow()
    expectSyncError(
      () => assertOrigin(req("POST", "https://sub.app.example.com")),
      403,
      "bad_origin"
    )
  })
})

describe("forwarded proxy trust mode (TRUST_PROXY_HEADERS=true)", () => {
  it("accepts a same-origin request when the public origin is reconstructed from forwarded headers", () => {
    enableTrust()
    expect(() =>
      assertOrigin(
        reqFwd("POST", "https://primalcreator.fuzzball.enterprises", {
          proto: "https",
          host: "primalcreator.fuzzball.enterprises",
        })
      )
    ).not.toThrow()
  })

  it("accepts a bracketed IPv6 forwarded host (with and without a port)", () => {
    enableTrust()
    expect(() =>
      assertOrigin(
        reqFwd("POST", "http://[2001:db8::1]", {
          proto: "http",
          host: "[2001:db8::1]",
        })
      )
    ).not.toThrow()
    expect(() =>
      assertOrigin(
        reqFwd("POST", "http://[2001:db8::1]:8080", {
          proto: "http",
          host: "[2001:db8::1]:8080",
        })
      )
    ).not.toThrow()
  })

  it("ignores forwarded headers when TRUST_PROXY_HEADERS is unset and uses the request URL", () => {
    // Trust is disabled (default): forwarded headers are ignored entirely, so the
    // request's own URL origin is what matters.
    expect(() =>
      assertOrigin(
        reqFwd("POST", "http://localhost", {
          proto: "https",
          host: "primalcreator.fuzzball.enterprises",
        })
      )
    ).not.toThrow()
    // The forwarded public origin is NOT the expected one while trust is off.
    expectSyncError(
      () =>
        assertOrigin(
          reqFwd("POST", "https://primalcreator.fuzzball.enterprises", {
            proto: "https",
            host: "primalcreator.fuzzball.enterprises",
          })
        ),
      403,
      "bad_origin"
    )
  })

  it("prefers APP_ORIGIN over forwarded headers (highest priority)", () => {
    process.env.APP_ORIGIN = "https://primalcreator.fuzzball.enterprises"
    enableTrust()
    // A malicious forwarded pair elsewhere must not override APP_ORIGIN.
    expect(() =>
      assertOrigin(
        reqFwd("POST", "https://primalcreator.fuzzball.enterprises", {
          proto: "http",
          host: "evil.internal",
        })
      )
    ).not.toThrow()
    expectSyncError(
      () =>
        assertOrigin(
          reqFwd("POST", "http://localhost", {
            proto: "http",
            host: "evil.internal",
          })
        ),
      403,
      "bad_origin"
    )
  })

  it("fails closed when forwarded headers are missing in trust mode", () => {
    enableTrust()
    expectSyncError(
      () => assertOrigin(reqFwd("POST", "http://localhost", {})),
      403,
      "bad_origin"
    )
  })

  it("fails closed on whitespace in forwarded headers", () => {
    enableTrust()
    // `Headers` trims leading/trailing HTTP whitespace (OWS) from a header value
    // before `Request` exposes it, so " https" / "host " is normalized to
    // "https" / "host" and never reaches the guard's whitespace check. Only
    // whitespace embedded inside the value (which survives normalization) is
    // observable, so use that to exercise the rejection.
    expectSyncError(
      () =>
        assertOrigin(
          reqFwd("POST", "https://primalcreator.fuzzball.enterprises", {
            proto: "ht tps",
            host: "primalcreator.fuzzball.enterprises",
          })
        ),
      403,
      "bad_origin"
    )
    expectSyncError(
      () =>
        assertOrigin(
          reqFwd("POST", "https://primalcreator.fuzzball.enterprises", {
            proto: "https",
            host: "primalcreator .fuzzball.enterprises",
          })
        ),
      403,
      "bad_origin"
    )
  })

  it("rejects ambiguous comma-separated forwarded values", () => {
    enableTrust()
    expectSyncError(
      () =>
        assertOrigin(
          reqFwd("POST", "https://primalcreator.fuzzball.enterprises", {
            proto: "https, http",
            host: "primalcreator.fuzzball.enterprises",
          })
        ),
      403,
      "bad_origin"
    )
    expectSyncError(
      () =>
        assertOrigin(
          reqFwd("POST", "https://primalcreator.fuzzball.enterprises", {
            proto: "https",
            host: "a.example.com, b.example.com",
          })
        ),
      403,
      "bad_origin"
    )
  })

  it("rejects malformed forwarded hosts (credentials, path, query, fragment, unbracketed IPv6)", () => {
    enableTrust()
    const malformed = [
      "user:pass@primalcreator.fuzzball.enterprises",
      "primalcreator.fuzzball.enterprises/path",
      "primalcreator.fuzzball.enterprises?x=1",
      "primalcreator.fuzzball.enterprises#frag",
      "2001:db8::1",
    ]
    for (const host of malformed) {
      expectSyncError(
        () =>
          assertOrigin(
            reqFwd("POST", "https://primalcreator.fuzzball.enterprises", {
              proto: "https",
              host,
            })
          ),
        403,
        "bad_origin"
      )
    }
  })

  it("rejects invalid forwarded host ports", () => {
    enableTrust()
    const invalidPorts = [
      "primalcreator.fuzzball.enterprises:abc",
      "primalcreator.fuzzball.enterprises:",
      "primalcreator.fuzzball.enterprises:70000",
      "primalcreator.fuzzball.enterprises:65536",
    ]
    for (const host of invalidPorts) {
      expectSyncError(
        () =>
          assertOrigin(
            reqFwd("POST", "https://primalcreator.fuzzball.enterprises", {
              proto: "https",
              host,
            })
          ),
        403,
        "bad_origin"
      )
    }
  })

  it("accepts a forwarded host with a valid non-default port", () => {
    enableTrust()
    expect(() =>
      assertOrigin(
        reqFwd("POST", "https://primalcreator.fuzzball.enterprises:8443", {
          proto: "https",
          host: "primalcreator.fuzzball.enterprises:8443",
        })
      )
    ).not.toThrow()
  })

  it("rejects a sibling subdomain in trust mode (exact origin, no wildcard)", () => {
    enableTrust()
    expectSyncError(
      () =>
        assertOrigin(
          reqFwd("POST", "https://sub.primalcreator.fuzzball.enterprises", {
            proto: "https",
            host: "primalcreator.fuzzball.enterprises",
          })
        ),
      403,
      "bad_origin"
    )
  })

  it("rejects a missing Origin header even in trust mode", () => {
    enableTrust()
    expectSyncError(
      () =>
        assertOrigin(
          reqFwd("POST", null, {
            proto: "https",
            host: "primalcreator.fuzzball.enterprises",
          })
        ),
      403,
      "bad_origin"
    )
  })
})

describe("requireUser / requireAdmin (origin is enforced before session lookup)", () => {
  it("rejects a cross-origin POST with 403 bad_origin even without a session", async () => {
    const r = req("POST", "https://evil.example")
    await expect(requireUser(r)).rejects.toMatchObject({
      status: 403,
      code: "bad_origin",
    })
  })

  it("rejects a missing-origin POST with 403 bad_origin (not 401)", async () => {
    const r = req("POST", null, BASE_URL, "primal_session=whatever")
    await expect(requireUser(r)).rejects.toMatchObject({
      status: 403,
      code: "bad_origin",
    })
  })

  it("rejects a sibling subdomain for requireAdmin with 403 bad_origin", async () => {
    const r = req("PATCH", "http://sub.localhost")
    await expect(requireAdmin(r)).rejects.toMatchObject({
      status: 403,
      code: "bad_origin",
    })
  })

  it("admits an authenticated same-origin request through requireUser", async () => {
    const id = "u1"
    dbMock.store.addUser({ id, email: "u@example.com", isAdmin: false })
    const token = await createSessionToken(
      { id, email: "u@example.com", isAdmin: false },
      0
    )
    const r = req(
      "POST",
      "http://localhost",
      BASE_URL,
      `primal_session=${token}`
    )
    const user = await requireUser(r)
    expect(user).toMatchObject({ id, email: "u@example.com", isAdmin: false })
  })

  it("admits an authenticated same-origin request through requireAdmin", async () => {
    const id = "admin-1"
    dbMock.store.addUser({ id, email: "admin@example.com", isAdmin: true })
    const token = await createSessionToken(
      { id, email: "admin@example.com", isAdmin: true },
      0
    )
    const r = req(
      "POST",
      "http://localhost",
      BASE_URL,
      `primal_session=${token}`
    )
    const user = await requireAdmin(r)
    expect(user).toMatchObject({ id, isAdmin: true })
  })
})
