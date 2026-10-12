/**
 * Shared gate for real-Postgres integration tests.
 *
 * Integration tests that touch a live database must NEVER run against a
 * development/production database during an ordinary `pnpm test`. They run only
 * when BOTH hold:
 *
 *   1. `RUN_DB_INTEGRATION_TESTS=1` is explicitly set, and
 *   2. the effective Prisma `DATABASE_URL` points at a test-named database (the
 *      database name contains `_test` or `test_`).
 *
 * When `TEST_DATABASE_URL` is set it is preferred: `lib/test/db-integration.setup.ts`
 * points `process.env.DATABASE_URL` at it BEFORE the Prisma singleton is constructed,
 * so the integration suite is isolated from any dev/prod database. The gate below
 * validates the effective `DATABASE_URL` name regardless.
 *
 * `resolveDbIntegration()` returns `run: false` only for the ordinary, non-opted-in
 * case (`RUN_DB_INTEGRATION_TESTS` is not "1"), which the tests skip via
 * `describe.skipIf(!gate.run)`. When the caller HAS opted in but the environment is
 * wrong - a non-test database name, no usable `DATABASE_URL`, or an unreachable
 * database - it THROWS so the run fails loudly instead of silently skipping. An
 * opted-in integration run never masks a misconfiguration.
 */

import { prisma } from "@/lib/db/client"

export interface DbIntegrationGate {
  run: boolean
  dbName: string | null
  reason: string
}

/** Extract the database name from a postgres connection URL, tolerating bad URLs. */
function dbNameFromUrl(url: string | undefined): string | null {
  if (!url) return null
  try {
    const pathname = new URL(url).pathname
    const seg = pathname.replace(/^\//, "").split("?")[0].split("#")[0]
    return seg ? decodeURIComponent(seg) : null
  } catch {
    // Fallback for connection strings `new URL` rejects: last slash -> '?'/'#'/end.
    const m = /\/([^/?#]+)(?:[?#]|$)/.exec(url)
    return m ? m[1] : null
  }
}

/** True when the database name is clearly a test database (`_test` or `test_`). */
function isTestDbName(name: string): boolean {
  return name.includes("_test") || name.includes("test_")
}

/**
 * Decide whether the real-Postgres integration suite may run. Safe to call at
 * module top level in a test file (top-level await).
 *
 * Throws when `RUN_DB_INTEGRATION_TESTS=1` but the database is missing, not
 * test-named, or unreachable. Returns `run: false` only when the caller has not
 * opted in, so ordinary test runs still skip the integration files.
 */
export async function resolveDbIntegration(): Promise<DbIntegrationGate> {
  if (process.env.RUN_DB_INTEGRATION_TESTS !== "1") {
    return {
      run: false,
      dbName: null,
      reason: "RUN_DB_INTEGRATION_TESTS is not set to 1",
    }
  }

  const dbName = dbNameFromUrl(process.env.DATABASE_URL)
  if (!dbName) {
    throw new Error(
      "RUN_DB_INTEGRATION_TESTS=1 but no usable DATABASE_URL was provided"
    )
  }
  if (!isTestDbName(dbName)) {
    throw new Error(
      `RUN_DB_INTEGRATION_TESTS=1 but database "${dbName}" is not a test database ` +
        "(the name must contain _test or test_)"
    )
  }

  try {
    await prisma.$queryRaw`SELECT 1`
  } catch (err) {
    throw new Error(
      `RUN_DB_INTEGRATION_TESTS=1 but integration database "${dbName}" is not ` +
        `reachable: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  return { run: true, dbName, reason: "ok" }
}
