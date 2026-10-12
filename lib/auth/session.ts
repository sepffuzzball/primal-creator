/**
 * JWT session helpers (via `jose`) plus cookie read/write primitives.
 *
 * The session is a stateless HS256 JWT carrying the user's id, email and admin
 * flag plus a numeric `sessionVersion`. It is delivered as an HttpOnly,
 * SameSite=Lax cookie that is marked `Secure` in production. `AUTH_SECRET` must
 * be at least 32 characters.
 *
 * Session revocation is enforced by the `sessionVersion` counter: every
 * role/disable/password change increments it in the database, and
 * `verifySessionToken` rejects any token whose version does not match the row.
 * Tokens that predate the counter (legacy, no `sessionVersion` claim) are also
 * rejected so old JWTs are invalidated. On every verification we query the user
 * row, so a disabled or deleted user loses their session immediately and the
 * returned email/isAdmin always reflect the current database (never the stale
 * JWT claims).
 */

import { SignJWT, jwtVerify } from "jose"
import { cookies } from "next/headers"
import { prisma } from "@/lib/db/client"

export const SESSION_COOKIE = "primal_session"
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7 // 7 days

export interface SessionUser {
  id: string
  email: string
  isAdmin: boolean
}

function authSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET
  if (!secret || secret.length < 32) {
    throw new Error("AUTH_SECRET must be set and at least 32 characters long")
  }
  return new TextEncoder().encode(secret)
}

/**
 * Sign a session token for `user`. The `sessionVersion` is the user's current
 * counter from the database; it defaults to 0 for convenience in tests, where a
 * freshly created user always has version 0. It is embedded as a numeric claim so
 * a later password/role change invalidates the token.
 */
export async function createSessionToken(
  user: SessionUser,
  sessionVersion = 0
): Promise<string> {
  const secret = authSecret()
  return new SignJWT({
    email: user.email,
    isAdmin: user.isAdmin,
    sessionVersion,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(secret)
}

/**
 * Verify a session token against the database.
 *
 * Rejects the token (returns null) when any of the following hold:
 *   - the JWT is invalid/expired,
 *   - the token carries no `sessionVersion` (a legacy, pre-counter JWT),
 *   - the token's `sessionVersion` differs from the user's current counter (the
 *     session was revoked by a password/role/disable change),
 *   - the user no longer exists, or
 *   - the user is `disabled`.
 *
 * On success the returned email/isAdmin come from the current user row, never
 * from the JWT claims, so a role change takes effect immediately.
 */
export async function verifySessionToken(
  token: string
): Promise<SessionUser | null> {
  const secret = authSecret()
  let payload: { sub?: unknown; sessionVersion?: unknown }
  try {
    const result = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
    })
    payload = result.payload
  } catch {
    return null
  }
  const sub = payload.sub
  const version = payload.sessionVersion
  if (typeof sub !== "string") return null
  // Reject legacy tokens that predate the sessionVersion counter.
  if (typeof version !== "number" || !Number.isFinite(version)) return null
  const user = await prisma.user.findUnique({ where: { id: sub } })
  if (!user) return null
  if (user.disabled) return null
  if (user.sessionVersion !== version) return null
  return { id: user.id, email: user.email, isAdmin: user.isAdmin }
}

export function cookieOptions(extra?: { maxAge?: number }) {
  const secure = process.env.NODE_ENV === "production"
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge: extra?.maxAge ?? SESSION_MAX_AGE_SECONDS,
  }
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=")
    if (key === name) {
      return rest.join("=") || null
    }
  }
  return null
}

/**
 * Resolve the current session user from a request. Prefers the request's Cookie
 * header; when no request is supplied, falls back to the Next cookies() store,
 * which requires a request context.
 */
export async function getSessionUser(
  req?: Request
): Promise<SessionUser | null> {
  if (req) {
    const header = req.headers.get("cookie")
    const token = readCookie(header, SESSION_COOKIE)
    if (!token) return null
    return verifySessionToken(token)
  }
  const store = await cookies()
  const token = store.get(SESSION_COOKIE)?.value
  if (!token) return null
  return verifySessionToken(token)
}
