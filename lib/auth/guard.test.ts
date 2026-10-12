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
