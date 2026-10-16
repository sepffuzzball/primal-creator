// @vitest-environment jsdom
import * as React from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ApiError, apiFetch } from "@/lib/api"
import { CatalogManager } from "@/components/catalog/catalog-manager"

// --- Module mocks --------------------------------------------------------- //

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

let mockIsAdmin = true
vi.mock("@/components/app-shell", () => ({
  useAppShell: () => ({
    user: { id: "user-1", email: "u@example.com", isAdmin: mockIsAdmin },
  }),
}))

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
  return {
    ApiError,
    jsonInit,
    apiFetch: vi.fn(),
    ATTRIBUTE_KEYS: [
      "strength",
      "agility",
      "endurance",
      "vitality",
      "toughness",
      "wisdom",
      "intelligence",
      "perception",
      "willpower",
    ],
  }
})

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}))

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: React.ComponentProps<"span">) => (
    <span>{children}</span>
  ),
}))

vi.mock("@/components/ui/alert", () => ({
  Alert: ({ children }: React.ComponentProps<"div">) => (
    <div role="alert">{children}</div>
  ),
}))

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
}))

vi.mock("@/components/ui/label", () => ({
  Label: ({ children, ...props }: React.ComponentProps<"label">) => (
    <label {...props}>{children}</label>
  ),
}))

vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: React.ComponentProps<"textarea">) => (
    <textarea {...props} />
  ),
}))

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    open,
    children,
    onOpenChange,
  }: React.ComponentProps<"div"> & {
    open?: boolean
    onOpenChange?: (open: boolean) => void
  }) =>
    open ? (
      <div>
        {children}
        <button onClick={() => onOpenChange?.(false)}>Mock close</button>
      </div>
    ) : null,
  DialogContent: ({ children, ...props }: React.ComponentProps<"div">) => (
    <div {...props}>{children}</div>
  ),
  DialogDescription: ({ children }: React.ComponentProps<"p">) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: React.ComponentProps<"div">) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: React.ComponentProps<"div">) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: React.ComponentProps<"h2">) => (
    <h2>{children}</h2>
  ),
}))

vi.mock("@/components/ui/select", () => {
  const SelectChange = React.createContext<(value: string) => void>(() => {})
  return {
    Select: ({
      children,
      onValueChange,
      disabled,
    }: React.ComponentProps<"div"> & {
      onValueChange?: (value: string) => void
      disabled?: boolean
    }) => {
      return (
        <SelectChange.Provider value={onValueChange ?? (() => {})}>
          <div data-disabled={disabled}>{children}</div>
        </SelectChange.Provider>
      )
    },
    SelectContent: ({ children }: React.ComponentProps<"div">) => (
      <div>{children}</div>
    ),
    SelectGroup: ({ children }: React.ComponentProps<"div">) => (
      <div>{children}</div>
    ),
    SelectItem: ({
      children,
      value,
    }: React.ComponentProps<"div"> & { value?: string }) => {
      const change = React.useContext(SelectChange)
      return (
        <button
          type="button"
          role="option"
          aria-selected={false}
          onClick={() => change(value ?? "")}
        >
          {children}
        </button>
      )
    },
    SelectTrigger: ({ children, ...props }: React.ComponentProps<"button">) => (
      <button
        role="combobox"
        aria-controls="select-options"
        aria-expanded={false}
        {...props}
      >
        {children}
      </button>
    ),
    SelectValue: () => <span />,
  }
})

vi.mock("@/components/ui/table", () => ({
  Table: ({ children }: React.ComponentProps<"table">) => (
    <table>{children}</table>
  ),
  TableBody: ({ children }: React.ComponentProps<"tbody">) => (
    <tbody>{children}</tbody>
  ),
  TableCell: ({ children }: React.ComponentProps<"td">) => <td>{children}</td>,
  TableHead: ({ children }: React.ComponentProps<"th">) => <th>{children}</th>,
  TableHeader: ({ children }: React.ComponentProps<"thead">) => (
    <thead>{children}</thead>
  ),
  TableRow: ({ children }: React.ComponentProps<"tr">) => <tr>{children}</tr>,
}))

// --- Fixture -------------------------------------------------------------- //

const item = {
  id: "bless-1",
  kind: "gods",
  stableId: "bless-1",
  name: "Blessing One",
  description: null,
  grade: null,
  provenance: "house",
  sourceUrl: null,
  archived: false,
  config: { tier: "Minor", effects: [] },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}

const preview = {
  source: "wiki-reviewed",
  entries: [
    {
      kind: "gods",
      stableId: "wiki-one",
      name: "Wiki One",
      sourceUrl: "https://wiki.example/one",
      provenance: "inferred",
      status: "create" as const,
    },
  ],
  createCount: 1,
  skipCount: 0,
}

// --- Helpers -------------------------------------------------------------- //

function setupMock() {
  const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
  mock.mockReset()
  mock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/admin/catalog-import") {
      if (init?.method === "POST") return { ...preview, createdIds: ["new-1"] }
      return preview
    }
    if (init?.method === "PATCH") {
      return { item }
    }
    if (url === "/api/catalog/gods") {
      return { kind: "gods", items: [item] }
    }
    throw new Error(`unexpected url ${url}`)
  })
  return mock
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

function patchCalls(mock: ReturnType<typeof vi.fn>) {
  return mock.mock.calls.filter(
    ([url, init]) =>
      typeof url === "string" &&
      url.startsWith("/api/catalog/gods/") &&
      (init as RequestInit | undefined)?.method === "PATCH"
  )
}

async function openEdit(itemName: string, mock: ReturnType<typeof vi.fn>) {
  render(<CatalogManager kind="gods" />)
  await flush()
  fireEvent.click(screen.getByLabelText("Edit"))
  await flush()
  return mock
}

// --- Tests ---------------------------------------------------------------- //

describe("CatalogManager config omission on edit", () => {
  afterEach(() => {
    mockIsAdmin = true
    cleanup()
  })

  it("omits `config` from a PATCH when the edited config is semantically unchanged", async () => {
    const mock = setupMock()
    await openEdit("Blessing One", mock)

    // The dialog is open and prefilled; leave the config field untouched.
    expect(
      (screen.getByLabelText("Config (JSON)") as HTMLTextAreaElement).value
    ).toBe(JSON.stringify(item.config, null, 2))

    fireEvent.click(screen.getByText("Save"))
    await flush()

    const calls = patchCalls(mock)
    expect(calls).toHaveLength(1)
    const body = JSON.parse(
      (calls[0][1] as RequestInit).body as string
    ) as Record<string, unknown>
    expect(body).not.toHaveProperty("config")
  })

  it("sends `config` on a PATCH when the edited config changed", async () => {
    const mock = setupMock()
    await openEdit("Blessing One", mock)

    const configField = screen.getByLabelText("Config (JSON)")
    fireEvent.change(configField, {
      target: { value: '{ "tier": "Major", "effects": [] }' },
    })
    fireEvent.click(screen.getByText("Save"))
    await flush()

    const calls = patchCalls(mock)
    expect(calls).toHaveLength(1)
    const body = JSON.parse(
      (calls[0][1] as RequestInit).body as string
    ) as Record<string, unknown>
    expect(body).toHaveProperty("config")
    expect((body.config as Record<string, unknown>).tier).toBe("Major")
  })

  it("edits per-tier blessing effects through the Gods advanced JSON editor", async () => {
    const mock = setupMock()
    const richer = {
      ...item,
      config: {
        blessingEffects: { True: [{ type: "x" }] },
        note: "keep",
      },
    }
    mock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === "PATCH"
        ? { item: richer }
        : { kind: "gods", items: [richer] }
    )
    render(<CatalogManager kind="gods" />)
    await flush()
    fireEvent.click(screen.getByLabelText("Edit"))
    const config = screen.getByLabelText("Config (JSON)") as HTMLTextAreaElement
    fireEvent.change(config, {
      target: {
        value: JSON.stringify({
          blessingEffects: { True: [{ type: "updated" }] },
        }),
      },
    })
    expect(
      JSON.parse(
        (screen.getByLabelText("Config (JSON)") as HTMLTextAreaElement).value
      )
    ).toEqual({ blessingEffects: { True: [{ type: "updated" }] } })
  })

  it("keeps gods config advanced and rejects invalid JSON without inventing effect inputs", async () => {
    const mock = setupMock()
    render(<CatalogManager kind="gods" />)
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "New entry" }))
    const field = screen.getByLabelText("Config (JSON)") as HTMLTextAreaElement
    fireEvent.change(field, { target: { value: '{ "pending":' } })
    expect(field.value).toBe('{ "pending":')
    expect(screen.getByText(/Invalid JSON/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "Legacy" },
    })
    fireEvent.click(screen.getByText("Save"))
    await flush()
    expect(screen.getByRole("alert")).toBeTruthy()
    expect(
      mock.mock.calls.some(
        ([url, init]) =>
          String(url) === "/api/catalog/gods" &&
          (init as RequestInit)?.method === "POST"
      )
    ).toBe(false)
  })

  it("bounds the edit dialog and keeps the config resizable", async () => {
    const mock = setupMock()
    await openEdit("Blessing One", mock)
    const dialog = screen.getByText("Edit entry").parentElement?.parentElement
    expect(dialog?.className).toContain("max-h-[calc(100dvh-2rem)]")
    expect(dialog?.className).toContain("overflow-hidden")
    const configField = screen.getByLabelText("Config (JSON)")
    expect(configField.className).toContain("max-h-[40vh]")
    expect(configField.className).toContain("resize-y")
    expect(screen.getByText("Save")).toBeTruthy()
    expect(screen.getByText("Mock close")).toBeTruthy()
  })

  it("loads archived entries only after an admin enables Show archived", async () => {
    const mock = setupMock()
    const archived = {
      ...item,
      id: "bless-archived",
      name: "Old Blessing",
      archived: true,
    }
    mock.mockImplementation(async (url: string) => ({
      kind: "gods",
      items: url.includes("includeArchived") ? [item, archived] : [item],
    }))
    render(<CatalogManager kind="gods" />)
    await flush()
    expect(
      mock.mock.calls.some(([url]) => String(url).includes("includeArchived=1"))
    ).toBe(false)
    fireEvent.click(screen.getByLabelText("Show archived"))
    await flush()
    expect(mock).toHaveBeenCalledWith("/api/catalog/gods?includeArchived=1")
    expect(screen.getByText("Archived")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Unarchive" })).toBeTruthy()
  })

  it("never requests archived entries for a non-admin", async () => {
    mockIsAdmin = false
    const mock = setupMock()
    render(<CatalogManager kind="gods" />)
    await flush()
    expect(
      mock.mock.calls.every(([url]) => !String(url).includes("includeArchived"))
    ).toBe(true)
    expect(screen.queryByLabelText("Show archived")).toBeNull()
  })

  it("unarchives with PATCH, confirms, and reloads while retaining archived view", async () => {
    const mock = setupMock()
    const archived = {
      ...item,
      id: "bless-archived",
      name: "Old Blessing",
      archived: true,
    }
    mock.mockImplementation(async (url: string) => ({
      kind: "gods",
      items: url.includes("includeArchived") ? [item, archived] : [item],
    }))
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true)
    )
    render(<CatalogManager kind="gods" />)
    await flush()
    fireEvent.click(screen.getByLabelText("Show archived"))
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Unarchive" }))
    await flush()
    const call = mock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("bless-archived") &&
        (init as RequestInit)?.method === "PATCH"
    )
    expect(call).toBeTruthy()
    expect(JSON.parse((call?.[1] as RequestInit).body as string)).toEqual({
      archived: false,
    })
    expect(
      mock.mock.calls.some(
        ([url]) => url === "/api/catalog/gods?includeArchived=1"
      )
    ).toBe(true)
    vi.unstubAllGlobals()
  })

  it("shows an actionable unarchive error", async () => {
    const mock = setupMock()
    const archived = {
      ...item,
      id: "bless-archived",
      name: "Old Blessing",
      archived: true,
    }
    mock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH")
        throw new Error("Permission denied; ask an administrator.")
      return {
        kind: "gods",
        items: url.includes("includeArchived") ? [item, archived] : [item],
      }
    })
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true)
    )
    render(<CatalogManager kind="gods" />)
    await flush()
    fireEvent.click(screen.getByLabelText("Show archived"))
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Unarchive" }))
    await flush()
    expect(
      screen.getByText(/Could not unarchive.*Permission denied/)
    ).toBeTruthy()
    vi.unstubAllGlobals()
  })

  it("previews without posting until confirmed, then applies and refreshes", async () => {
    const mock = setupMock()
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true)
    )
    render(<CatalogManager kind="gods" />)
    await flush()
    fireEvent.click(
      screen.getByRole("button", { name: "Import reviewed wiki entries" })
    )
    await flush()
    expect(screen.getByText("Wiki One")).toBeTruthy()
    expect(
      mock.mock.calls.some(
        ([url, init]) =>
          url === "/api/admin/catalog-import" &&
          (init as RequestInit | undefined)?.method === "POST"
      )
    ).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "Apply import" }))
    await flush()
    expect(screen.getByText("Created 1; skipped 0.")).toBeTruthy()
    expect(
      mock.mock.calls.some(
        ([url, init]) =>
          url === "/api/admin/catalog-import" &&
          (init as RequestInit | undefined)?.method === "POST"
      )
    ).toBe(true)
    expect(
      mock.mock.calls.filter(([url]) => url === "/api/catalog/gods").length
    ).toBeGreaterThan(1)
    vi.unstubAllGlobals()
  })

  it("does not expose importer to non-admins", async () => {
    mockIsAdmin = false
    const mock = setupMock()
    render(<CatalogManager kind="gods" />)
    await flush()
    expect(
      screen.queryByRole("button", { name: "Import reviewed wiki entries" })
    ).toBeNull()
    expect(
      mock.mock.calls.every(([url]) => url !== "/api/admin/catalog-import")
    ).toBe(true)
  })

  it("shows preview API failures", async () => {
    const mock = setupMock()
    mock.mockImplementation(async (url: string) => {
      if (url === "/api/admin/catalog-import")
        throw new Error("Preview unavailable")
      return { kind: "gods", items: [item] }
    })
    render(<CatalogManager kind="gods" />)
    await flush()
    fireEvent.click(
      screen.getByRole("button", { name: "Import reviewed wiki entries" })
    )
    await flush()
    expect(screen.getByText("Preview unavailable")).toBeTruthy()
  })
})

