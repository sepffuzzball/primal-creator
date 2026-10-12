/**
 * Vitest setup file, run before any test module is imported.
 *
 * When `TEST_DATABASE_URL` is set, point the effective Prisma `DATABASE_URL` at
 * the isolated integration-test database BEFORE `@/lib/db/client` constructs the
 * Prisma singleton, so the integration tests never connect to a dev/prod database.
 * The gate in `lib/test/db-integration.ts` still requires `RUN_DB_INTEGRATION_TESTS=1`
 * and a test-named database before anything runs.
 */

if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
}
