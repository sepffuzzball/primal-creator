// @vitest-environment jsdom
import * as React from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { apiFetch } from "@/lib/api"
import { CharacterDetail } from "@/components/characters/character-detail"

// --- Module mocks --------------------------------------------------------- //

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "chr-1" }),
}))

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock("@/components/app-shell", () => ({
  useAppShell: () => ({
    user: { id: "user-1", email: "u@example.com", isAdmin: false },
    refreshUser: vi.fn(),
    logout: vi.fn(),
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
  const ATTRIBUTE_KEYS = [
    "strength",
    "agility",
    "endurance",
    "vitality",
    "toughness",
    "wisdom",
    "intelligence",
    "perception",
    "willpower",
  ] as const
  return { ApiError, jsonInit, apiFetch: vi.fn(), ATTRIBUTE_KEYS }
})

// Mock the shadcn UI primitives to plain elements so the client component renders
// deterministically in jsdom without Radix portals / observers.
vi.mock("@/components/ui/avatar", () => ({
  Avatar: ({ children }: React.ComponentProps<"div">) => <div>{children}</div>,
  AvatarFallback: ({ children }: React.ComponentProps<"span">) => (
    <span>{children}</span>
  ),
  AvatarImage: () => <span data-testid="avatar-image" />,
}))

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
  buttonVariants: () => "mock-button",
}))

vi.mock("@/components/ui/alert", () => ({
  Alert: ({ children }: React.ComponentProps<"div">) => (
    <div role="alert">{children}</div>
  ),
}))

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: React.ComponentProps<"span">) => (
    <span>{children}</span>
  ),
}))

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: React.ComponentProps<"div">) => <div>{children}</div>,
  CardContent: ({ children }: React.ComponentProps<"div">) => (
    <div>{children}</div>
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

vi.mock("@/components/ui/separator", () => ({
  Separator: () => <hr />,
}))

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: React.ComponentProps<"div">) => <div>{children}</div>,
  TabsList: ({ children }: React.ComponentProps<"div">) => (
    <div>{children}</div>
  ),
  TabsContent: ({ children }: React.ComponentProps<"div">) => (
    <div>{children}</div>
  ),
  TabsTrigger: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}))

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: React.ComponentProps<"div">) => <div>{children}</div>,
  SheetContent: ({ children }: React.ComponentProps<"div">) => (
    <div>{children}</div>
  ),
  SheetDescription: ({ children }: React.ComponentProps<"p">) => (
    <p>{children}</p>
  ),
  SheetHeader: ({ children }: React.ComponentProps<"div">) => (
    <div>{children}</div>
  ),
  SheetTitle: ({ children }: React.ComponentProps<"h3">) => <h3>{children}</h3>,
}))

vi.mock("@/components/ui/dialog", () => {
  // Gate on `open` exactly like Radix Dialog, so an open evolve dialog is the
  // only content mounted when we assert on its contents.
  return {
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
  }
})

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

const character = {
  id: "chr-1",
  name: "Test",
  description: null,
  origin: "integrated",
  raceId: "race-human",
  classId: "cls-1",
  professionId: null,
  raceName: "Human",
  className: "Archer",
  professionName: null,
  state: {
    baseAttributes: {
      strength: 0,
      agility: 0,
      endurance: 0,
      vitality: 0,
      toughness: 0,
      wisdom: 0,
      intelligence: 0,
      perception: 0,
      willpower: 0,
    },
    tracks: {
      class: { level: 20, quarter: 0, definitionId: "" },
      profession: { level: 0, quarter: 0, definitionId: "" },
    },
    race: { level: 25, grade: "G", mode: "derived", origin: "integrated" },
    historicalLevelAwards: [],
    allocations: [],
    permanentGains: [],
    activeEffects: [],
    equipment: [],
    currentResources: {},
    turn: 0,
  },
  version: 3,
  archived: false,
  imported: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  associations: [],
  skillOffers: [],
  permanentConsumableCap: {},
  permanentConsumableRemaining: {},
} as unknown as import("@/lib/api").CharacterDetail

let evolutionsError: unknown = null

function setupMock() {
  const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
  mock.mockReset()
  mock.mockImplementation(async (url: string) => {
    if (url === "/api/characters/chr-1") return { character }
    if (url === "/api/characters/chr-1/portrait") return { portrait: null }
    if (url === "/api/characters/chr-1/evolutions") {
      if (evolutionsError) throw evolutionsError
      return { options: [], legacyAvailable: true }
    }
    throw new Error(`unexpected url ${url}`)
  })
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

async function renderDetail() {
  render(<CharacterDetail />)
  await flush()
}

beforeEach(() => {
  evolutionsError = null
})

afterEach(() => {
  cleanup()
})

// --- Tests ---------------------------------------------------------------- //

describe("CharacterDetail evolution options error state", () => {
  it("shows a retry and hides the legacy fallback/action when evolution options fail to load", async () => {
    setupMock()
    evolutionsError = new Error("network down")

    await renderDetail()

    // Open the evolve dialog. At grade G / level 25 the client target is E, so the
    // button is enabled.
    fireEvent.click(screen.getByText(/Evolve grade/))
    await flush()

    // No false availability claim: the failed options fetch must NOT be shown as
    // a legacy fallback. Instead the user is told options could not load and gets
    // a retry.
    expect(screen.getByText("Could not load evolution options.")).toBeTruthy()
    expect(screen.getByText("Retry")).toBeTruthy()
    expect(screen.queryByText(/Grade-only/)).toBeNull()
    expect(
      screen.queryByText("No evolution options are available yet.")
    ).toBeNull()

    // The action is withheld: the submit button is disabled.
    const submitBtn = screen.getByText(/Evolve to E/).closest("button")
    expect(submitBtn?.disabled).toBe(true)
  })

  it("recovers via the retry button once the evolution options fetch succeeds", async () => {
    setupMock()
    evolutionsError = new Error("network down")

    await renderDetail()
    fireEvent.click(screen.getByText(/Evolve grade/))
    await flush()

    expect(screen.getByText("Retry")).toBeTruthy()

    // The network recovers; the retry fetch now succeeds with the legacy fallback
    // available (no catalog path targets the next grade F).
    evolutionsError = null
    fireEvent.click(screen.getByText("Retry"))
    await flush()

    // The error/retry UI is gone and the legacy fallback is now honestly reported.
    expect(screen.queryByText("Could not load evolution options.")).toBeNull()
    expect(screen.getByText(/No contextual race evolution path/)).toBeTruthy()

    const submitBtn = screen.getByText(/Evolve to E/).closest("button")
    expect(submitBtn?.disabled).toBe(false)
  })
})
