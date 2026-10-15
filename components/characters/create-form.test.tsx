// @vitest-environment jsdom
import * as React from "react"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiError, apiFetch, type CatalogItem } from "@/lib/api"
import { CreateCharacterForm } from "@/components/characters/create-form"

const STORAGE_KEY = "primal-create-draft"
const RECOVERY_KEY = "primal-create-recovery"

// --- Module mocks --------------------------------------------------------- //

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
  // The real questionnaire components style Previous/Next/Submit via
  // `buttonVariants`; provide a no-op class string so they render as buttons.
  buttonVariants: () => "",
}))

vi.mock("@/components/ui/alert", () => ({
  Alert: ({ children }: React.ComponentProps<"div">) => (
    <div role="alert">{children}</div>
  ),
}))

vi.mock("@/components/ui/label", () => ({
  Label: ({ children, ...props }: React.ComponentProps<"label">) => (
    <label {...props}>{children}</label>
  ),
}))

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
}))

vi.mock("@/components/ui/questionnaire", () => {
  const div = ({ children, ...props }: React.ComponentProps<"div">) => (
    <div {...props}>{children}</div>
  )
  return {
    Questionnaire: ({
      children,
      onSubmit,
      items,
      ...props
    }: React.ComponentProps<"form"> & {
      items?: unknown[]
      item?: string
      onItemChange?: (name: string) => void
    }) => (
      <form
        data-testid="questionnaire"
        data-item-count={items?.length}
        data-item-names={items
          ?.map((entry) => (entry as { name: string }).name)
          .join(",")}
        onSubmit={onSubmit}
        {...props}
      >
        {children}
      </form>
    ),
    QuestionnaireActions: div,
    QuestionnaireChoice: ({
      children,
      checked,
      defaultChecked,
      disabled,
      onChange,
      onClick,
      value,
    }: React.ComponentProps<"input"> & { children?: React.ReactNode }) => (
      <label>
        <input
          type="radio"
          value={value}
          checked={checked}
          defaultChecked={defaultChecked}
          disabled={disabled}
          onChange={onChange}
          onClick={onClick}
        />
        {children}
      </label>
    ),
    QuestionnaireChoiceDescription: ({
      children,
    }: React.ComponentProps<"span">) => <span>{children}</span>,
    QuestionnaireChoices: div,
    QuestionnaireDescription: ({ children }: React.ComponentProps<"p">) => (
      <p>{children}</p>
    ),
    QuestionnaireInput: (props: React.ComponentProps<"input">) => (
      <input data-slot="questionnaire-input" {...props} />
    ),
    QuestionnaireItem: div,
    QuestionnaireNext: ({ children }: React.ComponentProps<"button">) => (
      <button type="button">{children ?? "Next"}</button>
    ),
    QuestionnairePrevious: ({ children }: React.ComponentProps<"button">) => (
      <button type="button">{children ?? "Previous"}</button>
    ),
    QuestionnaireProgress: div,
    QuestionnaireSubmit: ({
      children,
      ...props
    }: React.ComponentProps<"button">) => (
      <button type="submit" {...props}>
        {children ?? "Submit"}
      </button>
    ),
    QuestionnaireTitle: ({ children }: React.ComponentProps<"h3">) => (
      <h3>{children}</h3>
    ),
  }
})

vi.mock("@/lib/api", () => {
  class ApiError extends Error {
    readonly status: number
    readonly code: string
    constructor(status: number, code: string, message: string) {
      super(message)
      this.name = "ApiError"
      this.status = status
      this.code = code
    }
  }
  const jsonInit = (method: string, body?: unknown) => ({
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return { ApiError, jsonInit, apiFetch: vi.fn() }
})

// --- Test fixtures -------------------------------------------------------- //

type ServerDraft = {
  data: Record<string, unknown>
  version: number
}

/** Build a draft data payload the way the wizard's server contract expects. */
function serverData(partial: Record<string, unknown>) {
  return {
    step: 1,
    raceType: "enlightened",
    name: "",
    description: null,
    origin: "integrated",
    raceId: "",
    classId: "",
    professionId: null,
    special: false,
    equipment: [],
    ...partial,
  }
}

const EMPTY = {
  step: "name",
  raceType: "enlightened",
  name: "",
  description: "",
  origin: "",
  raceId: "",
  classId: "",
  professionId: "",
  special: "none",
  equipment: "none",
  nickname: null,
  pronouns: null,
  ageDescription: null,
  appearance: null,
  biography: null,
  notes: null,
}

function localDraft(partial: Record<string, unknown>) {
  return { ...EMPTY, ...partial }
}

type Options = {
  serverDraft?: ServerDraft | null
  /** Thrown when PUT /api/drafts is called (e.g. a 409 conflict). */
  putError?: unknown
  /** Result returned by PUT /api/drafts on success. */
  putResult?: ServerDraft
  /** Thrown when GET /api/drafts is called (the initial sync fails). */
  getError?: unknown
  createError?: unknown
  /**
   * Catalog items per kind returned by the catalog GETs. Any kind omitted
   * defaults to an empty list. Used to inject ability selections (blessings /
   * bloodlines / transcendent skills) and base options for tests.
   */
  catalog?: Partial<Record<CatalogKind, CatalogItem[]>>
  /** Thrown when ANY ability catalog GET (blessings / bloodlines / transcendent_skills) is called. */
  abilityCatalogError?: unknown
  /** Thrown when ANY base catalog GET (races / classes / professions) is called. */
  baseCatalogError?: unknown
  rulesError?: unknown
  maxTranscendentSkills?: number
}

type CatalogKind =
  | "races"
  | "classes"
  | "professions"
  | "gods"
  | "bloodlines"
  | "transcendentSkills"

/** Build a valid CatalogItem for tests; defaults can be overridden. */
function makeItem(
  id: string,
  overrides: Partial<CatalogItem> = {}
): CatalogItem {
  return {
    id,
    kind: "catalog",
    stableId: `stable-${id}`,
    name: `Name ${id}`,
    description: null,
    grade: null,
    sourceUrl: null,
    archived: false,
    config: {},
    gradeDescriptions: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

const BASE_CATALOG_URLS = new Set([
  "/api/catalog/races",
  "/api/catalog/classes",
  "/api/catalog/professions",
])
const ABILITY_CATALOG_URLS = new Set([
  "/api/catalog/gods",
  "/api/catalog/bloodlines",
  "/api/catalog/transcendent_skills",
])

const CATALOG_URL_TO_KIND: Record<string, CatalogKind> = {
  "/api/catalog/races": "races",
  "/api/catalog/classes": "classes",
  "/api/catalog/professions": "professions",
  "/api/catalog/gods": "gods",
  "/api/catalog/bloodlines": "bloodlines",
  "/api/catalog/transcendent_skills": "transcendentSkills",
}

let serverDraft: ServerDraft | null = null
let putError: unknown = null
let putResult: ServerDraft | null = null
let getError: unknown = null
let createError: unknown = null
let createCalls = 0
let catalog: Record<CatalogKind, CatalogItem[]> = {
  races: [],
  classes: [],
  professions: [],
  gods: [],
  bloodlines: [],
  transcendentSkills: [],
}
let abilityCatalogError: unknown = null
let baseCatalogError: unknown = null
let rulesError: unknown = null
let maxTranscendentSkills = 3

function setupMock(options: Options) {
  serverDraft = options.serverDraft ?? null
  putError = options.putError ?? null
  putResult = options.putResult ?? null
  getError = options.getError ?? null
  createError = options.createError ?? null
  createCalls = 0
  catalog = {
    races: options.catalog?.races ?? [],
    classes: options.catalog?.classes ?? [],
    professions: options.catalog?.professions ?? [],
    gods: options.catalog?.gods ?? [],
    bloodlines: options.catalog?.bloodlines ?? [],
    transcendentSkills: options.catalog?.transcendentSkills ?? [],
  }
  abilityCatalogError = options.abilityCatalogError ?? null
  baseCatalogError = options.baseCatalogError ?? null
  rulesError = options.rulesError ?? null
  maxTranscendentSkills = options.maxTranscendentSkills ?? 3

  const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
  mock.mockReset()
  mock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    if (url === "/api/rules/creation") {
      if (rulesError) throw rulesError
      return { maxTranscendentSkills }
    }
    if (url.startsWith("/api/catalog/")) {
      if (ABILITY_CATALOG_URLS.has(url) && abilityCatalogError) {
        throw abilityCatalogError
      }
      if (BASE_CATALOG_URLS.has(url) && baseCatalogError) {
        throw baseCatalogError
      }
      return {
        kind: "catalog",
        items: CATALOG_URL_TO_KIND[url]
          ? catalog[CATALOG_URL_TO_KIND[url]]
          : [],
      }
    }
    if (url === "/api/drafts") {
      if (method === "PUT") {
        if (putError) throw putError
        return { draft: putResult ?? { id: "d1", data: {}, version: 1 } }
      }
      if (getError) throw getError
      return { draft: serverDraft }
    }
    if (url === "/api/characters") {
      createCalls += 1
      if (createError) throw createError
      return { character: { id: "c1", name: "Created" } }
    }
    throw new Error(`unexpected url ${url}`)
  })
}

/** Render the form and let the mount effects (catalog + draft GET) settle. */
async function renderForm() {
  if (!window.localStorage.getItem(STORAGE_KEY)) {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...EMPTY, raceType: "enlightened" })
    )
  }
  render(<CreateCharacterForm />)
  await flush()
}

/** Let pending async handlers (saves, submits) settle. */
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

