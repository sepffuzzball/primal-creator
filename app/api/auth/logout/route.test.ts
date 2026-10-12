import { describe, it, expect, beforeEach } from "vitest"
import { POST } from "./route"
import { SESSION_COOKIE } from "@/lib/auth/session"

beforeEach(() => {
  delete process.env.APP_ORIGIN
})

const URL = "http://localhost/api/auth/logout"

function req(origin: string | null): Request {
  const headers: Record<string, string> = {}
  if (origin !== null) headers.origin = origin
  return new Request(URL, { method: "POST", headers })
}

describe("POST /api/auth/logout", () => {
  it("clears the session cookie for a matching same-origin request", async () => {
    const res = await POST(req("http://localhost"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
    const setCookie = res.headers.get("set-cookie") ?? ""
    expect(setCookie).toContain(`${SESSION_COOKIE}=`)
  })

  it("rejects a missing Origin with 403 bad_origin", async () => {
    const res = await POST(req(null))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("bad_origin")
  })

  it("rejects a sibling subdomain Origin with 403 bad_origin", async () => {
    const res = await POST(req("http://sub.localhost"))
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("bad_origin")
  })

  it("honors APP_ORIGIN when configured", async () => {
    process.env.APP_ORIGIN = "https://app.example.com"
    const same = await POST(req("https://app.example.com"))
    expect(same.status).toBe(200)
    const cross = await POST(req("http://localhost"))
    expect(cross.status).toBe(403)
    const body = (await cross.json()) as { error: { code: string } }
    expect(body.error.code).toBe("bad_origin")
  })
})
