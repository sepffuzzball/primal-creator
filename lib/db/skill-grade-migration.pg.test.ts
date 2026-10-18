/**
 * Real-Postgres regression for the skill-grade-removal migration
 * (`prisma/migrations/20261017200000_skill_grade_removed`).
 *
 * The migration is additive on top of the 0.1.0 baseline
 * (`20261016000000_initial_0_1_0`) and the currencies migration
 * (`20261017000000_currencies`). Before it clears any pre-existing `grade` /
 * `gradeDescriptions` value on a `skills` catalog row, it must archive every row
 * that actually carries authored legacy grade data into `legacy_skill_grade_metadata`
 * - an immutable, migration-only audit table keyed by the original catalog
 * definition id (TEXT PRIMARY KEY, no FK, so the record survives a later deletion).
 * Only then does it clear the live row and add a CHECK constraint enforcing that a
 * `skills` row is always grade-free.
 *
 * This test proves the archive-before-destroy behaviour:
 *   1. It builds a DISPOSABLE database in the exact pre-migration state by applying
 *      ONLY the baseline and currencies migration `migration.sql` files DIRECTLY
 *      with psql (`-v ON_ERROR_STOP=1 -f <absolute path>`). It never runs Prisma
 *      `migrate deploy` and NEVER moves or renames any repository migration
 *      directory, so the run cannot modify the repo even temporarily. It never
 *      touches a pre-existing database.
 *   2. It seeds a `skills` row carrying a grade AND authored `gradeDescriptions`,
 *      a second grade-free `skills` row, and a third non-skill (`classes`) row
 *      carrying a grade and authored grade prose.
 *   3. It then applies the real skill-grade-removal `migration.sql` directly and
 *      asserts:
 *        - the archive table holds exactly the authored skill row, with its exact
 *          id / stableId / grade / gradeDescriptions text and a non-null archivedAt;
 *        - the grade-free skill and the non-skill row are NOT archived;
 *        - both live skill rows are cleared to grade NULL / gradeDescriptions '{}';
 *        - the non-skill (`classes`) grade and grade prose are left untouched;
 *        - the new CHECK constraint rejects re-inserting a graded skill, while a
 *          valid grade-free skill insert succeeds.
 *
 * No Prisma `migrate deploy` tracking is needed here: the under-test migration and
 * its two prerequisites are applied as raw SQL, so there is no `_prisma_migrations`
 * history to consult and nothing to relocate.
 *
 * Runs ONLY when explicitly opted in (see `resolveDbIntegration`), like every other
 * `.pg.test.ts`. Cleanup is fully scoped to the disposable database this test
 * creates; that database is dropped in the `finally`, and no repository file or
 * existing database is ever modified.
 */

import { spawn } from "node:child_process"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { resolveDbIntegration } from "@/lib/test/db-integration"

const gate = await resolveDbIntegration()

const MIGRATIONS_ROOT = new URL("../../prisma/migrations", import.meta.url)
  .pathname

/** The migration under test; applied directly with psql, never via Prisma migrate. */
const SKILL_MIGRATION_SQL = join(
  MIGRATIONS_ROOT,
  "20261017200000_skill_grade_removed",
  "migration.sql"
)

/** Pre-state migrations that build the exact pre-migration schema, in order. */
const BASELINE_MIGRATION_SQL = join(
  MIGRATIONS_ROOT,
  "20261016000000_initial_0_1_0",
  "migration.sql"
)
const CURRENCIES_MIGRATION_SQL = join(
  MIGRATIONS_ROOT,
  "20261017000000_currencies",
  "migration.sql"
)

/**
 * libpq URI query parameters that `psql` itself understands. Prisma-only
 * parameters (notably `schema`) must be stripped before the connection string is
 * handed to libpq, which refuses unknown parameters outright.
 */
const LIBPQ_URI_PARAMS = new Set([
  "host",
  "hostaddr",
  "port",
  "dbname",
  "user",
  "password",
  "passfile",
  "connect_timeout",
  "client_encoding",
  "options",
  "application_name",
  "fallback_application_name",
  "keepalives",
  "keepalives_idle",
  "keepalives_interval",
  "keepalives_count",
  "sslmode",
  "sslcompression",
  "sslcert",
  "sslkey",
  "sslrootcert",
  "sslcrl",
  "sslcrldir",
  "sslsni",
  "requirepeer",
  "ssl_min_protocol_version",
  "ssl_max_protocol_version",
  "gssencmode",
  "krbsrvname",
  "gsslib",
  "service",
  "target_session_attrs",
  "channel_binding",
  "load_balance_hosts",
])