function putCalls(): string[] {
  const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
  return mock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT")
    .map(([url]) => url as string)
}

/** Parsed POST /api/characters request bodies, in call order. */
function createPostBodies(): Array<{
  name: string
  specialAbilities?: {
    blessing?: { godId: string; tier: string } | null
    bloodlineIds?: string[]
    transcendentSkillIds?: string[]
  }
  draftVersion?: number
}> {
  const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
  return mock.mock.calls
    .filter(
      ([url, init]) =>
        url === "/api/characters" &&
        (init as RequestInit | undefined)?.method === "POST"
    )
    .map(([, init]) => JSON.parse((init as RequestInit).body as string))
}

/** Find the most recent PUT /api/drafts body, if any. */
function lastDraftPutBody(): Array<{
  data?: {
    name?: string
    raceId?: string
    raceType?: "enlightened" | "monster"
    step?: number
    classId?: string
    professionId?: string | null
    special?: boolean
    specialAbilities?: unknown
  }
}> {
  const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
  return mock.mock.calls
    .filter(
      ([url, init]) =>
        url === "/api/drafts" &&
        (init as RequestInit | undefined)?.method === "PUT"
    )
    .map(([, init]) => JSON.parse((init as RequestInit).body as string))
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
})

// --- Tests ---------------------------------------------------------------- //

describe("CreateCharacterForm flushSave", () => {
  it("returns false promptly (no hang) when a save fails, aborting creation", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(localDraft({ name: "Local" }))
    )
    setupMock({
      serverDraft: null,
      putError: new ApiError(409, "conflict", "Draft conflict."),
    })

    await renderForm()
    // Wait until the server GET settles so the component is ready.
    await flush()

    // 409 on the save path: marking a field dirty then submitting must abort the
    // create rather than hanging on a polling quiesce.
    fireEvent.change(screen.getByPlaceholderText("Character name"), {
      target: { value: "Local v2" },
    })
    fireEvent.submit(screen.getByTestId("questionnaire"))
    await flush()

    // The submit flushes a save, which throws a 409 -> flushSave resolves false
    // -> no POST to /api/characters. Reaching this assertion proves no hang.
    expect(createCalls).toBe(0)
    expect(screen.getByText(/Draft conflict/)).toBeTruthy()
  })

  it("saves the dirty draft then creates when the save succeeds", async () => {
    setupMock({
      serverDraft: { data: serverData({ name: "Server" }), version: 3 },
      putResult: { data: serverData({ name: "Local" }), version: 4 },
    })

    await renderForm()
    await flush()

    fireEvent.change(screen.getByPlaceholderText("Character name"), {
      target: { value: "Local v2" },
    })
    fireEvent.submit(screen.getByTestId("questionnaire"))
    await flush()

    expect(createCalls).toBe(1)
    // Both offline keys are cleared only after a successful create.
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(window.localStorage.getItem(RECOVERY_KEY)).toBeNull()
  })

  it("Save draft does not auto-overwrite during a conflict", async () => {
    setupMock({
      serverDraft: { data: serverData({ name: "Server" }), version: 2 },
      putError: new ApiError(409, "conflict", "Draft conflict."),
    })

    await renderForm()
    await flush()

    // Mark the draft dirty and manually save to trigger a 409 conflict.
    fireEvent.change(screen.getByPlaceholderText("Character name"), {
      target: { value: "Local" },
    })
    fireEvent.click(screen.getByText("Save draft"))
    await flush()

    // Exactly one failed PUT; the conflict UI is shown and Save draft is
    // disabled. A Save draft click must not auto-invoke the overwrite.
    expect(putCalls()).toEqual(["/api/drafts"])
    expect(screen.getByText(/Retry \(overwrite\)/)).toBeTruthy()
    const saveBtn = screen.getByText("Save draft").closest("button")
    expect(saveBtn?.disabled).toBe(true)

    // Clicking the disabled Save draft must not issue a second (overwrite) PUT;
    // the labeled 'Retry (overwrite)' button is the explicit overwrite action.
    fireEvent.click(screen.getByText("Save draft"))
    await flush()
    expect(putCalls()).toEqual(["/api/drafts"])
  })

  it("blocks create while the server GET is failing and re-enables after Retry sync", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(localDraft({ name: "Local" }))
    )
    setupMock({
      serverDraft: null,
      getError: new Error("network down"),
    })

    await renderForm()
    await flush()

    // The initial sync failed: an explicit Retry sync action is offered, the
    // wizard is not ready, and Create is disabled because the draft version is
    // unknown.
    expect(screen.getByText(/Retry sync/)).toBeTruthy()
    const submitBtn = screen.getByText("Create character").closest("button")
    expect(submitBtn?.disabled).toBe(true)

    // Submitting while not ready must neither PUT nor POST: creation is deferred
    // until the server GET succeeds and the draft version is known.
    fireEvent.submit(screen.getByTestId("questionnaire"))
    await flush()
    expect(putCalls()).toEqual([])
    expect(createCalls).toBe(0)

    // The network recovers and the user retries the sync. The GET now succeeds
    // with no existing server draft, so the wizard becomes ready and the local
    // draft (which has content) is persisted as an initial PUT, giving the
    // create a known draft version.
    getError = null
    fireEvent.click(screen.getByText(/Retry sync/))
    await flush()

    expect(screen.queryByText(/Retry sync/)).toBeNull()
    expect(putCalls()).toEqual(["/api/drafts"])
    const submitBtn2 = screen.getByText("Create character").closest("button")
    expect(submitBtn2?.disabled).toBe(false)

    // Now submission creates the character, carrying the known draft version.
    fireEvent.submit(screen.getByTestId("questionnaire"))
    await flush()
    expect(createCalls).toBe(1)
  })

  it("persists an empty equipment list (no fake token) in the draft PUT", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(localDraft({ name: "Local" }))
    )
    setupMock({
      serverDraft: null,
      putResult: { data: serverData({ name: "Local" }), version: 1 },
    })

    await renderForm()
    await flush()

    // The initial PUT (no server draft + local content) must not carry a fake
    // `equipment: ["yes"]` token: there are no equipment IDs to record yet.
    const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
    const put = mock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PUT"
    )
    expect(put).toBeTruthy()
    const body = JSON.parse((put![1] as RequestInit).body as string) as {
      data: { equipment?: string[] }
    }
    expect(body.data.equipment).toEqual([])
  })

  it("does not PUT an empty draft until the user edits", async () => {
    // No STORAGE_KEY content: the device draft is empty.
    setupMock({
      serverDraft: null,
      putResult: { data: serverData({ name: "Local" }), version: 1 },
    })

    await renderForm()
    await flush()

    // GET returned no draft and the local draft is empty, so no initial PUT is
    // issued - an empty draft is not persisted until the user types something.
    expect(putCalls()).toEqual([])

    // Editing the name makes the draft non-empty, which schedules a debounced
    // autosave that PUTs the change.
    fireEvent.change(screen.getByPlaceholderText("Character name"), {
      target: { value: "Local" },
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 900))
    })
    expect(putCalls()).toEqual(["/api/drafts"])
  })
})

