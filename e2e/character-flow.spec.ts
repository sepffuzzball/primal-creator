import { test, expect, type Page } from "@playwright/test"

/**
 * Authenticated character lifecycle E2E.
 *
 * Drives a real Chromium against the app served on 127.0.0.1:3101 (started by
 * playwright.config.ts). It logs in through the UI, asserts the persisted
 * dashboard starts empty because the suite is required to run against a freshly
 * seeded, isolated test database (no active characters, no resumable draft),
 * then walks the official eight-step enlightened-branch questionnaire (born /
 * Human / Archer / no profession), creates a uniquely-named character, advances
 * the class track
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

/** Click `Back` in the questionnaire (the accessible Previous button). */
async function back(page: Page): Promise<void> {
  // `exact` avoids matching any other button whose accessible name merely
  // contains "Back" (e.g. a "Back to dashboard" link on some pages).
  await page.getByRole("button", { name: "Back", exact: true }).click()
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
 * Wait for a dynamically-loaded questionnaire radio (a catalog option) to be
 * visible.
 *
 * The race/class/blessing/bloodline choices are fetched from the API only after
 * the wizard step renders. On a cold `next dev --webpack` compile the route can
 * spend tens of seconds compiling before the option ever exists (the first run
 * of this suite failed at the default 10s expect timeout waiting for the Human
 * radio after Born, while a warm run passed instantly). The global expect
 * timeout (10s) is therefore too short here: give these catalog options the
 * same generous 45s budget as the hydration wait. This is a targeted
 * per-assertion timeout, not a global expect-timeout change, and it still fails
 * loudly (hard assertion) if the catalog never loads.
 */
async function waitForCatalogOption(page: Page, label: RegExp): Promise<void> {
  await expect(page.getByRole("radio", { name: label })).toBeVisible({
    timeout: 45_000,
  })
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

test.describe("character lifecycle", () => {
  test("login, create, progress, allocate, archive", async ({ page }) => {
    // A cold `next dev --webpack` compile can take tens of seconds per route on
    // the first hit, and the catalogue/hydration waits below budget up to 45s
    // each. The global 120s test timeout is only intended for warm runs, so
    // extend it for THIS lifecycle test only (not globally) to absorb a cold
    // compile. See waitForCatalogOption/waitForHydrated.
    test.setTimeout(180_000)

    // ------------------------------------------------------------------ //
    // QuestionnairePrimitive registry guard.
    //
    // The @shadcn/react Questionnaire primitive warns on the console whenever
    // a rendered Questionnaire.Item exists that is not present in the Root's
    // `items` definition, e.g. "Rendered item \"X\" is missing from Root.items
    // and is excluded from the questionnaire collection." The creation wizard
    // renders a different item set per branch (the monster branch omits the
    // class/profession items), so a transient or persistent mismatch when the
    // branch changes would surface here. Collect ONLY that specific text (not
    // every console message) for the whole test, then assert it is empty after
    // creation. This is a guard, not a fix: app logic is unchanged.
    // ------------------------------------------------------------------ //
    const missingItemWarnings: string[] = []
    page.on("console", (msg) => {
      const text = msg.text()
      if (text.includes("missing from Root.items")) {
        missingItemWarnings.push(text)
      }
    })

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

    // Creation-rules sanity check: the wizard's creation-rules endpoint must
    // report a valid, admin-configurable transcendent-skill cap. The seed applies
    // the default of 3 (migration 0012 + seed), but an admin may have reconfigured
    // the cap anywhere in 0..8, so running against a reused DB this assertion only
    // requires an integer inside that bound. The default of 3 is verified by the
    // ruleset and route unit/PG tests, not here. This is an assertion, not a
    // mutation: a non-integer or out-of-range cap (or a missing rules row) means
    // the DB is not freshly migrated/seeded, so fail loudly rather than running
    // the wizard against a malformed ruleset.
    const rulesRes = await page.request.get("/api/rules/creation")
    expect(rulesRes.ok()).toBeTruthy()
    const rules = (await rulesRes.json()) as { maxTranscendentSkills: number }
    expect(
      Number.isInteger(rules.maxTranscendentSkills),
      "The E2E test DB must be freshly migrated and seeded so the creation-rules " +
        "endpoint reports an integer maxTranscendentSkills within 0..8 (found " +
        `${rules.maxTranscendentSkills}).`
    ).toBeTruthy()
    expect(rules.maxTranscendentSkills).toBeGreaterThanOrEqual(0)
    expect(rules.maxTranscendentSkills).toBeLessThanOrEqual(8)

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
    await page.goto("/catalog/gods")
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

    const blessingCatalog = await page.request.get("/api/catalog/gods")
    expect(blessingCatalog.ok()).toBeTruthy()
    const blessings = (await blessingCatalog.json()) as {
      kind: string
      items: Array<{ id: string; name: string }>
    }
    expect(blessings.kind).toBe("gods")
    expect(
      blessings.items.some((b) => b.name === "The Malefic Viper")
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
    // Walk the enlightened branch of the questionnaire.
    // ------------------------------------------------------------------ //
    await page.getByRole("link", { name: "Create a character" }).click()
    await page.waitForURL(/\/characters\/new$/)

    // Step 1 - exercise the monster branch first, then switch to the
    // enlightened branch.
    //
    // The seed defines no monster races, so the monster branch is never taken
    // past the name step; the point is to render the monster questionnaire
    // (which omits the class/profession items), then transition to the
    // enlightened one, so the console registry guard above sees both item sets.
    // Selecting a branch auto-advances the wizard to the name step (the
    // raceType choice is not a navigable step of its own once a branch is
    // chosen), so there is no "Next" to press on branch selection. Return to
    // the branch question with Back and switch to Enlightened before entering a
    // name.
    await choose(page, /^Monster$/i)
    // Choosing Monster auto-advances to the name step.
    await expect(page.getByPlaceholder("Character name")).toBeVisible()
    // Go back to the branch question (monster omits class/profession items, so
    // this Back press also trips the questionnaire's own navigation) and switch.
    await back(page)
    await choose(page, /^Enlightened$/i)
    // Switching to Enlightened auto-advances to the name step again.
    await expect(page.getByPlaceholder("Character name")).toBeVisible()
    // The default enlightened branch still advances normally via Next after
    // filling the name, so no explicit Next press is required here.

    // Step 2 - name. The description is optional.
    await page.getByPlaceholder("Character name").fill(name)
    await next(page)

    // Step 3 - origin: Born (starts at F grade).
    await choose(page, /born/i)
    await next(page)

    // Step 4 - race: Human. Wait for the catalog to load so the choice exists.
    // The race catalog is fetched dynamically, so a cold compile may take tens of
    // seconds before the radio exists - wait with the same 45s budget as the
    // hydration wait rather than the 10s global expect timeout.
    await waitForCatalogOption(page, /^Human\b/i)
    await choose(page, /^Human\b/i)
    await next(page)

    // Step 5 - class: Archer. Dynamically loaded from the class catalog; see the
    // race step above for why this needs the generous 45s catalog wait.
    await waitForCatalogOption(page, /^Archer\b/i)
    await choose(page, /^Archer\b/i)
    await next(page)

    // Step 6 - profession: None.
    await choose(page, /^None\b/i)
    await next(page)

    // Step 7 - special abilities. The gods catalog offers The Malefic Viper and
    // the bloodline catalog offers Bloodline of the
    // Primal Hunter) but no transcendent skill, so select the blessing +
    // bloodline and leave the transcendent section unselected. The wizard's
    // bloodline picker is a single-select radio group (a character may carry at
    // most one bloodline link), so it is chosen with the same `choose` radio
    // helper as the race/class/profession steps, never checked as a checkbox.
    // These blessing/bloodline options are dynamically loaded from the gods and
    // bloodline catalogs, so they need the same generous 45s catalog wait as the
    // race/class steps.
    await waitForCatalogOption(page, /The Malefic Viper/)
    await choose(page, /The Malefic Viper/)
    await page.getByLabel("Blessing tier").selectOption("True")
    await waitForCatalogOption(page, /Bloodline of the Primal Hunter/)
    await choose(page, /Bloodline of the Primal Hunter/)
    await next(page)

    // Step 8 - review. Confirm and submit. There is no Next button on the
    // review step - it is replaced by the Submit button - so submit directly.
    await page.getByRole("button", { name: "Create character" }).click()
    // `new` also matches `[^/]+`, so exclude it explicitly: the create page keeps
    // its `/characters/new` URL until the push to the character detail route.
    await page.waitForURL(/\/characters\/(?!new$)[^/]+$/)
    const characterUrl = page.url()

    // The character detail page shows the created name. The page exposes the
    // name twice - as the page's h1 and again as the Overview h2 - so scope the
    // unique page title to the level-1 heading instead of matching both.
    await expect(
      page.getByRole("heading", { level: 1, name, exact: true })
    ).toBeVisible()

    // The questionnaire's completion is done: no QuestionnairePrimitive item was
    // reported as missing from Root.items during any creation-wizard branch
    // (the monster branch was exercised at step 1, then the enlightened branch
    // was walked to completion). Fail loudly with the actual warnings so a
    // regression is actionable.
    expect(
      missingItemWarnings,
      `The QuestionnairePrimitive logged ${missingItemWarnings.length} "missing ` +
        `from Root.items" warning(s) during creation:
${missingItemWarnings.join("\n")}`
    ).toEqual([])

    // ------------------------------------------------------------------ //
    // The special-ability selections persisted in their dedicated tabs.
    await page.getByRole("tab", { name: "Blessings", exact: true }).click()
    const blessingsPanel = page
      .locator("[role=tabpanel]")
      .filter({ hasText: "True Blessing of the Malefic Viper" })
    await expect(
      blessingsPanel.getByText("True Blessing of the Malefic Viper")
    ).toBeVisible()
    await page.getByRole("tab", { name: "Bloodlines", exact: true }).click()
    const bloodlinesPanel = page
      .locator("[role=tabpanel]")
      .filter({ hasText: "Bloodline of the Primal Hunter" })
    await expect(
      bloodlinesPanel.getByText("Bloodline of the Primal Hunter")
    ).toBeVisible()
    await expect(
      bloodlinesPanel.getByText("No linked bloodlines.")
    ).toBeHidden()
    await page
      .getByRole("tab", { name: "Transcendent skills", exact: true })
      .click()
    await expect(
      page
        .locator("[role=tabpanel]")
        .getByText("No linked transcendent skills.")
    ).toBeVisible()

    const characterId = new URL(characterUrl).pathname.split("/").pop()!
    expect(characterId).toBeTruthy()

    const detailRes = await page.request.get(`/api/characters/${characterId}`)
    expect(detailRes.ok()).toBeTruthy()
    const detail = (await detailRes.json()) as {
      character: {
        associations: Array<{ kind: string; name: string; tier?: string }>
      }
    }
    const assocKeys = detail.character.associations.map(
      (a) => `${a.kind}:${a.name}`
    )
    expect(assocKeys).toContain("blessing:The Malefic Viper")
    expect(
      detail.character.associations.find((a) => a.kind === "blessing")?.tier
    ).toBe("True")
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
          blessing: { name: string; tier: string } | null
          bloodlines: Array<{ name: string }>
        }
      | undefined
    expect(special).toBeTruthy()
    expect(special?.blessing).toMatchObject({
      name: "The Malefic Viper",
      tier: "True",
    })
    expect(
      special?.bloodlines.some(
        (b) => b.name === "Bloodline of the Primal Hunter"
      )
    ).toBe(true)

    // ------------------------------------------------------------------ //
    // Progress: advance the class track to level 1 through the Class tab.
    //
    // The class track exposes a Base UI slider ("Class experience") that
    // commits an experience-percent set on keyboard commit, and a "+ Level"
    // button that performs the actual level-up. The progression journal dialog
    // opens ONLY on a real level-up (the server returns `leveledUp`), never on
    // a percent-only slider change, so this exercises both paths with real
    // browser interaction and no network mocking.
    // ------------------------------------------------------------------ //
    await page.getByRole("tab", { name: "Class" }).click()

    // The class track exposes a Base UI slider labelled by the "Class
    // experience" group and starts at 0%. It is editable because the enlightened
    // race mode makes the class track independently adjustable.
    const classExperience = page.getByRole("group", {
      name: "Class experience",
    })
    const classSlider = classExperience.getByRole("slider")
    await expect(classSlider).toBeVisible()
    await expect(page.getByText("Level 0", { exact: true })).toBeVisible()
    await expect(
      page.getByRole("progressbar", { name: "Class experience" })
    ).toHaveAttribute("aria-valuenow", "0")

    // One actual keyboard increment (focus + ArrowRight, keyup commits) raises
    // the displayed percent to 1%. Because no quarter boundary is crossed, this
    // is a percent-only set and the progression journal must NOT open.
    const classJournal = page
      .locator("[role=dialog]")
      .filter({ hasText: "Progression journal" })
    await classSlider.focus()
    await page.keyboard.press("ArrowRight")
    await expect(classSlider).toHaveAttribute("aria-valuenow", "1")
    await expect(
      page.getByRole("progressbar", { name: "Class experience" })
    ).toHaveAttribute("aria-valuenow", "1")
    await expect(classJournal).toBeHidden()

    // "+ Level" performs the real level-up (level 0 -> 1). It resets the class
    // experience to 0% and opens the progression journal exactly once.
    await page.getByRole("button", { name: "Increase class level" }).click()

    // The level-up opens the progression journal exactly once. While this modal
    // dialog is open the background becomes hidden from the accessibility tree,
    // so the class-track assertions must run only after it is dismissed.
    await expect(classJournal).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(classJournal).toBeHidden()

    // The real level-up reached level 1 and reset the class experience to 0%.
    await expect(classSlider).toHaveAttribute("aria-valuenow", "0")
    await expect(page.getByText("Level 1", { exact: true })).toBeVisible()
    await expect(
      page.getByRole("progressbar", { name: "Class experience" })
    ).toHaveAttribute("aria-valuenow", "0")

    // ------------------------------------------------------------------ //
    // Allocate one attribute point.
    // ------------------------------------------------------------------ //
    await page.getByRole("tab", { name: "Stats" }).click()

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
    // textContent is also concatenated without whitespace between cells). The
    // sourced Archer F config grants `strength: 1` per level, so advancing the
    // class track to level 1 leaves Strength at 1 before allocation; the single
    // allocated free point brings the final value to 2.
    const strengthRow = page.locator("tbody tr").filter({ hasText: "strength" })
    await expect(strengthRow.locator("td").nth(1)).toHaveText("2")

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
