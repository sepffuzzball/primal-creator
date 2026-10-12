/**
 * Admin-managed user persistence.
 *
 * This module is the only place that touches Prisma's `user` model for admin
 * operations. Regular users are created ONLY by an admin (no public registration);
 * an admin can list users, promote/demote the admin role, disable access, and reset
 * a password. It is also used by the self-service password change flow, which is the
 * only place a user changes their own password.
 *
 * Session revocation is handled by the `sessionVersion` counter. Every patch that
 * touches role, disable state or password increments the counter, so any JWT issued
 * before the change is rejected by `verifySessionToken` immediately.
 *
 * Last-admin protection: a patch can never leave zero ENABLED admins. The guard runs
 * inside a SERIALIZABLE transaction so two concurrent demotions of the only two
 * admins cannot both commit; the loser gets a serialization failure (Prisma P2034)
 * which is mapped to a 409 conflict for the client to retry. A patch cannot demote or
 * disable the admin who is making the request either (self-demotion is rejected as a
 * simpler additional safety).
 *
 * Password hashing always uses bcrypt cost 12 and a password hash is never returned.
 */

import { Prisma } from "@prisma/client"
import bcrypt from "bcryptjs"
import { prisma } from "@/lib/db/client"
import { badRequest, conflict, notFound } from "@/lib/server/errors"
import type { SessionUser } from "@/lib/auth/session"

export interface UserView {
  id: string
  email: string
  isAdmin: boolean
  disabled: boolean
  createdAt: string
  updatedAt: string
}

type UserRow = {
  id: string
  email: string
  isAdmin: boolean
  disabled: boolean
  sessionVersion: number
  createdAt: Date
  updatedAt: Date
}

function toView(row: UserRow): UserView {
  return {
    id: row.id,
    email: row.email,
    isAdmin: row.isAdmin,
    disabled: row.disabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** Detect a Prisma unique-constraint violation (P2002), e.g. an email race. */
function isUniqueViolation(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { code?: string }).code === "P2002"
  )
}

/**
 * Detect a Prisma serialization/deadlock failure (P2034). Under SERIALIZABLE
 * isolation, a concurrent last-admin demotion cannot both commit and the loser
 * surfaces as P2034; we surface it to the client as a 409.
 */
function isSerializationFailure(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { code?: string }).code === "P2034"
  )
}

// ------------------------------------------------------------------ //
// Reads
// ------------------------------------------------------------------ //

/** List every user (admin only - enforced at the route boundary). */
export async function listUsers(): Promise<UserView[]> {
  const rows = await prisma.user.findMany({ orderBy: { createdAt: "asc" } })
  return rows.map(toView)
}

// ------------------------------------------------------------------ //
// Writes
// ------------------------------------------------------------------ //

/**
 * Change the authenticated user's own password.
 *
 * Verifies the current password with bcrypt, rejects a new password that is too
 * weak (fewer than 12 characters - guaranteed by the route schema) or identical to
 * the current one, then atomically bumps `sessionVersion`. This revokes every
 * previously issued token (including other devices) immediately. Callers must
 * issue a fresh cookie carrying the returned `sessionVersion` so the current
 * browser keeps its session; all other sessions are invalidated.
 *
 * Returns the updated user view and the new sessionVersion for token issuance.
 */
export async function changeOwnPassword(
  user: SessionUser,
  input: { currentPassword: string; newPassword: string }
): Promise<{ user: UserView; sessionVersion: number }> {
  const row = await prisma.user.findUnique({ where: { id: user.id } })
  if (!row) throw notFound("user_not_found", "User not found")

  const currentOk = await bcrypt.compare(input.currentPassword, row.password)
  if (!currentOk) {
    throw badRequest(
      "invalid_current_password",
      "Current password is incorrect"
    )
  }

  const same = await bcrypt.compare(input.newPassword, row.password)
  if (same) {
    throw badRequest(
      "same_password",
      "New password must be different from the current password"
    )
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      password: await bcrypt.hash(input.newPassword, 12),
      sessionVersion: { increment: 1 },
    },
  })
  return { user: toView(updated), sessionVersion: updated.sessionVersion }
}

