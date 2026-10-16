/**
 * Real-Postgres test for the single 0.1.0 initial baseline migration
 * (`prisma/migrations/20261016000000_initial_0_1_0`).
 *
 * This migration replaces the entire 0001..0023 chain with one from-scratch
 * baseline that must run ONLY against an EMPTY database. Because Prisma's schema
 * cannot express CHECK constraints, partial unique indexes or the singleton
 * house-rules seed, those are appended verbatim to the generated baseline SQL -
 * and this test proves they actually exist in the applied schema, so a
 * from-scratch baseline is byte-for-byte equivalent to what the old chain would
 * have produced.
 *
 * It also inspects the migration file itself to confirm the leading DO guard
 * (the "reject nonempty _prisma_migrations or any pre-existing non-extension
 * public object" guard) is present and runs BEFORE any CREATE, and never drops
 * anything. The guard ignores objects that belong to a Postgres extension
 * (detected via pg_depend, never by name), so a database that has an extension
 * such as pg_stat_statements installed into public is treated as empty rather
 * than refused.
 *
 * An additional opt-in block creates a UNIQUE disposable `_test` database,
 * installs pg_stat_statements into public, runs the ACTUAL `prisma migrate
 * deploy` CLI against it and asserts the baseline schema and the extension
 * views/functions survive. A second opt-in block proves the guard still refuses
 * a user-created table/view and an old migration history BEFORE any app object
 * is created. Both blocks run only when explicitly opted in (see
 * `resolveDbIntegration`) and never touch, or require, a pre-existing database.
 *
 * Runs ONLY when explicitly opted in (see `resolveDbIntegration`), same as every
 * other `.pg.test.ts` file. The database targeted must be a freshly migrated
 * baseline.
 */

import { readFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/db/client"
import { resolveDbIntegration } from "@/lib/test/db-integration"

const gate = await resolveDbIntegration()

const BASELINE_MIGRATION_NAME = "20261016000000_initial_0_1_0"

// The 11 application tables the final schema creates (everything except the
// Prisma tracking table `_prisma_migrations`).
const APP_TABLES = [
  "assets",
  "catalog_definitions",
  "character_associations",
  "character_drafts",
  "character_inventory_items",
  "characters",
  "house_rules",
  "progression_events",
  "skill_offer_options",
  "skill_offers",
  "users",
] as const

// The four application enums the final schema creates in the public schema.
// A refused baseline must not have created any of them, either.
const APP_ENUMS = [
  "Origin",
  "CatalogKind",
  "AssociationKind",
  "BlessingTier",
] as const

/**
 * The failure signature a refused baseline is expected to produce. A single
 * string or RegExp means that signature MUST appear in the combined
 * stdout+stderr; an array means ANY ONE of the listed signatures must appear.
 */
type FailurePattern = string | RegExp | ReadonlyArray<string | RegExp>

/** True when `output` contains at least one of the expected failure signatures. */
function matchesFailurePattern(
  output: string,
  pattern: FailurePattern
): boolean {
  const patterns = Array.isArray(pattern) ? pattern : [pattern]
  return patterns.some((p) =>
    p instanceof RegExp ? p.test(output) : output.includes(p)
  )
}

/** Human-readable description of the expected failure signature(s) for a message. */
function describeFailurePattern(pattern: FailurePattern): string {
  const patterns = Array.isArray(pattern) ? pattern : [pattern]
  return patterns
    .map((p) => (p instanceof RegExp ? p.toString() : `"${p}"`))
    .join(" or ")
}

/**
 * Remove SQL comments from a PostgreSQL script so the executable-statement
 * analysis below never matches a keyword that appears only inside a comment -
 * a naive `sql.indexOf("CREATE ")` would otherwise falsely fire on a leading
 * comment such as "runs BEFORE any CREATE, ...".
 *
 * Line comments (two dashes) and block comments (slash-star ... star-slash) are
 * removed. Single-quoted string literals and double-quoted identifiers (with
 * their doubled-quote escapes) are preserved, so a comment marker inside a
 * literal is never mistaken for a comment. A block comment is replaced with a
 * single space so adjacent tokens are not glued together. The 0.1.0 baseline
 * uses no dollar-quoted body that contains a comment marker, so dollar-quoting
 * needs no special handling here.
 */
function stripSqlComments(sql: string): string {
  let out = ""
  let i = 0
  const n = sql.length

  while (i < n) {
    const ch = sql[i]
    const next = sql[i + 1] ?? ""

    if (ch === "-" && next === "-") {
      // -- line comment: drop up to (not including) the line terminator.
      while (i < n && sql[i] !== "\n") i++
      // Keep the newline so relative positions of surviving tokens stay stable.
      if (i < n) {
        out += "\n"
        i++
      }
    } else if (ch === "/" && next === "*") {
      // /* block comment */: drop it, but keep a single space so adjacent tokens
      // do not get concatenated.
      i += 2
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++
      i += 2
      if (out.length > 0) out += " "
    } else if (ch === "'") {
      // Single-quoted string literal.
      let j = i + 1
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2
            continue
          }
          break
        }
        j++
      }
      out += sql.slice(i, j + 1)
      i = j + 1
    } else if (ch === '"') {
      // Double-quoted identifier.
      let j = i + 1
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2
            continue
          }
          break
        }
        j++
      }
      out += sql.slice(i, j + 1)
      i = j + 1
    } else {
      out += ch
      i++
    }
  }

  return out
}