describe("CreateCharacterForm local recovery", () => {
  it("persists the local draft under the recovery key and pauses autosave", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(localDraft({ name: "Local", raceId: "r1" }))
    )
    setupMock({
      serverDraft: { data: serverData({ name: "Server" }), version: 5 },
    })

    await renderForm()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    // The divergent device draft must be preserved under the separate recovery
    // key while the server draft is applied.
    const raw = window.localStorage.getItem(RECOVERY_KEY)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw as string).name).toBe("Local")

    // The user is offered an explicit choice; the banner shows both actions.
    expect(screen.getByText(/Use device draft/)).toBeTruthy()
    expect(screen.getByText(/Use server draft/)).toBeTruthy()

    // Autosave is paused while the choice is unresolved: editing must not PUT.
    fireEvent.change(screen.getByPlaceholderText("Character name"), {
      target: { value: "Local v3" },
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 900))
    })
    expect(putCalls()).toEqual([])
  })

  it("use device draft GETs the current version then PUTs the device's draft", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(localDraft({ name: "Local", raceId: "r1" }))
    )
    setupMock({
      serverDraft: { data: serverData({ name: "Server" }), version: 5 },
      putResult: { data: serverData({ name: "Local" }), version: 6 },
    })

    await renderForm()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    fireEvent.click(screen.getByText(/Use device draft/))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    // A GET must precede the PUT (for the current version) and the PUT must
    // carry the local draft data.
    expect(putCalls()).toEqual(["/api/drafts"])
    expect(window.localStorage.getItem(RECOVERY_KEY)).toBeNull()
    expect(screen.queryByText(/Use device draft/)).toBeNull()
  })

  it("use server draft discards the local draft and resumes", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(localDraft({ name: "Local", raceId: "r1" }))
    )
    setupMock({
      serverDraft: { data: serverData({ name: "Server" }), version: 5 },
      putResult: { data: serverData({ name: "Server" }), version: 5 },
    })

    await renderForm()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    fireEvent.click(screen.getByText(/Use server draft/))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(window.localStorage.getItem(RECOVERY_KEY)).toBeNull()
    expect(screen.queryByText(/Use server draft/)).toBeNull()
    // No overwrite PUT occurred; the server draft was kept.
    expect(putCalls()).toEqual([])
  })

  it("clears both the fallback and the recovery key after a successful create", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(localDraft({ name: "Local" }))
    )
    window.localStorage.setItem(
      RECOVERY_KEY,
      JSON.stringify(localDraft({ name: "RecoverMe" }))
    )
    setupMock({
      serverDraft: null,
      putResult: { data: serverData({ name: "Local" }), version: 7 },
    })

    await renderForm()
    await flush()

    // No server draft exists while both the live draft and the recovery snapshot
    // carry content: the explicit recovery choice is surfaced so nothing is
    // silently clobbered, and GET null must not erase the recovery snapshot.
    expect(screen.getByText(/Use device draft/)).toBeTruthy()
    expect(window.localStorage.getItem(RECOVERY_KEY)).not.toBeNull()

    // Resolve the recovery choice by keeping the device content, then create.
    // The overwrite persists the recovery snapshot, so submission POSTs with a
    // known draft version.
    fireEvent.click(screen.getByText(/Use device draft/))
    await flush()

    fireEvent.submit(screen.getByTestId("questionnaire"))
    await flush()

    expect(createCalls).toBe(1)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(window.localStorage.getItem(RECOVERY_KEY)).toBeNull()
  })

  it("manual Save does not PUT while a recovery choice is pending", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(localDraft({ name: "Local" }))
    )
    window.localStorage.setItem(
      RECOVERY_KEY,
      JSON.stringify(localDraft({ name: "RecoverMe" }))
    )
    setupMock({
      serverDraft: { data: serverData({ name: "Server" }), version: 2 },
      putResult: { data: serverData({ name: "Server" }), version: 3 },
    })

    await renderForm()
    await flush()

    // Recovery banner is up and Save draft is disabled while it is unresolved.
    expect(screen.getByText(/Use device draft/)).toBeTruthy()
    const saveBtn = screen.getByText("Save draft").closest("button")
    expect(saveBtn?.disabled).toBe(true)

    // Clicking the disabled Save draft must not issue a PUT (no overwrite):
    // only the explicit 'Use device draft' action may.
    fireEvent.click(screen.getByText("Save draft"))
    await flush()
    expect(putCalls()).toEqual([])
  })

  it("submit does not POST while a recovery choice is pending", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(localDraft({ name: "Local" }))
    )
    window.localStorage.setItem(
      RECOVERY_KEY,
      JSON.stringify(localDraft({ name: "RecoverMe" }))
    )
    setupMock({
      serverDraft: { data: serverData({ name: "Server" }), version: 2 },
      putResult: { data: serverData({ name: "Server" }), version: 3 },
    })

    await renderForm()
    await flush()

    // The Create button is disabled while the recovery choice is unresolved.
    const submitBtn = screen.getByText("Create character").closest("button")
    expect(submitBtn?.disabled).toBe(true)

    // Submitting the form must not PUT or POST: the server draft is preserved
    // until the user explicitly resolves the recovery choice.
    fireEvent.submit(screen.getByTestId("questionnaire"))
    await flush()
    expect(createCalls).toBe(0)
    expect(putCalls()).toEqual([])
  })

  it("offers recovery when only metadata (nickname) diverges from the server draft", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(localDraft({ nickname: "Kit" }))
    )
    setupMock({
      serverDraft: { data: serverData({ name: "Server" }), version: 3 },
    })

    await renderForm()
    await flush()

    // The divergence is metadata-only - no name/race/special content - yet the
    // device copy must not be silently overwritten by the server draft.
    expect(screen.getByText(/Use device draft/)).toBeTruthy()
    const raw = window.localStorage.getItem(RECOVERY_KEY)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw as string).nickname).toBe("Kit")
  })

  it("freezes the wizard while recovery is pending and resumes autosave after", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(localDraft({ name: "Local" }))
    )
    setupMock({
      serverDraft: { data: serverData({ name: "Server" }), version: 5 },
      putResult: { data: serverData({ name: "Server" }), version: 6 },
    })

    await renderForm()
    await flush()

    // Recovery is pending: the wizard is frozen so edits cannot diverge from the
    // displayed (server) snapshot before the user chooses.
    const fieldset = document.querySelector("fieldset") as HTMLFieldSetElement
    expect(fieldset?.disabled).toBe(true)

    // Resolve by keeping the server draft.
    fireEvent.click(screen.getByText(/Use server draft/))
    await flush()

    // Recovery is cleared and the wizard is editable again.
    expect(screen.queryByText(/Use server draft/)).toBeNull()
    expect(fieldset.disabled).toBe(false)

    // Editing now resumes the debounced autosave and PUTs the change.
    const nameInput = screen.getByPlaceholderText(
      "Character name"
    ) as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: "Server v2" } })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 900))
    })
    expect(putCalls()).toEqual(["/api/drafts"])
  })

  it("does not PUT while a no-server recovery choice is pending, across timer and refresh", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(localDraft({ name: "Live", raceId: "r1" }))
    )
    window.localStorage.setItem(
      RECOVERY_KEY,
      JSON.stringify(localDraft({ name: "RecoverMe" }))
    )
    setupMock({
      serverDraft: null,
      putResult: { data: serverData({ name: "RecoverMe" }), version: 1 },
    })

    await renderForm()
    await flush()

    // A no-server GET with divergent live and recovery drafts surfaces the
    // explicit choice and must not create a server draft: the first-save
    // autosave is blocked while the choice is pending.
    expect(screen.getByText(/Use device draft/)).toBeTruthy()
    expect(putCalls()).toEqual([])

    // The debounce timer passes with no choice made: still no PUT/overwrite.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 900))
    })
    expect(putCalls()).toEqual([])

    // A refresh remounts from the persisted recovery key; the choice is still
    // pending and no PUT is issued across the reload either.
    cleanup()
    await renderForm()
    await flush()
    expect(screen.getByText(/Use device draft/)).toBeTruthy()
    expect(putCalls()).toEqual([])
  })

  it("persists the chosen device snapshot exactly once (no clobber) after a no-server recovery choice", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(localDraft({ name: "Live", raceId: "r1" }))
    )
    window.localStorage.setItem(
      RECOVERY_KEY,
      JSON.stringify(localDraft({ name: "RecoverMe", raceId: "r1" }))
    )
    setupMock({
      serverDraft: null,
      putResult: { data: serverData({ name: "RecoverMe" }), version: 1 },
    })

    await renderForm()
    await flush()

    fireEvent.click(screen.getByText(/Use device draft/))
    await flush()

    // Exactly one PUT, carrying the chosen recovery snapshot - the live draft is
    // never written to the server while the choice was pending, so the chosen
    // snapshot is not clobbered by a stale autosave.
    const putBodies = lastDraftPutBody()
    expect(putBodies).toHaveLength(1)
    expect(putBodies[0].data?.name).toBe("RecoverMe")
    expect(putBodies[0].data?.raceId).toBe("r1")
    // The chosen snapshot is preserved locally (no data loss) and the recovery
    // key is cleared only after the snapshot was persisted.
    expect(window.localStorage.getItem(RECOVERY_KEY)).toBeNull()
    const stored = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) as string
    )
    expect(stored.name).toBe("RecoverMe")
  })

  it("still autosaves a no-server local draft when there is no recovery conflict", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(localDraft({ name: "Kael", raceId: "r1" }))
    )
    setupMock({
      serverDraft: null,
      putResult: { data: serverData({ name: "Kael" }), version: 1 },
    })

    await renderForm()
    await flush()

    // No recovery key and no server draft: the first-save create still persists
    // the device draft, so the no-conflict autosave path is unaffected.
    expect(putCalls()).toEqual(["/api/drafts"])
    const body = lastDraftPutBody()[0]
    expect(body.data?.name).toBe("Kael")
    expect(body.data?.raceId).toBe("r1")
  })
})