/**
 * Create a regular user (or an admin when `isAdmin` is true). No public
 * registration: only an admin routes here. The email is normalized to lowercase and
 * trimmed; a duplicate email is a 409 conflict. The password is hashed with bcrypt
 * cost 12 and never returned.
 */
export async function createUser(input: {
  email: string
  password: string
  isAdmin?: boolean
}): Promise<UserView> {
  const email = normalizeEmail(input.email)
  try {
    const created = await prisma.user.create({
      data: {
        email,
        password: await bcrypt.hash(input.password, 12),
        isAdmin: input.isAdmin ?? false,
        disabled: false,
        sessionVersion: 0,
      },
    })
    return toView(created)
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict("email_taken", `A user with email "${email}" already exists`)
    }
    throw err
  }
}

/**
 * Patch a user's role, disabled state and/or password.
 *
 * Guards:
 *   - The patch must contain at least one property (the route validates this too).
 *   - A new password must be hashed with bcrypt cost 12; a password reset invalidates
 *     every token the user currently holds by bumping `sessionVersion`.
 *   - Role, disable and password changes all bump `sessionVersion`.
 *   - Self-demotion: the acting admin (the caller) cannot demote/disable themselves.
 *   - Last-admin: a patch that would turn the target from an ENABLED admin into a
 *     non-admin (demote or disable) must leave at least one OTHER enabled admin. The
 *     whole check + update runs under SERIALIZABLE isolation so two concurrent
 *     demotions cannot both succeed; a resulting P2034 is mapped to a 409.
 *
 * Returns the updated view (never the password hash).
 */
export async function updateUser(
  id: string,
  patch: { isAdmin?: boolean; disabled?: boolean; password?: string },
  actor: SessionUser
): Promise<UserView> {
  const hasRoleChange = patch.isAdmin !== undefined
  const hasDisabledChange = patch.disabled !== undefined
  const hasPassword = patch.password !== undefined
  if (!hasRoleChange && !hasDisabledChange && !hasPassword) {
    throw conflict("no_change", "Nothing to update")
  }

  const isIdentityChange = hasRoleChange || hasDisabledChange || hasPassword

  const data: Prisma.UserUpdateInput = {}
  if (hasRoleChange) data.isAdmin = patch.isAdmin
  if (hasDisabledChange) data.disabled = patch.disabled
  if (hasPassword) data.password = await bcrypt.hash(patch.password!, 12)
  if (isIdentityChange) data.sessionVersion = { increment: 1 }

  try {
    const updated = await prisma.$transaction(
      async (tx) => {
        const existing = await tx.user.findUnique({ where: { id } })
        if (!existing) {
          throw notFound("user_not_found", "User not found")
        }

        if (hasRoleChange || hasDisabledChange) {
          const newIsAdmin = patch.isAdmin ?? existing.isAdmin
          const newDisabled = patch.disabled ?? existing.disabled
          const wasEnabledAdmin = existing.isAdmin && !existing.disabled
          const willBeEnabledAdmin = newIsAdmin && !newDisabled

          // Self-demotion: the acting admin cannot remove their own admin role (or
          // disable themselves), even if another admin exists.
          if (
            actor.id === id &&
            wasEnabledAdmin &&
            !willBeEnabledAdmin
          ) {
            throw conflict(
              "self_demotion",
              "You cannot demote or disable your own admin account"
            )
          }

          // Last-admin guard: never let a patch remove the final enabled admin.
          // Only checked when the target actually stops being an enabled admin.
          if (wasEnabledAdmin && !willBeEnabledAdmin) {
            const otherAdmins = await tx.user.count({
              where: { id: { not: id }, isAdmin: true, disabled: false },
            })
            if (otherAdmins === 0) {
              throw conflict(
                "last_admin",
                "Cannot demote or disable the last enabled admin"
              )
            }
          }
        }

        const row = await tx.user.update({ where: { id }, data })
        return toView(row)
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )
    return updated
  } catch (err) {
    if (isSerializationFailure(err)) {
      // A concurrent last-admin demotion lost the race: surface as a 409.
      throw conflict(
        "conflict",
        "Concurrent user update; retry the change"
      )
    }
    throw err
  }
}
