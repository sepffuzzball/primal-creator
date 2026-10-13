// @vitest-environment jsdom
import * as React from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { apiFetch } from "@/lib/api"
import { CatalogManager } from "@/components/catalog/catalog-manager"

// --- Module mocks --------------------------------------------------------- //

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock("@/components/app-shell", () => ({
  useAppShell: () => ({
    user: { id: "user-1", email: "u@example.com", isAdmin: true },
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

// --- Helpers -------------------------------------------------------------- //

function setupMock() {
  const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
  mock.mockReset()
  mock.mockImplementation(async (url: string, init?: RequestInit) => {
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
})
