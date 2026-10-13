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

import { toast } from "sonner"

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
  Select: ({
    children,
    onValueChange,
  }: React.ComponentProps<"div"> & {
    value?: string
    onValueChange?: (value: string) => void
  }) => (
    <div
      onClick={(event) => {
        const item = (event.target as HTMLElement).closest("[data-value]")
        if (item) onValueChange?.(item.getAttribute("data-value") ?? "")
      }}
    >
      {children}
    </div>
  ),
  SelectContent: ({ children }: React.ComponentProps<"div">) => (
    <div>{children}</div>
  ),
  SelectGroup: ({ children }: React.ComponentProps<"div">) => (
    <div>{children}</div>
  ),
  SelectLabel: ({ children }: React.ComponentProps<"div">) => (
    <div>{children}</div>
  ),
  SelectItem: ({
    children,
    value,
  }: React.ComponentProps<"div"> & { value?: string }) => (
    <div data-value={value}>{children}</div>
  ),
  SelectTrigger: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <span>{placeholder}</span>
  ),
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
  inventory: [],
  skillOffers: [],
  permanentConsumableCap: {},
  permanentConsumableRemaining: {},
} as unknown as import("@/lib/api").CharacterDetail

let evolutionsError: unknown = null
let associationsError: unknown = null
let blessingsCatalog: import("@/lib/api").CatalogItem[] = []
let bloodlinesCatalog: import("@/lib/api").CatalogItem[] = []
let transcendentCatalog: import("@/lib/api").CatalogItem[] = []
let equipmentCatalog: import("@/lib/api").CatalogItem[] = []
let consumablesCatalog: import("@/lib/api").CatalogItem[] = []
let inventoryError: unknown = null
let inventoryPosts: Array<{
  operation: "add" | "remove"
  definitionId: string
  quantity: number
  version: number
  sourceNote: string
}> = []
let activeCharacter: import("@/lib/api").CharacterDetail = character

/** Build a blessing/bloodline catalog item with documented defaults. */
function catalogItem(
  overrides: Partial<import("@/lib/api").CatalogItem> & {
    id: string
    name: string
  }
): import("@/lib/api").CatalogItem {
  const { id, name, kind, ...rest } = overrides
  return {
    id,
    kind: kind ?? "blessing",
    stableId: id,
    name,
    description: null,
    grade: null,
    provenance: "house",
    sourceUrl: null,
    archived: false,
    config: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...rest,
  } as import("@/lib/api").CatalogItem
}

/** Build a linked power association with documented defaults. */
function association(
  overrides: Partial<import("@/lib/api").CharacterAssociationView> & {
    id: string
    kind:
      | "blessing"
      | "bloodline"
      | "transcendent"
      | "equipment"
      | "title"
      | "skill"
    definitionId: string
    name: string
    /** Only meaningful on equipment links (export-only marker). */
    legacyUnowned?: boolean
  }
): import("@/lib/api").CharacterAssociationView {
  const { id, kind, definitionId, name, ...rest } = overrides
  return {
    id,
    kind,
    definitionId,
    name,
    definitionArchived: false,
    ...rest,
  } as import("@/lib/api").CharacterAssociationView
}

/** Build an owned inventory row with documented defaults. */
function inventoryItem(
  overrides: Partial<import("@/lib/api").CharacterInventoryItem> & {
    id: string
    definitionId: string
    name: string
    kind: "equipment" | "consumables"
    quantity: number
  }
): import("@/lib/api").CharacterInventoryItem {
  const { id, definitionId, name, kind, quantity, ...rest } = overrides
  return {
    id,
    definitionId,
    name,
    kind,
    quantity,
    archived: false,
    provenance: "house",
    ...rest,
  } as import("@/lib/api").CharacterInventoryItem
}

/**
 * Mutate the in-memory character the way the associations route would, so a
 * subsequent reload reflects the add/remove. The version is left untouched - the
 * tests assert that both add and remove carry `character.version`.
 */