describe("grade skill grants", () => {
  afterEach(() => cleanup())

  function setupStructuredEdit(
    kind: "classes" | "professions",
    config: Record<string, unknown>
  ) {
    const record = {
      ...item,
      id: `${kind}-record-id`,
      kind,
      stableId: `${kind}-stable`,
      name: `Test ${kind}`,
      grade: "G",
      config,
    }
    const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
    mock.mockReset()
    mock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/api/catalog/${kind}`) return { items: [record] }
      if (url === "/api/catalog/skills")
        return {
          items: [
            {
              ...item,
              id: "db-skill-one",
              stableId: "skill-one",
              name: "Skill One",
              archived: false,
            },
            {
              ...item,
              id: "db-skill-two",
              stableId: "skill-two",
              name: "Skill Two",
              archived: false,
            },
          ],
        }
      if (init?.method === "PATCH") return { item: record }
      throw new Error(`unexpected url ${url}`)
    })
    return mock
  }

  function chooseGrantGrade(grade: string) {
    const controls = screen.getByLabelText("Grant grade")
    const button = [...controls.querySelectorAll("button")].find(
      (entry) => entry.textContent === grade
    )
    if (!button) throw new Error(`missing grade button ${grade}`)
    fireEvent.click(button)
  }

  function addGrant(stableId: string) {
    fireEvent.change(screen.getByLabelText("Skill to grant"), {
      target: { value: stableId },
    })
    fireEvent.click(screen.getByText("Add skill"))
  }

  function savedConfig(mock: ReturnType<typeof vi.fn>) {
    const call = mock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH"
    )
    return JSON.parse((call?.[1] as RequestInit).body as string)
      .config as Record<string, unknown>
  }

  it("saves distinct skill stable IDs by race grade without changing gains rows", async () => {
    const race = {
      ...item,
      id: "race-1",
      kind: "races",
      stableId: "race-one",
      name: "Race One",
      grade: "G",
      config: {
        naturalGrade: "G",
        raceType: "enlightened",
        raceDefinitions: {
          G: { id: "race-g", perLevel: { strength: 1 }, freePerLevel: 0 },
          F: { id: "race-f", perLevel: { agility: 2 }, freePerLevel: 1 },
        },
      },
    }
    const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
    mock.mockReset()
    mock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/catalog/races") return { items: [race] }
      if (url === "/api/catalog/skills")
        return {
          items: [
            {
              ...item,
              stableId: "skill-one",
              name: "Skill One",
              archived: false,
            },
            {
              ...item,
              stableId: "skill-two",
              name: "Skill Two",
              archived: false,
            },
          ],
        }
      if (init?.method === "PATCH") return { item: race }
      throw new Error(`unexpected url ${url}`)
    })
    render(<CatalogManager kind="races" />)
    await flush()
    fireEvent.click(screen.getByLabelText("Edit"))
    await flush()
    expect(screen.getByText("Race One")).toBeTruthy()
    const grantControls = screen.getByLabelText("Grant grade")
    fireEvent.click(
      [...grantControls.querySelectorAll("button")].find(
        (button) => button.textContent === "F"
      )!
    )
    const choice = screen.getByLabelText("Skill to grant")
    fireEvent.change(choice, { target: { value: "skill-one" } })
    fireEvent.click(screen.getByText("Add skill"))
    fireEvent.change(choice, { target: { value: "skill-one" } })
    expect((screen.getByText("Add skill") as HTMLButtonElement).disabled).toBe(
      true
    )
    fireEvent.change(choice, { target: { value: "skill-two" } })
    fireEvent.click(screen.getByText("Add skill"))
    expect(screen.getByText("Skill One")).toBeTruthy()
    expect(screen.getByText("Skill Two")).toBeTruthy()
    fireEvent.click(screen.getByText("Save"))
    await flush()
    const call = mock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH"
    )
    const body = JSON.parse((call?.[1] as RequestInit).body as string)
    expect(body.config.gradeGrantedSkillStableIds.F).toEqual([
      "skill-one",
      "skill-two",
    ])
    expect(body.config.raceDefinitions).toEqual(race.config.raceDefinitions)
  })

  it("keeps independent class skill grants across grade switches and persists stable IDs", async () => {
    const gains = {
      G: { fixed: { strength: 1 }, free: 2 },
      F: { fixed: { agility: 3 }, free: 4 },
    }
    const mock = setupStructuredEdit("classes", { grades: gains })
    render(<CatalogManager kind="classes" />)
    await flush()
    fireEvent.click(screen.getByLabelText("Edit"))
    await flush()
    chooseGrantGrade("F")
    addGrant("skill-one")
    addGrant("skill-two")
    expect((screen.getByText("Add skill") as HTMLButtonElement).disabled).toBe(
      true
    )
    chooseGrantGrade("G")
    addGrant("skill-two")
    chooseGrantGrade("F")
    expect(screen.getByText("Skill One")).toBeTruthy()
    expect(screen.getByText("Skill Two")).toBeTruthy()
    fireEvent.click(screen.getByText("Save"))
    await flush()
    const config = savedConfig(mock)
    expect(config.gradeGrantedSkillStableIds).toEqual({
      F: ["skill-one", "skill-two"],
      G: ["skill-two"],
    })
    expect(JSON.stringify(config.gradeGrantedSkillStableIds)).not.toContain(
      "db-skill"
    )
    expect(config.grades).toEqual(gains)
  })

  it("removes and adds profession grants while preserving grade gains", async () => {
    const gains = {
      G: { fixed: { wisdom: 2 }, free: 1 },
      F: { fixed: { vitality: 3 }, free: 2 },
    }
    const mock = setupStructuredEdit("professions", {
      grades: gains,
      gradeGrantedSkillStableIds: { G: ["skill-one", "skill-one"] },
    })
    render(<CatalogManager kind="professions" />)
    await flush()
    fireEvent.click(screen.getByLabelText("Edit"))
    await flush()
    expect(screen.getByText("Skill One")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Remove Skill One" }))
    addGrant("skill-two")
    fireEvent.click(screen.getByText("Save"))
    await flush()
    const config = savedConfig(mock)
    expect(config.gradeGrantedSkillStableIds).toEqual({ G: ["skill-two"] })
    expect(JSON.stringify(config.gradeGrantedSkillStableIds)).not.toContain(
      "db-skill"
    )
    expect(config.grades).toEqual(gains)
  })
})

describe("structured catalog editors", () => {
  afterEach(() => cleanup())

  function useCreateMock(kind: string) {
    const mock = setupMock()
    mock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return { item: { ...item, kind } }
      return { kind, items: [] }
    })
    return mock
  }

  it.each(["titles", "bloodlines", "transcendent_skills"])(
    "sends grade null when clearing an optional grade on %s",
    async (kind) => {
      const fixture = {
        ...item,
        kind,
        id: `${kind}-graded`,
        stableId: `${kind}-graded`,
        grade: "E",
        name: "Graded entry",
        config: {},
      }
      const mock = setupMock()
      mock.mockImplementation(async (_url: string, init?: RequestInit) =>
        init?.method === "PATCH"
          ? { item: fixture }
          : { kind, items: [fixture] }
      )
      render(<CatalogManager kind={kind as "titles"} />)
      await flush()
      fireEvent.click(screen.getByLabelText("Edit"))
      fireEvent.click(screen.getByRole("option", { name: "No grade" }))
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
      await flush()
      const request = mock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "PATCH"
      )
      expect(
        JSON.parse((request?.[1] as RequestInit).body as string).grade
      ).toBeNull()
    }
  )

  it("exposes grade choices through a select", async () => {
    useCreateMock("races")
    render(<CatalogManager kind="races" />)
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "New entry" }))
    const group = screen.getByLabelText("Natural grade")
    const gradeA = screen.getByRole("option", { name: "A" })
    fireEvent.click(gradeA)
    expect(group).toBeTruthy()
    expect(screen.queryByRole("radiogroup")).toBeNull()
  })

  it("creates a race with a deterministic A-grade row and preserves explicit zero", async () => {
    const mock = useCreateMock("races")
    render(<CatalogManager kind="races" />)
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "New entry" }))
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "Ashkin" },
    })
    fireEvent.click(screen.getByRole("option", { name: "A" }))
    fireEvent.change(screen.getByLabelText("Race type"), {
      target: { value: "monster" },
    })
    fireEvent.change(screen.getByLabelText("A strength"), {
      target: { value: "0" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()
    const request = mock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST"
    )
    expect(request).toBeTruthy()
    const body = JSON.parse((request?.[1] as RequestInit).body as string)
    expect(body.grade).toBe("A")
    expect(body.config.naturalGrade).toBe("A")
    expect(body.config.raceDefinitions.A).toMatchObject({
      id: "ashkin-a",
      perLevel: { strength: 0 },
      freePerLevel: 0,
    })
  })

  it("offers every schema rarity and does not require grade for equipment", async () => {
    const mock = useCreateMock("equipment")
    render(<CatalogManager kind="equipment" />)
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "New entry" }))
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "Helm" },
    })
    fireEvent.change(screen.getByLabelText("Slot"), {
      target: { value: "Head" },
    })
    fireEvent.change(screen.getByLabelText("Rarity"), {
      target: { value: "Ancient" },
    })
    expect(screen.getByRole("option", { name: "Sacred" })).toBeTruthy()
    expect(screen.queryByRole("option", { name: "Mythic" })).toBeNull()
    fireEvent.change(screen.getByLabelText("Minimum Level"), {
      target: { value: "0" },
    })
    fireEvent.click(screen.getByLabelText(/Soulbound/))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()
    const request = mock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST"
    )
    const body = JSON.parse((request?.[1] as RequestInit).body as string)
    expect(body).not.toHaveProperty("grade")
    expect(body.config).toMatchObject({
      slot: "Head",
      rarity: "Ancient",
      soulbound: true,
      minimumLevel: 0,
    })
  })

  it("creates an Item with optional E grade and one general description", async () => {
    const mock = useCreateMock("items")
    render(<CatalogManager kind="items" />)
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "New Item" }))
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "Charm" },
    })
    expect(screen.getAllByLabelText("Description")).toHaveLength(1)
    expect(screen.queryByLabelText("G-grade description")).toBeNull()
    fireEvent.click(screen.getByRole("option", { name: "E" }))
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "A small charm" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()
    const request = mock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST"
    )
    const body = JSON.parse((request?.[1] as RequestInit).body as string)
    expect(body).toMatchObject({ grade: "E", description: "A small charm" })
  })

  it("allows an Item's grade to be cleared on PATCH and has no free-text grade input", async () => {
    const fixture = {
      ...item,
      kind: "items",
      id: "item-1",
      grade: "E",
      name: "Charm",
      config: {},
    }
    const mock = setupMock()
    mock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return { item: fixture }
      return { kind: "items", items: [fixture] }
    })
    render(<CatalogManager kind="items" />)
    await flush()
    fireEvent.click(screen.getByLabelText("Edit"))
    expect(screen.queryByLabelText("G-grade description")).toBeNull()
    expect(screen.queryByRole("textbox", { name: "Grade" })).toBeNull()
    fireEvent.click(screen.getByRole("option", { name: "No grade" }))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()
    const request = mock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH"
    )
    expect(
      JSON.parse((request?.[1] as RequestInit).body as string).grade
    ).toBeNull()
  })

  it("hides God grade controls and omits grade on create", async () => {
    const mock = useCreateMock("gods")
    render(<CatalogManager kind="gods" />)
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "New entry" }))
    expect(screen.queryByLabelText("Grade")).toBeNull()
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "Sol" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()
    const request = mock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST"
    )
    expect(
      JSON.parse((request?.[1] as RequestInit).body as string)
    ).not.toHaveProperty("grade")
  })

  it("creates structured per-tier God bonuses with percentage basis points and no grade", async () => {
    const mock = useCreateMock("gods")
    render(<CatalogManager kind="gods" />)
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "New entry" }))
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "Sol" },
    })
    fireEvent.click(screen.getByRole("option", { name: "Major" }))
    fireEvent.click(screen.getByRole("button", { name: "Add effect" }))
    fireEvent.click(screen.getByRole("option", { name: "Percent" }))
    fireEvent.change(screen.getByLabelText("Effect 1 strength"), {
      target: { value: "2.5" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add effect" }))
    fireEvent.change(screen.getByLabelText("Effect 2 agility"), {
      target: { value: "-3" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()
    const request = mock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST"
    )
    const body = JSON.parse((request?.[1] as RequestInit).body as string)
    expect(body).not.toHaveProperty("grade")
    expect(body.config.blessingEffects.Major).toEqual([
      { phase: "percent", basisPoints: { strength: 250 } },
      { phase: "flat", amount: { agility: -3 } },
    ])
  })

  it("switches tiers without losing edits and preserves unrelated config while removing one tier", async () => {
    const god = {
      ...item,
      kind: "gods",
      grade: null,
      config: {
        blessingEffects: {
          True: [
            {
              phase: "flat",
              amount: { strength: 4 },
              condition: "night",
              group: "moon",
              stacking: "add",
            },
          ],
          Minor: [{ phase: "flat", amount: { wisdom: 1 } }],
        },
        note: "keep me",
        pantheon: "Dawn",
        divineRank: 7,
      },
    }
    const mock = setupMock()
    mock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === "PATCH" ? { item: god } : { kind: "gods", items: [god] }
    )
    render(<CatalogManager kind="gods" />)
    await flush()
    fireEvent.click(screen.getByLabelText("Edit"))
    fireEvent.click(screen.getByRole("option", { name: "True" }))
    expect(
      (screen.getByLabelText("Effect 1 strength") as HTMLInputElement).value
    ).toBe("4")
    fireEvent.click(screen.getByRole("option", { name: "Minor" }))
    expect(
      (screen.getByLabelText("Effect 1 wisdom") as HTMLInputElement).value
    ).toBe("1")
    fireEvent.change(screen.getByLabelText("Effect 1 wisdom"), {
      target: { value: "-2" },
    })
    fireEvent.click(screen.getByRole("option", { name: "True" }))
    expect(
      (screen.getByLabelText("Effect 1 strength") as HTMLInputElement).value
    ).toBe("4")
    fireEvent.click(screen.getByRole("button", { name: "Remove tier bonuses" }))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()
    const request = mock.mock.calls.find(
      ([url, init]) =>
        String(url).startsWith("/api/catalog/gods/") &&
        (init as RequestInit | undefined)?.method === "PATCH"
    )
    const body = JSON.parse((request?.[1] as RequestInit).body as string)
    expect(body.config).toMatchObject({
      blessingEffects: { Minor: [{ phase: "flat", amount: { wisdom: -2 } }] },
      note: "keep me",
      pantheon: "Dawn",
      divineRank: 7,
    })
    expect(body.config.blessingEffects).not.toHaveProperty("True")
    expect(body.config.blessingEffects).not.toHaveProperty("Major")
    expect(body).not.toHaveProperty("grade")
  })

  it("adds distinct catalog skills, removes one, and saves only stable ids", async () => {
    const mock = setupMock()
    const equipment = {
      ...item,
      kind: "equipment",
      id: "gear-1",
      stableId: "gear-1",
      name: "Helm",
      config: { slot: "Head", rarity: "Common" },
    }
    const skill = (stableId: string, name: string) => ({
      ...item,
      kind: "skills",
      stableId,
      name,
      archived: false,
      config: { tags: ["magic"] },
    })
    mock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/catalog/equipment")
        return { kind: "equipment", items: [equipment] }
      if (url === "/api/catalog/skills")
        return {
          kind: "skills",
          items: [
            skill("skill-one", "First Skill"),
            skill("skill-two", "Second Skill"),
          ],
        }
      if (init?.method === "PATCH") return { item: equipment }
      throw new Error(`unexpected url ${url}`)
    })
    render(<CatalogManager kind="equipment" />)
    await flush()
    fireEvent.click(screen.getByLabelText("Edit"))
    expect(screen.getByText("Granted skills (while equipped)")).toBeTruthy()
    const picker = screen.getByLabelText("Add a skill")
    fireEvent.change(picker, { target: { value: "skill-one" } })
    fireEvent.change(picker, { target: { value: "skill-two" } })
    expect(screen.getByText("First Skill")).toBeTruthy()
    expect(screen.getByText("Second Skill")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Remove First Skill" }))
    fireEvent.change(picker, { target: { value: "skill-two" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()
    const request = mock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH"
    )
    const body = JSON.parse((request?.[1] as RequestInit).body as string)
    expect(body.config.grantedSkillStableIds).toEqual(["skill-two"])
  })

  it("creates a class track row with all fixed stats and preserves explicit zero", async () => {
    const mock = useCreateMock("classes")
    render(<CatalogManager kind="classes" />)
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "New entry" }))
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "Vanguard" },
    })
    fireEvent.click(screen.getByRole("option", { name: "F" }))
    for (const key of [
      "strength",
      "agility",
      "endurance",
      "vitality",
      "toughness",
      "wisdom",
      "intelligence",
      "perception",
      "willpower",
    ]) {
      fireEvent.change(screen.getByLabelText(`F ${key}`), {
        target: { value: "0" },
      })
    }
    fireEvent.change(screen.getByLabelText("F Free points"), {
      target: { value: "0" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()
    const request = mock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST"
    )
    const body = JSON.parse((request?.[1] as RequestInit).body as string)
    expect(body.grade).toBe("F")
    expect(body.config.grades.F).toMatchObject({
      fixed: { strength: 0, willpower: 0 },
      free: 0,
    })
  })

  it("keeps malformed JSON text intact and disables structured controls/save", async () => {
    useCreateMock("equipment")
    render(<CatalogManager kind="equipment" />)
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "New entry" }))
    fireEvent.change(screen.getByLabelText("Config (JSON)"), {
      target: { value: "{broken" },
    })
    expect(
      (screen.getByLabelText("Config (JSON)") as HTMLTextAreaElement).value
    ).toBe("{broken")
    expect(screen.getByLabelText("Slot")).toHaveProperty("disabled", true)
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty(
      "disabled",
      true
    )
  })
})

describe("skill type and class priority", () => {
  afterEach(() => cleanup())

  it("requires a type before creating and submits classification by stable ID", async () => {
    const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
    mock.mockReset()
    mock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/catalog/skills") return { items: [] }
      if (url === "/api/catalog/classes")
        return {
          items: [
            {
              ...item,
              id: "db-class",
              stableId: "warrior",
              name: "Warrior",
              archived: false,
            },
          ],
        }
      if (init?.method === "POST") return { item }
      return { items: [] }
    })
    render(<CatalogManager kind="skills" />)
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "New entry" }))
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "Slash" },
    })
    fireEvent.change(screen.getByLabelText("Rarity"), {
      target: { value: "Common" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()
    expect(
      mock.mock.calls.some(
        ([, init]) => (init as RequestInit)?.method === "POST"
      )
    ).toBe(false)
    expect(screen.getByText("Choose a skill type before saving.")).toBeTruthy()
    fireEvent.click(screen.getByRole("option", { name: "Profession" }))
    fireEvent.change(screen.getByLabelText("Class tie"), {
      target: { value: "warrior" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()
    const call = mock.mock.calls.find(
      ([, init]) => (init as RequestInit)?.method === "POST"
    )
    const body = JSON.parse((call?.[1] as RequestInit).body as string)
    expect(body.config).toMatchObject({
      track: "profession",
      classStableId: "warrior",
      rarity: "Common",
    })
    expect(JSON.stringify(body)).not.toContain("db-class")
  })

  it.each(["Race", "Class"])("creates a %s skill", async (type) => {
    const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
    mock.mockReset()
    mock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/catalog/skills" || url === "/api/catalog/classes")
        return { items: [] }
      if (init?.method === "POST") return { item }
      return { items: [] }
    })
    render(<CatalogManager kind="skills" />)
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "New entry" }))
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: `${type} skill` },
    })
    fireEvent.change(screen.getByLabelText("Rarity"), {
      target: { value: "Common" },
    })
    fireEvent.click(screen.getByRole("option", { name: type }))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()
    const call = mock.mock.calls.find(
      ([, init]) => (init as RequestInit)?.method === "POST"
    )
    expect(
      JSON.parse((call?.[1] as RequestInit).body as string).config.track
    ).toBe(type.toLowerCase())
  })

  it("backfills a legacy skill as Race on edit and keeps legacy annotations on config changes", async () => {
    const fixture = {
      ...item,
      id: "db-skill",
      kind: "skills",
      stableId: "legacy-skill",
      name: "Legacy",
      config: {
        rarity: "Common",
        effects: [{ type: "damage", amount: 3 }],
        milestone: 12,
        eligibleDefinitionStableIds: ["def-alpha"],
      },
    }
    const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
    mock.mockReset()
    mock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/catalog/skills") return { items: [fixture] }
      if (url === "/api/catalog/classes") return { items: [] }
      if (init?.method === "PATCH") return { item: fixture }
      return { items: [] }
    })
    render(<CatalogManager kind="skills" />)
    await flush()
    fireEvent.click(screen.getByLabelText("Edit"))
    expect(
      screen.getByText(/Race is selected as the migrated default/)
    ).toBeTruthy()
    fireEvent.change(screen.getByLabelText("Config (JSON)"), {
      target: { value: JSON.stringify({ ...fixture.config, rarity: "Rare" }) },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()
    const call = mock.mock.calls.find(
      ([, init]) => (init as RequestInit)?.method === "PATCH"
    )
    expect(
      JSON.parse((call?.[1] as RequestInit).body as string).config
    ).toEqual({ ...fixture.config, rarity: "Rare" })
  })

  it("changes and clears class ties while preserving rarity, effects and legacy annotations", async () => {
    const fixture = {
      ...item,
      id: "db-skill",
      kind: "skills",
      stableId: "skill-x",
      name: "Skill",
      config: {
        track: "class",
        classStableId: "class-old",
        rarity: "Rare",
        effects: [{ kind: "damage" }],
        milestone: 4,
        eligibleDefinitionStableIds: ["definition-one"],
      },
    }
    const classes = ["class-old", "class-new"].map((stableId) => ({
      ...item,
      id: `db-${stableId}`,
      kind: "classes",
      stableId,
      name: stableId === "class-old" ? "Old Class" : "New Class",
      archived: false,
    }))
    const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
    mock.mockReset()
    mock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/catalog/skills") return { items: [fixture] }
      if (url === "/api/catalog/classes") return { items: classes }
      if (init?.method === "PATCH") return { item: fixture }
      return { items: [] }
    })
    render(<CatalogManager kind="skills" />)
    await flush()
    fireEvent.click(screen.getByLabelText("Edit"))
    const tie = screen.getByLabelText("Class tie")
    fireEvent.change(tie, { target: { value: "class-new" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()
    let call = mock.mock.calls.find(
      ([, init]) => (init as RequestInit)?.method === "PATCH"
    )
    let saved = JSON.parse((call?.[1] as RequestInit).body as string).config
    expect(saved).toMatchObject({
      track: "class",
      classStableId: "class-new",
      rarity: "Rare",
      effects: fixture.config.effects,
      milestone: 4,
      eligibleDefinitionStableIds: ["definition-one"],
    })
    cleanup()

    mock.mockClear()
    mock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/catalog/skills") return { items: [fixture] }
      if (url === "/api/catalog/classes") return { items: classes }
      if (init?.method === "PATCH") return { item: fixture }
      return { items: [] }
    })
    render(<CatalogManager kind="skills" />)
    await flush()
    fireEvent.click(screen.getByLabelText("Edit"))
    fireEvent.change(screen.getByLabelText("Class tie"), {
      target: { value: "" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()
    call = mock.mock.calls.find(
      ([, init]) => (init as RequestInit)?.method === "PATCH"
    )
    saved = JSON.parse((call?.[1] as RequestInit).body as string).config
    expect(saved).not.toHaveProperty("classStableId")
    expect(saved).toMatchObject({
      track: "class",
      rarity: "Rare",
      effects: fixture.config.effects,
      milestone: 4,
      eligibleDefinitionStableIds: ["definition-one"],
    })
  })

  it("keeps an existing archived class tie and shows its unavailable label", async () => {
    const fixture = {
      ...item,
      id: "db-skill",
      kind: "skills",
      stableId: "skill-x",
      name: "Skill",
      config: { track: "race", classStableId: "old-class", rarity: "Common" },
    }
    const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
    mock.mockReset()
    mock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/catalog/skills") return { items: [fixture] }
      if (url === "/api/catalog/classes") return { items: [] }
      if (init?.method === "PATCH") return { item: fixture }
      return { items: [] }
    })
    render(<CatalogManager kind="skills" />)
    await flush()
    fireEvent.click(screen.getByLabelText("Edit"))
    expect(
      screen.getByRole("option", { name: /old-class.*unavailable or archived/ })
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()
    const call = mock.mock.calls.find(
      ([, init]) => (init as RequestInit)?.method === "PATCH"
    )
    expect(
      JSON.parse((call?.[1] as RequestInit).body as string)
    ).not.toHaveProperty("config")
  })

  it("shows class loading errors and retries rather than saving against an unknown catalog", async () => {
    const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
    mock.mockReset()
    let classRequests = 0
    mock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/catalog/classes") {
        classRequests += 1
        if (classRequests === 1) throw new Error("Classes offline")
        return { items: [] }
      }
      if (url === "/api/catalog/skills") return { items: [] }
      if (init?.method === "POST") return { item }
      return { items: [] }
    })
    render(<CatalogManager kind="skills" />)
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "New entry" }))
    expect(screen.getByText("Classes offline")).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "Slash" },
    })
    fireEvent.change(screen.getByLabelText("Rarity"), {
      target: { value: "Common" },
    })
    fireEvent.click(screen.getByRole("option", { name: "Race" }))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()
    expect(
      mock.mock.calls.some(
        ([, init]) => (init as RequestInit)?.method === "POST"
      )
    ).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()
    expect(
      mock.mock.calls.some(
        ([, init]) => (init as RequestInit)?.method === "POST"
      )
    ).toBe(true)
  })
})

describe("structured catalog editor legacy and sparse rows", () => {
  afterEach(() => cleanup())

  function useEditMock(kind: string, fixture: Record<string, unknown>) {
    const mock = setupMock()
    mock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return { item: fixture }
      return { kind, items: [fixture] }
    })
    return mock
  }

  function useCreateMock(kind: string) {
    const mock = setupMock()
    mock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return { item: { ...item, kind } }
      return { kind, items: [] }
    })
    return mock
  }

  function patchCallsFor(mock: ReturnType<typeof vi.fn>, kind: string) {
    return mock.mock.calls.filter(
      ([url, init]) =>
        String(url).startsWith(`/api/catalog/${kind}/`) &&
        (init as RequestInit | undefined)?.method === "PATCH"
    )
  }

  it("lets clearing a legacy minimum level remove it on save", async () => {
    const legacyEquipment = {
      ...item,
      kind: "equipment",
      id: "equipment-legacy",
      stableId: "equipment-legacy",
      name: "Legacy equipment",
      config: {
        slot: "Head",
        rarity: "Common",
        minRaceLevel: 5,
        requiredRaceType: "enlightened",
      },
    }
    const mock = useEditMock("equipment", legacyEquipment)
    render(<CatalogManager kind="equipment" />)
    await flush()
    fireEvent.click(screen.getByLabelText("Edit"))
    const minimumLevel = screen.getByLabelText(
      "Minimum Level"
    ) as HTMLInputElement
    expect(minimumLevel.value).toBe("5")
    fireEvent.change(minimumLevel, { target: { value: "" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()

    const calls = patchCallsFor(mock, "equipment")
    const body = JSON.parse((calls[0][1] as RequestInit).body as string)
    expect(body.config).not.toHaveProperty("minimumLevel")
    expect(body.config).not.toHaveProperty("minRaceLevel")
    expect(body.config).not.toHaveProperty("requiredRaceType")
    expect(body.config.requiredLevelType).toBe("humanoidRace")
  })

  it("converts legacy equipment requirements when saving without edits", async () => {
    const legacyEquipment = {
      ...item,
      kind: "equipment",
      id: "equipment-legacy",
      stableId: "equipment-legacy",
      name: "Legacy equipment",
      config: {
        slot: "Head",
        rarity: "Common",
        minRaceLevel: 5,
        requiredRaceType: "monster",
      },
    }
    const mock = useEditMock("equipment", legacyEquipment)
    render(<CatalogManager kind="equipment" />)
    await flush()
    fireEvent.click(screen.getByLabelText("Edit"))
    expect(
      (screen.getByLabelText("Minimum Level") as HTMLInputElement).value
    ).toBe("5")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()

    const calls = patchCallsFor(mock, "equipment")
    const body = JSON.parse((calls[0][1] as RequestInit).body as string)
    expect(body.config).toMatchObject({
      minimumLevel: 5,
      requiredLevelType: "monstrousRace",
    })
    expect(body.config).not.toHaveProperty("minRaceLevel")
    expect(body.config).not.toHaveProperty("requiredRaceType")
  })

  it("patches naturalGrade from the grade field when editing a legacy race lacking config.naturalGrade", async () => {
    const legacyRace = {
      ...item,
      kind: "races",
      id: "race-legacy",
      stableId: "race-legacy",
      name: "Legacy Race",
      grade: "F",
      config: {
        raceType: "enlightened",
        raceDefinitions: {
          F: {
            id: "legacy-race:F",
            perLevel: { strength: 1 },
            freePerLevel: 2,
          },
        },
      },
    }
    const mock = useEditMock("races", legacyRace)
    render(<CatalogManager kind="races" />)
    await flush()
    fireEvent.click(screen.getByLabelText("Edit"))
    await flush()
    fireEvent.change(screen.getByLabelText("Race type"), {
      target: { value: "monster" },
    })
    fireEvent.click(screen.getByText("Save"))
    await flush()
    const calls = patchCallsFor(mock, "races")
    expect(calls).toHaveLength(1)
    const body = JSON.parse(
      (calls[0][1] as RequestInit).body as string
    ) as Record<string, unknown>
    expect((body.config as Record<string, unknown>).naturalGrade).toBe("F")
    expect((body.config as Record<string, unknown>).raceType).toBe("monster")
  })

  it("edits a graded row's legacy description without using it as a grade fallback", async () => {
    const graded = {
      ...item,
      kind: "classes",
      id: "class-graded",
      stableId: "class-graded",
      name: "Graded Class",
      grade: "F",
      description: "Legacy overview",
      config: { grades: { F: { fixed: {}, free: 0 } } },
      gradeDescriptions: {},
    }
    const mock = useEditMock("classes", graded)
    render(<CatalogManager kind="classes" />)
    await flush()
    fireEvent.click(screen.getByLabelText("Edit"))
    await flush()

    expect(screen.queryByLabelText("Description")).toBeNull()
    fireEvent.click(
      screen.getByText(
        "Legacy general description (not displayed in grade tabs)"
      )
    )
    const legacyField = screen.getByLabelText("Legacy general description")
    expect((legacyField as HTMLTextAreaElement).value).toBe("Legacy overview")
    const gradeField = screen.getByLabelText("G-grade description")
    expect((gradeField as HTMLTextAreaElement).value).toBe("")
    fireEvent.change(legacyField, { target: { value: "Updated legacy text" } })
    fireEvent.click(screen.getByText("Save"))
    await flush()

    const calls = patchCallsFor(mock, "classes")
    const body = JSON.parse((calls[0][1] as RequestInit).body as string)
    expect(body.description).toBe("Updated legacy text")
    expect(body).not.toHaveProperty("gradeDescriptions")
  })

  it("permits a metadata-only edit of a legacy class with a sparse fixed row and omits config", async () => {
    const legacyClass = {
      ...item,
      kind: "classes",
      id: "class-legacy",
      stableId: "class-legacy",
      name: "Legacy Class",
      grade: "F",
      config: { grades: { F: { fixed: {}, free: 0 } } },
    }
    const mock = useEditMock("classes", legacyClass)
    render(<CatalogManager kind="classes" />)
    await flush()
    fireEvent.click(screen.getByLabelText("Edit"))
    await flush()
    fireEvent.click(screen.getByRole("tab", { name: "F" }))
    fireEvent.change(screen.getByLabelText("F-grade description"), {
      target: { value: "Updated grade text" },
    })
    fireEvent.click(screen.getByText("Save"))
    await flush()
    const calls = patchCallsFor(mock, "classes")
    expect(calls).toHaveLength(1)
    const body = JSON.parse(
      (calls[0][1] as RequestInit).body as string
    ) as Record<string, unknown>
    expect(body).not.toHaveProperty("config")
    expect(body.gradeDescriptions).toEqual({ F: "Updated grade text" })
  })

  it("creates a race entering only free points, serializing a sparse perLevel vector", async () => {
    const mock = useCreateMock("races")
    render(<CatalogManager kind="races" />)
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "New entry" }))
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "Ashkin" },
    })
    fireEvent.click(screen.getByRole("option", { name: "A" }))
    fireEvent.change(screen.getByLabelText("Race type"), {
      target: { value: "monster" },
    })
    fireEvent.change(screen.getByLabelText("A Free points"), {
      target: { value: "3" },
    })
    fireEvent.click(screen.getByText("Save"))
    await flush()
    const request = mock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST"
    )
    expect(request).toBeTruthy()
    const body = JSON.parse((request?.[1] as RequestInit).body as string)
    expect(body.config.raceDefinitions.A).toEqual({
      id: "ashkin-a",
      freePerLevel: 3,
      perLevel: {},
    })
  })

  it("serializes a class row with only free points as a valid sparse fixed vector and no extra rows", async () => {
    const mock = useCreateMock("classes")
    render(<CatalogManager kind="classes" />)
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "New entry" }))
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "Vanguard" },
    })
    fireEvent.click(screen.getByRole("option", { name: "F" }))
    fireEvent.change(screen.getByLabelText("F Free points"), {
      target: { value: "2" },
    })
    fireEvent.click(screen.getByText("Save"))
    await flush()
    const request = mock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST"
    )
    expect(request).toBeTruthy()
    const body = JSON.parse((request?.[1] as RequestInit).body as string)
    expect(body.config.grades).toEqual({ F: { fixed: {}, free: 2 } })
  })

  it("rejects a negative free-point value and prevents the create from being sent", async () => {
    const mock = useCreateMock("races")
    render(<CatalogManager kind="races" />)
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "New entry" }))
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "Ashkin" },
    })
    fireEvent.click(screen.getByRole("option", { name: "A" }))
    fireEvent.change(screen.getByLabelText("Race type"), {
      target: { value: "monster" },
    })
    fireEvent.change(screen.getByLabelText("A Free points"), {
      target: { value: "-1" },
    })
    fireEvent.click(screen.getByText("Save"))
    await flush()
    expect(
      screen.getByText(/free points must be a nonnegative integer/)
    ).toBeTruthy()
    expect(
      mock.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST"
      )
    ).toBe(false)
  })
})

describe("CatalogManager import preview staleness", () => {
  afterEach(() => {
    mockIsAdmin = true
    vi.unstubAllGlobals()
    cleanup()
  })

  const afterPreview = {
    source: "wiki-reviewed" as const,
    entries: [
      {
        kind: "gods",
        stableId: "wiki-one",
        name: "Wiki One",
        sourceUrl: "https://wiki.example/one",
        provenance: "inferred",
        status: "skip_existing" as const,
      },
    ],
    createCount: 0,
    skipCount: 1,
  }

  it("disables Apply when a preview refresh fails after a prior success", async () => {
    const mock = setupMock()
    let failPreview = false
    mock.mockImplementation(async (url: string) => {
      if (url === "/api/admin/catalog-import") {
        if (failPreview) throw new Error("Preview unavailable")
        return preview
      }
      if (url === "/api/catalog/gods") {
        return { kind: "gods", items: [item] }
      }
      throw new Error(`unexpected url ${url}`)
    })
    render(<CatalogManager kind="gods" />)
    await flush()
    fireEvent.click(
      screen.getByRole("button", { name: "Import reviewed wiki entries" })
    )
    await flush()
    // A successful preview with a creatable entry leaves Apply enabled.
    expect(
      (
        screen.getByRole("button", {
          name: "Apply import",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false)
    // The next refresh fails, so the stale preview must be cleared and Apply
    // disabled rather than pointing at an unrefreshable preview.
    failPreview = true
    fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }))
    await flush()
    expect(screen.getByText("Preview unavailable")).toBeTruthy()
    expect(
      (
        screen.getByRole("button", {
          name: "Apply import",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
  })

  it("shows an all-skipped result and refreshes the preview to zero creates", async () => {
    const mock = setupMock()
    let applied = false
    mock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/admin/catalog-import") {
        if (init?.method === "POST") {
          applied = true
          return { ...afterPreview, createdIds: [] }
        }
        return applied ? afterPreview : preview
      }
      if (url === "/api/catalog/gods") {
        return { kind: "gods", items: [item] }
      }
      throw new Error(`unexpected url ${url}`)
    })
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true)
    )
    render(<CatalogManager kind="gods" />)
    await flush()
    fireEvent.click(
      screen.getByRole("button", { name: "Import reviewed wiki entries" })
    )
    await flush()
    expect(screen.getByText("1 to create; 0 to skip existing.")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Apply import" }))
    await flush()
    // Nothing was created; the result reports the skip count clearly.
    expect(screen.getByText("Created 0; skipped 1.")).toBeTruthy()
    // The refreshed preview now shows everything as skip_existing, so Apply is
    // disabled (zero creates) instead of being controllable against stale data.
    expect(screen.getByText("0 to create; 1 to skip existing.")).toBeTruthy()
    expect(
      (
        screen.getByRole("button", {
          name: "Apply import",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
  })

  it("keeps the dialog open with an actionable error and no success on a 409 apply", async () => {
    const mock = setupMock()
    mock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/admin/catalog-import") {
        if (init?.method === "POST")
          throw new ApiError(
            409,
            "conflict",
            "Manifest changed; preview is stale."
          )
        return preview
      }
      if (url === "/api/catalog/gods") {
        return { kind: "gods", items: [item] }
      }
      throw new Error(`unexpected url ${url}`)
    })
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true)
    )
    render(<CatalogManager kind="gods" />)
    await flush()
    fireEvent.click(
      screen.getByRole("button", { name: "Import reviewed wiki entries" })
    )
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Apply import" }))
    await flush()
    // The dialog is preserved after the failure.
    expect(screen.getByRole("button", { name: "Apply import" })).toBeTruthy()
    // No fabricated success message.
    expect(screen.queryByText(/^Created/)).toBeNull()
    // The error is actionable and points at refreshing the preview to retry.
    expect(screen.getByText(/Refresh the preview and retry/)).toBeTruthy()
    // Apply is disabled while the preview is known-stale from the conflict.
    expect(
      (
        screen.getByRole("button", {
          name: "Apply import",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
    // The existing catalog view is not reloaded/overwritten on failure: only the
    // initial load fetch was issued.
    const catalogFetches = mock.mock.calls.filter(
      ([url]) => url === "/api/catalog/gods"
    )
    expect(catalogFetches).toHaveLength(1)
  })
})

describe("ranked title catalog controls", () => {
  afterEach(() => cleanup())

  const ranked = (
    id: string,
    name: string,
    rank: number,
    archived = false
  ) => ({
    ...item,
    id,
    kind: "titles",
    stableId: id,
    name,
    archived,
    grade: null,
    config: {
      improvement: { seriesId: "dungeon", rank, minRaceGrade: "G" },
      upgradeGroup: "dungeon",
      note: "kept",
    },
  })

  function mockTitles(
    entries: ReturnType<typeof ranked>[],
    save?: () => Promise<never>
  ) {
    const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
    mock.mockReset()
    mock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("includeArchived")) return { items: entries }
      if (init?.method === "PATCH") {
        if (save) return save()
        return { item: entries[0] }
      }
      return { items: entries.filter((entry) => !entry.archived) }
    })
    return mock
  }

  it("creates a ranked title through fields and atomically mirrors upgradeGroup", async () => {
    const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
    mock.mockReset()
    mock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "POST" ? { item } : { items: [] }
    )
    render(<CatalogManager kind="titles" />)
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "New entry" }))
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "Dungeon Pioneer II" },
    })
    fireEvent.click(screen.getByRole("checkbox", { name: "Ranked series" }))
    fireEvent.change(screen.getByLabelText("Series ID"), {
      target: { value: "dungeon-pioneer" },
    })
    fireEvent.change(screen.getByLabelText("Rank"), { target: { value: "2" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()
    const call = mock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST"
    )
    const body = JSON.parse((call?.[1] as RequestInit).body as string)
    expect(body.config.improvement).toEqual({
      seriesId: "dungeon-pioneer",
      rank: 2,
      minRaceGrade: "G",
    })
    expect(body.config.upgradeGroup).toBe("dungeon-pioneer")
  })

  it("edits rank and series through structured fields without JSON", async () => {
    const title = ranked("title-1", "Dungeon One", 1)
    const mock = mockTitles([title])
    render(<CatalogManager kind="titles" />)
    await flush()
    fireEvent.click(
      screen.getByRole("button", { name: "Expand series dungeon" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Edit Dungeon One" }))
    fireEvent.change(screen.getByLabelText("Rank"), { target: { value: "3" } })
    fireEvent.change(screen.getByLabelText("Series ID"), {
      target: { value: "new-ladder" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()
    const call = mock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH"
    )
    const config = JSON.parse((call?.[1] as RequestInit).body as string).config
    expect(config.improvement).toEqual({
      seriesId: "new-ladder",
      rank: 3,
      minRaceGrade: "G",
    })
    expect(config.upgradeGroup).toBe("new-ladder")
    expect(config.note).toBe("kept")
  })

  it("clears ranking while preserving an unrelated manual upgradeGroup", async () => {
    const title = {
      ...ranked("title-1", "Dungeon One", 1),
      config: {
        ...ranked("title-1", "Dungeon One", 1).config,
        upgradeGroup: "manual-group",
      },
    }
    const mock = mockTitles([title])
    render(<CatalogManager kind="titles" />)
    await flush()
    fireEvent.click(
      screen.getByRole("button", { name: "Expand series dungeon" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Edit Dungeon One" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Ranked series" }))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()
    const call = mock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH"
    )
    const config = JSON.parse((call?.[1] as RequestInit).body as string).config
    expect(config).not.toHaveProperty("improvement")
    expect(config.upgradeGroup).toBe("manual-group")
  })

  it("groups titles, expands/collapses, searches a matched rank and offers per-rank editing", async () => {
    const mock = mockTitles([
      ranked("title-1", "Dungeon One", 1),
      ranked("title-2", "Hidden Dungeon Two", 2),
    ])
    render(<CatalogManager kind="titles" />)
    await flush()
    expect(
      screen.getByRole("button", { name: "Expand series dungeon" })
    ).toBeTruthy()
    expect(screen.queryByText("Dungeon One")).toBeNull()
    fireEvent.click(
      screen.getByRole("button", { name: "Expand series dungeon" })
    )
    expect(screen.getByText("Dungeon One")).toBeTruthy()
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse series dungeon" })
    )
    expect(screen.queryByText("Dungeon One")).toBeNull()
    fireEvent.change(screen.getByLabelText("Search"), {
      target: { value: "title-2" },
    })
    expect(screen.getByText("Hidden Dungeon Two")).toBeTruthy()
    expect(screen.queryByText("Dungeon One")).toBeNull()
    fireEvent.click(
      screen.getByRole("button", { name: "Edit Hidden Dungeon Two" })
    )
    expect(screen.getByLabelText("Rank")).toBeTruthy()
    expect(mock).toHaveBeenCalled()
  })

  it("keeps archived ranked titles hidden until enabled and exposes their child action", async () => {
    const old = ranked("old", "Archived Rank", 4, true)
    const mock = mockTitles([old])
    render(<CatalogManager kind="titles" />)
    await flush()
    expect(screen.queryByText("Archived Rank")).toBeNull()
    fireEvent.click(screen.getByLabelText("Show archived"))
    await flush()
    expect(
      screen.getByRole("button", { name: "Expand series dungeon" })
    ).toBeTruthy()
    fireEvent.click(
      screen.getByRole("button", { name: "Expand series dungeon" })
    )
    expect(screen.getByText("Archived")).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "Edit Archived Rank" })
    ).toBeTruthy()
    expect(mock).toHaveBeenCalledWith("/api/catalog/titles?includeArchived=1")
  })

  it("leaves unranked titles standalone and shows an actionable identity conflict", async () => {
    const standalone = {
      ...ranked("plain", "Unranked Title", 1),
      config: { upgradeGroup: "manual" },
    } as ReturnType<typeof ranked>
    mockTitles([standalone], async () => {
      throw new ApiError(409, "conflict", "Title is linked.")
    })
    render(<CatalogManager kind="titles" />)
    await flush()
    expect(screen.getByText("Unranked Title")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /series dungeon/i })).toBeNull()
    fireEvent.click(screen.getByLabelText("Edit"))
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "Changed Identity" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()
    expect(screen.getByRole("alert").textContent).toContain(
      "ask an administrator to resolve the link"
    )
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy()
  })
})

describe("CatalogManager import preview existing metadata", () => {
  afterEach(() => {
    mockIsAdmin = true
    vi.unstubAllGlobals()
    cleanup()
  })

  const skipPreview = (existing: {
    id: string
    name: string
    sourceUrl: string | null
    provenance: string
    archived: boolean
  }) => ({
    source: "wiki-reviewed" as const,
    entries: [
      {
        kind: "titles",
        stableId: "legendary-prodigy",
        name: "Legendary Prodigy",
        sourceUrl:
          "https://the-primal-hunter.fandom.com/wiki/Legendary_Prodigy",
        provenance: "inferred",
        status: "skip_existing" as const,
        existing,
      },
    ],
    createCount: 0,
    skipCount: 1,
  })

  function seedSkipMock(existing: {
    id: string
    name: string
    sourceUrl: string | null
    provenance: string
    archived: boolean
  }) {
    const mock = setupMock()
    mock.mockImplementation(async (url: string) => {
      if (url === "/api/admin/catalog-import") return skipPreview(existing)
      if (url === "/api/catalog/gods") {
        return { kind: "gods", items: [item] }
      }
      throw new Error(`unexpected url ${url}`)
    })
    return mock
  }

  async function openImportPreview() {
    render(<CatalogManager kind="gods" />)
    await flush()
    fireEvent.click(
      screen.getByRole("button", { name: "Import reviewed wiki entries" })
    )
    await flush()
  }

  it("displays the proposed manifest source and the preserved existing row for a skip", async () => {
    seedSkipMock({
      id: "house-title",
      name: "Old House Title",
      sourceUrl: "https://house.example/old",
      provenance: "house",
      archived: true,
    })
    await openImportPreview()
    // The proposed manifest source is still shown (name, wiki URL).
    expect(screen.getByText("Legendary Prodigy")).toBeTruthy()
    expect(
      screen.getByText(
        "https://the-primal-hunter.fandom.com/wiki/Legendary_Prodigy"
      )
    ).toBeTruthy()
    // The preserved existing house row is shown with its ACTUAL source URL, never
    // the proposed manifest one.
    expect(
      screen.getByText(/Existing preserved: Old House Title - Archived/)
    ).toBeTruthy()
    expect(screen.getByText("https://house.example/old")).toBeTruthy()
    // The row is clearly marked as a skip, not a create.
    expect(screen.getByText("Skip existing")).toBeTruthy()
    expect(screen.queryByText("Create")).toBeNull()
  })

  it("shows the actual preserved metadata even when the existing row has no source URL", async () => {
    seedSkipMock({
      id: "house-title",
      name: "Old House Title",
      sourceUrl: null,
      provenance: "house",
      archived: false,
    })
    await openImportPreview()
    expect(screen.getByText("Existing preserved: Old House Title")).toBeTruthy()
    expect(screen.getByText("No source URL")).toBeTruthy()
    expect(
      screen.queryByText(
        "https://the-primal-hunter.fandom.com/wiki/Legendary_Prodigy"
      )
    ).toBeTruthy()
  })
})

describe("CatalogManager bulk imports", () => {
  afterEach(() => {
    mockIsAdmin = true
    vi.unstubAllGlobals()
    cleanup()
  })

  const bulkPreview = (digest = "digest-1", skipped = false) => ({
    source: "bulk" as const,
    previewDigest: digest,
    entries: [
      {
        row: 2,
        kind: "gods",
        stableId: "custom-one",
        name: "Custom One",
        sourceUrl: "https://example.test/source",
        provenance: "inferred",
        status: skipped ? ("skip_existing" as const) : ("create" as const),
        ...(skipped
          ? {
              existing: {
                id: "old-id",
                name: "Existing One",
                sourceUrl: "https://old.test",
                provenance: "house",
                archived: true,
              },
            }
          : {}),
      },
    ],
    createCount: skipped ? 0 : 1,
    skipCount: skipped ? 1 : 0,
  })

  function seedBulkMock() {
    const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
    mock.mockReset()
    let applied = false
    mock.mockImplementation(async (url: string) => {
      if (url === "/api/catalog/gods") return { kind: "gods", items: [item] }
      if (url === "/api/admin/catalog-import/bulk/preview")
        return bulkPreview("digest-1", applied)
      if (url === "/api/admin/catalog-import/bulk/apply") {
        applied = true
        return { ...bulkPreview("digest-1", true), createdIds: ["created-id"] }
      }
      throw new Error(`unexpected url ${url}`)
    })
    return mock
  }

  async function chooseFile(name = "catalog.json") {
    const file = new File(['{"entries":[]}'], name, {
      type: "application/json",
    })
    Object.defineProperty(file, "text", {
      value: vi.fn(async () => '{"entries":[]}'),
    })
    fireEvent.change(screen.getByLabelText(/Catalog file/), {
      target: { files: [file] },
    })
    await flush()
  }

  it("previews without applying until the explicit confirmed action", async () => {
    const mock = seedBulkMock()
    const confirm = vi.fn(() => true)
    vi.stubGlobal("confirm", confirm)
    render(<CatalogManager kind="gods" />)
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Import CSV/JSON" }))
    await chooseFile()
    fireEvent.click(screen.getByRole("button", { name: "Preview file" }))
    await flush()
    expect(screen.getByText("Custom One")).toBeTruthy()
    expect(
      mock.mock.calls.some(
        ([url]) => url === "/api/admin/catalog-import/bulk/apply"
      )
    ).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "Apply import" }))
    await flush()
    expect(confirm).toHaveBeenCalled()
    expect(screen.getByText("Created 1; skipped 1.")).toBeTruthy()
    expect(
      screen.getByText(/Existing preserved: Existing One - Archived/)
    ).toBeTruthy()
  })

  it("invalidates preview when the selected file changes", async () => {
    seedBulkMock()
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true)
    )
    render(<CatalogManager kind="gods" />)
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Import CSV/JSON" }))
    await chooseFile()
    fireEvent.click(screen.getByRole("button", { name: "Preview file" }))
    await flush()
    expect(
      (
        screen.getByRole("button", {
          name: "Apply import",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false)
    await chooseFile("replacement.csv")
    expect(screen.queryByText("Custom One")).toBeNull()
    expect(
      (
        screen.getByRole("button", {
          name: "Apply import",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
    expect(screen.getByText(/Detected format: csv/)).toBeTruthy()
  })

  it("keeps apply disabled and reports errors without false success", async () => {
    const mock = seedBulkMock()
    mock.mockImplementation(async (url: string) => {
      if (url === "/api/catalog/gods") return { kind: "gods", items: [item] }
      if (url === "/api/admin/catalog-import/bulk/preview") return bulkPreview()
      if (url === "/api/admin/catalog-import/bulk/apply")
        throw new ApiError(409, "conflict", "Preview digest mismatch.")
      throw new Error("unexpected")
    })
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true)
    )
    render(<CatalogManager kind="gods" />)
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Import CSV/JSON" }))
    await chooseFile()
    fireEvent.click(screen.getByRole("button", { name: "Preview file" }))
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Apply import" }))
    await flush()
    expect(screen.getByText(/Re-preview the file before applying/)).toBeTruthy()
    expect(screen.queryByText(/^Created/)).toBeNull()
    expect(
      (
        screen.getByRole("button", {
          name: "Apply import",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
  })

  it("preserves successful apply counts when refresh preview fails and retries the same file", async () => {
    const mock = seedBulkMock()
    let failRefresh = false
    let failedOnce = false
    mock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/catalog/gods") return { kind: "gods", items: [item] }
      if (url === "/api/admin/catalog-import/bulk/preview") {
        if (failRefresh && !failedOnce && init?.method === "POST") {
          failedOnce = true
          throw new Error("temporary preview outage")
        }
        return bulkPreview("digest-1", failedOnce)
      }
      if (url === "/api/admin/catalog-import/bulk/apply") {
        failRefresh = true
        return {
          ...bulkPreview("digest-1", true),
          skipCount: 2,
          createdIds: ["id-1", "id-2"],
        }
      }
      throw new Error(`unexpected url ${url}`)
    })
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true)
    )
    render(<CatalogManager kind="gods" />)
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Import CSV/JSON" }))
    await chooseFile()
    fireEvent.click(screen.getByRole("button", { name: "Preview file" }))
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Apply import" }))
    await flush()
    expect(screen.getByText("Created 2; skipped 2.")).toBeTruthy()
    expect(
      screen.getByText("Import succeeded, but refresh failed. Retry preview")
    ).toBeTruthy()
    expect(screen.queryByText("Import failed.")).toBeNull()
    expect(
      (
        screen.getByRole("button", {
          name: "Apply import",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Retry preview" }))
    await flush()
    expect(screen.getByText("Created 2; skipped 2.")).toBeTruthy()
    expect(
      mock.mock.calls.filter(
        ([url]) => url === "/api/admin/catalog-import/bulk/preview"
      )
    ).toHaveLength(3)
  })

  it("only applies the newest response from overlapping previews of the same file", async () => {
    const mock = seedBulkMock()
    let previewCount = 0
    let resolveOld!: (value: ReturnType<typeof bulkPreview>) => void
    mock.mockImplementation(async (url: string) => {
      if (url === "/api/catalog/gods") return { kind: "gods", items: [item] }
      if (url === "/api/admin/catalog-import/bulk/preview") {
        previewCount += 1
        if (previewCount === 2)
          return new Promise((resolve) => {
            resolveOld = resolve
          })
        return bulkPreview("newest", true)
      }
      throw new Error(`unexpected url ${url}`)
    })
    render(<CatalogManager kind="gods" />)
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Import CSV/JSON" }))
    await chooseFile()
    fireEvent.click(screen.getByRole("button", { name: "Preview file" }))
    await flush()
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Preview file" }))
      fireEvent.click(screen.getByRole("button", { name: "Preview file" }))
    })
    await flush()
    resolveOld(bulkPreview("older", false))
    await flush()
    expect(screen.getByText("Skip existing")).toBeTruthy()
  })

  it("ignores a delayed file read after selecting a different file and applies the new file content", async () => {
    const mock = seedBulkMock()
    const confirm = vi.fn(() => true)
    vi.stubGlobal("confirm", confirm)
    render(<CatalogManager kind="gods" />)
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Import CSV/JSON" }))
    let resolveOld!: (value: string) => void
    const oldFile = new File(["old"], "old.json")
    Object.defineProperty(oldFile, "text", {
      value: () =>
        new Promise<string>((resolve) => {
          resolveOld = resolve
        }),
    })
    fireEvent.change(screen.getByLabelText(/Catalog file/), {
      target: { files: [oldFile] },
    })
    const newFile = new File(["new"], "new.json")
    Object.defineProperty(newFile, "text", {
      value: async () => '{"entries":[{"name":"B"}]}',
    })
    fireEvent.change(screen.getByLabelText(/Catalog file/), {
      target: { files: [newFile] },
    })
    await flush()
    resolveOld('{"entries":[{"name":"A"}]}')
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Preview file" }))
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Apply import" }))
    await flush()
    const apply = mock.mock.calls.find(
      ([url]) => url === "/api/admin/catalog-import/bulk/apply"
    )
    expect(JSON.parse((apply?.[1] as RequestInit).body as string).content).toBe(
      '{"entries":[{"name":"B"}]}'
    )
  })

  it("ignores an old preview response and keeps Apply disabled until the new preview resolves", async () => {
    const mock = seedBulkMock()
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true)
    )
    let resolveOld!: (value: ReturnType<typeof bulkPreview>) => void
    mock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/catalog/gods") return { kind: "gods", items: [item] }
      if (
        url === "/api/admin/catalog-import/bulk/preview" &&
        (init?.body as string).includes("A")
      )
        return new Promise((resolve) => {
          resolveOld = resolve
        })
      if (url === "/api/admin/catalog-import/bulk/preview")
        return bulkPreview("digest-B")
      if (url === "/api/admin/catalog-import/bulk/apply")
        return { ...bulkPreview(), createdIds: ["id"] }
      throw new Error(`unexpected url ${url}`)
    })
    render(<CatalogManager kind="gods" />)
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Import CSV/JSON" }))
    const choose = (name: string, text: string) => {
      const file = new File([text], name)
      Object.defineProperty(file, "text", { value: async () => text })
      fireEvent.change(screen.getByLabelText(/Catalog file/), {
        target: { files: [file] },
      })
    }
    choose("a.json", "A")
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Preview file" }))
    choose("b.json", "B")
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Preview file" }))
    await flush()
    resolveOld(bulkPreview("digest-A"))
    await flush()
    expect(
      (
        screen.getByRole("button", {
          name: "Apply import",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "Apply import" }))
    await flush()
    const apply = mock.mock.calls.find(
      ([url]) => url === "/api/admin/catalog-import/bulk/apply"
    )
    expect(JSON.parse((apply?.[1] as RequestInit).body as string).content).toBe(
      "B"
    )
  })

  it("does not restore pending file state after closing and reopening", async () => {
    seedBulkMock()
    render(<CatalogManager kind="gods" />)
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Import CSV/JSON" }))
    let resolve!: (value: string) => void
    const file = new File(["old"], "old.json")
    Object.defineProperty(file, "text", {
      value: () =>
        new Promise<string>((done) => {
          resolve = done
        }),
    })
    fireEvent.change(screen.getByLabelText(/Catalog file/), {
      target: { files: [file] },
    })
    fireEvent.click(screen.getByRole("button", { name: "Mock close" }))
    fireEvent.click(screen.getByRole("button", { name: "Import CSV/JSON" }))
    resolve("old")
    await flush()
    expect(screen.getByText(/Detected format: not selected/)).toBeTruthy()
    expect(
      (
        screen.getByRole("button", {
          name: "Apply import",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
  })

  it("never renders bulk import controls or calls bulk endpoints for non-admins", async () => {
    mockIsAdmin = false
    const mock = setupMock()
    render(<CatalogManager kind="gods" />)
    await flush()
    expect(screen.queryByRole("button", { name: "Import CSV/JSON" })).toBeNull()
    expect(
      mock.mock.calls.every(
        ([url]) => !String(url).includes("/api/admin/catalog-import/bulk/")
      )
    ).toBe(true)
  })
})

describe("grade descriptions and equipment stats", () => {
  afterEach(() => cleanup())

  const catalogItem = (kind: string, extra: Record<string, unknown> = {}) => ({
    ...item,
    id: `${kind}-one`,
    kind,
    stableId: `${kind}-one`,
    name: `${kind} one`,
    ...extra,
  })

  function mockKind(
    kind: string,
    fixture: Record<string, unknown> | null = null
  ) {
    const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
    mock.mockReset()
    mock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH" || init?.method === "POST")
        return { item: fixture ?? catalogItem(kind) }
      if (url === `/api/catalog/${kind}`)
        return { kind, items: fixture ? [fixture] : [] }
      if (url === "/api/catalog/classes") return { kind: "classes", items: [] }
      if (url === "/api/catalog/gods")
        return {
          kind: "gods",
          items: [
            catalogItem("gods", {
              stableId: "goddess-moon",
              name: "Moon Goddess",
            }),
          ],
        }
      throw new Error(`unexpected URL ${url}`)
    })
    return mock
  }

  const bodyOf = (mock: ReturnType<typeof vi.fn>, method: string) => {
    const call = mock.mock.calls.find(
      ([, init]) => (init as RequestInit)?.method === method
    )
    return JSON.parse((call?.[1] as RequestInit).body as string)
  }

  it.each(["races", "skills"])(
    "POSTs grade descriptions for %s",
    async (kind) => {
      const mock = mockKind(kind)
      render(<CatalogManager kind={kind} />)
      await flush()
      fireEvent.click(screen.getByRole("button", { name: "New entry" }))
      fireEvent.change(screen.getByLabelText(/Name/), {
        target: { value: "New entry" },
      })
      if (kind === "races")
        fireEvent.click(screen.getByRole("option", { name: "G" }))
      else fireEvent.click(screen.getByRole("option", { name: "Race" }))
      fireEvent.change(screen.getByLabelText("G-grade description"), {
        target: { value: "  Grade G copy  " },
      })
      fireEvent.change(screen.getByLabelText("Config (JSON)"), {
        target: {
          value:
            kind === "races"
              ? JSON.stringify({
                  naturalGrade: "G",
                  raceType: "enlightened",
                  raceDefinitions: {
                    G: { id: "g", perLevel: {}, freePerLevel: 0 },
                  },
                })
              : JSON.stringify({ rarity: "Common" }),
        },
      })
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
      await flush()
      expect(bodyOf(mock, "POST").gradeDescriptions).toEqual({
        G: "Grade G copy",
      })
    }
  )

  it.each(["skills", "gods"])(
    "PATCHes only gradeDescriptions on legacy %s without config",
    async (kind) => {
      const legacy = catalogItem(kind, {
        grade: "B",
        description: "legacy general",
        config:
          kind === "gods"
            ? { grade: "old", effect: "legacy" }
            : { rarity: "Common", legacy: true },
      })
      const mock = mockKind(kind, legacy)
      render(<CatalogManager kind={kind} />)
      await flush()
      fireEvent.click(screen.getByLabelText("Edit"))
      await flush()
      fireEvent.change(screen.getByLabelText("G-grade description"), {
        target: { value: "G text" },
      })
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
      await flush()
      expect(bodyOf(mock, "PATCH")).toMatchObject({
        gradeDescriptions: { G: "G text" },
      })
      expect(bodyOf(mock, "PATCH")).not.toHaveProperty("config")
    }
  )

  it("renders eight grade tabs without general-description fallback and hides the general field when graded", async () => {
    const graded = catalogItem("skills", {
      grade: "A",
      description: "general text",
      gradeDescriptions: { A: "A text" },
    })
    mockKind("skills", graded)
    render(<CatalogManager kind="skills" />)
    await flush()
    fireEvent.click(screen.getByLabelText("Edit"))
    await flush()
    expect(screen.getAllByRole("tab")).toHaveLength(8)
    expect(screen.queryByLabelText("Description")).toBeNull()
    expect(
      (screen.getByLabelText("G-grade description") as HTMLTextAreaElement)
        .value
    ).toBe("")
    expect(screen.getByText("No description for this grade")).toBeTruthy()
    fireEvent.click(screen.getByRole("tab", { name: "A" }))
    expect(
      (screen.getByLabelText("A-grade description") as HTMLTextAreaElement)
        .value
    ).toBe("A text")
  })

  it("clears a grade description by sending an empty map and keeps the general field for ungraded items", async () => {
    const legacy = catalogItem("skills", {
      grade: null,
      description: "General",
      gradeDescriptions: { G: "text" },
    })
    const mock = mockKind("skills", legacy)
    render(<CatalogManager kind="skills" />)
    await flush()
    fireEvent.click(screen.getByLabelText("Edit"))
    await flush()
    expect(screen.getByLabelText("Description")).toBeTruthy()
    fireEvent.change(screen.getByLabelText("G-grade description"), {
      target: { value: "   " },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()
    expect(bodyOf(mock, "PATCH").gradeDescriptions).toEqual({})
  })

  it("edits flat/percent stats sparsely, retains unknown keys, and rejects invalid values", async () => {
    const equipment = catalogItem("equipment", {
      config: {
        slot: "Head",
        rarity: "Common",
        bonus: { agility: 2 },
        percentBasisPoints: { vitality: 500 },
        note: "keep",
      },
    })
    const mock = mockKind("equipment", equipment)
    render(<CatalogManager kind="equipment" />)
    await flush()
    fireEvent.click(screen.getByLabelText("Edit"))
    await flush()
    fireEvent.change(screen.getByLabelText("strength flat"), {
      target: { value: "3" },
    })
    fireEvent.change(screen.getByLabelText("strength percent"), {
      target: { value: "12.5" },
    })
    fireEvent.change(screen.getByLabelText("agility flat"), {
      target: { value: "" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()
    expect(bodyOf(mock, "PATCH").config).toMatchObject({
      bonus: {},
      percentBasisPoints: { strength: 1250, vitality: 500 },
      note: "keep",
    })
    cleanup()
    const second = mockKind("equipment", equipment)
    render(<CatalogManager kind="equipment" />)
    await flush()
    fireEvent.click(screen.getByLabelText("Edit"))
    await flush()
    fireEvent.change(screen.getByLabelText("strength flat"), {
      target: { value: "-1" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()
    expect(screen.getByRole("alert").textContent).toMatch(/finite nonnegative/)
    expect(
      second.mock.calls.some(
        ([, init]) => (init as RequestInit)?.method === "PATCH"
      )
    ).toBe(false)
  })

  it("serializes canonical equipment level and god requirements plus derived percentages", async () => {
    const mock = mockKind("equipment")
    render(<CatalogManager kind="equipment" />)
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "New entry" }))
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "Moonward" },
    })
    fireEvent.change(screen.getByLabelText("Slot"), {
      target: { value: "Head" },
    })
    fireEvent.change(screen.getByLabelText("Rarity"), {
      target: { value: "Common" },
    })
    fireEvent.change(screen.getByLabelText("Minimum Level"), {
      target: { value: "12" },
    })
    fireEvent.change(screen.getByLabelText("Required Level Type"), {
      target: { value: "class" },
    })
    fireEvent.change(screen.getByLabelText("Required God"), {
      target: { value: "goddess-moon" },
    })
    fireEvent.change(screen.getByLabelText("Minimum Blessing Tier"), {
      target: { value: "Major" },
    })
    fireEvent.change(screen.getByLabelText("HP derived flat"), {
      target: { value: "15" },
    })
    fireEvent.change(screen.getByLabelText("HP derived percent"), {
      target: { value: "25" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()
    expect(bodyOf(mock, "POST").config).toMatchObject({
      minimumLevel: 12,
      requiredLevelType: "class",
      requiredGodStableId: "goddess-moon",
      minimumBlessingTier: "Major",
      derivedFlat: { hp: 15 },
      derivedPercentBasisPoints: { hp: 2500 },
    })
    expect(bodyOf(mock, "POST").config).not.toHaveProperty("minRaceLevel")
  })

  it.each([
    ["enlightened", "humanoidRace"],
    ["monster", "monstrousRace"],
  ])(
    "converts legacy race requirement %s to %s",
    async (legacyType, canonicalType) => {
      const equipment = catalogItem("equipment", {
        config: {
          slot: "Head",
          rarity: "Common",
          minRaceLevel: 7,
          requiredRaceType: legacyType,
        },
      })
      const mock = mockKind("equipment", equipment)
      render(<CatalogManager kind="equipment" />)
      await flush()
      fireEvent.click(screen.getByLabelText("Edit"))
      await flush()
      fireEvent.change(screen.getByLabelText("Description"), {
        target: { value: "edited" },
      })
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
      await flush()
      const config = bodyOf(mock, "PATCH").config
      expect(config).toMatchObject({
        minimumLevel: 7,
        requiredLevelType: canonicalType,
      })
      expect(config).not.toHaveProperty("minRaceLevel")
      expect(config).not.toHaveProperty("requiredRaceType")
    }
  )

  it("only offers Ring and warns for normalized legacy Ring 1 config while permitting metadata-only edit", async () => {
    const equipment = catalogItem("equipment", {
      config: { slot: "Ring 1", rarity: "Common", custom: true },
    })
    const mock = mockKind("equipment", equipment)
    render(<CatalogManager kind="equipment" />)
    await flush()
    fireEvent.click(screen.getByLabelText("Edit"))
    await flush()
    const options = screen.getByLabelText("Slot").querySelectorAll("option")
    expect(
      [...options].some((option) => option.textContent?.includes("Ring1"))
    ).toBe(false)
    expect([...options].some((option) => option.textContent === "Ring")).toBe(
      true
    )
    expect(
      screen
        .getAllByRole("alert")
        .some((alert) => alert.textContent?.includes("Legacy Ring 1"))
    ).toBe(true)
    fireEvent.change(screen.getByLabelText(/Description/), {
      target: { value: "metadata" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()
    expect(bodyOf(mock, "PATCH")).not.toHaveProperty("config")
  })

  it("creates a generic Item with an empty config and no type or amount", async () => {
    const mock = mockKind("items")
    render(<CatalogManager kind="items" />)
    await flush()
    expect(screen.getByRole("heading", { name: "Items" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "New Item" }))
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "Moonstone" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()
    expect(mock.mock.calls.some(([url]) => url === "/api/catalog/items")).toBe(
      true
    )
    const body = bodyOf(mock, "POST")
    expect(body).toMatchObject({ name: "Moonstone", config: {} })
    expect(body).not.toHaveProperty("type")
    expect(body).not.toHaveProperty("amount")
  })
})
