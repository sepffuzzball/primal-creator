import { test, expect, type Page } from "@playwright/test"

/**
 * Authenticated character lifecycle E2E.
 *
 * Drives a real Chromium against the app served on 127.0.0.1:3101 (started by
 * playwright.config.ts). It logs in through the UI, asserts the persisted
 * dashboard starts empty because the suite is required to run against a freshly
 * seeded, isolated test database (no active characters, no resumable draft),
 * then walks the official eight-step questionnaire (born / Human / Archer / no
 * profession), creates a uniquely-named character, advances the class track
 * four quarters (reaching level 1 and gaining a free point), allocates one
 * attribute point, and archives the character through the confirmation dialog.
 *
 * The test never mutates pre-existing data: it fails loudly (rather than
 * deleting anything) if the test database already holds active characters or a
 * draft, and the only character it ever modifies is the one it creates. Prior
 * runs leave that character archived (never restored), so repeated runs against
 * the same test database are fine - the default `/api/characters` listing
 * excludes archived characters, so leftovers never appear as active. It uses a
 * fresh browser context (clean localStorage, no dev DB data), a unique character
 * name, and only accessible selectors - never hardcoded generated IDs
 * (character ids are read from the URL, not assumed).
 */

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || "admin@primal.local"
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || "admin"

/** Click `Next` in the questionnaire (the accessible Next button). */
async function next(page: Page): Promise<void> {
  // `exact` avoids matching the Next.js Dev Tools button, whose accessible name
  // is "Open Next.js Dev Tools" (contains "Next").
  await page.getByRole("button", { name: "Next", exact: true }).click()
}

/**
 * Select a questionnaire radio by its visible label text. The primitive renders
 * the choice as a `<label>` wrapping the input, so the accessible name includes
 * the label text; matching by a case-insensitive prefix is robust.
 */
async function choose(page: Page, label: RegExp): Promise<void> {
  await page.getByRole("radio", { name: label }).check()
}

/**
 * Wait until React has hydrated the current page. `next dev` is slow to
 * compile/hydrate on a cold start (and does so after the `load` event), so
 * interacting before hydration causes browsers to submit the login form with
 * the native GET fallback instead of firing React's onSubmit handler. This
 * deterministically waits for React to attach its fiber/props to the DOM -
 * which only happens once the client bundle actually hydrates - so every
 * click lands on a wired-up component.
 */
async function waitForHydrated(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const els = document.querySelectorAll<HTMLElement>("*")
      for (let i = 0; i < els.length; i++) {
        const keys = Object.keys(els[i])
        if (keys.some((k) => k.startsWith("__reactFiber$"))) return true
      }
      return false
    },
    undefined,
    { timeout: 45_000 }
  )
}

/**
 * Advance the class track one quarter, closing the progression journal dialog
 * that opens on every advance. Waits for the button to become enabled again
 * (the server reload disables it while the mutation is in flight).
 */
async function advanceClassQuarter(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: /^Advance class/ })
  await expect(button).toBeEnabled()
  await button.click()

  const journal = page
    .locator("[role=dialog]")
    .filter({ hasText: "Progression journal" })
  await expect(journal).toBeVisible()
  // base-ui <Dialog> closes on Escape; this also unblocks the next click.
  await page.keyboard.press("Escape")
  await expect(journal).toBeHidden()
  await expect(button).toBeEnabled()
}