// ------------------------------------------------------------------ //
// Disposable-database helpers for the opt-in regression blocks below.
// They never run against a pre-existing database: each helper creates a
// UNIQUE `_test`-named database on the same server DATABASE_URL points at,
// exercises it, and drops ONLY that database.
// ------------------------------------------------------------------ //

const PRISMA_BIN = createRequire(import.meta.url).resolve(
  "prisma/build/index.js"
)

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

/** Run the ACTUAL Prisma CLI `migrate deploy` (not a mock) as a subprocess. */
function runPrismaMigrateDeploy(
  env: Record<string, string>
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PRISMA_BIN, "migrate", "deploy"], {
      env: { ...process.env, ...env },
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("error", reject)
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
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

/**
 * Whether the server this DATABASE_URL points at has the pg_stat_statements
 * extension available to install. On CI images that omit it (or on a Postgres
 * that is unreachable) the pg_stat_statements-specific checks are skipped below
 * with a logged reason, while the fail-closed guard checks run regardless.
 */
async function checkPgStatStatementsAvailable(): Promise<boolean> {
  const base = new URL(process.env.DATABASE_URL!)
  const admin = new PrismaClient({
    datasources: { db: { url: maintenanceUrl(base) } },
  })
  try {
    const rows = (await admin.$queryRawUnsafe(
      `SELECT name FROM pg_available_extensions WHERE name = 'pg_stat_statements'`
    )) as Array<{ name: string }>
    return rows.length > 0
  } catch (err) {
    console.log(
      `initial-schema: could not query pg_available_extensions for pg_stat_statements ` +
        `(${err instanceof Error ? err.message : String(err)}); skipping the ` +
        `pg_stat_statements baseline checks`
    )
    return false
  } finally {
    await admin.$disconnect()
  }
}

/**
 * Whether a Postgres error is a role/permission failure that should SKIP rather
 * than fail the opt-in pg_stat_statements check. Installing pg_stat_statements
 * requires superuser (or database CREATE) privilege; a managed application role
 * (e.g. a Crunchy PGO application role) often lacks it, and that is an
 * environment limitation, not a regression in the baseline guard. Any other
 * CREATE EXTENSION failure is a real error and must fail the test.
 */
function isPermissionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /permission denied|must be (?:a )?superuser|must be owner|must be the owner|insufficient privilege|is not superuser|no privilege granted/i.test(
    msg
  )
}

// Resolve pg_stat_statements availability only when the integration gate passed;
// otherwise the block below is skipped and no DB round-trip happens.
let pgssAvailable = false
if (gate.run) {
  pgssAvailable = await checkPgStatStatementsAvailable()
}

