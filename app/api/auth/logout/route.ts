import { NextResponse } from "next/server"
import { assertOrigin } from "@/lib/auth/guard"
import { SESSION_COOKIE, cookieOptions } from "@/lib/auth/session"
import { respond } from "@/lib/server/errors"

export const runtime = "nodejs"

/**
 * Clear the session cookie.
 *
 * Logout is a state-changing (unsafe) POST, so it is subject to the same
 * same-origin CSRF check as every other cookie-authenticated write: the `Origin`
 * header must exactly match the configured `APP_ORIGIN` (or, when unset, the
 * request's own origin). A cross-origin or missing `Origin` is rejected with
 * 403 `bad_origin` before the cookie is cleared.
 */
export async function POST(req: Request) {
  return respond(async () => {
    assertOrigin(req)
    const res = NextResponse.json({ ok: true })
    res.cookies.set(SESSION_COOKIE, "", { ...cookieOptions(), maxAge: 0 })
    return res
  })
}
