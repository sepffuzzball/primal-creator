/**
 * Authorization guards applied at the route boundary.
 *
 * These functions resolve the session and throw the appropriate ApiError when
 * the caller is not authenticated / not an admin / not the owner of a resource.
 * They never silently return a default - every protected route must opt in, so an
 * unauthenticated request can never read or mutate another user's data.
 */

import { getSessionUser, type SessionUser } from "@/lib/auth/session"
import { forbidden, unauthorized } from "@/lib/server/errors"

export async function requireUser(req: Request): Promise<SessionUser> {
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
