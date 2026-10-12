import { NextResponse } from "next/server"

import { requireUser } from "@/lib/auth/guard"
import {
  SESSION_COOKIE,
  cookieOptions,
  createSessionToken,
} from "@/lib/auth/session"
import { changeOwnPassword } from "@/lib/db/user-service"
import { badRequest, respond } from "@/lib/server/errors"
import { passwordChangeSchema } from "@/lib/server/schemas"

export const runtime = "nodejs"

/**
 * Self-service password change.
 *
 * Requires an authenticated session. The current password is verified with bcrypt;
 * a too-weak (< 12 chars) or identical new password is rejected. On success the
 * user's `sessionVersion` is bumped, which revokes EVERY previously issued token,
 * then a fresh HttpOnly cookie is set with the new token/version so the current
 * browser stays signed in. Old tokens (other devices, prior cookies) are rejected
 * by `verifySessionToken` on their next request.
 */
export async function POST(req: Request) {
  return respond(async () => {
    const session = await requireUser(req)
    const body = await req.json().catch(() => null)
    const parsed = passwordChangeSchema.safeParse(body)
    if (!parsed.success) {
      throw badRequest(
        "validation",
        "Provide a current password and a new password (at least 12 characters)"
      )
    }

    const result = await changeOwnPassword(session, parsed.data)
    const token = await createSessionToken(result.user, result.sessionVersion)

    const res = NextResponse.json({
      user: {
        id: result.user.id,
        email: result.user.email,
        isAdmin: result.user.isAdmin,
      },
    })
    res.cookies.set(SESSION_COOKIE, token, cookieOptions())
    return res
  })
}
