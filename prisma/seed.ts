/**
 * Database seed.
 *
 * Run explicitly with `pnpm db:seed` (never automatically on install). It:
 *   1. Bootstraps the admin user from ADMIN_EMAIL / ADMIN_PASSWORD, hashing the
 *      password with bcryptjs. No secrets are committed - the defaults here are
 *      dev placeholders, override via a local env file or the deployment secret
 *      store.
 *   2. Seeds the curated Jake Thayne catalog via `seedJakeCatalog`
 *      (`prisma/catalog/jake-seed.ts`): the Human race table, Jake's five class
 *      progression definitions, his five alchemist profession progression
 *      definitions, and the fifteen god names. The two legacy rows seeded by the
 *      0.0.2 seed (`races/human`, `classes/archer`) are updated only when they
 *      still match that baseline; the rest are create-only, so an admin-customized
 *      row is never overwritten and a repeated seed is idempotent.
 *
 * The reviewed wiki-derived manifest (`prisma/catalog/wiki-reviewed.ts`) is NOT
 * imported here - it is an explicit, admin-opt-in operation via
 * `POST /api/admin/catalog-import` (see `lib/db/catalog-import.ts`).
 *
 * It deliberately creates NO sample characters - characters are user-created.
 */

import { PrismaClient } from "@prisma/client"
import bcrypt from "bcryptjs"
import { seedJakeCatalog } from "./catalog/jake-seed.ts"

const prisma = new PrismaClient()

/**
 * Placeholder/example admin passwords that must never be used to bootstrap a
 * production admin account. Values are compared case-insensitively.
 */
const WEAK_ADMIN_PASSWORDS = new Set([
  "admin",
  "password",
  "changeme",
  "example",
  "placeholder",
  "letmein",
])

/**
 * In production a weak or too-short admin password means the deployer forgot to
 * override the dev placeholder. Refuse to seed rather than silently creating an
 * admin with a guessable password. In development the dev placeholder ("admin")
 * is intentional and accepted.
 */
function validateAdminPassword(password: string): void {
  if (process.env.NODE_ENV !== "production") return
  const trimmed = password.trim()
  if (WEAK_ADMIN_PASSWORDS.has(trimmed.toLowerCase())) {
    throw new Error(
      `ADMIN_PASSWORD is a weak/placeholder value. Set a strong password (>= 12 chars) in production.`
    )
  }
  if (trimmed.length < 12) {
    throw new Error(
      `ADMIN_PASSWORD must be at least 12 characters in production (got ${trimmed.length}).`
    )
  }
}

async function main(): Promise<void> {
  // ------------------------------------------------------------------ //
  // Admin bootstrap
  // ------------------------------------------------------------------ //
  const email = (process.env.ADMIN_EMAIL || "admin@primal.local").toLowerCase()
  const password = process.env.ADMIN_PASSWORD || "admin"
  // Fail fast in production on a weak/too-short admin password (dev placeholder
  // only). This runs whether or not the admin already exists so a misconfigured
  // deployment never silently seeds a guessable admin.
  validateAdminPassword(password)
  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) {
    console.log(`Admin user "${email}" already exists.`)
  } else {
    const hash = await bcrypt.hash(password, 12)
    await prisma.user.create({
      data: { email, password: hash, isAdmin: true },
    })
    console.log(`Created admin user "${email}" (password hashed with bcrypt).`)
  }

  // ------------------------------------------------------------------ //
  // Jake Thayne catalog
  // ------------------------------------------------------------------ //
  await seedJakeCatalog(prisma)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
