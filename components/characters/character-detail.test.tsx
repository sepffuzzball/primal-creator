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

// The route id the component reads via useParams. Tests that simulate a route
// change mutate this value and rerender the same component instance.
let mockRouteId = "chr-1"

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: mockRouteId }),
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

describe("character currencies", () => {
  const currency = {
    definitionId: "coin-id",
    stableId: "gold_coin",
    name: "Gold",
    description: null,
    amount: null,
  }
  async function openCurrencies() {
    await renderDetail()
    fireEvent.click(
      screen.getAllByRole("button", { name: "Manage equipment" })[0]!
    )
    const panel = associationSheetContent("inventoryEquipment")
    fireEvent.click(within(panel).getByRole("tab", { name: "Currencies" }))
    await flush()
    return panel
  }

  it("loads active balances with null blank and zero displayed", async () => {
    setupMock()
    currenciesForTest = [
      currency,
      { ...currency, definitionId: "zero", name: "Zero", amount: 0 },
    ]
    const panel = await openCurrencies()
    expect(
      within(panel)
        .getByRole("textbox", { name: "Gold balance" })
        .getAttribute("value")
    ).toBe("")
    expect(
      within(panel)
        .getByRole("textbox", { name: "Zero balance" })
        .getAttribute("value")
    ).toBe("0")
  })

  it.each([
    ["12", 12],
    ["0", 0],
    ["", null],
  ])("saves %s with version then refreshes", async (value, amount) => {
    setupMock()
    currenciesForTest = [currency]
    const panel = await openCurrencies()
    const input = within(panel).getByRole("textbox", { name: "Gold balance" })
    fireEvent.change(input, { target: { value } })
    expect(
      within(panel)
        .getByRole("button", { name: "Save" })
        .hasAttribute("disabled")
    ).toBe(false)
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }))
    await flush()
    expect(currencyPostsForTest).toEqual([
      expect.objectContaining({ definitionId: "coin-id", amount, version: 3 }),
    ])
    expect(
      (apiFetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([url, init]) =>
          url.endsWith("/currencies") &&
          (init as RequestInit | undefined)?.method !== "PATCH"
      ).length
    ).toBeGreaterThanOrEqual(2)
  })

  it.each(["-1", "1.5", "2147483648", "１２"])(
    "rejects invalid balance %s",
    async (value) => {
      setupMock()
      currenciesForTest = [currency]
      const panel = await openCurrencies()
      const input = within(panel).getByRole("textbox", { name: "Gold balance" })
      fireEvent.change(input, { target: { value } })
      expect(
        within(panel)
          .getByRole("button", { name: "Save" })
          .hasAttribute("disabled")
      ).toBe(true)
      expect(currencyPostsForTest).toHaveLength(0)
    }
  )

  it("disables edits for archived characters and shows an empty state", async () => {
    setupMock({
      character: { ...character, archived: true } as typeof character,
    })
    currenciesForTest = [currency]
    const panel = await openCurrencies()
    expect(
      within(panel)
        .getByRole("textbox", { name: "Gold balance" })
        .hasAttribute("disabled")
    ).toBe(true)
    expect(within(panel).queryByRole("button", { name: "Save" })).toBeNull()
    cleanup()
    setupMock()
    currenciesForTest = []
    const emptyPanel = await openCurrencies()
    expect(
      within(emptyPanel).getByText("No active currencies in the catalog.")
    ).toBeTruthy()
  })

  it("shows API errors and supports reload after a conflict", async () => {
    setupMock()
    currenciesForTest = [currency]
    const panel = await openCurrencies()
    currencyErrorForTest = new Error("Version conflict")
    fireEvent.change(
      within(panel).getByRole("textbox", { name: "Gold balance" }),
      { target: { value: "42" } }
    )
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }))
    await flush()
    expect(within(panel).getByText("Version conflict")).toBeTruthy()
    currencyErrorForTest = null
    currenciesForTest = [{ ...currency, amount: 7 }]
    fireEvent.click(
      within(panel).getByRole("button", { name: "Reload from server" })
    )
    await flush()
    expect(
      within(panel).getByRole("textbox", { name: "Gold balance" })
    ).toHaveProperty("value", "7")
  })

  it("keeps another currency draft when saving one currency", async () => {
    setupMock()
    currenciesForTest = [
      currency,
      { ...currency, definitionId: "silver", name: "Silver", amount: 1 },
    ]
    const panel = await openCurrencies()
    fireEvent.change(
      within(panel).getByRole("textbox", { name: "Gold balance" }),
      { target: { value: "12" } }
    )
    fireEvent.change(
      within(panel).getByRole("textbox", { name: "Silver balance" }),
      { target: { value: "99" } }
    )
    fireEvent.click(within(panel).getAllByRole("button", { name: "Save" })[0]!)
    await flush()
    expect(
      within(panel).getByRole("textbox", { name: "Gold balance" })
    ).toHaveProperty("value", "12")
    expect(
      within(panel).getByRole("textbox", { name: "Silver balance" })
    ).toHaveProperty("value", "99")
  })

  it("refreshes the parent version after currency save", async () => {
    setupMock()
    currenciesForTest = [currency]
    const panel = await openCurrencies()
    fireEvent.change(
      within(panel).getByRole("textbox", { name: "Gold balance" }),
      { target: { value: "12" } }
    )
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }))
    await flush()
    fireEvent.click(
      screen.getAllByRole("button", { name: "Manage equipment" })[0]!
    )
    await flush()
    expect(activeCharacter.version).toBe(4)
  })
})

// --- Deferred promise helper ---------------------------------------------- //

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

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

vi.mock("@/components/ui/progress", () => ({
  Progress: ({
    children,
    value,
    "aria-label": ariaLabel,
  }: {
    children?: React.ReactNode
    value?: number | null
    "aria-label"?: string
  }) => (
    <div
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuenow={value ?? undefined}
    >
      {children}
    </div>
  ),
  ProgressTrack: ({ children }: React.ComponentProps<"div">) => (
    <div>{children}</div>
  ),
  ProgressIndicator: () => null,
  ProgressLabel: ({ children }: React.ComponentProps<"span">) => (
    <span>{children}</span>
  ),
  ProgressValue: () => null,
}))

vi.mock("@/components/ui/slider", () => ({
  Slider: ({
    children,
    value,
    onValueChange,
    onValueCommitted,
    disabled,
    ...props
  }: React.ComponentProps<"div"> & {
    value: number[]
    onValueChange: (value: number[]) => void
    onValueCommitted: (value: number[]) => void
    disabled?: boolean
  }) => (
    <div {...props}>
      {React.cloneElement(
        React.Children.only(children) as React.ReactElement<
          Record<string, unknown>
        >,
        {
          value,
          onValueChange,
          onValueCommitted,
          disabled,
        }
      )}
    </div>
  ),
  SliderControl: ({
    children,
    ...props
  }: React.ComponentProps<"div"> & {
    value: number[]
    onValueChange: (value: number[]) => void
    onValueCommitted: (value: number[]) => void
    disabled?: boolean
  }) => (
    <div {...props}>
      {React.Children.map(children, (child) =>
        React.isValidElement(child) ? React.cloneElement(child, props) : child
      )}
    </div>
  ),
  SliderTrack: ({
    children,
    ...props
  }: React.ComponentProps<"div"> & {
    value: number[]
    onValueChange: (value: number[]) => void
    onValueCommitted: (value: number[]) => void
    disabled?: boolean
  }) => <div {...props}>{children}</div>,
  SliderIndicator: () => null,
  SliderThumb: ({
    value,
    onValueChange,
    onValueCommitted,
    disabled,
  }: {
    value: number[]
    onValueChange: (value: number[]) => void
    onValueCommitted: (value: number[]) => void
    disabled?: boolean
  }) => (
    <input
      aria-label="Experience slider"
      type="range"
      min={0}
      max={100}
      value={value[0]}
      disabled={disabled}
      onChange={(event) => onValueChange([Number(event.currentTarget.value)])}
      onMouseUp={(event) =>
        onValueCommitted([Number(event.currentTarget.value)])
      }
      onKeyUp={(event) => onValueCommitted([Number(event.currentTarget.value)])}
    />
  ),
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

vi.mock("@/components/ui/tabs", () => {
  const TabsContext = React.createContext<
    ((value: string) => void) | undefined
  >(undefined)
  return {
    Tabs: ({
      children,
      onValueChange,
    }: React.ComponentProps<"div"> & {
      onValueChange?: (value: string) => void
    }) => (
      <TabsContext.Provider value={onValueChange}>
        <div>{children}</div>
      </TabsContext.Provider>
    ),
    TabsList: ({ children }: React.ComponentProps<"div">) => (
      <div role="tablist">{children}</div>
    ),
    TabsContent: ({
      children,
      value,
    }: React.ComponentProps<"div"> & { value?: string }) => (
      <div data-testid={value ? `panel-${value}` : undefined}>{children}</div>
    ),
    TabsTrigger: ({
      children,
      value,
      onClick,
      ...props
    }: React.ComponentProps<"button"> & { value?: string }) => {
      const onValueChange = React.useContext(TabsContext)
      return (
        <button
          role="tab"
          {...props}
          onClick={(event) => {
            onClick?.(event)
            onValueChange?.(value ?? "")
          }}
        >
          {children}
        </button>
      )
    },
  }
})

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({
    children,
    open,
  }: React.ComponentProps<"div"> & { open?: boolean }) =>
    open ? <div>{children}</div> : null,
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
      profession: null,
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
let titlesCatalog: import("@/lib/api").CatalogItem[] = []
let itemsCatalog: import("@/lib/api").CatalogItem[] = []
let inventoryError: unknown = null
let inventoryPosts: Array<{
  operation: "add" | "remove" | "use"
  definitionId: string
  quantity: number
  version: number
  sourceNote?: string
}> = []
/** Captured PATCH /api/characters/chr-1 request bodies (profile saves). */
let patchPosts: Array<Record<string, unknown>> = []
/** Thrown when PATCH /api/characters/chr-1 is called (a failed profile save). */
let profileSaveError: unknown = null
let creationRulesError: unknown = null
let maxTranscendentSkills = 3
let activeCharacter: import("@/lib/api").CharacterDetail = character
let advanceError: unknown = null
let advancePosts: Array<Record<string, unknown>> = []
let experiencePosts: Array<Record<string, unknown>> = []
let experienceError: unknown = null
let experienceJournal: Record<string, unknown> = { leveledUp: false, notes: [] }
let skillRefreshPosts = 0
let skillSelectPosts: Array<Record<string, unknown>> = []
let skillRefreshErrorForTest: unknown = null
let skillRefreshCharacter: import("@/lib/api").CharacterDetail | null = null
/** When set, the first POST to /api/characters/chr-1/skills/refresh returns this
 * deferred promise instead of resolving at once, letting a test resolve (or
 * reject) it later to simulate a slow/out-of-order refresh response. */
let skillRefreshDeferred: Deferred<{
  character: import("@/lib/api").CharacterDetail
}> | null = null
/** When set, the next GET to /api/characters/chr-1 returns this deferred promise
 * instead of resolving at once, letting a test resolve (or reject) it later to
 * simulate a slow/out-of-order character-detail GET response. */
let characterGetDeferred: Deferred<{
  character: import("@/lib/api").CharacterDetail
}> | null = null
/** Second character served when the route id is chr-2 (route-change race tests). */
let characterB: import("@/lib/api").CharacterDetail | null = null
/** When set, the next GET to /api/characters/chr-2 returns this deferred promise. */
let characterGetDeferredB: Deferred<{
  character: import("@/lib/api").CharacterDetail
}> | null = null
/** When set, the next POST to /api/characters/chr-2/skills/refresh returns this
 * deferred promise instead of resolving at once, letting a test resolve (or
 * reject) it later to simulate a slow character-B refresh. */
let skillRefreshDeferredB: Deferred<{
  character: import("@/lib/api").CharacterDetail
}> | null = null
let professionCatalog: import("@/lib/api").CatalogItem[] = []
let historyEvents: import("@/lib/api").ExportResponse["events"] = []
let exportErrorForTest: unknown = null
let exportGetCount = 0
let professionPostError: unknown = null
let professionPosts: Array<Record<string, unknown>> = []
let skillsCatalogForTest: import("@/lib/api").CatalogItem[] = []
let upgradeErrorForTest: unknown = null
let upgradePostsForTest: Array<Record<string, unknown>> = []
let currenciesForTest: Array<{
  definitionId: string
  stableId: string
  name: string
  description: string | null
  amount: number | null
}> = []
let currencyVersionForTest = 3
let currencyPostsForTest: Array<Record<string, unknown>> = []
let currencyErrorForTest: unknown = null

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
  overrides: Omit<
    Partial<import("@/lib/api").CharacterInventoryItem>,
    "kind"
  > & {
    id: string
    definitionId: string
    name: string
    kind: "equipment" | "items"
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
    operation: "add" | "remove" | "use"
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
    })
    return {
      ...current,
      associations: [
        ...current.associations.filter(
          (existing) =>
            !(body.kind === "bloodline" && existing.kind === "bloodline")
        ),
        assoc,
      ],
    }
  }
  return {
    ...current,
    associations: current.associations.filter(
      (a) => !(a.kind === body.kind && a.definitionId === body.definitionId)
    ),
  }
}