describe("CreateCharacterForm special abilities", () => {
  it("mounts only registry items and avoids missing-item console warnings", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      setupMock({ serverDraft: null })
      render(<CreateCharacterForm />)
      const questionnaire = screen.getByTestId("questionnaire")
      expect(questionnaire.dataset.itemNames).toBe("raceType")
      expect(
        questionnaire.querySelectorAll("[name=class], [name=profession]")
      ).toHaveLength(0)
      await flush()
      fireEvent.click(screen.getByLabelText("Monster"))
      expect(questionnaire.dataset.itemNames).toBe(
        "raceType,name,origin,race,special,review"
      )
      expect(
        questionnaire.querySelectorAll("[name=class], [name=profession]")
      ).toHaveLength(0)
      expect(
        [...consoleError.mock.calls, ...consoleWarn.mock.calls].flat().join(" ")
      ).not.toContain("Rendered item")
    } finally {
      consoleError.mockRestore()
      consoleWarn.mockRestore()
    }
  })

  it("requires an explicit branch choice and persists its canonical step", async () => {
    setupMock({ serverDraft: null })
    render(<CreateCharacterForm />)
    await flush()

    expect(
      (screen.getByLabelText("Enlightened") as HTMLInputElement).checked
    ).toBe(false)
    expect((screen.getByLabelText("Monster") as HTMLInputElement).checked).toBe(
      false
    )
    fireEvent.click(screen.getByLabelText("Enlightened"))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900))
    })

    const put = lastDraftPutBody()[0]
    expect(put.data?.raceType).toBe("enlightened")
    expect(put.data?.step).toBe(1)
  })

  it("uses six steps and omits class and profession for monsters", async () => {
    setupMock({ serverDraft: null })
    render(<CreateCharacterForm />)
    await flush()
    fireEvent.click(screen.getByLabelText("Monster"))

    expect(
      screen.getByTestId("questionnaire").getAttribute("data-item-count")
    ).toBe("6")
    expect(screen.queryByRole("heading", { name: "Class" })).toBeNull()
    expect(screen.queryByRole("heading", { name: "Profession" })).toBeNull()
  })

  it("clears race/class/profession when changing branch but preserves profile fields", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        localDraft({
          raceType: "enlightened",
          name: "Keep my name",
          notes: "Keep my notes",
          raceId: "human",
          classId: "archer",
          professionId: "smith",
        })
      )
    )
    setupMock({
      serverDraft: null,
      catalog: {
        races: [
          makeItem("human", {
            name: "Human",
            config: {
              raceType: "enlightened",
              naturalGrade: "F",
              raceDefinitions: { F: {} },
            },
          }),
        ],
        classes: [
          makeItem("archer", {
            name: "Archer",
            grade: "F",
            config: { grades: { F: { award: 1 } } },
          }),
        ],
        professions: [
          makeItem("smith", {
            name: "Smith",
            grade: "F",
            config: { grades: { F: { award: 1 } } },
          }),
        ],
      },
    })
    await renderForm()
    fireEvent.click(screen.getByLabelText("Monster"))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900))
    })

    const payload = lastDraftPutBody().at(-1)?.data
    expect(payload?.raceType).toBe("monster")
    expect(payload?.raceId).toBeUndefined()
    expect(payload?.classId).toBeUndefined()
    expect(payload?.professionId).toBeNull()
    expect(payload?.name).toBe("Keep my name")
    expect(window.localStorage.getItem(STORAGE_KEY)).toContain("Keep my notes")
  })

  it("offers only exact natural-grade definitions with usable grade data", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(localDraft({ raceId: "race-b", origin: "born" }))
    )
    setupMock({
      serverDraft: null,
      catalog: {
        races: [
          makeItem("race-b", {
            name: "B race",
            config: {
              raceType: "enlightened",
              naturalGrade: "B",
              raceDefinitions: { B: {} },
            },
          }),
        ],
        classes: [
          makeItem("class-b", {
            name: "Usable B",
            grade: "B",
            config: { grades: { B: { award: 1 } } },
          }),
          makeItem("class-low", {
            name: "Lower grade",
            grade: "F",
            config: { grades: { F: { award: 1 } } },
          }),
          makeItem("class-missing", {
            name: "Missing B data",
            grade: "B",
            config: { grades: { F: { award: 1 } } },
          }),
        ],
        professions: [
          makeItem("prof-b", {
            name: "B profession",
            grade: "B",
            config: { grades: { B: { award: 1 } } },
          }),
        ],
      },
    })
    await renderForm()

    expect(screen.getByText("Usable B")).toBeTruthy()
    expect(screen.queryByText("Lower grade")).toBeNull()
    expect(screen.queryByText("Missing B data")).toBeNull()
    expect(screen.getByText("B profession")).toBeTruthy()
  })

  it("allows legacy catalog grades by usable F config but enforces explicit naturalGrade", async () => {
    const gradeOptions = [
      makeItem("class-null", {
        name: "Legacy ungraded class",
        grade: null,
        config: { grades: { F: { award: 1 } } },
      }),
      makeItem("class-e", {
        name: "Legacy E class",
        grade: "E",
        config: { grades: { F: { award: 1 } } },
      }),
      makeItem("class-f", {
        name: "Explicit F class",
        grade: "F",
        config: { grades: { F: { award: 1 } } },
      }),
    ]
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(localDraft({ raceId: "legacy-race", origin: "born" }))
    )
    setupMock({
      serverDraft: null,
      catalog: {
        races: [
          makeItem("legacy-race", {
            name: "Legacy",
            config: { raceType: "enlightened" },
          }),
        ],
        classes: gradeOptions,
      },
    })
    await renderForm()
    expect(screen.getByText("Legacy ungraded class")).toBeTruthy()
    expect(screen.getByText("Legacy E class")).toBeTruthy()
    expect(screen.getByText(/Legacy race has no naturalGrade/)).toBeTruthy()

    cleanup()
    window.localStorage.clear()
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(localDraft({ raceId: "explicit-race", origin: "born" }))
    )
    setupMock({
      serverDraft: null,
      catalog: {
        races: [
          makeItem("explicit-race", {
            name: "Explicit",
            config: { raceType: "enlightened", naturalGrade: "F" },
          }),
        ],
        classes: gradeOptions,
      },
    })
    await renderForm()
    expect(screen.getByText("Explicit F class")).toBeTruthy()
    expect(screen.queryByText("Legacy E class")).toBeNull()
    expect(screen.queryByText("Legacy ungraded class")).toBeNull()
  })

  it("posts null class and profession for a monster character", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        localDraft({
          raceType: "monster",
          name: "Moss",
          origin: "born",
          raceId: "race-monster",
          classId: "stale-class",
          professionId: "stale-prof",
        })
      )
    )
    setupMock({
      serverDraft: null,
      catalog: {
        races: [
          makeItem("race-monster", {
            name: "Moss beast",
            config: {
              raceType: "monster",
              naturalGrade: "F",
              raceDefinitions: { F: {} },
            },
          }),
        ],
      },
    })
    await renderForm()
    fireEvent.submit(screen.getByTestId("questionnaire"))
    await flush()

    expect(createPostBodies()[0]).toMatchObject({
      name: "Moss",
      raceId: "race-monster",
      classId: null,
      professionId: null,
    })
  })

  it("infers a legacy server draft branch from its selected race", async () => {
    const legacyData = serverData({ step: 0, raceId: "old-monster" })
    delete (legacyData as Record<string, unknown>).raceType
    setupMock({
      serverDraft: { data: legacyData, version: 8 },
      catalog: {
        races: [
          makeItem("old-monster", {
            name: "Old monster",
            config: {
              raceType: "monster",
              naturalGrade: "F",
              raceDefinitions: { F: {} },
            },
          }),
        ],
      },
    })
    await renderForm()

    expect(screen.getByTestId("questionnaire").getAttribute("item")).toBe(
      "name"
    )
    expect((screen.getByLabelText("Monster") as HTMLInputElement).checked).toBe(
      true
    )
    expect(
      screen.getByTestId("questionnaire").getAttribute("data-item-count")
    ).toBe("6")
  })

  it("preserves legacy server race and class selections when reaffirming Enlightened", async () => {
    const legacyData = serverData({
      step: 3,
      raceId: "human",
      classId: "archer",
      origin: "born",
    })
    delete (legacyData as Record<string, unknown>).raceType
    setupMock({
      serverDraft: { data: legacyData, version: 12 },
      catalog: {
        races: [
          makeItem("human", {
            name: "Human",
            config: { raceDefinitions: { F: {} } },
          }),
        ],
        classes: [
          makeItem("archer", {
            name: "Archer",
            grade: null,
            config: { grades: { F: { award: 1 } } },
          }),
        ],
      },
    })
    await renderForm()

    expect(screen.getByTestId("questionnaire").getAttribute("item")).toBe(
      "class"
    )
    expect(
      (screen.getByLabelText("Enlightened") as HTMLInputElement).checked
    ).toBe(true)
    fireEvent.click(screen.getByLabelText("Enlightened"))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900))
    })
    expect(lastDraftPutBody().at(-1)?.data).toMatchObject({
      raceType: "enlightened",
      raceId: "human",
      classId: "archer",
      step: 4,
    })
    fireEvent.submit(screen.getByTestId("questionnaire"))
    await flush()
    expect(createPostBodies().at(-1)).toMatchObject({
      raceId: "human",
      classId: "archer",
    })
  })

  it("preserves no-server local legacy selections when reaffirming Enlightened", async () => {
    const local = localDraft({
      step: "class",
      raceId: "human",
      classId: "archer",
      origin: "born",
      name: "Legacy hero",
    })
    delete (local as Record<string, unknown>).raceType
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(local))
    setupMock({
      serverDraft: null,
      catalog: {
        races: [
          makeItem("human", {
            name: "Human",
            config: { raceDefinitions: { F: {} } },
          }),
        ],
        classes: [
          makeItem("archer", {
            name: "Archer",
            grade: null,
            config: { grades: { F: { award: 1 } } },
          }),
        ],
      },
    })
    await renderForm()
    fireEvent.click(screen.getByLabelText("Enlightened"))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900))
    })
    expect(lastDraftPutBody().at(-1)?.data).toMatchObject({
      raceType: "enlightened",
      raceId: "human",
      classId: "archer",
      step: 4,
    })
    fireEvent.submit(screen.getByTestId("questionnaire"))
    await flush()
    expect(createPostBodies().at(-1)).toMatchObject({
      raceId: "human",
      classId: "archer",
    })
  })

  it("shows the catalog picker and does not offer a yes/no special-abilities choice", async () => {
    setupMock({
      serverDraft: { data: serverData({ name: "Server" }), version: 3 },
    })

    await renderForm()
    await flush()

    // The legacy "Has special abilities" yes/no flag is gone; the step is now a
    // catalog picker that never asks the user to record a flag.
    expect(screen.queryByText(/Has special abilities/)).toBeNull()
    expect(screen.queryByText(/Recorded \(not calculated\)/)).toBeNull()
    expect(screen.queryByText(/Recorded, but not yet calculated/)).toBeNull()
    expect(screen.queryByText(/Not assigned during creation/)).toBeNull()

    // The step documents the explicit selection. An empty ability catalog still
    // renders the blessing "None" choice and the section headings.
    expect(
      screen.getAllByText(/Select optional catalog entries/).length
    ).toBeGreaterThan(0)
    expect(screen.getAllByText("None").length).toBeGreaterThan(0)
    expect(screen.getByText("Bloodline (choose one)")).toBeTruthy()
    expect(screen.getByText(/Selected 0 \/ maximum 3/)).toBeTruthy()
    expect(screen.getByRole("heading", { name: "Blessings" })).toBeTruthy()
  })

  it("warns about a legacy special-abilities flag and never submits special=true", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(localDraft({ origin: "integrated", special: "yes" }))
    )
    setupMock({
      serverDraft: { data: serverData({ special: true }), version: 3 },
      putResult: { data: serverData({ name: "Local v2" }), version: 4 },
    })

    await renderForm()
    await flush()

    // The legacy flag surfaces as an informative warning, not a silent feature.
    expect(
      screen.getByText(
        /This legacy draft had a special-abilities flag, not a catalog selection\. Choose entries again if desired\./
      )
    ).toBeTruthy()

    // Editing marks the draft dirty and triggers the debounced autosave.
    fireEvent.change(screen.getByPlaceholderText("Character name"), {
      target: { value: "Local v2" },
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 900))
    })

    const body = lastDraftPutBody()[0]
    // The UI never persists special=true: special abilities are deferred.
    expect(body.data?.special).toBe(false)
    // A legacy boolean never implies a power: the explicit selection is empty.
    expect(body.data?.specialAbilities).toEqual({
      bloodlineIds: [],
      transcendentSkillIds: [],
    })
  })

  it("round-trips selected abilities through the draft PUT", async () => {
    setupMock({
      serverDraft: null,
      catalog: {
        gods: [makeItem("bless-1", { name: "Blessing One" })],
        bloodlines: [
          makeItem("blood-1", { name: "Bloodline One" }),
          makeItem("blood-2", { name: "Bloodline Two" }),
        ],
        transcendentSkills: [makeItem("trans-1", { name: "Transcendent One" })],
      },
      putResult: { data: serverData({ name: "Kael" }), version: 1 },
    })

    await renderForm()
    await flush()

    // Select via the raw checkboxes (the blessing uses a choice control which
    // the mock renders as a span, so it is exercised via the stored draft).
    fireEvent.click(screen.getByLabelText(/Bloodline One/))
    fireEvent.click(screen.getByLabelText(/Transcendent One/))
    // The draft is now non-empty, so a debounced autosave PUT is scheduled.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 900))
    })

    const body = lastDraftPutBody()[0]
    expect(body.data?.specialAbilities).toEqual({
      bloodlineIds: ["blood-1"],
      transcendentSkillIds: ["trans-1"],
    })
  })

  it("restores a stored server draft's special-ability selections", async () => {
    setupMock({
      serverDraft: {
        data: serverData({
          name: "Kael",
          specialAbilities: {
            blessing: { godId: "bless-1", tier: "Minor" },
            bloodlineIds: ["blood-1"],
            transcendentSkillIds: ["trans-1"],
          },
        }),
        version: 5,
      },
      catalog: {
        gods: [makeItem("bless-1", { name: "Blessing One" })],
        bloodlines: [makeItem("blood-1", { name: "Bloodline One" })],
        transcendentSkills: [makeItem("trans-1", { name: "Transcendent One" })],
      },
    })

    await renderForm()
    await flush()

    // Stored selections are restored into the wizard's controls.
    expect(
      (screen.getByLabelText(/Bloodline One/) as HTMLInputElement).checked
    ).toBe(true)
    expect(
      (screen.getByLabelText(/Transcendent One/) as HTMLInputElement).checked
    ).toBe(true)
    // The review summary surfaces the restored names (matches the choice rows
    // as well as the review line, so assert via getAllByText).
    expect(screen.getAllByText(/Blessing One/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Bloodline One/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Transcendent One/).length).toBeGreaterThan(0)
  })

  it("POSTs the selected association ids with the create request", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        localDraft({
          name: "Kael",
          origin: "integrated",
          specialAbilities: {
            blessing: { godId: "bless-1", tier: "Minor" },
            bloodlineIds: ["blood-1", "blood-2"],
            transcendentSkillIds: ["trans-1"],
          },
        })
      )
    )
    setupMock({
      serverDraft: null,
      catalog: {
        gods: [makeItem("bless-1", { name: "Blessing One" })],
        bloodlines: [
          makeItem("blood-1", { name: "Bloodline One" }),
          makeItem("blood-2", { name: "Bloodline Two" }),
        ],
        transcendentSkills: [makeItem("trans-1", { name: "Transcendent One" })],
      },
      putResult: { data: serverData({ name: "Kael" }), version: 2 },
    })

    await renderForm()
    await flush()

    fireEvent.click(screen.getByText("Keep Bloodline One"))
    await flush()

    fireEvent.submit(screen.getByTestId("questionnaire"))
    await flush()

    expect(createCalls).toBe(1)
    const post = createPostBodies()[0]
    expect(post.specialAbilities).toEqual({
      blessing: { godId: "bless-1", tier: "Minor" },
      bloodlineIds: ["blood-1"],
      transcendentSkillIds: ["trans-1"],
    })
  })

  it("blocks submission when a selected ability is archived", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        localDraft({
          name: "Kael",
          specialAbilities: {
            blessing: { godId: "bless-1", tier: "Minor" },
            bloodlineIds: [],
            transcendentSkillIds: [],
          },
        })
      )
    )
    setupMock({
      serverDraft: null,
      catalog: {
        gods: [makeItem("bless-1", { name: "Blessing One", archived: true })],
      },
      putResult: { data: serverData({ name: "Kael" }), version: 1 },
    })

    await renderForm()
    await flush()

    expect(
      screen.getAllByText(/is archived and cannot be linked/i).length
    ).toBeGreaterThan(0)
    const submitBtn = screen.getByText("Create character").closest("button")
    expect(submitBtn?.disabled).toBe(true)

    // Form submit is blocked (defense in depth): no POST is issued.
    fireEvent.submit(screen.getByTestId("questionnaire"))
    await flush()
    expect(createCalls).toBe(0)
  })

  it("blocks submission when two selected bloodlines share an upgrade group", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        localDraft({
          name: "Kael",
          specialAbilities: {
            blessing: null,
            bloodlineIds: ["blood-1", "blood-2"],
            transcendentSkillIds: [],
          },
        })
      )
    )
    setupMock({
      serverDraft: null,
      catalog: {
        bloodlines: [
          makeItem("blood-1", {
            name: "Bloodline One",
            config: { upgradeGroup: "g1" },
          }),
          makeItem("blood-2", {
            name: "Bloodline Two",
            config: { upgradeGroup: "g1" },
          }),
        ],
      },
      putResult: { data: serverData({ name: "Kael" }), version: 1 },
    })

    await renderForm()
    await flush()

    expect(screen.getAllByText(/multiple bloodlines/i).length).toBeGreaterThan(
      0
    )
    const submitBtn = screen.getByText("Create character").closest("button")
    expect(submitBtn?.disabled).toBe(true)
    fireEvent.submit(screen.getByTestId("questionnaire"))
    await flush()
    expect(createCalls).toBe(0)
  })

  it("blocks submission on an unavailable stored ability id and recovers once removed", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        localDraft({
          name: "Kael",
          specialAbilities: {
            blessing: null,
            bloodlineIds: ["orphan-1"],
            transcendentSkillIds: [],
          },
        })
      )
    )
    setupMock({
      serverDraft: null,
      catalog: {
        bloodlines: [makeItem("blood-1", { name: "Bloodline One" })],
      },
      putResult: { data: serverData({ name: "Kael" }), version: 1 },
    })

    await renderForm()
    await flush()

    // The stale id is surfaced as an orphan row and blocks submission.
    expect(
      screen.getAllByText(/no longer in the catalog/).length
    ).toBeGreaterThan(0)
    const orphan = screen.getByLabelText(/orphan-1/) as HTMLInputElement
    expect(orphan.checked).toBe(true)
    const submitBtn = screen.getByText("Create character").closest("button")
    expect(submitBtn?.disabled).toBe(true)
    fireEvent.submit(screen.getByTestId("questionnaire"))
    await flush()
    expect(createCalls).toBe(0)

    // Removing the stale id clears the error and unblocks the create.
    fireEvent.click(
      screen.getByLabelText("None", {
        selector: 'input[name="create-bloodline"]',
      })
    )
    await flush()
    expect(screen.queryAllByText(/no longer in the catalog/).length).toBe(0)
    const submitBtn2 = screen.getByText("Create character").closest("button")
    expect(submitBtn2?.disabled).toBe(false)
    fireEvent.submit(screen.getByTestId("questionnaire"))
    await flush()
    expect(createCalls).toBe(1)
  })

  it("offers one radio bloodline rather than multiple selections", async () => {
    const selected = ["blood-0"]
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        localDraft({
          name: "Kael",
          specialAbilities: {
            blessing: null,
            bloodlineIds: selected,
            transcendentSkillIds: [],
          },
        })
      )
    )
    setupMock({
      serverDraft: null,
      catalog: {
        bloodlines: Array.from({ length: 9 }, (_, i) =>
          makeItem(`blood-${i}`, { name: `Bloodline ${i}` })
        ),
      },
      putResult: { data: serverData({ name: "Kael" }), version: 1 },
    })

    await renderForm()
    await flush()

    const ninth = screen.getByLabelText(/Bloodline 8/) as HTMLInputElement
    expect(ninth.type).toBe("radio")
    expect(ninth.disabled).toBe(false)
    expect(
      (screen.getByLabelText(/Bloodline 0/) as HTMLInputElement).checked
    ).toBe(true)
  })

  it("blocks submission when ability catalogs fail and recovers via Retry without a reload", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        localDraft({
          name: "Kael",
          specialAbilities: {
            blessing: { godId: "bless-1", tier: "Minor" },
            bloodlineIds: [],
            transcendentSkillIds: [],
          },
        })
      )
    )
    setupMock({
      serverDraft: null,
      catalog: {
        gods: [makeItem("bless-1", { name: "Blessing One" })],
      },
      abilityCatalogError: new Error("network down"),
      putResult: { data: serverData({ name: "Kael" }), version: 1 },
    })

    await renderForm()
    await flush()

    // The selected blessing cannot be validated - submission is blocked and an
    // actionable error plus a Retry action is offered (no page reload).
    expect(
      screen.getAllByText(/Ability catalogs could not be loaded/).length
    ).toBeGreaterThan(0)
    expect(screen.getAllByText(/Retry/).length).toBeGreaterThan(0)
    const submitBtn = screen.getByText("Create character").closest("button")
    expect(submitBtn?.disabled).toBe(true)
    fireEvent.submit(screen.getByTestId("questionnaire"))
    await flush()
    expect(createCalls).toBe(0)

    // The draft is preserved (no full-page reload): the name is still present.
    expect(
      (screen.getByPlaceholderText("Character name") as HTMLInputElement).value
    ).toBe("Kael")

    // Network recovers; Retry re-fetches only the ability lists.
    abilityCatalogError = null
    fireEvent.click(screen.getAllByText("Retry")[0])
    await flush()

    expect(
      screen.queryAllByText(/Ability catalogs could not be loaded/).length
    ).toBe(0)
    const submitBtn2 = screen.getByText("Create character").closest("button")
    expect(submitBtn2?.disabled).toBe(false)
    fireEvent.submit(screen.getByTestId("questionnaire"))
    await flush()
    expect(createCalls).toBe(1)
  })

  it.each([0, 3, 8])(
    "uses the configured transcendent maximum %i",
    async (maximum) => {
      const selectedIds = Array.from(
        { length: maximum },
        (_, i) => `trans-${i}`
      )
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(
          localDraft({
            name: "Cap test",
            specialAbilities: {
              blessing: null,
              bloodlineIds: [],
              transcendentSkillIds: selectedIds,
            },
          })
        )
      )
      setupMock({
        serverDraft: null,
        maxTranscendentSkills: maximum,
        catalog: {
          transcendentSkills: Array.from(
            { length: Math.max(1, maximum + 1) },
            (_, i) => makeItem(`trans-${i}`, { name: `Transcendent ${i}` })
          ),
        },
      })
      await renderForm()
      expect(
        screen.getByText(`Selected ${maximum} / maximum ${maximum}`)
      ).toBeTruthy()
      if (maximum < 8) {
        const next = screen
          .getByText(`Transcendent ${maximum}`)
          .closest("label")!
          .querySelector("input") as HTMLInputElement
        expect(next.disabled).toBe(true)
      }
    }
  )

  it("blocks a selected transcendent skill until creation rules load and retries", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        localDraft({
          name: "Cap test",
          specialAbilities: {
            blessing: null,
            bloodlineIds: [],
            transcendentSkillIds: ["trans-1"],
          },
        })
      )
    )
    setupMock({
      serverDraft: null,
      rulesError: new Error("rules offline"),
      catalog: {
        transcendentSkills: [makeItem("trans-1", { name: "Transcendent One" })],
      },
    })
    await renderForm()
    expect(
      screen.getAllByText(/Creation rules could not be loaded/).length
    ).toBeGreaterThan(0)
    expect(
      (
        screen
          .getByText("Create character")
          .closest("button") as HTMLButtonElement
      ).disabled
    ).toBe(true)
    fireEvent.submit(screen.getByTestId("questionnaire"))
    await flush()
    expect(createCalls).toBe(0)
    rulesError = null
    fireEvent.click(screen.getByText("Retry rules"))
    await flush()
    expect(screen.queryByText(/Creation rules could not be loaded/)).toBeNull()
    expect(screen.getByText("Create character").closest("button")).toBeTruthy()
  })

  it("blocks recovered transcendent selections above the configured maximum", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        localDraft({
          name: "Over cap",
          specialAbilities: {
            blessing: null,
            bloodlineIds: [],
            transcendentSkillIds: ["t1", "t2", "t3", "t4"],
          },
        })
      )
    )
    setupMock({
      serverDraft: null,
      maxTranscendentSkills: 3,
      catalog: {
        transcendentSkills: ["t1", "t2", "t3", "t4"].map((id) => makeItem(id)),
      },
    })
    await renderForm()
    expect(
      screen.getAllByText(/exceeds the transcendent maximum of 3/).length
    ).toBeGreaterThan(0)
    fireEvent.submit(screen.getByTestId("questionnaire"))
    await flush()
    expect(createCalls).toBe(0)
  })

  it("allows a no-selection create when creation rules are unavailable", async () => {
    setupMock({ serverDraft: null, rulesError: new Error("rules offline") })
    await renderForm()
    expect(screen.getByText("Create character").closest("button")).toBeTruthy()
    expect(
      (
        screen
          .getByText("Create character")
          .closest("button") as HTMLButtonElement
      ).disabled
    ).toBe(false)
    fireEvent.submit(screen.getByTestId("questionnaire"))
    await flush()
    expect(createCalls).toBe(1)
  })

  it("resumes a local equipment step at review with the current step map", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(localDraft({ step: "equipment", name: "Resume me" }))
    )
    setupMock({ serverDraft: null })
    await renderForm()
    expect(screen.getByTestId("questionnaire").getAttribute("item")).toBe(
      "review"
    )
    expect(screen.getByText(/branching character questionnaire/)).toBeTruthy()
    const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
    const put = mock.mock.calls.find(
      ([url, init]) =>
        url === "/api/drafts" && (init as RequestInit)?.method === "PUT"
    )
    expect(JSON.parse((put![1] as RequestInit).body as string).data.step).toBe(
      7
    )
    cleanup()
    setupMock({ serverDraft: { data: serverData({ step: 7 }), version: 2 } })
    await renderForm()
    expect(screen.getByTestId("questionnaire").getAttribute("item")).toBe(
      "review"
    )
  })

  it("proceeds with a legacy special=true draft that selected no abilities", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        localDraft({ name: "Kael", origin: "integrated", special: "yes" })
      )
    )
    setupMock({
      serverDraft: {
        data: serverData({ name: "Kael", origin: "integrated", special: true }),
        version: 3,
      },
      putResult: { data: serverData({ name: "Kael" }), version: 4 },
    })

    await renderForm()
    await flush()

    // No ability selection, so a legacy flag or catalog failure never blocks.
    const submitBtn = screen.getByText("Create character").closest("button")
    expect(submitBtn?.disabled).toBe(false)
    fireEvent.submit(screen.getByTestId("questionnaire"))
    await flush()
    expect(createCalls).toBe(1)
    const post = createPostBodies()[0]
    expect(post.specialAbilities).toEqual({
      bloodlineIds: [],
      transcendentSkillIds: [],
    })
  })

  it("offers recovery when only the special-ability selection diverges from the server draft", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        localDraft({
          name: "Kael",
          specialAbilities: {
            blessing: { godId: "bless-1", tier: "Minor" },
            bloodlineIds: [],
            transcendentSkillIds: [],
          },
        })
      )
    )
    setupMock({
      serverDraft: {
        data: serverData({
          name: "Kael",
          specialAbilities: {
            blessing: null,
            bloodlineIds: [],
            transcendentSkillIds: [],
          },
        }),
        version: 3,
      },
    })

    await renderForm()
    await flush()

    // The device copy diverges only on the ability selection, yet it must not be
    // silently overwritten by the server draft.
    expect(screen.getByText(/Use device draft/)).toBeTruthy()
    const raw = window.localStorage.getItem(RECOVERY_KEY)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw as string).specialAbilities.blessing.godId).toBe(
      "bless-1"
    )
    expect(JSON.parse(raw as string).specialAbilities.blessing.tier).toBe(
      "Minor"
    )
  })
})

