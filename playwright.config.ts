import { defineConfig, devices } from "@playwright/test"

/**
 * Playwright E2E configuration for the browser-based character lifecycle test.
 *
 * These tests drive a real Chromium against the Next.js app served on
 * 127.0.0.1:3101. They are deliberately gated so an ordinary `pnpm test:e2e`
 * can never mutate a development/production database (see the checks below).
 *
 * The app server is started by Playwright via the `webServer` block, so a
 * developer never has to run `pnpm dev` themselves. `reuseExistingServer` is
 * always `false`: Playwright starts a fresh server on 127.0.0.1:3101 and fails
 * on a port conflict rather than silently reusing a pre-existing dev server that
 * may point at a different database, so the E2E never runs against the wrong
 * data.
 */

const BASE_URL = "http://127.0.0.1:3101"

/** A database URL is test-safe when its name contains `_test` or `test_`. */
const TEST_DB_PATTERN = /_test|test_/

/** Extract the database name from a postgres connection URL, tolerating bad URLs. */
function dbNameFromUrl(url: string | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    const seg = u.pathname.replace(/^\//, "").split("?")[0].split("#")[0]
    return seg ? decodeURIComponent(seg) : null
  } catch {
    // Fallback for connection strings `new URL` rejects: last slash -> '?'/'#'/end.
    const m = /\/([^/?#]+)(?:[?#]|$)/.exec(url)
    return m ? m[1] : null
  }
}

// Load the repo `.env` (without overriding real environment variables) so the
// E2E gate below considers the *effective* DATABASE_URL even when it is only
// configured in `.env`. Real env vars always win, which is what CI uses.
const loadEnvFile = (process as unknown as { loadEnvFile?: () => void })
  .loadEnvFile
if (loadEnvFile) {
  try {
    loadEnvFile()
  } catch {
    // `.env` may be absent; environment variables still work.
  }
}

// ------------------------------------------------------------------ //
// Gate: never run against a non-test database, and only when opted in.
// ------------------------------------------------------------------ //

if (process.env.RUN_BROWSER_TESTS !== "1") {
  throw new Error(
    "Playwright browser tests are gated behind RUN_BROWSER_TESTS=1 so `pnpm test:e2e` " +
      "never touches your dev DB. Run: `RUN_BROWSER_TESTS=1 DATABASE_URL=<test-db> pnpm test:e2e`."
  )
}

const dbName = dbNameFromUrl(process.env.DATABASE_URL)
if (!dbName || !TEST_DB_PATTERN.test(dbName)) {
  // Report only the parsed database name (or "(unset)"), never the full
  // connection string, so a failing CI log does not leak a config password.
  throw new Error(
    `RUN_BROWSER_TESTS=1 but DATABASE_URL must name an isolated test database (the ` +
      `database name must contain _test or test_). Got database: ` +
      `${dbName ?? "(unset)"}`
  )
}

export default defineConfig({
  testDir: "./e2e",
  // Generous: a cold `next dev` compile can take several seconds per route, and
  // the test waits for React hydration after every full page load (see
  // e2e/character-flow.spec.ts `waitForHydrated`).
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: BASE_URL,
    // Collect failure diagnostics (screenshots/videos/traces) so CI can report
    // artifacts; these are no-ops on a passing run.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // `--webpack` opts out of the Turbopack dev server: Next 16's Turbopack
    // crashes on this codebase with a `parent_count underflow` panic, aborting
    // the server before any browser request can be served. Webpack is stable.
    command: "pnpm dev -p 3101 --webpack",
    url: `${BASE_URL}/api/health`,
    // Always start our own server. Never reuse a pre-existing :3101 dev server,
    // which could be running against a different database; instead fail on a port
    // conflict so the test never silently connects to the wrong data.
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
    // Carry the full environment (DATABASE_URL, AUTH_SECRET, creds) through to
    // the dev server, and pin APP_ORIGIN so the app's CSRF origin assertion
    // accepts browser requests whose Origin is 127.0.0.1:3101 rather than the
    // localhost:3101 the dev server would otherwise derive from `req.url`.
    env: {
      ...process.env,
      APP_ORIGIN: BASE_URL,
    },
  },
})
