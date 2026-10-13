// @vitest-environment jsdom
import * as React from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiError, apiFetch } from "@/lib/api"
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
      ...props
    }: React.ComponentProps<"form"> & {
      items?: unknown[]
      item?: string
      onItemChange?: (name: string) => void
    }) => (
      <form data-testid="questionnaire" onSubmit={onSubmit} {...props}>
        {children}
      </form>
    ),
    QuestionnaireActions: div,
    QuestionnaireChoice: ({ children }: React.ComponentProps<"span">) => (
      <span>{children}</span>
    ),
    QuestionnaireChoiceDescription: ({
      children,
    }: React.ComponentProps<"span">) => <span>{children}</span>,
    QuestionnaireChoices: div,
    QuestionnaireDescription: ({ children }: React.ComponentProps<"p">) => (
      <p>{children}</p>
    ),
    QuestionnaireInput: (props: React.ComponentProps<"input">) => (
      <input {...props} />
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
    step: 0,
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
}

let serverDraft: ServerDraft | null = null
let putError: unknown = null
let putResult: ServerDraft | null = null
let getError: unknown = null
let createError: unknown = null
let createCalls = 0

function setupMock(options: Options) {
  serverDraft = options.serverDraft ?? null
  putError = options.putError ?? null
  putResult = options.putResult ?? null
  getError = options.getError ?? null
  createError = options.createError ?? null
  createCalls = 0

  const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
  mock.mockReset()
  mock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    if (
      url === "/api/catalog/races" ||
      url === "/api/catalog/classes" ||
      url === "/api/catalog/professions"
    ) {
      return { kind: "catalog", items: [] }
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
    expect(screen.getByText(/Overwrite server draft/)).toBeTruthy()
    expect(screen.getByText(/Keep server draft/)).toBeTruthy()

    // Autosave is paused while the choice is unresolved: editing must not PUT.
    fireEvent.change(screen.getByPlaceholderText("Character name"), {
      target: { value: "Local v3" },
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 900))
    })
    expect(putCalls()).toEqual([])
  })

  it("overwrite server draft GETs the current version then PUTs the local draft", async () => {
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

    fireEvent.click(screen.getByText(/Overwrite server draft/))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    // A GET must precede the PUT (for the current version) and the PUT must
    // carry the local draft data.
    expect(putCalls()).toEqual(["/api/drafts"])
    expect(window.localStorage.getItem(RECOVERY_KEY)).toBeNull()
    expect(screen.queryByText(/Overwrite server draft/)).toBeNull()
  })

  it("keep server draft discards the local draft and resumes", async () => {
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

    fireEvent.click(screen.getByText(/Keep server draft/))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(window.localStorage.getItem(RECOVERY_KEY)).toBeNull()
    expect(screen.queryByText(/Keep server draft/)).toBeNull()
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
    expect(screen.getByText(/Overwrite server draft/)).toBeTruthy()
    const saveBtn = screen.getByText("Save draft").closest("button")
    expect(saveBtn?.disabled).toBe(true)

    // Clicking the disabled Save draft must not issue a PUT (no overwrite):
    // only the explicit 'Overwrite server draft' action may.
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
    expect(screen.getByText(/Overwrite server draft/)).toBeTruthy()
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
    fireEvent.click(screen.getByText(/Keep server draft/))
    await flush()

    // Recovery is cleared and the wizard is editable again.
    expect(screen.queryByText(/Keep server draft/)).toBeNull()
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
})

describe("CreateCharacterForm special abilities", () => {
  it("does not offer a yes/no special-abilities choice and shows it as not assigned", async () => {
    setupMock({
      serverDraft: { data: serverData({ name: "Server" }), version: 3 },
    })

    await renderForm()
    await flush()

    // The "Has special abilities" yes/no selection and any "Recorded" wording are
    // gone; the step no longer asks the user to record a flag.
    expect(screen.queryByText(/Has special abilities/)).toBeNull()
    expect(screen.queryByText(/Recorded \(not calculated\)/)).toBeNull()
    expect(screen.queryByText(/Recorded, but not yet calculated/)).toBeNull()

    // The step now explains the deferred feature accurately: nothing is assigned
    // during creation - blessings/bloodlines attach AFTER creation - and
    // transcendents remain unavailable (defined in the encyclopedia but not yet
    // attached to a character).
    expect(
      screen.getAllByText(/Not assigned during creation/).length
    ).toBeGreaterThan(0)
    expect(
      screen.getAllByText(
        /Attach blessings or bloodlines after creating the character/
      ).length
    ).toBeGreaterThan(0)
    expect(
      screen.getByText(
        /transcendents are defined in the encyclopedia but not yet attached/i
      )
    ).toBeTruthy()
  })

  it("warns about a legacy special-abilities flag and never submits special=true", async () => {
    // A draft saved before the change carried `special: yes`/`special: true`. It
    // must not be hidden silently - an informative warning is shown - and a save
    // must never PUT special=true.
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
    // The special step now says that a legacy draft only records the yes/no
    // answer and that blessings/bloodlines are attached after creation.
    expect(screen.getByText(/records your answer only/i)).toBeTruthy()
    expect(
      screen.getAllByText(
        /Attach blessings or bloodlines after creating the character/
      ).length
    ).toBeGreaterThan(0)

    // Editing marks the draft dirty and triggers the debounced autosave.
    fireEvent.change(screen.getByPlaceholderText("Character name"), {
      target: { value: "Local v2" },
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 900))
    })

    const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
    const put = mock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PUT"
    )
    expect(put).toBeTruthy()
    const body = JSON.parse((put![1] as RequestInit).body as string) as {
      data: { special?: boolean }
    }
    // The UI never persists special=true: special abilities are deferred.
    expect(body.data.special).toBe(false)
  })
})
