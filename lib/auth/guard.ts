/**
 * Authorization guards applied at the route boundary.
 *
 * These functions resolve the session and throw the appropriate ApiError when
 * the caller is not authenticated / not an admin / not the owner of a resource.
 * They never silently return a default - every protected route must opt in, so an
 * unauthenticated request can never read or mutate another user's data.
 *
 * CSRF origin defence: every cookie-authenticated *unsafe* (state-changing)
 * method must carry an `Origin` header that exactly matches the configured
 * `APP_ORIGIN`, or, when `APP_ORIGIN` is unset, the request's own origin
 * (`new URL(req.url).origin`). There is no suffix/subdomain wildcard - the match
 * is exact, so a sibling subdomain is correctly rejected. The check runs BEFORE
 * the session lookup, so a cross-origin request is rejected without touching the
 * database. Safe methods (GET/HEAD/OPTIONS) are exempt.
 */

import { getSessionUser, type SessionUser } from "@/lib/auth/session"
import { forbidden, unauthorized } from "@/lib/server/errors"

/** Method names that never change state and therefore need no CSRF check. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

/**
 * The origin a state-changing request must come from. Prefers the configured
 * `APP_ORIGIN` (the real browser origin, required when the app is behind a
 * reverse proxy) and otherwise falls back to the request's own origin.
 */
function expectedOrigin(req: Request): string {
  const configured = process.env.APP_ORIGIN
  if (configured) return configured.replace(/\/+$/, "")
  return new URL(req.url).origin
}

/**
 * Assert that an unsafe request originates from the same origin. Throws a 403
 * `bad_origin` when the `Origin` header is missing, null or mismatched. Safe
 * methods pass through without any header requirement.
 */
export function assertOrigin(req: Request): void {
  const method = req.method.toUpperCase()
  if (SAFE_METHODS.has(method)) return
  const origin = req.headers.get("origin")
  const expected = expectedOrigin(req)
  if (!origin || origin !== expected) {
    throw forbidden("bad_origin", "Cross-origin request rejected")
  }
}

export async function requireUser(req: Request): Promise<SessionUser> {
  assertOrigin(req)
  const user = await getSessionUser(req)
  if (!user) throw unauthorized("unauthorized", "Not authenticated")
  return user
}

export async function requireAdmin(req: Request): Promise<SessionUser> {
  const user = await requireUser(req)
  if (!user.isAdmin) throw forbidden("forbidden", "Admin role required")
  return user
}

/**
 * Assert that a character belongs to the requesting user, or that the requestor
 * is an admin. Throws a 403/404 when access is denied. Only the owner or an
 * admin may read/mutate a character.
 */
export function assertCharacterAccess(
  character: { ownerId: string },
  user: SessionUser
): void {
  if (user.isAdmin) return
  if (character.ownerId === user.id) return
  throw forbidden("forbidden", "You do not own this character")
}