function applyAssociation(
  current: import("@/lib/api").CharacterDetail,
  body: {
    kind: "blessing" | "bloodline" | "transcendent"
    definitionId: string
    operation: "add" | "remove"
    version: number
  }
): import("@/lib/api").CharacterDetail {
  if (body.operation === "add") {
    const source =
      body.kind === "blessing"
        ? blessingsCatalog
        : body.kind === "bloodline"
          ? bloodlinesCatalog
          : transcendentCatalog
    const item = source.find((c) => c.id === body.definitionId)
    const assoc = association({
      id: `${body.kind}-${body.definitionId}`,
      kind: body.kind,
      definitionId: body.definitionId,
      name: item?.name ?? body.definitionId,
      ...(typeof item?.config?.upgradeGroup === "string"
        ? { upgradeGroup: item.config.upgradeGroup as string }
        : {}),
      ...(item?.grade ? { grade: item.grade } : {}),
      ...(item ? { definitionArchived: item.archived } : {}),
      ...(item?.provenance ? { provenance: item.provenance } : {}),
    })
    return { ...current, associations: [...current.associations, assoc] }
  }
  return {
    ...current,
    associations: current.associations.filter(
      (a) => !(a.kind === body.kind && a.definitionId === body.definitionId)
    ),
  }
}

/** Find a definition in the test catalogs by id (equipment or consumables). */
function inventoryCatalogFind(
  definitionId: string
): import("@/lib/api").CatalogItem | undefined {
  return [...equipmentCatalog, ...consumablesCatalog].find(
    (c) => c.id === definitionId
  )
}

/**
 * Mutate the in-memory character the way the inventory route would, so a
 * subsequent reload reflects the add/remove. Mirrors the backend: an add sums
 * onto any existing quantity, a remove down to zero deletes the row, and every
 * successful write bumps the CAS version by one.
 */
function applyInventory(
  current: import("@/lib/api").CharacterDetail,
  body: {
    operation: "add" | "remove"
    definitionId: string
    quantity: number
    version: number
    sourceNote: string
  }
): import("@/lib/api").CharacterDetail {
  const prior = (current.inventory ?? []).find(
    (row) => row.definitionId === body.definitionId
  )
  let rows = [...(current.inventory ?? [])]
  if (body.operation === "add") {
    const next = (prior?.quantity ?? 0) + body.quantity
    if (prior) {
      rows = rows.map((row) =>
        row.definitionId === body.definitionId
          ? { ...row, quantity: next }
          : row
      )
    } else {
      const source = inventoryCatalogFind(body.definitionId)
      rows = [
        ...rows,
        inventoryItem({
          id: `inv-${body.definitionId}`,
          definitionId: body.definitionId,
          name: source?.name ?? body.definitionId,
          kind: source?.kind === "consumables" ? "consumables" : "equipment",
          quantity: next,
          archived: source?.archived ?? false,
          provenance: source?.provenance ?? "house",
          ...(typeof source?.config?.slot === "string" &&
          source.config.slot.length > 0
            ? { slot: source.config.slot }
            : {}),
        }),
      ]
    }
  } else {
    const next = (prior?.quantity ?? 0) - body.quantity
    if (next <= 0) {
      rows = rows.filter((row) => row.definitionId !== body.definitionId)
    } else {
      rows = rows.map((row) =>
        row.definitionId === body.definitionId
          ? { ...row, quantity: next }
          : row
      )
    }
  }
  return { ...current, inventory: rows, version: current.version + 1 }
}

