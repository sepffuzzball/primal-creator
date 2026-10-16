"use client"

import * as React from "react"
import { useParams } from "next/navigation"
import { toast } from "sonner"
import {
  ChevronRightIcon,
  DownloadIcon,
  ArchiveIcon,
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
  type AllocateResponse,
  type AssociationResponse,
  type ExportResponse,
  type Grade,
  type JournalDelta,
  type PortraitResponse,
  type PortraitView,
  type SkillResponse,
} from "@/lib/api"
import { normalizeEquipmentSlot } from "@/lib/server/schemas"
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
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Progress,
  ProgressTrack,
  ProgressIndicator,
  ProgressLabel,
  ProgressValue,
} from "@/components/ui/progress"
import {
  Slider,
  SliderControl,
  SliderTrack,
  SliderIndicator,
  SliderThumb,
} from "@/components/ui/slider"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Sheet,
  SheetContent,
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
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogClose,
} from "@/components/ui/alert-dialog"
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

/**
 * Normalize a character-profile metadata field for a PATCH body. Converts ONLY
 * the exact empty string `""` to null (a blank field is cleared on the server)
 * and otherwise passes the value through VERBATIM - leading/trailing whitespace
 * and newlines are never trimmed, so a multiline biography/notes value survives
 * to the server exactly as typed.
 */
function metadataOrNull(value: string | null | undefined): string | null {
  if (value === "") return null
  return value ?? null
}

// Race grade ladder, lowest to highest. Mirrors the server's grade order.
const GRADE_ORDER = ["G", "F", "E", "D", "C", "B", "A", "S"] as const
const SKILL_RARITY_ORDER = [
  "Inferior",
  "Common",
  "Uncommon",
  "Rare",
  "Epic",
  "Ancient",
  "Legendary",
  "Mythical",
  "Sacred",
  "Divine",
] as const

function rarityRank(rarity: string | undefined): number {
  return rarity === "Unique"
    ? -1
    : SKILL_RARITY_ORDER.indexOf(rarity as (typeof SKILL_RARITY_ORDER)[number])
}

function JournalPanel({ journal }: { journal: JournalDelta }) {
  const experienceJournal = journal as JournalDelta & {
    percentBefore?: number
    percentAfter?: number
    turnsAdvanced?: number
  }
  return (
    <div className="flex flex-col gap-2 text-xs/relaxed">
      <div className="flex flex-wrap gap-1.5">
        <Badge variant="outline">
          {journal.track} {journal.levelBefore} {"->"} {journal.levelAfter}
        </Badge>
        {experienceJournal.percentBefore != null ||
        experienceJournal.percentAfter != null ? (
          <Badge variant="outline">
            EXP {experienceJournal.percentBefore ?? 0}% {"->"}{" "}
            {experienceJournal.percentAfter ?? 0}%
          </Badge>
        ) : (
          <Badge variant="outline">
            Quarter {journal.quarterBefore} {"->"} {journal.quarterAfter}
          </Badge>
        )}
        {experienceJournal.turnsAdvanced != null ? (
          <Badge variant="outline">
            {experienceJournal.turnsAdvanced} turn(s) advanced
          </Badge>
        ) : null}
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

function ExperienceControl({
  track,
  percent,
  level,
  editable,
  busy,
  levelUpBlocked,
  draft,
  onDraft,
  onCommit,
  onLevel,
}: {
  track: "race" | "class" | "profession"
  percent: number
  level: number
  editable: boolean
  busy: boolean
  levelUpBlocked?: string
  draft: number | undefined
  onDraft: (value: number) => void
  onCommit: (value: number) => void
  onLevel: (operation: "levelUp" | "undo") => void
}) {
  const value = draft ?? percent
  const label = `${track === "race" ? "Race" : track === "class" ? "Class" : "Profession"} experience`
  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
      <div className="flex items-center justify-between gap-3">
        <Progress value={value} aria-label={`${label} ${value}%`}>
          <div className="flex items-center justify-between gap-2 text-sm">
            <ProgressLabel className="font-medium">{label}</ProgressLabel>
            <span className="text-muted-foreground tabular-nums">{value}%</span>
            <ProgressValue className="sr-only" />
          </div>
          <ProgressTrack className="mt-2">
            <ProgressIndicator />
          </ProgressTrack>
        </Progress>
      </div>
      <div className="flex items-center gap-2">
        {editable ? (
          <>
            <Button
              aria-label={`Decrease ${track} level`}
              variant="outline"
              size="sm"
              disabled={busy || (track !== "race" && level <= 1)}
              onClick={() => onLevel("undo")}
            >
              - Level
            </Button>
            <Slider
              aria-label={label}
              min={0}
              max={100}
              step={1}
              value={[value]}
              disabled={busy}
              onValueChange={(next) =>
                onDraft(Array.isArray(next) ? (next[0] ?? 0) : (next as number))
              }
              onValueCommitted={(next) =>
                onCommit(
                  Array.isArray(next) ? (next[0] ?? 0) : (next as number)
                )
              }
            >
              <SliderControl>
                <SliderTrack>
                  <SliderIndicator />
                </SliderTrack>
                <SliderThumb />
              </SliderControl>
            </Slider>
            <Button
              aria-label={`Increase ${track} level`}
              variant="outline"
              size="sm"
              disabled={busy || Boolean(levelUpBlocked)}
              title={levelUpBlocked}
              onClick={() => onLevel("levelUp")}
            >
              + Level
            </Button>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            Average of available class and profession experience
          </p>
        )}
      </div>
      {editable && levelUpBlocked ? (
        <p className="text-xs text-muted-foreground" role="status">
          {levelUpBlocked}
        </p>
      ) : null}
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>Level {level}</span>
        <span className="tabular-nums">{value}%</span>
      </div>
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

function payloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {}
}

/**
 * Normalize a source event timestamp for skill history. Accepts either a valid
 * ISO date string or a finite numeric Unix epoch in MILLISECONDS that falls
 * within the JS Date range, and returns a UTC ISO string for display/sort.
 * Returns null (so the caller falls back to the inherited date) when the value
 * is missing, not a parseable date, NaN/non-finite, or outside the JS Date
 * range. A numeric `sourceCreatedAt` is permitted by the import schema
 * (z.union string/number), so a trusted backup time must survive to the screen.
 */
function normalizeSourceDate(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null
    // JS Date valid range is +/- 8.64e15 ms relative to the Unix epoch; outside
    // of it `new Date` yields an Invalid Date that cannot be sorted/displayed.
    if (Math.abs(value) > 8640000000000000) return null
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return null
    return date.toISOString()
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value)
    if (Number.isNaN(parsed)) return null
    return new Date(parsed).toISOString()
  }
  return null
}