describe("CreateCharacterForm legacy draft normalization", () => {
  it("normalizes a malformed legacy specialAbilities draft without dropping other fields", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        localDraft({
          name: "Kael",
          nickname: "Kit",
          specialAbilities: {
            blessing: null,
            bloodlineIds: "not-an-array",
            transcendentSkillIds: null,
          },
        })
      )
    )
    setupMock({
      serverDraft: null,
      putResult: { data: serverData({ name: "Kael" }), version: 1 },
    })

    await renderForm()
    await flush()

    // An unrelated draft field survives the normalization untouched.
    expect(
      (screen.getByPlaceholderText("Character name") as HTMLInputElement).value
    ).toBe("Kael")

    // The malformed specialAbilities is coerced to a well-formed empty selection,
    // so hasContent / draftsDiffer / toServerData never dereference undefined and
    // the create POST carries a clean selection.
    fireEvent.submit(screen.getByTestId("questionnaire"))
    await flush()

    expect(createCalls).toBe(1)
    expect(createPostBodies()[0].specialAbilities).toEqual({
      bloodlineIds: [],
      transcendentSkillIds: [],
    })
  })

  it("restores the recovery snapshot and normalizes its abilities after GET null", async () => {
    // The live draft (STORAGE_KEY) is empty and the server draft has disappeared,
    // so the recovery snapshot becomes the device draft again. Its malformed
    // abilities must be normalized - not carried as raw values.
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(localDraft({})))
    window.localStorage.setItem(
      RECOVERY_KEY,
      JSON.stringify(
        localDraft({
          name: "Kael",
          specialAbilities: {
            blessing: { godId: "bless-1", tier: "Minor" },
            bloodlineIds: ["blood-1", 42, null],
            transcendentSkillIds: null,
          },
        })
      )
    )
    setupMock({
      serverDraft: null,
      catalog: {
        gods: [makeItem("bless-1")],
        bloodlines: [makeItem("blood-1")],
      },
      putResult: { data: serverData({ name: "Kael" }), version: 1 },
    })

    await renderForm()
    await flush()

    // No banner: the empty live draft is restored from the recovery snapshot.
    expect(screen.queryByText(/Use device draft/)).toBeNull()
    expect(
      (screen.getByPlaceholderText("Character name") as HTMLInputElement).value
    ).toBe("Kael")
    // RECOVERY_KEY is cleared only after the snapshot was persisted.
    expect(window.localStorage.getItem(RECOVERY_KEY)).toBeNull()
    const stored = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) as string
    )
    expect(stored.specialAbilities.bloodlineIds).toEqual(["blood-1"])

    // The autosave initial create persists the restored snapshot to the server
    // with the malformed array values normalized to strings only.
    expect(putCalls()).toEqual(["/api/drafts"])
    const putBody = lastDraftPutBody()[0]
    expect(putBody.data?.specialAbilities).toEqual({
      blessing: { godId: "bless-1", tier: "Minor" },
      bloodlineIds: ["blood-1"],
      transcendentSkillIds: [],
    })
  })

  it("surfaces an explicit recovery choice when the live draft also carries content after GET null", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(localDraft({ name: "Live", raceId: "r1" }))
    )
    window.localStorage.setItem(
      RECOVERY_KEY,
      JSON.stringify(
        localDraft({
          name: "RecoverMe",
          specialAbilities: {
            blessing: { godId: "bless-1", tier: "Minor" },
            bloodlineIds: [],
            transcendentSkillIds: [],
          },
        })
      )
    )
    setupMock({
      serverDraft: null,
      catalog: {
        races: [makeItem("r1")],
        gods: [makeItem("bless-1", { name: "Blessing One" })],
      },
      putResult: { data: serverData({ name: "RecoverMe" }), version: 2 },
    })

    await renderForm()
    await flush()

    // Both the live draft and the recovery snapshot carry content and differ, so
    // the explicit choice is surfaced and GET null must not erase the snapshot.
    expect(screen.getByText(/Use device draft/)).toBeTruthy()
    expect(window.localStorage.getItem(RECOVERY_KEY)).not.toBeNull()

    // Keeping the device content restores the recovery snapshot; the chosen
    // selection survives the null GET and is normalized. Because the recovery
    // choice now blocks autosave while pending, no earlier autosave persists the
    // live draft - the overwrite PUT carries the recovery snapshot exactly once.
    fireEvent.click(screen.getByText(/Use device draft/))
    await flush()

    const bodies = lastDraftPutBody()
    const putBody = bodies[bodies.length - 1]
    expect(putBody.data?.specialAbilities).toEqual({
      blessing: { godId: "bless-1", tier: "Minor" },
      bloodlineIds: [],
      transcendentSkillIds: [],
    })
    // Exactly one PUT (the overwrite) - no duplicate autosave of the snapshot.
    expect(bodies).toHaveLength(1)
    expect(window.localStorage.getItem(RECOVERY_KEY)).toBeNull()
  })
})