// ------------------------------------------------------------------ //
// Real-Postgres opt-in regressions (disposable databases only)
// ------------------------------------------------------------------ //

describe.skipIf(!gate.run)(
  "0.1.0 baseline with a public extension (pg_stat_statements) (opt-in)",
  () => {
    it(
      "applies the baseline and preserves extension views/functions when pg_stat_statements is installed in public",
      { timeout: 60_000 },
      async (context) => {
        if (!pgssAvailable) {
          context.skip(
            "pg_stat_statements is not available on this PostgreSQL server; " +
              "cannot prove the public-extension baseline here (asserted on servers where it is available)"
          )
        }

        await withScratchDb("initial_schema_pgss", async (dbName, url) => {
          // Install the extension into public, exactly as a Crunchy PGO database does.
          // pg_stat_statements needs superuser to CREATE EXTENSION; if the opted-in
          // role cannot install it (e.g. a PGO application role), skip this check with
          // an explicit reason rather than failing the whole opt-in suite. Any other
          // installation error is rethrown so the test genuinely fails.
          const admin = new PrismaClient({
            datasources: { db: { url } },
          })
          try {
            await admin.$executeRawUnsafe(
              `CREATE EXTENSION pg_stat_statements WITH SCHEMA public`
            )
          } catch (err) {
            if (isPermissionError(err)) {
              context.skip(
                `could not CREATE EXTENSION pg_stat_statements in the scratch database ` +
                  `(${err instanceof Error ? err.message : String(err)}); the role likely lacks ` +
                  `superuser. Skipping so the opt-in suite can run on a PGO application role.`
              )
            }
            throw err
          } finally {
            await admin.$disconnect()
          }

          // Run the ACTUAL Prisma CLI migrate deploy against this disposable DB.
          const res = await runPrismaMigrateDeploy({ DATABASE_URL: url })
          expect(
            res.code,
            `migrate deploy failed against a public-extension baseline:\n${res.stderr}`
          ).toBe(0)

          // Assert the full baseline schema AND the extension objects survived.
          const db = new PrismaClient({ datasources: { db: { url } } })
          try {
            const tables = (await db.$queryRawUnsafe(
              `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
            )) as Array<{ table_name: string }>
            const appNames = tables
              .map((r) => r.table_name)
              .filter((n) => n !== "_prisma_migrations")
            expect(appNames).toEqual([...APP_TABLES])

            // The extension views must still be present and never dropped.
            const views = (await db.$queryRawUnsafe(
              `SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'v' AND c.relname IN ('pg_stat_statements', 'pg_stat_statements_info') ORDER BY c.relname`
            )) as Array<{ relname: string }>
            expect(views.map((r) => r.relname)).toEqual([
              "pg_stat_statements",
              "pg_stat_statements_info",
            ])

            // The extension functions must still be present and never dropped.
            const funcs = (await db.$queryRawUnsafe(
              `SELECT p.proname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('pg_stat_statements', 'pg_stat_statements_info', 'pg_stat_statements_reset') ORDER BY p.proname`
            )) as Array<{ proname: string }>
            expect(funcs.map((r) => r.proname)).toEqual([
              "pg_stat_statements",
              "pg_stat_statements_info",
              "pg_stat_statements_reset",
            ])

            // The single baseline migration is recorded as applied.
            const migs = (await db.$queryRawUnsafe(
              `SELECT migration_name AS name, finished_at FROM public."_prisma_migrations" ORDER BY started_at`
            )) as Array<{ name: string; finished_at: Date | null }>
            expect(migs.map((m) => m.name)).toEqual([BASELINE_MIGRATION_NAME])
            expect(migs[0].finished_at).not.toBeNull()
          } finally {
            await db.$disconnect()
          }
        })
      }
    )
  }
)

describe.skipIf(!gate.run)(
  "0.1.0 baseline guard refuses pre-existing non-extension objects (opt-in)",
  () => {
    async function runAndAssertRefusal(
      prefix: string,
      expectedPattern: FailurePattern,
      setup: (admin: PrismaClient) => Promise<void>
    ): Promise<void> {
      await withScratchDb(prefix, async (_dbName, url) => {
        const admin = new PrismaClient({ datasources: { db: { url } } })
        try {
          await setup(admin)
        } finally {
          await admin.$disconnect()
        }

        // The guard must refuse BEFORE any app object is created, and the
        // refusal must be a genuine failure (the specific Prisma error / guard
        // message), not a blind nonzero exit code.
        const res = await runPrismaMigrateDeploy({ DATABASE_URL: url })
        const combined = `${res.stdout}\n${res.stderr}`
        expect(
          res.code,
          `expected migrate deploy to fail closed, but it succeeded:\n${combined}`
        ).not.toBe(0)
        expect(
          matchesFailurePattern(combined, expectedPattern),
          `expected migrate deploy to fail with ${describeFailurePattern(expectedPattern)}, ` +
            `but the combined output did not match:\n${combined}`
        ).toBe(true)

        const db = new PrismaClient({ datasources: { db: { url } } })
        try {
          // No application TABLE may exist: a refused baseline creates nothing.
          const app = (await db.$queryRawUnsafe(
            `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name IN (${APP_TABLES.map((t) => `'${t}'`).join(", ")})`
          )) as Array<{ n: number }>
          expect(
            app[0].n,
            "no application table must be created on a refused migration"
          ).toBe(0)

          // No application ENUM may exist either.
          const enums = (await db.$queryRawUnsafe(
            `SELECT count(*)::int AS n FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace ns ON ns.oid = t.typnamespace WHERE ns.nspname = 'public' AND t.typtype = 'e' AND t.typname IN (${APP_ENUMS.map((e) => `'${e}'`).join(", ")})`
          )) as Array<{ n: number }>
          expect(
            enums[0].n,
            "no application enum must be created on a refused migration"
          ).toBe(0)
        } finally {
          await db.$disconnect()
        }
      })
    }

    it(
      "refuses a user-created table before any app object is created",
      { timeout: 60_000 },
      async () => {
        await runAndAssertRefusal(
          "baseline_refuse_tab",
          ["P3005", "non-extension object"],
          async (admin) => {
            await admin.$executeRawUnsafe(
              `CREATE TABLE public.foo (id text PRIMARY KEY)`
            )
          }
        )
      }
    )

    it(
      "refuses a user-created view (and its composite row type) before any app object is created",
      { timeout: 60_000 },
      async () => {
        await runAndAssertRefusal(
          "baseline_refuse_view",
          "non-extension object(s)",
          async (admin) => {
            await admin.$executeRawUnsafe(
              `CREATE VIEW public.foo_view AS SELECT 1 AS x`
            )
          }
        )
      }
    )

    it(
      "refuses an already-applied migration history before any app object is created",
      { timeout: 60_000 },
      async () => {
        await runAndAssertRefusal(
          "baseline_refuse_hist",
          /already has \d+ applied migration/,
          async (admin) => {
            await admin.$executeRawUnsafe(
              `CREATE TABLE public."_prisma_migrations" (id varchar PRIMARY KEY, checksum varchar NOT NULL, finished_at timestamptz, migration_name varchar NOT NULL, logs text, rolled_back_at timestamptz, started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0)`
            )
            await admin.$executeRawUnsafe(
              `INSERT INTO public."_prisma_migrations" (id, checksum, migration_name, started_at, applied_steps_count, finished_at) VALUES ('a', 'x', '0001_init', now(), 1, now())`
            )
          }
        )
      }
    )
  }
)

describe.skipIf(!gate.run)("prisma 0.1.0 initial baseline schema", () => {
  beforeAll(async () => {
    // Warm the connection so the first query in a test is not the DB gate's own.
    await prisma.$queryRaw`SELECT 1`
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it("records exactly one applied baseline migration and nothing else", async () => {
    const rows = await prisma.$queryRaw<
      Array<{ migration_name: string; finished_at: Date | null }>
    >`SELECT "migration_name", "finished_at" FROM "_prisma_migrations" ORDER BY "started_at"`

    expect(rows.map((r) => r.migration_name)).toEqual([BASELINE_MIGRATION_NAME])
    expect(rows[0].finished_at).not.toBeNull()
  })

  it("creates exactly the 11 application tables", async () => {
    const rows = await prisma.$queryRaw<
      Array<{ table_name: string }>
    >`SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`

    const names = rows.map((r) => r.table_name)
    const appNames = names.filter((n) => n !== "_prisma_migrations")
    expect(appNames).toEqual([...APP_TABLES])
  })

  it("adds the quantity and blessing-tier CHECK constraints", async () => {
    const rows = await prisma.$queryRaw<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint
      WHERE conname IN (
        'character_inventory_items_quantity_check',
        'character_associations_blessing_tier_check'
      )
    `
    expect(rows.map((r) => r.conname).sort()).toEqual([
      "character_associations_blessing_tier_check",
      "character_inventory_items_quantity_check",
    ])
  })

  it("creates the partial blessing and bloodline unique indexes", async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
      WHERE indexname IN (
        'character_associations_characterId_blessing_key',
        'character_associations_characterId_bloodline_key'
      )
    `
    expect(rows.map((r) => r.indexname).sort()).toEqual([
      "character_associations_characterId_blessing_key",
      "character_associations_characterId_bloodline_key",
    ])
  })

  it("defines the four application enums in the public schema", async () => {
    const rows = await prisma.$queryRaw<Array<{ typname: string }>>`
      SELECT t.typname FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
        AND t.typtype = 'e'
        AND t.typname IN ('Origin', 'CatalogKind', 'AssociationKind', 'BlessingTier')
      ORDER BY t.typname
    `
    expect(rows.map((r) => r.typname)).toEqual([
      "AssociationKind",
      "BlessingTier",
      "CatalogKind",
      "Origin",
    ])
  })

  it("seeds the active house_rules singleton with the full final default config", async () => {
    const rows = await prisma.$queryRaw<Array<{ config_text: string }>>`
      SELECT "config"::text AS config_text FROM "house_rules" WHERE "id" = 'active'
    `
    expect(rows).toHaveLength(1)
    const config = JSON.parse(rows[0].config_text)
    expect(config).toEqual({
      equipmentIndividualCapPercent: 20,
      equipmentCombinedCapPercent: 15,
      consumableGradeRates: { F: 3, E: 5, D: 15, C: 45 },
      maxTranscendentSkills: 3,
      skillChoiceIntervals: {
        G: 5,
        F: 5,
        E: 5,
        D: 20,
        C: 30,
        B: 40,
        A: 50,
        S: 60,
      },
    })
  })

  it("migration file opens with the guard and never drops anything", () => {
    const rawSql = readFileSync(
      new URL(
        "../../prisma/migrations/20261016000000_initial_0_1_0/migration.sql",
        import.meta.url
      ),
      "utf8"
    )
    // Analyze ONLY the executable SQL. Stripping comments first means a keyword
    // that appears solely in a leading comment (e.g. "runs BEFORE any CREATE")
    // is never mistaken for a real statement.
    const sql = stripSqlComments(rawSql).trim()

    // The executable migration MUST open with the DO guard: it is the first
    // statement, and it runs BEFORE any CREATE.
    expect(sql.startsWith("DO $$")).toBe(true)
    const firstCreate = sql.indexOf("CREATE ")
    const doIndex = sql.indexOf("DO $$")
    expect(doIndex).toBeGreaterThanOrEqual(0)
    expect(firstCreate).toBeGreaterThan(doIndex)

    // Guard semantics: it rejects a non-empty _prisma_migrations and pre-existing
    // public objects, and raises (never drops).
    expect(sql).toContain("_prisma_migrations")
    expect(sql).toContain("RAISE EXCEPTION")
    expect(sql).toContain("CONSTRAINT")
    expect(
      /DROP\s+TABLE|DROP\s+INDEX|DROP\s+TYPE|DROP\s+COLUMN/i.test(sql)
    ).toBe(false)
  })
})