/** Find a definition in the test catalogs by id (equipment or items). */
function inventoryCatalogFind(
  definitionId: string
): import("@/lib/api").CatalogItem | undefined {
  return [...equipmentCatalog, ...itemsCatalog].find(
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
    sourceNote?: string
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
          kind: source?.kind === "items" ? "items" : "equipment",
          quantity: next,
          archived: source?.archived ?? false,
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

/**
 * Apply a profile PATCH the way the save route would, so a subsequent reload
 * reflects the saved name/description/metadata. The PATCH body carries the CAS
 * `version` being written against; a successful write bumps the stored version
 * by one (mirrors the backend's optimistic-concurrency bump on every write).
 */
function applyProfilePatch(
  current: import("@/lib/api").CharacterDetail,
  body: Record<string, unknown>
): import("@/lib/api").CharacterDetail {
  // The PATCH body carries the CAS `version` being written against. Spreading
  // it would overwrite the stored version with the request's (stale) value, so
  // the successful write always bumps the stored version by one.
  return { ...current, ...body, version: current.version + 1 }
}

function setupMock(options?: {
  character?: import("@/lib/api").CharacterDetail
  associationsError?: unknown
  blessings?: import("@/lib/api").CatalogItem[]
  bloodlines?: import("@/lib/api").CatalogItem[]
  transcendentSkills?: import("@/lib/api").CatalogItem[]
  equipmentCatalog?: import("@/lib/api").CatalogItem[]
  titles?: import("@/lib/api").CatalogItem[]
  itemsCatalog?: import("@/lib/api").CatalogItem[]
  inventoryError?: unknown
  /** Thrown when PATCH /api/characters/chr-1 is called (a failed profile save). */
  profileSaveError?: unknown
  creationRulesError?: unknown
  maxTranscendentSkills?: number
  advanceError?: unknown
  experienceError?: unknown
  experienceJournal?: Record<string, unknown>
  professions?: import("@/lib/api").CatalogItem[]
  events?: import("@/lib/api").ExportResponse["events"]
  exportError?: unknown
  professionError?: unknown
  skills?: import("@/lib/api").CatalogItem[]
  upgradeError?: unknown
}) {
  activeCharacter = options?.character ?? character
  advanceError = options?.advanceError ?? null
  advancePosts = []
  experiencePosts = []
  experienceError = options?.experienceError ?? null
  experienceJournal = options?.experienceJournal ?? {
    leveledUp: false,
    notes: [],
  }
  skillRefreshPosts = 0
  skillSelectPosts = []
  skillRefreshErrorForTest = null
  skillRefreshCharacter = null
  skillRefreshDeferred = null
  characterGetDeferred = null
  characterB = null
  characterGetDeferredB = null
  skillRefreshDeferredB = null
  professionCatalog = options?.professions ?? []
  historyEvents = options?.events ?? []
  exportErrorForTest = options?.exportError ?? null
  exportGetCount = 0
  professionPostError = options?.professionError ?? null
  professionPosts = []
  skillsCatalogForTest = options?.skills ?? []
  upgradeErrorForTest = options?.upgradeError ?? null
  upgradePostsForTest = []
  currenciesForTest = []
  currencyVersionForTest = activeCharacter.version
  currencyPostsForTest = []
  currencyErrorForTest = null
  associationsError = options?.associationsError ?? null
  blessingsCatalog = options?.blessings ?? []
  bloodlinesCatalog = options?.bloodlines ?? []
  transcendentCatalog = options?.transcendentSkills ?? []
  equipmentCatalog = options?.equipmentCatalog ?? []
  titlesCatalog = options?.titles ?? []
  itemsCatalog = options?.itemsCatalog ?? []
  inventoryError = options?.inventoryError ?? null
  profileSaveError = options?.profileSaveError ?? null
  creationRulesError = options?.creationRulesError ?? null
  maxTranscendentSkills = options?.maxTranscendentSkills ?? 3
  inventoryPosts = []
  patchPosts = []

  const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
  mock.mockReset()
  mock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    if (url === "/api/rules/creation") {
      if (creationRulesError) throw creationRulesError
      return { maxTranscendentSkills }
    }
    if (url === "/api/characters/chr-1" && method === "GET") {
      const deferred = characterGetDeferred
      characterGetDeferred = null
      if (deferred) return deferred.promise
      return { character: activeCharacter }
    }
    if (url === "/api/characters/chr-2" && method === "GET") {
      const deferred = characterGetDeferredB
      characterGetDeferredB = null
      if (deferred) return deferred.promise
      return { character: characterB ?? activeCharacter }
    }
    if (url === "/api/characters/chr-1" && method === "PATCH") {
      if (profileSaveError) throw profileSaveError
      const body = JSON.parse((init?.body as string) ?? "{}") as Record<
        string,
        unknown
      >
      patchPosts.push(body)
      activeCharacter = applyProfilePatch(activeCharacter, body)
      return { character: activeCharacter }
    }
    if (url === "/api/characters/chr-1/currencies" && method === "GET") {
      if (currencyErrorForTest) throw currencyErrorForTest
      return { currencies: currenciesForTest, version: currencyVersionForTest }
    }
    if (url === "/api/characters/chr-1/currencies" && method === "PATCH") {
      if (currencyErrorForTest) throw currencyErrorForTest
      const body = JSON.parse((init?.body as string) ?? "{}") as Record<
        string,
        unknown
      >
      currencyPostsForTest.push(body)
      currencyVersionForTest += 1
      activeCharacter = {
        ...activeCharacter,
        version: activeCharacter.version + 1,
      }
      currenciesForTest = currenciesForTest.map((item) =>
        item.definitionId === body.definitionId
          ? { ...item, amount: body.amount as number | null }
          : item
      )
      return { version: currencyVersionForTest }
    }
    if (url === "/api/characters/chr-1/portrait") return { portrait: null }
    if (url === "/api/characters/chr-2/portrait") return { portrait: null }
    if (url === "/api/characters/chr-1/export") {
      exportGetCount += 1
      if (exportErrorForTest) throw exportErrorForTest
      return { events: historyEvents }
    }
    if (url === "/api/characters/chr-2/export") {
      exportGetCount += 1
      if (exportErrorForTest) throw exportErrorForTest
      return { events: historyEvents }
    }
    if (url === "/api/characters/chr-1/skills/refresh" && method === "POST") {
      skillRefreshPosts += 1
      const deferred = skillRefreshDeferred
      skillRefreshDeferred = null
      if (deferred) return deferred.promise
      if (skillRefreshErrorForTest) throw skillRefreshErrorForTest
      return { character: skillRefreshCharacter ?? activeCharacter }
    }
    if (url === "/api/characters/chr-2/skills/refresh" && method === "POST") {
      skillRefreshPosts += 1
      const deferred = skillRefreshDeferredB
      skillRefreshDeferredB = null
      if (deferred) return deferred.promise
      if (skillRefreshErrorForTest) throw skillRefreshErrorForTest
      return { character: characterB ?? activeCharacter }
    }
    if (url === "/api/characters/chr-1/skills" && method === "POST") {
      const body = JSON.parse((init?.body as string) ?? "{}") as Record<
        string,
        unknown
      >
      skillSelectPosts.push(body)
      return { character: activeCharacter }
    }
    if (url === "/api/catalog/professions")
      return { kind: "catalog", items: professionCatalog }
    if (url === "/api/characters/chr-1/profession" && method === "POST") {
      const body = JSON.parse((init?.body as string) ?? "{}") as Record<
        string,
        unknown
      >
      professionPosts.push(body)
      if (professionPostError) throw professionPostError
      return { character: activeCharacter }
    }
    if (url === "/api/characters/chr-1/advance" && method === "POST") {
      const body = JSON.parse((init?.body as string) ?? "{}") as Record<
        string,
        unknown
      >
      advancePosts.push(body)
      if (advanceError) throw advanceError
      return { journal: {} }
    }
    if (url === "/api/characters/chr-1/experience" && method === "POST") {
      const body = JSON.parse((init?.body as string) ?? "{}") as Record<
        string,
        unknown
      >
      experiencePosts.push(body)
      if (experienceError) throw experienceError
      if (body.operation === "set") {
        const percent = Number(body.percent)
        if (body.track === "race")
          activeCharacter = {
            ...activeCharacter,
            state: {
              ...activeCharacter.state,
              race: {
                ...activeCharacter.state.race,
                experiencePercent: percent === 100 ? 0 : percent,
              },
            },
          } as typeof activeCharacter
        if (body.track === "class" || body.track === "profession") {
          const track = body.track
          activeCharacter = {
            ...activeCharacter,
            state: {
              ...activeCharacter.state,
              tracks: {
                ...activeCharacter.state.tracks,
                [track]: {
                  ...activeCharacter.state.tracks[track],
                  experiencePercent: percent,
                },
              },
            },
          } as typeof activeCharacter
        }
      }
      return { character: activeCharacter, journal: experienceJournal }
    }
    if (url.startsWith("/api/characters/chr-1/evolutions")) {
      if (evolutionsError) throw evolutionsError
      return { options: [], legacyAvailable: false }
    }
    if (url === "/api/catalog/gods") {
      return { kind: "catalog", items: blessingsCatalog }
    }
    if (url === "/api/catalog/bloodlines") {
      return { kind: "catalog", items: bloodlinesCatalog }
    }
    if (url === "/api/catalog/transcendent_skills") {
      return { kind: "catalog", items: transcendentCatalog }
    }
    if (url === "/api/catalog/titles") {
      return { kind: "catalog", items: titlesCatalog }
    }
    if (url === "/api/catalog/equipment") {
      return { kind: "catalog", items: equipmentCatalog }
    }
    if (url === "/api/catalog/items") {
      return { kind: "catalog", items: itemsCatalog }
    }
    if (url === "/api/catalog/skills")
      return { kind: "catalog", items: skillsCatalogForTest }
    if (url === "/api/characters/chr-1/skills/upgrade" && method === "POST") {
      const body = JSON.parse((init?.body as string) ?? "{}") as Record<
        string,
        unknown
      >
      upgradePostsForTest.push(body)
      if (upgradeErrorForTest) throw upgradeErrorForTest
      activeCharacter = {
        ...activeCharacter,
        version: activeCharacter.version + 1,
        associations: activeCharacter.associations.map((a) =>
          a.kind === "skill"
            ? {
                ...a,
                definitionId: String(body.definitionId),
                name:
                  skillsCatalogForTest.find((s) => s.id === body.definitionId)
                    ?.name ?? a.name,
                rarity: String(
                  skillsCatalogForTest.find((s) => s.id === body.definitionId)
                    ?.config.rarity ?? ""
                ),
              }
            : a
        ),
      }
      return { character: activeCharacter }
    }
    if (url === "/api/characters/chr-1/associations" && method === "POST") {
      if (associationsError) throw associationsError
      const body = JSON.parse((init?.body as string) ?? "{}") as {
        kind: "blessing" | "bloodline" | "transcendent" | "title" | "equipment"
        definitionId: string
        operation: "add" | "remove" | "use"
        version: number
      }
      if (body.kind === "title") {
        if (body.operation === "remove") {
          activeCharacter = {
            ...activeCharacter,
            associations: activeCharacter.associations.filter(
              (a) =>
                !(a.kind === "title" && a.definitionId === body.definitionId)
            ),
          }
        } else {
          const item = titlesCatalog.find(
            (title) => title.id === body.definitionId
          )
          activeCharacter = {
            ...activeCharacter,
            associations: [
              ...activeCharacter.associations,
              association({
                id: `title-${body.definitionId}`,
                kind: "title",
                definitionId: body.definitionId,
                name: item?.name ?? body.definitionId,
                ...(typeof item?.config?.upgradeGroup === "string"
                  ? { upgradeGroup: item.config.upgradeGroup as string }
                  : {}),
              }),
            ],
          }
        }
      } else {
        activeCharacter = applyAssociation(
          activeCharacter,
          body as Parameters<typeof applyAssociation>[1]
        )
      }
      return { character: activeCharacter }
    }
    if (url === "/api/characters/chr-1/inventory" && method === "POST") {
      if (inventoryError) throw inventoryError
      const body = JSON.parse((init?.body as string) ?? "{}") as {
        operation: "add" | "remove"
        definitionId: string
        quantity: number
        version: number
        sourceNote?: string
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

/** Locate an open panel through its accessible, visually-hidden sheet title. */
function associationSheetContent(
  panel: "titlesSkills" | "powers" | "inventoryEquipment" = "titlesSkills"
) {
  const names = {
    titlesSkills: "Titles and skills",
    powers: "Blessings and bloodlines",
    inventoryEquipment: "Inventory and equipment",
  }
  return screen.getByRole("heading", { name: names[panel] }).parentElement!
    .parentElement!
}

beforeEach(() => {
  evolutionsError = null
  mockRouteId = "chr-1"
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// --- Tests ---------------------------------------------------------------- //

describe("association panel separation", () => {
  it("opens only the requested category and keeps each panel's tabs isolated", async () => {
    setupMock()
    await renderDetail()

    fireEvent.click(screen.getByRole("button", { name: "Manage titles" }))
    const titles = associationSheetContent("titlesSkills")
    expect(within(titles).getByRole("tab", { name: "Titles" })).toBeTruthy()
    expect(within(titles).getByRole("tab", { name: "Skills" })).toBeTruthy()
    expect(
      screen.queryByRole("heading", { name: "Blessings and bloodlines" })
    ).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Manage equipment" }))
    const equipment = associationSheetContent("inventoryEquipment")
    expect(
      within(equipment).getByRole("tab", { name: "Inventory" })
    ).toBeTruthy()
    expect(
      within(equipment).getByRole("tab", { name: "Equipment" })
    ).toBeTruthy()
    expect(
      screen.queryByRole("heading", { name: "Titles and skills" })
    ).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Manage blessings" }))
    const powers = associationSheetContent("powers")
    expect(within(powers).getByRole("tab", { name: "Blessings" })).toBeTruthy()
    expect(within(powers).getByRole("tab", { name: "Bloodlines" })).toBeTruthy()
    expect(
      within(powers).getByRole("tab", { name: "Transcendent skills" })
    ).toBeTruthy()
    expect(within(powers).queryByRole("tab", { name: "Titles" })).toBeNull()
    expect(
      screen.queryByRole("heading", { name: "Inventory and equipment" })
    ).toBeNull()
  })
})

describe("scheduled skill choice prompts", () => {
  const pendingOffer = (overrides: Record<string, unknown> = {}) => ({
    id: "offer-class-1",
    track: "class",
    level: 25,
    choiceGroup: "milestone",
    generation: 0,
    canceledAt: null,
    selectedDefinitionId: null,
    options: [
      { definitionId: "skill-1", nameSnapshot: "Quick Shot", archived: false },
    ],
    ...overrides,
  })

  it("routes owner offer selection through Titles and Skills before confirming the select API action", async () => {
    setupMock({
      character: {
        ...character,
        skillOffers: [
          pendingOffer({
            options: [
              {
                definitionId: "skill-1",
                nameSnapshot: "Quick Shot",
                archived: false,
                classPriority: true,
                grade: "A",
              },
            ],
          }),
        ],
      } as typeof character,
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("button", { name: "Choose skill" }))
    const sheet = associationSheetContent("titlesSkills")
    expect(within(sheet).getByText("A")).toBeTruthy()
    expect(within(sheet).getByRole("tab", { name: "Skills" })).toBeTruthy()
    expect(within(sheet).getByText("Class match")).toBeTruthy()
    fireEvent.click(within(sheet).getByRole("button", { name: "Select" }))
    fireEvent.click(screen.getAllByRole("button", { name: "Select" }).at(-1)!)
    await flush()
    expect(skillSelectPosts).toEqual([
      expect.objectContaining({
        operation: "select",
        offerId: "offer-class-1",
        definitionId: "skill-1",
        version: 3,
      }),
    ])
    expect(skillSelectPosts.some((post) => post.operation === "grant")).toBe(
      false
    )
  })

  it("shows a zero-option waiting state in the Skills sheet and retries refresh", async () => {
    setupMock({
      character: {
        ...character,
        skillOffers: [pendingOffer({ options: [] })],
      } as typeof character,
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("button", { name: "Manage skills" }))
    const sheet = associationSheetContent("titlesSkills")
    expect(
      within(sheet).getByText("No eligible skill options are available yet.")
    ).toBeTruthy()
    fireEvent.click(
      within(sheet).getByRole("button", { name: "Retry refresh" })
    )
    await flush()
    expect(skillRefreshPosts).toBe(2)
  })

  it("keeps server option order, badges class priority, and leaves cross-class options selectable", async () => {
    const offer = pendingOffer({
      options: [
        {
          definitionId: "priority",
          nameSnapshot: "Priority Skill",
          archived: false,
          classPriority: true,
        },
        {
          definitionId: "other",
          nameSnapshot: "Other Class Skill",
          archived: false,
          classPriority: false,
        },
      ],
    })
    setupMock({
      character: { ...character, skillOffers: [offer] } as typeof character,
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("button", { name: "Manage skills" }))
    const sheet = associationSheetContent("titlesSkills")
    const priority = within(sheet).getByText("Priority Skill").parentElement!
    expect(within(priority).getByText("Class match")).toBeTruthy()
    expect(within(sheet).getByText("Other Class Skill")).toBeTruthy()
    expect(
      within(sheet).getAllByRole("button", { name: "Select" })
    ).toHaveLength(2)
  })

  it("searches offered skills by snapshot fields, clears to restore options, and keeps the list scrollable", async () => {
    const offer = pendingOffer({
      options: [
        {
          definitionId: "s1",
          nameSnapshot: "Quick Shot",
          archived: false,
          rarity: "Rare",
          skillType: "active",
          classStableId: "archer-class",
        },
        {
          definitionId: "s2",
          nameSnapshot: "Stone Skin",
          archived: false,
          rarity: "Common",
          skillType: "passive",
          classStableId: "mage-class",
        },
      ],
    })
    setupMock({
      character: { ...character, skillOffers: [offer] } as typeof character,
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("button", { name: "Manage skills" }))
    const sheet = associationSheetContent("titlesSkills")
    const search = within(sheet).getByRole("searchbox", {
      name: "Search offered skills",
    })
    const options = within(sheet).getByLabelText("Skill offer options")
    expect(options.className).toContain("overflow-y-auto")
    expect(options.className).toContain("max-h-[min(20rem,50vh)]")
    fireEvent.change(search, { target: { value: "ARCHER-CLASS" } })
    expect(within(sheet).getByText("Quick Shot")).toBeTruthy()
    expect(within(sheet).queryByText("Stone Skin")).toBeNull()
    fireEvent.change(search, { target: { value: "unmatched" } })
    expect(
      within(sheet).getByText("No offered skills match your search.")
    ).toBeTruthy()
    fireEvent.change(search, { target: { value: "" } })
    expect(within(sheet).getByText("Stone Skin")).toBeTruthy()
    fireEvent.click(
      within(sheet).getAllByRole("button", { name: "Select" })[0]!
    )
    fireEvent.click(screen.getAllByRole("button", { name: "Select" }).at(-1)!)
    await flush()
    expect(skillSelectPosts.at(-1)).toEqual(
      expect.objectContaining({ definitionId: "s1" })
    )
  })

  it("counts pending monster Race offers on the sheet", async () => {
    setupMock({
      character: {
        ...character,
        skillOffers: [
          pendingOffer({ id: "race-offer", track: "race", options: [] }),
        ],
      } as typeof character,
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("button", { name: "Manage skills" }))
    const sheet = associationSheetContent("titlesSkills")
    expect(within(sheet).getByText("Race: 1 pending")).toBeTruthy()
    expect(within(sheet).getByText("Class: 0 pending")).toBeTruthy()
  })

  it("opens the matching Skills sheet with Choose now and defers without a request", async () => {
    setupMock({
      experienceJournal: {
        leveledUp: true,
        notes: [],
        skillOfferIds: ["offer-class-1"],
      },
      character: {
        ...character,
        skillOffers: [pendingOffer()],
      } as typeof character,
    })
    await renderDetail()
    fireEvent.click(
      screen.getByRole("button", { name: "Increase class level" })
    )
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Choose now" }))
    const sheet = associationSheetContent("titlesSkills")
    expect(within(sheet).getByRole("tab", { name: "Skills" })).toBeTruthy()
    expect(sheet.querySelector("#skill-offer-offer-class-1")).toBeTruthy()
    expect(skillSelectPosts).toHaveLength(0)

    expect(skillSelectPosts).toHaveLength(0)
  })

  it("closes a level-up prompt with Decide later without submitting a selection", async () => {
    setupMock({
      experienceJournal: {
        leveledUp: true,
        notes: [],
        skillOfferIds: ["offer-class-1"],
      },
      character: {
        ...character,
        skillOffers: [pendingOffer()],
      } as typeof character,
    })
    await renderDetail()
    fireEvent.click(
      screen.getByRole("button", { name: "Increase class level" })
    )
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Decide later" }))
    await flush()
    expect(screen.queryByText("Choose a skill")).toBeNull()
    expect(skillSelectPosts).toHaveLength(0)
  })

  it("prompts only for a newly generated scheduled credit, selects through the skill API, and does not repeat on load", async () => {
    setupMock({
      experienceJournal: {
        leveledUp: true,
        notes: [],
        skillOfferIds: ["offer-class-1"],
      },
      character: {
        ...character,
        skillOffers: [pendingOffer()],
      } as typeof character,
    })
    await renderDetail()
    expect(skillRefreshPosts).toBe(1)
    expect(screen.queryByText("Choose a skill")).toBeNull()
    fireEvent.click(
      screen.getByRole("button", { name: "Increase class level" })
    )
    await flush()
    expect(screen.getByText("Choose a skill")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Choose now" }))
    const sheet = associationSheetContent("titlesSkills")
    fireEvent.click(within(sheet).getByRole("button", { name: "Select" }))
    fireEvent.click(screen.getAllByRole("button", { name: "Select" }).at(-1)!)
    await flush()
    expect(skillSelectPosts).toEqual([
      expect.objectContaining({
        operation: "select",
        offerId: "offer-class-1",
        definitionId: "skill-1",
        version: 3,
      }),
    ])
    expect(screen.queryByText("Choose a skill")).toBeNull()
  })

  it("defers empty-option prompts and counts pending offers per track excluding selected/canceled", async () => {
    setupMock({
      experienceJournal: {
        leveledUp: true,
        notes: [],
        skillOfferIds: ["offer-class-1"],
      },
      character: {
        ...character,
        skillOffers: [
          pendingOffer({ options: [] }),
          pendingOffer({ id: "selected", selectedDefinitionId: "skill-x" }),
          pendingOffer({ id: "canceled", canceledAt: "now" }),
          pendingOffer({ id: "profession", track: "profession" }),
        ],
      } as typeof character,
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()
    const skillsPanel = screen.getByTestId("panel-skills")
    expect(within(skillsPanel).getByText("Class: 1 pending")).toBeTruthy()
    expect(within(skillsPanel).getByText("Profession: 1 pending")).toBeTruthy()
    fireEvent.click(
      screen.getByRole("button", { name: "Increase class level" })
    )
    await flush()
    expect(screen.getByText("Awaiting eligible skills")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Decide later" }))
    await flush()
    expect(screen.queryByText("Choose a skill")).toBeNull()
    expect(skillSelectPosts).toHaveLength(0)
  })

  it("refreshes on Skills tab entry and keeps fixed Stats rows unindented", async () => {
    setupMock()
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()
    expect(skillRefreshPosts).toBe(2)
    fireEvent.click(screen.getByRole("tab", { name: "Stats" }))
    await flush()
    expect(document.querySelectorAll(".pl-3")).toHaveLength(0)
  })

  it("does not prompt on a level-up without a newly created scheduled credit", async () => {
    setupMock({
      experienceJournal: { leveledUp: true, notes: [], skillOfferIds: [] },
      character: {
        ...character,
        skillOffers: [pendingOffer()],
      } as typeof character,
    })
    await renderDetail()
    fireEvent.click(
      screen.getByRole("button", { name: "Increase class level" })
    )
    await flush()
    expect(screen.queryByText("Choose a skill")).toBeNull()
  })

  it("prompts for a new milestone credit when setting EXP to 100%", async () => {
    setupMock({
      experienceJournal: {
        leveledUp: true,
        notes: [],
        skillOfferIds: ["offer-class-1"],
      },
      character: {
        ...character,
        skillOffers: [pendingOffer()],
      } as typeof character,
    })
    await renderDetail()
    const slider = screen.getByRole("slider", { name: "Experience slider" })
    fireEvent.change(slider, { target: { value: "100" } })
    fireEvent.mouseUp(slider, { target: { value: "100" } })
    await flush()
    expect(experiencePosts).toEqual([
      expect.objectContaining({
        operation: "set",
        track: "class",
        percent: 100,
      }),
    ])
    expect(screen.getByText("Choose a skill")).toBeTruthy()
  })

  it("does not prompt when setting EXP to 100% does not level up", async () => {
    setupMock({ experienceJournal: { leveledUp: false, notes: [] } })
    await renderDetail()
    const slider = screen.getByRole("slider", { name: "Experience slider" })
    fireEvent.change(slider, { target: { value: "100" } })
    fireEvent.mouseUp(slider, { target: { value: "100" } })
    await flush()
    expect(screen.queryByText("Choose a skill")).toBeNull()
  })

  it("offers retry after refresh failure and applies newly eligible choices on retry", async () => {
    setupMock()
    skillRefreshErrorForTest = new Error("refresh unavailable")
    await renderDetail()
    expect(
      screen.getByText("Skill options could not be refreshed.")
    ).toBeTruthy()
    skillRefreshErrorForTest = null
    skillRefreshCharacter = {
      ...character,
      skillOffers: [
        pendingOffer({
          options: [
            {
              definitionId: "late",
              nameSnapshot: "Late Skill",
              archived: false,
            },
          ],
        }),
      ],
    } as typeof character
    fireEvent.click(screen.getByRole("button", { name: "Retry skill options" }))
    await flush()
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()
    expect(screen.getByText("Late Skill")).toBeTruthy()
    expect(skillRefreshPosts).toBeGreaterThanOrEqual(2)
  })

  it("does not let a delayed refresh with an older version clobber the newer state after a level-up", async () => {
    // A refresh fired on open resolves only after the level-up has produced a
    // newer character. The obsolete snapshot must not overwrite the newer state.
    const refreshDeferred = createDeferred<{
      character: import("@/lib/api").CharacterDetail
    }>()
    setupMock({
      experienceJournal: {
        leveledUp: true,
        notes: [],
        skillOfferIds: ["offer-class-1"],
      },
      character: {
        ...character,
        skillOffers: [pendingOffer()],
      } as typeof character,
    })
    skillRefreshDeferred = refreshDeferred
    await renderDetail()

    // The server now holds a NEWER version plus the offer.
    activeCharacter = {
      ...activeCharacter,
      version: 4,
      skillOffers: [pendingOffer()],
    } as typeof activeCharacter
    fireEvent.click(
      screen.getByRole("button", { name: "Increase class level" })
    )
    await flush()
    expect(screen.getByText("Choose a skill")).toBeTruthy()

    // The stale refresh from before the level-up resolves late with a LOWER
    // version and an empty offer set; it must be ignored.
    refreshDeferred.resolve({
      character: {
        ...character,
        version: 3,
        skillOffers: [],
      } as typeof character,
    })
    await flush()

    // The dialog and its offer stay, and the pending count is untouched.
    expect(screen.getByText("Choose a skill")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Choose now" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Choose now" }))
    const skillSheet = associationSheetContent("titlesSkills")
    fireEvent.click(within(skillSheet).getByRole("tab", { name: "Skills" }))
    await flush()
    expect(within(skillSheet).getByText("Class: 1 pending")).toBeTruthy()

    // A subsequent action still carries the current (newer) version.
    fireEvent.click(within(skillSheet).getByRole("button", { name: "Select" }))
    fireEvent.click(screen.getAllByRole("button", { name: "Select" }).at(-1)!)
    await flush()
    expect(skillSelectPosts).toEqual([
      expect.objectContaining({ operation: "select", version: 4 }),
    ])
  })

  it("does not resurrect a pending offer when a delayed refresh resolves after a selection", async () => {
    const refreshDeferred = createDeferred<{
      character: import("@/lib/api").CharacterDetail
    }>()
    setupMock({
      experienceJournal: {
        leveledUp: true,
        notes: [],
        skillOfferIds: ["offer-class-1"],
      },
      character: {
        ...character,
        skillOffers: [pendingOffer()],
      } as typeof character,
    })
    skillRefreshDeferred = refreshDeferred
    await renderDetail()

    activeCharacter = {
      ...activeCharacter,
      version: 4,
      skillOffers: [pendingOffer()],
    } as typeof activeCharacter
    fireEvent.click(
      screen.getByRole("button", { name: "Increase class level" })
    )
    await flush()
    expect(screen.getByText("Choose a skill")).toBeTruthy()

    // Selecting terminalizes the offer (selected) and bumps the version.
    activeCharacter = {
      ...activeCharacter,
      version: 5,
      skillOffers: [pendingOffer({ selectedDefinitionId: "skill-1" })],
    } as typeof activeCharacter
    fireEvent.click(screen.getByRole("button", { name: "Choose now" }))
    const skillSheet = associationSheetContent("titlesSkills")
    fireEvent.click(within(skillSheet).getByRole("button", { name: "Select" }))
    fireEvent.click(screen.getAllByRole("button", { name: "Select" }).at(-1)!)
    await flush()
    expect(screen.queryByText("Choose a skill")).toBeNull()

    // The obsolete refresh arrives late with a lower version and the offer still
    // pending; it must not turn the selected offer back into a pending one.
    refreshDeferred.resolve({
      character: {
        ...character,
        version: 3,
        skillOffers: [pendingOffer()],
      } as typeof character,
    })
    await flush()

    fireEvent.click(within(skillSheet).getByRole("tab", { name: "Skills" }))
    await flush()
    const skillsPanel = skillSheet
    expect(within(skillsPanel).getByText("Class: 0 pending")).toBeTruthy()
    expect(screen.queryByText("Selected")).toBeNull()
    expect(within(skillsPanel).queryByText("Pending")).toBeNull()
  })

  it("does not let a delayed same-version refresh omit offer details that still exist", async () => {
    // A mutation can leave the version unchanged while still adding an offer
    // (e.g. the snapshot predates a bump). A delayed refresh that omits the
    // pending offer must not drop it from the live state.
    const refreshDeferred = createDeferred<{
      character: import("@/lib/api").CharacterDetail
    }>()
    setupMock({
      experienceJournal: {
        leveledUp: true,
        notes: [],
        skillOfferIds: ["offer-class-1"],
      },
      character: {
        ...character,
        skillOffers: [pendingOffer()],
      } as typeof character,
    })
    skillRefreshDeferred = refreshDeferred
    await renderDetail()
    // No version bump: the level-up keeps version 3.
    fireEvent.click(
      screen.getByRole("button", { name: "Increase class level" })
    )
    await flush()
    expect(screen.getByText("Choose a skill")).toBeTruthy()
    // The delayed snapshot reports the same version but omits the offer.
    refreshDeferred.resolve({
      character: {
        ...character,
        version: 3,
        skillOffers: [],
      } as typeof character,
    })
    await flush()
    expect(screen.getByText("Choose a skill")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Choose now" })).toBeTruthy()
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()
    expect(
      within(screen.getByTestId("panel-skills")).getByText("Class: 1 pending")
    ).toBeTruthy()
  })

  it("retains selected/canceled terminal status when a same-version refresh returns pending offers", async () => {
    setupMock({
      character: {
        ...character,
        skillOffers: [
          pendingOffer({ id: "offer-a", selectedDefinitionId: "skill-1" }),
          pendingOffer({ id: "offer-b", canceledAt: "now" }),
        ],
      } as typeof character,
    })
    // A same-version snapshot that (incorrectly) reports both offers as pending
    // must not wipe the terminal status from the live state.
    skillRefreshCharacter = {
      ...character,
      skillOffers: [
        pendingOffer({ id: "offer-a" }),
        pendingOffer({ id: "offer-b" }),
      ],
    } as typeof character
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()
    expect(screen.queryByText("Selected")).toBeNull()
    expect(screen.queryByText("Canceled")).toBeNull()
  })

  it("retains same-version offer options appended after a captured GET snapshot was read", async () => {
    setupMock({
      experienceJournal: { leveledUp: false, notes: [] },
      character: {
        ...character,
        skillOffers: [pendingOffer()],
      } as typeof character,
    })
    await renderDetail()
    expect(screen.getByText("Quick Shot")).toBeTruthy()

    // Capture the reload GET fired by the upcoming level-up as deferred.
    const getDeferred = createDeferred<{
      character: import("@/lib/api").CharacterDetail
    }>()
    characterGetDeferred = getDeferred

    // While that GET is in flight, a skill refresh appends a second option on the
    // same version.
    skillRefreshCharacter = {
      ...character,
      skillOffers: [
        pendingOffer({
          options: [
            {
              definitionId: "skill-1",
              nameSnapshot: "Quick Shot",
              archived: false,
            },
            {
              definitionId: "skill-2",
              nameSnapshot: "Aim Shot",
              archived: false,
            },
          ],
        }),
      ],
    } as typeof character

    fireEvent.click(
      screen.getByRole("button", { name: "Increase class level" })
    )
    await flush()
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()
    expect(screen.getByText("Quick Shot")).toBeTruthy()
    expect(screen.getByText("Aim Shot")).toBeTruthy()

    // The stale GET snapshot resolves late with the SAME version but only the
    // original option; the appended option must survive the merge.
    getDeferred.resolve({
      character: {
        ...character,
        version: 3,
        skillOffers: [pendingOffer()],
      } as typeof character,
    })
    await flush()

    expect(screen.getByText("Quick Shot")).toBeTruthy()
    expect(screen.getByText("Aim Shot")).toBeTruthy()
  })

  it("keeps notes, selected state, and version newer when a captured GET resolves after a later mutation", async () => {
    setupMock({
      experienceJournal: { leveledUp: false, notes: [] },
      character: {
        ...character,
        skillOffers: [pendingOffer()],
      } as typeof character,
    })
    await renderDetail()
    expect(screen.getByText("v3")).toBeTruthy()

    // Start an in-progress editable note draft.
    fireEvent.click(screen.getByRole("tab", { name: "Notes" }))
    await flush()
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Draft" },
    })
    await flush()

    // Capture the reload GET fired by the upcoming level-up as deferred.
    const getDeferred = createDeferred<{
      character: import("@/lib/api").CharacterDetail
    }>()
    characterGetDeferred = getDeferred
    fireEvent.click(
      screen.getByRole("button", { name: "Increase class level" })
    )
    await flush()

    // The later mutation terminalizes the offer, bumps the version, and renames
    // the character; its refresh applies that newer state.
    activeCharacter = {
      ...activeCharacter,
      version: 5,
      name: "Newest",
      skillOffers: [pendingOffer({ selectedDefinitionId: "skill-1" })],
    } as typeof activeCharacter
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()

    // The stale GET from before the mutation resolves last with an older
    // snapshot; it must not clobber the newer version, selected state, or notes.
    getDeferred.resolve({
      character: {
        ...character,
        version: 3,
        name: "Test",
        skillOffers: [pendingOffer()],
      } as typeof character,
    })
    await flush()

    expect(screen.getByText("v5")).toBeTruthy()
    expect(screen.queryByText("Selected")).toBeNull()

    fireEvent.click(screen.getByRole("tab", { name: "Notes" }))
    await flush()
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Draft"
    )
  })

  it("does not reset an in-progress note draft when a same-version refresh occurs", async () => {
    setupMock({
      experienceJournal: { leveledUp: false, notes: [] },
      character: { ...character } as typeof character,
    })
    await renderDetail()

    fireEvent.click(screen.getByRole("tab", { name: "Notes" }))
    await flush()
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Draft" },
    })
    await flush()

    const getDeferred = createDeferred<{
      character: import("@/lib/api").CharacterDetail
    }>()
    characterGetDeferred = getDeferred
    fireEvent.click(
      screen.getByRole("button", { name: "Increase class level" })
    )
    await flush()

    // A same-version refresh resolves while the user has an unsaved edit; it
    // must not clobber the draft even though it reports the same version.
    getDeferred.resolve({
      character: { ...character, version: 3 } as typeof character,
    })
    await flush()

    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Draft"
    )
  })

  it("toggles an offer option archived flag on the same version without duplicating the option or changing the snapshot", async () => {
    setupMock({
      experienceJournal: {
        leveledUp: true,
        notes: [],
        skillOfferIds: ["offer-class-1"],
      },
      character: {
        ...character,
        skillOffers: [
          pendingOffer({
            options: [
              {
                definitionId: "skill-1",
                nameSnapshot: "Quick Shot",
                archived: false,
                grade: "C",
              },
            ],
          }),
        ],
      } as typeof character,
    })
    await renderDetail()
    fireEvent.click(
      screen.getByRole("button", { name: "Increase class level" })
    )
    await flush()
    expect(screen.getByRole("button", { name: "Choose now" })).toBeTruthy()

    // The catalog archives the offer's definition (same version). The mutable
    // `archived` flag flips, but the incoming snapshot's different name does NOT
    // overwrite the immutable prior nameSnapshot, and no duplicate option is
    // created.
    skillRefreshCharacter = {
      ...character,
      version: 3,
      skillOffers: [
        pendingOffer({
          options: [
            {
              definitionId: "skill-1",
              nameSnapshot: "Renamed Shot",
              archived: true,
              grade: "C",
            },
          ],
        }),
      ],
    } as typeof character
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()
    expect(screen.getByText("Awaiting eligible skills")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Quick Shot" })).toBeNull()

    // The catalog is re-enabled (same version): archived flips back to false, the
    // immutable prior snapshot (nameSnapshot "Quick Shot") still wins over the
    // incoming rename, and there is still exactly one option - no duplicate.
    skillRefreshCharacter = {
      ...character,
      version: 3,
      skillOffers: [
        pendingOffer({
          options: [
            {
              definitionId: "skill-1",
              nameSnapshot: "Renamed Shot",
              archived: false,
              grade: "C",
            },
          ],
        }),
      ],
    } as typeof character
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()
    expect(screen.getAllByText("Quick Shot")).toHaveLength(1)
    expect(screen.queryByText("Renamed Shot")).toBeNull()
  })

  it("does not let a deferred same-version GET roll back archive state that a newer refresh applied", async () => {
    setupMock({
      experienceJournal: { leveledUp: true, notes: [], skillOfferIds: [] },
      character: {
        ...character,
        skillOffers: [
          pendingOffer({
            options: [
              {
                definitionId: "skill-1",
                nameSnapshot: "Quick Shot",
                archived: false,
              },
            ],
          }),
        ],
      } as typeof character,
    })
    await renderDetail()

    // Capture the reload GET fired by the upcoming level-up as deferred. It read
    // (and will return) the same-version UNARCHIVED snapshot.
    const getDeferred = createDeferred<{
      character: import("@/lib/api").CharacterDetail
    }>()
    characterGetDeferred = getDeferred

    // While that GET is in flight, a skills/refresh archives the offer's option.
    skillRefreshCharacter = {
      ...character,
      version: 3,
      skillOffers: [
        pendingOffer({
          options: [
            {
              definitionId: "skill-1",
              nameSnapshot: "Quick Shot",
              archived: true,
            },
          ],
        }),
      ],
    } as typeof character

    fireEvent.click(
      screen.getByRole("button", { name: "Increase class level" })
    )
    await flush()
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()

    // The refresh archived the option; it must no longer be selectable.
    expect(screen.getAllByText("Archived").length).toBeGreaterThan(0)
    expect(screen.queryByRole("button", { name: "Select" })).toBeNull()

    // The stale GET resolves LAST with the same version but UNARCHIVED; it must
    // NOT roll the option back to a selectable (unarchived) offer.
    getDeferred.resolve({
      character: {
        ...character,
        version: 3,
        skillOffers: [
          pendingOffer({
            options: [
              {
                definitionId: "skill-1",
                nameSnapshot: "Quick Shot",
                archived: false,
              },
            ],
          }),
        ],
      } as typeof character,
    })
    await flush()

    expect(screen.getAllByText("Archived").length).toBeGreaterThan(0)
    expect(screen.queryByRole("button", { name: "Select" })).toBeNull()
  })

  it("does not let a deferred same-version GET re-archive an option that a newer refresh re-enabled", async () => {
    setupMock({
      experienceJournal: { leveledUp: true, notes: [], skillOfferIds: [] },
      character: {
        ...character,
        skillOffers: [
          pendingOffer({
            options: [
              {
                definitionId: "skill-1",
                nameSnapshot: "Quick Shot",
                archived: false,
              },
            ],
          }),
        ],
      } as typeof character,
    })
    await renderDetail()

    // Archive the option first via a refresh (same version).
    skillRefreshCharacter = {
      ...character,
      version: 3,
      skillOffers: [
        pendingOffer({
          options: [
            {
              definitionId: "skill-1",
              nameSnapshot: "Quick Shot",
              archived: true,
            },
          ],
        }),
      ],
    } as typeof character
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()
    expect(screen.getAllByText("Archived").length).toBeGreaterThan(0)
    expect(screen.queryByRole("button", { name: "Select" })).toBeNull()

    // Capture the reload GET fired by the upcoming level-up as deferred. It read
    // (and will return) the ARCHIVED snapshot.
    const getDeferred = createDeferred<{
      character: import("@/lib/api").CharacterDetail
    }>()
    characterGetDeferred = getDeferred

    // While that GET is in flight, a newer refresh re-enables the option.
    skillRefreshCharacter = {
      ...character,
      version: 3,
      skillOffers: [
        pendingOffer({
          options: [
            {
              definitionId: "skill-1",
              nameSnapshot: "Quick Shot",
              archived: false,
            },
          ],
        }),
      ],
    } as typeof character

    fireEvent.click(
      screen.getByRole("button", { name: "Increase class level" })
    )
    await flush()
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()

    // The refresh re-enabled the option; it is selectable again.
    expect(screen.getByRole("button", { name: "Choose skill" })).toBeTruthy()
    expect(screen.queryByText("Archived")).toBeNull()

    // The stale GET resolves LAST with archived:true (same version); it must NOT
    // re-archive the re-enabled option.
    getDeferred.resolve({
      character: {
        ...character,
        version: 3,
        skillOffers: [
          pendingOffer({
            options: [
              {
                definitionId: "skill-1",
                nameSnapshot: "Quick Shot",
                archived: true,
              },
            ],
          }),
        ],
      } as typeof character,
    })
    await flush()

    expect(screen.getByRole("button", { name: "Choose skill" })).toBeTruthy()
    expect(screen.queryByText("Archived")).toBeNull()
  })

  it("appends a new skill option from an older-started refresh that resolves after a faster empty GET", async () => {
    const refreshDeferred = createDeferred<{
      character: import("@/lib/api").CharacterDetail
    }>()
    setupMock({
      experienceJournal: { leveledUp: false, notes: [] },
      character: { ...character, skillOffers: [] } as typeof character,
    })
    // Hold the on-open refresh in flight so it starts BEFORE the initial GET and
    // resolves AFTER it. It began first but is last to resolve.
    skillRefreshDeferred = refreshDeferred
    await renderDetail()
    // The initial GET has resolved with no offers; the refresh is still pending.
    // Resolve it with a NEW skill appended on the same version.
    refreshDeferred.resolve({
      character: {
        ...character,
        version: 3,
        skillOffers: [
          pendingOffer({
            options: [
              {
                definitionId: "skill-x",
                nameSnapshot: "Late Skill",
                archived: false,
              },
            ],
          }),
        ],
      } as typeof character,
    })
    await flush()
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()
    expect(screen.getByText("Late Skill")).toBeTruthy()
  })

  it("still does not let a stale older-started GET roll back an archived flag that a refresh applied", async () => {
    setupMock({
      experienceJournal: { leveledUp: true, notes: [], skillOfferIds: [] },
      character: {
        ...character,
        skillOffers: [
          pendingOffer({
            options: [
              {
                definitionId: "skill-1",
                nameSnapshot: "Quick Shot",
                archived: false,
              },
            ],
          }),
        ],
      } as typeof character,
    })
    await renderDetail()

    // Capture the reload GET fired by the upcoming level-up as deferred. It read
    // (and will return) the same-version UNARCHIVED snapshot and started BEFORE
    // the archival refresh.
    const getDeferred = createDeferred<{
      character: import("@/lib/api").CharacterDetail
    }>()
    characterGetDeferred = getDeferred

    // While that GET is in flight, a skills/refresh archives the option.
    skillRefreshCharacter = {
      ...character,
      version: 3,
      skillOffers: [
        pendingOffer({
          options: [
            {
              definitionId: "skill-1",
              nameSnapshot: "Quick Shot",
              archived: true,
            },
          ],
        }),
      ],
    } as typeof character

    fireEvent.click(
      screen.getByRole("button", { name: "Increase class level" })
    )
    await flush()
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()
    expect(screen.getAllByText("Archived").length).toBeGreaterThan(0)
    expect(screen.queryByRole("button", { name: "Select" })).toBeNull()

    // The stale GET resolves LAST with the same version but UNARCHIVED; it must
    // NOT roll the option back to a selectable (unarchived) offer.
    getDeferred.resolve({
      character: {
        ...character,
        version: 3,
        skillOffers: [
          pendingOffer({
            options: [
              {
                definitionId: "skill-1",
                nameSnapshot: "Quick Shot",
                archived: false,
              },
            ],
          }),
        ],
      } as typeof character,
    })
    await flush()

    expect(screen.getAllByText("Archived").length).toBeGreaterThan(0)
    expect(screen.queryByRole("button", { name: "Select" })).toBeNull()
  })

  it("does not roll back an archived flag from a stale refresh but appends a new option it carries", async () => {
    const staleRefresh = createDeferred<{
      character: import("@/lib/api").CharacterDetail
    }>()
    setupMock({
      experienceJournal: { leveledUp: false, notes: [] },
      character: {
        ...character,
        skillOffers: [
          pendingOffer({
            options: [
              {
                definitionId: "skill-1",
                nameSnapshot: "Quick Shot",
                archived: true,
              },
            ],
          }),
        ],
      } as typeof character,
    })
    // The on-open refresh starts BEFORE the initial GET. It resolves LAST, so it
    // is now stale relative to the GET that already applied an archived:true
    // option. Because it is still the latest refresh request (no later refresh
    // has superseded it), it is applied append-only.
    skillRefreshDeferred = staleRefresh
    await renderDetail()

    // The stale refresh resolves last with the OLD archived flag for skill-1 plus
    // a NEW option. It must not un-archive skill-1, but must append the new
    // option.
    staleRefresh.resolve({
      character: {
        ...character,
        version: 3,
        skillOffers: [
          pendingOffer({
            options: [
              {
                definitionId: "skill-1",
                nameSnapshot: "Quick Shot",
                archived: false,
              },
              {
                definitionId: "skill-2",
                nameSnapshot: "Aim Shot",
                archived: false,
              },
            ],
          }),
        ],
      } as typeof character,
    })
    await flush()
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()

    expect(screen.getAllByText("Archived").length).toBeGreaterThan(0)
    expect(screen.getByRole("button", { name: "Choose skill" })).toBeTruthy()
    expect(screen.getByText("Aim Shot")).toBeTruthy()
  })

  it("does not revert the sheet to character A when a deferred refresh resolves after the route changes to B", async () => {
    const refreshDeferredA = createDeferred<{
      character: import("@/lib/api").CharacterDetail
    }>()
    setupMock({ character: { ...character } })
    characterB = {
      ...character,
      id: "chr-2",
      name: "Bee",
      version: 1,
    } as unknown as import("@/lib/api").CharacterDetail
    // Defer ONLY the refresh for chr-1; its GET resolves at once with A.
    skillRefreshDeferred = refreshDeferredA
    mockRouteId = "chr-1"

    const view = render(<CharacterDetail />)
    await flush()
    // The character name appears both as the top-level heading and the overview
    // profile heading, so match by role heading and assert none of the other id.
    expect(
      screen.getAllByRole("heading", { name: "Test" }).length
    ).toBeGreaterThan(0)

    // The route changes to B while A's refresh is still in flight. B's GET and
    // refresh resolve at once, so the sheet shows B.
    mockRouteId = "chr-2"
    view.rerender(<CharacterDetail />)
    await flush()
    expect(
      screen.getAllByRole("heading", { name: "Bee" }).length
    ).toBeGreaterThan(0)
    expect(screen.queryAllByRole("heading", { name: "Test" })).toHaveLength(0)
    expect(
      screen.queryByText("Skill options could not be refreshed.")
    ).toBeNull()

    // A's stale refresh resolves late; it must NOT revert the sheet to A nor
    // surface an old skill-refresh error from a previous route.
    refreshDeferredA.resolve({
      character: { ...character } as typeof character,
    })
    await flush()
    expect(
      screen.getAllByRole("heading", { name: "Bee" }).length
    ).toBeGreaterThan(0)
    expect(screen.queryAllByRole("heading", { name: "Test" })).toHaveLength(0)
    expect(
      screen.queryByText("Skill options could not be refreshed.")
    ).toBeNull()
  })

  it("does not apply a deferred character A GET to the sheet after the route changes to B", async () => {
    const getDeferredA = createDeferred<{
      character: import("@/lib/api").CharacterDetail
    }>()
    setupMock({ character: { ...character } })
    characterB = {
      ...character,
      id: "chr-2",
      name: "Bee",
      version: 1,
    } as unknown as import("@/lib/api").CharacterDetail
    // Defer ONLY the GET for chr-1; its refresh resolves at once with A.
    characterGetDeferred = getDeferredA
    mockRouteId = "chr-1"

    const view = render(<CharacterDetail />)
    await flush()
    // A's refresh resolved the sheet to A even though its GET is deferred.
    expect(
      screen.getAllByRole("heading", { name: "Test" }).length
    ).toBeGreaterThan(0)

    // The route changes to B while A's GET is still in flight. B's GET and
    // refresh resolve at once, so the sheet shows B.
    mockRouteId = "chr-2"
    view.rerender(<CharacterDetail />)
    await flush()
    expect(
      screen.getAllByRole("heading", { name: "Bee" }).length
    ).toBeGreaterThan(0)
    expect(screen.queryAllByRole("heading", { name: "Test" })).toHaveLength(0)

    // A's stale GET resolves late; it must NOT revert the sheet to A.
    getDeferredA.resolve({
      character: { ...character } as typeof character,
    })
    await flush()
    expect(
      screen.getAllByRole("heading", { name: "Bee" }).length
    ).toBeGreaterThan(0)
    expect(screen.queryAllByRole("heading", { name: "Test" })).toHaveLength(0)
  })
})

describe("skill offer details and acquisition history", () => {
  const offer = (
    options = [
      {
        definitionId: "skill-live",
        nameSnapshot: "Quick Shot",
        archived: false,
        description: "Current grade-specific prose",
        rarity: "Rare",
        skillType: "class" as const,
        classStableId: "archer-class",
        classPriority: true,
      },
    ]
  ) => ({
    id: "offer-live",
    track: "class",
    level: 25,
    choiceGroup: "milestone",
    canceledAt: null,
    selectedDefinitionId: null,
    options,
  })
  const event = (kind: string, payload: unknown, day: string) => ({
    kind,
    payload,
    createdAt: `2026-01-${day}T12:00:00.000Z`,
  })

  it("hides offers when none are pending while retaining acquired skills and history", async () => {
    setupMock({
      character: {
        ...character,
        skillOffers: [
          { ...offer(), selectedDefinitionId: "skill-live" },
          { ...offer(), id: "canceled", canceledAt: "2026-01-01T00:00:00Z" },
        ],
        associations: [
          association({
            id: "acquired",
            kind: "skill",
            definitionId: "skill-live",
            name: "Quick Shot",
          }),
        ],
      } as typeof character,
      events: [
        event(
          "skill_select",
          { definition: { name: "Quick Shot", stableId: "quick-shot" } },
          "02"
        ),
      ],
    })
    await renderDetail()
    expect(exportGetCount).toBe(0)
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()
    expect(exportGetCount).toBe(1)
    expect(screen.queryByText("Skill offers")).toBeNull()
    expect(screen.getByText("Quick Shot")).toBeTruthy()
    expect(screen.getByText("Skill selected: Quick Shot")).toBeTruthy()
  })

  it("shows pending offers with initially collapsed accessible live description and snapshot badges", async () => {
    setupMock({
      character: { ...character, skillOffers: [offer()] } as typeof character,
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    const summary = screen.getByText("Description for Quick Shot")
    const details = summary.closest("details")!
    const optionDetails = within(details.parentElement!)
    expect(details.open).toBe(false)
    expect(optionDetails.getByText("Rare")).toBeTruthy()
    expect(optionDetails.getByText("Class")).toBeTruthy()
    expect(optionDetails.getByText("Class tie: Archer Class")).toBeTruthy()
    const description = within(details).getByText(
      "Current grade-specific prose"
    )
    expect(details.contains(description)).toBe(true)
    fireEvent.click(summary)
    expect(details.open).toBe(true)
    expect(
      within(details).getByText("Current grade-specific prose")
    ).toBeTruthy()
    expect(optionDetails.getAllByText("Rare")).toHaveLength(1)
    expect(optionDetails.getAllByText("Class")).toHaveLength(1)
    expect(optionDetails.getAllByText("Class tie: Archer Class")).toHaveLength(
      1
    )
  })

  it("renders direct and wrapped skill event kinds newest-first and excludes noop outcomes", async () => {
    setupMock({
      events: [
        event(
          "skill_select",
          {
            definition: {
              id: "skill-sel",
              stableId: "sel-stable",
              name: "Selected",
              grade: "G",
            },
          },
          "01"
        ),
        event(
          "skill_grant",
          {
            definition: {
              id: "skill-man",
              stableId: "man-stable",
              name: "Manual",
              grade: "G",
            },
          },
          "02"
        ),
        event(
          "skill_upgrade",
          {
            from: {
              definitionId: "skill-old",
              stableId: "old-stable",
              name: "Old",
            },
            to: {
              definitionId: "skill-up",
              stableId: "up-stable",
              name: "Upgraded",
            },
          },
          "03"
        ),
        event(
          "create",
          {
            skillGrants: {
              granted: [
                { stableId: "created-stable", name: "Created", grade: "G" },
              ],
            },
          },
          "04"
        ),
        event(
          "evolve",
          {
            journal: {
              skillGrants: {
                upgraded: [
                  {
                    fromStableId: "evol-from",
                    fromName: "EvolFrom",
                    toStableId: "evol-to",
                    toName: "Evolved",
                    grade: "G",
                  },
                ],
              },
            },
          },
          "05"
        ),
        event(
          "profession_set",
          {
            skillGrants: {
              granted: [
                { stableId: "prof-stable", name: "Profession", grade: "G" },
              ],
            },
          },
          "06"
        ),
        event(
          "import_history",
          {
            sourceKind: "create",
            sourcePayload: {
              skillGrants: {
                granted: [
                  { stableId: "imported-stable", name: "Imported", grade: "G" },
                ],
              },
            },
          },
          "07"
        ),
        event(
          "import_history",
          {
            sourceKind: "skill_select",
            sourcePayload: {
              definition: { name: "Imported Sel", stableId: "imported-sel" },
            },
          },
          "08"
        ),
        event(
          "skill_grant",
          { definition: { name: "Noop" }, noop: true },
          "09"
        ),
        event(
          "skill_grant",
          { definition: { name: "Skipped" }, status: "skipped" },
          "10"
        ),
        event(
          "skill_upgrade",
          {
            from: { name: "Sup" },
            to: { name: "Serseded" },
            status: "superseded",
          },
          "11"
        ),
      ],
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()
    const section = screen.getByRole("region", { name: "Skill history" })
    const list = section.querySelector("ol")!
    const text = within(list)
      .getAllByRole("listitem")
      .map((item) => item.textContent)
    expect(text.slice(0, 8).map((item) => item?.split("2026")[0])).toEqual([
      "Skill selected: Imported Sel1/8/",
      "Skill granted: Imported1/7/",
      "Skill granted: Profession1/6/",
      "Skill upgraded: Evolved1/5/",
      "Skill granted: Created1/4/",
      "Skill upgraded: Old -> Upgraded1/3/",
      "Skill granted: Manual1/2/",
      "Skill selected: Selected1/1/",
    ])
    expect(within(list).queryByText(/Noop|Skipped|Superseded/)).toBeNull()
  })

  it("orders an imported select by its original sourceCreatedAt, not the wrapper's recorded time", async () => {
    setupMock({
      events: [
        event(
          "skill_select",
          { definition: { name: "Fresh Sel", stableId: "fresh-sel" } },
          "01"
        ),
        event(
          "import_history",
          {
            sourceKind: "skill_select",
            sourceCreatedAt: "2022-01-15T12:00:00.000Z",
            sourcePayload: {
              definition: { name: "Imported Sel", stableId: "imported-sel" },
            },
          },
          "02"
        ),
      ],
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()
    const section = screen.getByRole("region", { name: "Skill history" })
    const list = section.querySelector("ol")!
    const times = Array.from(list.querySelectorAll("time")).map((time) =>
      time.getAttribute("dateTime")
    )
    // The direct 2026 selection sorts first; the imported 2022 selection is
    // ordered by its original source time, not the wrapper's 2026 record time.
    expect(times).toEqual([
      "2026-01-01T12:00:00.000Z",
      "2022-01-15T12:00:00.000Z",
    ])
    const imported = within(list).getByText("Skill selected: Imported Sel")
    expect(
      imported.parentElement!.querySelector("time")!.getAttribute("dateTime")
    ).toBe("2022-01-15T12:00:00.000Z")
  })

  it("lets a nested import_history wrapper's own sourceCreatedAt supersede the outer one", async () => {
    setupMock({
      events: [
        event(
          "import_history",
          {
            sourceKind: "import_history",
            sourceCreatedAt: "2020-01-01T12:00:00.000Z",
            sourcePayload: {
              sourceKind: "skill_select",
              sourceCreatedAt: "2019-06-01T12:00:00.000Z",
              sourcePayload: {
                definition: {
                  name: "Nested Sel",
                  stableId: "nested-sel",
                },
              },
            },
          },
          "03"
        ),
        event(
          "skill_select",
          { definition: { name: "Fresh", stableId: "fresh" } },
          "01"
        ),
      ],
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()
    const section = screen.getByRole("region", { name: "Skill history" })
    const list = section.querySelector("ol")!
    const times = Array.from(list.querySelectorAll("time")).map((time) =>
      time.getAttribute("dateTime")
    )
    // The 2026 direct sorts first; the nested wrapper's own 2019 source time
    // supersedes the outer 2020 (which never surfaces as an entry on its own).
    expect(times).toEqual([
      "2026-01-01T12:00:00.000Z",
      "2019-06-01T12:00:00.000Z",
    ])
    expect(within(list).getByText("Skill selected: Nested Sel")).toBeTruthy()
  })

  it("uses sourceCreatedAt for an imported grade-grant event and falls back to the inherited date when missing or invalid", async () => {
    setupMock({
      events: [
        event(
          "import_history",
          {
            sourceKind: "create",
            sourceCreatedAt: "2021-03-10T12:00:00.000Z",
            sourcePayload: {
              skillGrants: {
                granted: [
                  {
                    stableId: "imported-grant",
                    name: "Imported Grant",
                    grade: "G",
                  },
                ],
              },
            },
          },
          "04"
        ),
        event(
          "import_history",
          {
            sourceKind: "create",
            sourceCreatedAt: "not-a-date",
            sourcePayload: {
              skillGrants: {
                granted: [
                  {
                    stableId: "invalid-grant",
                    name: "Invalid Grant",
                    grade: "G",
                  },
                ],
              },
            },
          },
          "05"
        ),
        event(
          "import_history",
          {
            sourceKind: "create",
            sourcePayload: {
              skillGrants: {
                granted: [
                  {
                    stableId: "missing-grant",
                    name: "Missing Grant",
                    grade: "G",
                  },
                ],
              },
            },
          },
          "06"
        ),
        event(
          "skill_select",
          { definition: { name: "Fresh", stableId: "fresh" } },
          "01"
        ),
      ],
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()
    const section = screen.getByRole("region", { name: "Skill history" })
    const list = section.querySelector("ol")!
    const times = Array.from(list.querySelectorAll("time")).map((time) =>
      time.getAttribute("dateTime")
    )
    // The valid imported grant keeps its original 2021 time; both the invalid
    // and the missing sourceCreatedAt fall back to the wrapper's own created time.
    expect(times).toEqual([
      "2026-01-06T12:00:00.000Z",
      "2026-01-05T12:00:00.000Z",
      "2026-01-01T12:00:00.000Z",
      "2021-03-10T12:00:00.000Z",
    ])
    expect(within(list).getByText("Skill granted: Imported Grant")).toBeTruthy()
    expect(within(list).getByText("Skill granted: Invalid Grant")).toBeTruthy()
    expect(within(list).getByText("Skill granted: Missing Grant")).toBeTruthy()
  })

  it("normalizes a numeric sourceCreatedAt (epoch ms) to UTC ISO for an imported skill_select", async () => {
    setupMock({
      events: [
        event(
          "import_history",
          {
            sourceKind: "skill_select",
            sourceCreatedAt: Date.UTC(2022, 0, 15, 12, 0, 0),
            sourcePayload: {
              definition: { name: "Numeric Sel", stableId: "numeric-sel" },
            },
          },
          "02"
        ),
        event(
          "skill_select",
          { definition: { name: "Fresh", stableId: "fresh" } },
          "01"
        ),
      ],
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()
    const section = screen.getByRole("region", { name: "Skill history" })
    const list = section.querySelector("ol")!
    const times = Array.from(list.querySelectorAll("time")).map((time) =>
      time.getAttribute("dateTime")
    )
    // The direct 2026 selection sorts first; the numeric 2022 epoch is converted
    // to UTC ISO for display/sort rather than falling back to the wrapper's 2026
    // record time.
    expect(times).toEqual([
      "2026-01-01T12:00:00.000Z",
      "2022-01-15T12:00:00.000Z",
    ])
    const imported = within(list).getByText("Skill selected: Numeric Sel")
    expect(
      imported.parentElement!.querySelector("time")!.getAttribute("dateTime")
    ).toBe("2022-01-15T12:00:00.000Z")
  })

  it("normalizes a numeric sourceCreatedAt for an imported grade-grant and treats epoch 0 as a valid date", async () => {
    setupMock({
      events: [
        event(
          "import_history",
          {
            sourceKind: "create",
            sourceCreatedAt: Date.UTC(2021, 2, 10, 12, 0, 0),
            sourcePayload: {
              skillGrants: {
                granted: [
                  {
                    stableId: "numeric-grant",
                    name: "Numeric Grant",
                    grade: "G",
                  },
                ],
              },
            },
          },
          "04"
        ),
        event(
          "import_history",
          {
            sourceKind: "create",
            sourceCreatedAt: 0,
            sourcePayload: {
              skillGrants: {
                granted: [
                  {
                    stableId: "epoch-grant",
                    name: "Epoch Grant",
                    grade: "G",
                  },
                ],
              },
            },
          },
          "05"
        ),
        event(
          "skill_select",
          { definition: { name: "Fresh", stableId: "fresh" } },
          "01"
        ),
      ],
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()
    const section = screen.getByRole("region", { name: "Skill history" })
    const list = section.querySelector("ol")!
    const times = Array.from(list.querySelectorAll("time")).map((time) =>
      time.getAttribute("dateTime")
    )
    expect(times).toEqual([
      "2026-01-01T12:00:00.000Z",
      "2021-03-10T12:00:00.000Z",
      "1970-01-01T00:00:00.000Z",
    ])
    expect(within(list).getByText("Skill granted: Numeric Grant")).toBeTruthy()
    expect(within(list).getByText("Skill granted: Epoch Grant")).toBeTruthy()
  })

  it("falls back to the inherited wrapper date for non-finite or out-of-range numeric sourceCreatedAt", async () => {
    setupMock({
      events: [
        event(
          "import_history",
          {
            sourceKind: "create",
            sourceCreatedAt: Infinity,
            sourcePayload: {
              skillGrants: {
                granted: [
                  {
                    stableId: "inf-grant",
                    name: "Infinity Grant",
                    grade: "G",
                  },
                ],
              },
            },
          },
          "06"
        ),
        event(
          "import_history",
          {
            sourceKind: "create",
            sourceCreatedAt: Number.NaN,
            sourcePayload: {
              skillGrants: {
                granted: [
                  {
                    stableId: "nan-grant",
                    name: "NaN Grant",
                    grade: "G",
                  },
                ],
              },
            },
          },
          "07"
        ),
        event(
          "import_history",
          {
            sourceKind: "create",
            sourceCreatedAt: 1e30,
            sourcePayload: {
              skillGrants: {
                granted: [
                  {
                    stableId: "big-grant",
                    name: "Big Grant",
                    grade: "G",
                  },
                ],
              },
            },
          },
          "08"
        ),
        event(
          "import_history",
          {
            sourceKind: "create",
            sourceCreatedAt: -1e30,
            sourcePayload: {
              skillGrants: {
                granted: [
                  {
                    stableId: "neg-grant",
                    name: "Negative Grant",
                    grade: "G",
                  },
                ],
              },
            },
          },
          "09"
        ),
        event(
          "skill_select",
          { definition: { name: "Fresh", stableId: "fresh" } },
          "01"
        ),
      ],
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()
    const section = screen.getByRole("region", { name: "Skill history" })
    const list = section.querySelector("ol")!
    const times = Array.from(list.querySelectorAll("time")).map((time) =>
      time.getAttribute("dateTime")
    )
    // None of these are usable dates, so each falls back to the wrapper's own
    // created time and is ordered newest-first by that wrapper date.
    expect(times).toEqual([
      "2026-01-09T12:00:00.000Z",
      "2026-01-08T12:00:00.000Z",
      "2026-01-07T12:00:00.000Z",
      "2026-01-06T12:00:00.000Z",
      "2026-01-01T12:00:00.000Z",
    ])
  })

  it("orders direct events, string-timestamped imports, and numeric-timestamped imports chronologically", async () => {
    setupMock({
      events: [
        event(
          "import_history",
          {
            sourceKind: "skill_select",
            sourceCreatedAt: "2023-05-05T08:30:00.000Z",
            sourcePayload: {
              definition: { name: "String Sel", stableId: "string-sel" },
            },
          },
          "03"
        ),
        event(
          "import_history",
          {
            sourceKind: "skill_select",
            sourceCreatedAt: Date.UTC(2021, 6, 4, 6, 0, 0),
            sourcePayload: {
              definition: { name: "Numeric Sel", stableId: "numeric-sel" },
            },
          },
          "04"
        ),
        event(
          "skill_select",
          { definition: { name: "Latest Fresh", stableId: "latest" } },
          "05"
        ),
      ],
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()
    const section = screen.getByRole("region", { name: "Skill history" })
    const list = section.querySelector("ol")!
    const times = Array.from(list.querySelectorAll("time")).map((time) =>
      time.getAttribute("dateTime")
    )
    expect(times).toEqual([
      "2026-01-05T12:00:00.000Z",
      "2023-05-05T08:30:00.000Z",
      "2021-07-04T06:00:00.000Z",
    ])
  })

  it("lets a nested import_history wrapper's numeric sourceCreatedAt supersede the outer one", async () => {
    setupMock({
      events: [
        event(
          "import_history",
          {
            sourceKind: "import_history",
            sourceCreatedAt: "2020-01-01T12:00:00.000Z",
            sourcePayload: {
              sourceKind: "skill_select",
              sourceCreatedAt: Date.UTC(2019, 5, 1, 12, 0, 0),
              sourcePayload: {
                definition: {
                  name: "Nested Sel",
                  stableId: "nested-sel",
                },
              },
            },
          },
          "03"
        ),
        event(
          "skill_select",
          { definition: { name: "Fresh", stableId: "fresh" } },
          "01"
        ),
      ],
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()
    const section = screen.getByRole("region", { name: "Skill history" })
    const list = section.querySelector("ol")!
    const times = Array.from(list.querySelectorAll("time")).map((time) =>
      time.getAttribute("dateTime")
    )
    // The nested wrapper's own numeric 2019 source time supersedes the outer
    // 2020 (which never surfaces as an entry on its own).
    expect(times).toEqual([
      "2026-01-01T12:00:00.000Z",
      "2019-06-01T12:00:00.000Z",
    ])
    expect(within(list).getByText("Skill selected: Nested Sel")).toBeTruthy()
  })

  it("excludes noop/skipped/superseded imported source events while preserving names", async () => {
    setupMock({
      events: [
        event(
          "import_history",
          {
            sourceKind: "skill_grant",
            sourceCreatedAt: "2023-01-01T12:00:00.000Z",
            sourcePayload: {
              definition: { name: "Noop Imported", stableId: "noop-imp" },
              noop: true,
            },
          },
          "07"
        ),
        event(
          "import_history",
          {
            sourceKind: "skill_grant",
            sourceCreatedAt: "2023-01-02T12:00:00.000Z",
            sourcePayload: {
              definition: { name: "Skipped Imported", stableId: "skip-imp" },
              status: "skipped",
            },
          },
          "08"
        ),
        event(
          "import_history",
          {
            sourceKind: "skill_select",
            sourceCreatedAt: "2023-01-03T12:00:00.000Z",
            sourcePayload: {
              definition: { name: "Kept Sel", stableId: "kept-sel" },
            },
          },
          "09"
        ),
      ],
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()
    const section = screen.getByRole("region", { name: "Skill history" })
    const list = section.querySelector("ol")!
    const text = within(list)
      .getAllByRole("listitem")
      .map((item) => item.textContent)
    expect(text.map((value) => value?.split("2023")[0])).toEqual([
      "Skill selected: Kept Sel1/3/",
    ])
    expect(
      within(list).queryByText(/Noop Imported|Skipped Imported/)
    ).toBeNull()
  })

  it("offers retry after lazy history loading fails and refreshes events after a skill selection", async () => {
    setupMock({
      exportError: new Error("History unavailable"),
      character: { ...character, skillOffers: [offer()] } as typeof character,
    })
    await renderDetail()
    expect(exportGetCount).toBe(0)
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()
    expect(exportGetCount).toBe(1)
    expect(screen.getByText("Could not load skill history.")).toBeTruthy()
    exportErrorForTest = null
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    await flush()
    expect(exportGetCount).toBe(2)
    expect(screen.getByText("No skill history yet.")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Manage skills" }))
    const sheet = associationSheetContent()
    fireEvent.click(within(sheet).getByRole("button", { name: "Select" }))
    fireEvent.click(screen.getAllByRole("button", { name: "Select" }).at(-1)!)
    await flush()
    expect(exportGetCount).toBeGreaterThanOrEqual(3)
  })
})

describe("CharacterDetail overview summary", () => {
  it("shows all nine server-calculated attributes and available track levels", async () => {
    setupMock({
      character: {
        ...character,
        nickname: "Longshot",
        status: {
          attributes: {
            strength: 11,
            agility: 22,
            endurance: 33,
            vitality: 44,
            toughness: 55,
            wisdom: 66,
            intelligence: 77,
            perception: 88,
            willpower: 99,
          },
          derivedStats: { hp: 101, mp: 202, sp: 303 },
          traces: [],
          availablePoints: 0,
          totalFreePoints: 0,
          allocatedPoints: 0,
          resources: [],
          equipment: {
            requested: {},
            applied: {},
            suppressed: {},
            items: [],
            capUsage: [],
          },
          consumables: {
            requested: {},
            applied: {},
            suppressed: {},
            capUsage: [],
          },
          capUsage: [],
        },
      } as unknown as import("@/lib/api").CharacterDetail,
    })
    await renderDetail()

    expect(screen.getByRole("heading", { name: "Longshot" })).toBeTruthy()
    expect(screen.getByRole("heading", { name: "Derived Stats" })).toBeTruthy()
    const overviewHeadings = screen
      .getAllByRole("heading")
      .map((heading) => heading.textContent)
    expect(overviewHeadings.indexOf("Progression")).toBeLessThan(
      overviewHeadings.indexOf("Derived Stats")
    )
    expect(overviewHeadings.indexOf("Derived Stats")).toBeLessThan(
      overviewHeadings.indexOf("Stats")
    )
    expect(screen.getByRole("heading", { name: "Stats" })).toBeTruthy()
    expect(screen.getByLabelText("Health (HP) 101")).toBeTruthy()
    expect(screen.getByLabelText("Mana (MP) 202")).toBeTruthy()
    expect(screen.getByLabelText("Stamina (SP) 303")).toBeTruthy()
    expect(screen.getByText("101")).toBeTruthy()
    expect(screen.getByText("202")).toBeTruthy()
    expect(screen.getByText("303")).toBeTruthy()
    expect(
      screen.queryByText("Calculated values from the character status.")
    ).toBeNull()
    for (const [label, value] of [
      ["Strength", "11"],
      ["Agility", "22"],
      ["Endurance", "33"],
      ["Vitality", "44"],
      ["Toughness", "55"],
      ["Wisdom", "66"],
      ["Intelligence", "77"],
      ["Perception", "88"],
      ["Willpower", "99"],
    ]) {
      expect(screen.getByLabelText(`${label} ${value}`)).toBeTruthy()
    }
    expect(screen.getByLabelText("Race level 25")).toBeTruthy()
    expect(screen.getByLabelText("Class level 20")).toBeTruthy()
    expect(screen.getByText("Grade G")).toBeTruthy()
  })

  it("keeps race progression for monsters and gives a meaningful unavailable-stats state", async () => {
    const monster = {
      ...character,
      nickname: "Mossback",
      classId: null,
      className: null,
      status: undefined,
      state: {
        ...character.state,
        tracks: { class: null, profession: null },
        race: { ...character.state.race, mode: "independent" },
      },
    } as unknown as import("@/lib/api").CharacterDetail
    setupMock({ character: monster })
    await renderDetail()

    expect(screen.getByRole("heading", { name: "Mossback" })).toBeTruthy()
    expect(
      screen.getByText(
        "Current calculated attributes are unavailable right now."
      )
    ).toBeTruthy()
    expect(
      screen.getByText("Derived stats are unavailable right now.")
    ).toBeTruthy()
    expect(screen.getByLabelText("Race level 25")).toBeTruthy()
    expect(screen.queryByLabelText(/Class level/)).toBeNull()
    expect(screen.queryByLabelText(/Profession level/)).toBeNull()
  })
})

describe("grade ceiling and historical stat provenance", () => {
  it("disables only the monster race + Level when the server blocks it", async () => {
    const monster = {
      ...character,
      classId: null,
      className: null,
      state: {
        ...character.state,
        race: { ...character.state.race, mode: "independent" },
      },
      levelUpBlocked: { race: "Race grade ceiling reached." },
    } as unknown as import("@/lib/api").CharacterDetail
    setupMock({ character: monster })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Race" }))
    expect(
      screen
        .getByRole("button", { name: "Increase race level" })
        .hasAttribute("disabled")
    ).toBe(true)
    expect(screen.getByText("Race grade ceiling reached.")).toBeTruthy()
    expect(screen.getByRole("slider").hasAttribute("disabled")).toBe(false)
  })

  it("blocks class + Level from server reason and leaves it enabled when unblocked", async () => {
    setupMock({
      character: {
        ...character,
        levelUpBlocked: { class: "Class grade ceiling reached." },
      },
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Class" }))
    expect(
      screen
        .getByRole("button", { name: "Increase class level" })
        .hasAttribute("disabled")
    ).toBe(true)
    expect(screen.getByText("Class grade ceiling reached.")).toBeTruthy()
    cleanup()
    setupMock({ character })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Class" }))
    expect(
      screen
        .getByRole("button", { name: "Increase class level" })
        .hasAttribute("disabled")
    ).toBe(false)
  })

  it("shows server-supplied fixed points by track without changing historical total", async () => {
    const status = {
      attributes: { strength: 8 },
      derivedStats: { hp: 1, mp: 2, sp: 3 },
      traces: [
        {
          attribute: "strength",
          final: 8,
          phases: [{ phase: "historical-fixed", value: 6, delta: 6 }],
        },
      ],
      historicalFixedByTrack: {
        race: { strength: 1 },
        class: { strength: 2 },
        profession: { strength: 3 },
      },
      availablePoints: 0,
      totalFreePoints: 0,
      allocatedPoints: 0,
      resources: [],
      equipment: {
        requested: {},
        applied: {},
        suppressed: {},
        items: [],
        capUsage: [],
      },
      consumables: { requested: {}, applied: {}, suppressed: {}, capUsage: [] },
      capUsage: [],
    }
    setupMock({
      character: {
        ...character,
        status,
      } as unknown as import("@/lib/api").CharacterDetail,
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Stats" }))
    expect(screen.getByRole("tab", { name: "Stats" })).toBeTruthy()
    expect(screen.getByText("Race fixed")).toBeTruthy()
    expect(screen.getByText("Class fixed")).toBeTruthy()
    expect(screen.getByText("Profession fixed")).toBeTruthy()
    expect(screen.getByText("1 (+1)")).toBeTruthy()
    expect(screen.getByText("3 (+2)")).toBeTruthy()
    expect(screen.getByText("6 (+3)")).toBeTruthy()
    expect(screen.getAllByText("8").length).toBeGreaterThan(0)
    expect(screen.queryByText(/historical-fixed/)).toBeNull()
    expect(document.body.textContent).not.toContain("historical-fixed")
    expect(screen.getByRole("heading", { name: "Derived Stats" })).toBeTruthy()
  })

  it("splits legacy combined fixed totals using backend source vectors", async () => {
    const legacyStatus = {
      attributes: { strength: 12 },
      derivedStats: { hp: 1, mp: 2, sp: 3 },
      traces: [
        {
          attribute: "strength",
          final: 12,
          phases: [{ phase: "historical-fixed", value: 9, delta: 9 }],
        },
      ],
      historicalFixedByTrack: {
        race: { strength: 2 },
        class: { strength: 3 },
        profession: { strength: 4 },
      },
      availablePoints: 0,
      totalFreePoints: 0,
      allocatedPoints: 0,
      resources: [],
      equipment: {
        requested: {},
        applied: {},
        suppressed: {},
        items: [],
        capUsage: [],
      },
      consumables: { requested: {}, applied: {}, suppressed: {}, capUsage: [] },
      capUsage: [],
    }
    setupMock({
      character: {
        ...character,
        status: legacyStatus,
      } as unknown as import("@/lib/api").CharacterDetail,
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Stats" }))

    expect(screen.getByText("2 (+2)")).toBeTruthy()
    expect(screen.getByText("5 (+3)")).toBeTruthy()
    expect(screen.getByText("9 (+4)")).toBeTruthy()
    expect(screen.getAllByText("12").length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toContain("historical-fixed")
  })
})

describe("CharacterDetail ranked title claims", () => {
  const rankedTitle = (
    id: string,
    name: string,
    rank: number,
    minRaceGrade: string = "G",
    seriesId: string = "dungeon-pioneer"
  ) =>
    catalogItem({
      id,
      name,
      kind: "titles",
      config: {
        improvement: { seriesId, rank, minRaceGrade },
        upgradeGroup: seriesId,
        flat: { strength: rank },
      },
    })

  it("keeps a ranked series collapsed, exposes its next claim, and expands child ranks", async () => {
    setupMock({
      titles: [
        rankedTitle("pioneer-1", "Dungeon Pioneer I", 1),
        rankedTitle("pioneer-2", "Dungeon Pioneer II", 2),
        rankedTitle("pioneer-3", "Dungeon Pioneer III", 3),
      ],
    })
    await renderDetail()
    fireEvent.click(screen.getAllByRole("button", { name: "Manage titles" })[0])
    await flush()
    expect(screen.getByText("Dungeon Pioneer")).toBeTruthy()
    expect(screen.queryByText("Dungeon Pioneer I")).toBeNull()
    expect(screen.getByRole("button", { name: "Claim next rank" })).toBeTruthy()
    const toggle = screen.getByRole("button", { name: /Dungeon Pioneer/ })
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByText("Dungeon Pioneer I")).toBeTruthy()
    expect(screen.getByText("Dungeon Pioneer II")).toBeTruthy()
    expect(screen.getByText("Dungeon Pioneer III")).toBeTruthy()
  })

  it("labels an unrelated ranked series from its own entries, not a hardcoded id", async () => {
    setupMock({
      titles: [
        rankedTitle("warden-1", "Warden I", 1, "G", "warden"),
        rankedTitle("warden-2", "Warden II", 2, "G", "warden"),
      ],
    })
    await renderDetail()
    fireEvent.click(screen.getAllByRole("button", { name: "Manage titles" })[0])
    await flush()
    expect(screen.getByText("Warden")).toBeTruthy()
  })

  it("falls back to a humanized series id when the lowest rank name has no recognizable suffix", async () => {
    setupMock({
      titles: [rankedTitle("keeper", "Keeper of the Gate", 1, "G", "keeper")],
    })
    await renderDetail()
    fireEvent.click(screen.getAllByRole("button", { name: "Manage titles" })[0])
    await flush()
    expect(screen.getByText("Keeper")).toBeTruthy()
  })

  it("searches by child title, auto-expands matching series, and reports no matches", async () => {
    setupMock({
      titles: [
        rankedTitle("pioneer-1", "Dungeon Pioneer I", 1),
        rankedTitle("pioneer-2", "Dungeon Pioneer II", 2),
      ],
    })
    await renderDetail()
    fireEvent.click(screen.getAllByRole("button", { name: "Manage titles" })[0])
    await flush()
    const search = screen.getByRole("textbox", {
      name: "Search titles by series or name",
    })
    fireEvent.change(search, { target: { value: "Dungeon Pioneer II" } })
    expect(
      screen
        .getByRole("button", { name: /Dungeon Pioneer/ })
        .getAttribute("aria-expanded")
    ).toBe("true")
    expect(screen.getByText("Dungeon Pioneer II")).toBeTruthy()
    expect(screen.queryByText("Dungeon Pioneer I")).toBeNull()
    fireEvent.change(search, { target: { value: "no such title" } })
    expect(
      screen
        .getAllByRole("status")
        .some((status) => status.textContent?.includes("No titles match"))
    ).toBe(true)
  })

  it("requires choosing between multiple authored entries at the next rank", async () => {
    setupMock({
      character: {
        ...character,
        associations: [
          association({
            id: "linked-one",
            kind: "title",
            definitionId: "pioneer-1",
            name: "Dungeon Pioneer I",
            improvement: {
              seriesId: "dungeon-pioneer",
              rank: 1,
              minRaceGrade: "G",
            },
            upgradeGroup: "dungeon-pioneer",
          }),
        ],
      },
      titles: [
        rankedTitle("pioneer-1", "Dungeon Pioneer I", 1),
        rankedTitle("pioneer-2a", "Dungeon Pioneer II A", 2),
        rankedTitle("pioneer-2b", "Dungeon Pioneer II B", 2),
      ],
    })
    await renderDetail()
    fireEvent.click(screen.getAllByRole("button", { name: "Manage titles" })[0])
    await flush()
    expect(screen.getByText("Expand and choose")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Claim next rank" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /Dungeon Pioneer/ }))
    expect(screen.getByText("Dungeon Pioneer II A")).toBeTruthy()
    expect(screen.getByText("Dungeon Pioneer II B")).toBeTruthy()
  })

  it("advances the compact action to rank 2 after a successful rank 1 claim", async () => {
    setupMock({
      titles: [
        rankedTitle("pioneer-1", "Dungeon Pioneer I", 1),
        rankedTitle("pioneer-2", "Dungeon Pioneer II", 2),
      ],
    })
    await renderDetail()
    fireEvent.click(screen.getAllByRole("button", { name: "Manage titles" })[0])
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Claim next rank" }))
    fireEvent.change(screen.getByLabelText("Qualifying first-clear details"), {
      target: { value: "Cleared rank one." },
    })
    fireEvent.click(screen.getByRole("button", { name: "Confirm claim" }))
    await flush()
    expect(screen.getByText("Rank 2 / minimum race grade G")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Claim next rank" })).toBeTruthy()
  })

  it("requires a self-reported first-clear detail and sends it with version", async () => {
    setupMock({
      titles: [rankedTitle("pioneer-1", "Dungeon Pioneer I", 1)],
    })
    await renderDetail()
    fireEvent.click(screen.getAllByRole("button", { name: "Manage titles" })[0])
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Claim next rank" }))
    expect(
      screen.getByText(/self-reported qualifying first-clear claim/)
    ).toBeTruthy()
    expect(
      screen.getByText(/Rank 1; configured bonus: Flat strength:1/)
    ).toBeTruthy()
    const submit = screen.getByRole("button", {
      name: "Confirm claim",
    }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText("Qualifying first-clear details"), {
      target: { value: "Cleared the qualifying dungeon." },
    })
    fireEvent.click(submit)
    await flush()
    const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
    const post = mock.mock.calls.find(
      ([url, init]) =>
        url === "/api/characters/chr-1/associations" &&
        (init as RequestInit | undefined)?.method === "POST"
    )
    expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({
      kind: "title",
      definitionId: "pioneer-1",
      operation: "add",
      version: 3,
      reason: "Cleared the qualifying dungeon.",
    })
  })

  it("blocks below-grade claims and skipped ranks", async () => {
    setupMock({
      titles: [rankedTitle("pioneer-2", "Dungeon Pioneer II", 2, "C")],
    })
    await renderDetail()
    fireEvent.click(screen.getAllByRole("button", { name: "Manage titles" })[0])
    await flush()
    expect(screen.getByText(/Locked: race grade G is below C/)).toBeTruthy()
    expect(
      (
        screen.getByRole("button", {
          name: "Claim next rank",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
  })

  it("does not offer rank 2 when no rank 1 is linked", async () => {
    setupMock({
      titles: [rankedTitle("pioneer-2", "Dungeon Pioneer II", 2)],
    })
    await renderDetail()
    fireEvent.click(screen.getAllByRole("button", { name: "Manage titles" })[0])
    await flush()
    expect(screen.getByText(/Locked: only rank 1 is next/)).toBeTruthy()
    expect(
      (
        screen.getByRole("button", {
          name: "Claim next rank",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
  })

  it("uses archived association rank metadata to unlock the next rank without loading archived catalog entries", async () => {
    setupMock({
      character: {
        ...character,
        state: {
          ...character.state,
          race: { ...character.state.race, grade: "E" },
        },
        associations: [
          association({
            id: "archived-prior",
            kind: "title",
            definitionId: "old",
            name: "Old Pioneer",
            definitionArchived: true,
            upgradeGroup: "dungeon-pioneer",
            improvement: {
              seriesId: "dungeon-pioneer",
              rank: 3,
              minRaceGrade: "G",
            },
          }),
        ],
      },
      titles: [rankedTitle("pioneer-4", "Dungeon Pioneer IV", 4, "E")],
    })
    await renderDetail()
    fireEvent.click(screen.getAllByRole("button", { name: "Manage titles" })[0])
    await flush()
    expect(screen.getAllByText("Old Pioneer").length).toBeGreaterThan(0)
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy()
    expect(screen.getByText("Rank 4 / minimum race grade E")).toBeTruthy()
    expect(
      screen.queryByText(/linked prior rank details unavailable/)
    ).toBeNull()
    expect(
      (
        screen.getByRole("button", {
          name: "Claim next rank",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false)
  })

  it("fails closed when an archived same-series link has no improvement metadata", async () => {
    setupMock({
      character: {
        ...character,
        associations: [
          association({
            id: "archived-prior",
            kind: "title",
            definitionId: "old",
            name: "Old Pioneer",
            definitionArchived: true,
            upgradeGroup: "dungeon-pioneer",
          }),
        ],
      },
      titles: [rankedTitle("pioneer-2", "Dungeon Pioneer II", 2)],
    })
    await renderDetail()
    fireEvent.click(screen.getAllByRole("button", { name: "Manage titles" })[0])
    await flush()
    expect(
      screen.getByText(
        /linked prior rank details unavailable; retry catalog before claiming/
      )
    ).toBeTruthy()
    expect(
      (
        screen.getByRole("button", {
          name: "Claim next rank",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
  })

  it("keeps ordinary title add payload unchanged and does not fake success on server rejection", async () => {
    setupMock({
      titles: [
        catalogItem({ id: "ordinary", name: "Ordinary title", kind: "titles" }),
      ],
    })
    await renderDetail()
    fireEvent.click(screen.getAllByRole("button", { name: "Manage titles" })[0])
    await flush()
    const titleRow =
      screen.getByText("Ordinary title").parentElement?.parentElement
    fireEvent.click(within(titleRow!).getByRole("button", { name: "Add" }))
    await flush()
    const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
    const post = mock.mock.calls.find(
      ([url, init]) =>
        url === "/api/characters/chr-1/associations" &&
        (init as RequestInit | undefined)?.method === "POST"
    )
    expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({
      kind: "title",
      definitionId: "ordinary",
      operation: "add",
      version: 3,
    })

    cleanup()
    setupMock({
      associationsError: new Error("title_rank_conflict"),
      titles: [rankedTitle("pioneer-1", "Dungeon Pioneer I", 1)],
    })
    await renderDetail()
    fireEvent.click(screen.getAllByRole("button", { name: "Manage titles" })[0])
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Claim next rank" }))
    fireEvent.change(screen.getByLabelText("Qualifying first-clear details"), {
      target: { value: "I cleared it." },
    })
    fireEvent.click(screen.getByRole("button", { name: "Confirm claim" }))
    await flush()
    expect(toast.error).toHaveBeenCalledWith("title_rank_conflict")
    expect(screen.getByRole("button", { name: "Claim next rank" })).toBeTruthy()
  })

  it("disables the next-rank claim while multiple titles are linked in the same ranked series", async () => {
    setupMock({
      character: {
        ...character,
        associations: [
          association({
            id: "archived-prior",
            kind: "title",
            definitionId: "pioneer-1",
            name: "Dungeon Pioneer I",
            definitionArchived: true,
            upgradeGroup: "dungeon-pioneer",
            improvement: {
              seriesId: "dungeon-pioneer",
              rank: 1,
              minRaceGrade: "G",
            },
          }),
          association({
            id: "linked-two",
            kind: "title",
            definitionId: "pioneer-2",
            name: "Dungeon Pioneer II",
            upgradeGroup: "dungeon-pioneer",
            improvement: {
              seriesId: "dungeon-pioneer",
              rank: 2,
              minRaceGrade: "G",
            },
          }),
        ],
      },
      titles: [
        rankedTitle("pioneer-1", "Dungeon Pioneer I", 1),
        rankedTitle("pioneer-2", "Dungeon Pioneer II", 2),
        rankedTitle("pioneer-3", "Dungeon Pioneer III", 3),
      ],
    })
    await renderDetail()
    fireEvent.click(screen.getAllByRole("button", { name: "Manage titles" })[0])
    await flush()

    // Even though the highest linked rank is known, more than one linked rank
    // makes the exactly-one-prior claim ambiguous: the summary CTA is inert and
    // points the user at the conflict instead.
    expect(
      screen.getByText(
        /Multiple linked ranks; resolve conflicting titles first/
      )
    ).toBeTruthy()
    const summaryClaim = screen.getByRole("button", {
      name: "Claim next rank",
    }) as HTMLButtonElement
    expect(summaryClaim.disabled).toBe(true)

    // The expanded per-rank child claim for the next rank is inert too, so it
    // never presents an active-but-doomed CTA.
    fireEvent.click(screen.getByRole("button", { name: /Dungeon Pioneer/ }))
    expect(screen.getByText("Dungeon Pioneer III")).toBeTruthy()
    const claimButtons = screen.getAllByRole("button", {
      name: "Claim next rank",
    }) as HTMLButtonElement[]
    expect(claimButtons.length).toBe(2)
    expect(claimButtons.every((button) => button.disabled)).toBe(true)

    // Clicking the inert summary CTA must not fire a doomed association POST.
    const postsBefore = (
      apiFetch as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.filter(
      ([url, init]) =>
        url === "/api/characters/chr-1/associations" &&
        (init as RequestInit | undefined)?.method === "POST"
    ).length
    fireEvent.click(summaryClaim)
    await flush()
    const postsAfter = (
      apiFetch as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.filter(
      ([url, init]) =>
        url === "/api/characters/chr-1/associations" &&
        (init as RequestInit | undefined)?.method === "POST"
    ).length
    expect(postsAfter).toBe(postsBefore)
    expect(postsAfter).toBe(0)
  })

  it("restores the next-rank claim after one of the conflicting linked titles is removed", async () => {
    setupMock({
      character: {
        ...character,
        associations: [
          association({
            id: "archived-prior",
            kind: "title",
            definitionId: "pioneer-1",
            name: "Dungeon Pioneer I",
            definitionArchived: true,
            upgradeGroup: "dungeon-pioneer",
            improvement: {
              seriesId: "dungeon-pioneer",
              rank: 1,
              minRaceGrade: "G",
            },
          }),
          association({
            id: "linked-two",
            kind: "title",
            definitionId: "pioneer-2",
            name: "Dungeon Pioneer II",
            upgradeGroup: "dungeon-pioneer",
            improvement: {
              seriesId: "dungeon-pioneer",
              rank: 2,
              minRaceGrade: "G",
            },
          }),
        ],
      },
      titles: [
        rankedTitle("pioneer-1", "Dungeon Pioneer I", 1),
        rankedTitle("pioneer-2", "Dungeon Pioneer II", 2),
        rankedTitle("pioneer-3", "Dungeon Pioneer III", 3),
      ],
    })
    await renderDetail()
    fireEvent.click(screen.getAllByRole("button", { name: "Manage titles" })[0])
    await flush()

    expect(
      screen.getByText(
        /Multiple linked ranks; resolve conflicting titles first/
      )
    ).toBeTruthy()

    // Expand and remove the active rank-2 link, leaving only the archived prior
    // rank (still a single prior, so a next-rank claim is valid again).
    fireEvent.click(screen.getByRole("button", { name: /Dungeon Pioneer/ }))
    const sheetContent = associationSheetContent()
    const pioneerTwoRow =
      within(sheetContent).getByText("Dungeon Pioneer II").parentElement!
        .parentElement!
    fireEvent.click(
      within(pioneerTwoRow).getByRole("button", { name: "Remove" })
    )
    await flush()

    expect(
      screen.queryByText(
        /Multiple linked ranks; resolve conflicting titles first/
      )
    ).toBeNull()
    // After removing one conflicting link the exactly-one-prior constraint is
    // satisfied again, so the next-rank claim is restored: at least one CTA is
    // active (the summary or the current next-rank child). The remaining rank-3
    // child stays disabled because it is no longer the next rank.
    const claimButtons = screen.getAllByRole("button", {
      name: "Claim next rank",
    }) as HTMLButtonElement[]
    expect(claimButtons.some((button) => !button.disabled)).toBe(true)
  })
})

describe("CharacterDetail archived linked title search", () => {
  const rankedTitle = (
    id: string,
    name: string,
    rank: number,
    seriesId: string = "dungeon-pioneer"
  ) =>
    catalogItem({
      id,
      name,
      kind: "titles",
      config: {
        improvement: { seriesId, rank, minRaceGrade: "G" },
        upgradeGroup: seriesId,
        flat: { strength: rank },
      },
    })

  const archivedLinkedTitle = association({
    id: "archived-warden",
    kind: "title",
    definitionId: "archived-warden-def",
    name: "Ancient Warden",
    definitionArchived: true,
    upgradeGroup: "ancient-warden",
    improvement: {
      seriesId: "ancient-warden",
      rank: 1,
      minRaceGrade: "G",
    },
  })

  function openTitlesTab() {
    fireEvent.click(screen.getAllByRole("button", { name: "Manage titles" })[0])
  }

  it("hides archived linked titles and reports no matches when the search matches nothing", async () => {
    setupMock({
      character: {
        ...character,
        associations: [archivedLinkedTitle],
      },
      titles: [
        rankedTitle("pioneer-1", "Dungeon Pioneer I", 1),
        rankedTitle("pioneer-2", "Dungeon Pioneer II", 2),
      ],
    })
    await renderDetail()
    openTitlesTab()
    await flush()
    const sheet = associationSheetContent("titlesSkills")
    const search = within(sheet).getByRole("textbox", {
      name: "Search titles by series or name",
    })
    fireEvent.change(search, { target: { value: "unrelated term" } })
    expect(within(sheet).queryByText("Ancient Warden")).toBeNull()
    expect(
      within(sheet)
        .getAllByRole("status")
        .some((status) => status.textContent?.includes("No titles match"))
    ).toBe(true)
  })

  it("shows an archived linked title by name with its Remove action, restores it on clear, and leaves ranked search unchanged", async () => {
    setupMock({
      character: {
        ...character,
        associations: [archivedLinkedTitle],
      },
      titles: [
        rankedTitle("pioneer-1", "Dungeon Pioneer I", 1),
        rankedTitle("pioneer-2", "Dungeon Pioneer II", 2),
      ],
    })
    await renderDetail()
    openTitlesTab()
    await flush()
    const sheet = associationSheetContent("titlesSkills")
    const search = within(sheet).getByRole("textbox", {
      name: "Search titles by series or name",
    })

    // Searching the archived linked title name reveals it with a Remove action.
    fireEvent.change(search, { target: { value: "Ancient Warden" } })
    expect(within(sheet).getByText("Ancient Warden")).toBeTruthy()
    expect(within(sheet).getByRole("button", { name: "Remove" })).toBeTruthy()

    // Ranked series search is unaffected by the archived-linked filter.
    fireEvent.change(search, { target: { value: "Dungeon Pioneer II" } })
    expect(within(sheet).queryByText("Ancient Warden")).toBeNull()
    expect(within(sheet).getByText("Dungeon Pioneer II")).toBeTruthy()

    // Clearing the search restores every archived linked title.
    fireEvent.change(search, { target: { value: "" } })
    expect(within(sheet).getByText("Ancient Warden")).toBeTruthy()
    expect(within(sheet).queryByText("No titles match your search")).toBeNull()
  })

  it("matches archived linked titles by upgrade group and series id as well as name", async () => {
    setupMock({
      character: {
        ...character,
        associations: [archivedLinkedTitle],
      },
      titles: [rankedTitle("pioneer-1", "Dungeon Pioneer I", 1)],
    })
    await renderDetail()
    openTitlesTab()
    await flush()
    const sheet = associationSheetContent("titlesSkills")
    const search = within(sheet).getByRole("textbox", {
      name: "Search titles by series or name",
    })
    fireEvent.change(search, { target: { value: "ancient-warden" } })
    expect(within(sheet).getByText("Ancient Warden")).toBeTruthy()
  })
})

describe("equipment eligibility and skill upgrades", () => {
  const skill = (id: string, name: string, rarity: string, archived = false) =>
    catalogItem({
      id,
      name,
      kind: "skills",
      archived,
      config: { rarity, upgradeGroup: "ember" },
      description: `${name} description`,
    })
  const sourceCharacter = (rarity?: string, archived = false) =>
    ({
      ...character,
      associations: [
        association({
          id: "skill-link",
          kind: "skill",
          definitionId: "old-skill",
          name: "Ember",
          rarity,
          upgradeGroup: rarity ? "ember" : undefined,
          definitionArchived: archived,
        }),
      ],
    }) as unknown as import("@/lib/api").CharacterDetail

  it("loads skill catalog for owners, submits explicit higher-tier upgrade reason/version, and reloads", async () => {
    setupMock({
      character: sourceCharacter("Common"),
      skills: [skill("target", "Ember II", "Rare")],
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()
    expect(
      (apiFetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(
        ([url]) => url === "/api/catalog/skills"
      )
    ).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Upgrade skill" }))
    fireEvent.click(screen.getByRole("button", { name: "Upgrade target" }))
    fireEvent.click(screen.getByText(/Ember II - Rare/))
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Training" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Confirm upgrade" }))
    await flush()
    expect(upgradePostsForTest).toEqual([
      { definitionId: "target", version: 3, reason: "Training" },
    ])
    expect(activeCharacter.associations[0]?.definitionId).toBe("target")
    expect(
      (apiFetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([url]) => url === "/api/characters/chr-1"
      ).length
    ).toBeGreaterThan(1)
  })

  it("searches eligible upgrade targets without widening rarity or archived guards", async () => {
    setupMock({
      character: sourceCharacter("Common"),
      skills: [
        skill("eligible", "Ember Adept", "Rare"),
        skill("archived", "Archived Ember", "Mythical", true),
        skill("lower", "Lower Ember", "Common"),
        ...Array.from({ length: 15 }, (_, index) =>
          skill(`extra-${index}`, `Ember Variant ${index}`, "Rare")
        ),
      ],
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Upgrade skill" }))
    const search = screen.getByRole("searchbox", {
      name: "Search upgrade skills",
    })
    fireEvent.change(search, { target: { value: "ADEPT" } })
    fireEvent.click(screen.getByRole("button", { name: "Upgrade target" }))
    expect(screen.getByText(/Ember Adept - Rare/)).toBeTruthy()
    expect(screen.queryByText(/Archived Ember/)).toBeNull()
    expect(screen.queryByText(/Lower Ember/)).toBeNull()
    expect(
      screen.queryByText("No upgrade skills match your search.")
    ).toBeNull()
    fireEvent.change(search, { target: { value: "no result" } })
    expect(
      screen.getByText("No upgrade skills match your search.")
    ).toBeTruthy()
    fireEvent.change(search, { target: { value: "ADEPT" } })
    fireEvent.click(screen.getByText(/Ember Adept - Rare/))
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Training" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Confirm upgrade" }))
    await flush()
    expect(upgradePostsForTest).toEqual([
      { definitionId: "eligible", version: 3, reason: "Training" },
    ])
  })

  it("blocks Unique, lower/equal, and missing source rarity; archived source metadata remains upgradeable", async () => {
    setupMock({
      character: sourceCharacter("Unique", true),
      skills: [skill("target", "Higher", "Divine")],
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()
    expect(screen.getByText(/Unique rarity is incomparable/)).toBeTruthy()
    cleanup()
    setupMock({
      character: sourceCharacter("Rare"),
      skills: [
        skill("lower", "Lower", "Common"),
        skill("equal", "Same", "Rare"),
      ],
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()
    expect(screen.getByText(/No active higher-rarity variant/)).toBeTruthy()
    cleanup()
    setupMock({
      character: sourceCharacter(undefined),
      skills: [skill("target", "Higher", "Divine")],
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()
    expect(screen.getByText(/Source rarity metadata unavailable/)).toBeTruthy()
    cleanup()
    setupMock({
      character: sourceCharacter("Common", true),
      skills: [skill("target", "Higher", "Rare")],
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()
    expect(screen.getByRole("button", { name: "Upgrade skill" })).toBeTruthy()
  })

  it("surfaces rejected upgrade without claiming success and reloads latest character", async () => {
    setupMock({
      character: sourceCharacter("Common"),
      skills: [skill("target", "Higher", "Rare")],
      upgradeError: new Error("Version conflict"),
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Upgrade skill" }))
    fireEvent.click(screen.getByRole("button", { name: "Upgrade target" }))
    fireEvent.click(screen.getByText(/Higher - Rare/))
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Practice" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Confirm upgrade" }))
    await flush()
    expect(toast.error).toHaveBeenCalledWith("Version conflict")
    expect(activeCharacter.associations[0]?.definitionId).toBe("old-skill")
  })

  it("shows inventory and linked equipment requirement badges and blocks equip but allows stock and unequip", async () => {
    const inv = inventoryItem({
      id: "inv",
      definitionId: "blade",
      name: "Blade",
      kind: "equipment",
      quantity: 1,
      rarity: "Rare",
      soulbound: true,
      slot: "hand",
      requirements: { minRaceLevel: 30, requiredRaceType: "monster" },
      equipmentEligibility: { eligible: false, reason: "Requires level 30" },
    })
    const equipped = association({
      id: "blade-link",
      kind: "equipment",
      definitionId: "blade",
      name: "Blade",
      rarity: "Rare",
      soulbound: true,
      slot: "hand",
      requirements: { minRaceLevel: 30, requiredRaceType: "monster" },
      equipmentEligibility: { eligible: false, reason: "Requires level 30" },
    })
    const stockOnly = inventoryItem({
      id: "inv-helm",
      definitionId: "helm",
      name: "Helm",
      kind: "equipment",
      quantity: 1,
      rarity: "Common",
      requirements: { minRaceLevel: 40, requiredRaceType: "monster" },
      equipmentEligibility: { eligible: false, reason: "Requires level 40" },
    })
    setupMock({
      character: {
        ...character,
        inventory: [inv, stockOnly],
        associations: [equipped],
      },
      equipmentCatalog: [
        catalogItem({
          id: "blade",
          name: "Blade",
          kind: "equipment",
          config: { slot: "hand" },
        }),
        catalogItem({
          id: "helm",
          name: "Helm",
          kind: "equipment",
          config: { slot: "head" },
        }),
      ],
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Inventory" }))
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Manage inventory" }))
    await flush()
    const sheet = associationSheetContent("inventoryEquipment")
    expect(within(sheet).getAllByText("Soulbound").length).toBeGreaterThan(0)
    expect(
      within(sheet).getAllByText("Requires level 30").length
    ).toBeGreaterThan(0)
    expect(
      within(sheet).getAllByText("Monstrous (monster)").length
    ).toBeGreaterThan(0)
    expect(
      within(sheet)
        .getAllByRole("button", { name: "Equip" })
        .some((button) => (button as HTMLButtonElement).disabled)
    ).toBe(true)
    expect(
      within(sheet).getByRole("button", { name: "Add stock" })
    ).toBeTruthy()
    fireEvent.click(within(sheet).getByRole("button", { name: "Unequip" }))
    await flush()
    expect(
      activeCharacter.associations.some((row) => row.kind === "equipment")
    ).toBe(false)
  })
})

describe("CharacterDetail race-only progression", () => {
  it("commits percentage experience without a journal popup and reports API failures", async () => {
    const monster = {
      ...character,
      classId: null,
      className: null,
      state: {
        ...character.state,
        race: { ...character.state.race, mode: "independent", quarter: 2 },
      },
    } as unknown as import("@/lib/api").CharacterDetail
    setupMock({
      character: monster,
    })
    await renderDetail()
    expect(
      screen
        .getByRole("progressbar", { name: /Race experience/ })
        .getAttribute("aria-valuenow")
    ).toBe("50")
    const slider = screen.getByLabelText("Experience slider")
    fireEvent.change(slider, { target: { value: "35" } })
    expect(experiencePosts).toHaveLength(0)
    fireEvent.mouseUp(slider, { target: { value: "35" } })
    await flush()
    expect(experiencePosts).toEqual([
      { operation: "set", track: "race", percent: 35, version: 3 },
    ])
    expect(screen.queryByText("Level-up")).toBeNull()

    setupMock({
      character: monster,
      experienceError: new Error("Undo is not safe"),
    })
    cleanup()
    await renderDetail()
    fireEvent.click(screen.getByRole("button", { name: "Decrease race level" }))
    await flush()
    expect(experiencePosts).toEqual([
      { operation: "undo", track: "race", version: 3 },
    ])
    expect(screen.getByRole("alert").textContent).toContain("Undo is not safe")
  })

  it("shows editable monster Race experience and no old quarter actions", async () => {
    const monster = {
      ...character,
      classId: null,
      className: null,
      state: {
        ...character.state,
        race: { ...character.state.race, mode: "independent", quarter: 2 },
      },
    } as unknown as import("@/lib/api").CharacterDetail
    setupMock({ character: monster })
    await renderDetail()

    expect(screen.getByLabelText("Experience slider")).toBeTruthy()
    expect(
      screen.queryByText(/Advance race|Advance class|Advance profession/)
    ).toBeNull()
    // Race grade evolution is a race action and stays available. The button
    // carries an aria-label, so match the accessible name, not the visible text
    // ("Evolve grade (to F)").
    expect(
      screen.getByRole("button", { name: /Evolve race grade to F/ })
    ).toBeTruthy()
    // No class/profession advance or evolution actions.
    expect(screen.queryByRole("button", { name: /Evolve class/ })).toBeNull()
    expect(
      screen.queryByRole("button", { name: /Evolve profession/ })
    ).toBeNull()

    // A monster (independent race mode) has no class/profession: no top-level
    // Class or Profession tabs, and no class/profession track history panels.
    expect(screen.queryByRole("tab", { name: "Class" })).toBeNull()
    expect(screen.queryByRole("tab", { name: "Profession" })).toBeNull()
    fireEvent.click(screen.getByRole("tab", { name: "Race" }))
    await flush()
    expect(screen.queryByLabelText("class history")).toBeNull()
    expect(screen.queryByLabelText("profession history")).toBeNull()
    expect(screen.getByLabelText("race history")).toBeTruthy()
  })

  it("allows undoing a level-one monster race and skips unchanged slider commits", async () => {
    const monster = {
      ...character,
      classId: null,
      className: null,
      state: {
        ...character.state,
        race: {
          ...character.state.race,
          mode: "independent",
          level: 1,
          quarter: 2,
        },
      },
    } as unknown as import("@/lib/api").CharacterDetail
    setupMock({ character: monster })
    await renderDetail()

    const decrease = screen.getByRole("button", {
      name: "Decrease race level",
    }) as HTMLButtonElement
    expect(decrease.disabled).toBe(false)
    fireEvent.click(decrease)
    await flush()
    expect(experiencePosts).toEqual([
      { operation: "undo", track: "race", version: 3 },
    ])

    // A slider commit equal to the authoritative value (including the legacy
    // quarter fallback) does not issue a write or surface an error.
    const slider = screen.getByLabelText("Experience slider")
    fireEvent.change(slider, { target: { value: "50" } })
    fireEvent.mouseUp(slider, { target: { value: "50" } })
    await flush()
    expect(experiencePosts).toHaveLength(1)
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("opens the journal exactly for a true level-up at 100 percent", async () => {
    const monster = {
      ...character,
      classId: null,
      state: {
        ...character.state,
        race: { ...character.state.race, mode: "independent", quarter: 3 },
      },
    } as unknown as import("@/lib/api").CharacterDetail
    setupMock({
      character: monster,
      experienceJournal: { leveledUp: true, notes: ["Level increased"] },
    })
    await renderDetail()
    expect(screen.getAllByText("75%").length).toBeGreaterThan(0)
    const slider = screen.getByLabelText("Experience slider")
    fireEvent.change(slider, { target: { value: "100" } })
    fireEvent.mouseUp(slider, { target: { value: "100" } })
    await flush()
    expect(experiencePosts).toEqual([
      { operation: "set", track: "race", percent: 100, version: 3 },
    ])
    expect(
      screen
        .getByRole("progressbar", { name: /Race experience/ })
        .getAttribute("aria-valuenow")
    ).toBe("0")
    expect(screen.getByText("Level-up")).toBeTruthy()
    expect(screen.getByText("Level increased")).toBeTruthy()
  })

  it("sends explicit level-up and undo operations", async () => {
    const monster = {
      ...character,
      classId: null,
      state: {
        ...character.state,
        race: { ...character.state.race, mode: "independent" },
      },
    } as unknown as import("@/lib/api").CharacterDetail
    setupMock({ character: monster })
    await renderDetail()
    fireEvent.click(screen.getByRole("button", { name: "Increase race level" }))
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Decrease race level" }))
    await flush()
    expect(experiencePosts).toEqual([
      { operation: "levelUp", track: "race", version: 3 },
      { operation: "undo", track: "race", version: 3 },
    ])
    expect(screen.queryByText("Level-up")).toBeNull()
  })

  it("shows derived Race average read-only alongside independently editable tracks", async () => {
    const enlightened = {
      ...character,
      professionName: "Maker",
      state: {
        ...character.state,
        tracks: {
          class: {
            level: 20,
            quarter: 1,
            experiencePercent: 30,
            definitionId: "c",
          },
          profession: {
            level: 4,
            quarter: 3,
            experiencePercent: 70,
            definitionId: "p",
          },
        },
        race: { ...character.state.race, mode: "derived" },
      },
    } as unknown as import("@/lib/api").CharacterDetail
    setupMock({ character: enlightened })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Race" }))
    expect(screen.getAllByText("50%").length).toBeGreaterThan(0)
    const derivedRace = screen.getByRole("progressbar", {
      name: /Race experience/,
    })
    expect(
      derivedRace.closest(".rounded-lg")?.querySelector('input[type="range"]')
    ).toBeNull()
    fireEvent.click(screen.getByRole("tab", { name: "Class" }))
    expect(
      screen.getAllByLabelText("Experience slider").length
    ).toBeGreaterThan(0)
    expect(screen.queryByText("Quarter")).toBeNull()
    fireEvent.click(screen.getByRole("tab", { name: "Profession" }))
    expect(
      screen.getAllByLabelText("Experience slider").length
    ).toBeGreaterThan(0)
    expect(screen.queryByText("Quarter")).toBeNull()
  })

  it("retains canceled skill offers as history without selectable choices", async () => {
    const canceled = {
      ...character,
      skillOffers: [
        {
          id: "offer-1",
          track: "class",
          level: 10,
          choiceGroup: "core",
          generation: 0,
          canceledAt: "2026-01-01",
          selectedDefinitionId: null,
          options: [
            {
              definitionId: "skill-1",
              nameSnapshot: "Quick Shot",
              archived: false,
            },
          ],
        },
      ],
    } as unknown as import("@/lib/api").CharacterDetail
    setupMock({ character: canceled })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }))
    expect(screen.queryByText("Canceled")).toBeNull()
    expect(screen.queryByRole("button", { name: "Select" })).toBeNull()
    expect(screen.queryByText("Quick Shot")).toBeNull()
  })

  it("includes experience set and undo events only in their track history, including derived Race changes", async () => {
    const events = [
      { kind: "experience_set", createdAt: "now", payload: { track: "class" } },
      {
        kind: "level_undo",
        createdAt: "later",
        payload: {
          track: "profession",
          journal: { raceLevelBefore: 5, raceLevelAfter: 4 },
        },
      },
    ]
    setupMock({
      events: events as import("@/lib/api").ExportResponse["events"],
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Race" }))
    await flush()
    expect(screen.getByLabelText("race history").textContent).toContain(
      "level_undo"
    )
    expect(screen.getByLabelText("race history").textContent).not.toContain(
      "experience_set"
    )
    fireEvent.click(screen.getByRole("tab", { name: "Class" }))
    await flush()
    expect(screen.getByLabelText("class history").textContent).toContain(
      "experience_set"
    )
    fireEvent.click(screen.getByRole("tab", { name: "Profession" }))
    await flush()
    expect(screen.getByLabelText("profession history").textContent).toContain(
      "level_undo"
    )
  })
})

describe("CharacterDetail progression tabs and grade descriptions", () => {
  it("renders the Race/Class/Profession top-level tabs and no legacy identity tab", async () => {
    setupMock()
    await renderDetail()
    expect(screen.getByRole("tab", { name: "Race" })).toBeTruthy()
    expect(screen.getByRole("tab", { name: "Class" })).toBeTruthy()
    expect(screen.getByRole("tab", { name: "Profession" })).toBeTruthy()
    // The old combined "Race / Class / Profession" identity tab is gone.
    expect(
      screen.queryByRole("tab", { name: "Race / Class / Profession" })
    ).toBeNull()
  })

  it("renders configured race/class/profession grade descriptions on their tabs", async () => {
    setupMock({
      character: {
        ...character,
        raceGradeDescription: "A towering human lineage.",
        classGradeDescription: "Precise archer training.",
        professionGradeDescription: "Masterful profession lore.",
      },
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Race" }))
    await flush()
    expect(screen.getByText("A towering human lineage.")).toBeTruthy()
    fireEvent.click(screen.getByRole("tab", { name: "Class" }))
    await flush()
    expect(screen.getByText("Precise archer training.")).toBeTruthy()
    fireEvent.click(screen.getByRole("tab", { name: "Profession" }))
    await flush()
    expect(screen.getByText("Masterful profession lore.")).toBeTruthy()
  })

  it("shows the grade description fallback when no description is configured", async () => {
    setupMock()
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Race" }))
    await flush()
    expect(
      screen.getAllByText("No description for this grade").length
    ).toBeGreaterThan(0)
  })
})

describe("CharacterDetail profession assignment and track history", () => {
  it("offers only current-grade professions, including Integrated G, and posts CAS version", async () => {
    const integrated = {
      ...character,
      origin: "integrated",
      state: {
        ...character.state,
        race: { ...character.state.race, grade: "G" },
      },
    } as unknown as import("@/lib/api").CharacterDetail
    setupMock({
      character: integrated,
      professions: [
        catalogItem({
          id: "g-pro",
          name: "G profession",
          kind: "professions",
          grade: "G",
          config: { grades: { G: {} } },
        }),
        catalogItem({
          id: "e-pro",
          name: "E profession",
          kind: "professions",
          grade: "E",
          config: { grades: { E: {} } },
        }),
      ],
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Profession" }))
    await flush()
    expect(screen.getByText("G profession")).toBeTruthy()
    expect(screen.queryByText("E profession")).toBeNull()
    fireEvent.click(screen.getByText("G profession"))
    fireEvent.click(screen.getByRole("button", { name: "Assign profession" }))
    await flush()
    expect(professionPosts).toEqual([{ professionId: "g-pro", version: 3 }])
  })

  it("shows CAS errors and separates track history by payload track", async () => {
    const events = [
      { kind: "create", payload: { initial: true }, createdAt: "one" },
      {
        kind: "advance",
        payload: {
          track: "class",
          journal: { raceLevelBefore: 1, raceLevelAfter: 2 },
        },
        createdAt: "two",
      },
      {
        kind: "profession_set",
        payload: { professionId: "p1" },
        createdAt: "three",
      },
      { kind: "advance", payload: { track: "profession" }, createdAt: "four" },
    ]
    setupMock({
      professions: [
        catalogItem({
          id: "g-pro",
          name: "G profession",
          kind: "professions",
          grade: "G",
          config: { grades: { G: {} } },
        }),
      ],
      events,
      professionError: new Error("Version conflict"),
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Profession" }))
    await flush()
    fireEvent.click(screen.getByText("G profession"))
    fireEvent.click(screen.getByRole("button", { name: "Assign profession" }))
    await flush()
    expect(toast.error).toHaveBeenCalledWith("Version conflict")
    const raceHistory = screen.getByLabelText("race history")
    expect(raceHistory.textContent).toContain("Initial state")
    expect(raceHistory.textContent).toContain('"track": "class"')
    const professionHistory = screen.getByLabelText("profession history")
    expect(professionHistory.textContent).toContain("profession_set")
    expect(professionHistory.textContent).toContain('"track": "profession"')
    expect(professionHistory.textContent).not.toContain('"track": "class"')
  })

  it("offers a profession only when BOTH the row grade and the config grade entry match the current race grade", async () => {
    setupMock({
      professions: [
        catalogItem({
          id: "valid",
          name: "Valid profession",
          kind: "professions",
          grade: "G",
          config: { grades: { G: {} } },
        }),
        catalogItem({
          id: "grade-mismatch",
          name: "Grade mismatch",
          kind: "professions",
          grade: "E",
          config: { grades: { G: {} } },
        }),
        catalogItem({
          id: "config-missing",
          name: "Config missing",
          kind: "professions",
          grade: "G",
          config: { grades: { E: {} } },
        }),
      ],
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Profession" }))
    await flush()
    // Only the entry whose row grade AND config agree with the current grade.
    expect(screen.getByText("Valid profession")).toBeTruthy()
    expect(screen.queryByText("Grade mismatch")).toBeNull()
    expect(screen.queryByText("Config missing")).toBeNull()
  })

  it("classifies a grade-only evolve (no payload track) as race history only", async () => {
    const events = [
      { kind: "create", payload: { initial: true }, createdAt: "one" },
      {
        kind: "evolve",
        payload: { journal: { raceLevelBefore: 5, raceLevelAfter: 6 } },
        createdAt: "two",
      },
      {
        kind: "advance",
        payload: {
          track: "class",
          journal: { raceLevelBefore: 6, raceLevelAfter: 7 },
        },
        createdAt: "three",
      },
    ]
    setupMock({ events })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Race" }))
    await flush()
    const raceHistory = screen.getByLabelText("race history")
    expect(raceHistory.textContent).toContain("evolve")
    const classHistory = screen.getByLabelText("class history")
    expect(classHistory.textContent).not.toContain("evolve")
    const professionHistory = screen.getByLabelText("profession history")
    expect(professionHistory.textContent).not.toContain("evolve")
  })

  it("invalidates cached export events after a successful profession set when history is already loaded", async () => {
    const initial = [
      { kind: "create", payload: { initial: true }, createdAt: "one" },
    ]
    setupMock({
      professions: [
        catalogItem({
          id: "g-pro",
          name: "G profession",
          kind: "professions",
          grade: "G",
          config: { grades: { G: {} } },
        }),
      ],
      events: initial,
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Race" }))
    await flush()
    const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
    const exportBefore = mock.mock.calls.filter(
      ([url]) => url === "/api/characters/chr-1/export"
    ).length
    expect(exportBefore).toBe(1)
    // The server has since recorded the assignment; the next export reflects it.
    historyEvents = [
      ...initial,
      {
        kind: "profession_set",
        payload: { professionId: "g-pro" },
        createdAt: "two",
      },
    ]
    fireEvent.click(screen.getByRole("tab", { name: "Profession" }))
    await flush()
    fireEvent.click(screen.getByText("G profession"))
    fireEvent.click(screen.getByRole("button", { name: "Assign profession" }))
    await flush()
    const exportAfter = mock.mock.calls.filter(
      ([url]) => url === "/api/characters/chr-1/export"
    ).length
    expect(exportAfter).toBeGreaterThan(exportBefore)
    const professionHistory = screen.getByLabelText("profession history")
    expect(professionHistory.textContent).toContain("profession_set")
  })
})

describe("CharacterDetail evolution options error state", () => {
  it("shows a retry and hides the legacy fallback/action when evolution options fail to load", async () => {
    setupMock()
    evolutionsError = new Error("network down")

    await renderDetail()

    // Open the evolve dialog. At grade G the client targets the next grade (F), so
    // the button is enabled.
    fireEvent.click(screen.getByText(/Evolve grade/))
    await flush()

    // No false availability claim: the failed options fetch surfaces the raw error
    // and a retry, with no legacy grade-only fallback.
    expect(screen.getByText("network down")).toBeTruthy()
    expect(screen.getByText("Retry")).toBeTruthy()
    expect(screen.queryByText(/Grade-only/)).toBeNull()
    expect(
      screen.queryByText("No race evolution options are available yet.")
    ).toBeNull()

    // The action is withheld: the submit button is disabled.
    const submitBtn = screen.getByText(/Evolve to -/).closest("button")
    expect(submitBtn?.disabled).toBe(true)
  })

  it("recovers via the retry button once the evolution options fetch succeeds", async () => {
    setupMock()
    evolutionsError = new Error("network down")

    await renderDetail()
    fireEvent.click(screen.getByText(/Evolve grade/))
    await flush()

    expect(screen.getByText("Retry")).toBeTruthy()

    // The network recovers; the retry fetch now succeeds with no options (there
    // is no grade-only path anymore).
    evolutionsError = null
    fireEvent.click(screen.getByText("Retry"))
    await flush()

    // The error/retry UI is gone and the empty candidate set is honestly reported.
    expect(
      screen.queryByText("Could not load race evolution options.")
    ).toBeNull()
    expect(
      screen.getByText("No race evolution options are available yet.")
    ).toBeTruthy()

    const submitBtn = screen.getByText(/Evolve to -/).closest("button")
    expect(submitBtn?.disabled).toBe(true)
  })
})

describe("CharacterDetail power associations", () => {
  it("formats an existing blessing link from its god name and persisted tier", async () => {
    setupMock({
      character: {
        ...character,
        associations: [
          association({
            id: "assoc-viper",
            kind: "blessing",
            definitionId: "god-viper",
            name: "The Malefic Viper",
            tier: "True",
          }),
        ],
      },
    })
    await renderDetail()
    expect(
      within(screen.getAllByTestId("panel-blessings")[0]).getByText(
        "True Blessing of The Malefic Viper"
      )
    ).toBeTruthy()
  })

  it("confirms replacing the sole bloodline and names archived displaced links", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true)
    setupMock({
      character: {
        ...character,
        associations: [
          association({
            id: "old",
            kind: "bloodline",
            definitionId: "old",
            name: "Old active",
          }),
          association({
            id: "old-archived",
            kind: "bloodline",
            definitionId: "old-archived",
            name: "Old archived",
            definitionArchived: true,
          }),
        ],
      },
      bloodlines: [catalogItem({ id: "new", name: "New bloodline" })],
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("button", { name: "Manage bloodlines" }))
    await flush()
    const add = screen
      .getAllByRole("button", { name: "Add" })
      .find((button) =>
        button.closest("div")?.textContent?.includes("New bloodline")
      )
    fireEvent.click(add!)
    await flush()
    expect(screen.getByRole("alertdialog")).toBeTruthy()
    expect(
      screen.getByText(
        /New bloodline will replace Old active, Old archived \(archived, inert\)/
      )
    ).toBeTruthy()
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it("shows the configured transcendent cap and disables Add at capacity", async () => {
    setupMock({
      maxTranscendentSkills: 1,
      character: {
        ...character,
        associations: [
          association({
            id: "linked",
            kind: "transcendent",
            definitionId: "linked",
            name: "Linked skill",
          }),
        ],
      },
      transcendentSkills: [
        catalogItem({
          id: "available",
          name: "Available skill",
          kind: "transcendent_skills",
        }),
      ],
    })
    await renderDetail()
    fireEvent.click(
      screen.getByRole("button", { name: "Manage transcendent skills" })
    )
    await flush()
    expect(screen.getByText("Selected 1 / maximum 1")).toBeTruthy()
    const attach = screen.getByRole("button", {
      name: "Attach",
    }) as HTMLButtonElement
    expect(attach.disabled).toBe(true)
  })

  it("surfaces a failed cap load and blocks Add instead of assuming a default", async () => {
    setupMock({
      creationRulesError: new Error("rules offline"),
      transcendentSkills: [
        catalogItem({
          id: "available",
          name: "Available skill",
          kind: "transcendent_skills",
        }),
      ],
    })
    await renderDetail()
    fireEvent.click(
      screen.getByRole("button", { name: "Manage transcendent skills" })
    )
    await flush()
    expect(screen.getByText(/rules offline/)).toBeTruthy()
    expect(
      (screen.getByRole("button", { name: "Attach" }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
  })

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

    const blessingSection = within(screen.getAllByTestId("panel-blessings")[0])
    const bloodlineSection = within(
      screen.getAllByTestId("panel-bloodlines")[0]
    )
    expect(blessingSection.getByText("Blessing of Fire")).toBeTruthy()
    expect(bloodlineSection.getByText("Wolf Bloodline")).toBeTruthy()
    // The archived linked blessing stays visible but is honestly marked inert.
    expect(blessingSection.getByText("Old Blessing")).toBeTruthy()
    expect(blessingSection.getByText("Archived - inert")).toBeTruthy()
  })

  it("monster and classless characters can open Manage powers and add a blessing", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true)
    const monster = {
      ...character,
      classId: null,
      className: null,
      state: {
        ...character.state,
        tracks: {},
        race: {
          ...character.state.race,
          mode: "independent",
          quarter: 2,
        },
      },
    } as unknown as import("@/lib/api").CharacterDetail
    setupMock({
      character: monster,
      blessings: [
        catalogItem({ id: "bless-monster", name: "Monster Blessing" }),
      ],
    })

    await renderDetail()
    // The Manage powers button is NOT gated on a class: a monster/classless
    // character can open the association sheet.
    fireEvent.click(screen.getByRole("button", { name: "Manage blessings" }))
    await flush()
    fireEvent.click(screen.getByText("Add"))
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }))
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
      tier?: string
    }
    expect(body).toEqual({
      kind: "blessing",
      definitionId: "bless-monster",
      operation: "add",
      version: 3,
      tier: "Minor",
    })

    // The reload reflects the newly linked blessing on the powers tab.
    const blessingSection = within(screen.getAllByTestId("panel-blessings")[0])
    expect(blessingSection.getByText("Monster Blessing")).toBeTruthy()
  })

  it("loads blessing choices from the Gods catalog and exposes a tier selector", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Manage blessings" }))
    await flush()

    expect(screen.getByLabelText("Blessing tier")).toBeTruthy()
    expect(
      (apiFetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(
        ([url]) => url === "/api/catalog/gods"
      )
    ).toBe(true)
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
    fireEvent.click(screen.getByRole("button", { name: "Manage blessings" }))
    await flush()
    fireEvent.click(screen.getByText("Add"))
    await flush()

    // The replacement confirmation lists ALL displaced links, not just the active
    // one: both the active and the archived blessing are named, and the archived
    // one carries the "(archived, inert)" marker.
    expect(
      screen.getByText(
        /New Blessing will replace Blessing of Fire, Old Blessing \(archived, inert\)/
      )
    ).toBeTruthy()
    expect(confirmSpy).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }))
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
      tier?: string
    }
    expect(body).toEqual({
      kind: "blessing",
      definitionId: "bless-new",
      operation: "add",
      version: 3,
      tier: "Minor",
    })

    // The successful reload reflects the newly linked blessing.
    const blessingSection = within(screen.getAllByTestId("panel-blessings")[0])
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
    fireEvent.click(screen.getByRole("button", { name: "Manage blessings" }))
    await flush()
    fireEvent.click(screen.getByText("Add"))
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
    const assocPosts = mock.mock.calls.filter(
      ([url, init]) =>
        url === "/api/characters/chr-1/associations" &&
        (init as RequestInit | undefined)?.method === "POST"
    )
    expect(assocPosts).toEqual([])
    // The blessings tab still shows only the original blessing - no fake success.
    const blessingSection = within(screen.getAllByTestId("panel-blessings")[0])
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
    fireEvent.click(screen.getByRole("button", { name: "Manage bloodlines" }))
    await flush()
    fireEvent.click(screen.getByText("Remove"))
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }))
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

    // The reload reflects the removal: the bloodlines tab no longer lists it.
    const bloodlineSection = within(
      screen.getAllByTestId("panel-bloodlines")[0]
    )
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
    fireEvent.click(screen.getByRole("button", { name: "Manage blessings" }))
    await flush()
    fireEvent.click(screen.getByText("Add"))
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }))
    await flush()

    // The failure is surfaced, not swallowed.
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("network down")
    )
    // No fake success: the blessings tab still lists only the original blessing.
    const blessingSection = within(screen.getAllByTestId("panel-blessings")[0])
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

    const section = within(screen.getAllByTestId("panel-transcendent")[0])
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

    const section = within(screen.getAllByTestId("panel-transcendent")[0])
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
    fireEvent.click(
      screen.getByRole("button", { name: "Manage transcendent skills" })
    )
    await flush()
    fireEvent.click(
      screen.getAllByRole("tab", { name: "Transcendent skills" }).at(-1)!
    )
    await flush()
    const removeOld = screen
      .getAllByRole("button", { name: "Remove" })
      .find((button) =>
        button.parentElement?.parentElement?.textContent?.includes(
          "Old Transcendence"
        )
      )
    expect(removeOld).toBeTruthy()
    fireEvent.click(removeOld!)
    await flush()
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" }).at(-1)!)
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }))
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
    fireEvent.click(
      screen.getByRole("button", { name: "Manage transcendent skills" })
    )
    await flush()

    const attachA = screen
      .getAllByRole("button", { name: "Attach" })
      .find((btn) =>
        btn.closest("div")?.textContent?.includes("Transcendence A")
      )
    expect(attachA).toBeTruthy()
    fireEvent.click(attachA!)
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }))
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
    fireEvent.click(
      screen.getByRole("button", { name: "Manage transcendent skills" })
    )
    await flush()
    fireEvent.click(screen.getByText("Attach"))
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }))
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
  it("shows grouped owned stock and confirms one-item use outside management", async () => {
    setupMock({
      character: {
        ...character,
        inventory: [
          inventoryItem({
            id: "inv-potion",
            definitionId: "item-potion",
            name: "Healing Tonic",
            kind: "items",
            quantity: 1,
          }),
          inventoryItem({
            id: "inv-sword",
            definitionId: "eq-sword",
            name: "Iron Sword",
            kind: "equipment",
            quantity: 2,
            slot: "Weapon",
          }),
        ],
      },
    })
    await renderDetail()
    expect(screen.getByLabelText("Owned equipment")).toBeTruthy()
    expect(screen.getByText("Iron Sword")).toBeTruthy()
    expect(screen.getByText("Slot: Weapon")).toBeTruthy()
    expect(screen.getByLabelText("Owned items")).toBeTruthy()
    expect(screen.getByText("Qty 1")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Use" }))
    expect(screen.getByText(/spends one Healing Tonic/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await flush()
    expect(inventoryPosts).toHaveLength(0)

    fireEvent.click(screen.getByRole("button", { name: "Use" }))
    fireEvent.click(screen.getByRole("button", { name: "Confirm use" }))
    await flush()
    expect(inventoryPosts).toEqual([
      {
        operation: "use",
        definitionId: "item-potion",
        quantity: 1,
        version: 3,
      },
    ])
    expect(screen.queryByText("Healing Tonic")).toBeNull()
    expect(screen.getByText("Iron Sword")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Use" })).toBeNull()
  })

  it("allows using archived item stock and exposes a retry after a stale write", async () => {
    setupMock({
      character: {
        ...character,
        inventory: [
          inventoryItem({
            id: "inv-token",
            definitionId: "old-token",
            name: "Old Token",
            kind: "items",
            quantity: 2,
            archived: true,
          }),
        ],
      },
    })
    await renderDetail()
    expect(screen.getByText("Archived - inert")).toBeTruthy()
    const useButton = screen.getByRole("button", { name: "Use" })
    fireEvent.click(useButton)
    inventoryError = new Error("Version conflict")
    fireEvent.click(screen.getByRole("button", { name: "Confirm use" }))
    await flush()
    expect(screen.getByRole("alert").textContent).toContain("Version conflict")
    expect(screen.getByRole("button", { name: "Confirm use" })).toBeTruthy()
    inventoryError = null
    fireEvent.click(screen.getByRole("button", { name: "Confirm use" }))
    await flush()
    expect(inventoryPosts).toHaveLength(1)
    expect(inventoryPosts[0]).toMatchObject({ operation: "use", quantity: 1 })
    expect(screen.getByText("Qty 1")).toBeTruthy()
  })

  it("Inventory tab Add stock saves an add POST and refreshes the owned quantity", async () => {
    setupMock({
      equipmentCatalog: [
        catalogItem({
          id: "eq-sword",
          name: "Iron Sword",
          kind: "equipment",
          config: { slot: "weapon" },
        }),
        ...Array.from({ length: 15 }, (_, index) =>
          catalogItem({
            id: `eq-extra-${index}`,
            name: `Catalog Blade ${index}`,
            kind: "equipment",
          })
        ),
      ],
    })

    await renderDetail()
    // The Tabs mock never fires onValueChange, so the inventory tab does not
    // load catalogs on its own; open the associations sheet to trigger the
    // catalog loads that back the Add stock dialog.
    fireEvent.click(
      screen.getAllByRole("button", { name: "Manage equipment" })[0]
    )
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

    // Search a large catalog, handle empty results, then select the match.
    fireEvent.change(
      within(dialog).getByRole("searchbox", { name: "Search stock catalog" }),
      {
        target: { value: "no such stock" },
      }
    )
    expect(
      within(dialog).getByText("No stock catalog items match your search.")
    ).toBeTruthy()
    fireEvent.change(
      within(dialog).getByRole("searchbox", { name: "Search stock catalog" }),
      {
        target: { value: "IRON SWORD" },
      }
    )
    expect(within(dialog).queryByText("Catalog Blade 0")).toBeNull()
    fireEvent.click(within(dialog).getByText("Iron Sword"))
    await flush()
    fireEvent.change(
      within(dialog).getByRole("searchbox", { name: "Search stock catalog" }),
      {
        target: { value: "no match now" },
      }
    )
    expect(within(dialog).getByText("Iron Sword")).toBeTruthy()

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
    expect(screen.getAllByText("Qty 2").length).toBeGreaterThan(0)
  })

  it("an archived item inventory row shows stock quantity without consume controls", async () => {
    setupMock({
      character: {
        ...character,
        inventory: [
          inventoryItem({
            id: "inv-potion",
            definitionId: "item-token",
            name: "Old Token",
            kind: "items",
            quantity: 1,
            archived: true,
          }),
        ],
      },
      itemsCatalog: [
        catalogItem({
          id: "item-token",
          name: "Old Token",
          kind: "items",
          archived: true,
        }),
      ],
    })

    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Inventory" }))
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Manage inventory" }))
    await flush()

    const sheet = associationSheetContent("inventoryEquipment")
    const ownedItems = within(within(sheet).getByLabelText("Owned items"))
    // Archived stock stays visible and is honestly marked inert.
    expect(ownedItems.getByText("Old Token")).toBeTruthy()
    expect(ownedItems.getByText("Qty 1")).toBeTruthy()
    expect(ownedItems.getByText("Archived - inert")).toBeTruthy()
    expect(ownedItems.queryByRole("button", { name: "Consume" })).toBeNull()
    // But owned archived stock can still be discarded.
    const discard = ownedItems.getByRole("button", {
      name: "Discard",
    }) as HTMLButtonElement
    expect(discard.disabled).toBe(false)

    fireEvent.click(discard)
    await flush()

    const heading = within(sheet).getByRole("heading", {
      name: "Discard stock",
    })
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
        definitionId: "item-token",
        quantity: 1,
        version: 3,
        sourceNote: "used it up",
      },
    ])

    // The row disappears on reload; the archived catalog entry remains visible
    // only via the management sheet, not as owned stock.
    const after = within(within(sheet).getByLabelText("Owned items"))
    expect(after.queryByText("Old Token")).toBeNull()
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
    fireEvent.click(
      screen.getAllByRole("button", { name: "Manage equipment" })[0]
    )
    await flush()

    const sheetContent = associationSheetContent("inventoryEquipment")
    fireEvent.click(
      within(sheetContent).getByRole("tab", { name: "Equipment" })
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
    const after = within(associationSheetContent("inventoryEquipment"))
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
    fireEvent.click(screen.getByRole("tab", { name: "Inventory" }))
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Manage inventory" }))
    await flush()

    const sheet = associationSheetContent("inventoryEquipment")
    const ownedEquip = within(within(sheet).getByLabelText("Owned equipment"))
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
    fireEvent.click(screen.getByRole("tab", { name: "Inventory" }))
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Manage inventory" }))
    await flush()

    const sheet = associationSheetContent("inventoryEquipment")
    const ownedEquip = within(within(sheet).getByLabelText("Owned equipment"))
    const discard = ownedEquip.getByRole("button", {
      name: "Discard",
    }) as HTMLButtonElement
    // Two units available, one must stay equipped: Discard is allowed.
    expect(discard.disabled).toBe(false)

    fireEvent.click(discard)
    await flush()

    const heading = within(sheet).getByRole("heading", {
      name: "Discard stock",
    })
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

describe("CharacterDetail profile metadata whitespace", () => {
  it("preserves exact multiline whitespace in biography/notes in the notes Save PATCH body (no trim)", async () => {
    setupMock({ character: { ...character, biography: "", notes: "" } })
    await renderDetail()

    const bio = "\n  first line\n  second line  \n\n"
    const notes = "  \nleading space line\n\tindented\t\n"
    fireEvent.change(screen.getByLabelText("Biography"), {
      target: { value: bio },
    })
    fireEvent.change(screen.getByLabelText("Notes"), {
      target: { value: notes },
    })

    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()

    // The Save PATCH carries the raw biography/notes: leading/trailing whitespace
    // and internal newlines are never trimmed.
    expect(patchPosts).toHaveLength(1)
    expect(patchPosts[0].biography).toBe(bio)
    expect(patchPosts[0].notes).toBe(notes)
  })
})

describe("CharacterDetail profile metadata", () => {
  it("renders the six profile metadata fields and the profile preview from the initial GET", async () => {
    setupMock({
      character: {
        ...character,
        nickname: "Kit",
        pronouns: "they/them",
        ageDescription: "Ancient wanderer",
        appearance: "Tall, scarred",
        biography: "Born under a red moon.",
        notes: "Secretive.",
      },
    })
    await renderDetail()

    // The editor inputs are populated from the server-provided metadata.
    expect((screen.getByLabelText("Nickname") as HTMLInputElement).value).toBe(
      "Kit"
    )
    expect((screen.getByLabelText("Pronouns") as HTMLInputElement).value).toBe(
      "they/them"
    )
    expect(
      (screen.getByLabelText("Age description") as HTMLTextAreaElement).value
    ).toBe("Ancient wanderer")
    expect(
      (screen.getByLabelText("Appearance") as HTMLTextAreaElement).value
    ).toBe("Tall, scarred")
    expect(
      (screen.getByLabelText("Biography") as HTMLTextAreaElement).value
    ).toBe("Born under a red moon.")
    expect((screen.getByLabelText("Notes") as HTMLTextAreaElement).value).toBe(
      "Secretive."
    )

    // The profile preview renders the persisted metadata. Value assertions are
    // scoped to the preview container because controlled textareas also expose
    // their text value as a text node, which would otherwise match twice.
    const preview = screen.getByRole("heading", { name: "Profile preview" })
      .parentElement as HTMLElement
    const page = within(preview)

    expect(page.getByText("Nickname:")).toBeTruthy()
    expect(page.getByText("Kit")).toBeTruthy()
    expect(page.getByText(/they\/them/)).toBeTruthy()
    expect(page.getByText("Age:")).toBeTruthy()
    expect(page.getByText("Ancient wanderer")).toBeTruthy()
    expect(page.getByText("Appearance:")).toBeTruthy()
    expect(page.getByText("Tall, scarred")).toBeTruthy()
    expect(page.getByText("Biography:")).toBeTruthy()
    expect(page.getByText("Born under a red moon.")).toBeTruthy()
    expect(page.getByText("Notes:")).toBeTruthy()
    expect(page.getByText("Secretive.")).toBeTruthy()
  })

  it("saves name/description and all six metadata fields via PATCH with the current version, then reload displays the changes", async () => {
    setupMock({ character: { ...character } })
    await renderDetail()

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Kael" },
    })
    fireEvent.change(screen.getByLabelText("Notes / description"), {
      target: { value: "A description" },
    })
    fireEvent.change(screen.getByLabelText("Nickname"), {
      target: { value: "Kit" },
    })
    fireEvent.change(screen.getByLabelText("Pronouns"), {
      target: { value: "they/them" },
    })
    fireEvent.change(screen.getByLabelText("Age description"), {
      target: { value: "Ancient wanderer" },
    })
    fireEvent.change(screen.getByLabelText("Appearance"), {
      target: { value: "Tall, scarred" },
    })
    fireEvent.change(screen.getByLabelText("Biography"), {
      target: { value: "Born under a red moon." },
    })
    fireEvent.change(screen.getByLabelText("Notes"), {
      target: { value: "Secretive." },
    })

    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()

    // Exactly one PATCH, carrying every edited field plus the CAS version.
    expect(patchPosts).toHaveLength(1)
    expect(patchPosts[0]).toEqual({
      name: "Kael",
      description: "A description",
      nickname: "Kit",
      pronouns: "they/them",
      ageDescription: "Ancient wanderer",
      appearance: "Tall, scarred",
      biography: "Born under a red moon.",
      notes: "Secretive.",
      version: 3,
    })

    // The reload fetches the persisted character and displays the changes, and
    // the optimistic-concurrency write bumped the stored version. The value is
    // scoped to the profile preview because the editor textarea also carries the
    // value as its text content.
    expect(screen.getByText("v4")).toBeTruthy()
    expect((screen.getByLabelText("Nickname") as HTMLInputElement).value).toBe(
      "Kit"
    )
    const preview = screen.getByRole("heading", { name: "Profile preview" })
      .parentElement as HTMLElement
    const previewPage = within(preview)
    expect(previewPage.getByText("Age:")).toBeTruthy()
    expect(previewPage.getByText("Ancient wanderer")).toBeTruthy()
  })

  it("clearing previously-set metadata fields posts null in the Save PATCH", async () => {
    setupMock({
      character: {
        ...character,
        nickname: "Kit",
        pronouns: "they/them",
        ageDescription: "Ancient wanderer",
        appearance: "Tall, scarred",
        biography: "Born under a red moon.",
        notes: "Secretive.",
      },
    })
    await renderDetail()

    fireEvent.change(screen.getByLabelText("Nickname"), {
      target: { value: "" },
    })
    fireEvent.change(screen.getByLabelText("Pronouns"), {
      target: { value: "" },
    })
    fireEvent.change(screen.getByLabelText("Age description"), {
      target: { value: "" },
    })
    fireEvent.change(screen.getByLabelText("Appearance"), {
      target: { value: "" },
    })
    fireEvent.change(screen.getByLabelText("Biography"), {
      target: { value: "" },
    })
    fireEvent.change(screen.getByLabelText("Notes"), {
      target: { value: "" },
    })

    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()

    expect(patchPosts).toHaveLength(1)
    // A blank metadata field is cleared on the server (null), never kept as "".
    expect(patchPosts[0].nickname).toBeNull()
    expect(patchPosts[0].pronouns).toBeNull()
    expect(patchPosts[0].ageDescription).toBeNull()
    expect(patchPosts[0].appearance).toBeNull()
    expect(patchPosts[0].biography).toBeNull()
    expect(patchPosts[0].notes).toBeNull()
  })

  it("a failed profile save keeps the current form and surfaces the error (no fake Saved)", async () => {
    setupMock({
      character: { ...character },
      profileSaveError: new Error("network down"),
    })
    await renderDetail()

    fireEvent.change(screen.getByLabelText("Biography"), {
      target: { value: "New bio" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await flush()

    // The failure is surfaced as a visible error, not swallowed.
    expect(screen.getByText(/network down/)).toBeTruthy()
    // No fake success: the "Saved." toast was never fired and the button is not
    // stuck on "Saving...".
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy()
    // A failed save must not reload/clobber the current form.
    expect(
      (screen.getByLabelText("Biography") as HTMLTextAreaElement).value
    ).toBe("New bio")
  })
})

describe("CharacterDetail ring equipment position and gating", () => {
  it("sheet: a Ring-1-slot ring equipped with position Ring 2 posts equipmentPosition Ring 2", async () => {
    setupMock({
      character: {
        ...character,
        inventory: [
          inventoryItem({
            id: "inv-ring",
            definitionId: "ring-1",
            name: "Ring of Power",
            kind: "equipment",
            quantity: 1,
            slot: "Ring 1",
          }),
        ],
      },
      equipmentCatalog: [
        catalogItem({
          id: "ring-1",
          name: "Ring of Power",
          kind: "equipment",
          config: { slot: "Ring 1" },
        }),
      ],
    })
    await renderDetail()
    fireEvent.click(
      screen.getAllByRole("button", { name: "Manage equipment" })[0]
    )
    await flush()
    const sheetContent = associationSheetContent("inventoryEquipment")
    fireEvent.click(
      within(sheetContent).getByRole("tab", { name: "Equipment" })
    )
    await flush()
    const equipmentPanel = within(sheetContent).getByTestId("panel-equipment")
    fireEvent.change(
      within(equipmentPanel).getByLabelText("Equip position for Ring of Power"),
      { target: { value: "Ring 2" } }
    )
    await flush()
    fireEvent.click(
      within(equipmentPanel).getByRole("button", { name: "Equip" })
    )
    await flush()
    const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
    const post = mock.mock.calls.find(
      ([url, init]) =>
        url === "/api/characters/chr-1/associations" &&
        (init as RequestInit | undefined)?.method === "POST"
    )
    expect(post).toBeTruthy()
    const body = JSON.parse((post![1] as RequestInit).body as string) as {
      kind: string
      definitionId: string
      operation: string
      version: number
      equipmentPosition?: string
    }
    expect(body).toEqual({
      kind: "equipment",
      definitionId: "ring-1",
      operation: "add",
      version: 3,
      equipmentPosition: "Ring 2",
    })
  })

  it("inventory: a legacy lowercase ring1 inventory slot is a ring and posts Ring 1 position", async () => {
    setupMock({
      character: {
        ...character,
        inventory: [
          inventoryItem({
            id: "inv-ring",
            definitionId: "ring-legacy",
            name: "Legacy Ring",
            kind: "equipment",
            quantity: 1,
            slot: "ring1",
          }),
        ],
      },
      // No equipment catalog entry for this legacy definition, so the ring
      // determination falls back to the normalized inventory slot.
      equipmentCatalog: [],
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Inventory" }))
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Manage inventory" }))
    await flush()
    const sheet = associationSheetContent("inventoryEquipment")
    const ownedEquip = within(within(sheet).getByLabelText("Owned equipment"))
    // The normalized inventory slot alone identifies this as a ring and offers
    // the position selector.
    fireEvent.change(
      ownedEquip.getByLabelText("Equip position for Legacy Ring"),
      { target: { value: "Ring 1" } }
    )
    await flush()
    fireEvent.click(ownedEquip.getByRole("button", { name: "Equip" }))
    await flush()
    const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
    const post = mock.mock.calls.find(
      ([url, init]) =>
        url === "/api/characters/chr-1/associations" &&
        (init as RequestInit | undefined)?.method === "POST"
    )
    expect(post).toBeTruthy()
    const body = JSON.parse((post![1] as RequestInit).body as string) as {
      kind: string
      definitionId: string
      operation: string
      version: number
      equipmentPosition?: string
    }
    expect(body).toEqual({
      kind: "equipment",
      definitionId: "ring-legacy",
      operation: "add",
      version: 3,
      equipmentPosition: "Ring 1",
    })
  })

  it("omits equipmentPosition when equipping a non-ring item", async () => {
    setupMock({
      character: {
        ...character,
        inventory: [
          inventoryItem({
            id: "inv-sword",
            definitionId: "sword",
            name: "Iron Sword",
            kind: "equipment",
            quantity: 1,
            slot: "weapon",
          }),
        ],
      },
      equipmentCatalog: [
        catalogItem({
          id: "sword",
          name: "Iron Sword",
          kind: "equipment",
          config: { slot: "weapon" },
        }),
      ],
    })
    await renderDetail()
    fireEvent.click(screen.getByRole("tab", { name: "Inventory" }))
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Manage inventory" }))
    await flush()
    const sheet = associationSheetContent("inventoryEquipment")
    const ownedEquip = within(within(sheet).getByLabelText("Owned equipment"))
    expect(
      ownedEquip.queryByLabelText("Equip position for Iron Sword")
    ).toBeNull()
    fireEvent.click(ownedEquip.getByRole("button", { name: "Equip" }))
    await flush()
    const mock = apiFetch as unknown as ReturnType<typeof vi.fn>
    const post = mock.mock.calls.find(
      ([url, init]) =>
        url === "/api/characters/chr-1/associations" &&
        (init as RequestInit | undefined)?.method === "POST"
    )
    expect(post).toBeTruthy()
    const body = JSON.parse((post![1] as RequestInit).body as string) as Record<
      string,
      unknown
    >
    expect(body).toEqual({
      kind: "equipment",
      definitionId: "sword",
      operation: "add",
      version: 3,
    })
    expect("equipmentPosition" in body).toBe(false)
  })

  it("sheet: zero stock and unmet requirements disable Equip, but an ineligible linked item stays removable", async () => {
    const helm = catalogItem({
      id: "helm",
      name: "Helm",
      kind: "equipment",
      config: { slot: "head" },
    })
    const mail = catalogItem({
      id: "mail",
      name: "Mail",
      kind: "equipment",
      config: { slot: "chest" },
    })
    const blade = catalogItem({
      id: "blade",
      name: "Blade",
      kind: "equipment",
      config: { slot: "hand" },
    })
    setupMock({
      character: {
        ...character,
        inventory: [
          inventoryItem({
            id: "inv-mail",
            definitionId: "mail",
            name: "Mail",
            kind: "equipment",
            quantity: 1,
            equipmentEligibility: {
              eligible: false,
              reason: "Requires level 40",
            },
          }),
        ],
        associations: [
          association({
            id: "blade-link",
            kind: "equipment",
            definitionId: "blade",
            name: "Blade",
            equipmentEligibility: {
              eligible: false,
              reason: "Requires level 40",
            },
          }),
        ],
      },
      equipmentCatalog: [helm, mail, blade],
    })
    await renderDetail()
    fireEvent.click(
      screen.getAllByRole("button", { name: "Manage equipment" })[0]
    )
    await flush()
    const sheetContent = associationSheetContent("inventoryEquipment")
    fireEvent.click(
      within(sheetContent).getByRole("tab", { name: "Equipment" })
    )
    await flush()

    const equipmentPanel = within(sheetContent).getByTestId("panel-equipment")

    // Zero owned stock: Equip is replaced by a disabled "Add stock first".
    const noStock = within(equipmentPanel).getByRole("button", {
      name: "Add stock first",
    }) as HTMLButtonElement
    expect(noStock.disabled).toBe(true)

    // Owned but unmet requirements: Equip is disabled and carries the reason.
    const unmet = within(equipmentPanel).getByRole("button", {
      name: "Equip",
    }) as HTMLButtonElement
    expect(unmet.disabled).toBe(true)
    expect(unmet.title).toBe("Requires level 40")

    // A linked-but-ineligible item is still removable (Remove is busy-gated only).
    const remove = within(equipmentPanel).getByRole("button", {
      name: "Remove",
    }) as HTMLButtonElement
    expect(remove.disabled).toBe(false)
  })
})

describe("CharacterDetail linked grade descriptions", () => {
  it("renders link grade description, its missing fallback, and a formatted equip percent", async () => {
    setupMock({
      character: {
        ...character,
        associations: [
          association({
            id: "title-c",
            kind: "title",
            definitionId: "title-c",
            name: "Tier C Title",
            grade: "C",
            gradeDescription: "Tier C prose.",
          }),
          association({
            id: "title-b",
            kind: "title",
            definitionId: "title-b",
            name: "Tier B Title",
            grade: "B",
          }),
          association({
            id: "staff-link",
            kind: "equipment",
            definitionId: "staff",
            name: "Staff",
            grade: "F",
            gradeDescription: "Equipment tier F prose.",
          }),
        ],
      },
      titles: [
        catalogItem({ id: "title-c", name: "Tier C Title", kind: "titles" }),
      ],
      equipmentCatalog: [
        catalogItem({
          id: "staff",
          name: "Staff",
          kind: "equipment",
          config: { slot: "weapon", percentBasisPoints: { strength: 1250 } },
        }),
      ],
    })
    await renderDetail()

    // The linked title's configured grade description and the missing-grade
    // fallback both render; the catalog description is never used as a fallback.
    expect(screen.getAllByText("Tier C prose.").length).toBeGreaterThan(0)
    expect(
      screen.getAllByText("No description for this grade").length
    ).toBeGreaterThan(0)

    fireEvent.click(
      screen.getAllByRole("button", { name: "Manage equipment" })[0]
    )
    await flush()
    const sheetContent = associationSheetContent("inventoryEquipment")
    fireEvent.click(
      within(sheetContent).getByRole("tab", { name: "Equipment" })
    )
    await flush()
    // Active catalog equipment row uses the linked association's grade description.
    expect(
      within(sheetContent).getByText("Equipment tier F prose.")
    ).toBeTruthy()
    // The equipment percent is formatted from basis points (12.50%).
    expect(within(sheetContent).getByText(/strength:12\.50%/)).toBeTruthy()
  })
})