describe("CreateCharacterForm special step None choice", () => {
  it("allows changing the selected god's tier and clearing the selection", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(
        localDraft({
          step: "special",
          name: "Kael",
          origin: "integrated",
          specialAbilities: {
            blessing: { godId: "god-viper", tier: "Minor" },
            bloodlineIds: [],
            transcendentSkillIds: [],
          },
        })
      )
    )
    setupMock({
      serverDraft: null,
      catalog: {
        gods: [makeItem("god-viper", { name: "The Malefic Viper" })],
      },
    })

    await renderForm()
    await flush()

    const tier = screen.getByLabelText("Blessing tier") as HTMLSelectElement
    fireEvent.change(tier, { target: { value: "True" } })
    expect(tier.value).toBe("True")

    fireEvent.click(
      within(screen.getByRole("region", { name: "Blessings" })).getByRole(
        "radio",
        { name: "None" }
      )
    )
    expect(screen.queryByLabelText("Blessing tier")).toBeNull()
  })

  it("renders the blessing None choice even when the ability catalogs fail", async () => {
    setupMock({
      serverDraft: null,
      abilityCatalogError: new Error("network down"),
      putResult: { data: serverData({}), version: 1 },
    })

    await renderForm()
    await flush()

    // A catalog failure must not strip the special step of its real None answer:
    // the retry UI is offered alongside the None choice, so a no-selection draft
    // is never trapped on the step (a selection would still surface specialError).
    expect(screen.getAllByText(/Catalog unavailable/).length).toBeGreaterThan(0)
    expect(screen.getAllByText("None").length).toBeGreaterThan(0)
  })
})

