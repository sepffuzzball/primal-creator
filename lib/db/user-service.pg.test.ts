/**
 * Real-Postgres integration tests for user access controls.
 *
 * Exercises:
 *   - Session revocation on disable and on role change (verifySessionToken reads
 *     the DB on every request and rejects disabled users / stale sessionVersion).
 *   - Concurrent demotion of the only two enabled admins, which must not leave zero
 *     enabled admins (SERIALIZABLE isolation + P2034 -> 409 mapping).
 *   - Self-service password change invalidating previously issued tokens.
 *
 * Runs ONLY when explicitly opted in: `RUN_DB_INTEGRATION_TESTS=1` AND the
 * effective `DATABASE_URL` points at a test-named database (name contains `_test`
 * or `test_`). An ordinary `pnpm test` against a dev/prod DB therefore never
 * demotes a pre-existing admin or broadly deletes users. See
 * `lib/test/db-integration.ts`. When the caller HAS opted in but the target
 * database is missing, not test-named, or unreachable, the gate throws so the run
 * fails loudly instead of silently skipping (the unit suite still runs without
 * Postgres during an ordinary, non-opted-in `pnpm test`).
 *
 * Cleanup is strictly scoped: `afterAll` deletes ONLY the users this run created
 * (captured IDs), never an email/pattern match.
 */

import { randomUUID } from "node:crypto"
import bcrypt from "bcryptjs"
import { afterAll, describe, expect, it } from "vitest"
import { prisma } from "@/lib/db/client"
import { changeOwnPassword, updateUser } from "@/lib/db/user-service"
import { createSessionToken, verifySessionToken } from "@/lib/auth/session"
import { resolveDbIntegration } from "@/lib/test/db-integration"

process.env.AUTH_SECRET = "x".repeat(40)

const gate = await resolveDbIntegration()

// Every user id this suite creates; afterAll deletes exactly these rows.
const createdUserIds: string[] = []

async function makeUser(opts: {
  isAdmin?: boolean
  disabled?: boolean
  sessionVersion?: number
  password?: string
}) {
  const id = randomUUID()
  const email = `user-${id}@test.local`
  const password = opts.password ?? "a-strong-password"
  const created = await prisma.user.create({
    data: {
      id,
      email,
      password: await bcrypt.hash(password, 12),
      isAdmin: opts.isAdmin ?? false,
      disabled: opts.disabled ?? false,
      sessionVersion: opts.sessionVersion ?? 0,
    },
  })
  createdUserIds.push(id)
  return { id, email, password, row: created }
}

describe.skipIf(!gate.run)("user access (real PG)", () => {
  afterAll(async () => {
    // Never broadly delete users; remove only the rows this run created.
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    }
  })

  it("revokes a session when a user is disabled, and re-admits after re-enable", async () => {
    const { id, email } = await makeUser({})
    const token = await createSessionToken({ id, email, isAdmin: false }, 0)
    expect(await verifySessionToken(token)).toMatchObject({
      id,
      email,
      isAdmin: false,
    })

    await prisma.user.update({ where: { id }, data: { disabled: true } })
    expect(await verifySessionToken(token)).toBeNull()

    await prisma.user.update({ where: { id }, data: { disabled: false } })
    expect(await verifySessionToken(token)).toMatchObject({ id })
  })

  it("rejects a stale token after sessionVersion bump and reflects the DB role", async () => {
    const { id, email } = await makeUser({ isAdmin: true })
    const oldToken = await createSessionToken({ id, email, isAdmin: true }, 0)
    expect(await verifySessionToken(oldToken)).toMatchObject({ isAdmin: true })

    // Demote the admin: this bumps sessionVersion, so the old token is revoked.
    await prisma.user.update({
      where: { id },
      data: { isAdmin: false, sessionVersion: { increment: 1 } },
    })
    expect(await verifySessionToken(oldToken)).toBeNull()

    // A fresh token at the new version reflects the demoted role from the DB.
    const freshToken = await createSessionToken({ id, email, isAdmin: true }, 1)
    const session = await verifySessionToken(freshToken)
    expect(session).toMatchObject({ id, email, isAdmin: false })
  })

  it("two concurrent demotions of the only two enabled admins cannot both succeed", async () => {
    // The serialization guard only triggers when A and B are the ONLY enabled
    // admins, so the suite must run against an empty, isolated test database. If
    // any OTHER enabled admin exists (e.g. a seeded admin, or a leftover from a
    // parallel file), FAIL - don't silently skip and let the concurrency fixture
    // go unexercised.
    const a = await makeUser({ isAdmin: true })
    const b = await makeUser({ isAdmin: true })

    const otherEnabledAdmins = await prisma.user.count({
      where: { isAdmin: true, disabled: false, id: { notIn: [a.id, b.id] } },
    })
    expect(otherEnabledAdmins).toBe(0)

    const actorA = { id: a.id, email: a.email, isAdmin: true }
    const actorB = { id: b.id, email: b.email, isAdmin: true }

    const results = await Promise.allSettled([
      updateUser(b.id, { isAdmin: false, disabled: false }, actorA),
      updateUser(a.id, { isAdmin: false, disabled: false }, actorB),
    ])

    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")

    // Exactly one of the demotions may commit; the other must 409.
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
    const rejection = rejected[0] as PromiseRejectedResult
    const err = rejection.reason as { status?: number; code?: string }
    expect(err.status).toBe(409)

    // At least one enabled admin must remain (A or B kept their admin role).
    const remaining = await prisma.user.count({
      where: { id: { in: [a.id, b.id] }, isAdmin: true, disabled: false },
    })
    expect(remaining).toBe(1)
  })

  it("a password change invalidates previously issued tokens but keeps the current session", async () => {
    const { id, email, password } = await makeUser({
      password: "old-password-123",
    })
    const oldToken = await createSessionToken({ id, email, isAdmin: false }, 0)
    expect(await verifySessionToken(oldToken)).toMatchObject({ id })

    const result = await changeOwnPassword(
      { id, email, isAdmin: false },
      { currentPassword: password, newPassword: "new-password-456" }
    )
    expect(result.sessionVersion).toBe(1)

    // The old token is now stale (version mismatch).
    expect(await verifySessionToken(oldToken)).toBeNull()

    // A fresh token at the new version is valid.
    const freshToken = await createSessionToken(
      { id, email, isAdmin: false },
      result.sessionVersion
    )
    expect(await verifySessionToken(freshToken)).toMatchObject({ id })
  })
})
