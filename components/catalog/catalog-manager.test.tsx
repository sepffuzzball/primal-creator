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
  return { ApiError, jsonInit, apiFetch: vi.fn() }
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
  }: React.ComponentProps<"div"> & { open?: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: React.ComponentProps<"div">) => (
    <div>{children}</div>
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

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: React.ComponentProps<"div">) => <div>{children}</div>,
  SelectContent: ({ children }: React.ComponentProps<"div">) => (
    <div>{children}</div>
  ),
  SelectItem: ({ children }: React.ComponentProps<"div">) => (
    <div>{children}</div>
  ),
  SelectTrigger: ({ children }: React.ComponentProps<"button">) => (
    <button>{children}</button>
  ),
  SelectValue: () => <span />,
}))

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
  kind: "blessings",
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
      kind: "blessings",
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
    if (url === "/api/catalog/blessings") {
      return { kind: "blessings", items: [item] }
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
      url.startsWith("/api/catalog/blessings/") &&
      (init as RequestInit | undefined)?.method === "PATCH"
  )
}

async function openEdit(itemName: string, mock: ReturnType<typeof vi.fn>) {
  render(<CatalogManager kind="blessings" />)
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

  it("loads archived entries only after an admin enables Show archived", async () => {
    const mock = setupMock()
    const archived = {
      ...item,
      id: "bless-archived",
      name: "Old Blessing",
      archived: true,
    }
    mock.mockImplementation(async (url: string) => ({
      kind: "blessings",
      items: url.includes("includeArchived") ? [item, archived] : [item],
    }))
    render(<CatalogManager kind="blessings" />)
    await flush()
    expect(
      mock.mock.calls.some(([url]) => String(url).includes("includeArchived=1"))
    ).toBe(false)
    fireEvent.click(screen.getByLabelText("Show archived"))
    await flush()
    expect(mock).toHaveBeenCalledWith(
      "/api/catalog/blessings?includeArchived=1"
    )
    expect(screen.getByText("Archived")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Unarchive" })).toBeTruthy()
  })

  it("never requests archived entries for a non-admin", async () => {
    mockIsAdmin = false
    const mock = setupMock()
    render(<CatalogManager kind="blessings" />)
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
      kind: "blessings",
      items: url.includes("includeArchived") ? [item, archived] : [item],
    }))
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true)
    )
    render(<CatalogManager kind="blessings" />)
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
        ([url]) => url === "/api/catalog/blessings?includeArchived=1"
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
        kind: "blessings",
        items: url.includes("includeArchived") ? [item, archived] : [item],
      }
    })
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true)
    )
    render(<CatalogManager kind="blessings" />)
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
    render(<CatalogManager kind="blessings" />)
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
      mock.mock.calls.filter(([url]) => url === "/api/catalog/blessings").length
    ).toBeGreaterThan(1)
    vi.unstubAllGlobals()
  })

  it("does not expose importer to non-admins", async () => {
    mockIsAdmin = false
    const mock = setupMock()
    render(<CatalogManager kind="blessings" />)
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
      return { kind: "blessings", items: [item] }
    })
    render(<CatalogManager kind="blessings" />)
    await flush()
    fireEvent.click(
      screen.getByRole("button", { name: "Import reviewed wiki entries" })
    )
    await flush()
    expect(screen.getByText("Preview unavailable")).toBeTruthy()
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
        kind: "blessings",
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
      if (url === "/api/catalog/blessings") {
        return { kind: "blessings", items: [item] }
      }
      throw new Error(`unexpected url ${url}`)
    })
    render(<CatalogManager kind="blessings" />)
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
      if (url === "/api/catalog/blessings") {
        return { kind: "blessings", items: [item] }
      }
      throw new Error(`unexpected url ${url}`)
    })
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true)
    )
    render(<CatalogManager kind="blessings" />)
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
      if (url === "/api/catalog/blessings") {
        return { kind: "blessings", items: [item] }
      }
      throw new Error(`unexpected url ${url}`)
    })
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true)
    )
    render(<CatalogManager kind="blessings" />)
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
      ([url]) => url === "/api/catalog/blessings"
    )
    expect(catalogFetches).toHaveLength(1)
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
      if (url === "/api/catalog/blessings") {
        return { kind: "blessings", items: [item] }
      }
      throw new Error(`unexpected url ${url}`)
    })
    return mock
  }

  async function openImportPreview() {
    render(<CatalogManager kind="blessings" />)
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
    // The proposed manifest source is still shown (name, wiki URL, Inferred).
    expect(screen.getByText("Legendary Prodigy")).toBeTruthy()
    expect(
      screen.getByText(
        "https://the-primal-hunter.fandom.com/wiki/Legendary_Prodigy"
      )
    ).toBeTruthy()
    expect(screen.getByText("Inferred")).toBeTruthy()
    // The preserved existing house row is shown with its ACTUAL provenance and
    // URL, never labelled Inferred.
    expect(
      screen.getByText(
        /Existing preserved: Old House Title \(house\) - Archived/
      )
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
    expect(
      screen.getByText("Existing preserved: Old House Title (house)")
    ).toBeTruthy()
    expect(screen.getByText("No source URL")).toBeTruthy()
    expect(
      screen.queryByText(
        "https://the-primal-hunter.fandom.com/wiki/Legendary_Prodigy"
      )
    ).toBeTruthy()
  })
})