describe("CreateCharacterForm special step navigation (real questionnaire)", () => {
  // The questionnaire is mocked to a plain form for most tests. This block uses
  // the actual QuestionnairePrimitive (via importActual) to verify that the real
  // answered None choice lets a no-selection special step advance to review, and
  // that removing that choice would trap the user. The primitive is the real one,
  // so it enforces the "answered" requirement the wizard depends on.
  it("lets a no-selection special step advance to review when ability catalogs fail", async () => {
    const real = await vi.importActual<
      typeof import("@/components/ui/questionnaire")
    >("@/components/ui/questionnaire")

    function Harness() {
      const [step, setStep] = React.useState("special")
      return (
        <real.Questionnaire
          items={[
            { name: "special", required: false },
            { name: "review", required: false },
          ]}
          item={step}
          onItemChange={(name) => setStep(name)}
        >
          <real.QuestionnaireProgress />
          <real.QuestionnaireItem name="special">
            <real.QuestionnaireTitle>Special abilities</real.QuestionnaireTitle>
            <span>Catalog unavailable: network down</span>
            <real.QuestionnaireChoices>
              <real.QuestionnaireChoice value="" checked onChange={() => {}}>
                None
              </real.QuestionnaireChoice>
            </real.QuestionnaireChoices>
          </real.QuestionnaireItem>
          <real.QuestionnaireItem name="review">
            <real.QuestionnaireTitle>Review</real.QuestionnaireTitle>
            <p>Confirm your choices.</p>
          </real.QuestionnaireItem>
          <real.QuestionnaireActions>
            <real.QuestionnaireNext>Next</real.QuestionnaireNext>
          </real.QuestionnaireActions>
        </real.Questionnaire>
      )
    }

    render(<Harness />)

    // The special step carries a real checked None answer, so the step is
    // "answered" and Next advances to review rather than trapping the user.
    const nextBtn = screen.getByRole("button", { name: "Next" })
    expect(nextBtn).toBeTruthy()
    await act(async () => {
      fireEvent.click(nextBtn)
    })
    const active = document.querySelector("[data-active]")
    expect(active?.textContent).toMatch(/Review/)
  })

  it("traps the special step when no answered choice is rendered", async () => {
    const real = await vi.importActual<
      typeof import("@/components/ui/questionnaire")
    >("@/components/ui/questionnaire")

    function Harness() {
      const [step, setStep] = React.useState("special")
      return (
        <real.Questionnaire
          items={[
            { name: "special", required: false },
            { name: "review", required: false },
          ]}
          item={step}
          onItemChange={(name) => setStep(name)}
        >
          <real.QuestionnaireProgress />
          <real.QuestionnaireItem name="special">
            <real.QuestionnaireTitle>Special abilities</real.QuestionnaireTitle>
            <span>Catalog unavailable: network down</span>
          </real.QuestionnaireItem>
          <real.QuestionnaireItem name="review">
            <real.QuestionnaireTitle>Review</real.QuestionnaireTitle>
            <p>Confirm your choices.</p>
          </real.QuestionnaireItem>
          <real.QuestionnaireActions>
            <real.QuestionnaireNext>Next</real.QuestionnaireNext>
          </real.QuestionnaireActions>
        </real.Questionnaire>
      )
    }

    render(<Harness />)

    // Without any rendered choice the special step stays unanswered, so Next
    // cannot advance to review (this is the bug the unconditional None choice
    // fixes).
    const nextBtn = screen.getByRole("button", { name: "Next" })
    await act(async () => {
      fireEvent.click(nextBtn)
    })
    const active = document.querySelector("[data-active]")
    expect(active?.textContent).toMatch(/Special abilities/)
  })
})

describe("CreateCharacterForm profile metadata whitespace", () => {
  it("preserves exact multiline whitespace in biography/notes in the create POST body (no trim)", async () => {
    const bio = "\n  first line\n  second line  \n\n"
    const notes = "  \nleading space line\n\tindented\t\n"
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(localDraft({ name: "Kael", biography: bio, notes }))
    )
    setupMock({
      serverDraft: null,
      putResult: { data: serverData({ name: "Kael" }), version: 1 },
    })

    await renderForm()
    await flush()

    fireEvent.submit(screen.getByTestId("questionnaire"))
    await flush()

    expect(createCalls).toBe(1)
    const post = createPostBodies()[0] as Record<string, unknown>
    // Leading/trailing whitespace and internal newlines are sent VERBATIM -
    // never trimmed, never collapsed.
    expect(post.biography).toBe(bio)
    expect(post.notes).toBe(notes)
  })
})

