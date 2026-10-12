import { describe, it, expect, beforeEach, vi } from "vitest"
import bcrypt from "bcryptjs"
import { POST } from "./route"
import { SESSION_COOKIE } from "@/lib/auth/session"

type TestStore = import("@/lib/db/testPrisma").TestPrismaInstance["store"]

const dbMock = vi.hoisted(() => ({
  store: undefined as unknown as TestStore,
}))

vi.mock("@/lib/db/client", async () => {
  const { createTestPrisma } = await import("@/lib/db/testPrisma")
  const instance = createTestPrisma()
  dbMock.store = instance.store
  return { prisma: instance.prisma, default: instance.prisma }
})

process.env.AUTH_SECRET = "x".repeat(40)

beforeEach(() => {
  dbMock.store.reset()
  delete process.env.APP_ORIGIN
})

const URL = "http://localhost/api/auth/login"
const EMAIL = "u@example.com"
const PASSWORD = "correct-horse"

function req(origin: string | null, body?: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (origin !== null) headers.origin = origin
  return new Request(URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? { email: EMAIL, password: PASSWORD }),
  })
}

async function seedUser(): Promise<void> {
  dbMock.store.addUser({
    id: "u1",
    email: EMAIL,
    password: await bcrypt.hash(PASSWORD, 10),
    isAdmin: false,
  })
}

function expectCode(
  res: Response,
  status: number,
  code: string
): Promise<void> {
  expect(res.status).toBe(status)
  return res.json().then((body: { error: { code: string } }) => {
    expect(body.error.code).toBe(code)
  })
}

describe("POST /api/auth/login", () => {
  it("logs in a valid same-origin user and sets the session cookie", async () => {
    await seedUser()
    const res = await POST(req("http://localhost"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      user: { id: string; email: string; isAdmin: boolean }
    }
    expect(body.user).toMatchObject({
      id: "u1",
      email: EMAIL,
      isAdmin: false,
    })
    const setCookie = res.headers.get("set-cookie") ?? ""
    expect(setCookie).toContain(`${SESSION_COOKIE}=`)
  })

  it("rejects a missing Origin with 403 bad_origin and sets no cookie", async () => {
    const res = await POST(req(null))
    await expectCode(res, 403, "bad_origin")
    expect(res.headers.get("set-cookie")).toBeNull()
  })

  it("rejects a cross-origin request with 403 bad_origin and sets no cookie", async () => {
    const res = await POST(req("https://evil.example"))
    await expectCode(res, 403, "bad_origin")
    expect(res.headers.get("set-cookie")).toBeNull()
  })

  it("rejects a sibling subdomain with 403 bad_origin and sets no cookie", async () => {
    const res = await POST(req("http://sub.localhost"))
    await expectCode(res, 403, "bad_origin")
    expect(res.headers.get("set-cookie")).toBeNull()
  })

  it("honors APP_ORIGIN when configured", async () => {
    await seedUser()
    process.env.APP_ORIGIN = "https://app.example.com"
    const same = await POST(req("https://app.example.com"))
    expect(same.status).toBe(200)
    const cross = await POST(req("http://localhost"))
    await expectCode(cross, 403, "bad_origin")
  })

  it("rejects invalid credentials with 401 invalid_credentials and sets no cookie", async () => {
    await seedUser()
    const res = await POST(
      req("http://localhost", { email: EMAIL, password: "wrong" })
    )
    await expectCode(res, 401, "invalid_credentials")
    expect(res.headers.get("set-cookie")).toBeNull()
  })
})
