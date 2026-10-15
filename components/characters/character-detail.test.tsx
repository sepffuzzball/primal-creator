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
    TabsContent: ({ children }: React.ComponentProps<"div">) => (
      <div>{children}</div>
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
  operation: "add" | "remove"
  definitionId: string
  quantity: number
  version: number
  sourceNote: string
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
let professionCatalog: import("@/lib/api").CatalogItem[] = []
let historyEvents: import("@/lib/api").ExportResponse["events"] = []
let professionPostError: unknown = null
let professionPosts: Array<Record<string, unknown>> = []
let skillsCatalogForTest: import("@/lib/api").CatalogItem[] = []
let upgradeErrorForTest: unknown = null
let upgradePostsForTest: Array<Record<string, unknown>> = []

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
  professionCatalog = options?.professions ?? []
  historyEvents = options?.events ?? []
  professionPostError = options?.professionError ?? null
  professionPosts = []
  skillsCatalogForTest = options?.skills ?? []
  upgradeErrorForTest = options?.upgradeError ?? null
  upgradePostsForTest = []
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
      return { character: activeCharacter }
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
    if (url === "/api/characters/chr-1/portrait") return { portrait: null }
    if (url === "/api/characters/chr-1/export") return { events: historyEvents }
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
        operation: "add" | "remove"
        version: number
      }
      if (body.kind === "title") {
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
    expect(screen.getByText("historical-fixed")).toBeTruthy()
    expect(screen.getByText("Race fixed")).toBeTruthy()
    expect(screen.getByText("Class fixed")).toBeTruthy()
    expect(screen.getByText("Profession fixed")).toBeTruthy()
    expect(screen.getByText("6 (+6)")).toBeTruthy()
    expect(screen.getByRole("heading", { name: "Derived Stats" })).toBeTruthy()
  })
})