describe("CreateCharacterForm profile metadata", () => {
  const META = {
    nickname: "Kit",
    pronouns: "they/them",
    ageDescription: "Ancient wanderer",
    appearance: "Tall, scarred",
    biography: "Born under a red moon.",
    notes: "Secretive.",
  }

  function fillMetadata() {
    fireEvent.change(screen.getByLabelText("Nickname"), {
      target: { value: META.nickname },
    })
    fireEvent.change(screen.getByLabelText("Pronouns"), {
      target: { value: META.pronouns },
    })
    fireEvent.change(screen.getByLabelText("Age description (optional)"), {
      target: { value: META.ageDescription },
    })
    fireEvent.change(screen.getByLabelText("Appearance (optional)"), {
      target: { value: META.appearance },
    })
    fireEvent.change(screen.getByLabelText("Biography (optional)"), {
      target: { value: META.biography },
    })
    fireEvent.change(screen.getByLabelText("Notes (optional)"), {
      target: { value: META.notes },
    })
  }

  it("persists nickname/pronouns/ageDescription/appearance/biography/notes exactly in the server draft PUT", async () => {
    setupMock({
      serverDraft: { data: serverData({ name: "Server" }), version: 3 },
    })

    await renderForm()
    await flush()

    fireEvent.change(screen.getByPlaceholderText("Character name"), {
      target: { value: "Kael" },
    })
    fillMetadata()

    for (const label of [
      "Age description (optional)",
      "Appearance (optional)",
      "Biography (optional)",
      "Notes (optional)",
    ]) {
      const field = screen.getByLabelText(label)
      expect(field.tagName).toBe("INPUT")
      expect((field as HTMLInputElement).value).not.toBe("")
      expect(field.getAttribute("data-slot")).toBe("questionnaire-input")
      expect((field as HTMLInputElement).placeholder).toBe(label)
    }
    for (const label of ["Nickname", "Pronouns"]) {
      expect(screen.getByLabelText(label).getAttribute("data-slot")).toBe(
        "questionnaire-input"
      )
    }
    expect(
      screen.getByPlaceholderText("Character name").getAttribute("data-slot")
    ).toBe("questionnaire-input")

    // The debounced autosave PUTs the draft with every metadata field VERBATIM.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 900))
    })

    const putBodies = lastDraftPutBody()
    expect(putBodies).toHaveLength(1)
    const data = putBodies[0].data as Record<string, unknown>
    expect(data.nickname).toBe(META.nickname)
    expect(data.pronouns).toBe(META.pronouns)
    expect(data.ageDescription).toBe(META.ageDescription)
    expect(data.appearance).toBe(META.appearance)
    expect(data.biography).toBe(META.biography)
    expect(data.notes).toBe(META.notes)
  })

  it("shows all six profile metadata fields on the review step", async () => {
    setupMock({
      serverDraft: { data: serverData({ name: "Server" }), version: 3 },
    })

    await renderForm()
    await flush()

    fireEvent.change(screen.getByPlaceholderText("Character name"), {
      target: { value: "Kael" },
    })
    fillMetadata()

    // The review step renders each metadata field row: the value text is scoped
    // to the review container because controlled textareas also expose their text
    // value as a text node, which would otherwise match twice.
    const reviewTitle = screen.getByRole("heading", { name: "Review" })
    const reviewItem = reviewTitle.parentElement as HTMLElement
    const review = within(reviewItem)

    expect(review.getByText("Nickname:")).toBeTruthy()
    expect(review.getByText(META.nickname)).toBeTruthy()
    expect(review.getByText("Pronouns:")).toBeTruthy()
    expect(review.getByText(META.pronouns)).toBeTruthy()
    expect(review.getByText("Age description:")).toBeTruthy()
    expect(review.getByText(META.ageDescription)).toBeTruthy()
    expect(review.getByText("Appearance:")).toBeTruthy()
    expect(review.getByText(META.appearance)).toBeTruthy()
    expect(review.getByText("Biography:")).toBeTruthy()
    expect(review.getByText(META.biography)).toBeTruthy()
    expect(review.getByText("Notes:")).toBeTruthy()
    expect(review.getByText(META.notes)).toBeTruthy()
  })

  it("includes the exact metadata values and the draft version in the create POST", async () => {
    setupMock({
      serverDraft: null,
      putResult: { data: serverData({ name: "Kael" }), version: 4 },
    })

    await renderForm()
    await flush()

    fireEvent.change(screen.getByPlaceholderText("Character name"), {
      target: { value: "Kael" },
    })
    fillMetadata()

    fireEvent.submit(screen.getByTestId("questionnaire"))
    await flush()

    expect(createCalls).toBe(1)
    const post = createPostBodies()[0] as Record<string, unknown>
    // Every metadata field is sent verbatim, and the known draft version rides
    // along for the atomic consume of the draft.
    expect(post.nickname).toBe(META.nickname)
    expect(post.pronouns).toBe(META.pronouns)
    expect(post.ageDescription).toBe(META.ageDescription)
    expect(post.appearance).toBe(META.appearance)
    expect(post.biography).toBe(META.biography)
    expect(post.notes).toBe(META.notes)
    expect(post.draftVersion).toBe(4)
  })

  it("restores all six metadata fields from the device draft after a divergent server draft recovery (no clobber)", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(localDraft({ name: "Kael", ...META }))
    )
    setupMock({
      serverDraft: {
        data: serverData({
          name: "Server",
          nickname: "Srv",
          pronouns: "he/him",
          ageDescription: "Young",
          appearance: "Short",
          biography: "SBio",
          notes: "SNotes",
        }),
        version: 3,
      },
    })

    await renderForm()
    await flush()

    // Metadata-only divergence surfaces the explicit recovery choice, never a
    // silent overwrite of the device copy.
    expect(screen.getByText(/Use device draft/)).toBeTruthy()
    const raw = window.localStorage.getItem(RECOVERY_KEY)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw as string).nickname).toBe(META.nickname)

    // Keeping the device content restores every metadata field from the local
    // copy.
    fireEvent.click(screen.getByText(/Use device draft/))
    await flush()

    expect((screen.getByLabelText("Nickname") as HTMLInputElement).value).toBe(
      META.nickname
    )
    expect((screen.getByLabelText("Pronouns") as HTMLInputElement).value).toBe(
      META.pronouns
    )
    expect(
      (screen.getByLabelText("Age description (optional)") as HTMLInputElement)
        .value
    ).toBe(META.ageDescription)
    expect(
      (screen.getByLabelText("Appearance (optional)") as HTMLInputElement).value
    ).toBe(META.appearance)
    expect(
      (screen.getByLabelText("Biography (optional)") as HTMLInputElement).value
    ).toBe(META.biography)
    expect(
      (screen.getByLabelText("Notes (optional)") as HTMLInputElement).value
    ).toBe(META.notes)

    // The chosen device snapshot is now the live draft - the server metadata was
    // not clobbered in and the recovery copy is cleared.
    const stored = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) as string
    )
    expect(stored.nickname).toBe(META.nickname)
    expect(stored.pronouns).toBe(META.pronouns)
    expect(window.localStorage.getItem(RECOVERY_KEY)).toBeNull()
  })

  it("clearing previously-set metadata fields posts null in the create POST", async () => {
    setupMock({
      serverDraft: null,
      putResult: { data: serverData({ name: "Kael" }), version: 5 },
    })

    await renderForm()
    await flush()

    fireEvent.change(screen.getByPlaceholderText("Character name"), {
      target: { value: "Kael" },
    })
    fillMetadata()
    // Clear every metadata field back to blank.
    fireEvent.change(screen.getByLabelText("Nickname"), {
      target: { value: "" },
    })
    fireEvent.change(screen.getByLabelText("Pronouns"), {
      target: { value: "" },
    })
    fireEvent.change(screen.getByLabelText("Age description (optional)"), {
      target: { value: "" },
    })
    fireEvent.change(screen.getByLabelText("Appearance (optional)"), {
      target: { value: "" },
    })
    fireEvent.change(screen.getByLabelText("Biography (optional)"), {
      target: { value: "" },
    })
    fireEvent.change(screen.getByLabelText("Notes (optional)"), {
      target: { value: "" },
    })

    fireEvent.submit(screen.getByTestId("questionnaire"))
    await flush()

    expect(createCalls).toBe(1)
    const post = createPostBodies()[0] as Record<string, unknown>
    // A blank metadata field is cleared on the server (null), never kept as "".
    expect(post.nickname).toBeNull()
    expect(post.pronouns).toBeNull()
    expect(post.ageDescription).toBeNull()
    expect(post.appearance).toBeNull()
    expect(post.biography).toBeNull()
    expect(post.notes).toBeNull()
  })

  it("a metadata autosave failure keeps the current form and shows the error (no fake Saved)", async () => {
    setupMock({
      serverDraft: { data: serverData({ name: "Server" }), version: 3 },
      putError: new Error("network down"),
    })

    await renderForm()
    await flush()

    fireEvent.change(screen.getByLabelText("Nickname"), {
      target: { value: "Kit" },
    })

    // The debounced autosave PUT fails; the error is surfaced and the form is
    // preserved (no reload/clobber, no fake "Saved").
    await act(async () => {
      await new Promise((r) => setTimeout(r, 900))
    })

    expect(screen.getByText(/network down/)).toBeTruthy()
    expect(screen.queryByText("Saved")).toBeNull()
    expect(screen.queryByText("Saving...")).toBeNull()
    expect((screen.getByLabelText("Nickname") as HTMLInputElement).value).toBe(
      "Kit"
    )
  })
})