test.describe("character lifecycle", () => {
  test("login, create, progress, allocate, archive", async ({ page }) => {
    // ------------------------------------------------------------------ //
    // Login through the UI.
    // ------------------------------------------------------------------ //
    await page.goto("/login")
    await waitForHydrated(page)
    await page.getByLabel("Email").fill(ADMIN_EMAIL)
    await page.getByLabel("Password").fill(ADMIN_PASSWORD)
    await page.getByRole("button", { name: "Sign in" }).click()
    await page.waitForURL("**/")

    // ------------------------------------------------------------------ //
    // Fresh, isolated test DB, no mutation. The seed creates no characters and
    // no draft, so after logging in the dashboard must be empty. Fail loudly
    // (rather than deleting/archiving) if the database is not fresh, so the suite
    // never silently runs against user data or a reused DB holding real
    // characters. Prior runs' archived characters never count here: the default
    // `/api/characters` listing excludes archived, so only *active* characters
    // are required to be absent and archived leftovers are left untouched.
    // ------------------------------------------------------------------ //
    const list = await page.request.get("/api/characters")
    expect(list.ok()).toBeTruthy()
    const { characters } = (await list.json()) as {
      characters: Array<{ id: string; name: string }>
    }
    expect(
      characters,
      `The E2E test DB must start with no active characters (found ${characters.length}). ` +
        "Drop/reseed a fresh isolated test database and re-run. Prior runs' archived " +
        "characters are excluded by default and do not count."
    ).toHaveLength(0)

    // The test admin must have no resumable draft, or the questionnaire would
    // resume mid-way and hide the name field (the test always starts at step 1).
    // This is an assertion, not cleanup: a leftover draft means the DB is not fresh.
    const draftGet = await page.request.get("/api/drafts")
    expect(draftGet.ok()).toBeTruthy()
    const { draft } = (await draftGet.json()) as { draft: unknown }
    expect(
      draft,
      "The E2E test DB must start with no resumable draft for the test admin " +
        "(found one). Drop/reseed a fresh isolated test database and re-run."
    ).toBeNull()

    await page.reload()
    await waitForHydrated(page)

    // No sample characters: the empty-state message is shown and the create
    // entry point is present.
    await expect(
      page.getByRole("link", { name: "Create a character" })
    ).toBeVisible()
    await expect(
      page.getByText("No characters match your filters.")
    ).toBeVisible()

    // Unique name so a repeated run can never collide with a leftover archived
    // character or other data (the dashboard excludes archived by default).
    const name = `E2E-${Date.now()}`

    // ------------------------------------------------------------------ //
    // Walk the eight-step questionnaire.
    // ------------------------------------------------------------------ //
    await page.getByRole("link", { name: "Create a character" }).click()
    await page.waitForURL(/\/characters\/new$/)

    // Step 1 - name. The description is optional.
    await page.getByPlaceholder("Character name").fill(name)
    await next(page)

    // Step 2 - origin: Born (starts at F grade).
    await choose(page, /born/i)
    await next(page)

    // Step 3 - race: Human. Wait for the catalog to load so the choice exists.
    await expect(page.getByRole("radio", { name: /^Human\b/i })).toBeVisible()
    await choose(page, /^Human\b/i)
    await next(page)

    // Step 4 - class: Archer.
    await expect(page.getByRole("radio", { name: /^Archer\b/i })).toBeVisible()
    await choose(page, /^Archer\b/i)
    await next(page)

    // Step 5 - profession: None.
    await choose(page, /^None\b/i)
    await next(page)

    // Step 6 - special abilities (nothing to choose; the wizard has no Next
    // button on the final review step, so this is the last Next click).
    await next(page)

    // Step 7 - equipment (nothing to choose).
    await next(page)

    // Step 8 - review. Confirm and submit. There is no Next button on the
    // review step - it is replaced by the Submit button - so submit directly.
    await page.getByRole("button", { name: "Create character" }).click()
    // `new` also matches `[^/]+`, so exclude it explicitly: the create page keeps
    // its `/characters/new` URL until the push to the character detail route.
    await page.waitForURL(/\/characters\/(?!new$)[^/]+$/)
    const characterUrl = page.url()

    // The character detail page shows the created name.
    await expect(page.getByRole("heading", { name })).toBeVisible()

    // ------------------------------------------------------------------ //
    // Progress: advance the class track four quarters (level 0 -> level 1).
    // ------------------------------------------------------------------ //
    await advanceClassQuarter(page)
    await advanceClassQuarter(page)
    await advanceClassQuarter(page)
    await advanceClassQuarter(page)

    // The class track reached level 1 quarter 0.
    await expect(
      page.getByRole("button", { name: /^Advance class \(L1 Q0\)/ })
    ).toBeVisible()

    // ------------------------------------------------------------------ //
    // Allocate one attribute point.
    // ------------------------------------------------------------------ //
    await page.getByRole("tab", { name: "Attributes" }).click()

    // Level-up awarded the class free point (Archer F gives 1 free point).
    await expect(page.getByText("Available points: 1").first()).toBeVisible()
    await expect(page.getByText("Total free: 1", { exact: true })).toBeVisible()
    await expect(page.getByText("Allocated: 0", { exact: true })).toBeVisible()

    // Allocate the single free point to Strength.
    await page.getByLabel("Strength", { exact: true }).fill("1")
    await page.getByRole("button", { name: "Confirm allocation" }).click()

    // Status updated: the point is now allocated, nothing remains available.
    await expect(page.getByText("Available points: 0").first()).toBeVisible()
    await expect(page.getByText("Allocated: 1", { exact: true })).toBeVisible()
    // The attribute name cell is `text-transform: capitalize` (CSS) but the DOM
    // text is the lowercase attribute key, so match case-insensitively (the row
    // textContent is also concatenated without whitespace between cells).
    const strengthRow = page.locator("tbody tr").filter({ hasText: "strength" })
    await expect(strengthRow.locator("td").nth(1)).toHaveText("1")

    // ------------------------------------------------------------------ //
    // Archive through the confirmation dialog.
    // ------------------------------------------------------------------ //
    await page.goto("/")
    await waitForHydrated(page)
    await expect(page.getByRole("link", { name })).toBeVisible()
    await page.getByRole("button", { name: "Archive", exact: true }).click()
    const archiveDialog = page
      .locator("[role=dialog]")
      .filter({ hasText: "Archive character" })
    await expect(archiveDialog).toBeVisible()
    await archiveDialog
      .getByRole("button", { name: "Archive", exact: true })
      .click()
    await expect(
      page.getByText(new RegExp(`Archived "${name}"\\.`))
    ).toBeVisible()

    // The archive persisted: the character detail page now offers Restore.
    await page.goto(characterUrl)
    await waitForHydrated(page)
    await expect(page.getByRole("button", { name: "Restore" })).toBeVisible()
  })
})
