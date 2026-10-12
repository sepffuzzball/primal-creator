/**
 * JWT session helpers (via `jose`) plus cookie read/write primitives.
 *
 * The session is a stateless HS256 JWT carrying the user's id, email and admin
 * flag. It is delivered as an HttpOnly, SameSite=Lax cookie that is marked
 * `Secure` in production. `AUTH_SECRET` must be at least 32 characters.
 */

import { SignJWT, jwtVerify } from "jose"
import { cookies } from "next/headers"

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

export async function createSessionToken(user: SessionUser): Promise<string> {
  const secret = authSecret()
  return new SignJWT({ email: user.email, isAdmin: user.isAdmin })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(secret)
}

export async function verifySessionToken(
  token: string
): Promise<SessionUser | null> {
  const secret = authSecret()
  try {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
    })
    const sub = payload.sub
    const email = payload.email
    const isAdmin = payload.isAdmin
    if (typeof sub !== "string" || typeof email !== "string") return null
    return { id: sub, email, isAdmin: isAdmin === true }
  } catch {
    return null
  }
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
