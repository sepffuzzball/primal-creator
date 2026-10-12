import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx", "**/*.test.mts"],
    // Build output (Next standalone) contains a stale copy of source test files;
    // never collect tests from there.
    exclude: ["**/node_modules/**", "**/.next/**", "**/.git/**"],
    // Resolve TEST_DATABASE_URL into the effective Prisma DATABASE_URL before any
    // test module imports the Prisma singleton (see lib/test/db-integration.setup.ts).
    setupFiles: ["./lib/test/db-integration.setup.ts"],
    // Run test files serially. The real-Postgres integration suites share a single
    // test database and the last-admin concurrency fixture asserts that NO other
    // enabled admin exists (it fails loudly rather than skipping), so a portrait
    // test that concurrently creates an admin must not overlap with it.
    fileParallelism: false,
  },
})