describe("CharacterDetail ranked title claims", () => {
  const rankedTitle = (
    id: string,
    name: string,
    rank: number,
    minRaceGrade: string = "G"
  ) =>
    catalogItem({
      id,
      name,
      kind: "titles",
      config: {
        improvement: { seriesId: "pioneer", rank, minRaceGrade },
        upgradeGroup: "pioneer",
        flat: { strength: rank },
      },
    })

  it("requires a self-reported first-clear detail and sends it with version", async () => {
    setupMock({ titles: [rankedTitle("pioneer-1", "Pioneer I", 1)] })
    await renderDetail()
    fireEvent.click(screen.getByText("Manage powers"))
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
    setupMock({ titles: [rankedTitle("pioneer-2", "Pioneer II", 2, "C")] })
    await renderDetail()
    fireEvent.click(screen.getByText("Manage powers"))
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
    setupMock({ titles: [rankedTitle("pioneer-2", "Pioneer II", 2)] })
    await renderDetail()
    fireEvent.click(screen.getByText("Manage powers"))
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
            upgradeGroup: "pioneer",
            improvement: { seriesId: "pioneer", rank: 3, minRaceGrade: "G" },
          }),
        ],
      },
      titles: [rankedTitle("pioneer-4", "Pioneer IV", 4, "E")],
    })
    await renderDetail()
    fireEvent.click(screen.getByText("Manage powers"))
    await flush()
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
            upgradeGroup: "pioneer",
          }),
        ],
      },
      titles: [rankedTitle("pioneer-2", "Pioneer II", 2)],
    })
    await renderDetail()
    fireEvent.click(screen.getByText("Manage powers"))
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
    fireEvent.click(screen.getByText("Manage powers"))
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
      titles: [rankedTitle("pioneer-1", "Pioneer I", 1)],
    })
    await renderDetail()
    fireEvent.click(screen.getByText("Manage powers"))
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
    expect(screen.getAllByText("Soulbound").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Requires level 30").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Monstrous (monster)").length).toBeGreaterThan(0)
    expect(
      screen
        .getAllByRole("button", { name: "Equip" })
        .some((button) => (button as HTMLButtonElement).disabled)
    ).toBe(true)
    expect(screen.getByRole("button", { name: "Add stock" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Unequip" }))
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
    expect(screen.getByText("Canceled")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Select" })).toBeNull()
    expect(screen.getByText("Quick Shot")).toBeTruthy()
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
    fireEvent.click(screen.getByRole("tab", { name: "Powers" }))
    expect(screen.getByText("True Blessing of The Malefic Viper")).toBeTruthy()
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
    fireEvent.click(screen.getByText("Manage powers"))
    await flush()
    fireEvent.click(screen.getByRole("tab", { name: "Bloodlines" }))
    const add = screen
      .getAllByRole("button", { name: "Add" })
      .find((button) =>
        button.closest("div")?.textContent?.includes("New bloodline")
      )
    fireEvent.click(add!)
    await flush()
    expect(confirmSpy).toHaveBeenCalledWith(
      "New bloodline will replace Old active, Old archived (archived, inert). Continue?"
    )
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
    fireEvent.click(screen.getByText("Manage powers"))
    await flush()
    fireEvent.click(screen.getByRole("tab", { name: "Transcendent skills" }))
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
    fireEvent.click(screen.getByText("Manage powers"))
    await flush()
    fireEvent.click(screen.getByRole("tab", { name: "Transcendent skills" }))
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
    fireEvent.click(screen.getByText("Manage powers"))
    await flush()
    fireEvent.click(screen.getByRole("tab", { name: "Blessings" }))
    fireEvent.click(screen.getByText("Add"))
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
    const blessingSection = within(screen.getByLabelText("Blessing"))
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
    fireEvent.click(screen.getByText("Manage powers"))
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
    fireEvent.click(screen.getByText("Manage powers"))
    await flush()
    fireEvent.click(screen.getByRole("tab", { name: "Blessings" }))
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
    fireEvent.click(screen.getByRole("tab", { name: "Blessings" }))
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
    fireEvent.click(screen.getByRole("tab", { name: "Bloodlines" }))
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
    fireEvent.click(screen.getByRole("tab", { name: "Blessings" }))
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
    fireEvent.click(screen.getByRole("tab", { name: "Transcendent skills" }))
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

    const ownedItems = within(screen.getByLabelText("Owned items"))
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
        definitionId: "item-token",
        quantity: 1,
        version: 3,
        sourceNote: "used it up",
      },
    ])

    // The row disappears on reload; the archived catalog entry remains visible
    // only via the management sheet, not as owned stock.
    const after = within(screen.getByLabelText("Owned items"))
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
    fireEvent.click(screen.getByRole("tab", { name: "Powers" }))
    await flush()
    fireEvent.click(screen.getByText("Manage powers"))
    await flush()

    const sheetContent = screen
      .getByText("Character associations")
      .closest("div")!.parentElement!
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
    fireEvent.click(screen.getByRole("tab", { name: "Inventory" }))
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
    fireEvent.click(screen.getByRole("tab", { name: "Inventory" }))
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
    fireEvent.click(screen.getByText("Manage powers"))
    await flush()
    const sheetContent = screen
      .getByText("Character associations")
      .closest("div")!.parentElement!
    fireEvent.click(
      within(sheetContent).getByRole("tab", { name: "Equipment" })
    )
    await flush()
    fireEvent.change(
      within(sheetContent).getByLabelText("Equip position for Ring of Power"),
      { target: { value: "Ring 2" } }
    )
    await flush()
    fireEvent.click(within(sheetContent).getByRole("button", { name: "Equip" }))
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
    const ownedEquip = within(screen.getByLabelText("Owned equipment"))
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
    const ownedEquip = within(screen.getByLabelText("Owned equipment"))
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
    fireEvent.click(screen.getByText("Manage powers"))
    await flush()
    const sheetContent = screen
      .getByText("Character associations")
      .closest("div")!.parentElement!
    fireEvent.click(
      within(sheetContent).getByRole("tab", { name: "Equipment" })
    )
    await flush()

    // Zero owned stock: Equip is replaced by a disabled "Add stock first".
    const noStock = within(sheetContent).getByRole("button", {
      name: "Add stock first",
    }) as HTMLButtonElement
    expect(noStock.disabled).toBe(true)

    // Owned but unmet requirements: Equip is disabled and carries the reason.
    const unmet = within(sheetContent).getByRole("button", {
      name: "Equip",
    }) as HTMLButtonElement
    expect(unmet.disabled).toBe(true)
    expect(unmet.title).toBe("Requires level 40")

    // A linked-but-ineligible item is still removable (Remove is busy-gated only).
    const remove = within(sheetContent).getByRole("button", {
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

    fireEvent.click(screen.getByText("Manage powers"))
    await flush()
    const sheetContent = screen
      .getByText("Character associations")
      .closest("div")!.parentElement!
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