/** A unique `_test`-named database that only this test run owns. */
function uniqueDbName(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_test_${Date.now()}_${rand}`
}

/** Connection string to the `postgres` maintenance database (same server/creds). */
function maintenanceUrl(base: URL): string {
  const u = new URL(base.toString())
  u.pathname = "/postgres"
  return u.toString()
}

/** Connection string to a freshly named disposable database on the same server. */
function scratchUrl(base: URL, dbName: string): string {
  const u = new URL(base.toString())
  u.pathname = `/${dbName}`
  return u.toString()
}

/**
 * Return a libpq-safe connection string: the same URL minus any query parameters
 * libpq does not recognize (Prisma adds `schema`, which libpq rejects).
 */
function psqlConnString(url: string): string {
  const u = new URL(url)
  if (u.searchParams.size === 0) return u.toString()
  const kept = new URLSearchParams()
  for (const [key, value] of u.searchParams) {
    if (LIBPQ_URI_PARAMS.has(key)) kept.set(key, value)
  }
  u.search = kept.toString()
  return u.toString()
}

/** Run the ACTUAL `psql` binary (not a mock) as a subprocess. */
function runPsql(
  url: string,
  sqlPath: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.PSQL_BIN ?? "psql",
      [psqlConnString(url), "-v", "ON_ERROR_STOP=1", "-f", sqlPath],
      {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      }
    )
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("error", reject)
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

/** Apply a repository migration `migration.sql` directly to the disposable DB. */
async function applyMigrationSql(url: string, sqlPath: string): Promise<void> {
  const res = await runPsql(url, sqlPath)
  expect(res.code, `psql applying ${sqlPath} failed:\n${res.stderr}`).toBe(0)
}

/**
 * Create a unique disposable database, run `fn` against it, and drop ONLY that
 * database afterwards. The `postgres` maintenance connection is used for
 * CREATE/DROP; `fn` receives the unique database name and its connection URL.
 */
async function withScratchDb<T>(
  prefix: string,
  fn: (dbName: string, url: string) => Promise<T>
): Promise<T> {
  const base = new URL(process.env.DATABASE_URL!)
  const dbName = uniqueDbName(prefix)

  const admin = new PrismaClient({
    datasources: { db: { url: maintenanceUrl(base) } },
  })
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`)
  } finally {
    await admin.$disconnect()
  }

  const url = scratchUrl(base, dbName)
  try {
    return await fn(dbName, url)
  } finally {
    const admin2 = new PrismaClient({
      datasources: { db: { url: maintenanceUrl(base) } },
    })
    try {
      await admin2.$executeRawUnsafe(
        `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`
      )
    } finally {
      await admin2.$disconnect()
    }
  }
}

