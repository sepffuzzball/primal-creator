"use client"

import * as React from "react"
import { useParams } from "next/navigation"
import { toast } from "sonner"
import {
  ChevronRightIcon,
  DownloadIcon,
  ArchiveIcon,
  ArrowUpIcon,
  RotateCcwIcon,
  SparklesIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react"

import { cn } from "cn"

import {
  apiFetch,
  jsonInit,
  ATTRIBUTE_KEYS,
  type AttributeKey,
  type CatalogItem,
  type CatalogListResponse,
  type CharacterAssociationView,
  type CharacterDetail,
  type CharacterResponse,
  type AdvanceResponse,
  type AllocateResponse,
  type AssociationResponse,
  type ConsumeResponse,
  type ExportResponse,
  type EvolveResponse,
  type EvolutionOptionsResult,
  type Grade,
  type JournalDelta,
  type PortraitResponse,
  type PortraitView,
  type SkillResponse,
} from "@/lib/api"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button, buttonVariants } from "@/components/ui/button"
import { useAppShell } from "@/components/app-shell"
import { AllocationEditor } from "@/components/characters/allocation-editor"
import { TrackEvolutionDialog } from "@/components/characters/track-evolution-dialog"
import { Alert } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectLabel,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

function labelFor(key: AttributeKey): string {
  return key.charAt(0).toUpperCase() + key.slice(1)
}

// Race grade ladder, lowest to highest. Mirrors the server's grade order.
const GRADE_ORDER = ["G", "F", "E", "D", "C", "B", "A", "S"] as const

// House rule entry level required to evolve INTO each grade (source-verified).
const GRADE_ENTRY_LEVEL: Record<Grade, number> = {
  G: 0,
  F: 10,
  E: 25,
  D: 100,
  C: 200,
  B: 350,
  A: 500,
  S: 750,
}

// Inclusive upper level bound of each grade band (next entry - 1; S is open).
const GRADE_MAX_LEVEL: Record<Grade, number> = {
  G: 9,
  F: 24,
  E: 99,
  D: 199,
  C: 349,
  B: 499,
  A: 749,
  S: 999,
}

/**
 * The highest grade strictly above `current` whose level band contains `level`.
 * A grade qualifies only when the race level is within its published band and
 * has reached the band's entry level. Returns null when no higher grade is
 * reachable from the current level (e.g. already at S).
 */
function evolutionTarget(level: number, current: Grade): Grade | null {
  let best: Grade | null = null
  for (const grade of GRADE_ORDER) {
    if (GRADE_ORDER.indexOf(grade) <= GRADE_ORDER.indexOf(current)) continue
    if (level >= GRADE_ENTRY_LEVEL[grade] && level <= GRADE_MAX_LEVEL[grade]) {
      best = grade
    }
  }
  return best
}

