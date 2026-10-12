import { beforeEach, describe, expect, it, vi } from "vitest"
import bcrypt from "bcryptjs"
import { changeOwnPassword, createUser, listUsers, updateUser } from "@/lib/db/user-service"

type TestStore = import("./testPrisma").TestPrismaInstance["store"]
type TestPrisma = import("./testPrisma").TestPrismaInstance["prisma"]

const dbMock = vi.hoisted(() => ({
  store: undefined as unknown as TestStore,
  prisma: undefined as unknown as TestPrisma,
}))

vi.mock("@/lib/db/client", async () => {
  const { createTestPrisma } = await import("./testPrisma")
  const instance = createTestPrisma()
  dbMock.store = instance.store
  dbMock.prisma = instance.prisma
  return { prisma: instance.prisma, default: instance.prisma }
})

const actorRegular = { id: "actor-1", email: "actor@example.com", isAdmin: false }
const actorAdmin = { id: "admin-1", email: "admin@example.com", isAdmin: true }

function seedUser(row: {
  id: string
  email: string
  isAdmin?: boolean
  disabled?: boolean
  sessionVersion?: number
  password?: string
}) {
  dbMock.store.addUser({
    id: row.id,
    email: row.email,
    isAdmin: row.isAdmin ?? false,
    disabled: row.disabled ?? false,
    sessionVersion: row.sessionVersion ?? 0,
    password: row.password ?? "hashed-password",
  })
}

beforeEach(() => {
  dbMock.store.reset()
})

describe("listUsers", () => {
  it("returns every user as a view without the password hash", async () => {
    seedUser({ id: "u1", email: "a@example.com", isAdmin: true })
    seedUser({ id: "u2", email: "b@example.com", disabled: true })
    const users = await listUsers()
    expect(users).toHaveLength(2)
    const a = users.find((u) => u.id === "u1")!
    expect(a).toMatchObject({
      id: "u1",
      email: "a@example.com",
      isAdmin: true,
      disabled: false,
    })
    expect(a).not.toHaveProperty("password")
    expect(typeof a.createdAt).toBe("string")
    expect(typeof a.updatedAt).toBe("string")
  })
})

describe("createUser", () => {
  it("normalizes email to lowercase trim, hashes with bcrypt, isAdmin defaults false", async () => {
    const created = await createUser({
      email: "  New.User@Example.COM ",
      password: "a-strong-password",
    })
    expect(created.email).toBe("new.user@example.com")
    expect(created.isAdmin).toBe(false)
    expect(created.disabled).toBe(false)
    const stored = [...dbMock.store.users.values()][0]
    expect(stored.email).toBe("new.user@example.com")
    expect(stored.password).not.toBe("a-strong-password")
    expect(await bcrypt.compare("a-strong-password", stored.password)).toBe(true)
  })

  it("honors isAdmin and rejects a duplicate email with 409", async () => {
    seedUser({ id: "u1", email: "dup@example.com" })
    await expect(
      createUser({ email: "DUP@example.com", password: "another-strong" })
    ).rejects.toMatchObject({ status: 409, code: "email_taken" })
    const created = await createUser({
      email: "admin@example.com",
      password: "another-strong",
      isAdmin: true,
    })
    expect(created.isAdmin).toBe(true)
  })
})