function setupMock(options?: {
  character?: import("@/lib/api").CharacterDetail
  associationsError?: unknown
  blessings?: import("@/lib/api").CatalogItem[]
  bloodlines?: import("@/lib/api").CatalogItem[]
  transcendentSkills?: import("@/lib/api").CatalogItem[]
  equipmentCatalog?: import("@/lib/api").CatalogItem[]
  consumablesCatalog?: import("@/lib/api").CatalogItem[]
  inventoryError?: unknown
}) {
  activeCharacter = options?.character ?? character
  associationsError = options?.associationsError ?? null
  blessingsCatalog = options?.blessings ?? []
  bloodlinesCatalog = options?.bloodlines ?? []
  transcendentCatalog = options?.transcendentSkills ?? []
  equipmentCatalog = options?.equipmentCatalog ?? []
  consumablesCatalog = options?.consumablesCatalog ?? []
  inventoryError = options?.inventoryError ?? null
  inventoryPosts = []

  const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
  mock.mockReset()
  mock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    if (url === "/api/characters/chr-1" && method === "GET") {
      return { character: activeCharacter }
    }
    if (url === "/api/characters/chr-1/portrait") return { portrait: null }
    if (url === "/api/characters/chr-1/evolutions") {
      if (evolutionsError) throw evolutionsError
      return { options: [], legacyAvailable: true }
    }
    if (url === "/api/catalog/blessings") {
      return { kind: "catalog", items: blessingsCatalog }
    }
    if (url === "/api/catalog/bloodlines") {
      return { kind: "catalog", items: bloodlinesCatalog }
    }
    if (url === "/api/catalog/transcendent_skills") {
      return { kind: "catalog", items: transcendentCatalog }
    }
    if (url === "/api/catalog/titles") {
      return { kind: "catalog", items: [] }
    }
    if (url === "/api/catalog/equipment") {
      return { kind: "catalog", items: equipmentCatalog }
    }
    if (url === "/api/catalog/consumables") {
      return { kind: "catalog", items: consumablesCatalog }
    }
    if (url === "/api/characters/chr-1/associations" && method === "POST") {
      if (associationsError) throw associationsError
      const body = JSON.parse((init?.body as string) ?? "{}") as {
        kind: "blessing" | "bloodline" | "transcendent"
        definitionId: string
        operation: "add" | "remove"
        version: number
      }
      activeCharacter = applyAssociation(activeCharacter, body)
      return { character: activeCharacter }
    }
    if (url === "/api/characters/chr-1/inventory" && method === "POST") {
      if (inventoryError) throw inventoryError
      const body = JSON.parse((init?.body as string) ?? "{}") as {
        operation: "add" | "remove"
        definitionId: string
        quantity: number
        version: number
        sourceNote: string
      }
      inventoryPosts.push(body)
      activeCharacter = applyInventory(activeCharacter, body)
      return {
        character: activeCharacter,
        inventory: activeCharacter.inventory ?? [],
        version: activeCharacter.version,
      }
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
  vi.restoreAllMocks()
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

describe("CharacterDetail power associations", () => {
  it("Powers tab lists active blessing and bloodline and marks an archived blessing inert", async () => {
    setupMock({
      character: {
        ...character,
        associations: [
          association({
            id: "assoc-bless-fire",
            kind: "blessing",
            definitionId: "bless-fire",
            name: "Blessing of Fire",
          }),
          association({
            id: "assoc-bloodline-wolf",
            kind: "bloodline",
            definitionId: "bloodline-wolf",
            name: "Wolf Bloodline",
          }),
          association({
            id: "assoc-bless-old",
            kind: "blessing",
            definitionId: "bless-old",
            name: "Old Blessing",
            definitionArchived: true,
          }),
        ],
      },
    })

    await renderDetail()
    fireEvent.click(screen.getByText("Powers"))
    await flush()

    const blessingSection = within(screen.getByLabelText("Blessing"))
    const bloodlineSection = within(screen.getByLabelText("Bloodlines"))
    expect(blessingSection.getByText("Blessing of Fire")).toBeTruthy()
    expect(bloodlineSection.getByText("Wolf Bloodline")).toBeTruthy()
    // The archived linked blessing stays visible but is honestly marked inert.
    expect(blessingSection.getByText("Old Blessing")).toBeTruthy()
    expect(blessingSection.getByText("Archived - inert")).toBeTruthy()
  })

  it("AssociationSheet blessing option surfaces the patronGodStableId", async () => {
    setupMock({
      blessings: [
        catalogItem({
          id: "bless-patron",
          name: "Blessing of Dawn",
          config: { patronGodStableId: "god-dawn" },
        }),
      ],
    })

    await renderDetail()
    fireEvent.click(screen.getByText("Manage powers"))
    await flush()

    expect(screen.getByText(/Patron: god-dawn/)).toBeTruthy()
  })

  it("adding a blessing with linked blessings opens a replacement confirmation listing every displaced link with an archived marker before POST", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true)
    setupMock({
      character: {
        ...character,
        associations: [
          association({
            id: "assoc-bless-fire",
            kind: "blessing",
            definitionId: "bless-fire",
            name: "Blessing of Fire",
          }),
          association({
            id: "assoc-bless-old",
            kind: "blessing",
            definitionId: "bless-old",
            name: "Old Blessing",
            definitionArchived: true,
          }),
        ],
      },
      blessings: [
        catalogItem({
          id: "bless-old",
          name: "Old Blessing",
          archived: true,
        }),
        catalogItem({ id: "bless-new", name: "New Blessing" }),
      ],
    })

    await renderDetail()
    fireEvent.click(screen.getByText("Manage powers"))
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Blessings" }))
    fireEvent.click(screen.getByText("Add"))
    await flush()

    // The replacement confirmation lists ALL displaced links, not just the active
    // one: both the active and the archived blessing are named, and the archived
    // one carries the "(archived, inert)" marker.
    const confirmMessages = confirmSpy.mock.calls.map((c) => c[0] as string)
    expect(confirmMessages[0]).toBe(
      "New Blessing will replace Blessing of Fire, Old Blessing (archived, inert). Continue?"
    )
    expect(confirmMessages[1]).toBe("Add New Blessing to Test?")

    const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
    const addPost = mock.mock.calls.find(
      ([url, init]) =>
        url === "/api/characters/chr-1/associations" &&
        (init as RequestInit | undefined)?.method === "POST"
    )
    expect(addPost).toBeTruthy()
    const body = JSON.parse((addPost![1] as RequestInit).body as string) as {
      kind: string
      definitionId: string
      operation: string
      version: number
    }
    expect(body).toEqual({
      kind: "blessing",
      definitionId: "bless-new",
      operation: "add",
      version: 3,
    })

    // The successful reload reflects the newly linked blessing.
    const blessingSection = within(screen.getByLabelText("Blessing"))
    expect(blessingSection.getByText("New Blessing")).toBeTruthy()
  })

  it("declining the replacement confirmation does not POST", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false)
    setupMock({
      character: {
        ...character,
        associations: [
          association({
            id: "assoc-bless-fire",
            kind: "blessing",
            definitionId: "bless-fire",
            name: "Blessing of Fire",
          }),
        ],
      },
      blessings: [catalogItem({ id: "bless-new", name: "New Blessing" })],
    })

    await renderDetail()
    fireEvent.click(screen.getByText("Manage powers"))
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Blessings" }))
    fireEvent.click(screen.getByText("Add"))
    await flush()

    const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
    const assocPosts = mock.mock.calls.filter(
      ([url, init]) =>
        url === "/api/characters/chr-1/associations" &&
        (init as RequestInit | undefined)?.method === "POST"
    )
    expect(assocPosts).toEqual([])
    // The powers tab still shows only the original blessing - no fake success.
    const blessingSection = within(screen.getByLabelText("Blessing"))
    expect(blessingSection.getByText("Blessing of Fire")).toBeTruthy()
    expect(blessingSection.queryByText("New Blessing")).toBeNull()
  })

  it("removing a bloodline POSTs kind bloodline/remove/version and reload renders it removed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true)
    setupMock({
      character: {
        ...character,
        associations: [
          association({
            id: "assoc-bloodline-wolf",
            kind: "bloodline",
            definitionId: "bloodline-wolf",
            name: "Wolf Bloodline",
          }),
        ],
      },
      bloodlines: [
        catalogItem({ id: "bloodline-wolf", name: "Wolf Bloodline" }),
      ],
    })

    await renderDetail()
    fireEvent.click(screen.getByText("Manage powers"))
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Bloodlines" }))
    fireEvent.click(screen.getByText("Remove"))
    await flush()

    const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
    const removePost = mock.mock.calls.find(
      ([url, init]) =>
        url === "/api/characters/chr-1/associations" &&
        (init as RequestInit | undefined)?.method === "POST"
    )
    expect(removePost).toBeTruthy()
    const body = JSON.parse((removePost![1] as RequestInit).body as string) as {
      kind: string
      definitionId: string
      operation: string
      version: number
    }
    expect(body).toEqual({
      kind: "bloodline",
      definitionId: "bloodline-wolf",
      operation: "remove",
      version: 3,
    })

    // The reload reflects the removal: the powers tab no longer lists it.
    const bloodlineSection = within(screen.getByLabelText("Bloodlines"))
    expect(bloodlineSection.queryByText("Wolf Bloodline")).toBeNull()
  })

  it("a failed add POST does not fake UI success", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true)
    setupMock({
      character: {
        ...character,
        associations: [
          association({
            id: "assoc-bless-fire",
            kind: "blessing",
            definitionId: "bless-fire",
            name: "Blessing of Fire",
          }),
        ],
      },
      associationsError: new Error("network down"),
      blessings: [catalogItem({ id: "bless-new", name: "New Blessing" })],
    })

    await renderDetail()
    fireEvent.click(screen.getByText("Manage powers"))
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Blessings" }))
    fireEvent.click(screen.getByText("Add"))
    await flush()

    // The failure is surfaced, not swallowed.
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("network down")
    )
    // No fake success: the powers tab still lists only the original blessing.
    const blessingSection = within(screen.getByLabelText("Blessing"))
    expect(blessingSection.getByText("Blessing of Fire")).toBeTruthy()
    expect(blessingSection.queryByText("New Blessing")).toBeNull()
  })
})