function JournalPanel({ journal }: { journal: JournalDelta }) {
  return (
    <div className="flex flex-col gap-2 text-xs/relaxed">
      <div className="flex flex-wrap gap-1.5">
        <Badge variant="outline">
          {journal.track} {journal.levelBefore} {"->"} {journal.levelAfter}
        </Badge>
        <Badge variant="outline">
          Quarter {journal.quarterBefore} {"->"} {journal.quarterAfter}
        </Badge>
        <Badge variant="outline">
          Race level {journal.raceLevelBefore} {"->"} {journal.raceLevelAfter}
        </Badge>
        {journal.leveledUp ? <Badge>Level-up</Badge> : null}
      </div>
      {journal.award ? (
        <div className="rounded-lg border bg-input/20 p-2">
          <div className="font-medium">
            Award snapshotted (fixed + {journal.award.free} free points)
          </div>
          <div className="grid grid-cols-3 gap-x-2 gap-y-0.5 pt-1 text-muted-foreground">
            {ATTRIBUTE_KEYS.map((attr) => (
              <div key={attr} className="flex justify-between">
                <span className="capitalize">{labelFor(attr)}</span>
                <span className="tabular-nums">
                  {journal.award?.fixed[attr] ?? 0}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
        {journal.notes.map((note, i) => (
          <li key={i}>{note}</li>
        ))}
      </ul>
    </div>
  )
}

function MetaRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b py-1.5 text-xs/relaxed last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  )
}

function formatVector(
  v: Partial<Record<AttributeKey, number>> | undefined
): string {
  if (!v) return "0"
  const entries = ATTRIBUTE_KEYS.filter((key) => (v[key] ?? 0) !== 0)
  if (entries.length === 0) return "0"
  return entries.map((key) => `${key}:${v[key] ?? 0}`).join(", ")
}

function slotFor(item: CatalogItem): string | undefined {
  const slot = item.config?.slot
  return typeof slot === "string" && slot.length > 0 ? slot : undefined
}

function bonusFor(item: CatalogItem): string {
  const bonus = item.config?.bonus
  return formatVector(
    bonus as Partial<Record<AttributeKey, number>> | undefined
  )
}

function titleFlatFor(item: CatalogItem): string {
  const flat = item.config?.flat
  return formatVector(flat as Partial<Record<AttributeKey, number>> | undefined)
}

function titlePercentFor(item: CatalogItem): string {
  const pct = item.config?.percentBasisPoints
  return formatVector(pct as Partial<Record<AttributeKey, number>> | undefined)
}

function upgradeGroupFor(item: CatalogItem): string | undefined {
  const group = item.config?.upgradeGroup
  return typeof group === "string" && group.length > 0 ? group : undefined
}

function consumableTypeFor(item: CatalogItem): "permanent" | "temporary" {
  return item.config?.type === "temporary" ? "temporary" : "permanent"
}

function consumableAmountFor(item: CatalogItem): string {
  return formatVector(
    item.config?.amount as Partial<Record<AttributeKey, number>> | undefined
  )
}

function consumableDurationFor(item: CatalogItem): number | undefined {
  const d = item.config?.durationQuarters
  return typeof d === "number" && Number.isFinite(d) ? d : undefined
}

/**
 * Right-hand panel for attaching/removing titles and equipment. It lists the
 * real catalog entries and calls the associations endpoint with the current
 * character version. Equipment is equipped directly onto the character - it is
 * inventory claim by itself. Equipment actions require owned stock. The caps noted here
 * are house assumptions (20% per attribute / 15% overall), documented in
 * docs/rules/assumptions.md.
 */
function AssociationSheet({
  open,
  onOpenChange,
  character,
  titles,
  equipment,
  consumables,
  blessings,
  bloodlines,
  transcendentSkills,
  loading,
  busy,
  consumeBusy,
  onAdd,
  onRemove,
  onConsume,
  onPowerAdd,
  onPowerRemove,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  character: CharacterDetail
  titles: CatalogItem[]
  equipment: CatalogItem[]
  consumables: CatalogItem[]
  blessings: CatalogItem[]
  bloodlines: CatalogItem[]
  transcendentSkills: CatalogItem[]
  loading: boolean
  busy: boolean
  consumeBusy: boolean
  onAdd: (kind: "title" | "equipment", definitionId: string) => void
  onRemove: (kind: "title" | "equipment", definitionId: string) => void
  onConsume: (definitionId: string) => void
  onPowerAdd: (
    kind: "blessing" | "bloodline" | "transcendent",
    definitionId: string
  ) => void
  onPowerRemove: (
    kind: "blessing" | "bloodline" | "transcendent",
    definitionId: string
  ) => void
}) {
  const linked = new Map(character.associations.map((a) => [a.definitionId, a]))
  const equipmentStatusById = new Map(
    (character.status?.equipment.items ?? []).map((item) => [item.id, item])
  )
  const ownedQuantity = (definitionId: string) =>
    character.inventory?.find(
      (row) => row.definitionId === definitionId && !row.archived
    )?.quantity ?? 0

  // Archived linked entries are NOT in the active catalog lists (listCatalog
  // filters archived:false), so they would otherwise disappear and become
  // impossible to remove. Keep them visible with a Remove button.
  const titleIds = new Set(titles.map((t) => t.id))
  const equipmentIds = new Set(equipment.map((e) => e.id))
  const archivedLinkedTitles = character.associations.filter(
    (a) =>
      a.kind === "title" &&
      a.definitionArchived &&
      !titleIds.has(a.definitionId)
  )
  const archivedLinkedEquipment = character.associations.filter(
    (a) =>
      a.kind === "equipment" &&
      a.definitionArchived &&
      !equipmentIds.has(a.definitionId)
  )

  // Archived linked transcendent skills are NOT in the active-only catalog list
  // (listCatalog filters archived:false), so they would otherwise disappear and
  // become impossible to remove. Keep them visible with a Remove button. Active
  // linked transcendent skills missing from the catalog (e.g. a failed catalog
  // fetch) are kept visible too so an existing link can always be removed
  // without depending on the catalog list.
  const transcendentOptions: CatalogItem[] = [
    ...transcendentSkills,
    ...character.associations
      .filter(
        (a) =>
          a.kind === "transcendent" &&
          !transcendentSkills.some((c) => c.id === a.definitionId)
      )
      .map(
        (a) =>
          ({
            id: a.definitionId,
            name: a.name,
            description: null,
            provenance: a.provenance ?? "house",
            grade: a.grade ?? null,
            archived: a.definitionArchived,
            config: {},
          }) as CatalogItem
      ),
  ]

  function archivedLinkedRow(a: CharacterAssociationView) {
    return (
      <div
        key={a.id}
        className="flex items-center justify-between gap-3 rounded-lg border bg-input/20 p-2"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-medium">{a.name}</span>
            <Badge variant="outline">Archived</Badge>
          </div>
          <div className="text-[0.6875rem] text-muted-foreground">
            {a.kind === "equipment"
              ? `Slot: ${a.slot ?? "unspecified"}`
              : a.upgradeGroup
                ? `Upgrade group: ${a.upgradeGroup}`
                : "No upgrade group"}{" "}
            - linked but archived, no longer contributing.
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() =>
            onRemove(a.kind as "title" | "equipment", a.definitionId)
          }
        >
          Remove
        </Button>
      </div>
    )
  }

  function equipmentRow(item: CatalogItem) {
    const isLinked = linked.has(item.id)
    const status = equipmentStatusById.get(item.id)
    return (
      <div
        key={item.id}
        className="flex items-center justify-between gap-3 rounded-lg border bg-input/20 p-2"
      >
        <div className="min-w-0">
          <div className="truncate font-medium">{item.name}</div>
          <div className="text-[0.6875rem] text-muted-foreground">
            Slot: {slotFor(item) ?? "unspecified"} - Bonus: {bonusFor(item)}
          </div>
          {status ? (
            <div className="mt-1 text-[0.6875rem] text-muted-foreground">
              <span className="tabular-nums">
                Requested: {formatVector(status.requested)}
              </span>{" "}
              /{" "}
              <span className="tabular-nums">
                Effective: {formatVector(status.applied)}
              </span>{" "}
              /{" "}
              <span className="tabular-nums">
                Suppressed: {formatVector(status.suppressed)}
              </span>
            </div>
          ) : null}
        </div>
        {isLinked ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onRemove("equipment", item.id)}
          >
            Remove
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onAdd("equipment", item.id)}
          >
            {ownedQuantity(item.id) > 0 ? "Equip" : "Add stock first"}
          </Button>
        )}
      </div>
    )
  }

  function titleRow(item: CatalogItem) {
    const isLinked = linked.has(item.id)
    const group = upgradeGroupFor(item)
    return (
      <div
        key={item.id}
        className="flex items-center justify-between gap-3 rounded-lg border bg-input/20 p-2"
      >
        <div className="min-w-0">
          <div className="truncate font-medium">{item.name}</div>
          <div className="text-[0.6875rem] text-muted-foreground">
            Flat: {titleFlatFor(item)} - Percent: {titlePercentFor(item)}
            {group ? <> - Upgrade group: {group}</> : null}
          </div>
          {isLinked && group ? (
            <div className="text-[0.6875rem] text-muted-foreground">
              Replaces any title in group &quot;{group}&quot; (superseded tiers
              never stack).
            </div>
          ) : null}
        </div>
        {isLinked ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onRemove("title", item.id)}
          >
            Remove
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onAdd("title", item.id)}
          >
            Add
          </Button>
        )}
      </div>
    )
  }

  function consumableRow(item: CatalogItem) {
    const permanent = consumableTypeFor(item) === "permanent"
    return (
      <div
        key={item.id}
        className="flex items-center justify-between gap-3 rounded-lg border bg-input/20 p-2"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-medium">{item.name}</span>
            <Badge variant={permanent ? "default" : "outline"}>
              {permanent ? "Permanent" : "Temporary"}
            </Badge>
          </div>
          <div className="text-[0.6875rem] text-muted-foreground">
            Amount: {consumableAmountFor(item) || "0"}
            {permanent
              ? null
              : ` - Duration: ${consumableDurationFor(item) ?? "?"} quarter(s)`}
          </div>
          <div className="text-[0.6875rem] text-muted-foreground">
            Provenance: {item.provenance}
          </div>
          {permanent &&
          character.permanentConsumableCap &&
          character.permanentConsumableRemaining ? (
            <div className="text-[0.6875rem] text-muted-foreground">
              Cap: {formatVector(character.permanentConsumableCap)} - Remaining:{" "}
              {formatVector(character.permanentConsumableRemaining)}
            </div>
          ) : null}
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={
            consumeBusy ||
            !character.inventory?.some(
              (row) =>
                row.definitionId === item.id &&
                row.quantity > 0 &&
                !row.archived
            )
          }
          onClick={() => onConsume(item.id)}
        >
          Consume
        </Button>
      </div>
    )
  }

  const permanentHistory = (character.state.permanentGains ?? []).filter(
    (g) => (g as { kind?: string }).kind === "consumable"
  ) as Array<{
    id: string
    source: string
    vector?: Partial<Record<AttributeKey, number>>
    requested?: Partial<Record<AttributeKey, number>>
    capRemainingAfter?: Partial<Record<AttributeKey, number>>
    gradeAtApplication?: string
    raceLevelAtApplication?: number
    appliedAt?: string | number
  }>

  // Only show temporary consumable effects that are still active: an effect with
  // a recorded `expiresAt` is active while it is strictly greater than the
  // current turn; effects without an expiry stay active indefinitely.
  const currentTurn = character.state.turn
  const activeTempEffects = (character.state.activeEffects ?? []).filter(
    (e) =>
      (e as { phase?: string }).phase === "temporary" &&
      (e as { source?: string }).source === "consumable" &&
      ((e as { expiresAt?: number }).expiresAt == null ||
        (e as { expiresAt?: number }).expiresAt! > currentTurn)
  ) as Array<{
    id: string
    source: string
    provenance: string
    expiresAt?: number
    amount?: Partial<Record<AttributeKey, number>>
  }>

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex flex-col gap-4">
        <SheetHeader>
          <SheetTitle>Character associations</SheetTitle>
          <SheetDescription>
            Manage titles, equipment, consumables, blessings, and bloodlines
            directly onto this character. This is direct application, not an
            Equipment and consumables require owned stock. Use the Inventory tab
            to record manual bookkeeping before equipping or consuming. Source
            notes are not verified loot or crafting records.
          </SheetDescription>
        </SheetHeader>

        <Tabs defaultValue="titles">
          <TabsList variant="line">
            <TabsTrigger value="titles">Titles</TabsTrigger>
            <TabsTrigger value="equipment">Equipment</TabsTrigger>
            <TabsTrigger value="consumables">Consumables</TabsTrigger>
            <TabsTrigger value="blessings">Blessings</TabsTrigger>
            <TabsTrigger value="bloodlines">Bloodlines</TabsTrigger>
            <TabsTrigger value="transcendent">Transcendent skills</TabsTrigger>
          </TabsList>

          <TabsContent value="titles" className="pt-3">
            {loading ? (
              <p className="text-xs text-muted-foreground">Loading titles...</p>
            ) : titles.length === 0 && archivedLinkedTitles.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No titles in the catalog yet.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {titles.map(titleRow)}
                {archivedLinkedTitles.map(archivedLinkedRow)}
              </div>
            )}
          </TabsContent>

          <TabsContent value="equipment" className="pt-3">
            {loading ? (
              <p className="text-xs text-muted-foreground">
                Loading equipment...
              </p>
            ) : equipment.length === 0 &&
              archivedLinkedEquipment.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No equipment in the catalog yet.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {equipment.map(equipmentRow)}
                {archivedLinkedEquipment.map(archivedLinkedRow)}
              </div>
            )}
            <p className="mt-3 text-[0.6875rem] text-muted-foreground">
              Equipment bonuses are capped (house assumption): 20% of the
              pre-equipment value per attribute (aggregate, not per item) and
              15% of the total across all attributes. Suppressed values above
              are what these caps reject.
            </p>
          </TabsContent>

          <TabsContent value="consumables" className="pt-3">
            {loading ? (
              <p className="text-xs text-muted-foreground">
                Loading consumables...
              </p>
            ) : consumables.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No consumables in the catalog yet.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {consumables.map(consumableRow)}
              </div>
            )}

            <Separator className="my-3" />

            <div className="flex flex-col gap-2">
              <h4 className="text-xs font-medium">Active temporary effects</h4>
              {activeTempEffects.length === 0 ? (
                <p className="text-[0.6875rem] text-muted-foreground">
                  No active temporary consumable effects.
                </p>
              ) : (
                activeTempEffects.map((effect) => (
                  <div
                    key={effect.id}
                    className="rounded-lg border bg-input/20 p-2 text-xs/relaxed"
                  >
                    <div className="font-medium">
                      {formatVector(effect.amount) || "0"}
                    </div>
                    <div className="text-[0.6875rem] text-muted-foreground">
                      Expires at turn {effect.expiresAt ?? "?"} (
                      {effect.provenance})
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="mt-3 flex flex-col gap-2">
              <h4 className="text-xs font-medium">Permanent gains applied</h4>
              {permanentHistory.length === 0 ? (
                <p className="text-[0.6875rem] text-muted-foreground">
                  No permanent consumable gains recorded yet.
                </p>
              ) : (
                permanentHistory.map((gain) => (
                  <div
                    key={gain.id}
                    className="rounded-lg border bg-input/20 p-2 text-xs/relaxed"
                  >
                    <div className="font-medium">{gain.source}</div>
                    <div className="text-[0.6875rem] text-muted-foreground">
                      Applied: {formatVector(gain.vector)} - Requested:{" "}
                      {formatVector(gain.requested)}
                      {gain.gradeAtApplication
                        ? ` - Grade at application: ${gain.gradeAtApplication}`
                        : ""}
                      {typeof gain.raceLevelAtApplication === "number"
                        ? ` - Race level: ${gain.raceLevelAtApplication}`
                        : ""}
                    </div>
                    <div className="text-[0.6875rem] text-muted-foreground">
                      Cap remaining after:{" "}
                      {formatVector(gain.capRemainingAfter)}
                    </div>
                  </div>
                ))
              )}
            </div>
          </TabsContent>
          {(["blessing", "bloodline"] as const).map((kind) => {
            const catalog = kind === "blessing" ? blessings : bloodlines
            const linkedPower = character.associations.filter(
              (a) => a.kind === kind
            )
            const options = [
              ...catalog,
              ...linkedPower
                .filter(
                  (a) =>
                    a.definitionArchived &&
                    !catalog.some((c) => c.id === a.definitionId)
                )
                .map(
                  (a) =>
                    ({
                      id: a.definitionId,
                      name: a.name,
                      description: null,
                      provenance: a.provenance ?? "house",
                      grade: a.grade ?? null,
                      archived: true,
                      config: {},
                    }) as CatalogItem
                ),
            ]
            return (
              <TabsContent
                key={kind}
                value={kind === "blessing" ? "blessings" : "bloodlines"}
                className="pt-3"
              >
                {loading ? (
                  <p className="text-xs text-muted-foreground">
                    Loading {kind}s...
                  </p>
                ) : options.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No {kind}s in the catalog yet.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {options.map((item) => {
                      const association = linkedPower.find(
                        (a) => a.definitionId === item.id
                      )
                      const patron = item.config?.patronGodStableId
                      const tier = item.config?.tier
                      return (
                        <div
                          key={item.id}
                          className="flex items-center justify-between gap-3 rounded-lg border bg-input/20 p-2"
                        >
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-medium">{item.name}</span>
                              {item.grade ? (
                                <Badge variant="outline">{item.grade}</Badge>
                              ) : null}
                              {item.archived ? (
                                <Badge variant="outline">
                                  Archived - inert
                                </Badge>
                              ) : null}
                            </div>
                            <div className="text-[0.6875rem] text-muted-foreground">
                              Provenance: {item.provenance}
                              {typeof tier === "string"
                                ? ` - Tier: ${tier}`
                                : ""}
                              {typeof patron === "string"
                                ? ` - Patron: ${patron}`
                                : ""}
                            </div>
                            {item.description ? (
                              <p className="text-xs text-muted-foreground">
                                {item.description}
                              </p>
                            ) : null}
                          </div>
                          {association ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() => onPowerRemove(kind, item.id)}
                            >
                              Remove
                            </Button>
                          ) : item.archived ? null : (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() => onPowerAdd(kind, item.id)}
                            >
                              Add
                            </Button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </TabsContent>
            )
          })}
          <TabsContent value="transcendent" className="pt-3">
            {loading ? (
              <p className="text-xs text-muted-foreground">
                Loading transcendent skills...
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {transcendentOptions.map((item) => {
                  const association = character.associations.find(
                    (a) =>
                      a.kind === "transcendent" && a.definitionId === item.id
                  )
                  const cost = item.config?.costDescription
                  const acquisition = item.config?.acquisitionNotes
                  return (
                    <div
                      key={item.id}
                      className="flex items-center justify-between gap-3 rounded-lg border bg-input/20 p-2"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5 font-medium">
                          {item.name}
                          {item.grade ? (
                            <Badge variant="outline">{item.grade}</Badge>
                          ) : null}
                          {item.archived ? (
                            <Badge variant="outline">Archived</Badge>
                          ) : null}
                        </div>
                        <p className="text-[0.6875rem] text-muted-foreground">
                          Provenance: {item.provenance}
                          {item.sourceUrl ? (
                            <>
                              {" "}
                              -{" "}
                              <a
                                className="underline"
                                href={item.sourceUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Source
                              </a>
                            </>
                          ) : (
                            ""
                          )}
                        </p>
                        {item.description ? (
                          <p className="text-xs text-muted-foreground">
                            {item.description}
                          </p>
                        ) : null}
                        {typeof cost === "string" ? (
                          <p className="text-xs text-muted-foreground">
                            Cost description (reference only): {cost}
                          </p>
                        ) : null}
                        {typeof acquisition === "string" ? (
                          <p className="text-xs text-muted-foreground">
                            Acquisition notes: {acquisition}
                          </p>
                        ) : null}
                      </div>
                      {association ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => onPowerRemove("transcendent", item.id)}
                        >
                          Remove
                        </Button>
                      ) : item.archived ? null : (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => onPowerAdd("transcendent", item.id)}
                        >
                          Attach
                        </Button>
                      )}
                    </div>
                  )
                })}
                {transcendentOptions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No transcendent skills in the catalog.
                  </p>
                ) : null}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}

export function CharacterDetail({
  onNameChange,
}: {
  onNameChange?: (name: string) => void
}) {
  const params = useParams<{ id: string }>()
  const id = params.id
  const { user } = useAppShell()
  const isAdmin = user?.isAdmin ?? false

  const [character, setCharacter] = React.useState<CharacterDetail | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [activeTab, setActiveTab] = React.useState("overview")
  const [journal, setJournal] = React.useState<JournalDelta | null>(null)
  const [journalOpen, setJournalOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [events, setEvents] = React.useState<ExportResponse["events"] | null>(
    null
  )
  const [notes, setNotes] = React.useState<{
    name: string
    description: string
  }>({
    name: "",
    description: "",
  })
  const [savingNotes, setSavingNotes] = React.useState(false)
  const [evolveOpen, setEvolveOpen] = React.useState(false)
  const [evolveBusy, setEvolveBusy] = React.useState(false)
  const [evolveError, setEvolveError] = React.useState<string | null>(null)
  const [evolutionOptions, setEvolutionOptions] =
    React.useState<EvolutionOptionsResult | null>(null)
  const [evolutionLoading, setEvolutionLoading] = React.useState(false)
  const [selectedOptionId, setSelectedOptionId] = React.useState("")
  const [evolutionOptionMode, setEvolutionOptionMode] = React.useState<
    "option" | "legacy"
  >("option")
  const [evolveReason, setEvolveReason] = React.useState("")
  const [trackEvolveTrack, setTrackEvolveTrack] = React.useState<
    "class" | "profession" | null
  >(null)
  const [associationsOpen, setAssociationsOpen] = React.useState(false)
  const [titlesCatalog, setTitlesCatalog] = React.useState<CatalogItem[]>([])
  const [equipmentCatalog, setEquipmentCatalog] = React.useState<CatalogItem[]>(
    []
  )
  const [consumablesCatalog, setConsumablesCatalog] = React.useState<
    CatalogItem[]
  >([])
  const [blessingsCatalog, setBlessingsCatalog] = React.useState<CatalogItem[]>(
    []
  )
  const [bloodlinesCatalog, setBloodlinesCatalog] = React.useState<
    CatalogItem[]
  >([])
  const [transcendentCatalog, setTranscendentCatalog] = React.useState<
    CatalogItem[]
  >([])
  const [catalogLoading, setCatalogLoading] = React.useState(false)
  const [assocBusy, setAssocBusy] = React.useState(false)
  const [consumeBusy, setConsumeBusy] = React.useState(false)
  const [consumeConfirm, setConsumeConfirm] =
    React.useState<CatalogItem | null>(null)
  const [skillsCatalog, setSkillsCatalog] = React.useState<CatalogItem[]>([])
  const [skillBusy, setSkillBusy] = React.useState(false)
  const [selectConfirm, setSelectConfirm] = React.useState<{
    offerId: string
    definitionId: string
    name: string
  } | null>(null)
  const [grantOpen, setGrantOpen] = React.useState(false)
  const [grantSkillId, setGrantSkillId] = React.useState("")
  const [grantReason, setGrantReason] = React.useState("")
  const [portrait, setPortrait] = React.useState<PortraitView | null>(null)
  const [portraitBusy, setPortraitBusy] = React.useState(false)
  const [removePortraitOpen, setRemovePortraitOpen] = React.useState(false)
  const [inventoryAddOpen, setInventoryAddOpen] = React.useState(false)
  const [inventoryRemoveItem, setInventoryRemoveItem] = React.useState<
    NonNullable<CharacterDetail["inventory"]>[number] | null
  >(null)
  const [inventoryDefinitionId, setInventoryDefinitionId] = React.useState("")
  const [inventoryQuantity, setInventoryQuantity] = React.useState("")
  const [inventorySourceNote, setInventorySourceNote] = React.useState("")
  const [inventoryBusy, setInventoryBusy] = React.useState(false)
  const [inventoryError, setInventoryError] = React.useState<string | null>(
    null
  )

  // Last character name reported upstream to the breadcrumb. Used to fire
  // onNameChange only when the successfully fetched name actually changes,
  // never on every render.
  const lastReportedName = React.useRef<string | null>(null)

  const reload = React.useCallback(async () => {
    if (!id) return
    try {
      const res = await apiFetch<CharacterResponse>(`/api/characters/${id}`)
      setCharacter(res.character)
      setNotes({
        name: res.character.name,
        description: res.character.description ?? "",
      })
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load character.")
    } finally {
      setLoading(false)
    }
  }, [id])

  const submitInventory = async (
    operation: "add" | "remove",
    definitionId: string,
    quantity: number,
    sourceNote: string,
    onSuccess: () => void
  ) => {
    if (!character) return
    setInventoryBusy(true)
    setInventoryError(null)
    try {
      await apiFetch(`/api/characters/${character.id}/inventory`, {
        ...jsonInit("POST", {
          operation,
          definitionId,
          quantity,
          version: character.version,
          sourceNote: sourceNote.trim(),
        }),
      })
      onSuccess()
      await reload()
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Inventory update failed."
      setInventoryError(message)
      toast.error(message)
    } finally {
      setInventoryBusy(false)
    }
  }

  const loadPortrait = React.useCallback(async () => {
    if (!id) return
    try {
      const res = await apiFetch<PortraitResponse>(
        `/api/characters/${id}/portrait`
      )
      setPortrait(res.portrait)
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to load portrait."
      )
    }
  }, [id])

  const uploadPortrait = React.useCallback(
    async (file: File) => {
      if (!id) return
      setPortraitBusy(true)
      try {
        const form = new FormData()
        form.append("file", file)
        await apiFetch<PortraitView>(`/api/characters/${id}/portrait`, {
          method: "POST",
          body: form,
        })
        toast.success("Portrait uploaded.")
        // The upload bumped the character version, so reload the FULL character
        // detail (not just the portrait) to keep `character.version` current for
        // progression/actions, and refresh the portrait bytes too.
        await Promise.all([reload(), loadPortrait()])
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Portrait upload failed."
        )
      } finally {
        setPortraitBusy(false)
      }
    },
    [id, loadPortrait, reload]
  )

  const removePortrait = React.useCallback(async () => {
    if (!id) return
    setRemovePortraitOpen(false)
    setPortraitBusy(true)
    try {
      await apiFetch<PortraitView>(`/api/characters/${id}/portrait`, {
        method: "DELETE",
      })
      toast.success("Portrait removed.")
      // Removing a portrait bumps the version too, so reload the full detail as
      // well as the (now empty) portrait to keep the version current.
      await Promise.all([reload(), loadPortrait()])
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to remove portrait."
      )
    } finally {
      setPortraitBusy(false)
    }
  }, [id, loadPortrait, reload])

  function onPortraitFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    if (file.size > 4 * 1024 * 1024) {
      toast.error("Portrait must be 4 MiB or smaller.")
      return
    }
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      toast.error("Portrait must be a PNG, JPEG or WebP image.")
      return
    }
    void uploadPortrait(file)
    event.target.value = ""
  }

  React.useEffect(() => {
    if (!id) return
    let active = true
    apiFetch<PortraitResponse>(`/api/characters/${id}/portrait`)
      .then((res) => {
        if (active) setPortrait(res.portrait)
      })
      .catch((err) => {
        if (active) {
          toast.error(
            err instanceof Error ? err.message : "Failed to load portrait."
          )
        }
      })
    return () => {
      active = false
    }
  }, [id])

  React.useEffect(() => {
    if (!id) return
    let active = true
    apiFetch<CharacterResponse>(`/api/characters/${id}`)
      .then((res) => {
        if (!active) return
        setCharacter(res.character)
        setNotes({
          name: res.character.name,
          description: res.character.description ?? "",
        })
        setError(null)
      })
      .catch((err) => {
        if (!active) return
        setError(
          err instanceof Error ? err.message : "Failed to load character."
        )
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [id])

  // Report the character name upstream (to the breadcrumb) only when the
  // successfully fetched name changes, not on every render. The ref guard
  // keeps onNameChange from firing again for the same name (e.g. Strict Mode's
  // double-invoked effects, or a reload that returns an unchanged name).
  React.useEffect(() => {
    const name = character?.name ?? null
    if (name === null) return
    if (lastReportedName.current === name) return
    lastReportedName.current = name
    onNameChange?.(name)
  }, [character?.name, onNameChange])

  // Load the immutable journal when the History tab is first opened.
  React.useEffect(() => {
    if (activeTab === "history" && !events && id) {
      apiFetch<ExportResponse>(`/api/characters/${id}/export`)
        .then((res) => setEvents(res.events))
        .catch((err) =>
          toast.error(
            err instanceof Error ? err.message : "Failed to load history."
          )
        )
    }
  }, [activeTab, events, id])

  const advance = React.useCallback(
    async (track: "class" | "profession") => {
      if (!character) return
      setBusy(true)
      setError(null)
      try {
        const res = await apiFetch<AdvanceResponse>(
          `/api/characters/${character.id}/advance`,
          {
            ...jsonInit("POST", { track, version: character.version }),
          }
        )
        setJournal(res.journal)
        setJournalOpen(true)
        await reload()
      } catch (err) {
        setError(err instanceof Error ? err.message : "Advance failed.")
      } finally {
        setBusy(false)
      }
    },
    [character, reload]
  )

  const allocate = React.useCallback(
    async (allocation: Partial<Record<AttributeKey, number>>) => {
      if (!character) return
      setBusy(true)
      setError(null)
      try {
        await apiFetch<AllocateResponse>(
          `/api/characters/${character.id}/allocate`,
          {
            ...jsonInit("POST", {
              allocation,
              version: character.version,
            }),
          }
        )
        await reload()
      } catch (err) {
        setError(err instanceof Error ? err.message : "Allocation failed.")
      } finally {
        setBusy(false)
      }
    },
    [character, reload]
  )

  const loadEvolutionOptions = React.useCallback(async () => {
    if (!character) return
    setEvolutionLoading(true)
    setEvolveError(null)
    try {
      const res = await apiFetch<EvolutionOptionsResult>(
        `/api/characters/${character.id}/evolutions`
      )
      setEvolutionOptions(res)
      // Default to the first option a user could take (no manual review gate);
      // otherwise prefer the first mechanically-eligible option. The client can
      // still change the selection; the server re-validates on submit.
      const firstSelectable = res.options.find(
        (o) => o.eligible && (isAdmin ? true : !o.manualReview)
      )
      if (firstSelectable) {
        setSelectedOptionId(firstSelectable.id)
        setEvolutionOptionMode("option")
      } else if (res.legacyAvailable) {
        setEvolutionOptionMode("legacy")
      } else {
        setSelectedOptionId(res.options[0]?.id ?? "")
        setEvolutionOptionMode("option")
      }
    } catch (err) {
      setEvolveError(
        err instanceof Error ? err.message : "Failed to load evolution options."
      )
      // Leave options UNKNOWN (null) rather than claiming a legacy fallback is
      // available: on a failed fetch no option list is trustworthy, so the UI
      // must not show the grade-only fallback or enable the action.
      setEvolutionOptions(null)
    } finally {
      setEvolutionLoading(false)
    }
  }, [character, isAdmin])

  const submitEvolution = React.useCallback(async () => {
    if (!character) return
    setEvolveBusy(true)
    setEvolveError(null)
    try {
      let body: {
        version: number
        grade?: Grade
        optionId?: string
        reason?: string
      }
      if (evolutionOptionMode === "legacy") {
        const fallbackGrade = evolutionTarget(
          character.state.race.level,
          character.state.race.grade
        )
        if (!fallbackGrade) {
          setEvolveError("No higher race grade reached at this level yet.")
          setEvolveBusy(false)
          return
        }
        body = { grade: fallbackGrade, version: character.version }
      } else {
        body = {
          optionId: selectedOptionId,
          version: character.version,
          ...(evolveReason.trim() ? { reason: evolveReason.trim() } : {}),
        }
      }
      const res = await apiFetch<EvolveResponse>(
        `/api/characters/${character.id}/evolve`,
        { ...jsonInit("POST", body) }
      )
      setEvolveOpen(false)
      toast.success(`Evolved race grade to ${res.journal.to}.`)
      await reload()
    } catch (err) {
      setEvolveError(err instanceof Error ? err.message : "Evolution failed.")
    } finally {
      setEvolveBusy(false)
    }
  }, [character, evolutionOptionMode, selectedOptionId, evolveReason, reload])

  const archive = React.useCallback(async () => {
    if (!character) return
    setBusy(true)
    try {
      await apiFetch(`/api/characters/${character.id}`, { method: "DELETE" })
      toast.success(`Archived "${character.name}".`)
      await reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Archive failed.")
    } finally {
      setBusy(false)
    }
  }, [character, reload])

  const restore = React.useCallback(async () => {
    if (!character) return
    setBusy(true)
    try {
      await apiFetch<CharacterResponse>(`/api/characters/${character.id}`, {
        ...jsonInit("PATCH", { archived: false }),
      })
      toast.success(`Restored "${character.name}".`)
      await reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Restore failed.")
    } finally {
      setBusy(false)
    }
  }, [character, reload])

  const saveNotes = React.useCallback(async () => {
    if (!character) return
    setSavingNotes(true)
    setError(null)
    try {
      await apiFetch<CharacterResponse>(`/api/characters/${character.id}`, {
        ...jsonInit("PATCH", {
          name: notes.name,
          description: notes.description,
          version: character.version,
        }),
      })
      toast.success("Saved.")
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.")
    } finally {
      setSavingNotes(false)
    }
  }, [character, notes, reload])

  const exportCharacter = React.useCallback(async () => {
    if (!character) return
    try {
      const res = await fetch(`/api/characters/${character.id}/export`)
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: { message?: string }
        } | null
        throw new Error(data?.error?.message ?? "Export failed.")
      }
      const data = await res.json()
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `${character.name.replace(/[^a-z0-9\-_ ]+/gi, "").trim() || "character"}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed.")
    }
  }, [character])

  const loadCatalog = React.useCallback(
    async (
      kind:
        | "titles"
        | "equipment"
        | "consumables"
        | "blessings"
        | "bloodlines"
        | "transcendent_skills"
    ) => {
      setCatalogLoading(true)
      try {
        const res = await apiFetch<CatalogListResponse>(`/api/catalog/${kind}`)
        if (kind === "titles") setTitlesCatalog(res.items)
        else if (kind === "equipment") setEquipmentCatalog(res.items)
        else if (kind === "consumables") setConsumablesCatalog(res.items)
        else if (kind === "blessings") setBlessingsCatalog(res.items)
        else if (kind === "bloodlines") setBloodlinesCatalog(res.items)
        else setTranscendentCatalog(res.items)
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to load catalog."
        )
      } finally {
        setCatalogLoading(false)
      }
    },
    []
  )

  const openAssociations = React.useCallback(() => {
    setAssociationsOpen(true)
    if (titlesCatalog.length === 0) void loadCatalog("titles")
    if (equipmentCatalog.length === 0) void loadCatalog("equipment")
    if (consumablesCatalog.length === 0) void loadCatalog("consumables")
    if (blessingsCatalog.length === 0) void loadCatalog("blessings")
    if (bloodlinesCatalog.length === 0) void loadCatalog("bloodlines")
    if (transcendentCatalog.length === 0)
      void loadCatalog("transcendent_skills")
  }, [
    titlesCatalog.length,
    equipmentCatalog.length,
    consumablesCatalog.length,
    blessingsCatalog.length,
    bloodlinesCatalog.length,
    transcendentCatalog.length,
    loadCatalog,
  ])

  const addAssociation = React.useCallback(
    async (
      kind: "title" | "equipment" | "blessing" | "bloodline" | "transcendent",
      definitionId: string
    ) => {
      if (!character) return
      setAssocBusy(true)
      setError(null)
      try {
        await apiFetch<AssociationResponse>(
          `/api/characters/${character.id}/associations`,
          {
            ...jsonInit("POST", {
              kind,
              definitionId,
              operation: "add",
              version: character.version,
            }),
          }
        )
        await reload()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to attach.")
      } finally {
        setAssocBusy(false)
      }
    },
    [character, reload]
  )

  const removeAssociation = React.useCallback(
    async (
      kind: "title" | "equipment" | "blessing" | "bloodline" | "transcendent",
      definitionId: string
    ) => {
      if (!character) return
      setAssocBusy(true)
      setError(null)
      try {
        await apiFetch<AssociationResponse>(
          `/api/characters/${character.id}/associations`,
          {
            ...jsonInit("POST", {
              kind,
              definitionId,
              operation: "remove",
              version: character.version,
            }),
          }
        )
        await reload()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to remove.")
      } finally {
        setAssocBusy(false)
      }
    },
    [character, reload]
  )

  const doConsume = React.useCallback(
    async (definitionId: string, name?: string) => {
      if (!character) return
      setConsumeBusy(true)
      setError(null)
      try {
        await apiFetch<ConsumeResponse>(
          `/api/characters/${character.id}/consume`,
          {
            ...jsonInit("POST", {
              definitionId,
              version: character.version,
            }),
          }
        )
        toast.success(`Consumed "${name ?? "consumable"}".`)
        await reload()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Consume failed.")
      } finally {
        setConsumeBusy(false)
      }
    },
    [character, reload]
  )

  const requestConsume = React.useCallback(
    (item: CatalogItem) => {
      // Temporary effects are immediate; permanent gains cannot be undone, so
      // they first require confirmation.
      if (consumableTypeFor(item) === "permanent") {
        setConsumeConfirm(item)
      } else {
        void doConsume(item.id, item.name)
      }
    },
    [doConsume]
  )

  const confirmConsume = React.useCallback(async () => {
    if (!consumeConfirm) return
    const item = consumeConfirm
    setConsumeConfirm(null)
    await doConsume(item.id, item.name)
  }, [consumeConfirm, doConsume])

  const selectSkill = React.useCallback(
    async (offerId: string, definitionId: string) => {
      if (!character) return
      setSkillBusy(true)
      setError(null)
      try {
        await apiFetch<SkillResponse>(
          `/api/characters/${character.id}/skills`,
          {
            ...jsonInit("POST", {
              operation: "select",
              offerId,
              definitionId,
              version: character.version,
            }),
          }
        )
        setSelectConfirm(null)
        toast.success("Skill selected.")
        await reload()
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Skill selection failed."
        )
      } finally {
        setSkillBusy(false)
      }
    },
    [character, reload]
  )

  const grantSkill = React.useCallback(async () => {
    if (!character || !grantSkillId || !grantReason.trim()) return
    setSkillBusy(true)
    setError(null)
    try {
      await apiFetch<SkillResponse>(`/api/characters/${character.id}/skills`, {
        ...jsonInit("POST", {
          operation: "grant",
          definitionId: grantSkillId,
          version: character.version,
          reason: grantReason.trim(),
        }),
      })
      setGrantOpen(false)
      setGrantSkillId("")
      setGrantReason("")
      toast.success("Skill granted.")
      await reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Skill grant failed.")
    } finally {
      setSkillBusy(false)
    }
  }, [character, grantSkillId, grantReason, reload])

  // Load the skills catalog when the Skills tab is opened by an admin (needed for
  // the manual grant). It is only required for admins; owners just select options.
  React.useEffect(() => {
    if (activeTab !== "skills" || !isAdmin || skillsCatalog.length > 0) return
    let active = true
    apiFetch<CatalogListResponse>(`/api/catalog/skills`)
      .then((res) => {
        if (active) setSkillsCatalog(res.items)
      })
      .catch((err) =>
        toast.error(
          err instanceof Error ? err.message : "Failed to load skills catalog."
        )
      )
    return () => {
      active = false
    }
  }, [activeTab, isAdmin, skillsCatalog.length])

  if (loading && !character) {
    return (
      <div className="flex flex-col gap-4">
        <div className="h-6 w-1/3 animate-pulse rounded bg-muted" />
        <div className="h-32 animate-pulse rounded-lg bg-muted" />
      </div>
    )
  }

  if (error && !character) {
    return (
      <Alert variant="destructive">
        {error}{" "}
        <Button variant="outline" className="ml-2" onClick={reload}>
          Retry
        </Button>
      </Alert>
    )
  }

  if (!character) return null

  const state = character.state
  const classTrack = state.tracks["class"]
  const professionTrack = state.tracks["profession"]
  const status = character.status
  const raceGrade = state.race.grade
  const evolveTarget = evolutionTarget(state.race.level, raceGrade)

  // Archived linked equipment is not synthesized into `status`, so it never
  // appears in the live table. Keep it visible so the link can be removed.
  const archivedEquipmentLinks = character.associations.filter(
    (a) => a.kind === "equipment" && a.definitionArchived
  )

  // Skills acquired via milestone selection (kind "skill") or manual grant.
  const skillAssociations = character.associations.filter(
    (a) => a.kind === "skill"
  )

  const evolutionOptionList = evolutionOptions?.options ?? []
  const legacyAvailable = evolutionOptions?.legacyAvailable ?? false
  const selectedOption = evolutionOptionList.find(
    (o) => o.id === selectedOptionId
  )
  const canConfirm =
    evolutionOptionMode === "legacy"
      ? legacyAvailable && evolveTarget != null
      : selectedOption?.eligible === true &&
        (!selectedOption.manualReview ||
          (isAdmin && evolveReason.trim().length > 0))

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="relative shrink-0">
            <Avatar size="lg" className="size-12">
              {portrait?.url ? (
                <AvatarImage
                  src={portrait.url}
                  alt={`${character.name} portrait`}
                  className="size-12"
                />
              ) : null}
              <AvatarFallback className="text-sm">
                {character.name.charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate font-heading text-lg font-medium">
                {character.name}
              </h1>
              {character.archived ? <Badge>Archived</Badge> : null}
              {character.imported ? (
                <Badge variant="outline">Imported - unverified backup</Badge>
              ) : null}
              <Badge variant="outline" className="capitalize">
                {character.origin}
              </Badge>
              <Badge variant="outline">
                Grade {state.race.grade} (level {state.race.level})
              </Badge>
              <Badge variant="outline">v{character.version}</Badge>
            </div>
            <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              {[
                character.raceName,
                character.className,
                character.professionName,
              ]
                .filter(Boolean)
                .map((name, i) => (
                  <React.Fragment key={name}>
                    {i > 0 ? <ChevronRightIcon className="size-3" /> : null}
                    <span>{name}</span>
                  </React.Fragment>
                ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {!character.archived ? (
                <label
                  htmlFor="portrait-upload"
                  className={cn(
                    buttonVariants({ variant: "outline", size: "sm" }),
                    "cursor-pointer"
                  )}
                >
                  <UploadIcon />
                  Upload portrait
                </label>
              ) : null}
              {portrait ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1"
                  onClick={() => setRemovePortraitOpen(true)}
                  disabled={portraitBusy}
                >
                  <Trash2Icon />
                  Remove
                </Button>
              ) : null}
            </div>
          </div>
        </div>
        <input
          id="portrait-upload"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="sr-only"
          disabled={portraitBusy}
          onChange={onPortraitFileChange}
        />
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            onClick={exportCharacter}
          >
            <DownloadIcon />
            Export
          </Button>
          {character.archived ? (
            <Button
              variant="outline"
              size="sm"
              className="gap-1"
              onClick={restore}
              disabled={busy}
            >
              <RotateCcwIcon />
              Restore
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="gap-1"
              onClick={archive}
              disabled={busy}
            >
              <ArchiveIcon />
              Archive
            </Button>
          )}
        </div>
      </div>

      {error ? <Alert variant="destructive">{error}</Alert> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="gap-1"
          onClick={() => advance("class")}
          disabled={busy || !classTrack}
        >
          <ArrowUpIcon />
          Advance class
          {classTrack ? ` (L${classTrack.level} Q${classTrack.quarter})` : ""}
        </Button>
        {professionTrack ? (
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            onClick={() => advance("profession")}
            disabled={busy}
          >
            <ArrowUpIcon />
            Advance profession (L{professionTrack.level} Q
            {professionTrack.quarter})
          </Button>
        ) : null}
        {classTrack ? (
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            onClick={() => setTrackEvolveTrack("class")}
            disabled={busy}
            title={
              classTrack.grade
                ? `Evolve class grade from ${classTrack.grade}`
                : "Class has no explicit grade yet (legacy state)"
            }
          >
            <SparklesIcon />
            Evolve class{classTrack.grade ? ` (${classTrack.grade})` : ""}
          </Button>
        ) : null}
        {professionTrack ? (
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            onClick={() => setTrackEvolveTrack("profession")}
            disabled={busy}
            title={
              professionTrack.grade
                ? `Evolve profession grade from ${professionTrack.grade}`
                : "Profession has no explicit grade yet (legacy state)"
            }
          >
            <SparklesIcon />
            Evolve profession
            {professionTrack.grade ? ` (${professionTrack.grade})` : ""}
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          className="gap-1"
          onClick={() => {
            setEvolveError(null)
            setSelectedOptionId("")
            setEvolutionOptionMode("option")
            setEvolveReason("")
            setEvolveOpen(true)
            void loadEvolutionOptions()
          }}
          disabled={busy || evolveBusy || !evolveTarget}
          title={
            evolveTarget
              ? `Evolve race grade to ${evolveTarget}`
              : "No higher race grade reached at this level yet"
          }
          aria-label={
            evolveTarget
              ? `Evolve race grade to ${evolveTarget}`
              : "Evolve race grade"
          }
        >
          <SparklesIcon />
          Evolve grade{evolveTarget ? ` (to ${evolveTarget})` : ""}
        </Button>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(v) => {
          if (!v) return
          setActiveTab(v)
          if (v === "inventory") {
            if (equipmentCatalog.length === 0) void loadCatalog("equipment")
            if (consumablesCatalog.length === 0) void loadCatalog("consumables")
          }
        }}
      >
        <TabsList variant="line">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="attributes">Attributes</TabsTrigger>
          <TabsTrigger value="identity">Race / Class / Profession</TabsTrigger>
          <TabsTrigger value="skills">Skills</TabsTrigger>
          <TabsTrigger value="powers">Powers</TabsTrigger>
          <TabsTrigger value="titles">Titles</TabsTrigger>
          <TabsTrigger value="equipment">Equipment</TabsTrigger>
          <TabsTrigger value="consumables">Consumables</TabsTrigger>
          <TabsTrigger value="inventory">Inventory</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
        </TabsList>

        <TabsContent value="inventory" className="pt-3">
          <Card>
            <CardContent>
              <div className="flex flex-col gap-3">
                <div>
                  <h3 className="font-medium">Owned inventory</h3>
                  <p className="text-sm text-muted-foreground">
                    Manual bookkeeping only. Source notes are not verified loot
                    or crafting records.
                  </p>
                </div>
                {(["equipment", "consumables"] as const).map((kind) => {
                  const rows = (character.inventory ?? []).filter(
                    (item) => item.kind === kind
                  )
                  return (
                    <section
                      key={kind}
                      aria-label={
                        kind === "equipment"
                          ? "Owned equipment"
                          : "Owned consumables"
                      }
                    >
                      <h4 className="mb-2 text-sm font-medium capitalize">
                        {kind}
                      </h4>
                      {rows.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          No owned stock.
                        </p>
                      ) : (
                        <div className="flex flex-col gap-2">
                          {rows.map((item) => {
                            const equipped = character.associations.some(
                              (a) =>
                                a.kind === "equipment" &&
                                a.definitionId === item.definitionId
                            )
                            return (
                              <div
                                key={item.id}
                                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                              >
                                <div>
                                  <div className="font-medium">
                                    {item.name}{" "}
                                    <Badge variant="outline">
                                      Qty {item.quantity}
                                    </Badge>{" "}
                                    {item.archived ? (
                                      <Badge variant="outline">
                                        Archived - inert
                                      </Badge>
                                    ) : null}
                                  </div>
                                  <p className="text-xs text-muted-foreground">
                                    {item.slot ? `Slot: ${item.slot} - ` : ""}
                                    Provenance: {item.provenance}
                                    {equipped ? " - Equipped" : ""}
                                  </p>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                  {item.kind === "equipment" ? (
                                    equipped ? (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={assocBusy}
                                        onClick={() =>
                                          void removeAssociation(
                                            "equipment",
                                            item.definitionId
                                          )
                                        }
                                      >
                                        Unequip
                                      </Button>
                                    ) : (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={
                                          assocBusy ||
                                          item.archived ||
                                          item.quantity < 1
                                        }
                                        onClick={() =>
                                          void addAssociation(
                                            "equipment",
                                            item.definitionId
                                          )
                                        }
                                      >
                                        Equip
                                      </Button>
                                    )
                                  ) : (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      disabled={
                                        consumeBusy ||
                                        item.archived ||
                                        item.quantity < 1
                                      }
                                      onClick={() => {
                                        const catalogItem =
                                          consumablesCatalog.find(
                                            (entry) =>
                                              entry.id === item.definitionId
                                          )
                                        if (catalogItem)
                                          requestConsume(catalogItem)
                                      }}
                                    >
                                      Consume
                                    </Button>
                                  )}
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={
                                      busy || (equipped && item.quantity <= 1)
                                    }
                                    onClick={() => {
                                      setInventoryRemoveItem(item)
                                      setInventoryQuantity("")
                                      setInventorySourceNote("")
                                      setInventoryError(null)
                                    }}
                                  >
                                    Discard
                                  </Button>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </section>
                  )
                })}
                <Button
                  variant="outline"
                  className="self-start"
                  onClick={() => {
                    setInventoryDefinitionId("")
                    setInventoryQuantity("")
                    setInventorySourceNote("")
                    setInventoryError(null)
                    setInventoryAddOpen(true)
                  }}
                >
                  Add stock
                </Button>
                {inventoryRemoveItem?.quantity === 1 &&
                character.associations.some(
                  (a) =>
                    a.kind === "equipment" &&
                    a.definitionId === inventoryRemoveItem.definitionId
                ) ? (
                  <p className="text-sm text-muted-foreground">
                    Unequip {inventoryRemoveItem.name} before discarding its
                    last stock.
                  </p>
                ) : null}
              </div>
            </CardContent>
          </Card>
          <Dialog open={inventoryAddOpen} onOpenChange={setInventoryAddOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add stock</DialogTitle>
                <DialogDescription>
                  Manual bookkeeping only; source notes are not verified loot or
                  crafting records.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-3">
                <Label htmlFor="inventory-add-item">Catalog item</Label>
                <Select
                  value={inventoryDefinitionId}
                  onValueChange={(value) =>
                    setInventoryDefinitionId(value ?? "")
                  }
                >
                  <SelectTrigger id="inventory-add-item">
                    <SelectValue placeholder="Choose an active item" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel>Equipment</SelectLabel>
                      {equipmentCatalog
                        .filter((item) => !item.archived)
                        .map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {item.name}
                          </SelectItem>
                        ))}
                    </SelectGroup>
                    <SelectGroup>
                      <SelectLabel>Consumables</SelectLabel>
                      {consumablesCatalog
                        .filter((item) => !item.archived)
                        .map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {item.name}
                          </SelectItem>
                        ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Label htmlFor="inventory-add-quantity">Quantity</Label>
                <Input
                  id="inventory-add-quantity"
                  type="number"
                  min={1}
                  max={999999}
                  required
                  value={inventoryQuantity}
                  onChange={(e) => setInventoryQuantity(e.target.value)}
                />
                <Label htmlFor="inventory-add-note">Source note</Label>
                <Input
                  id="inventory-add-note"
                  required
                  maxLength={500}
                  value={inventorySourceNote}
                  onChange={(e) => setInventorySourceNote(e.target.value)}
                />
                {inventoryError ? (
                  <p role="alert" className="text-sm text-destructive">
                    {inventoryError}
                  </p>
                ) : null}
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setInventoryAddOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  disabled={
                    inventoryBusy ||
                    !inventoryDefinitionId ||
                    !Number.isInteger(Number(inventoryQuantity)) ||
                    Number(inventoryQuantity) < 1 ||
                    Number(inventoryQuantity) > 999999 ||
                    !inventorySourceNote.trim() ||
                    inventorySourceNote.length > 500
                  }
                  onClick={() =>
                    void submitInventory(
                      "add",
                      inventoryDefinitionId,
                      Number(inventoryQuantity),
                      inventorySourceNote,
                      () => setInventoryAddOpen(false)
                    )
                  }
                >
                  Save
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Dialog
            open={!!inventoryRemoveItem}
            onOpenChange={(open) => {
              if (!open) setInventoryRemoveItem(null)
            }}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Discard stock</DialogTitle>
                <DialogDescription>
                  Discard stock of {inventoryRemoveItem?.name}.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-3">
                <Label htmlFor="inventory-remove-quantity">
                  Quantity (1-
                  {inventoryRemoveItem
                    ? Math.min(
                        inventoryRemoveItem.quantity,
                        character.associations.some(
                          (a) =>
                            a.kind === "equipment" &&
                            a.definitionId === inventoryRemoveItem.definitionId
                        )
                          ? inventoryRemoveItem.quantity - 1
                          : inventoryRemoveItem.quantity
                      )
                    : 1}
                  )
                </Label>
                <Input
                  id="inventory-remove-quantity"
                  type="number"
                  min={1}
                  max={
                    inventoryRemoveItem
                      ? Math.min(
                          inventoryRemoveItem.quantity,
                          character.associations.some(
                            (a) =>
                              a.kind === "equipment" &&
                              a.definitionId ===
                                inventoryRemoveItem.definitionId
                          )
                            ? inventoryRemoveItem.quantity - 1
                            : inventoryRemoveItem.quantity
                        )
                      : 1
                  }
                  required
                  value={inventoryQuantity}
                  onChange={(e) => setInventoryQuantity(e.target.value)}
                />
                <Label htmlFor="inventory-remove-note">Source note</Label>
                <Input
                  id="inventory-remove-note"
                  required
                  maxLength={500}
                  value={inventorySourceNote}
                  onChange={(e) => setInventorySourceNote(e.target.value)}
                />
                {inventoryError ? (
                  <p role="alert" className="text-sm text-destructive">
                    {inventoryError}
                  </p>
                ) : null}
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setInventoryRemoveItem(null)}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  disabled={
                    inventoryBusy ||
                    !inventoryRemoveItem ||
                    !Number.isInteger(Number(inventoryQuantity)) ||
                    Number(inventoryQuantity) < 1 ||
                    Number(inventoryQuantity) >
                      Math.min(
                        inventoryRemoveItem.quantity,
                        character.associations.some(
                          (a) =>
                            a.kind === "equipment" &&
                            a.definitionId === inventoryRemoveItem.definitionId
                        )
                          ? inventoryRemoveItem.quantity - 1
                          : inventoryRemoveItem.quantity
                      ) ||
                    !inventorySourceNote.trim() ||
                    inventorySourceNote.length > 500
                  }
                  onClick={() =>
                    inventoryRemoveItem &&
                    void submitInventory(
                      "remove",
                      inventoryRemoveItem.definitionId,
                      Number(inventoryQuantity),
                      inventorySourceNote,
                      () => setInventoryRemoveItem(null)
                    )
                  }
                >
                  Discard stock
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </TabsContent>

        <TabsContent value="overview" className="pt-3">
          <Card>
            <CardContent>
              <div className="flex flex-col gap-1">
                <MetaRow label="Description">
                  {character.description?.trim() || "No description"}
                </MetaRow>
                <MetaRow label="Origin">{character.origin}</MetaRow>
                <MetaRow label="Race">
                  {character.raceName ?? "Not set"}
                </MetaRow>
                <MetaRow label="Class">
                  {character.className ?? "Not set"}
                </MetaRow>
                <MetaRow label="Profession">
                  {character.professionName ?? "None"}
                </MetaRow>
                <MetaRow label="Updated">{character.updatedAt}</MetaRow>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="powers" className="pt-3">
          <Card>
            <CardContent>
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="font-heading text-sm font-medium">
                      Blessings and bloodlines
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      Linked blessing and bloodline effects are catalog-defined.
                      Numeric status and effective values are calculated by the
                      server; this sheet does not assume canonical bonuses or
                      treat narrative power as numeric.
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={openAssociations}
                  >
                    Manage powers
                  </Button>
                </div>
                {(["blessing", "bloodline"] as const).map((kind) => {
                  const links = character.associations.filter(
                    (a) => a.kind === kind
                  )
                  return (
                    <section
                      key={kind}
                      aria-label={
                        kind === "blessing" ? "Blessing" : "Bloodlines"
                      }
                    >
                      <h4 className="text-xs font-medium capitalize">
                        {kind === "blessing" ? "Blessing" : "Bloodlines"}
                      </h4>
                      {links.length ? (
                        <div className="mt-1 flex flex-col gap-2">
                          {links.map((a) => (
                            <div
                              key={a.id}
                              className="rounded-lg border bg-input/20 p-2"
                            >
                              <div className="flex flex-wrap items-center gap-1.5 font-medium">
                                {a.name}
                                {a.grade ? (
                                  <Badge variant="outline">{a.grade}</Badge>
                                ) : null}
                                {a.definitionArchived ? (
                                  <Badge variant="outline">
                                    Archived - inert
                                  </Badge>
                                ) : null}
                              </div>
                              <p className="text-[0.6875rem] text-muted-foreground">
                                Provenance: {a.provenance ?? "unspecified"}
                                {a.definitionArchived
                                  ? " - linked but not effective"
                                  : ""}
                              </p>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-1 text-xs text-muted-foreground">
                          No linked {kind}s.
                        </p>
                      )}
                    </section>
                  )
                })}
                <section aria-label="Transcendent skills">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-xs font-medium">Transcendent skills</h4>
                    {character.isTranscendent ? (
                      <Badge variant="outline">Transcendent</Badge>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Transcendent skills are distinct from blessings, bloodlines,
                    and acquired skills. Listed descriptions and costs are
                    reference only; this app does not activate skills or deduct
                    costs.
                  </p>
                  {character.associations.filter(
                    (a) => a.kind === "transcendent"
                  ).length ? (
                    <div className="mt-1 flex flex-col gap-2">
                      {character.associations
                        .filter((a) => a.kind === "transcendent")
                        .map((a) => (
                          <div
                            key={a.id}
                            className="flex items-center justify-between gap-3 rounded-lg border bg-input/20 p-2"
                          >
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-1.5 font-medium">
                                {a.name}
                                {a.definitionArchived ? (
                                  <Badge variant="outline">
                                    Archived - inert
                                  </Badge>
                                ) : null}
                                {a.grade ? (
                                  <Badge variant="outline">{a.grade}</Badge>
                                ) : null}
                              </div>
                              <p className="text-[0.6875rem] text-muted-foreground">
                                Provenance: {a.provenance ?? "unspecified"}
                                {a.definitionArchived
                                  ? " - linked but not effective"
                                  : ""}
                              </p>
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={assocBusy}
                              onClick={() => {
                                if (
                                  window.confirm(
                                    `Remove ${a.name} from ${character.name}?`
                                  )
                                )
                                  void removeAssociation(
                                    "transcendent",
                                    a.definitionId
                                  )
                              }}
                            >
                              Remove
                            </Button>
                          </div>
                        ))}
                    </div>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">
                      No linked transcendent skills.
                    </p>
                  )}
                </section>
                {status ? (
                  <p className="text-xs text-muted-foreground">
                    Current attribute values below reflect server-calculated
                    live effects.
                  </p>
                ) : null}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="attributes" className="pt-3">
          {status ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="outline">
                  Available points: {status.availablePoints}
                </Badge>
                <Badge variant="outline">
                  Total free: {status.totalFreePoints}
                </Badge>
                <Badge variant="outline">
                  Allocated: {status.allocatedPoints}
                </Badge>
              </div>

              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Attribute</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                      <TableHead>Trace</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {status.traces.map((trace) => (
                      <TableRow key={trace.attribute}>
                        <TableCell className="capitalize">
                          {trace.attribute}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {trace.final}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-0.5">
                            {trace.phases.map((phase) => (
                              <span
                                key={phase.phase}
                                className="flex justify-between text-[0.6875rem] text-muted-foreground"
                              >
                                <span>{phase.phase}</span>
                                <span className="tabular-nums">
                                  {phase.value}
                                  {phase.delta >= 0 ? " (+" : " ("}
                                  {phase.delta}){" "}
                                </span>
                              </span>
                            ))}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <Card>
                <CardContent>
                  <h3 className="mb-2 font-heading text-sm font-medium">
                    Allocate points
                  </h3>
                  <AllocationEditor
                    status={status}
                    onAllocate={allocate}
                    busy={busy}
                  />
                </CardContent>
              </Card>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Status is not available.
            </p>
          )}
        </TabsContent>

        <TabsContent value="identity" className="pt-3">
          <Card>
            <CardContent>
              <div className="flex flex-col gap-1">
                <MetaRow label="Race">
                  {character.raceName ?? "Not set"}
                </MetaRow>
                <MetaRow label="Class">
                  {character.className ?? "Not set"}
                </MetaRow>
                <MetaRow label="Profession">
                  {character.professionName ?? "None"}
                </MetaRow>
                <MetaRow label="Race grade">
                  {state.race.grade} (mode {state.race.mode})
                </MetaRow>
                <MetaRow label="Race level">{state.race.level}</MetaRow>
                <MetaRow label="Class level">
                  {classTrack
                    ? `${classTrack.level} (quarter ${classTrack.quarter})`
                    : "None"}
                </MetaRow>
                <MetaRow label="Profession level">
                  {professionTrack
                    ? `${professionTrack.level} (quarter ${professionTrack.quarter})`
                    : "None"}
                </MetaRow>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="skills" className="pt-3">
          <Card>
            <CardContent>
              <div className="flex flex-col gap-4">
                <div>
                  <h3 className="font-heading text-sm font-medium">
                    Skill offers
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Skills are offered at class/profession milestones - never
                    auto-awarded. Choose one option from a pending offer, or
                    re-open the catalog to edit what is offered.
                  </p>
                </div>

                {character.skillOffers.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No skill offers yet. Advance a class or profession to its
                    milestone to be offered skills.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {character.skillOffers.map((offer) => {
                      const allArchived =
                        offer.options.length > 0 &&
                        offer.options.every((o) => o.archived)
                      const selected = offer.selectedDefinitionId
                      const selectedName = selected
                        ? (offer.options.find(
                            (o) => o.definitionId === selected
                          )?.nameSnapshot ?? null)
                        : null
                      return (
                        <div
                          key={offer.id}
                          className="rounded-lg border bg-input/20 p-2"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium">
                              {offer.track === "class" ? "Class" : "Profession"}{" "}
                              level {offer.level} - {offer.choiceGroup}
                            </span>
                            {selected ? (
                              <Badge variant="outline">Selected</Badge>
                            ) : allArchived ? (
                              <Badge variant="outline">Blocked</Badge>
                            ) : (
                              <Badge variant="outline">Pending</Badge>
                            )}
                          </div>
                          {selected ? (
                            <div className="text-xs text-muted-foreground">
                              Selected: {selectedName ?? "?"}
                            </div>
                          ) : (
                            <div className="mt-1 flex flex-col gap-1.5">
                              {offer.options.map((opt) => (
                                <div
                                  key={opt.definitionId}
                                  className="flex items-center justify-between gap-3 rounded-md border bg-background/40 p-1.5"
                                >
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-1.5">
                                      <span className="truncate font-medium">
                                        {opt.nameSnapshot}
                                      </span>
                                      {opt.grade ? (
                                        <Badge variant="outline">
                                          {opt.grade}
                                        </Badge>
                                      ) : null}
                                      {opt.archived ? (
                                        <Badge variant="outline">
                                          Archived
                                        </Badge>
                                      ) : null}
                                    </div>
                                    <div className="text-[0.6875rem] text-muted-foreground">
                                      Provenance: {opt.provenance ?? "house"}
                                      {opt.archived
                                        ? " - unavailable until re-enabled in the catalog"
                                        : ""}
                                    </div>
                                  </div>
                                  {opt.archived ? null : (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      disabled={skillBusy}
                                      onClick={() =>
                                        setSelectConfirm({
                                          offerId: offer.id,
                                          definitionId: opt.definitionId,
                                          name: opt.nameSnapshot,
                                        })
                                      }
                                    >
                                      Select
                                    </Button>
                                  )}
                                </div>
                              ))}
                              {allArchived ? (
                                <p className="text-xs text-muted-foreground">
                                  Every offered choice is archived. An admin can
                                  re-enable one in the catalog to unlock this
                                  offer.
                                </p>
                              ) : null}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}

                <Separator />

                <div>
                  <h3 className="font-heading text-sm font-medium">
                    Acquired skills
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Effects are synthesized live from the current catalog; the
                    stored history is unchanged. Archived skills no longer
                    contribute.
                  </p>
                </div>
                {skillAssociations.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No skills acquired yet.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {skillAssociations.map((a) => (
                      <div
                        key={a.id}
                        className="rounded-lg border bg-input/20 p-2"
                      >
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium">{a.name}</span>
                          {a.definitionArchived ? (
                            <Badge variant="outline">Archived</Badge>
                          ) : null}
                          {a.grade ? (
                            <Badge variant="outline">{a.grade}</Badge>
                          ) : null}
                        </div>
                        <div className="text-[0.6875rem] text-muted-foreground">
                          Provenance: {a.provenance ?? "house"}
                          {a.upgradeGroup
                            ? ` - Upgrade group: ${a.upgradeGroup}`
                            : ""}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {isAdmin ? (
                  <>
                    <Separator />
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="font-heading text-sm font-medium">
                          Admin: manually grant a skill
                        </h3>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setGrantSkillId("")
                            setGrantReason("")
                            setGrantOpen(true)
                          }}
                        >
                          Grant skill
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Grants a skill immediately (provenance manual) with a
                        required reason. Owners can only select offered options
                        - they cannot grant.
                      </p>
                    </div>
                  </>
                ) : null}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="titles" className="pt-3">
          <Card>
            <CardContent>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-heading text-sm font-medium">Titles</h3>
                  <p className="text-xs text-muted-foreground">
                    Titles attached to this character. Their effects are
                    synthesized live from the current catalog; the stored
                    history is unchanged.
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={openAssociations}>
                  Manage titles & equipment
                </Button>
              </div>
              {character.associations.filter((a) => a.kind === "title")
                .length === 0 ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  No titles attached yet.
                </p>
              ) : (
                <div className="mt-3 flex flex-col gap-2">
                  {character.associations
                    .filter((a) => a.kind === "title")
                    .map((a) => (
                      <div
                        key={a.id}
                        className="flex items-center justify-between rounded-lg border bg-input/20 p-2"
                      >
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium">{a.name}</span>
                            {a.definitionArchived ? (
                              <Badge variant="outline">Archived</Badge>
                            ) : null}
                          </div>
                          {a.upgradeGroup ? (
                            <div className="text-[0.6875rem] text-muted-foreground">
                              Upgrade group: {a.upgradeGroup}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="equipment" className="pt-3">
          <div className="flex items-start justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Equipment must be owned in Inventory before it can be equipped.
              Bonuses are capped by the house assumption of 20% per attribute
              (aggregate) and 15% overall.
            </p>
            <Button variant="outline" size="sm" onClick={openAssociations}>
              Manage titles & equipment
            </Button>
          </div>
          {status && status.equipment.items.length > 0 ? (
            <div className="mt-3 overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead>Requested</TableHead>
                    <TableHead>Applied</TableHead>
                    <TableHead>Suppressed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {status.equipment.items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>{item.name}</TableCell>
                      <TableCell className="tabular-nums">
                        {ATTRIBUTE_KEYS.filter((a) => item.requested[a] !== 0)
                          .map((a) => `${a}:${item.requested[a]}`)
                          .join(", ") || "0"}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {ATTRIBUTE_KEYS.filter((a) => item.applied[a] !== 0)
                          .map((a) => `${a}:${item.applied[a]}`)
                          .join(", ") || "0"}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {ATTRIBUTE_KEYS.filter((a) => item.suppressed[a] !== 0)
                          .map((a) => `${a}:${item.suppressed[a]}`)
                          .join(", ") || "0"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <Card className="mt-3">
              <CardContent>
                <p className="text-xs text-muted-foreground">
                  {archivedEquipmentLinks.length > 0
                    ? "No active equipment is contributing, but archived links remain."
                    : "No equipment is attached to this character yet. Equip items from the catalog to see their bonuses."}
                </p>
              </CardContent>
            </Card>
          )}
          {archivedEquipmentLinks.length > 0 ? (
            <div className="mt-3 flex flex-col gap-2">
              {archivedEquipmentLinks.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center justify-between rounded-lg border bg-input/20 p-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-medium">{a.name}</span>
                      <Badge variant="outline">Archived</Badge>
                    </div>
                    <div className="text-[0.6875rem] text-muted-foreground">
                      Linked but archived - no longer contributing.
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </TabsContent>

        <TabsContent value="consumables" className="pt-3">
          <div className="flex items-start justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Consumables grant either a permanent stat gain (capped by the
              grade-based race-level capacity) or a temporary effect that
              expires after a number of quarters. Permanent gains are recorded
              in the immutable journal and cannot be undone.
            </p>
            <Button variant="outline" size="sm" onClick={openAssociations}>
              Manage consumables
            </Button>
          </div>

          {status && status.consumables ? (
            <div className="mt-3 overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Requested</TableHead>
                    <TableHead>Applied</TableHead>
                    <TableHead>Suppressed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell className="tabular-nums">
                      {formatVector(status.consumables.requested)}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {formatVector(status.consumables.applied)}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {formatVector(status.consumables.suppressed)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">
              No active temporary consumable effects.
            </p>
          )}

          <div className="mt-4 flex flex-col gap-2">
            <div className="flex items-center gap-1.5">
              <Badge variant="outline">Cap</Badge>
              <span className="text-xs tabular-nums">
                {formatVector(character.permanentConsumableCap)}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <Badge variant="outline">Remaining</Badge>
              <span className="text-xs tabular-nums">
                {formatVector(character.permanentConsumableRemaining)}
              </span>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="history" className="pt-3">
          {events ? (
            <div className="flex flex-col gap-2">
              {events.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No progression events recorded yet.
                </p>
              ) : (
                events.map((event, i) => (
                  <div
                    key={i}
                    className="flex flex-col gap-1 rounded-lg border bg-input/20 p-2 text-xs/relaxed"
                  >
                    <div className="flex items-center justify-between">
                      <Badge variant="outline" className="capitalize">
                        {event.kind}
                      </Badge>
                      <span className="text-[0.6875rem] text-muted-foreground">
                        {event.createdAt}
                      </span>
                    </div>
                    <pre className="whitespace-pre-wrap text-muted-foreground">
                      {JSON.stringify(event.payload, null, 2)}
                    </pre>
                  </div>
                ))
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Loading history...</p>
          )}
        </TabsContent>

        <TabsContent value="notes" className="pt-3">
          <Card>
            <CardContent>
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="note-name">Name</Label>
                  <Input
                    id="note-name"
                    value={notes.name}
                    onChange={(e) =>
                      setNotes((n) => ({ ...n, name: e.target.value }))
                    }
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="note-description">Notes / description</Label>
                  <textarea
                    id="note-description"
                    value={notes.description}
                    onChange={(e) =>
                      setNotes((n) => ({ ...n, description: e.target.value }))
                    }
                    className="min-h-28 w-full rounded-md border border-input bg-input/20 px-2 py-1.5 text-xs/relaxed outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                  />
                </div>
                <div>
                  <Button
                    onClick={saveNotes}
                    disabled={savingNotes || notes.name.trim().length === 0}
                  >
                    {savingNotes ? "Saving..." : "Save"}
                  </Button>
                </div>
                <p className="text-[0.6875rem] text-muted-foreground">
                  Saving sends the current version to detect conflicts with
                  other changes.
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Separator />

      <Dialog open={journalOpen} onOpenChange={setJournalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Progression journal</DialogTitle>
            <DialogDescription>
              What the last advancement produced.
            </DialogDescription>
          </DialogHeader>
          {journal ? <JournalPanel journal={journal} /> : null}
        </DialogContent>
      </Dialog>

      <Dialog open={evolveOpen} onOpenChange={setEvolveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Evolve race grade</DialogTitle>
            <DialogDescription>
              This progresses race grade only. Class/profession evolution is not
              selected yet, so the system will not auto-choose a path for you.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1 text-xs/relaxed text-muted-foreground">
            <span>
              Current grade: <span className="font-medium">{raceGrade}</span>
            </span>
            <span>
              Target grade:{" "}
              <span className="font-medium">{evolveTarget ?? "-"}</span>
            </span>
            <span>
              Race level:{" "}
              <span className="font-medium">{state.race.level}</span>
            </span>
          </div>

          {evolutionLoading ? (
            <p className="text-xs text-muted-foreground">
              Loading evolution options...
            </p>
          ) : evolutionOptions == null ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">
                Could not load evolution options.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadEvolutionOptions()}
              >
                Retry
              </Button>
            </div>
          ) : evolutionOptions && evolutionOptionList.length > 0 ? (
            <div className="flex flex-col gap-2">
              {evolutionOptionList.map((option) => {
                const selected = option.id === selectedOptionId
                const selectable = option.eligible
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => {
                      if (!selectable) return
                      setSelectedOptionId(option.id)
                      setEvolutionOptionMode("option")
                    }}
                    disabled={!selectable}
                    className={cn(
                      "flex w-full flex-col gap-1 rounded-lg border p-2 text-left text-xs/relaxed",
                      selected ? "border-ring bg-input/20" : "border",
                      !selectable ? "cursor-not-allowed opacity-70" : ""
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">{option.name}</span>
                      <Badge variant="outline">
                        {option.fromGrade} {"->"} {option.toGrade}
                      </Badge>
                      <Badge variant="outline">
                        {option.track === "race"
                          ? "Race"
                          : option.track === "class"
                            ? "Class"
                            : "Profession"}
                        : {option.toTrackName}
                      </Badge>
                      {option.manualReview ? (
                        <Badge variant="outline">Manual review</Badge>
                      ) : null}
                      {!selectable ? (
                        <Badge variant="outline">Blocked</Badge>
                      ) : null}
                    </div>
                    {option.description ? (
                      <span className="text-muted-foreground">
                        {option.description}
                      </span>
                    ) : null}
                    <span className="text-muted-foreground">
                      Provenance: {option.provenance}
                      {option.sourceUrl ? ` - ${option.sourceUrl}` : ""}
                    </span>
                    {option.blockers.length > 0 ? (
                      <ul className="list-disc pl-5 text-muted-foreground">
                        {option.blockers.map((blocker, i) => (
                          <li key={i}>{blocker}</li>
                        ))}
                      </ul>
                    ) : null}
                    {option.manualReview && !isAdmin ? (
                      <span className="text-muted-foreground">
                        An admin must provide a reason to override the manual
                        requirements for this path.
                      </span>
                    ) : null}
                  </button>
                )
              })}
              {legacyAvailable ? (
                <button
                  type="button"
                  onClick={() => setEvolutionOptionMode("legacy")}
                  className={cn(
                    "flex w-full flex-col gap-1 rounded-lg border p-2 text-left text-xs/relaxed",
                    evolutionOptionMode === "legacy"
                      ? "border-ring bg-input/20"
                      : "border"
                  )}
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">
                      Grade-only ({evolveTarget ?? "-"})
                    </span>
                    <Badge variant="outline">House fallback</Badge>
                  </div>
                  <span className="text-muted-foreground">
                    No contextual race path targets this grade, so the same-race
                    grade evolution is offered.
                  </span>
                </button>
              ) : null}
            </div>
          ) : evolutionOptions && evolutionOptions.legacyAvailable ? (
            <p className="text-xs text-muted-foreground">
              No contextual race evolution path is configured for this grade.
              The system applies the grade-only house fallback to{" "}
              {evolveTarget ?? "-"}.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              No evolution options are available yet.
            </p>
          )}

          {evolutionOptionMode === "option" &&
          selectedOption?.manualReview &&
          isAdmin ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="evolve-reason">
                Reason (required to override manual requirements)
              </Label>
              <Input
                id="evolve-reason"
                value={evolveReason}
                onChange={(e) => setEvolveReason(e.target.value)}
              />
            </div>
          ) : evolutionOptionMode === "legacy" && isAdmin ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="evolve-reason">Reason (optional)</Label>
              <Input
                id="evolve-reason"
                value={evolveReason}
                onChange={(e) => setEvolveReason(e.target.value)}
              />
            </div>
          ) : null}

          {evolveError ? (
            <p role="alert" className="text-xs/relaxed text-destructive">
              {evolveError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEvolveOpen(false)}
              disabled={evolveBusy}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void submitEvolution()}
              disabled={!canConfirm || evolveBusy}
            >
              {evolveBusy ? "Evolving..." : `Evolve to ${evolveTarget ?? "-"}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {trackEvolveTrack === "class" ? (
        <TrackEvolutionDialog
          track="class"
          character={character}
          isAdmin={isAdmin}
          onClose={() => setTrackEvolveTrack(null)}
          onEvolved={() => void reload()}
        />
      ) : null}

      {trackEvolveTrack === "profession" ? (
        <TrackEvolutionDialog
          track="profession"
          character={character}
          isAdmin={isAdmin}
          onClose={() => setTrackEvolveTrack(null)}
          onEvolved={() => void reload()}
        />
      ) : null}

      <AssociationSheet
        open={associationsOpen}
        onOpenChange={setAssociationsOpen}
        character={character}
        titles={titlesCatalog}
        equipment={equipmentCatalog}
        consumables={consumablesCatalog}
        blessings={blessingsCatalog}
        bloodlines={bloodlinesCatalog}
        transcendentSkills={transcendentCatalog}
        loading={catalogLoading}
        busy={assocBusy}
        consumeBusy={consumeBusy}
        onAdd={(kind, definitionId) => void addAssociation(kind, definitionId)}
        onRemove={(kind, definitionId) =>
          void removeAssociation(kind, definitionId)
        }
        onConsume={(definitionId) => {
          const item = consumablesCatalog.find((c) => c.id === definitionId)
          if (item) requestConsume(item)
        }}
        onPowerAdd={(kind, definitionId) => {
          if (kind === "transcendent") {
            const item = transcendentCatalog.find(
              (entry) => entry.id === definitionId
            )
            if (
              item &&
              window.confirm(`Attach ${item.name} to ${character.name}?`)
            )
              void addAssociation(kind, definitionId)
            return
          }
          const displaced =
            kind === "blessing"
              ? character.associations.filter(
                  (a) => a.kind === kind && a.definitionId !== definitionId
                )
              : []
          const item = [...blessingsCatalog, ...bloodlinesCatalog].find(
            (entry) => entry.id === definitionId
          )
          const group = item?.config?.upgradeGroup
          const replacements =
            kind === "bloodline" && typeof group === "string"
              ? character.associations.filter(
                  (a) =>
                    a.kind === kind &&
                    a.definitionId !== definitionId &&
                    a.upgradeGroup === group
                )
              : []
          const names = [...displaced, ...replacements].map((a) =>
            a.definitionArchived ? `${a.name} (archived, inert)` : a.name
          )
          if (
            names.length &&
            !window.confirm(
              `${item?.name ?? "Power"} will replace ${names.join(", ")}. Continue?`
            )
          )
            return
          if (
            !window.confirm(
              `Add ${item?.name ?? "this power"} to ${character.name}?`
            )
          )
            return
          void addAssociation(kind, definitionId)
        }}
        onPowerRemove={(kind, definitionId) => {
          const name =
            character.associations.find((a) => a.definitionId === definitionId)
              ?.name ?? "this power"
          if (window.confirm(`Remove ${name} from ${character.name}?`))
            void removeAssociation(kind, definitionId)
        }}
      />

      <Dialog open={removePortraitOpen} onOpenChange={setRemovePortraitOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove portrait</DialogTitle>
            <DialogDescription>
              Remove this character&apos;s portrait? This does not archive the
              character and can be re-uploaded later.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRemovePortraitOpen(false)}
              disabled={portraitBusy}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void removePortrait()}
              disabled={portraitBusy}
            >
              {portraitBusy ? "Removing..." : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!consumeConfirm}
        onOpenChange={(open) => {
          if (!open) setConsumeConfirm(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Consume permanent consumable</DialogTitle>
            <DialogDescription>
              Applying &quot;{consumeConfirm?.name ?? ""}&quot; grants a
              permanent attribute gain that cannot be undone by simply
              unequipping. It is capped by the grade-based permanent-consumable
              capacity (a house assumption, F3/E5/D15/C45).
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConsumeConfirm(null)}
              disabled={consumeBusy}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void confirmConsume()}
              disabled={consumeBusy}
            >
              {consumeBusy ? "Consuming..." : "Consume"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!selectConfirm}
        onOpenChange={(open) => {
          if (!open) setSelectConfirm(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Select skill</DialogTitle>
            <DialogDescription>
              Link &quot;{selectConfirm?.name ?? ""}&quot; to this character?
              Its effects are synthesized live from the current catalog;
              archived options are unavailable until re-enabled in the catalog.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSelectConfirm(null)}
              disabled={skillBusy}
            >
              Cancel
            </Button>
            <Button
              onClick={() =>
                selectConfirm &&
                void selectSkill(
                  selectConfirm.offerId,
                  selectConfirm.definitionId
                )
              }
              disabled={skillBusy}
            >
              {skillBusy ? "Selecting..." : "Select"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={grantOpen} onOpenChange={setGrantOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Grant a skill</DialogTitle>
            <DialogDescription>
              Grants a skill immediately with provenance &quot;manual&quot; and
              a required reason. Owners can only select offered options - they
              cannot grant.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="grant-skill">Skill</Label>
              <Select
                value={grantSkillId}
                onValueChange={(value) => setGrantSkillId(value ?? "")}
              >
                <SelectTrigger id="grant-skill" className="w-full">
                  <SelectValue placeholder="Choose a skill" />
                </SelectTrigger>
                <SelectContent>
                  {skillsCatalog.length === 0 ? (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">
                      No skills in the catalog.
                    </div>
                  ) : (
                    skillsCatalog.map((skill) => (
                      <SelectItem key={skill.id} value={skill.id}>
                        {skill.name}
                        {skill.grade ? ` (${skill.grade})` : ""}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="grant-reason">Reason (required)</Label>
              <Input
                id="grant-reason"
                value={grantReason}
                onChange={(e) => setGrantReason(e.target.value)}
                placeholder="Why is this granted?"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setGrantOpen(false)
                setGrantSkillId("")
                setGrantReason("")
              }}
              disabled={skillBusy}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void grantSkill()}
              disabled={skillBusy || !grantSkillId || !grantReason.trim()}
            >
              {skillBusy ? "Granting..." : "Grant"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