describe("updateUser", () => {
  it("password-only change bumps sessionVersion and never returns a hash", async () => {
    seedUser({ id: "u1", email: "u@example.com", sessionVersion: 4 })
    const updated = await updateUser(
      "u1",
      { password: "a-new-strong-password" },
      actorRegular
    )
    expect(updated).not.toHaveProperty("password")
    const stored = [...dbMock.store.users.values()][0]
    expect(stored.sessionVersion).toBe(5)
    expect(stored.password).not.toBe("a-new-strong-password")
  })

  it("role and disable changes bump sessionVersion", async () => {
    // A second enabled admin exists so disabling the target never trips the
    // last-admin guard.
    seedUser({ id: "admin-2", email: "z@example.com", isAdmin: true })
    seedUser({ id: "u1", email: "u@example.com", sessionVersion: 2 })
    await updateUser("u1", { isAdmin: true }, actorAdmin)
    let stored = [...dbMock.store.users.values()].find((u) => u.id === "u1")!
    expect(stored.sessionVersion).toBe(3)
    expect(stored.isAdmin).toBe(true)

    await updateUser("u1", { disabled: true }, actorAdmin)
    stored = [...dbMock.store.users.values()].find((u) => u.id === "u1")!
    expect(stored.sessionVersion).toBe(4)
    expect(stored.disabled).toBe(true)
  })

  it("rejects a patch with no properties with 409", async () => {
    seedUser({ id: "u1", email: "u@example.com" })
    await expect(updateUser("u1", {}, actorRegular)).rejects.toMatchObject({
      status: 409,
      code: "no_change",
    })
  })

  it("cannot demote the last enabled admin (last_admin)", async () => {
    seedUser({ id: "admin-1", email: "admin@example.com", isAdmin: true })
    seedUser({ id: "reg-1", email: "reg@example.com" })
    await expect(
      updateUser("admin-1", { isAdmin: false }, actorRegular)
    ).rejects.toMatchObject({ status: 409, code: "last_admin" })
    // The admin row is untouched.
    const stored = [...dbMock.store.users.values()].find(
      (u) => u.id === "admin-1"
    )!
    expect(stored.isAdmin).toBe(true)
  })

  it("cannot disable the last enabled admin (last_admin)", async () => {
    seedUser({ id: "admin-1", email: "admin@example.com", isAdmin: true })
    await expect(
      updateUser("admin-1", { disabled: true }, actorRegular)
    ).rejects.toMatchObject({ status: 409, code: "last_admin" })
  })

  it("allows demoting an admin when another enabled admin exists", async () => {
    seedUser({ id: "admin-1", email: "a@example.com", isAdmin: true })
    seedUser({ id: "admin-2", email: "b@example.com", isAdmin: true })
    const updated = await updateUser("admin-1", { isAdmin: false }, actorRegular)
    expect(updated.isAdmin).toBe(false)
  })

  it("rejects demoting yourself even when another admin exists (self_demotion)", async () => {
    seedUser({ id: "admin-1", email: "a@example.com", isAdmin: true })
    seedUser({ id: "admin-2", email: "b@example.com", isAdmin: true })
    const actor = {
      id: "admin-1",
      email: "a@example.com",
      isAdmin: true,
    }
    await expect(
      updateUser("admin-1", { isAdmin: false }, actor)
    ).rejects.toMatchObject({ status: 409, code: "self_demotion" })
  })

  it("not found returns 404", async () => {
    await expect(
      updateUser("missing", { isAdmin: true }, actorAdmin)
    ).rejects.toMatchObject({ status: 404, code: "user_not_found" })
  })
})

describe("changeOwnPassword", () => {
  it("rejects an incorrect current password", async () => {
    seedUser({ id: "u1", email: "u@example.com", password: "hashed-password" })
    await expect(
      changeOwnPassword(
        { id: "u1", email: "u@example.com", isAdmin: false },
        { currentPassword: "wrong", newPassword: "brand-new-secret" }
      )
    ).rejects.toMatchObject({ status: 400, code: "invalid_current_password" })
  })

  it("rejects a new password identical to the current one", async () => {
    const password = "existing-password"
    const hash = await bcrypt.hash(password, 12)
    seedUser({ id: "u1", email: "u@example.com", password: hash })
    await expect(
      changeOwnPassword(
        { id: "u1", email: "u@example.com", isAdmin: false },
        { currentPassword: password, newPassword: password }
      )
    ).rejects.toMatchObject({ status: 400, code: "same_password" })
  })

  it("bumps sessionVersion and returns the new version for a cookie", async () => {
    seedUser({
      id: "u1",
      email: "u@example.com",
      password: await bcrypt.hash("old-password", 12),
      sessionVersion: 0,
    })
    const result = await changeOwnPassword(
      { id: "u1", email: "u@example.com", isAdmin: false },
      { currentPassword: "old-password", newPassword: "brand-new-secret" }
    )
    expect(result.sessionVersion).toBe(1)
    expect(result.user).not.toHaveProperty("password")
    const stored = [...dbMock.store.users.values()][0]
    expect(stored.sessionVersion).toBe(1)
    expect(await bcrypt.compare("brand-new-secret", stored.password)).toBe(true)
  })
})
