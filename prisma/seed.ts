/**
 * Database seed.
 *
 * Run explicitly with `pnpm db:seed` (never automatically on install). It:
 *   1. Bootstraps the admin user from ADMIN_EMAIL / ADMIN_PASSWORD, hashing the
 *      password with bcryptjs. No secrets are committed - the defaults here are
 *      dev placeholders, override via a local env file or the deployment secret
 *      store.
 *   2. Seeds the catalog: the verified Human race (per-grade definitions) and an
 *      F-grade Archer class as a clearly-labeled house placeholder (the wiki does
 *      not document Archer's exact per-level gains).
 *
 * It deliberately creates NO sample characters - characters are user-created.
 */

import { PrismaClient, type CatalogKind, type Provenance } from "@prisma/client"
import bcrypt from "bcryptjs"

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
      `ADMIN_PASSWORD "${password}" is a weak/placeholder value. Set a strong password (>= 12 chars) in production.`
    )
  }
  if (trimmed.length < 12) {
    throw new Error(
      `ADMIN_PASSWORD must be at least 12 characters in production (got ${trimmed.length}).`
    )
  }
}

const ATTRIBUTES = [
  "strength",
  "agility",
  "endurance",
  "vitality",
  "toughness",
  "wisdom",
  "intelligence",
  "perception",
  "willpower",
] as const

function allEqual(value: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const attr of ATTRIBUTES) out[attr] = value
  return out
}

async function upsertCatalog(
  kind: CatalogKind,
  stableId: string,
  data: {
    name: string
    description?: string | null
    grade?: string | null
    provenance: Provenance
    sourceUrl?: string | null
    archived?: boolean
    config: Record<string, unknown>
  }
): Promise<void> {
  const base = {
    name: data.name,
    description: data.description ?? null,
    grade: data.grade ?? null,
    provenance: data.provenance,
    sourceUrl: data.sourceUrl ?? null,
    archived: data.archived ?? false,
    config: data.config as object,
  }
  await prisma.catalogDefinition.upsert({
    where: { kind_stableId: { kind, stableId } },
    update: base,
    create: { kind, stableId, ...base },
  })
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
  // Race: Human (verified per-grade definitions)
  // ------------------------------------------------------------------ //
  await upsertCatalog("races", "human", {
    name: "Human",
    description:
      "Balanced/most numerous race. Humans possess both a class and a profession. Per-grade race gains are verified for F/E/D/C/B; G is an explicit house zero (unknown), see config.houseGrades.",
    grade: "F",
    provenance: "verified",
    sourceUrl: "https://the-primal-hunter.fandom.com/wiki/Human",
    config: {
      naturalGrade: "F",
      verifiedGrades: ["F", "E", "D", "C", "B"],
      // G is not source-confirmed; configured explicitly at zero and labeled house.
      houseGrades: ["G"],
      raceDefinitions: {
        G: { id: "human:G", perLevel: allEqual(0), freePerLevel: 0 },
        F: { id: "human:F", perLevel: allEqual(1), freePerLevel: 5 },
        E: { id: "human:E", perLevel: allEqual(2), freePerLevel: 5 },
        D: { id: "human:D", perLevel: allEqual(6), freePerLevel: 15 },
        C: { id: "human:C", perLevel: allEqual(18), freePerLevel: 45 },
        B: { id: "human:B", perLevel: allEqual(54), freePerLevel: 135 },
      },
    },
  })

  // ------------------------------------------------------------------ //
  // Class: Archer (F-grade starter; house placeholder)
  // ------------------------------------------------------------------ //
  await upsertCatalog("classes", "archer", {
    name: "Archer",
    description:
      "F-grade primary class. HOUSE PLACEHOLDER - the wiki does not document Archer's exact per-level stat gains, so config.grades.F is editable. Replace with a sourced value when available.",
    grade: "F",
    provenance: "house",
    sourceUrl: "https://the-primal-hunter.fandom.com/wiki/Classes",
    config: {
      grades: {
        F: {
          fixed: { agility: 2, perception: 1 },
          free: 1,
        },
      },
    },
  })
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