describe("CharacterDetail transcendent skills", () => {
  it("Powers tab derives the transcendent badge from the server flag and marks an archived link inert", async () => {
    setupMock({
      character: {
        ...character,
        isTranscendent: true,
        associations: [
          association({
            id: "assoc-trans-zen",
            kind: "transcendent",
            definitionId: "trans-zen",
            name: "Zen Transcendence",
          }),
          association({
            id: "assoc-trans-old",
            kind: "transcendent",
            definitionId: "trans-old",
            name: "Old Transcendence",
            definitionArchived: true,
          }),
        ],
      },
    })

    await renderDetail()
    fireEvent.click(screen.getByText("Powers"))
    await flush()

    const section = within(screen.getByLabelText("Transcendent skills"))
    // The badge is the server-computed flag, never a client derivation.
    expect(section.getByText("Transcendent")).toBeTruthy()
    expect(section.getByText("Zen Transcendence")).toBeTruthy()
    expect(section.getByText("Old Transcendence")).toBeTruthy()
    expect(section.getByText("Archived - inert")).toBeTruthy()
  })

  it("Powers tab does not fabricate the transcendent badge when the server flag is false", async () => {
    setupMock({
      character: {
        ...character,
        isTranscendent: false,
        associations: [
          association({
            id: "assoc-trans-zen",
            kind: "transcendent",
            definitionId: "trans-zen",
            name: "Zen Transcendence",
          }),
        ],
      },
    })

    await renderDetail()
    fireEvent.click(screen.getByText("Powers"))
    await flush()

    const section = within(screen.getByLabelText("Transcendent skills"))
    expect(section.getByText("Zen Transcendence")).toBeTruthy()
    // No client-derived activation: the badge is absent when the server says no.
    expect(section.queryByText("Transcendent")).toBeNull()
  })

  it("an archived linked transcendent omitted by the active-only catalog stays removable and POSTs kind transcendent/remove/version then reloads it away", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true)
    setupMock({
      character: {
        ...character,
        isTranscendent: true,
        associations: [
          association({
            id: "assoc-trans-old",
            kind: "transcendent",
            definitionId: "trans-old",
            name: "Old Transcendence",
            definitionArchived: true,
          }),
        ],
      },
      // The active-only catalog omits the archived linked skill entirely.
      transcendentSkills: [],
    })

    await renderDetail()
    fireEvent.click(screen.getByText("Manage powers"))
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Transcendent skills" }))
    fireEvent.click(screen.getAllByText("Remove")[0])
    await flush()

    const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
    const removePost = mock.mock.calls.find(
      ([url, init]) =>
        url === "/api/characters/chr-1/associations" &&
        (init as RequestInit | undefined)?.method === "POST"
    )
    expect(removePost).toBeTruthy()
    const body = JSON.parse((removePost![1] as RequestInit).body as string) as {
      kind: string
      definitionId: string
      operation: string
      version: number
    }
    expect(body).toEqual({
      kind: "transcendent",
      definitionId: "trans-old",
      operation: "remove",
      version: 3,
    })

    // The reload reflects the removal: no UI still lists the old skill.
    expect(screen.queryByText("Old Transcendence")).toBeNull()
    expect(screen.queryByText("Archived - inert")).toBeNull()
  })

  it("attaching one of several transcendent candidates POSTs kind transcendent/add/version and reload marks it linked", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true)
    setupMock({
      character: {
        ...character,
        isTranscendent: false,
      },
      transcendentSkills: [
        catalogItem({
          id: "trans-a",
          name: "Transcendence A",
          kind: "transcendent_skills",
        }),
        catalogItem({
          id: "trans-b",
          name: "Transcendence B",
          kind: "transcendent_skills",
        }),
      ],
    })

    await renderDetail()
    fireEvent.click(screen.getByText("Manage powers"))
    await flush()

    const attachA = screen
      .getAllByRole("button", { name: "Attach" })
      .find((btn) =>
        btn.closest("div")?.textContent?.includes("Transcendence A")
      )
    expect(attachA).toBeTruthy()
    fireEvent.click(attachA!)
    await flush()

    const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
    const addPost = mock.mock.calls.find(
      ([url, init]) =>
        url === "/api/characters/chr-1/associations" &&
        (init as RequestInit | undefined)?.method === "POST"
    )
    expect(addPost).toBeTruthy()
    const body = JSON.parse((addPost![1] as RequestInit).body as string) as {
      kind: string
      definitionId: string
      operation: string
      version: number
    }
    expect(body).toEqual({
      kind: "transcendent",
      definitionId: "trans-a",
      operation: "add",
      version: 3,
    })

    // The reload reflects the attach: candidate A is now linked (Remove action)
    // while candidate B remains unattached.
    const removeA = screen
      .getAllByRole("button", { name: "Remove" })
      .find((btn) =>
        btn.closest("div")?.textContent?.includes("Transcendence A")
      )
    expect(removeA).toBeTruthy()
    const attachB = screen
      .getAllByRole("button", { name: "Attach" })
      .find((btn) =>
        btn.closest("div")?.textContent?.includes("Transcendence B")
      )
    expect(attachB).toBeTruthy()
  })

  it("a failed transcendent attach POST surfaces the error and leaves the candidate unlinked", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true)
    setupMock({
      associationsError: new Error("network down"),
      character: {
        ...character,
        isTranscendent: false,
      },
      transcendentSkills: [
        catalogItem({
          id: "trans-a",
          name: "Transcendence A",
          kind: "transcendent_skills",
        }),
      ],
    })

    await renderDetail()
    fireEvent.click(screen.getByText("Manage powers"))
    await flush()
    fireEvent.click(screen.getByText("Attach"))
    await flush()

    // The failure is surfaced, not swallowed.
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("network down")
    )
    // No fake success: the candidate is still unattached (Attach, no Remove).
    expect(screen.getByText("Attach")).toBeTruthy()
    expect(screen.queryByText("Remove")).toBeNull()
  })
})