describe.skipIf(!gate.run)(
  "skill-grade-removal migration archives authored legacy skill grade data",
  () => {
    it(
      "archives authored skill grade data before clearing and rejects re-insertion",
      { timeout: 120_000 },
      async () => {
        await withScratchDb("skill_grade_pg", async (_dbName, url) => {
          const skillAuthoredId = "mg-skill-authored"
          const skillFreeId = "mg-skill-free"
          const classId = "mg-class-kept"

          // ---- Build the exact PRE-migration state (baseline + currencies ONLY).
          //      Applied directly via psql, so no migration directory is moved and
          //      no Prisma migration history is consulted.
          await applyMigrationSql(url, BASELINE_MIGRATION_SQL)
          await applyMigrationSql(url, CURRENCIES_MIGRATION_SQL)

          const check = new PrismaClient({
            datasources: { db: { url } },
          })
          try {
            // Confirm the skill-grade migration was NOT applied yet: the archive
            // table it would create does not exist in the schema.
            const legacyTable = (await check.$queryRawUnsafe(
              `SELECT to_regclass('public.legacy_skill_grade_metadata')::text AS rel`
            )) as Array<{ rel: string | null }>
            expect(legacyTable[0].rel).toBeNull()

            // Seed an authored skill (grade + authored gradeDescriptions), a
            // grade-free skill, and a graded non-skill (`classes`) row.
            await check.$executeRaw`
              INSERT INTO "catalog_definitions"
                ("id", "kind", "stableId", "name", "grade", "gradeDescriptions", "config", "createdAt", "updatedAt")
              VALUES
                (${skillAuthoredId}, 'skills'::"CatalogKind", ${skillAuthoredId}, 'Authored Skill', 'A', ${JSON.stringify(
                  { A: "Authored A prose" }
                )}::jsonb, '{}'::jsonb, now(), now())
            `
            await check.$executeRaw`
              INSERT INTO "catalog_definitions"
                ("id", "kind", "stableId", "name", "grade", "gradeDescriptions", "config", "createdAt", "updatedAt")
              VALUES
                (${skillFreeId}, 'skills'::"CatalogKind", ${skillFreeId}, 'Grade Free Skill', NULL, '{}'::jsonb, '{}'::jsonb, now(), now())
            `
            await check.$executeRaw`
              INSERT INTO "catalog_definitions"
                ("id", "kind", "stableId", "name", "grade", "gradeDescriptions", "config", "createdAt", "updatedAt")
              VALUES
                (${classId}, 'classes'::"CatalogKind", ${classId}, 'Graded Class', 'A', ${JSON.stringify(
                  { A: "Class A prose" }
                )}::jsonb, '{}'::jsonb, now(), now())
            `
          } finally {
            await check.$disconnect()
          }

          // ---- Apply the REAL skill-grade-removal migration directly.
          await applyMigrationSql(url, SKILL_MIGRATION_SQL)

          const db = new PrismaClient({ datasources: { db: { url } } })
          try {
            // ---- Archive holds EXACTLY the authored skill row, with exact text.
            const archive = (await db.$queryRawUnsafe(
              `SELECT "id", "stableId", "grade", "gradeDescriptions", "archivedAt"
               FROM "legacy_skill_grade_metadata"
               ORDER BY "id"`
            )) as Array<{
              id: string
              stableId: string
              grade: string | null
              gradeDescriptions: Record<string, string>
              archivedAt: Date | null
            }>

            expect(archive).toHaveLength(1)
            expect(archive[0].id).toBe(skillAuthoredId)
            expect(archive[0].stableId).toBe(skillAuthoredId)
            expect(archive[0].grade).toBe("A")
            expect(archive[0].gradeDescriptions).toEqual({
              A: "Authored A prose",
            })
            expect(archive[0].archivedAt).not.toBeNull()

            // The grade-free skill and the non-skill row are NOT archived.
            const archivedIds = archive.map((r) => r.id)
            expect(archivedIds).not.toContain(skillFreeId)
            expect(archivedIds).not.toContain(classId)

            // ---- Live skill rows are cleared; non-skill row is untouched.
            const seededIds = [skillAuthoredId, skillFreeId, classId]
              .map((id) => `'${id}'`)
              .join(", ")
            const rows = (await db.$queryRawUnsafe(
              `SELECT "id", "kind", "grade", "gradeDescriptions"
               FROM "catalog_definitions"
               WHERE "id" IN (${seededIds})
               ORDER BY "id"`
            )) as Array<{
              id: string
              kind: string
              grade: string | null
              gradeDescriptions: Record<string, string>
            }>

            const authored = rows.find((r) => r.id === skillAuthoredId)
            expect(authored?.grade).toBeNull()
            expect(authored?.gradeDescriptions).toEqual({})

            const free = rows.find((r) => r.id === skillFreeId)
            expect(free?.grade).toBeNull()
            expect(free?.gradeDescriptions).toEqual({})

            const kept = rows.find((r) => r.id === classId)
            expect(kept?.kind).toBe("classes")
            expect(kept?.grade).toBe("A")
            expect(kept?.gradeDescriptions).toEqual({ A: "Class A prose" })

            // ---- The CHECK constraint rejects re-inserting a graded skill.
            await expect(
              db.$executeRaw`
                INSERT INTO "catalog_definitions"
                  ("id", "kind", "stableId", "name", "grade", "gradeDescriptions", "config", "createdAt", "updatedAt")
                VALUES ('mg-reinsert-grade', 'skills'::"CatalogKind", 'mg-reinsert-grade', 'Bad Grade', 'B', '{}'::jsonb, '{}'::jsonb, now(), now())
              `
            ).rejects.toThrow()

            await expect(
              db.$executeRaw`
                INSERT INTO "catalog_definitions"
                  ("id", "kind", "stableId", "name", "grade", "gradeDescriptions", "config", "createdAt", "updatedAt")
                VALUES ('mg-reinsert-desc', 'skills'::"CatalogKind", 'mg-reinsert-desc', 'Bad Descriptions', NULL, ${JSON.stringify(
                  { B: "x" }
                )}::jsonb, '{}'::jsonb, now(), now())
              `
            ).rejects.toThrow()

            // A valid grade-free skill insert succeeds.
            await db.$executeRaw`
              INSERT INTO "catalog_definitions"
                ("id", "kind", "stableId", "name", "grade", "gradeDescriptions", "config", "createdAt", "updatedAt")
              VALUES ('mg-reinsert-valid', 'skills'::"CatalogKind", 'mg-reinsert-valid', 'Valid Skill', NULL, '{}'::jsonb, '{}'::jsonb, now(), now())
            `
          } finally {
            await db.$disconnect()
          }
        })
      }
    )
  }
)
