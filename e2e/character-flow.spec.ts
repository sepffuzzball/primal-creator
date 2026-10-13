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

    // ------------------------------------------------------------------ //
    // Import the reviewed wiki manifest (admin-only, idempotent).
    //
    // The seed creates no blessings / bloodlines / transcendent skills, so the
    // wizard's special-abilities step would have nothing to select until this
    // import runs. The import never deletes or overwrites existing catalog rows
    // (a repeated run skips every already-present entry), so it is safe to run
    // against the same isolated test DB more than once: the first run creates
    // the entries and a second run observes createCount=0 and takes the
    // idempotent skip path.
    // ------------------------------------------------------------------ //
    await page.goto("/catalog/blessings")
    await waitForHydrated(page)

    // Preview to decide whether to apply. The preview endpoint is admin-only
    // and we are logged in as the test admin, so a 401/403 would fail loudly.
    const previewRes = await page.request.get("/api/admin/catalog-import")
    expect(previewRes.ok()).toBeTruthy()
    const preview = (await previewRes.json()) as {
      source: string
      createCount: number
      skipCount: number
      entries: Array<{
        kind: string
        stableId: string
        status: "create" | "skip_existing"
      }>
    }
    expect(preview.source).toBe("wiki-reviewed")

    // Exercise the UI entry point: open the import dialog so the admin sees the
    // preview and the Apply button, rather than only calling the API.
    const importDialog = page
      .locator("[role=dialog]")
      .filter({ hasText: "Import reviewed wiki entries" })
    await page
      .getByRole("button", { name: "Import reviewed wiki entries" })
      .click()
    await expect(
      importDialog.getByText(
        new RegExp(
          `${preview.createCount} to create; ${preview.skipCount} to skip existing\\.`
        )
      )
    ).toBeVisible()

    if (preview.createCount > 0) {
      // Apply, accepting the browser confirmation dialog.
      page.once("dialog", (dialog) => dialog.accept())
      await importDialog.getByRole("button", { name: "Apply import" }).click()
      await expect(
        importDialog.getByText(new RegExp(/Created \d+; skipped \d+\./))
      ).toBeVisible()
    } else {
      // Idempotent: nothing to create this run. Every manifest entry is
      // skip_existing (existing rows are never overwritten) and the Apply
      // button is disabled when there is nothing to create.
      expect(preview.skipCount).toBeGreaterThan(0)
      expect(
        preview.entries.every((e) => e.status === "skip_existing")
      ).toBeTruthy()
      await expect(
        importDialog.getByRole("button", { name: "Apply import" })
      ).toBeDisabled()
    }

    // Close the import dialog and assert the imported catalogs are now reachable
    // via authenticated GET, so the wizard can offer the blessing + bloodline on
    // the special-abilities step.
    await page.keyboard.press("Escape")
    await expect(
      page.getByRole("button", { name: "Import reviewed wiki entries" })
    ).toBeVisible()

    const blessingCatalog = await page.request.get("/api/catalog/blessings")
    expect(blessingCatalog.ok()).toBeTruthy()
    const blessings = (await blessingCatalog.json()) as {
      kind: string
      items: Array<{ name: string }>
    }
    expect(blessings.kind).toBe("blessings")
    expect(
      blessings.items.some(
        (b) => b.name === "True Blessing of the Malefic Viper"
      )
    ).toBeTruthy()

    const bloodlineCatalog = await page.request.get("/api/catalog/bloodlines")
    expect(bloodlineCatalog.ok()).toBeTruthy()
    const bloodlines = (await bloodlineCatalog.json()) as {
      kind: string
      items: Array<{ name: string }>
    }
    expect(bloodlines.kind).toBe("bloodlines")
    expect(
      bloodlines.items.some((b) => b.name === "Bloodline of the Primal Hunter")
    ).toBeTruthy()

    const transcendentCatalog = await page.request.get(
      "/api/catalog/transcendent_skills"
    )
    expect(transcendentCatalog.ok()).toBeTruthy()
    const transcendents = (await transcendentCatalog.json()) as {
      kind: string
      items: unknown[]
    }
    expect(transcendents.kind).toBe("transcendent_skills")
    // The curated manifest ships no transcendent skill, so this catalog is
    // present (endpoint reachable, items array returned) but empty.
    expect(Array.isArray(transcendents.items)).toBeTruthy()

    // Return to the dashboard to start the character wizard.
    await page.goto("/")
    await waitForHydrated(page)

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

    // Step 6 - special abilities. The curated wiki manifest ships a blessing
    // (True Blessing of the Malefic Viper) and a bloodline (Bloodline of the
    // Primal Hunter) but no transcendent skill, so select the blessing +
    // bloodline and leave the transcendent section unselected.
    await expect(
      page.getByRole("radio", { name: /True Blessing of the Malefic Viper/ })
    ).toBeVisible()
    await choose(page, /True Blessing of the Malefic Viper/)
    await expect(
      page.getByRole("checkbox", { name: /Bloodline of the Primal Hunter/ })
    ).toBeVisible()
    await page
      .getByRole("checkbox", { name: /Bloodline of the Primal Hunter/ })
      .check()
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
    // The special-ability selections persisted: the Powers tab shows the
    // linked blessing + bloodline, the detail API returns the associations,
    // the resumable draft was consumed atomically, and the atomic create
    // progression event recorded the selection snapshot.
    // ------------------------------------------------------------------ //
    await page.getByRole("tab", { name: "Powers" }).click()
    const powers = page
      .locator("[role=tabpanel]")
      .filter({ hasText: "Blessings and bloodlines" })
    await expect(
      powers.getByText("True Blessing of the Malefic Viper")
    ).toBeVisible()
    await expect(
      powers.getByText("Bloodline of the Primal Hunter")
    ).toBeVisible()
    // The curated manifest ships no transcendent skill, so none is linked and
    // the section reports an empty state (never a fabricated link).
    await expect(
      powers.getByText("No linked transcendent skills.")
    ).toBeVisible()

    const characterId = new URL(characterUrl).pathname.split("/").pop()!
    expect(characterId).toBeTruthy()

    const detailRes = await page.request.get(`/api/characters/${characterId}`)
    expect(detailRes.ok()).toBeTruthy()
    const detail = (await detailRes.json()) as {
      character: {
        associations: Array<{ kind: string; name: string }>
      }
    }
    const assocKeys = detail.character.associations.map(
      (a) => `${a.kind}:${a.name}`
    )
    expect(assocKeys).toContain("blessing:True Blessing of the Malefic Viper")
    expect(assocKeys).toContain("bloodline:Bloodline of the Primal Hunter")

    // The wizard's final create step atomically consumes the resumable draft,
    // so no draft remains after creation.
    const draftAfterRes = await page.request.get("/api/drafts")
    expect(draftAfterRes.ok()).toBeTruthy()
    const draftAfter = (await draftAfterRes.json()) as { draft: unknown }
    expect(draftAfter.draft).toBeNull()

    // The atomic create progression event recorded the special-ability
    // selection snapshot (blessing + bloodline), never an empty selection.
    const exportRes = await page.request.get(
      `/api/characters/${characterId}/export`
    )
    expect(exportRes.ok()).toBeTruthy()
    const exportBody = (await exportRes.json()) as {
      events: Array<{ kind: string; payload: Record<string, unknown> }>
    }
    const createEvent = exportBody.events.find((e) => e.kind === "create")
    expect(createEvent).toBeTruthy()
    const special = createEvent?.payload.specialAbilities as
      | {
          blessing: { name: string } | null
          bloodlines: Array<{ name: string }>
        }
      | undefined
    expect(special).toBeTruthy()
    expect(special?.blessing?.name).toBe("True Blessing of the Malefic Viper")
    expect(
      special?.bloodlines.some(
        (b) => b.name === "Bloodline of the Primal Hunter"
      )
    ).toBe(true)

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