describe("CharacterDetail inventory", () => {
  it("Inventory tab Add stock saves an add POST and refreshes the owned quantity", async () => {
    setupMock({
      equipmentCatalog: [
        catalogItem({
          id: "eq-sword",
          name: "Iron Sword",
          kind: "equipment",
          config: { slot: "weapon" },
        }),
      ],
    })

    await renderDetail()
    // The Tabs mock never fires onValueChange, so the inventory tab does not
    // load catalogs on its own; open the associations sheet to trigger the
    // catalog loads that back the Add stock dialog.
    fireEvent.click(screen.getByText("Manage powers"))
    await flush()

    fireEvent.click(screen.getByRole("button", { name: "Add stock" }))
    await flush()

    // The dialog is accessible: a title and the manual-bookkeeping notice.
    const heading = screen.getByRole("heading", { name: "Add stock" })
    const dialog = heading.closest("div")!.parentElement!
    expect(heading).toBeTruthy()
    expect(within(dialog).getByText(/Manual bookkeeping only/)).toBeTruthy()

    const save = () =>
      within(dialog).getByRole("button", {
        name: "Save",
      }) as HTMLButtonElement

    // Nothing selected / no quantity / no note: submit is disabled.
    expect(save().disabled).toBe(true)

    // Pick an active catalog equipment item.
    fireEvent.click(within(dialog).getByText("Iron Sword"))
    await flush()

    // A quantity alone still leaves submit disabled (source note required).
    fireEvent.change(within(dialog).getByLabelText("Quantity"), {
      target: { value: "2" },
    })
    expect(save().disabled).toBe(true)

    // With a valid quantity and note the submit enables.
    fireEvent.change(within(dialog).getByLabelText("Source note"), {
      target: { value: "bought at market" },
    })
    await flush()
    expect(save().disabled).toBe(false)

    // An invalid quantity re-disables the submit.
    fireEvent.change(within(dialog).getByLabelText("Quantity"), {
      target: { value: "0" },
    })
    expect(save().disabled).toBe(true)
    fireEvent.change(within(dialog).getByLabelText("Quantity"), {
      target: { value: "1.5" },
    })
    expect(save().disabled).toBe(true)

    fireEvent.change(within(dialog).getByLabelText("Quantity"), {
      target: { value: "2" },
    })
    await flush()
    expect(save().disabled).toBe(false)

    fireEvent.click(save())
    await flush()

    expect(inventoryPosts).toEqual([
      {
        operation: "add",
        definitionId: "eq-sword",
        quantity: 2,
        version: 3,
        sourceNote: "bought at market",
      },
    ])

    // The dialog closes and the reload reflects the fresh owned stock.
    expect(screen.queryByRole("heading", { name: "Add stock" })).toBeNull()
    expect(screen.getByText("Qty 2")).toBeTruthy()
  })

  it("an archived consumable inventory row is visible and inert: Discard works but Consume is disabled", async () => {
    setupMock({
      character: {
        ...character,
        inventory: [
          inventoryItem({
            id: "inv-potion",
            definitionId: "cons-potion",
            name: "Old Potion",
            kind: "consumables",
            quantity: 1,
            archived: true,
          }),
        ],
      },
      consumablesCatalog: [
        catalogItem({
          id: "cons-potion",
          name: "Old Potion",
          kind: "consumables",
          archived: true,
        }),
      ],
    })

    await renderDetail()
    fireEvent.click(screen.getByRole("button", { name: "Inventory" }))
    await flush()

    const ownedConsumables = within(screen.getByLabelText("Owned consumables"))
    // Archived stock stays visible and is honestly marked inert.
    expect(ownedConsumables.getByText("Old Potion")).toBeTruthy()
    expect(ownedConsumables.getByText("Qty 1")).toBeTruthy()
    expect(ownedConsumables.getByText("Archived - inert")).toBeTruthy()
    // An archived definition cannot be newly consumed.
    expect(
      (
        ownedConsumables.getByRole("button", {
          name: "Consume",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
    // But owned archived stock can still be discarded.
    const discard = ownedConsumables.getByRole("button", {
      name: "Discard",
    }) as HTMLButtonElement
    expect(discard.disabled).toBe(false)

    fireEvent.click(discard)
    await flush()

    const heading = screen.getByRole("heading", { name: "Discard stock" })
    const dialog = heading.closest("div")!.parentElement!
    fireEvent.change(within(dialog).getByLabelText("Quantity (1-1)"), {
      target: { value: "1" },
    })
    fireEvent.change(within(dialog).getByLabelText("Source note"), {
      target: { value: "used it up" },
    })
    await flush()

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Discard stock" })
    )
    await flush()

    expect(inventoryPosts).toEqual([
      {
        operation: "remove",
        definitionId: "cons-potion",
        quantity: 1,
        version: 3,
        sourceNote: "used it up",
      },
    ])

    // The row disappears on reload; the archived catalog entry remains visible
    // only via the management sheet, not as owned stock.
    const after = within(screen.getByLabelText("Owned consumables"))
    expect(after.queryByText("Old Potion")).toBeNull()
    expect(after.queryByText("Qty 1")).toBeNull()
  })

  it("a grandfathered equipped equipment link with no inventory row stays removable from the equipment sheet", async () => {
    setupMock({
      character: {
        ...character,
        associations: [
          association({
            id: "assoc-eq-sword",
            kind: "equipment",
            definitionId: "eq-sword",
            name: "Iron Sword",
            legacyUnowned: true,
          }),
        ],
      },
      equipmentCatalog: [
        catalogItem({
          id: "eq-sword",
          name: "Iron Sword",
          kind: "equipment",
          config: { slot: "weapon" },
        }),
      ],
    })

    await renderDetail()
    fireEvent.click(screen.getByRole("button", { name: "Powers" }))
    await flush()
    fireEvent.click(screen.getByText("Manage powers"))
    await flush()

    const sheetContent = screen
      .getByText("Character associations")
      .closest("div")!.parentElement!
    fireEvent.click(
      within(sheetContent).getByRole("button", { name: "Equipment" })
    )
    await flush()

    // The legacy linked equipment is present and removable - no owned stock is
    // required to remove it.
    const remove = within(sheetContent).getByRole("button", {
      name: "Remove",
    }) as HTMLButtonElement
    expect(remove.disabled).toBe(false)
    fireEvent.click(remove)
    await flush()

    const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
    const removePost = mock.mock.calls.find(
      ([url, init]) =>
        url === "/api/characters/chr-1/associations" &&
        (init as RequestInit | undefined)?.method === "POST"
    )
    expect(removePost).toBeTruthy()
    const body = JSON.parse((removePost![1] as RequestInit).body as string) as {
      kind: string
      definitionId: string
      operation: string
      version: number
    }
    expect(body).toEqual({
      kind: "equipment",
      definitionId: "eq-sword",
      operation: "remove",
      version: 3,
    })

    // The reload reflects the unlink: the sheet now requires stock to equip.
    const after = within(
      screen.getByText("Character associations").closest("div")!.parentElement!
    )
    expect(after.queryByRole("button", { name: "Remove" })).toBeNull()
    expect(after.getByRole("button", { name: "Add stock first" })).toBeTruthy()
  })

  it("an equipped item with one remaining unit protects its final stock: Discard is disabled", async () => {
    setupMock({
      character: {
        ...character,
        inventory: [
          inventoryItem({
            id: "inv-final",
            definitionId: "eq-final",
            name: "Final Sword",
            kind: "equipment",
            quantity: 1,
          }),
        ],
        associations: [
          association({
            id: "assoc-eq-final",
            kind: "equipment",
            definitionId: "eq-final",
            name: "Final Sword",
          }),
        ],
      },
    })

    await renderDetail()
    fireEvent.click(screen.getByRole("button", { name: "Inventory" }))
    await flush()

    const ownedEquip = within(screen.getByLabelText("Owned equipment"))
    expect(ownedEquip.getByText("Final Sword")).toBeTruthy()
    expect(ownedEquip.getByText("Qty 1")).toBeTruthy()
    expect(
      (
        ownedEquip.getByRole("button", {
          name: "Discard",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
  })

  it("an equipped item with two units opens a Discard dialog capped at one remaining unit", async () => {
    setupMock({
      character: {
        ...character,
        inventory: [
          inventoryItem({
            id: "inv-final",
            definitionId: "eq-final",
            name: "Final Sword",
            kind: "equipment",
            quantity: 2,
          }),
        ],
        associations: [
          association({
            id: "assoc-eq-final",
            kind: "equipment",
            definitionId: "eq-final",
            name: "Final Sword",
          }),
        ],
      },
    })

    await renderDetail()
    fireEvent.click(screen.getByRole("button", { name: "Inventory" }))
    await flush()

    const ownedEquip = within(screen.getByLabelText("Owned equipment"))
    const discard = ownedEquip.getByRole("button", {
      name: "Discard",
    }) as HTMLButtonElement
    // Two units available, one must stay equipped: Discard is allowed.
    expect(discard.disabled).toBe(false)

    fireEvent.click(discard)
    await flush()

    const heading = screen.getByRole("heading", { name: "Discard stock" })
    const dialog = heading.closest("div")!.parentElement!
    const qtyInput = within(dialog).getByLabelText(
      "Quantity (1-1)"
    ) as HTMLInputElement
    // The dialog caps the discard at quantity - 1 (keep the final equipped unit).
    expect(qtyInput.max).toBe("1")

    const confirm = () =>
      within(dialog).getByRole("button", {
        name: "Discard stock",
      }) as HTMLButtonElement
    // Empty quantity (0) is below the floor, and no note is set, so submitting
    // is disabled.
    expect(confirm().disabled).toBe(true)
    fireEvent.change(qtyInput, { target: { value: "1" } })
    fireEvent.change(within(dialog).getByLabelText("Source note"), {
      target: { value: "left one equipped" },
    })
    await flush()
    expect(confirm().disabled).toBe(false)
  })
})