function humanizeStableId(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

const ROMAN_NUMERALS = new Map<string, number>([
  ["I", 1],
  ["V", 5],
  ["X", 10],
  ["L", 50],
  ["C", 100],
  ["D", 500],
  ["M", 1000],
])

function romanNumeralToNumber(value: string): number | null {
  let total = 0
  let previous = 0
  for (const char of value.split("").reverse()) {
    const numeral = ROMAN_NUMERALS.get(char)
    if (numeral == null) return null
    if (numeral < previous) total -= numeral
    else total += numeral
    previous = numeral
  }
  return total
}

/**
 * Strip a trailing rank suffix (a space then a Roman numeral or Arabic number
 * token) from a title name when that token equals the given rank. Returns the
 * base name, or null when the name carries no safely recognizable rank suffix.
 */
function stripRankSuffix(name: string, rank: number): string | null {
  const trimmed = name.trim()
  const match = trimmed.match(/^(.*\S)\s+(\d+|[IVXLCDM]+)$/)
  if (!match) return null
  const [, base, token] = match
  const suffixValue = /^\d+$/.test(token)
    ? Number(token)
    : romanNumeralToNumber(token)
  if (suffixValue == null || suffixValue !== rank) return null
  return base
}

/**
 * Derive a human-facing label for a ranked title series directly from its
 * catalog entries, without hardcoding any series id. It takes the lowest-rank
 * entry name and strips its trailing rank suffix (e.g. "Dungeon Pioneer I" ->
 * "Dungeon Pioneer"); when the lowest rank carries no safely recognizable rank
 * suffix it falls back to a humanized stable id.
 */
function rankedSeriesLabel(seriesId: string, sorted: CatalogItem[]): string {
  const lowest = sorted[0]
  if (lowest) {
    const rank = Number(
      (lowest.config?.improvement as { rank?: unknown } | undefined)?.rank
    )
    if (Number.isInteger(rank)) {
      const stripped = stripRankSuffix(lowest.name, rank)
      if (stripped) return stripped
    }
  }
  return humanizeStableId(seriesId)
}

function SkillOfferOptionDetails({
  option,
}: {
  option: CharacterDetail["skillOffers"][number]["options"][number]
}) {
  return (
    <div className="mt-1">
      <div className="flex flex-wrap gap-1">
        {option.rarity ? (
          <Badge variant="outline">{option.rarity}</Badge>
        ) : null}
        {option.skillType ? (
          <Badge variant="outline">
            {option.skillType[0]!.toUpperCase() + option.skillType.slice(1)}
          </Badge>
        ) : null}
        {option.classStableId ? (
          <Badge variant="outline">
            Class tie: {humanizeStableId(option.classStableId)}
          </Badge>
        ) : null}
      </div>
      <details className="text-xs text-muted-foreground">
        <summary className="w-fit cursor-pointer underline underline-offset-2">
          Description for {option.nameSnapshot}
        </summary>
        <p className="mt-1 whitespace-pre-wrap">
          {option.description || "No description available"}
        </p>
      </details>
    </div>
  )
}

/**
 * Humanize a single skill reference's name, falling back to a snapshot
 * stableId / id / definitionId when the name is absent. Used for upgrade
 * `from`/`to` refs and for the `definition` snapshot on select/grant payloads.
 */
function refSkillName(ref: Record<string, unknown>): string | undefined {
  if (typeof ref.name === "string" && ref.name.length > 0) return ref.name
  if (typeof ref.stableId === "string" && ref.stableId.length > 0)
    return humanizeStableId(ref.stableId)
  const id = typeof ref.id === "string" ? ref.id : ref.definitionId
  if (typeof id === "string" && id.length > 0) return humanizeStableId(id)
  return undefined
}

/**
 * The human-facing name for a direct skill_select / skill_grant event payload.
 * The service snapshots the selected/granted definition under `definition`
 * (name / stableId / id); when the name is absent the snapshot stableId or id is
 * humanized as a meaningful fallback.
 */
function definitionSkillName(
  payload: Record<string, unknown>
): string | undefined {
  return refSkillName(payloadRecord(payload.definition))
}

/**
 * The acquired-skill name for a grade-grant journal entry. A `granted` entry
 * carries `name`; an `upgraded` entry carries `toName` (the newly acquired
 * target). Falls back to the snapshot stableId.
 */
function journalSkillName(
  item: Record<string, unknown>,
  field: "granted" | "upgraded"
): string | undefined {
  if (field === "upgraded") {
    if (typeof item.toName === "string" && item.toName.length > 0)
      return item.toName
    if (typeof item.toStableId === "string" && item.toStableId.length > 0)
      return humanizeStableId(item.toStableId)
  }
  if (typeof item.name === "string" && item.name.length > 0) return item.name
  if (typeof item.stableId === "string" && item.stableId.length > 0)
    return humanizeStableId(item.stableId)
  return undefined
}

/**
 * Build the history label for a skill_select / skill_grant / skill_upgrade
 * event. select/grant read the definition name from `definition`; an upgrade
 * reads the from -> to names. "Skill" is used only when neither a name nor a
 * snapshot identifier is available.
 */
function skillEventLabel(
  kind: "skill_select" | "skill_grant" | "skill_upgrade",
  payload: Record<string, unknown>
): string {
  if (kind === "skill_upgrade") {
    const fromName = refSkillName(payloadRecord(payload.from)) ?? "Skill"
    const toName = refSkillName(payloadRecord(payload.to)) ?? "Skill"
    return `Skill upgraded: ${fromName} -> ${toName}`
  }
  const name = definitionSkillName(payload) ?? "Skill"
  return `${kind === "skill_select" ? "Skill selected" : "Skill granted"}: ${name}`
}

function skillHistoryEvents(events: ExportResponse["events"]) {
  const found: Array<{ date: string; label: string; key: string }> = []
  const addGrant = (
    payload: Record<string, unknown>,
    date: string,
    key: string
  ) => {
    // An import_history wrapper records the time the event was imported (`date`,
    // the wrapper's own createdAt) alongside the original event timestamp under
    // `sourceCreatedAt`. At each recursion level a valid `sourceCreatedAt`
    // supersedes the inherited date; a missing, invalid, or out-of-range one
    // falls back to it. A numeric `sourceCreatedAt` (epoch ms) is normalized to
    // UTC ISO. This keeps imported history sorted by the ORIGINAL event time,
    // never the import wrapper time.
    const effectiveDate = normalizeSourceDate(payload.sourceCreatedAt) ?? date
    const journal = payloadRecord(payload.journal)
    const grants = payloadRecord(payload.skillGrants ?? journal.skillGrants)
    for (const [field, label] of [
      ["granted", "Skill granted"],
      ["upgraded", "Skill upgraded"],
    ] as const) {
      const values = grants[field]
      if (Array.isArray(values))
        values.forEach((value, index) => {
          const item = payloadRecord(value)
          if (
            item.noop === true ||
            item.skipped === true ||
            item.superseded === true ||
            ["noop", "skipped", "superseded"].includes(String(item.status))
          )
            return
          const name = journalSkillName(item, field) ?? "Skill"
          found.push({
            date: effectiveDate,
            label: `${label}: ${name}`,
            key: `${key}-${field}-${index}`,
          })
        })
    }
    if (
      payload.sourceKind === "import_history" ||
      ["create", "profession_set", "evolve"].includes(
        String(payload.sourceKind)
      )
    )
      addGrant(
        payloadRecord(payload.sourcePayload),
        effectiveDate,
        `${key}-source`
      )
    else if (
      ["skill_select", "skill_grant", "skill_upgrade"].includes(
        String(payload.sourceKind)
      )
    ) {
      const imported = payloadRecord(payload.sourcePayload)
      if (
        imported.noop === true ||
        imported.skipped === true ||
        imported.superseded === true ||
        ["noop", "skipped", "superseded"].includes(String(imported.status))
      )
        return
      const sourceKind = String(payload.sourceKind) as
        "skill_select" | "skill_grant" | "skill_upgrade"
      found.push({
        date: effectiveDate,
        label: skillEventLabel(sourceKind, imported),
        key: `${key}-source-event`,
      })
    }
  }
  for (const [eventIndex, event] of events.entries()) {
    const payload = payloadRecord(event.payload)
    const status = payload.status
    if (
      payload.noop === true ||
      payload.skipped === true ||
      payload.superseded === true ||
      status === "noop" ||
      status === "skipped" ||
      status === "superseded"
    )
      continue
    if (
      event.kind === "skill_select" ||
      event.kind === "skill_grant" ||
      event.kind === "skill_upgrade"
    ) {
      found.push({
        date: event.createdAt,
        label: skillEventLabel(
          event.kind as "skill_select" | "skill_grant" | "skill_upgrade",
          payload
        ),
        key: `${event.kind}-${eventIndex}`,
      })
    }
    if (["create", "profession_set", "evolve"].includes(event.kind))
      addGrant(payload, event.createdAt, `${event.kind}-${eventIndex}`)
    if (event.kind === "import_history" && payload.sourceKind)
      addGrant(payload, event.createdAt, `import-${eventIndex}`)
  }
  return found.sort((a, b) => b.date.localeCompare(a.date))
}

function eventsForTrack(
  events: ExportResponse["events"],
  track: "race" | "class" | "profession"
) {
  return events.filter((event) => {
    const payload = payloadRecord(event.payload)
    if (event.kind === "create") return true
    if (event.kind === "profession_set") return track === "profession"
    if (event.kind === "experience_set" || event.kind === "level_undo") {
      const changedTrack = payload.track
      if (changedTrack === track) return true
      const journal = payloadRecord(payload.journal)
      return (
        track === "race" &&
        (changedTrack === "class" || changedTrack === "profession") &&
        (journal.raceLevelBefore !== undefined ||
          journal.raceLevelAfter !== undefined)
      )
    }
    if (event.kind === "advance" || event.kind === "evolve") {
      const changedTrack = payload.track
      if (changedTrack === track) return true
      // A grade-only evolution carries no payload.track; it is inherently a race
      // grade change and belongs only in race history. An explicit
      // payload.track === "race" is handled by the changedTrack check above.
      if (event.kind === "evolve" && changedTrack == null)
        return track === "race"
      const journal = payloadRecord(payload.journal)
      return (
        track === "race" &&
        (changedTrack === "class" || changedTrack === "profession") &&
        (journal.raceLevelBefore !== undefined ||
          journal.raceLevelAfter !== undefined)
      )
    }
    if (event.kind === "skill_select" || event.kind === "skill_grant")
      return payload.track === track
    return false
  })
}

/**
 * A profession is assignable only when its catalog row grade equals the
 * character's current race grade AND its config declares a grade entry for that
 * exact grade. Both facts must hold; a valid grade with no config entry, or a
 * config entry with a mismatched grade, is not offered.
 */
function professionEligible(p: CatalogItem, currentGrade: Grade): boolean {
  const grades = p.config?.grades as Record<string, unknown> | undefined
  return p.grade === currentGrade && grades?.[currentGrade] != null
}

function slotFor(item: CatalogItem): string | undefined {
  const slot = item.config?.slot
  return typeof slot === "string"
    ? (normalizeEquipmentSlot(slot) ?? undefined)
    : undefined
}

function isRing(item: CatalogItem): boolean {
  return slotFor(item) === "Ring"
}

function percentBonusFor(item: CatalogItem): string {
  const pct = item.config?.percentBasisPoints as
    Partial<Record<AttributeKey, number>> | undefined
  if (!pct) return "0"
  const entries = ATTRIBUTE_KEYS.filter((key) => (pct[key] ?? 0) !== 0)
  return entries.length
    ? entries
        .map((key) => `${key}:${((pct[key] ?? 0) / 100).toFixed(2)}%`)
        .join(", ")
    : "0"
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

/**
 * Right-hand panel for attaching/removing titles and equipment. It lists the
 * real catalog entries and calls the associations endpoint with the current
 * character version. Equipment is equipped directly onto the character - it is
 * inventory claim by itself. Equipment actions require owned stock. The caps noted here
 * are house assumptions (20% per attribute / 15% overall), documented in
 * docs/rules/assumptions.md.
 */
function AssociationSheet({
  panel,
  open,
  onOpenChange,
  associationTab,
  onAssociationTabChange,
  character,
  titles,
  equipment,
  blessings,
  bloodlines,
  transcendentSkills,
  maxTranscendentSkills,
  creationRulesError,
  onRetryCreationRules,
  loading,
  busy,
  onAdd,
  onRemove,
  onPowerAdd,
  onPowerRemove,
  skillOffers,
  focusedOfferId,
  onSelectSkill,
  onRetrySkills,
  inventoryContent,
}: {
  panel: "titlesSkills" | "powers" | "inventoryEquipment"
  open: boolean
  onOpenChange: (open: boolean) => void
  associationTab: string
  onAssociationTabChange: (value: string) => void
  character: CharacterDetail
  titles: CatalogItem[]
  equipment: CatalogItem[]
  blessings: CatalogItem[]
  bloodlines: CatalogItem[]
  transcendentSkills: CatalogItem[]
  maxTranscendentSkills: number | null
  creationRulesError: string | null
  onRetryCreationRules: () => void
  loading: boolean
  busy: boolean
  onAdd: (
    kind: "title" | "equipment",
    definitionId: string,
    reason?: string,
    equipmentPosition?: "Ring 1" | "Ring 2"
  ) => void
  onRemove: (kind: "title" | "equipment", definitionId: string) => void
  onPowerAdd: (
    kind: "blessing" | "bloodline" | "transcendent",
    definitionId: string,
    tier?: string
  ) => void
  onPowerRemove: (
    kind: "blessing" | "bloodline" | "transcendent",
    definitionId: string
  ) => void
  skillOffers: CharacterDetail["skillOffers"]
  focusedOfferId: string | null
  onSelectSkill: (offerId: string, definitionId: string, name: string) => void
  onRetrySkills: () => void
  inventoryContent?: React.ReactNode
}) {
  const [blessingTier, setBlessingTier] = React.useState("Minor")
  const [rankedClaim, setRankedClaim] = React.useState<CatalogItem | null>(null)
  const [rankedReason, setRankedReason] = React.useState("")
  const [titleSearch, setTitleSearch] = React.useState("")
  const [skillSearch, setSkillSearch] = React.useState("")
  const [expandedTitleSeries, setExpandedTitleSeries] = React.useState<
    Set<string>
  >(() => new Set())
  const [ringPositions, setRingPositions] = React.useState<
    Record<string, "Ring 1" | "Ring 2">
  >({})
  const [powerConfirmation, setPowerConfirmation] = React.useState<{
    kind: "blessing" | "bloodline" | "transcendent"
    definitionId: string
    tier?: string
    action: "add" | "remove"
    title: string
    description: string
  } | null>(null)
  const linked = new Map(character.associations.map((a) => [a.definitionId, a]))
  const equipmentStatusById = new Map(
    (character.status?.equipment.items ?? []).map((item) => [item.id, item])
  )
  const ownedQuantity = (definitionId: string) =>
    character.inventory?.find(
      (row) => row.definitionId === definitionId && !row.archived
    )?.quantity ?? 0

  function requestPowerAction(
    kind: "blessing" | "bloodline" | "transcendent",
    definitionId: string,
    action: "add" | "remove",
    tier?: string
  ) {
    const association = character.associations.find(
      (a) => a.kind === kind && a.definitionId === definitionId
    )
    const catalog =
      kind === "blessing"
        ? blessings
        : kind === "bloodline"
          ? bloodlines
          : transcendentSkills
    const item = catalog.find((entry) => entry.id === definitionId)
    const name = association?.name ?? item?.name ?? "this power"
    const displaced =
      action === "add"
        ? character.associations.filter(
            (a) => a.kind === kind && a.definitionId !== definitionId
          )
        : []
    const displacedNames = displaced.map(
      (a) => `${a.name}${a.definitionArchived ? " (archived, inert)" : ""}`
    )
    setPowerConfirmation({
      kind,
      definitionId,
      tier,
      action,
      title: action === "add" ? `Add ${name}?` : `Remove ${name}?`,
      description:
        action === "remove"
          ? `Remove ${name}${association?.tier && kind === "blessing" ? ` (${association.tier} tier)` : ""} from ${character.name}?`
          : displacedNames.length
            ? `${name} will replace ${displacedNames.join(", ")}. Continue?`
            : `Add ${kind === "blessing" && tier ? `${tier} ` : ""}${name} to ${character.name}?`,
    })
  }

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

  const titleSeries = React.useMemo(() => {
    const groups = new Map<string, CatalogItem[]>()
    for (const item of titles) {
      const improvement = item.config?.improvement as
        { seriesId?: unknown; rank?: unknown } | undefined
      if (
        typeof improvement?.seriesId !== "string" ||
        !Number.isInteger(improvement.rank)
      )
        continue
      const group = groups.get(improvement.seriesId) ?? []
      group.push(item)
      groups.set(improvement.seriesId, group)
    }
    return groups
  }, [titles])
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
            grade: a.grade ?? null,
            archived: a.definitionArchived,
            config: {},
          }) as CatalogItem
      ),
  ]

  // Archived linked titles honour the title search too: matching is
  // case-insensitive on the linked name plus any upgradeGroup / series id,
  // and an empty search keeps every archived row visible. The same predicate
  // drives both the rendered rows and the "No titles match" check so they
  // can never disagree about whether an archived row is on screen.
  function archivedLinkedTitleMatchesSearch(
    a: CharacterAssociationView
  ): boolean {
    const query = titleSearch.trim().toLocaleLowerCase()
    if (!query) return true
    return `${a.name} ${a.upgradeGroup ?? ""} ${a.improvement?.seriesId ?? ""}`
      .toLocaleLowerCase()
      .includes(query)
  }

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
          <p className="text-xs whitespace-pre-wrap text-muted-foreground">
            {a.grade
              ? (a.gradeDescription ?? "No description for this grade")
              : null}
          </p>
          <div className="text-[0.6875rem] text-muted-foreground">
            {a.kind === "equipment"
              ? `Slot: ${a.slot ?? "unspecified"}`
              : a.upgradeGroup
                ? `Upgrade group: ${a.upgradeGroup}`
                : "No upgrade group"}{" "}
            - linked but archived, no longer contributing.
          </div>
          {a.kind === "equipment" ? (
            <div className="flex flex-wrap items-center gap-1 text-[0.6875rem] text-muted-foreground">
              {a.rarity ? <Badge variant="outline">{a.rarity}</Badge> : null}
              {a.soulbound ? <Badge variant="outline">Soulbound</Badge> : null}
              {a.requirements?.minRaceLevel != null ? (
                <Badge variant="outline">
                  Min race level {a.requirements.minRaceLevel}
                </Badge>
              ) : null}
              {a.requirements?.requiredRaceType ? (
                <Badge variant="outline">
                  {a.requirements.requiredRaceType === "enlightened"
                    ? "Humanoid (enlightened)"
                    : "Monstrous (monster)"}
                </Badge>
              ) : null}
              {a.equipmentEligibility?.eligible === false ? (
                <>
                  <Badge variant="outline">Ineligible</Badge>
                  <span>
                    {a.equipmentEligibility.reason ??
                      "Equipment bonus inactive."}
                  </span>
                </>
              ) : null}
            </div>
          ) : null}
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
    const inventoryItem = character.inventory?.find(
      (row) => row.definitionId === item.id
    )
    const association = linked.get(item.id)
    const eligibility =
      inventoryItem?.equipmentEligibility ?? association?.equipmentEligibility
    return (
      <div
        key={item.id}
        className="flex items-center justify-between gap-3 rounded-lg border bg-input/20 p-2"
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate font-medium">{item.name}</span>
            <Badge variant="outline">
              {inventoryItem?.rarity ??
                (typeof item.config.rarity === "string"
                  ? item.config.rarity
                  : "Unknown")}
            </Badge>
            {inventoryItem?.soulbound ? (
              <Badge variant="outline">Soulbound</Badge>
            ) : null}
          </div>
          <p className="text-xs whitespace-pre-wrap text-muted-foreground">
            {association?.grade
              ? (association.gradeDescription ??
                "No description for this grade")
              : null}
          </p>
          <div className="text-[0.6875rem] text-muted-foreground">
            Rarity: {inventoryItem?.rarity ?? "Unknown"} - Slot:{" "}
            {slotFor(item) ?? "unspecified"}
            {association?.equipmentPosition
              ? ` (Position: ${association.equipmentPosition})`
              : ""}{" "}
            - Bonus: {bonusFor(item)}
            {item.config.percentBasisPoints
              ? ` - Percent: ${percentBonusFor(item)}`
              : ""}
          </div>
          {association ? (
            <div className="flex flex-wrap items-center gap-1 text-[0.6875rem] text-muted-foreground">
              {association.rarity ? (
                <Badge variant="outline">{association.rarity}</Badge>
              ) : null}
              {association.soulbound ? (
                <Badge variant="outline">Soulbound</Badge>
              ) : null}
              {association.requirements?.minRaceLevel != null ? (
                <Badge variant="outline">
                  Min race level {association.requirements.minRaceLevel}
                </Badge>
              ) : null}
              {association.requirements?.requiredRaceType ? (
                <Badge variant="outline">
                  {association.requirements.requiredRaceType === "enlightened"
                    ? "Humanoid (enlightened)"
                    : "Monstrous (monster)"}
                </Badge>
              ) : null}
              {eligibility?.eligible === false ? (
                <>
                  <Badge variant="outline">Ineligible</Badge>
                  <span>
                    {eligibility.reason ?? "Equipment bonus inactive."}
                  </span>
                </>
              ) : null}
            </div>
          ) : null}
          <div className="text-[0.6875rem] text-muted-foreground">
            {inventoryItem?.requirements?.minRaceLevel != null
              ? `Minimum race level ${inventoryItem.requirements.minRaceLevel}`
              : "No minimum race level"}
            {inventoryItem?.requirements?.requiredRaceType
              ? ` - ${inventoryItem.requirements.requiredRaceType === "enlightened" ? "Humanoid (enlightened)" : "Monstrous (monster)"}`
              : ""}
          </div>
          <div className="flex flex-wrap gap-1 text-[0.6875rem] text-muted-foreground">
            {inventoryItem?.soulbound ? (
              <Badge variant="outline">Soulbound</Badge>
            ) : null}
            {inventoryItem?.requirements?.minRaceLevel != null ? (
              <Badge variant="outline">
                Min race level {inventoryItem.requirements.minRaceLevel}
              </Badge>
            ) : null}
            {inventoryItem?.requirements?.requiredRaceType ? (
              <Badge variant="outline">
                {inventoryItem.requirements.requiredRaceType === "enlightened"
                  ? "Humanoid (enlightened)"
                  : "Monstrous (monster)"}
              </Badge>
            ) : null}
            {eligibility?.eligible === false ? (
              <Badge variant="outline">Ineligible</Badge>
            ) : null}
          </div>
          {eligibility?.eligible === false ? (
            <p className="text-[0.6875rem] text-muted-foreground">
              {eligibility.reason ?? "Requirements not met; bonus inactive."}
            </p>
          ) : null}
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
            title={
              eligibility?.eligible === false
                ? (eligibility.reason ?? "Equipment requirements not met")
                : undefined
            }
            onClick={() => onRemove("equipment", item.id)}
          >
            Remove
          </Button>
        ) : (
          <div className="flex flex-col items-end gap-1">
            {isRing(item) ? (
              <label className="text-xs">
                Equip position
                <select
                  aria-label={`Equip position for ${item.name}`}
                  value={ringPositions[item.id] ?? ""}
                  onChange={(event) =>
                    setRingPositions((current) => ({
                      ...current,
                      [item.id]: event.target.value as "Ring 1" | "Ring 2",
                    }))
                  }
                >
                  <option value="">Choose position</option>
                  <option value="Ring 1">Ring 1</option>
                  <option value="Ring 2">Ring 2</option>
                </select>
              </label>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              disabled={
                busy ||
                ownedQuantity(item.id) < 1 ||
                eligibility?.eligible === false ||
                (isRing(item) && !ringPositions[item.id])
              }
              title={
                ownedQuantity(item.id) < 1
                  ? "Add stock before equipping"
                  : eligibility?.eligible === false
                    ? (eligibility.reason ?? "Equipment requirements not met")
                    : isRing(item) && !ringPositions[item.id]
                      ? "Choose an equip position"
                      : undefined
              }
              onClick={() =>
                onAdd("equipment", item.id, undefined, ringPositions[item.id])
              }
            >
              {ownedQuantity(item.id) > 0 ? "Equip" : "Add stock first"}
            </Button>
          </div>
        )}
      </div>
    )
  }

  function titleRow(item: CatalogItem) {
    const isLinked = linked.has(item.id)
    const linkedAssociation = linked.get(item.id)
    const group = upgradeGroupFor(item)
    const improvement = item.config?.improvement as
      { seriesId?: unknown; rank?: unknown; minRaceGrade?: unknown } | undefined
    const isRanked =
      typeof improvement?.seriesId === "string" &&
      Number.isInteger(improvement.rank) &&
      typeof improvement.minRaceGrade === "string"
    const gradeIndex = (grade: unknown) => GRADE_ORDER.indexOf(grade as Grade)
    const gradeBlocked =
      isRanked &&
      (gradeIndex(character.state.race.grade) < 0 ||
        gradeIndex(character.state.race.grade) <
          gradeIndex(improvement?.minRaceGrade))
    const seriesLinks = isRanked
      ? character.associations.filter((a) => {
          if (a.kind !== "title") return false
          const catalogImprovement = titles.find((t) => t.id === a.definitionId)
            ?.config?.improvement as
            { seriesId?: string; rank?: number } | undefined
          const linkedImprovement = a.improvement ?? catalogImprovement
          return (
            linkedImprovement?.seriesId === improvement?.seriesId ||
            // Preserve the server's ambiguity guard: legacy linked titles
            // sharing a series upgradeGroup but lacking rank metadata make
            // the prior rank unknowable and therefore block progression.
            (!a.improvement &&
              !catalogImprovement &&
              a.upgradeGroup === improvement?.seriesId)
          )
        })
      : []
    const knownLinkedRanks = seriesLinks.map((a) => {
      const catalog = titles.find((t) => t.id === a.definitionId)
      return (
        a.improvement?.rank ??
        (catalog?.config?.improvement as { rank?: number } | undefined)?.rank
      )
    })
    const unknownLinkedRank = knownLinkedRanks.some(
      (rank) => !Number.isInteger(rank)
    )
    const currentRank = knownLinkedRanks
      .filter((rank): rank is number => Number.isInteger(rank))
      .sort((a, b) => b - a)[0]
    const nextRank = currentRank == null ? 1 : currentRank + 1
    // A legacy trusted import can link MULTIPLE titles in the same ranked
    // series (e.g. an archived prior rank beside an active one). The server
    // enforces an exactly-one-prior rule for a next-rank claim, so the claim is
    // ambiguous while more than one series link exists - even when the highest
    // rank is known. Keep the per-rank "Claim next rank" CTA inert in that case
    // instead of firing a doomed POST.
    const multipleLinkedRanks = seriesLinks.length > 1
    const rankIsNext =
      isRanked &&
      !unknownLinkedRank &&
      !multipleLinkedRanks &&
      improvement.rank === nextRank &&
      !isLinked
    return (
      <div
        key={item.id}
        className="flex items-center justify-between gap-3 rounded-lg border bg-input/20 p-2"
      >
        <div className="min-w-0">
          <div className="truncate font-medium">{item.name}</div>
          <p className="text-xs whitespace-pre-wrap text-muted-foreground">
            {linkedAssociation?.grade
              ? (linkedAssociation.gradeDescription ??
                "No description for this grade")
              : null}
          </p>
          <div className="text-[0.6875rem] text-muted-foreground">
            Flat: {titleFlatFor(item)} - Percent: {titlePercentFor(item)}
            {group ? <> - Upgrade group: {group}</> : null}
          </div>
          {isRanked ? (
            <div className="text-[0.6875rem] text-muted-foreground">
              Rank {String(improvement.rank)} / minimum race grade{" "}
              {String(improvement.minRaceGrade)}
              {multipleLinkedRanks
                ? " - Multiple linked ranks; resolve conflicting titles first"
                : null}
              {unknownLinkedRank
                ? " - linked prior rank details unavailable; retry catalog before claiming"
                : null}
              {!unknownLinkedRank &&
              !rankIsNext &&
              !isLinked &&
              !multipleLinkedRanks
                ? ` - ${gradeBlocked ? `Locked: race grade ${character.state.race.grade} is below ${String(improvement.minRaceGrade)}` : `Locked: only rank ${nextRank} is next`}`
                : null}
            </div>
          ) : null}
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
        ) : isRanked ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !rankIsNext || Boolean(gradeBlocked)}
            onClick={() => {
              setRankedReason("")
              setRankedClaim(item)
            }}
          >
            Claim next rank
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

  function rankedSeriesRow(seriesId: string, items: CatalogItem[]) {
    const sorted = [...items].sort((a, b) => {
      const ar = Number((a.config?.improvement as { rank?: number })?.rank)
      const br = Number((b.config?.improvement as { rank?: number })?.rank)
      return ar - br || a.name.localeCompare(b.name)
    })
    const links = character.associations.filter((a) => {
      if (a.kind !== "title") return false
      const catalog = titles.find((t) => t.id === a.definitionId)
      const imp =
        a.improvement ??
        (catalog?.config?.improvement as { seriesId?: string } | undefined)
      return (
        imp?.seriesId === seriesId ||
        (!a.improvement && !catalog && a.upgradeGroup === seriesId)
      )
    })
    // A legacy trusted import can link multiple titles in the SAME ranked series
    // (e.g. an archived prior rank beside an active one). The server enforces an
    // exactly-one-prior rule for a next-rank claim, so with more than one linked
    // rank the claim is ambiguous - even when the highest rank is known. Disable
    // the summary next-rank claim and explain instead of firing a doomed POST.
    const multipleLinked = links.length > 1
    const ranks = links.map((a) => {
      const catalog = titles.find((t) => t.id === a.definitionId)
      return (
        a.improvement?.rank ??
        (catalog?.config?.improvement as { rank?: number } | undefined)?.rank
      )
    })
    const unknown = ranks.some((rank) => !Number.isInteger(rank))
    const owned = ranks.filter((rank): rank is number => Number.isInteger(rank))
    const highest = owned.length ? Math.max(...owned) : 0
    const nextRank = highest + 1
    const nextItems = sorted.filter(
      (item) =>
        (item.config?.improvement as { rank?: number })?.rank === nextRank
    )
    const searchable =
      `${seriesId} ${sorted.map((item) => item.name).join(" ")}`.toLocaleLowerCase()
    if (
      titleSearch.trim() &&
      !searchable.includes(titleSearch.trim().toLocaleLowerCase())
    )
      return null
    const open =
      expandedTitleSeries.has(seriesId) || Boolean(titleSearch.trim())
    const displayItems = nextItems.length ? nextItems : sorted.slice(0, 1)
    const match = displayItems.length === 1 ? displayItems[0] : undefined
    const minGrade = match?.config?.improvement as
      { minRaceGrade?: string } | undefined
    const canClaim = Boolean(
      match &&
      !multipleLinked &&
      !linked.has(match.id) &&
      (match.config?.improvement as { rank?: number })?.rank === nextRank &&
      !unknown &&
      !gradeBlockedFor(match, character.state.race.grade)
    )
    return (
      <section key={seriesId} className="rounded-lg border bg-input/20 p-2">
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            aria-expanded={open}
            onClick={() =>
              setExpandedTitleSeries((current) => {
                const next = new Set(current)
                if (next.has(seriesId)) next.delete(seriesId)
                else next.add(seriesId)
                return next
              })
            }
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <ChevronRightIcon
              aria-hidden="true"
              className={cn(
                "size-4 shrink-0 transition-transform",
                open && "rotate-90"
              )}
            />
            <span className="truncate font-medium">
              {rankedSeriesLabel(seriesId, sorted)}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {highest ? `Rank ${highest}` : "No ranks"} / {sorted.length}
            </span>
          </button>
          {highest >=
          Math.max(
            ...sorted.map((item) =>
              Number((item.config?.improvement as { rank?: number })?.rank)
            )
          ) ? (
            <Badge variant="outline">Complete</Badge>
          ) : nextItems.length > 1 ? (
            <span className="text-xs text-muted-foreground">
              Expand and choose
            </span>
          ) : match ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {multipleLinked
                  ? "Multiple linked ranks; resolve conflicting titles first"
                  : unknown
                    ? "linked prior rank details unavailable; retry catalog before claiming"
                    : `Rank ${String((match.config?.improvement as { rank?: number })?.rank)} / minimum race grade ${minGrade?.minRaceGrade ?? "?"}`}
                {!multipleLinked && !canClaim
                  ? gradeBlockedFor(match, character.state.race.grade)
                    ? ` - Locked: race grade ${character.state.race.grade} is below ${minGrade?.minRaceGrade}`
                    : unknown
                      ? ""
                      : ` - Locked: only rank ${nextRank} is next`
                  : ""}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !canClaim}
                title={
                  !canClaim
                    ? multipleLinked
                      ? "Multiple linked ranks for this series; resolve conflicting titles before claiming the next rank"
                      : "Next rank is unavailable until grade and prior-rank requirements are met"
                    : undefined
                }
                onClick={() => {
                  setRankedReason("")
                  setRankedClaim(match)
                }}
              >
                Claim next rank
              </Button>
            </div>
          ) : null}
        </div>
        {open ? (
          <div className="mt-2 flex flex-col gap-2 border-l pl-3">
            {sorted
              .filter(
                (item) =>
                  !titleSearch.trim() ||
                  `${item.name} ${seriesId}`
                    .toLocaleLowerCase()
                    .includes(titleSearch.trim().toLocaleLowerCase())
              )
              .map(titleRow)}
          </div>
        ) : null}
      </section>
    )
  }

  function gradeBlockedFor(item: CatalogItem, grade: Grade) {
    const improvement = item.config?.improvement as
      { minRaceGrade?: string } | undefined
    return (
      GRADE_ORDER.indexOf(grade) < 0 ||
      GRADE_ORDER.indexOf(grade) <
        GRADE_ORDER.indexOf(improvement?.minRaceGrade as Grade)
    )
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex max-h-dvh flex-col gap-4 overflow-hidden">
        <SheetHeader>
          <SheetTitle className="sr-only">
            {panel === "titlesSkills"
              ? "Titles and skills"
              : panel === "powers"
                ? "Blessings and bloodlines"
                : "Inventory and equipment"}
          </SheetTitle>
        </SheetHeader>

        <Tabs
          value={associationTab}
          onValueChange={(value) => {
            if (value) onAssociationTabChange(value)
          }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList variant="line">
            {panel === "titlesSkills" ? (
              <>
                <TabsTrigger value="titles">Titles</TabsTrigger>
                <TabsTrigger value="skills">Skills</TabsTrigger>
              </>
            ) : null}
            {panel === "inventoryEquipment" ? (
              <>
                <TabsTrigger value="inventory">Inventory</TabsTrigger>
                <TabsTrigger value="equipment">Equipment</TabsTrigger>
              </>
            ) : null}
            {panel === "powers" ? (
              <>
                <TabsTrigger value="blessings">Blessings</TabsTrigger>
                <TabsTrigger value="bloodlines">Bloodlines</TabsTrigger>
                <TabsTrigger value="transcendent">
                  Transcendent skills
                </TabsTrigger>
              </>
            ) : null}
          </TabsList>

          <ScrollArea className="min-h-0 flex-1">
            {panel === "titlesSkills" ? (
              <TabsContent value="titles" className="pt-3">
                {loading ? (
                  <p className="text-xs text-muted-foreground">
                    Loading titles...
                  </p>
                ) : titles.length === 0 && archivedLinkedTitles.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No titles in the catalog yet.
                  </p>
                ) : (
                  <div className="flex max-h-[65dvh] flex-col gap-2 overflow-y-auto pr-1">
                    <Label htmlFor="title-search" className="sr-only">
                      Search titles
                    </Label>
                    <Input
                      id="title-search"
                      aria-label="Search titles by series or name"
                      placeholder="Search titles by series or name"
                      value={titleSearch}
                      onChange={(event) => setTitleSearch(event.target.value)}
                    />
                    {titles
                      .filter((item) => {
                        const improvement = item.config?.improvement as
                          { seriesId?: unknown; rank?: unknown } | undefined
                        return !(
                          typeof improvement?.seriesId === "string" &&
                          Number.isInteger(improvement.rank)
                        )
                      })
                      .filter(
                        (item) =>
                          !titleSearch.trim() ||
                          item.name
                            .toLocaleLowerCase()
                            .includes(titleSearch.trim().toLocaleLowerCase())
                      )
                      .map(titleRow)}
                    {[...titleSeries].map(([seriesId, items]) =>
                      rankedSeriesRow(seriesId, items)
                    )}
                    {titleSearch.trim() &&
                    !titles.some((item) => {
                      const improvement = item.config?.improvement as
                        { seriesId?: unknown; rank?: unknown } | undefined
                      return typeof improvement?.seriesId !== "string" ||
                        !Number.isInteger(improvement.rank)
                        ? item.name
                            .toLocaleLowerCase()
                            .includes(titleSearch.trim().toLocaleLowerCase())
                        : `${improvement.seriesId} ${item.name}`
                            .toLocaleLowerCase()
                            .includes(titleSearch.trim().toLocaleLowerCase())
                    }) &&
                    !archivedLinkedTitles.some(
                      archivedLinkedTitleMatchesSearch
                    ) ? (
                      <p
                        role="status"
                        className="text-xs text-muted-foreground"
                      >
                        No titles match your search.
                      </p>
                    ) : null}
                    {archivedLinkedTitles
                      .filter(archivedLinkedTitleMatchesSearch)
                      .map(archivedLinkedRow)}
                  </div>
                )}
              </TabsContent>
            ) : null}
            {panel === "titlesSkills" ? (
              <TabsContent value="skills" className="pt-3">
                <div className="flex flex-col gap-3">
                  <h2 className="font-medium">Skill choices</h2>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="offered-skills-search">
                      Search offered skills
                    </Label>
                    <Input
                      id="offered-skills-search"
                      type="search"
                      value={skillSearch}
                      onChange={(event) => setSkillSearch(event.target.value)}
                      placeholder="Name, rarity, type, or class"
                    />
                  </div>
                  <div
                    className="flex flex-wrap gap-2"
                    aria-label="Unspent skill selections"
                  >
                    {(["race", "class", "profession"] as const).map((track) => (
                      <Badge key={track} variant="outline">
                        {track[0]!.toUpperCase() + track.slice(1)}:{" "}
                        {
                          skillOffers.filter(
                            (offer) =>
                              offer.track === track &&
                              !offer.selectedDefinitionId &&
                              !offer.canceledAt
                          ).length
                        }{" "}
                        pending
                      </Badge>
                    ))}
                  </div>
                  {skillOffers.filter(
                    (offer) => !offer.selectedDefinitionId && !offer.canceledAt
                  ).length > 0 ? (
                    <div className="flex flex-col gap-2">
                      {skillOffers
                        .filter(
                          (offer) =>
                            !offer.selectedDefinitionId && !offer.canceledAt
                        )
                        .map((offer) => {
                          const eligible = offer.options.filter(
                            (option) => !option.archived
                          )
                          return (
                            <section
                              key={offer.id}
                              id={`skill-offer-${offer.id}`}
                              className={cn(
                                "flex flex-col gap-2 rounded-lg border bg-input/20 p-3",
                                focusedOfferId === offer.id &&
                                  "ring-2 ring-primary"
                              )}
                              aria-label={`${offer.track} level ${offer.level} skill offer`}
                            >
                              <h3 className="font-medium">
                                {offer.track[0]!.toUpperCase() +
                                  offer.track.slice(1)}{" "}
                                level {offer.level} - {offer.choiceGroup}
                              </h3>
                              {eligible.length === 0 ? (
                                <div className="flex flex-col items-start gap-2">
                                  <p className="text-xs text-muted-foreground">
                                    No eligible skill options are available yet.
                                  </p>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={onRetrySkills}
                                  >
                                    Retry refresh
                                  </Button>
                                </div>
                              ) : null}
                              <div
                                className="max-h-[min(20rem,50vh)] overflow-y-auto overscroll-contain"
                                tabIndex={0}
                                aria-label="Skill offer options"
                              >
                                {offer.options
                                  .filter((option) => {
                                    const query = skillSearch
                                      .trim()
                                      .toLocaleLowerCase()
                                    return (
                                      !query ||
                                      [
                                        option.nameSnapshot,
                                        option.rarity,
                                        option.skillType,
                                        option.classStableId,
                                      ]
                                        .filter(Boolean)
                                        .some((value) =>
                                          value!
                                            .toLocaleLowerCase()
                                            .includes(query)
                                        )
                                    )
                                  })
                                  .map((option) => (
                                    <div
                                      key={option.definitionId}
                                      className="flex items-center justify-between gap-3 rounded-md border bg-background/40 p-2"
                                    >
                                      <div className="flex flex-wrap items-center gap-1.5 font-medium">
                                        <span>{option.nameSnapshot}</span>
                                        {option.grade ? (
                                          <Badge variant="outline">
                                            {option.grade}
                                          </Badge>
                                        ) : null}
                                        {option.classPriority ? (
                                          <Badge variant="outline">
                                            Class match
                                          </Badge>
                                        ) : null}
                                        {option.archived ? (
                                          <Badge variant="outline">
                                            Archived
                                          </Badge>
                                        ) : null}
                                      </div>
                                      <SkillOfferOptionDetails
                                        option={option}
                                      />
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={busy || option.archived}
                                        onClick={() =>
                                          onSelectSkill(
                                            offer.id,
                                            option.definitionId,
                                            option.nameSnapshot
                                          )
                                        }
                                      >
                                        Select
                                      </Button>
                                    </div>
                                  ))}
                                {offer.options.length > 0 &&
                                !offer.options.some((option) => {
                                  const query = skillSearch
                                    .trim()
                                    .toLocaleLowerCase()
                                  return (
                                    !query ||
                                    [
                                      option.nameSnapshot,
                                      option.rarity,
                                      option.skillType,
                                      option.classStableId,
                                    ]
                                      .filter(Boolean)
                                      .some((value) =>
                                        value!
                                          .toLocaleLowerCase()
                                          .includes(query)
                                      )
                                  )
                                }) ? (
                                  <p
                                    role="status"
                                    className="py-2 text-xs text-muted-foreground"
                                  >
                                    No offered skills match your search.
                                  </p>
                                ) : null}
                              </div>
                            </section>
                          )
                        })}
                    </div>
                  ) : null}
                </div>
              </TabsContent>
            ) : null}

            {panel === "inventoryEquipment" ? (
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
                  pre-equipment value per attribute (aggregate, not per item)
                  and 15% of the total across all attributes. Suppressed values
                  above are what these caps reject.
                </p>
              </TabsContent>
            ) : null}
            {panel === "inventoryEquipment" ? (
              <TabsContent value="inventory" className="pt-3">
                {inventoryContent}
              </TabsContent>
            ) : null}

            {panel === "powers"
              ? (["blessing", "bloodline"] as const).map((kind) => {
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
                      {kind === "blessing" ? (
                        <div className="mb-3 flex flex-col gap-2">
                          <Label htmlFor="association-blessing-tier">
                            Blessing tier
                          </Label>
                          <Select
                            value={blessingTier}
                            onValueChange={(value) => {
                              if (value) setBlessingTier(value)
                            }}
                          >
                            <SelectTrigger
                              id="association-blessing-tier"
                              aria-label="Blessing tier"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {(
                                  [
                                    "Baptism",
                                    "Minor",
                                    "Lesser",
                                    "Intermediate",
                                    "Major",
                                    "Greater",
                                    "Divine",
                                    "True",
                                  ] as const
                                ).map((tier) => (
                                  <SelectItem key={tier} value={tier}>
                                    {tier}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </div>
                      ) : null}
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
                            return (
                              <div
                                key={item.id}
                                className="flex items-center justify-between gap-3 rounded-lg border bg-input/20 p-2"
                              >
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="font-medium">
                                      {kind === "blessing" && association?.tier
                                        ? `${association.tier} Blessing of ${item.name}`
                                        : item.name}
                                    </span>
                                    {item.grade ? (
                                      <Badge variant="outline">
                                        {item.grade}
                                      </Badge>
                                    ) : null}
                                    {item.archived ? (
                                      <Badge variant="outline">
                                        Archived - inert
                                      </Badge>
                                    ) : null}
                                  </div>
                                  <p className="text-xs whitespace-pre-wrap text-muted-foreground">
                                    {association?.grade
                                      ? (association.gradeDescription ??
                                        "No description for this grade")
                                      : null}
                                  </p>
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
                                    onClick={() =>
                                      requestPowerAction(
                                        kind,
                                        item.id,
                                        "remove"
                                      )
                                    }
                                  >
                                    Remove
                                  </Button>
                                ) : item.archived ? null : (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={busy}
                                    onClick={() =>
                                      requestPowerAction(
                                        kind,
                                        item.id,
                                        "add",
                                        kind === "blessing"
                                          ? blessingTier
                                          : undefined
                                      )
                                    }
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
                })
              : null}
            {panel === "powers" ? (
              <TabsContent value="transcendent" className="pt-3">
                <div className="mb-3 flex flex-col gap-2">
                  <p className="text-xs text-muted-foreground">
                    Selected{" "}
                    {
                      character.associations.filter(
                        (a) => a.kind === "transcendent"
                      ).length
                    }{" "}
                    / maximum {maxTranscendentSkills ?? "unavailable"}
                  </p>
                  {creationRulesError ? (
                    <Alert variant="destructive">
                      <div className="flex flex-col gap-2">
                        <span>{creationRulesError}</span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={onRetryCreationRules}
                        >
                          Retry rules
                        </Button>
                      </div>
                    </Alert>
                  ) : null}
                </div>
                {loading ? (
                  <p className="text-xs text-muted-foreground">
                    Loading transcendent skills...
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {transcendentOptions.map((item) => {
                      const association = character.associations.find(
                        (a) =>
                          a.kind === "transcendent" &&
                          a.definitionId === item.id
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
                            <p className="text-xs whitespace-pre-wrap text-muted-foreground">
                              {association?.grade
                                ? (association.gradeDescription ??
                                  "No description for this grade")
                                : null}
                            </p>
                            {item.sourceUrl ? (
                              <p className="text-[0.6875rem] text-muted-foreground">
                                <a
                                  className="underline"
                                  href={item.sourceUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Source
                                </a>
                              </p>
                            ) : null}
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
                              onClick={() =>
                                requestPowerAction(
                                  "transcendent",
                                  item.id,
                                  "remove"
                                )
                              }
                            >
                              Remove
                            </Button>
                          ) : item.archived ? null : (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={
                                busy ||
                                maxTranscendentSkills == null ||
                                character.associations.filter(
                                  (a) => a.kind === "transcendent"
                                ).length >= maxTranscendentSkills
                              }
                              onClick={() =>
                                requestPowerAction(
                                  "transcendent",
                                  item.id,
                                  "add"
                                )
                              }
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
            ) : null}
          </ScrollArea>
        </Tabs>
        <Dialog
          open={rankedClaim !== null}
          onOpenChange={(open) => {
            if (!open) setRankedClaim(null)
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Claim next rank</DialogTitle>
              <DialogDescription>
                This is a self-reported qualifying first-clear claim; it is not
                automatically verified.
                {rankedClaim
                  ? ` Rank ${(rankedClaim.config?.improvement as { rank: number }).rank}; configured bonus: Flat ${titleFlatFor(rankedClaim)} / Percent ${titlePercentFor(rankedClaim)}.`
                  : ""}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor="ranked-first-clear">
                Qualifying first-clear details
              </Label>
              <Input
                id="ranked-first-clear"
                maxLength={500}
                value={rankedReason}
                onChange={(event) => setRankedReason(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {rankedReason.length}/500 characters
              </p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRankedClaim(null)}>
                Cancel
              </Button>
              <Button
                disabled={
                  busy || !rankedReason.trim() || rankedReason.length > 500
                }
                onClick={() => {
                  if (rankedClaim)
                    onAdd("title", rankedClaim.id, rankedReason.trim())
                  setRankedClaim(null)
                }}
              >
                Confirm claim
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <AlertDialog
          open={powerConfirmation !== null}
          onOpenChange={(open) => {
            if (!open && !busy) setPowerConfirmation(null)
          }}
        >
          <AlertDialogContent>
            <AlertDialogTitle>{powerConfirmation?.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {powerConfirmation?.description}
            </AlertDialogDescription>
            <div className="flex justify-end gap-2">
              <AlertDialogClose
                render={<Button variant="outline" disabled={busy} />}
              >
                Cancel
              </AlertDialogClose>
              <Button
                disabled={busy || !powerConfirmation}
                onClick={() => {
                  if (!powerConfirmation || busy) return
                  const pending = powerConfirmation
                  setPowerConfirmation(null)
                  if (pending.action === "add")
                    onPowerAdd(pending.kind, pending.definitionId, pending.tier)
                  else onPowerRemove(pending.kind, pending.definitionId)
                }}
              >
                Confirm
              </Button>
            </div>
          </AlertDialogContent>
        </AlertDialog>
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
  const [inventoryRingPositions, setInventoryRingPositions] = React.useState<
    Record<string, "Ring 1" | "Ring 2">
  >({})
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [activeTab, setActiveTab] = React.useState("overview")
  const [journal, setJournal] = React.useState<JournalDelta | null>(null)
  const [journalOpen, setJournalOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [experienceDrafts, setExperienceDrafts] = React.useState<
    Record<string, number>
  >({})
  const [events, setEvents] = React.useState<ExportResponse["events"] | null>(
    null
  )
  const [eventsError, setEventsError] = React.useState(false)
  const [eventsLoading, setEventsLoading] = React.useState(false)
  const [eventsRetry, setEventsRetry] = React.useState(0)
  const [notes, setNotes] = React.useState({
    name: "",
    description: "",
    nickname: "",
    pronouns: "",
    ageDescription: "",
    appearance: "",
    biography: "",
    notes: "",
  })
  const [savingNotes, setSavingNotes] = React.useState(false)
  const [trackEvolveTrack, setTrackEvolveTrack] = React.useState<
    "race" | "class" | "profession" | null
  >(null)
  const [activeAssociationPanel, setActiveAssociationPanel] = React.useState<
    "titlesSkills" | "powers" | "inventoryEquipment" | null
  >(null)
  const [associationTabs, setAssociationTabs] = React.useState({
    titlesSkills: "titles",
    powers: "blessings",
    inventoryEquipment: "equipment",
  })
  const [titlesCatalog, setTitlesCatalog] = React.useState<CatalogItem[]>([])
  const [equipmentCatalog, setEquipmentCatalog] = React.useState<CatalogItem[]>(
    []
  )
  const [itemsCatalog, setItemsCatalog] = React.useState<CatalogItem[]>([])
  const [blessingsCatalog, setBlessingsCatalog] = React.useState<CatalogItem[]>(
    []
  )
  const [bloodlinesCatalog, setBloodlinesCatalog] = React.useState<
    CatalogItem[]
  >([])
  const [transcendentCatalog, setTranscendentCatalog] = React.useState<
    CatalogItem[]
  >([])
  const [maxTranscendentSkills, setMaxTranscendentSkills] = React.useState<
    number | null
  >(null)
  const [creationRulesError, setCreationRulesError] = React.useState<
    string | null
  >(null)
  const [catalogLoading, setCatalogLoading] = React.useState(false)
  const [assocBusy, setAssocBusy] = React.useState(false)
  const [skillsCatalog, setSkillsCatalog] = React.useState<CatalogItem[]>([])
  const [skillBusy, setSkillBusy] = React.useState(false)
  const [upgradeSource, setUpgradeSource] =
    React.useState<CharacterAssociationView | null>(null)
  const [upgradeTargetId, setUpgradeTargetId] = React.useState("")
  const [upgradeSearch, setUpgradeSearch] = React.useState("")
  const [upgradeReason, setUpgradeReason] = React.useState("")
  const [selectConfirm, setSelectConfirm] = React.useState<{
    offerId: string
    definitionId: string
    name: string
  } | null>(null)
  const [levelUpOfferId, setLevelUpOfferId] = React.useState<string | null>(
    null
  )
  const [focusedSkillOfferId, setFocusedSkillOfferId] = React.useState<
    string | null
  >(null)
  const [skillRefreshError, setSkillRefreshError] = React.useState(false)
  const refreshOnOpen = React.useRef<string | null>(null)
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
  const [inventoryUseItem, setInventoryUseItem] = React.useState<
    NonNullable<CharacterDetail["inventory"]>[number] | null
  >(null)
  const [inventoryDefinitionId, setInventoryDefinitionId] = React.useState("")
  const [inventorySearch, setInventorySearch] = React.useState("")
  const [inventoryQuantity, setInventoryQuantity] = React.useState("")
  const [inventorySourceNote, setInventorySourceNote] = React.useState("")
  const [inventoryBusy, setInventoryBusy] = React.useState(false)
  const [professionOptions, setProfessionOptions] = React.useState<
    CatalogItem[]
  >([])
  const [professionChoice, setProfessionChoice] = React.useState("")
  const [professionBusy, setProfessionBusy] = React.useState(false)
  const [inventoryError, setInventoryError] = React.useState<string | null>(
    null
  )

  // Last character name reported upstream to the breadcrumb. Used to fire
  // onNameChange only when the successfully fetched name actually changes,
  // never on every render.
  const lastReportedName = React.useRef<string | null>(null)
  const currentCharacter = React.useRef(character)
  // Tracks whether the editable notes/profile form has unsaved edits, so an
  // unrelated same-version refresh does not reset an in-progress draft.
  const notesDirty = React.useRef(false)
  // The latest route id, kept in a ref so an async callback that started for a
  // previous route (e.g. a slow refresh for character A) can detect the route
  // changed to B and ignore its response instead of reverting the sheet.
  const activeCharacterIdRef = React.useRef(id)
  // Monotonic sequence per async operation. A response only applies when it is
  // still the latest request for the active route, so a late response from a
  // superseded request (or a stale route) cannot overwrite a newer one.
  const refreshRequestRef = React.useRef(0)
  const reloadRequestRef = React.useRef(0)
  // Cross-request monotonic sequence shared by character GET/reload and
  // skills/refresh. Each request stamps a start sequence (requestSeqRef); the
  // sequence of the last successfully applied snapshot (lastAppliedSeqRef) is
  // recorded so a same-version response from a request that began BEFORE a newer
  // snapshot was applied - a stale GET/refresh - cannot roll back live mutable
  // metadata such as an offer option's `archived` flag. The request counter never
  // resets (it stays monotonic for the component's lifetime); only the recorded
  // last-applied sequence is reset to 0 when the route id changes, so a value
  // from character A can never mark character B's snapshots as stale.
  const requestSeqRef = React.useRef(0)
  const lastAppliedSeqRef = React.useRef(0)

  // Set the notes/profile form from a server snapshot only when it is safe to do
  // so: never with a stale (older) snapshot, never for a different character id
  // (treated as fresh), and never while the user has an unsaved edit on an
  // unrelated same-version refresh. `currentRef` must be the accepted ref read
  // BEFORE applyCharacter mutates it, otherwise a stale response can pass its own
  // version check and clobber notes.
  const applyNotesIfFresh = React.useCallback(
    (
      currentRef: CharacterDetail | null,
      incoming: CharacterDetail,
      requestSeq: number
    ) => {
      // A snapshot is fresh only if it is newer (version), for a different
      // character id (route change, treated as fresh), or a same-version snapshot
      // that is NOT stale - i.e. its request began at or after the last applied
      // snapshot. A stale same-version request must not clobber the profile form
      // with older values.
      const fresh =
        !currentRef ||
        currentRef.id !== incoming.id ||
        incoming.version > currentRef.version ||
        (incoming.version === currentRef.version &&
          !notesDirty.current &&
          requestSeq >= lastAppliedSeqRef.current)
      if (!fresh) return
      notesDirty.current = false
      setNotes({
        name: incoming.name,
        description: incoming.description ?? "",
        nickname: incoming.nickname ?? "",
        pronouns: incoming.pronouns ?? "",
        ageDescription: incoming.ageDescription ?? "",
        appearance: incoming.appearance ?? "",
        biography: incoming.biography ?? "",
        notes: incoming.notes ?? "",
      })
    },
    []
  )

  // A single notes/profile field edit marks the form dirty (so an unrelated
  // same-version refresh does not reset it) and applies the patch.
  const updateNotes = React.useCallback((patch: Partial<typeof notes>) => {
    notesDirty.current = true
    setNotes((n) => ({ ...n, ...patch }))
  }, [])

  // Ignore older snapshots from refreshes that resolve after a mutation. A
  // snapshot for a different character id is always treated as fresh (the
  // component is reused across route params, so the ref/state can otherwise
  // hold the previous character).
  const applyCharacter = React.useCallback(
    (incoming: CharacterDetail, requestSeq: number) => {
      const current = currentCharacter.current
      // A same-version snapshot is stale when its request began BEFORE the last
      // successfully applied snapshot (it was issued while an even newer GET or
      // refresh was still in flight). Such a response must not roll back live
      // mutable metadata, e.g. an offer option's `archived` flag. Unlike the
      // previous behavior it is not discarded outright: it may still contribute
      // append-only offer/option additions, so it is merged rather than ignored.
      const staleSameVersion =
        current != null &&
        current.id === incoming.id &&
        incoming.version === current.version &&
        requestSeq < lastAppliedSeqRef.current
      // Apply the snapshot when there is no baseline, the route id differs
      // (treated as fresh), the version strictly increases (apply regardless of
      // ordering), or it is a same-version request (whether stale or not - a
      // stale same-version response contributes only append-only additions
      // rather than being ignored).
      const shouldApply =
        current == null ||
        current.id !== incoming.id ||
        incoming.version > current.version ||
        incoming.version === current.version
      if (!shouldApply) return
      // Only a non-stale snapshot replaces the authoritative ref and advances the
      // last-applied sequence. A stale same-version response is append-only: it
      // must neither clobber the ref with an (possibly older) snapshot nor
      // regress the sequence counter.
      if (!staleSameVersion) {
        currentCharacter.current = incoming
        lastAppliedSeqRef.current = requestSeq
      }
      setCharacter((current) => {
        if (!current || current.id !== incoming.id) return incoming
        if (incoming.version > current.version) return incoming
        if (incoming.version < current.version) return current
        if (staleSameVersion) {
          // Stale same-version snapshot: preserve every current field, the
          // existing offer's mutable flags / terminal status / immutable
          // snapshot(s), and option state. Append ONLY offer ids and options
          // absent from the current state from the incoming snapshot
          // (append-only additions). Never overwrite an existing option's
          // `archived` flag from a stale response; a newly seen option may carry
          // its archived value.
          const currentOffers = current.skillOffers ?? []
          const incomingOffers = incoming.skillOffers ?? []
          const currentOfferById = new Map(
            currentOffers.map((offer) => [offer.id, offer])
          )
          const merged = [...currentOffers]
          for (const offer of incomingOffers) {
            const prior = currentOfferById.get(offer.id)
            if (!prior) {
              merged.push(offer)
              continue
            }
            const priorOptions = prior.options ?? []
            const priorOptionIds = new Set(
              priorOptions.map((option) => option.definitionId)
            )
            const additions = (offer.options ?? []).filter(
              (option) => !priorOptionIds.has(option.definitionId)
            )
            if (additions.length === 0) continue
            const index = merged.findIndex((entry) => entry.id === offer.id)
            merged[index] = {
              ...prior,
              options: [...priorOptions, ...additions],
            }
          }
          const unchanged =
            merged.length === currentOffers.length &&
            merged.every((offer, index) => offer === currentOffers[index])
          if (unchanged) return current
          return { ...current, skillOffers: merged }
        }
        // Non-stale same-version snapshot, keep the current merge policy: adopt
        // the incoming mutable metadata (archived / grade) for options already
        // held, keep the immutable old snapshots (nameSnapshot), and preserve
        // live note and terminal state.
        const currentOffers = current.skillOffers ?? []
        const incomingOffers = incoming.skillOffers ?? []
        const priorById = new Map(
          currentOffers.map((offer) => [offer.id, offer])
        )
        const offers = incomingOffers.map((offer) => {
          const prior = priorById.get(offer.id)
          if (!prior) return offer
          const needTerminal =
            Boolean(prior.selectedDefinitionId) || Boolean(prior.canceledAt)
          // Merge options by definitionId. A duplicate id keeps the prior
          // immutable snapshot fields (nameSnapshot / configSnapshot) but adopts
          // the incoming mutable live metadata (archived, grade) so a same-version
          // archive/re-enable toggle is reflected without creating a duplicate
          // option. A new option id from the incoming snapshot is appended; an
          // option the incoming snapshot omits (a delayed refresh that predates an
          // append) keeps its prior option unchanged.
          const priorOptions = prior.options ?? []
          const incomingOptions = offer.options ?? []
          const priorOptionById = new Map(
            priorOptions.map((option) => [option.definitionId, option])
          )
          const mergedOptions = incomingOptions.map((option) => {
            const priorOption = priorOptionById.get(option.definitionId)
            if (!priorOption) return option
            // Spreading prior first keeps any extra immutable snapshot field
            // (e.g. configSnapshot) that is not part of the view type; spreading
            // the incoming option then adopts its mutable archived/grade flags.
            // Only nameSnapshot is re-pinned from the prior so the captured name
            // survives even if the incoming definition row was already renamed.
            return {
              ...priorOption,
              ...option,
              nameSnapshot: priorOption.nameSnapshot,
            }
          })
          // Keep prior options whose ids the incoming snapshot omitted, so a stale
          // same-version snapshot cannot drop options appended after it was read.
          for (const priorOption of priorOptions) {
            if (
              !mergedOptions.some(
                (merged) => merged.definitionId === priorOption.definitionId
              )
            ) {
              mergedOptions.push(priorOption)
            }
          }
          return {
            ...(needTerminal
              ? {
                  ...offer,
                  selectedDefinitionId: prior.selectedDefinitionId,
                  canceledAt: prior.canceledAt,
                }
              : offer),
            options: mergedOptions,
          }
        })
        const mergedIds = new Set(offers.map((offer) => offer.id))
        const merged = [
          ...offers,
          ...currentOffers.filter((offer) => !mergedIds.has(offer.id)),
        ]
        const unchanged =
          merged.length === incomingOffers.length &&
          merged.every((offer, index) => offer === incomingOffers[index])
        if (unchanged) return incoming === current ? current : incoming
        return { ...incoming, skillOffers: merged }
      })
    },
    []
  )

  const reload = React.useCallback(async () => {
    if (!id) return
    const requestId = reloadRequestRef.current + 1
    reloadRequestRef.current = requestId
    const requestSeq = ++requestSeqRef.current
    try {
      const res = await apiFetch<CharacterResponse>(`/api/characters/${id}`)
      // Ignore a stale response: it may belong to a previous route id, or to a
      // reload that was superseded before it resolved. This prevents a slow
      // reload for character A from reverting the sheet after the route changed
      // to character B.
      if (
        activeCharacterIdRef.current !== id ||
        reloadRequestRef.current !== requestId
      )
        return
      // Compare against the accepted current ref BEFORE applyCharacter mutates
      // it, so a stale (older) reload cannot pass its own version check and
      // clobber notes.
      applyNotesIfFresh(currentCharacter.current, res.character, requestSeq)
      applyCharacter(res.character, requestSeq)
      setError(null)
    } catch (err) {
      if (
        activeCharacterIdRef.current !== id ||
        reloadRequestRef.current !== requestId
      )
        return
      setError(err instanceof Error ? err.message : "Failed to load character.")
    } finally {
      if (
        activeCharacterIdRef.current === id &&
        reloadRequestRef.current === requestId
      ) {
        setLoading(false)
      }
    }
  }, [id, applyCharacter, applyNotesIfFresh])

  const refreshSkills = React.useCallback(async () => {
    if (!id) return
    const requestId = refreshRequestRef.current + 1
    refreshRequestRef.current = requestId
    const requestSeq = ++requestSeqRef.current
    try {
      const result = await apiFetch<{ character: CharacterDetail }>(
        `/api/characters/${id}/skills/refresh`,
        { method: "POST" }
      )
      // A refresh started for character A must not apply its snapshot (or clear
      // the skill error) once the route id has changed to B - a stale-route
      // guard, plus a request-id guard so only the latest refresh wins.
      if (
        activeCharacterIdRef.current !== id ||
        refreshRequestRef.current !== requestId
      )
        return
      applyCharacter(result.character, requestSeq)
      setSkillRefreshError(false)
    } catch {
      if (
        activeCharacterIdRef.current !== id ||
        refreshRequestRef.current !== requestId
      )
        return
      setSkillRefreshError(true)
    }
  }, [id, applyCharacter])

  // Invalidate and reload cached export events after a mutation that refreshes
  // the character only when the history/track data is already on screen or
  // cached. The cache stays lazy: with no history loaded and no track tab open,
  // we leave it untouched and the lazy-load effect fetches it on demand.
  const refreshEvents = React.useCallback(async () => {
    if (!id) return
    const trackContext = [
      "history",
      "race",
      "class",
      "profession",
      "skills",
    ].includes(activeTab)
    if (!events && !trackContext) return
    try {
      const res = await apiFetch<ExportResponse>(`/api/characters/${id}/export`)
      setEvents(res.events)
      setEventsError(false)
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to refresh history."
      )
    }
  }, [id, events, activeTab])

  const submitInventory = async (
    operation: "add" | "remove" | "use",
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
          ...(operation === "use" ? {} : { sourceNote: sourceNote.trim() }),
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
    if (!id || refreshOnOpen.current === id) return
    refreshOnOpen.current = id
    void refreshSkills()
  }, [id, refreshSkills])

  React.useEffect(() => {
    activeCharacterIdRef.current = id
    // Reset the per-route last-applied sequence when the route id changes. The
    // sequence refs are only meaningful within a single route; carrying
    // character A's last-applied sequence into character B would mark B's first
    // snapshots as stale and incorrectly keep them from applying. The request
    // counter is NOT reset - it stays globally monotonic so no two requests ever
    // share a sequence within the component's lifetime.
    lastAppliedSeqRef.current = 0
  }, [id])

  React.useEffect(() => {
    if (!id) return
    let active = true
    const requestSeq = ++requestSeqRef.current
    apiFetch<CharacterResponse>(`/api/characters/${id}`)
      .then((res) => {
        if (!active) return
        // Stale-route guard: if the route id changed after this request was
        // issued, ignore the response so a previous id cannot revert the sheet.
        if (activeCharacterIdRef.current !== id) return
        // Same guard as reload: compare against the accepted ref BEFORE
        // applyCharacter mutates it, and ignore a stale response from a previous
        // character id (the `active` flag plus the cross-id fresh check).
        applyNotesIfFresh(currentCharacter.current, res.character, requestSeq)
        applyCharacter(res.character, requestSeq)
        setError(null)
      })
      .catch((err) => {
        if (!active) return
        if (activeCharacterIdRef.current !== id) return
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
  }, [id, applyCharacter, applyNotesIfFresh])

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
    if (
      ["history", "race", "class", "profession", "skills"].includes(
        activeTab
      ) &&
      !events &&
      id
    ) {
      Promise.resolve()
        .then(() => {
          setEventsLoading(true)
          return apiFetch<ExportResponse>(`/api/characters/${id}/export`)
        })
        .then((res) => {
          setEvents(res.events)
          setEventsError(false)
        })
        .catch((err) => {
          setEventsError(true)
          toast.error(
            err instanceof Error ? err.message : "Failed to load history."
          )
        })
        .finally(() => setEventsLoading(false))
    }
  }, [activeTab, events, id, eventsRetry])

  React.useEffect(() => {
    if (activeTab !== "profession" || professionOptions.length) return
    apiFetch<CatalogListResponse>("/api/catalog/professions")
      .then((res) => setProfessionOptions(res.items))
      .catch((err) =>
        toast.error(
          err instanceof Error ? err.message : "Could not load professions."
        )
      )
  }, [activeTab, professionOptions.length])

  const experienceAction = React.useCallback(
    async (
      track: "race" | "class" | "profession",
      operation: "set" | "levelUp" | "undo",
      percent?: number
    ) => {
      if (!character) return
      if (operation === "set") {
        const currentState = character.state
        const currentTrack =
          track === "race"
            ? currentState.race.mode === "independent"
              ? (currentState.race as typeof currentState.race & {
                  experiencePercent?: number
                })
              : undefined
            : (currentState.tracks[track] as
                | ((typeof currentState.tracks)[typeof track] & {
                    experiencePercent?: number
                  })
                | undefined)
        const currentPercent = currentTrack
          ? Math.min(
              100,
              Math.max(
                0,
                currentTrack.experiencePercent ??
                  (currentTrack.quarter ?? 0) * 25
              )
            )
          : 0
        if (percent === currentPercent) {
          setExperienceDrafts((drafts) => {
            const next = { ...drafts }
            delete next[track]
            return next
          })
          return
        }
      }
      setBusy(true)
      setError(null)
      try {
        const res = await apiFetch<{
          character: CharacterDetail
          journal: JournalDelta & { leveledUp?: boolean }
        }>(`/api/characters/${character.id}/experience`, {
          ...jsonInit("POST", {
            operation,
            track,
            ...(operation === "set" ? { percent } : {}),
            version: character.version,
          }),
        })
        setExperienceDrafts((drafts) => ({
          ...drafts,
          [track]:
            res.character.state.race.mode === "independent" && track === "race"
              ? ((res.character.state.race as { experiencePercent?: number })
                  .experiencePercent ?? 0)
              : track === "class"
                ? ((
                    res.character.state.tracks.class as
                      { experiencePercent?: number } | undefined
                  )?.experiencePercent ?? 0)
                : track === "profession"
                  ? ((
                      res.character.state.tracks.profession as
                        { experiencePercent?: number } | undefined
                    )?.experiencePercent ?? 0)
                  : 0,
        }))
        if (res.journal.leveledUp) {
          setJournal(res.journal)
          setJournalOpen(true)
        }
        await reload()
        if (
          res.journal.leveledUp &&
          (track === "class" || track === "profession") &&
          res.journal.skillOfferIds?.length
        ) {
          await refreshSkills()
          setLevelUpOfferId(res.journal.skillOfferIds[0] ?? null)
        }
        await refreshEvents()
      } catch (err) {
        setExperienceDrafts((drafts) => {
          const next = { ...drafts }
          delete next[track]
          return next
        })
        await reload()
        setError(
          err instanceof Error ? err.message : "Experience update failed."
        )
      } finally {
        setBusy(false)
      }
    },
    [character, reload, refreshEvents, refreshSkills]
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
          nickname: metadataOrNull(notes.nickname),
          pronouns: metadataOrNull(notes.pronouns),
          ageDescription: metadataOrNull(notes.ageDescription),
          appearance: metadataOrNull(notes.appearance),
          biography: metadataOrNull(notes.biography),
          notes: metadataOrNull(notes.notes),
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
        | "items"
        | "gods"
        | "bloodlines"
        | "transcendent_skills"
    ) => {
      setCatalogLoading(true)
      try {
        const res = await apiFetch<CatalogListResponse>(`/api/catalog/${kind}`)
        if (kind === "titles") setTitlesCatalog(res.items)
        else if (kind === "equipment") setEquipmentCatalog(res.items)
        else if (kind === "items") setItemsCatalog(res.items)
        else if (kind === "gods") setBlessingsCatalog(res.items)
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

  const loadCreationRules = React.useCallback(async () => {
    try {
      const result = await apiFetch<{ maxTranscendentSkills: number }>(
        "/api/rules/creation"
      )
      if (
        !Number.isInteger(result.maxTranscendentSkills) ||
        result.maxTranscendentSkills < 0 ||
        result.maxTranscendentSkills > 8
      )
        throw new Error("Invalid transcendent skill maximum.")
      setMaxTranscendentSkills(result.maxTranscendentSkills)
      setCreationRulesError(null)
    } catch (err) {
      setMaxTranscendentSkills(null)
      setCreationRulesError(
        err instanceof Error ? err.message : "Could not load creation rules."
      )
    }
  }, [])

  const openAssociations = React.useCallback(
    (
      kind?:
        | "title"
        | "skill"
        | "equipment"
        | "blessing"
        | "bloodline"
        | "transcendent"
        | "inventory",
      offerId?: string
    ) => {
      const panel =
        kind === "equipment" || kind === "inventory"
          ? "inventoryEquipment"
          : kind === "blessing" ||
              kind === "bloodline" ||
              kind === "transcendent"
            ? "powers"
            : "titlesSkills"
      const tab =
        kind === "equipment"
          ? "equipment"
          : kind === "inventory"
            ? "inventory"
            : kind === "blessing"
              ? "blessings"
              : kind === "bloodline"
                ? "bloodlines"
                : kind === "transcendent"
                  ? "transcendent"
                  : kind === "skill"
                    ? "skills"
                    : "titles"
      setAssociationTabs((current) => ({ ...current, [panel]: tab }))
      if (kind === "skill") setFocusedSkillOfferId(offerId ?? null)
      setActiveAssociationPanel(panel)
      void loadCreationRules()
      if (titlesCatalog.length === 0) void loadCatalog("titles")
      if (equipmentCatalog.length === 0) void loadCatalog("equipment")
      if (itemsCatalog.length === 0) void loadCatalog("items")
      if (blessingsCatalog.length === 0) void loadCatalog("gods")
      if (bloodlinesCatalog.length === 0) void loadCatalog("bloodlines")
      if (transcendentCatalog.length === 0)
        void loadCatalog("transcendent_skills")
    },
    [
      titlesCatalog.length,
      equipmentCatalog.length,
      itemsCatalog.length,
      blessingsCatalog.length,
      bloodlinesCatalog.length,
      transcendentCatalog.length,
      loadCatalog,
      loadCreationRules,
    ]
  )

  const addAssociation = React.useCallback(
    async (
      kind: "title" | "equipment" | "blessing" | "bloodline" | "transcendent",
      definitionId: string,
      reason?: string,
      equipmentPosition?: "Ring 1" | "Ring 2",
      tier?: string
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
              ...(kind === "equipment" && equipmentPosition
                ? { equipmentPosition }
                : {}),
              ...(kind === "title" && reason ? { reason } : {}),
              ...(kind === "blessing" && tier ? { tier } : {}),
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
        void refreshEvents()
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Skill selection failed."
        )
      } finally {
        setSkillBusy(false)
      }
    },
    [character, reload, refreshEvents]
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
      void refreshEvents()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Skill grant failed.")
    } finally {
      setSkillBusy(false)
    }
  }, [character, grantSkillId, grantReason, reload, refreshEvents])

  const upgradeSkill = React.useCallback(async () => {
    if (
      !character ||
      !upgradeSource ||
      !upgradeTargetId ||
      !upgradeReason.trim() ||
      upgradeReason.length > 500
    )
      return
    setSkillBusy(true)
    try {
      await apiFetch<SkillResponse>(
        `/api/characters/${character.id}/skills/upgrade`,
        {
          ...jsonInit("POST", {
            definitionId: upgradeTargetId,
            version: character.version,
            reason: upgradeReason.trim(),
          }),
        }
      )
      setUpgradeSource(null)
      toast.success("Skill upgraded.")
      await reload()
      await refreshEvents()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Skill upgrade failed.")
      await reload()
    } finally {
      setSkillBusy(false)
    }
  }, [
    character,
    upgradeSource,
    upgradeTargetId,
    upgradeReason,
    reload,
    refreshEvents,
  ])

  // Load active skill variants for owner upgrades and admin grants.
  React.useEffect(() => {
    if (activeTab !== "skills" || skillsCatalog.length > 0) return
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
  }, [activeTab, skillsCatalog.length])

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
  const raceHasNextGrade =
    GRADE_ORDER.indexOf(raceGrade) < GRADE_ORDER.length - 1
  const raceNextGrade: Grade | null = raceHasNextGrade
    ? (GRADE_ORDER[GRADE_ORDER.indexOf(raceGrade) + 1] ?? null)
    : null
  const classPercent = Math.min(
    100,
    Math.max(
      0,
      (
        classTrack as
          (typeof classTrack & { experiencePercent?: number }) | undefined
      )?.experiencePercent ?? (classTrack?.quarter ?? 0) * 25
    )
  )
  const professionPercent = Math.min(
    100,
    Math.max(
      0,
      (
        professionTrack as
          (typeof professionTrack & { experiencePercent?: number }) | undefined
      )?.experiencePercent ?? (professionTrack?.quarter ?? 0) * 25
    )
  )
  const racePercent =
    state.race.mode === "independent"
      ? Math.min(
          100,
          Math.max(
            0,
            (state.race as typeof state.race & { experiencePercent?: number })
              .experiencePercent ?? (state.race.quarter ?? 0) * 25
          )
        )
      : Math.round(
          [
            classTrack ? classPercent : null,
            professionTrack ? professionPercent : null,
          ]
            .filter((v): v is number => v !== null)
            .reduce((a, b) => a + b, 0) /
            Math.max(
              1,
              Number(Boolean(classTrack)) + Number(Boolean(professionTrack))
            )
        )

  // Archived linked equipment is not synthesized into `status`, so it never
  // appears in the live table. Keep it visible so the link can be removed.
  const archivedEquipmentLinks = character.associations.filter(
    (a) => a.kind === "equipment" && a.definitionArchived
  )

  // Skills acquired via milestone selection (kind "skill") or manual grant.
  const skillAssociations = character.associations.filter(
    (a) => a.kind === "skill"
  )

  const trackHistory = (track: "race" | "class" | "profession") => {
    const matching = events ? eventsForTrack(events, track) : null
    return (
      <div className="mt-4 flex flex-col gap-2" aria-label={`${track} history`}>
        <h3 className="text-sm font-medium">
          {track[0].toUpperCase() + track.slice(1)} history
        </h3>
        {matching === null ? (
          <p className="text-xs text-muted-foreground">Loading history...</p>
        ) : matching.length === 0 ? (
          <p className="text-xs text-muted-foreground">No events yet</p>
        ) : (
          matching.map((event, i) => (
            <div
              key={`${event.createdAt}-${i}`}
              className="rounded-lg border bg-input/20 p-2 text-xs/relaxed"
            >
              <div className="flex justify-between">
                <Badge variant="outline">
                  {event.kind === "create" ? "Initial state" : event.kind}
                </Badge>
                <span className="text-muted-foreground">{event.createdAt}</span>
              </div>
              <pre className="whitespace-pre-wrap text-muted-foreground">
                {JSON.stringify(event.payload, null, 2)}
              </pre>
            </div>
          ))
        )}
      </div>
    )
  }

  function renderInventoryContent(): React.ReactNode {
    if (!character) return null
    return (
      <>
        <Card>
          <CardContent>
            <div className="flex flex-col gap-3">
              <div>
                <h3 className="font-medium">Owned inventory</h3>
                <p className="text-sm text-muted-foreground">
                  Manual bookkeeping only. Source notes are not verified loot or
                  crafting records.
                </p>
              </div>
              {(["equipment", "items"] as const).map((kind) => {
                const rows = (character.inventory ?? []).filter(
                  (item) => item.kind === kind
                )
                return (
                  <section
                    key={kind}
                    aria-label={
                      kind === "equipment" ? "Owned equipment" : "Owned items"
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
                          const linkedEquipment = character.associations.find(
                            (a) =>
                              a.kind === "equipment" &&
                              a.definitionId === item.definitionId
                          )
                          const catalogEquipment = equipmentCatalog.find(
                            (entry) => entry.id === item.definitionId
                          )
                          const ring = catalogEquipment
                            ? isRing(catalogEquipment)
                            : normalizeEquipmentSlot(item.slot ?? "") === "Ring"
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
                                  {item.rarity
                                    ? `Rarity: ${item.rarity} - `
                                    : ""}
                                  {item.slot ? `Slot: ${item.slot}` : ""}
                                  {item.slot && equipped ? " - " : ""}
                                  {equipped
                                    ? `Equipped${linkedEquipment?.equipmentPosition ? ` in ${linkedEquipment.equipmentPosition}` : ""}`
                                    : ""}
                                </p>
                                {catalogEquipment ? (
                                  <p className="text-xs text-muted-foreground">
                                    Flat bonus: {bonusFor(catalogEquipment)}
                                    {catalogEquipment.config.percentBasisPoints
                                      ? ` - Percent: ${percentBonusFor(catalogEquipment)}`
                                      : ""}
                                  </p>
                                ) : null}
                                {item.soulbound ? (
                                  <Badge variant="outline">Soulbound</Badge>
                                ) : null}
                                {item.requirements?.minRaceLevel != null ? (
                                  <Badge variant="outline">
                                    Min race level{" "}
                                    {item.requirements.minRaceLevel}
                                  </Badge>
                                ) : null}
                                {item.requirements?.requiredRaceType ? (
                                  <Badge variant="outline">
                                    {item.requirements.requiredRaceType ===
                                    "enlightened"
                                      ? "Humanoid (enlightened)"
                                      : "Monstrous (monster)"}
                                  </Badge>
                                ) : null}
                                {item.equipmentEligibility?.eligible ===
                                false ? (
                                  <p className="text-xs text-muted-foreground">
                                    {item.equipmentEligibility.reason ??
                                      "Ineligible; equipment bonus inactive."}
                                  </p>
                                ) : null}
                              </div>
                              <div className="flex flex-wrap gap-2">
                                {item.kind === "items" ? (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={inventoryBusy}
                                    onClick={() => {
                                      setInventoryError(null)
                                      setInventoryUseItem(item)
                                    }}
                                  >
                                    Use
                                  </Button>
                                ) : null}
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
                                    <div className="flex flex-col items-end gap-1">
                                      {ring ? (
                                        <label className="text-xs">
                                          Equip position
                                          <select
                                            aria-label={`Equip position for ${item.name}`}
                                            value={
                                              inventoryRingPositions[
                                                item.definitionId
                                              ] ?? ""
                                            }
                                            onChange={(event) =>
                                              setInventoryRingPositions(
                                                (current) => ({
                                                  ...current,
                                                  [item.definitionId]: event
                                                    .target.value as
                                                    "Ring 1" | "Ring 2",
                                                })
                                              )
                                            }
                                          >
                                            <option value="">
                                              Choose position
                                            </option>
                                            <option value="Ring 1">
                                              Ring 1
                                            </option>
                                            <option value="Ring 2">
                                              Ring 2
                                            </option>
                                          </select>
                                        </label>
                                      ) : null}
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={
                                          assocBusy ||
                                          item.archived ||
                                          item.quantity < 1 ||
                                          item.equipmentEligibility
                                            ?.eligible === false ||
                                          (ring &&
                                            !inventoryRingPositions[
                                              item.definitionId
                                            ])
                                        }
                                        title={
                                          item.equipmentEligibility
                                            ?.eligible === false
                                            ? (item.equipmentEligibility
                                                .reason ??
                                              "Equipment requirements not met")
                                            : undefined
                                        }
                                        onClick={() =>
                                          void addAssociation(
                                            "equipment",
                                            item.definitionId,
                                            undefined,
                                            ring
                                              ? inventoryRingPositions[
                                                  item.definitionId
                                                ]
                                              : undefined
                                          )
                                        }
                                      >
                                        Equip
                                      </Button>
                                    </div>
                                  )
                                ) : null}
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
                  setInventorySearch("")
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
                  Unequip {inventoryRemoveItem.name} before discarding its last
                  stock.
                </p>
              ) : null}
            </div>
          </CardContent>
        </Card>
        <Dialog
          open={inventoryAddOpen}
          onOpenChange={(nextOpen) => {
            setInventoryAddOpen(nextOpen)
            if (!nextOpen) setInventorySearch("")
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add stock</DialogTitle>
              <DialogDescription>
                Manual bookkeeping only; source notes are not verified loot or
                crafting records.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <Label htmlFor="inventory-add-search">Search stock catalog</Label>
              <Input
                id="inventory-add-search"
                type="search"
                value={inventorySearch}
                onChange={(event) => setInventorySearch(event.target.value)}
              />
              <Label htmlFor="inventory-add-item">Catalog item</Label>
              <Select
                value={inventoryDefinitionId}
                onValueChange={(value) => setInventoryDefinitionId(value ?? "")}
              >
                <SelectTrigger id="inventory-add-item">
                  <SelectValue placeholder="Choose an active item" />
                </SelectTrigger>
                <SelectContent>
                  {(() => {
                    const query = inventorySearch.trim().toLocaleLowerCase()
                    const matches = (item: CatalogItem) =>
                      !query ||
                      `${item.name} ${item.stableId ?? ""} ${item.kind ?? ""}`
                        .toLocaleLowerCase()
                        .includes(query)
                    const equipmentOptions = equipmentCatalog.filter(
                      (item) =>
                        !item.archived &&
                        (matches(item) || item.id === inventoryDefinitionId)
                    )
                    const itemOptions = itemsCatalog.filter(
                      (item) =>
                        !item.archived &&
                        (matches(item) || item.id === inventoryDefinitionId)
                    )
                    return (
                      <>
                        {equipmentOptions.length > 0 ? (
                          <SelectGroup>
                            <SelectLabel>Equipment</SelectLabel>
                            {equipmentOptions.map((item) => (
                              <SelectItem key={item.id} value={item.id}>
                                {item.name}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        ) : null}
                        {itemOptions.length > 0 ? (
                          <SelectGroup>
                            <SelectLabel>Items</SelectLabel>
                            {itemOptions.map((item) => (
                              <SelectItem key={item.id} value={item.id}>
                                {item.name}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        ) : null}
                        {equipmentOptions.length + itemOptions.length === 0 ? (
                          <p className="px-2 py-1.5 text-xs text-muted-foreground">
                            No stock catalog items match your search.
                          </p>
                        ) : null}
                      </>
                    )
                  })()}
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
                    () => {
                      setInventoryAddOpen(false)
                      setInventorySearch("")
                    }
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
                            a.definitionId === inventoryRemoveItem.definitionId
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
      </>
    )
  }

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
                Grade {state.race.grade} / Level {state.race.level}
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
        {state.race.mode === "independent" ? (
          <>
            <Button
              variant="outline"
              size="sm"
              className="gap-1"
              onClick={() => setTrackEvolveTrack("race")}
              disabled={busy || !raceHasNextGrade}
              title={
                raceHasNextGrade
                  ? `Evolve race grade to ${raceNextGrade}`
                  : "This race is already at the highest grade"
              }
              aria-label={
                raceHasNextGrade
                  ? `Evolve race grade to ${raceNextGrade}`
                  : "Evolve race grade"
              }
            >
              <SparklesIcon />
              Evolve grade
              {raceNextGrade ? ` (to ${raceNextGrade})` : ""}
            </Button>
          </>
        ) : (
          <>
            {character.classId != null && classTrack ? (
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
            {character.classId != null && professionTrack ? (
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
              onClick={() => setTrackEvolveTrack("race")}
              disabled={busy || !raceHasNextGrade}
              title={
                raceHasNextGrade
                  ? `Evolve race grade to ${raceNextGrade}`
                  : "This race is already at the highest grade"
              }
              aria-label={
                raceHasNextGrade
                  ? `Evolve race grade to ${raceNextGrade}`
                  : "Evolve race grade"
              }
            >
              <SparklesIcon />
              Evolve grade
              {raceNextGrade ? ` (to ${raceNextGrade})` : ""}
            </Button>
          </>
        )}
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(v) => {
          if (!v) return
          setActiveTab(v)
          if (v === "skills") void refreshSkills()
          if (v === "inventory") {
            if (equipmentCatalog.length === 0) void loadCatalog("equipment")
            if (itemsCatalog.length === 0) void loadCatalog("items")
          }
        }}
      >
        <TabsList variant="line">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="attributes">Stats</TabsTrigger>
          <TabsTrigger value="race">Race</TabsTrigger>
          {state.race.mode !== "independent" ? (
            <TabsTrigger value="class">Class</TabsTrigger>
          ) : null}
          {state.race.mode !== "independent" ? (
            <TabsTrigger value="profession">Profession</TabsTrigger>
          ) : null}
          <TabsTrigger value="skills">Skills</TabsTrigger>
          <TabsTrigger value="blessings">Blessings</TabsTrigger>
          <TabsTrigger value="bloodlines">Bloodlines</TabsTrigger>
          <TabsTrigger value="transcendent">Transcendent skills</TabsTrigger>
          <TabsTrigger value="titles">Titles</TabsTrigger>
          <TabsTrigger value="equipment">Equipment</TabsTrigger>
          <TabsTrigger value="inventory">Inventory</TabsTrigger>
          <TabsTrigger value="consumables">Historical gains</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
        </TabsList>
        <TabsContent value="inventory" className="pt-3">
          <div className="flex flex-col gap-3">
            <div>
              <h3 className="font-medium">Owned inventory</h3>
              <p className="text-sm text-muted-foreground">
                Equipment and items currently in this character&apos;s
                inventory.
              </p>
            </div>
            <div className="flex flex-col gap-4">
              {(["equipment", "items"] as const).map((kind) => {
                const rows = (character.inventory ?? []).filter(
                  (item) => item.kind === kind
                )
                return (
                  <section key={kind} aria-label={`Owned ${kind}`}>
                    <h4 className="mb-2 text-sm font-medium capitalize">
                      {kind}
                    </h4>
                    {rows.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No owned {kind}.
                      </p>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {rows.map((item) => {
                          const equipment = equipmentCatalog.find(
                            (entry) => entry.id === item.definitionId
                          )
                          const equipped = character.associations.find(
                            (association) =>
                              association.kind === "equipment" &&
                              association.definitionId === item.definitionId
                          )
                          return (
                            <div
                              key={item.id}
                              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3"
                            >
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2 font-medium">
                                  <span>{item.name}</span>
                                  <Badge variant="outline">
                                    Qty {item.quantity}
                                  </Badge>
                                  {item.archived ? (
                                    <Badge variant="outline">
                                      Archived - inert
                                    </Badge>
                                  ) : null}
                                </div>
                                <p className="text-xs text-muted-foreground">
                                  {item.kind === "equipment"
                                    ? [
                                        item.rarity
                                          ? `Rarity: ${item.rarity}`
                                          : null,
                                        item.slot ? `Slot: ${item.slot}` : null,
                                        equipped
                                          ? `Equipped${equipped.equipmentPosition ? ` in ${equipped.equipmentPosition}` : ""}`
                                          : null,
                                        equipment
                                          ? `Bonus: ${bonusFor(equipment)}`
                                          : null,
                                      ]
                                        .filter(Boolean)
                                        .join(" - ")
                                    : "Stock item"}
                                </p>
                              </div>
                              {item.kind === "items" ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={inventoryBusy}
                                  onClick={() => {
                                    setInventoryError(null)
                                    setInventoryUseItem(item)
                                  }}
                                >
                                  Use
                                </Button>
                              ) : null}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </section>
                )
              })}
            </div>
            <Button
              variant="outline"
              className="self-start"
              onClick={() => openAssociations("inventory")}
            >
              Manage inventory
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="overview" className="pt-3">
          <div className="flex flex-col gap-4">
            <Card>
              <CardContent>
                <section
                  aria-labelledby="character-profile-heading"
                  className="flex flex-col gap-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2
                        id="character-profile-heading"
                        className="font-heading text-lg font-semibold"
                      >
                        {character.nickname?.trim() || character.name}
                      </h2>
                      <p className="text-sm text-muted-foreground">
                        {[
                          character.raceName,
                          character.className,
                          character.professionName,
                        ]
                          .filter(Boolean)
                          .join(" / ")}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant="outline" className="capitalize">
                        {character.origin}
                      </Badge>
                      {character.archived ? <Badge>Archived</Badge> : null}
                      {character.imported ? (
                        <Badge variant="outline">
                          Imported - unverified backup
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {character.description?.trim() || "No description"}
                  </p>
                  <div className="grid gap-2 text-xs sm:grid-cols-2">
                    <MetaRow label="Nickname">
                      {character.nickname?.trim() || "Not set"}
                    </MetaRow>
                    <MetaRow label="Updated">{character.updatedAt}</MetaRow>
                  </div>
                </section>
              </CardContent>
            </Card>

            <section
              aria-labelledby="character-tracks-heading"
              className="flex flex-col gap-2"
            >
              <h2
                id="character-tracks-heading"
                className="font-heading text-sm font-semibold"
              >
                Progression
              </h2>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {[
                  {
                    label: "Race",
                    name: character.raceName,
                    level: state.race.level,
                    grade: state.race.grade,
                  },
                  ...(character.classId != null && classTrack
                    ? [
                        {
                          label: "Class",
                          name: character.className,
                          level: classTrack.level,
                          grade: classTrack.grade,
                        },
                      ]
                    : []),
                  ...(character.classId != null && professionTrack
                    ? [
                        {
                          label: "Profession",
                          name: character.professionName,
                          level: professionTrack.level,
                          grade: professionTrack.grade,
                        },
                      ]
                    : []),
                ].map((track) => (
                  <Card key={track.label}>
                    <CardContent>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <h3 className="text-xs font-medium text-muted-foreground">
                            {track.label}
                          </h3>
                          <p className="truncate text-sm font-semibold">
                            {track.name ?? "Not set"}
                          </p>
                        </div>
                        <Badge variant="outline">
                          Grade {track.grade ?? "-"}
                        </Badge>
                      </div>
                      <p
                        className="mt-2 text-2xl font-semibold tabular-nums"
                        aria-label={`${track.label} level ${track.level}`}
                      >
                        {track.level}
                        <span className="ml-1 text-xs font-normal text-muted-foreground">
                          level
                        </span>
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>

            <section
              aria-labelledby="character-derived-stats-heading"
              className="flex flex-col gap-2"
            >
              <h2
                id="character-derived-stats-heading"
                className="font-heading text-sm font-semibold"
              >
                Derived Stats
              </h2>
              {status?.derivedStats ? (
                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      ["hp", "Health"],
                      ["mp", "Mana"],
                      ["sp", "Stamina"],
                    ] as const
                  ).map(([resource, name]) => {
                    const value = status.derivedStats[resource]
                    return (
                      <Card key={resource}>
                        <CardContent className="flex flex-col items-center gap-1 text-center">
                          <span className="text-[0.6875rem] font-medium text-muted-foreground uppercase">
                            {resource}
                          </span>
                          <span
                            className="text-2xl font-semibold tabular-nums"
                            aria-label={`${name} (${resource.toUpperCase()}) ${value}`}
                          >
                            {value}
                          </span>
                        </CardContent>
                      </Card>
                    )
                  })}
                </div>
              ) : (
                <p
                  className="rounded-lg border p-4 text-sm text-muted-foreground"
                  role="status"
                >
                  Derived stats are unavailable right now.
                </p>
              )}
            </section>
            <section
              aria-labelledby="character-attributes-heading"
              className="flex flex-col gap-2"
            >
              <div>
                <h2
                  id="character-attributes-heading"
                  className="font-heading text-sm font-semibold"
                >
                  Stats
                </h2>
              </div>
              {status?.attributes ? (
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-9">
                  {ATTRIBUTE_KEYS.map((attr) => (
                    <Card key={attr}>
                      <CardContent className="flex flex-col items-center gap-1 text-center">
                        <span className="text-[0.6875rem] font-medium text-muted-foreground">
                          {labelFor(attr)}
                        </span>
                        <span
                          className="text-2xl font-semibold tabular-nums"
                          aria-label={`${labelFor(attr)} ${status.attributes[attr]}`}
                        >
                          {status.attributes[attr]}
                        </span>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              ) : (
                <p
                  className="rounded-lg border p-4 text-sm text-muted-foreground"
                  role="status"
                >
                  Current calculated attributes are unavailable right now.
                </p>
              )}
            </section>
          </div>
        </TabsContent>

        {(["blessing", "bloodline", "transcendent"] as const).map((kind) => {
          const tabValue =
            kind === "blessing"
              ? "blessings"
              : kind === "bloodline"
                ? "bloodlines"
                : "transcendent"
          const heading =
            kind === "blessing"
              ? "Blessings"
              : kind === "bloodline"
                ? "Bloodlines"
                : "Transcendent skills"
          const links = character.associations.filter((a) => a.kind === kind)
          return (
            <TabsContent key={kind} value={tabValue} className="pt-3">
              <Card>
                <CardContent>
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="font-heading text-sm font-medium">
                        {heading}
                      </h3>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openAssociations(kind)}
                      >
                        Manage {heading.toLowerCase()}
                      </Button>
                    </div>
                    {kind === "transcendent" ? (
                      <>
                        <div className="flex flex-wrap items-center gap-2">
                          {character.isTranscendent ? (
                            <Badge variant="outline">Transcendent</Badge>
                          ) : null}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Transcendent skills are distinct from blessings,
                          bloodlines, and acquired skills. Listed descriptions
                          and costs are reference only; this app does not
                          activate skills or deduct costs.
                        </p>
                      </>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Linked {heading.toLowerCase()} effects are
                        catalog-defined. Numeric status and effective values are
                        calculated by the server; this sheet does not assume
                        canonical bonuses or treat narrative power as numeric.
                      </p>
                    )}
                    {links.length ? (
                      <div className="flex flex-col gap-2">
                        {links.map((a) => (
                          <div
                            key={a.id}
                            className="flex items-center justify-between gap-3 rounded-lg border bg-input/20 p-2"
                          >
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-1.5 font-medium">
                                {kind === "blessing" && a.tier
                                  ? `${a.tier} Blessing of ${a.name}`
                                  : a.name}
                                {a.grade ? (
                                  <Badge variant="outline">{a.grade}</Badge>
                                ) : null}
                                {a.definitionArchived ? (
                                  <Badge variant="outline">
                                    Archived - inert
                                  </Badge>
                                ) : null}
                              </div>
                              <p className="text-xs whitespace-pre-wrap text-muted-foreground">
                                {a.grade
                                  ? (a.gradeDescription ??
                                    "No description for this grade")
                                  : null}
                              </p>
                              {a.definitionArchived ? (
                                <p className="text-[0.6875rem] text-muted-foreground">
                                  linked but not effective
                                </p>
                              ) : null}
                            </div>
                            {kind === "transcendent" ? (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={assocBusy}
                                onClick={() => openAssociations("transcendent")}
                              >
                                Remove
                              </Button>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        No linked{" "}
                        {kind === "transcendent"
                          ? "transcendent skills"
                          : `${kind}s`}
                        .
                      </p>
                    )}
                    {status && kind !== "transcendent" ? (
                      <p className="text-xs text-muted-foreground">
                        Current attribute values below reflect server-calculated
                        live effects.
                      </p>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          )
        })}

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
                            {trace.phases.map((phase) => {
                              if (phase.phase === "historical-fixed") {
                                const fixedByTrack = (
                                  status as typeof status & {
                                    historicalFixedByTrack?: Partial<
                                      Record<
                                        "race" | "class" | "profession",
                                        Partial<Record<AttributeKey, number>>
                                      >
                                    >
                                  }
                                ).historicalFixedByTrack
                                const sources = [
                                  ["Race fixed", "race"],
                                  ["Class fixed", "class"],
                                  ["Profession fixed", "profession"],
                                ] as const
                                let cumulative = phase.value - phase.delta
                                return sources.map(([label, track], index) => {
                                  const delta =
                                    fixedByTrack?.[track]?.[
                                      trace.attribute as AttributeKey
                                    ] ?? 0
                                  cumulative =
                                    index === sources.length - 1
                                      ? phase.value
                                      : cumulative + delta
                                  return (
                                    <span
                                      key={`${phase.phase}-${track}`}
                                      className="flex justify-between text-[0.6875rem] text-muted-foreground"
                                    >
                                      <span>{label}</span>
                                      <span className="tabular-nums">
                                        {cumulative}
                                        {delta >= 0 ? " (+" : " ("}
                                        {delta})
                                      </span>
                                    </span>
                                  )
                                })
                              }
                              return (
                                <div key={phase.phase}>
                                  <span className="flex justify-between text-[0.6875rem] text-muted-foreground">
                                    <span>{phase.phase}</span>
                                    <span className="tabular-nums">
                                      {phase.value}
                                      {phase.delta >= 0 ? " (+" : " ("}
                                      {phase.delta}){" "}
                                    </span>
                                  </span>
                                </div>
                              )
                            })}
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

        <TabsContent value="race" className="pt-3">
          <Card>
            <CardContent>
              <ExperienceControl
                track="race"
                levelUpBlocked={character.levelUpBlocked?.race}
                percent={racePercent}
                level={state.race.level}
                editable={state.race.mode === "independent"}
                busy={busy}
                draft={experienceDrafts.race}
                onDraft={(value) =>
                  setExperienceDrafts((drafts) => ({ ...drafts, race: value }))
                }
                onCommit={(value) =>
                  void experienceAction("race", "set", value)
                }
                onLevel={(operation) =>
                  void experienceAction("race", operation)
                }
              />
              <div className="flex flex-col gap-1">
                <MetaRow label="Race">
                  {character.raceName ?? "Not set"}
                </MetaRow>
                <MetaRow label="Grade">{state.race.grade}</MetaRow>
                <MetaRow label="Level">{state.race.level}</MetaRow>
              </div>
            </CardContent>
          </Card>
          <p className="mt-3 text-sm whitespace-pre-wrap text-muted-foreground">
            {character.raceGradeDescription ?? "No description for this grade"}
          </p>
          <section
            className="mt-3 flex flex-col gap-2"
            aria-label="Race track history"
          >
            <h3 className="text-sm font-medium">Track history</h3>
            {trackHistory("race")}
          </section>
        </TabsContent>
        {state.race.mode !== "independent" ? (
          <TabsContent value="class" className="pt-3">
            <Card>
              <CardContent>
                {classTrack ? (
                  <ExperienceControl
                    track="class"
                    levelUpBlocked={character.levelUpBlocked?.class}
                    percent={classPercent}
                    level={classTrack.level}
                    editable={state.race.mode !== "independent"}
                    busy={busy}
                    draft={experienceDrafts.class}
                    onDraft={(value) =>
                      setExperienceDrafts((drafts) => ({
                        ...drafts,
                        class: value,
                      }))
                    }
                    onCommit={(value) =>
                      void experienceAction("class", "set", value)
                    }
                    onLevel={(operation) =>
                      void experienceAction("class", operation)
                    }
                  />
                ) : null}
                <div className="flex flex-col gap-1">
                  <MetaRow label="Class">
                    {character.className ?? "Not set"}
                  </MetaRow>
                  <MetaRow label="Grade">{classTrack?.grade ?? "-"}</MetaRow>
                  <MetaRow label="Level">{classTrack?.level ?? "-"}</MetaRow>
                </div>
                {classTrack && classTrack.grade ? (
                  <Button
                    className="mt-2 w-full"
                    variant="outline"
                    onClick={() => setTrackEvolveTrack("class")}
                    disabled={busy}
                  >
                    Evolve class
                  </Button>
                ) : null}
              </CardContent>
            </Card>
            <p className="mt-3 text-sm whitespace-pre-wrap text-muted-foreground">
              {character.classGradeDescription ??
                "No description for this grade"}
            </p>
            <section
              className="mt-3 flex flex-col gap-2"
              aria-label="Class track history"
            >
              <h3 className="text-sm font-medium">Track history</h3>
              {trackHistory("class")}
            </section>
          </TabsContent>
        ) : null}
        {state.race.mode !== "independent" ? (
          <TabsContent value="profession" className="pt-3">
            <Card>
              <CardContent>
                {professionTrack ? (
                  <ExperienceControl
                    track="profession"
                    levelUpBlocked={character.levelUpBlocked?.profession}
                    percent={professionPercent}
                    level={professionTrack.level}
                    editable={state.race.mode !== "independent"}
                    busy={busy}
                    draft={experienceDrafts.profession}
                    onDraft={(value) =>
                      setExperienceDrafts((drafts) => ({
                        ...drafts,
                        profession: value,
                      }))
                    }
                    onCommit={(value) =>
                      void experienceAction("profession", "set", value)
                    }
                    onLevel={(operation) =>
                      void experienceAction("profession", operation)
                    }
                  />
                ) : null}
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1">
                    <MetaRow label="Profession">
                      {character.professionName ?? "None"}
                    </MetaRow>
                    <MetaRow label="Grade">
                      {professionTrack?.grade ?? "-"}
                    </MetaRow>
                    <MetaRow label="Level">
                      {professionTrack?.level ?? "-"}
                    </MetaRow>
                  </div>
                  {!professionTrack ? (
                    <>
                      <p className="text-sm text-muted-foreground">
                        Choose an eligible profession at your current race
                        grade.
                      </p>
                      <Select
                        value={professionChoice}
                        onValueChange={(value) =>
                          setProfessionChoice(value ?? "")
                        }
                      >
                        <SelectTrigger aria-label="Profession">
                          <SelectValue placeholder="Select profession" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {professionOptions
                              .filter((p) =>
                                professionEligible(p, state.race.grade)
                              )
                              .map((p) => (
                                <SelectItem key={p.id} value={p.id}>
                                  {p.name}
                                </SelectItem>
                              ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      {professionOptions.filter((p) =>
                        professionEligible(p, state.race.grade)
                      ).length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          No professions are configured for current race grade{" "}
                          {state.race.grade}, including Integrated G.
                        </p>
                      ) : (
                        <Button
                          disabled={!professionChoice || professionBusy}
                          onClick={async () => {
                            setProfessionBusy(true)
                            try {
                              await apiFetch(
                                `/api/characters/${character.id}/profession`,
                                {
                                  ...jsonInit("POST", {
                                    professionId: professionChoice,
                                    version: character.version,
                                  }),
                                }
                              )
                              await reload()
                              void refreshEvents()
                              setProfessionChoice("")
                            } catch (err) {
                              toast.error(
                                err instanceof Error
                                  ? err.message
                                  : "Could not assign profession."
                              )
                              await reload()
                            } finally {
                              setProfessionBusy(false)
                            }
                          }}
                        >
                          Assign profession
                        </Button>
                      )}
                    </>
                  ) : null}
                  {professionTrack?.grade ? (
                    <Button
                      variant="outline"
                      className="mt-2 w-full"
                      onClick={() => setTrackEvolveTrack("profession")}
                      disabled={busy}
                    >
                      Evolve profession
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>
            <p className="mt-3 text-sm whitespace-pre-wrap text-muted-foreground">
              {character.professionGradeDescription ??
                "No description for this grade"}
            </p>
            <section
              className="mt-3 flex flex-col gap-2"
              aria-label="Profession track history"
            >
              <h3 className="text-sm font-medium">Track history</h3>
              {trackHistory("profession")}
            </section>
          </TabsContent>
        ) : null}

        <TabsContent value="skills" className="pt-3">
          <div
            className="mb-3 flex flex-wrap gap-2"
            aria-label="Unspent skill selections"
          >
            {(["race", "class", "profession"] as const).map((track) => (
              <Badge key={track} variant="outline">
                {track[0]!.toUpperCase() + track.slice(1)}:{" "}
                {
                  character.skillOffers.filter(
                    (offer) =>
                      offer.track === track &&
                      !offer.selectedDefinitionId &&
                      !offer.canceledAt
                  ).length
                }{" "}
                pending
              </Badge>
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="mb-3"
            onClick={() => openAssociations("skill")}
          >
            Manage skills
          </Button>
          <Card>
            <CardContent>
              <div className="flex flex-col gap-4">
                {character.skillOffers.some(
                  (offer) => !offer.selectedDefinitionId && !offer.canceledAt
                ) ? (
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
                ) : null}

                {character.skillOffers.some(
                  (offer) => !offer.selectedDefinitionId && !offer.canceledAt
                ) ? (
                  <div className="flex flex-col gap-2">
                    {character.skillOffers
                      .filter(
                        (offer) =>
                          !offer.selectedDefinitionId && !offer.canceledAt
                      )
                      .map((offer) => {
                        const allArchived =
                          offer.options.length > 0 &&
                          offer.options.every((o) => o.archived)
                        const selected = offer.selectedDefinitionId
                        return (
                          <div
                            key={offer.id}
                            className="rounded-lg border bg-input/20 p-2"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-medium">
                                {offer.track === "race"
                                  ? "Race"
                                  : offer.track === "class"
                                    ? "Class"
                                    : "Profession"}{" "}
                                level {offer.level} - {offer.choiceGroup}
                              </span>
                              {offer.canceledAt ? (
                                <Badge variant="outline">Canceled</Badge>
                              ) : selected ? (
                                <Badge variant="outline">Selected</Badge>
                              ) : allArchived ? (
                                <Badge variant="outline">Blocked</Badge>
                              ) : (
                                <Badge variant="outline">Pending</Badge>
                              )}
                            </div>
                            {!selected ? (
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
                                        {opt.classPriority ? (
                                          <Badge variant="outline">
                                            Class match
                                          </Badge>
                                        ) : null}
                                        {opt.archived ? (
                                          <Badge variant="outline">
                                            Archived
                                          </Badge>
                                        ) : null}
                                      </div>
                                      <SkillOfferOptionDetails option={opt} />
                                      {opt.archived ? (
                                        <div className="text-[0.6875rem] text-muted-foreground">
                                          unavailable until re-enabled in the
                                          catalog
                                        </div>
                                      ) : null}
                                    </div>
                                    {opt.archived ? null : (
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={skillBusy}
                                        onClick={() =>
                                          openAssociations("skill", offer.id)
                                        }
                                      >
                                        Choose skill
                                      </Button>
                                    )}
                                  </div>
                                ))}
                                {allArchived ? (
                                  <p className="text-xs text-muted-foreground">
                                    Every offered choice is archived. An admin
                                    can re-enable one in the catalog to unlock
                                    this offer.
                                  </p>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        )
                      })}
                  </div>
                ) : null}

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
                    {skillAssociations.map((a) => {
                      const sourceRank = rarityRank(a.rarity)
                      const group = a.upgradeGroup
                      const targets = skillsCatalog.filter((item) => {
                        const rarity =
                          typeof item.config.rarity === "string"
                            ? item.config.rarity
                            : undefined
                        return (
                          !item.archived &&
                          Boolean(group) &&
                          item.config.upgradeGroup === group &&
                          sourceRank >= 0 &&
                          rarityRank(rarity) > sourceRank
                        )
                      })
                      const blocked = !a.rarity
                        ? "Source rarity metadata unavailable"
                        : !group
                          ? "Upgrade group metadata unavailable"
                          : a.rarity === "Unique"
                            ? "Unique rarity is incomparable"
                            : targets.length === 0
                              ? "No active higher-rarity variant in this upgrade group"
                              : null
                      return (
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
                            {a.rarity ? (
                              <Badge variant="outline">{a.rarity}</Badge>
                            ) : null}
                          </div>
                          <p className="text-xs whitespace-pre-wrap text-muted-foreground">
                            {a.grade
                              ? (a.gradeDescription ??
                                "No description for this grade")
                              : null}
                          </p>
                          {a.upgradeGroup ? (
                            <div className="text-[0.6875rem] text-muted-foreground">
                              Upgrade group: {a.upgradeGroup}
                            </div>
                          ) : null}
                          {blocked ? (
                            <p className="text-[0.6875rem] text-muted-foreground">
                              {blocked}
                            </p>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={skillBusy}
                              onClick={() => {
                                setUpgradeSource(a)
                                setUpgradeTargetId("")
                                setUpgradeSearch("")
                                setUpgradeReason("")
                              }}
                            >
                              Upgrade skill
                            </Button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}

                {upgradeSource
                  ? (() => {
                      const targets = skillsCatalog.filter((item) => {
                        const rarity =
                          typeof item.config.rarity === "string"
                            ? item.config.rarity
                            : undefined
                        return (
                          !item.archived &&
                          item.config.upgradeGroup ===
                            upgradeSource.upgradeGroup &&
                          rarityRank(upgradeSource.rarity) >= 0 &&
                          rarityRank(rarity) > rarityRank(upgradeSource.rarity)
                        )
                      })
                      return (
                        <div className="flex flex-col gap-2 rounded-lg border p-3">
                          <h4 className="font-medium">
                            Upgrade {upgradeSource.name}
                          </h4>
                          <p className="text-xs text-muted-foreground">
                            Current: {upgradeSource.rarity ?? "Unknown"}
                          </p>
                          <Label htmlFor="skill-upgrade-search">
                            Search upgrade skills
                          </Label>
                          <Input
                            id="skill-upgrade-search"
                            type="search"
                            value={upgradeSearch}
                            onChange={(event) =>
                              setUpgradeSearch(event.target.value)
                            }
                          />
                          <Select
                            value={upgradeTargetId}
                            onValueChange={(value) => {
                              setUpgradeTargetId(value ?? "")
                              setUpgradeSearch("")
                            }}
                          >
                            <SelectTrigger aria-label="Upgrade target">
                              <SelectValue placeholder="Select higher-rarity variant" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {targets
                                  .filter((target) => {
                                    const query = upgradeSearch
                                      .trim()
                                      .toLocaleLowerCase()
                                    return (
                                      target.id === upgradeTargetId ||
                                      !query ||
                                      `${target.name} ${String(target.config.rarity ?? "")} ${target.description ?? ""}`
                                        .toLocaleLowerCase()
                                        .includes(query)
                                    )
                                  })
                                  .map((target) => (
                                    <SelectItem
                                      key={target.id}
                                      value={target.id}
                                    >
                                      {target.name} -{" "}
                                      {String(target.config.rarity)}
                                      {target.description
                                        ? ` - ${target.description}`
                                        : ""}
                                    </SelectItem>
                                  ))}
                                {targets.filter((target) => {
                                  const query = upgradeSearch
                                    .trim()
                                    .toLocaleLowerCase()
                                  return (
                                    target.id === upgradeTargetId ||
                                    !query ||
                                    `${target.name} ${String(target.config.rarity ?? "")} ${target.description ?? ""}`
                                      .toLocaleLowerCase()
                                      .includes(query)
                                  )
                                }).length === 0 ? (
                                  <p className="px-2 py-1.5 text-xs text-muted-foreground">
                                    No upgrade skills match your search.
                                  </p>
                                ) : null}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                          <Label htmlFor="skill-upgrade-reason">Reason</Label>
                          <Input
                            id="skill-upgrade-reason"
                            maxLength={500}
                            value={upgradeReason}
                            onChange={(event) =>
                              setUpgradeReason(event.target.value)
                            }
                          />
                          <p className="text-xs text-muted-foreground">
                            {upgradeReason.length}/500 characters
                          </p>
                          <div className="flex gap-2">
                            <Button
                              variant="outline"
                              onClick={() => setUpgradeSource(null)}
                            >
                              Cancel
                            </Button>
                            <Button
                              disabled={
                                skillBusy ||
                                !upgradeTargetId ||
                                !upgradeReason.trim() ||
                                upgradeReason.length > 500
                              }
                              onClick={() => void upgradeSkill()}
                            >
                              Confirm upgrade
                            </Button>
                          </div>
                        </div>
                      )
                    })()
                  : null}

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
          <section
            className="mt-4 flex flex-col gap-2"
            aria-label="Skill history"
          >
            <h3 className="font-heading text-sm font-medium">Skill history</h3>
            {eventsLoading ? (
              <p className="text-xs text-muted-foreground" role="status">
                Loading skill history...
              </p>
            ) : null}
            {eventsError ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Could not load skill history.</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEvents(null)
                    setEventsError(false)
                    setEventsRetry((value) => value + 1)
                  }}
                >
                  Retry
                </Button>
              </div>
            ) : null}
            {events && skillHistoryEvents(events).length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No skill history yet.
              </p>
            ) : null}
            {events ? (
              <ol className="flex flex-col gap-1">
                {skillHistoryEvents(events).map((entry) => (
                  <li
                    key={entry.key}
                    className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border px-2 py-1 text-xs"
                  >
                    <span>{entry.label}</span>
                    <time
                      className="text-muted-foreground"
                      dateTime={entry.date}
                    >
                      {new Date(entry.date).toLocaleDateString()}
                    </time>
                  </li>
                ))}
              </ol>
            ) : null}
          </section>
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
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openAssociations("title")}
                >
                  Manage titles
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
                          <p className="text-xs whitespace-pre-wrap text-muted-foreground">
                            {a.grade
                              ? (a.gradeDescription ??
                                "No description for this grade")
                              : null}
                          </p>
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
            <Button
              variant="outline"
              size="sm"
              onClick={() => openAssociations("equipment")}
            >
              Manage equipment
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
                    <p className="text-xs whitespace-pre-wrap text-muted-foreground">
                      {a.grade
                        ? (a.gradeDescription ??
                          "No description for this grade")
                        : null}
                    </p>
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
              Historical item-related gains and effects remain visible here; new
              stock is managed in Inventory.
            </p>
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
              No active temporary item effects.
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
                    onChange={(e) => updateNotes({ name: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="note-description">Notes / description</Label>
                  <textarea
                    id="note-description"
                    value={notes.description}
                    onChange={(e) =>
                      updateNotes({ description: e.target.value })
                    }
                    className="min-h-28 w-full rounded-md border border-input bg-input/20 px-2 py-1.5 text-xs/relaxed outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                  />
                </div>
                {(
                  [
                    ["nickname", "Nickname", 200],
                    ["pronouns", "Pronouns", 100],
                    ["ageDescription", "Age description", 4000],
                    ["appearance", "Appearance", 8000],
                    ["biography", "Biography", 8000],
                    ["notes", "Notes", 4000],
                  ] as const
                ).map(([field, label, maxLength]) => (
                  <div key={field} className="flex flex-col gap-1.5">
                    <Label htmlFor={`profile-${field}`}>{label}</Label>
                    {maxLength < 2000 ? (
                      <Input
                        id={`profile-${field}`}
                        maxLength={maxLength}
                        value={notes[field]}
                        onChange={(e) =>
                          updateNotes({ [field]: e.target.value })
                        }
                      />
                    ) : (
                      <textarea
                        id={`profile-${field}`}
                        maxLength={maxLength}
                        value={notes[field]}
                        onChange={(e) =>
                          updateNotes({ [field]: e.target.value })
                        }
                        className="min-h-28 w-full rounded-md border border-input bg-input/20 px-2 py-1.5 text-xs/relaxed"
                      />
                    )}
                  </div>
                ))}
                <div className="rounded-lg border bg-input/20 p-3 text-xs/relaxed">
                  <h3 className="mb-2 font-medium">Profile preview</h3>
                  {(
                    [
                      ["Nickname", notes.nickname],
                      ["Pronouns", notes.pronouns],
                      ["Age", notes.ageDescription],
                      ["Appearance", notes.appearance],
                      ["Biography", notes.biography],
                      ["Notes", notes.notes],
                    ] as const
                  ).map(([label, value]) => (
                    <p key={label}>
                      <span className="text-muted-foreground">{label}: </span>
                      {value || "Not provided"}
                    </p>
                  ))}
                </div>
                <div>
                  <Button
                    onClick={saveNotes}
                    disabled={
                      savingNotes ||
                      notes.name.trim().length === 0 ||
                      character.archived
                    }
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

      {trackEvolveTrack ? (
        <TrackEvolutionDialog
          track={trackEvolveTrack}
          character={character}
          onClose={() => setTrackEvolveTrack(null)}
          onEvolved={() => {
            void reload()
            void refreshEvents()
          }}
        />
      ) : null}

      <AssociationSheet
        panel="titlesSkills"
        open={activeAssociationPanel === "titlesSkills"}
        onOpenChange={(open) => {
          if (!open) setActiveAssociationPanel(null)
        }}
        associationTab={associationTabs.titlesSkills}
        onAssociationTabChange={(value) =>
          setAssociationTabs((current) => ({ ...current, titlesSkills: value }))
        }
        character={character}
        titles={titlesCatalog}
        equipment={equipmentCatalog}
        blessings={blessingsCatalog}
        bloodlines={bloodlinesCatalog}
        transcendentSkills={transcendentCatalog}
        maxTranscendentSkills={maxTranscendentSkills}
        creationRulesError={creationRulesError}
        onRetryCreationRules={() => void loadCreationRules()}
        loading={catalogLoading}
        busy={assocBusy}
        onAdd={(kind, definitionId, reason, equipmentPosition) =>
          void addAssociation(kind, definitionId, reason, equipmentPosition)
        }
        onRemove={(kind, definitionId) =>
          void removeAssociation(kind, definitionId)
        }
        onPowerAdd={(kind, definitionId, tier) =>
          void addAssociation(kind, definitionId, undefined, undefined, tier)
        }
        onPowerRemove={(kind, definitionId) =>
          void removeAssociation(kind, definitionId)
        }
        skillOffers={character.skillOffers}
        focusedOfferId={focusedSkillOfferId}
        onSelectSkill={(offerId, definitionId, name) =>
          setSelectConfirm({ offerId, definitionId, name })
        }
        onRetrySkills={() => void refreshSkills()}
      />
      <AssociationSheet
        panel="powers"
        open={activeAssociationPanel === "powers"}
        onOpenChange={(open) => {
          if (!open) setActiveAssociationPanel(null)
        }}
        associationTab={associationTabs.powers}
        onAssociationTabChange={(value) =>
          setAssociationTabs((current) => ({ ...current, powers: value }))
        }
        character={character}
        titles={titlesCatalog}
        equipment={equipmentCatalog}
        blessings={blessingsCatalog}
        bloodlines={bloodlinesCatalog}
        transcendentSkills={transcendentCatalog}
        maxTranscendentSkills={maxTranscendentSkills}
        creationRulesError={creationRulesError}
        onRetryCreationRules={() => void loadCreationRules()}
        loading={catalogLoading}
        busy={assocBusy}
        onAdd={(kind, definitionId, reason, equipmentPosition) =>
          void addAssociation(kind, definitionId, reason, equipmentPosition)
        }
        onRemove={(kind, definitionId) =>
          void removeAssociation(kind, definitionId)
        }
        onPowerAdd={(kind, definitionId, tier) =>
          void addAssociation(kind, definitionId, undefined, undefined, tier)
        }
        onPowerRemove={(kind, definitionId) =>
          void removeAssociation(kind, definitionId)
        }
        skillOffers={character.skillOffers}
        focusedOfferId={focusedSkillOfferId}
        onSelectSkill={(offerId, definitionId, name) =>
          setSelectConfirm({ offerId, definitionId, name })
        }
        onRetrySkills={() => void refreshSkills()}
      />
      <AssociationSheet
        panel="inventoryEquipment"
        open={activeAssociationPanel === "inventoryEquipment"}
        inventoryContent={renderInventoryContent()}
        onOpenChange={(open) => {
          if (!open) setActiveAssociationPanel(null)
        }}
        associationTab={associationTabs.inventoryEquipment}
        onAssociationTabChange={(value) =>
          setAssociationTabs((current) => ({
            ...current,
            inventoryEquipment: value,
          }))
        }
        character={character}
        titles={titlesCatalog}
        equipment={equipmentCatalog}
        blessings={blessingsCatalog}
        bloodlines={bloodlinesCatalog}
        transcendentSkills={transcendentCatalog}
        maxTranscendentSkills={maxTranscendentSkills}
        creationRulesError={creationRulesError}
        onRetryCreationRules={() => void loadCreationRules()}
        loading={catalogLoading}
        busy={assocBusy}
        onAdd={(kind, definitionId, reason, equipmentPosition) =>
          void addAssociation(kind, definitionId, reason, equipmentPosition)
        }
        onRemove={(kind, definitionId) =>
          void removeAssociation(kind, definitionId)
        }
        onPowerAdd={(kind, definitionId, tier) =>
          void addAssociation(kind, definitionId, undefined, undefined, tier)
        }
        onPowerRemove={(kind, definitionId) =>
          void removeAssociation(kind, definitionId)
        }
        skillOffers={character.skillOffers}
        focusedOfferId={focusedSkillOfferId}
        onSelectSkill={(offerId, definitionId, name) =>
          setSelectConfirm({ offerId, definitionId, name })
        }
        onRetrySkills={() => void refreshSkills()}
      />

      <Dialog
        open={inventoryUseItem !== null}
        onOpenChange={(open) => {
          if (!open && !inventoryBusy) setInventoryUseItem(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Use {inventoryUseItem?.name}?</DialogTitle>
            <DialogDescription>
              This spends one {inventoryUseItem?.name} from stock. It has no
              mechanical effect.
            </DialogDescription>
          </DialogHeader>
          {inventoryError ? (
            <p role="alert" className="text-sm text-destructive">
              {inventoryError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={inventoryBusy}
              onClick={() => setInventoryUseItem(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={inventoryBusy || !inventoryUseItem}
              onClick={() =>
                inventoryUseItem &&
                void submitInventory(
                  "use",
                  inventoryUseItem.definitionId,
                  1,
                  "",
                  () => setInventoryUseItem(null)
                )
              }
            >
              {inventoryBusy ? "Using..." : "Confirm use"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
        open={levelUpOfferId !== null}
        onOpenChange={(open) => {
          if (!open) setLevelUpOfferId(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Choose a skill</DialogTitle>
            <DialogDescription>
              Choose now to review this offer, or decide later.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            {character.skillOffers
              .find((offer) => offer.id === levelUpOfferId)
              ?.options.filter((option) => !option.archived).length ? (
              <Button
                variant="outline"
                disabled={skillBusy}
                onClick={() => {
                  const offerId = levelUpOfferId
                  setLevelUpOfferId(null)
                  if (offerId) openAssociations("skill", offerId)
                }}
              >
                Choose now
              </Button>
            ) : null}
            {character.skillOffers
              .find((offer) => offer.id === levelUpOfferId)
              ?.options.filter((option) => !option.archived).length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Awaiting eligible skills
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLevelUpOfferId(null)}>
              Decide later
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {skillRefreshError ? (
        <div
          role="status"
          className="flex items-center gap-2 text-xs text-muted-foreground"
        >
          <span>Skill options could not be refreshed.</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refreshSkills()}
          >
            Retry skill options
          </Button>
        </div>
      ) : null}

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
