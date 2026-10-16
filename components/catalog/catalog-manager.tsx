"use client"

import * as React from "react"
import { toast } from "sonner"
import {
  PlusIcon,
  SearchIcon,
  PencilIcon,
  LinkIcon,
  ArchiveRestoreIcon,
} from "lucide-react"

import {
  ApiError,
  apiFetch,
  jsonInit,
  type CatalogItem,
  type CatalogListResponse,
} from "@/lib/api"
import { useAppShell } from "@/components/app-shell"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ATTRIBUTE_KEYS } from "@/lib/api"
import {
  EQUIPMENT_RARITIES,
  EQUIPMENT_SLOTS,
  EQUIPMENT_UNIQUE_RARITY,
} from "@/lib/server/schemas"

const GRADES = ["G", "F", "E", "D", "C", "B", "A", "S"] as const
const OPTIONAL_GRADE_KINDS = [
  "items",
  "titles",
  "bloodlines",
  "transcendent_skills",
]
const RARITIES = [...EQUIPMENT_RARITIES, EQUIPMENT_UNIQUE_RARITY] as const
const BLESSING_TIERS = [
  "Baptism",
  "Minor",
  "Lesser",
  "Intermediate",
  "Major",
  "Greater",
  "Divine",
  "True",
] as const
type BlessingTier = (typeof BLESSING_TIERS)[number]
type BlessingEffect =
  | { phase: "flat"; amount: Record<string, number>; [key: string]: unknown }
  | {
      phase: "percent"
      basisPoints: Record<string, number>
      [key: string]: unknown
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

interface FormState {
  name: string
  description: string
  grade: string
  sourceUrl: string
  configText: string
  gradeDescriptions: Record<string, string>
}

const EMPTY_FORM: FormState = {
  name: "",
  description: "",
  grade: "",
  sourceUrl: "",
  configText: "{}",
  gradeDescriptions: {},
}

interface ImportPreview {
  source: "wiki-reviewed"
  entries: Array<{
    kind: string
    stableId: string
    name: string
    sourceUrl: string
    status: "create" | "skip_existing"
    existing?: {
      id: string
      name: string
      sourceUrl: string | null
      archived: boolean
    }
  }>
  createCount: number
  skipCount: number
}

type BulkFormat = "json" | "csv"
interface BulkPreview {
  source: "bulk"
  previewDigest: string
  entries: Array<{
    row: number
    kind: string
    stableId: string
    name: string
    sourceUrl: string
    status: "create" | "skip_existing"
    existing?: {
      id: string
      name: string
      sourceUrl: string | null
      archived: boolean
    }
  }>
  createCount: number
  skipCount: number
}

function toForm(item: CatalogItem): FormState {
  const config = isRecord(item.config) ? item.config : {}
  const formConfig = { ...config }
  if (item.kind === "equipment") {
    if (
      formConfig.minimumLevel === undefined &&
      typeof formConfig.minRaceLevel === "number"
    )
      formConfig.minimumLevel = formConfig.minRaceLevel
    if (
      formConfig.requiredLevelType === undefined &&
      typeof formConfig.requiredRaceType === "string"
    ) {
      formConfig.requiredLevelType =
        formConfig.requiredRaceType === "enlightened"
          ? "humanoidRace"
          : formConfig.requiredRaceType === "monster"
            ? "monstrousRace"
            : undefined
    }
    delete formConfig.minRaceLevel
    delete formConfig.requiredRaceType
  }
  return {
    name: item.name,
    description: item.description ?? "",
    grade:
      item.kind === "races" && typeof config.naturalGrade === "string"
        ? config.naturalGrade
        : (item.grade ?? ""),
    sourceUrl: item.sourceUrl ?? "",
    configText: JSON.stringify(
      item.kind === "equipment" ? formConfig : (item.config ?? {}),
      null,
      2
    ),
    gradeDescriptions: isRecord(
      (item as CatalogItem & { gradeDescriptions?: unknown }).gradeDescriptions
    )
      ? Object.fromEntries(
          Object.entries(
            (
              item as CatalogItem & {
                gradeDescriptions: Record<string, unknown>
              }
            ).gradeDescriptions
          ).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string"
          )
        )
      : {},
  }
}

/**
 * Stable JSON stringifier that sorts object keys, so two semantically identical
 * config objects (differing only in key order) produce the same string. Used to
 * decide whether an edit's parsed config is semantically unchanged from the
 * currently persisted one, so a redundant `config` can be omitted from a PATCH
 * (which avoids re-validating and re-stamping unchanged config server-side).
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
    .join(",")}}`
}

export function CatalogManager({ kind }: { kind: string }) {
  const { user } = useAppShell()
  const isAdmin = user?.isAdmin === true

  const [items, setItems] = React.useState<CatalogItem[] | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState("")
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<CatalogItem | null>(null)
  const [form, setForm] = React.useState<FormState>(EMPTY_FORM)
  const [gods, setGods] = React.useState<
    Array<{ stableId: string; name: string }>
  >([])
  const [skills, setSkills] = React.useState<CatalogItem[]>([])
  const [classChoices, setClassChoices] = React.useState<CatalogItem[] | null>(
    null
  )
  const [classChoicesError, setClassChoicesError] = React.useState<
    string | null
  >(null)
  const [skillTrack, setSkillTrack] = React.useState("")
  const [skillTrackTouched, setSkillTrackTouched] = React.useState(false)
  const [classTie, setClassTie] = React.useState("")
  const [classTieFilter, setClassTieFilter] = React.useState("")
  const [skillGrantGrade, setSkillGrantGrade] =
    React.useState<(typeof GRADES)[number]>("G")
  const [skillToGrant, setSkillToGrant] = React.useState("")
  const [skillGrantFilter, setSkillGrantFilter] = React.useState("")
  const [descriptionGrade, setDescriptionGrade] =
    React.useState<(typeof GRADES)[number]>("G")
  const [blessingTier, setBlessingTier] =
    React.useState<BlessingTier>("Baptism")
  const structuredConfig = React.useMemo(() => {
    try {
      const parsed: unknown = JSON.parse(form.configText || "{}")
      return isRecord(parsed) ? parsed : null
    } catch {
      return null
    }
  }, [form.configText])
  const structuredKind = ["races", "classes", "professions"].includes(kind)
  const hasStructuredEditor =
    structuredKind || ["equipment", "skills"].includes(kind)
  const setConfigValue = React.useCallback((key: string, value: unknown) => {
    setForm((current) => {
      try {
        const parsed: unknown = JSON.parse(current.configText || "{}")
        if (!isRecord(parsed)) return current
        return {
          ...current,
          configText: JSON.stringify({ ...parsed, [key]: value }, null, 2),
        }
      } catch {
        return current
      }
    })
  }, [])
  const updateBlessingEffects = React.useCallback(
    (tier: BlessingTier, effects: BlessingEffect[] | undefined) => {
      setForm((current) => {
        try {
          const config = JSON.parse(current.configText || "{}") as Record<
            string,
            unknown
          >
          const oldEffects = isRecord(config.blessingEffects)
            ? config.blessingEffects
            : {}
          const blessingEffects = { ...oldEffects }
          if (effects === undefined) delete blessingEffects[tier]
          else blessingEffects[tier] = effects
          config.blessingEffects = blessingEffects
          return { ...current, configText: JSON.stringify(config, null, 2) }
        } catch {
          return current
        }
      })
    },
    []
  )
  const updateEquipmentConfig = React.useCallback(
    (key: string, value: unknown) => {
      setForm((current) => {
        try {
          const config = JSON.parse(current.configText || "{}") as Record<
            string,
            unknown
          >
          if (value === undefined) delete config[key]
          else config[key] = value
          return { ...current, configText: JSON.stringify(config, null, 2) }
        } catch {
          return current
        }
      })
    },
    []
  )
  const [submitting, setSubmitting] = React.useState(false)
  const [formError, setFormError] = React.useState<string | null>(null)
  const [showArchived, setShowArchived] = React.useState(false)
  const [expandedSeries, setExpandedSeries] = React.useState<
    Record<string, boolean>
  >({})
  const [unarchiving, setUnarchiving] = React.useState<string | null>(null)
  const [unarchiveError, setUnarchiveError] = React.useState<string | null>(
    null
  )
  const [importOpen, setImportOpen] = React.useState(false)
  const [importPreview, setImportPreview] =
    React.useState<ImportPreview | null>(null)
  const [importLoading, setImportLoading] = React.useState(false)
  const [importApplying, setImportApplying] = React.useState(false)
  const [importError, setImportError] = React.useState<string | null>(null)
  const [importResult, setImportResult] = React.useState<string | null>(null)
  const [bulkOpen, setBulkOpen] = React.useState(false)
  const [bulkFile, setBulkFile] = React.useState<File | null>(null)
  const [bulkContent, setBulkContent] = React.useState<string | null>(null)
  const [bulkFormat, setBulkFormat] = React.useState<BulkFormat | null>(null)
  const [bulkPreview, setBulkPreview] = React.useState<BulkPreview | null>(null)
  const [bulkLoading, setBulkLoading] = React.useState(false)
  const [bulkApplying, setBulkApplying] = React.useState(false)
  const [bulkError, setBulkError] = React.useState<string | null>(null)
  const [bulkResult, setBulkResult] = React.useState<string | null>(null)
  const bulkGeneration = React.useRef(0)
  const bulkPreviewRequest = React.useRef(0)
  const catalogUrl = `/api/catalog/${kind}${isAdmin && showArchived ? "?includeArchived=1" : ""}`

  const loadSkillClasses = React.useCallback(async () => {
    setClassChoicesError(null)
    try {
      const response = await apiFetch<CatalogListResponse>(
        "/api/catalog/classes"
      )
      setClassChoices(response.items.filter((entry) => !entry.archived))
    } catch (err) {
      setClassChoicesError(
        err instanceof Error ? err.message : "Could not load classes."
      )
      setClassChoices(null)
    }
  }, [])

  React.useEffect(() => {
    if (kind === "skills") void Promise.resolve().then(loadSkillClasses)
  }, [kind, loadSkillClasses])

  function clearBulkPreview() {
    setBulkPreview(null)
    setBulkResult(null)
    setBulkError(null)
  }

  async function readBulkFile(file: File | null) {
    const generation = ++bulkGeneration.current
    clearBulkPreview()
    setBulkFile(file)
    setBulkContent(null)
    setBulkLoading(false)
    setBulkApplying(false)
    const extension = file?.name.toLowerCase().split(".").pop()
    setBulkFormat(
      extension === "csv" || extension === "json" ? extension : null
    )
    if (!file) return
    if (file.size > 1024 * 1024) {
      setBulkError("File exceeds the 1 MiB upload limit.")
      return
    }
    if (extension !== "csv" && extension !== "json") {
      setBulkError("Choose a .csv or .json file.")
      return
    }
    try {
      const content = await file.text()
      if (generation !== bulkGeneration.current || !bulkOpen) return
      if (content.length > 1024 * 1024)
        throw new Error("File exceeds the 1 MiB upload limit.")
      setBulkContent(content)
    } catch (err) {
      if (generation !== bulkGeneration.current || !bulkOpen) return
      setBulkError(err instanceof Error ? err.message : "Could not read file.")
    }
  }

  async function requestBulkPreview(
    content = bulkContent,
    format = bulkFormat
  ) {
    if (!isAdmin || !content || !format) return null
    const generation = bulkGeneration.current
    const requestId = ++bulkPreviewRequest.current
    setBulkLoading(true)
    setBulkError(null)
    setBulkPreview(null)
    try {
      const result = await apiFetch<BulkPreview>(
        "/api/admin/catalog-import/bulk/preview",
        {
          ...jsonInit("POST", { format, content }),
        }
      )
      if (
        generation !== bulkGeneration.current ||
        requestId !== bulkPreviewRequest.current ||
        !bulkOpen
      )
        return null
      setBulkPreview(result)
      return result
    } catch (err) {
      if (
        generation !== bulkGeneration.current ||
        requestId !== bulkPreviewRequest.current ||
        !bulkOpen
      )
        return null
      setBulkError(
        err instanceof Error ? err.message : "Could not preview file."
      )
      return null
    } finally {
      if (
        generation === bulkGeneration.current &&
        requestId === bulkPreviewRequest.current &&
        bulkOpen
      )
        setBulkLoading(false)
    }
  }

  async function applyBulk() {
    if (
      !isAdmin ||
      !bulkPreview ||
      bulkPreview.createCount === 0 ||
      !bulkContent ||
      !bulkFormat
    )
      return
    if (
      !window.confirm(
        `Create ${bulkPreview.createCount} catalog entries from this file? Existing entries will not be changed.`
      )
    )
      return
    const snapshotContent = bulkContent
    const snapshotFormat = bulkFormat
    const snapshotDigest = bulkPreview.previewDigest
    const generation = bulkGeneration.current
    setBulkApplying(true)
    setBulkError(null)
    setBulkResult(null)
    try {
      const result = await apiFetch<BulkPreview & { createdIds: string[] }>(
        "/api/admin/catalog-import/bulk/apply",
        {
          ...jsonInit("POST", {
            format: snapshotFormat,
            content: snapshotContent,
            previewDigest: snapshotDigest,
          }),
        }
      )
      if (generation !== bulkGeneration.current || !bulkOpen) {
        await load()
        return
      }
      setBulkResult(
        `Created ${result.createdIds.length}; skipped ${result.skipCount}.`
      )
      // The POST succeeded: keep its result separate from refresh failures.
      await load()
      if (generation !== bulkGeneration.current || !bulkOpen) return
      try {
        const refreshed = await apiFetch<BulkPreview>(
          "/api/admin/catalog-import/bulk/preview",
          {
            ...jsonInit("POST", {
              format: snapshotFormat,
              content: snapshotContent,
            }),
          }
        )
        if (generation !== bulkGeneration.current || !bulkOpen) return
        setBulkPreview(refreshed)
      } catch {
        if (generation !== bulkGeneration.current || !bulkOpen) return
        setBulkPreview(null)
        setBulkError("Import succeeded, but refresh failed. Retry preview")
      }
    } catch (err) {
      if (generation !== bulkGeneration.current || !bulkOpen) return
      const message = err instanceof Error ? err.message : "Import failed."
      setBulkPreview(null)
      setBulkResult(null)
      setBulkError(
        err instanceof ApiError && err.status === 409
          ? `${message} Re-preview the file before applying.`
          : message
      )
    } finally {
      if (generation === bulkGeneration.current && bulkOpen)
        setBulkApplying(false)
    }
  }

  async function openImport() {
    if (!isAdmin) return
    setImportOpen(true)
    setImportLoading(true)
    setImportError(null)
    setImportResult(null)
    // Clear any previously shown preview up front so a failed fetch cannot leave
    // a stale preview that the user could still apply.
    setImportPreview(null)
    try {
      setImportPreview(
        await apiFetch<ImportPreview>("/api/admin/catalog-import")
      )
    } catch (err) {
      setImportError(
        err instanceof Error ? err.message : "Could not load preview."
      )
    } finally {
      setImportLoading(false)
    }
  }

  async function applyImport() {
    if (!isAdmin || !importPreview || importPreview.createCount === 0) return
    if (
      !window.confirm(
        `Import ${importPreview.createCount} reviewed wiki entries?`
      )
    )
      return
    setImportApplying(true)
    setImportError(null)
    setImportResult(null)
    try {
      const result = await apiFetch<ImportPreview & { createdIds: string[] }>(
        "/api/admin/catalog-import",
        { ...jsonInit("POST", {}) }
      )
      setImportResult(
        `Created ${result.createdIds.length}; skipped ${result.skipCount}.`
      )
      // Re-fetch the preview so the just-imported entries show as `skip_existing`
      // with updated counts, while keeping the created/skipped result message
      // clear and separate from the preview counts.
      try {
        setImportPreview(
          await apiFetch<ImportPreview>("/api/admin/catalog-import")
        )
      } catch (refreshErr) {
        setImportError(
          refreshErr instanceof Error
            ? refreshErr.message
            : "Could not refresh preview."
        )
      }
      await load()
    } catch (err) {
      const message = err instanceof Error ? err.message : "Import failed."
      setImportError(
        err instanceof ApiError && err.status === 409
          ? `${message} Refresh the preview and retry.`
          : message
      )
    } finally {
      setImportApplying(false)
    }
  }

  const load = React.useCallback(async () => {
    try {
      const res = await apiFetch<CatalogListResponse>(catalogUrl)
      setItems(res.items)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load catalog.")
    } finally {
      setLoading(false)
    }
  }, [catalogUrl])

  React.useEffect(() => {
    if (kind !== "equipment") return
    let active = true
    apiFetch<CatalogListResponse>("/api/catalog/gods")
      .then((response) => {
        if (!active) return
        setGods(
          response.items.map(({ stableId, name }) => ({ stableId, name }))
        )
      })
      .catch(() => {
        if (active) setGods([])
      })
    return () => {
      active = false
    }
  }, [kind])

  React.useEffect(() => {
    if (
      !(["equipment", "races", "classes", "professions"] as string[]).includes(
        kind
      )
    )
      return
    let active = true
    apiFetch<CatalogListResponse>("/api/catalog/skills")
      .then((response) => {
        if (active) setSkills(response.items.filter((skill) => !skill.archived))
      })
      .catch(() => {
        if (active) setSkills([])
      })
    return () => {
      active = false
    }
  }, [kind])

  React.useEffect(() => {
    let active = true
    apiFetch<CatalogListResponse>(catalogUrl)
      .then((res) => {
        if (!active) return
        setItems(res.items)
        setError(null)
      })
      .catch((err) => {
        if (!active) return
        setError(err instanceof Error ? err.message : "Failed to load catalog.")
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [catalogUrl])

  const visible = React.useMemo(() => {
    if (!items) return []
    const q = query.trim().toLowerCase()
    const available = items.filter((item) =>
      isAdmin && showArchived ? true : !item.archived
    )
    if (!q) return available
    return available.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.stableId.toLowerCase().includes(q)
    )
  }, [items, query, isAdmin, showArchived])

  const rankedSeries = React.useMemo(() => {
    if (kind !== "titles") return []
    return [
      ...new Set(
        (items ?? []).flatMap((item) => {
          const config = isRecord(item.config) ? item.config : {}
          const improvement = isRecord(config.improvement)
            ? config.improvement
            : null
          return typeof improvement?.seriesId === "string"
            ? [improvement.seriesId]
            : []
        })
      ),
    ].sort()
  }, [items, kind])

  const updateImprovement = React.useCallback(
    (update: Record<string, unknown> | null) => {
      setForm((current) => {
        try {
          const config = JSON.parse(current.configText || "{}") as Record<
            string,
            unknown
          >
          const previous = isRecord(config.improvement)
            ? config.improvement
            : null
          if (update) {
            config.improvement = update
            config.upgradeGroup = update.seriesId
          } else {
            delete config.improvement
            // Only remove the mirrored group if it still belongs to the ranking.
            if (previous && config.upgradeGroup === previous.seriesId)
              delete config.upgradeGroup
          }
          return { ...current, configText: JSON.stringify(config, null, 2) }
        } catch {
          return current
        }
      })
    },
    []
  )

  const unarchive = React.useCallback(
    async (item: CatalogItem) => {
      if (!isAdmin || !window.confirm(`Unarchive "${item.name}"?`)) return
      setUnarchiving(item.id)
      setUnarchiveError(null)
      try {
        await apiFetch<{ item: CatalogItem }>(
          `/api/catalog/${kind}/${item.id}`,
          {
            ...jsonInit("PATCH", { archived: false }),
          }
        )
        toast.success(`Unarchived "${item.name}".`)
        await load()
      } catch (err) {
        const message = `Could not unarchive "${item.name}". ${err instanceof Error ? err.message : "Please try again."}`
        setUnarchiveError(message)
        toast.error(message)
      } finally {
        setUnarchiving(null)
      }
    },
    [isAdmin, kind, load]
  )

  const openCreate = React.useCallback(() => {
    setEditing(null)
    setForm(EMPTY_FORM)
    setDescriptionGrade("G")
    setBlessingTier("Baptism")
    setFormError(null)
    setSkillTrack("")
    setSkillTrackTouched(false)
    setClassTie("")
    setDialogOpen(true)
  }, [])

  const openEdit = React.useCallback((item: CatalogItem) => {
    setEditing(item)
    setForm(toForm(item))
    setDescriptionGrade("G")
    setBlessingTier("Baptism")
    setFormError(null)
    const config = isRecord(item.config) ? item.config : {}
    setSkillTrack(
      typeof config.track === "string" &&
        ["race", "class", "profession"].includes(config.track)
        ? config.track
        : "race"
    )
    setSkillTrackTouched(false)
    setClassTie(
      typeof config.classStableId === "string" ? config.classStableId : ""
    )
    setDialogOpen(true)
  }, [])

  const save = React.useCallback(async () => {
    let config: Record<string, unknown>
    try {
      const parsed = JSON.parse(form.configText || "{}")
      if (
        parsed == null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        throw new Error("Config must be a JSON object.")
      }
      config = parsed as Record<string, unknown>
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Config must be valid JSON."
      )
      return
    }
    if (kind === "equipment") {
      const stableIds = config.grantedSkillStableIds
      if (
        stableIds !== undefined &&
        (!Array.isArray(stableIds) ||
          stableIds.some((id) => typeof id !== "string") ||
          new Set(stableIds).size !== stableIds.length)
      ) {
        setFormError(
          "Choose granted skills from the catalog without duplicates."
        )
        return
      }
      const originalIds = isRecord(editing?.config)
        ? editing.config.grantedSkillStableIds
        : undefined
      const changedGrantIds =
        stableStringify(stableIds ?? []) !== stableStringify(originalIds ?? [])
      if (
        changedGrantIds &&
        Array.isArray(stableIds) &&
        stableIds.some(
          (id) =>
            typeof id !== "string" ||
            (!(Array.isArray(originalIds) && originalIds.includes(id)) &&
              !skills.some((skill) => skill.stableId === id))
        )
      ) {
        setFormError(
          "Choose granted skills from the unarchived skills catalog."
        )
        return
      }
      if (
        typeof config.requiredGodStableId === "string" &&
        !gods.some((god) => god.stableId === config.requiredGodStableId)
      ) {
        setFormError("Choose a required god from the catalog.")
        return
      }
      delete config.minRaceLevel
      delete config.requiredRaceType
      for (const [vectorKey, integer] of [
        ["bonus", false],
        ["percentBasisPoints", true],
        ["derivedFlat", false],
        ["derivedPercentBasisPoints", true],
      ] as const) {
        const vector = config[vectorKey]
        if (vector === undefined) continue
        if (
          !isRecord(vector) ||
          Object.entries(vector).some(
            ([, value]) =>
              typeof value !== "number" ||
              !Number.isFinite(value) ||
              value < 0 ||
              (integer && !Number.isInteger(value))
          )
        ) {
          setFormError(
            integer
              ? "Percent basis points must be nonnegative integers."
              : "Flat equipment bonuses must be finite nonnegative numbers."
          )
          return
        }
      }
    }
    if (kind === "titles") {
      const improvement = isRecord(config.improvement)
        ? config.improvement
        : null
      if (improvement) {
        const seriesId =
          typeof improvement.seriesId === "string"
            ? improvement.seriesId.trim()
            : ""
        const rank = improvement.rank
        if (
          !seriesId ||
          typeof rank !== "number" ||
          !Number.isInteger(rank) ||
          rank < 1 ||
          rank > 100 ||
          !GRADES.includes(improvement.minRaceGrade as (typeof GRADES)[number])
        ) {
          setFormError(
            "Ranked titles require a nonempty series ID, an integer rank from 1 to 100, and a minimum race grade from G to S."
          )
          return
        }
        config.improvement = {
          seriesId,
          rank,
          minRaceGrade: improvement.minRaceGrade,
        }
        config.upgradeGroup = seriesId
      }
    }
    if (kind === "gods" && config.blessingEffects !== undefined) {
      if (!isRecord(config.blessingEffects)) {
        setFormError("Blessing effects must be organized by tier.")
        return
      }
      for (const [tier, effects] of Object.entries(config.blessingEffects)) {
        if (
          !BLESSING_TIERS.includes(tier as BlessingTier) ||
          !Array.isArray(effects)
        ) {
          setFormError(
            "Blessing effects must use supported tiers and effect lists."
          )
          return
        }
        for (const effect of effects) {
          if (
            !isRecord(effect) ||
            !["flat", "percent"].includes(String(effect.phase))
          ) {
            setFormError(`${tier} effects require a flat or percent phase.`)
            return
          }
          const vectorKey = effect.phase === "flat" ? "amount" : "basisPoints"
          const vector = effect[vectorKey]
          if (
            !isRecord(vector) ||
            Object.values(vector).some(
              (value) =>
                typeof value !== "number" ||
                !Number.isFinite(value) ||
                (effect.phase === "flat"
                  ? !Number.isInteger(value)
                  : !Number.isInteger(value) || value < 0)
            )
          ) {
            setFormError(
              effect.phase === "flat"
                ? `${tier} flat effects must use whole-number values.`
                : `${tier} percent effects must use nonnegative basis points.`
            )
            return
          }
        }
      }
    }
    const legacyRaceWithoutNaturalGrade =
      kind === "races" &&
      editing != null &&
      !form.grade &&
      !(isRecord(config) && typeof config.naturalGrade === "string")
    if (structuredKind && !legacyRaceWithoutNaturalGrade) {
      if (
        (!editing || form.grade) &&
        form.grade &&
        !GRADES.includes(form.grade as (typeof GRADES)[number])
      ) {
        setFormError("Choose a valid grade.")
        return
      }
      if (kind === "races") {
        if (
          !editing &&
          (!form.grade ||
            !["enlightened", "monster"].includes(String(config.raceType)))
        ) {
          setFormError("Choose a race type before creating a race.")
          return
        }
        const originalNatural =
          isRecord(editing?.config) &&
          typeof editing.config.naturalGrade === "string"
            ? editing.config.naturalGrade
            : editing?.grade
        if (
          !editing ||
          (form.grade &&
            (form.grade !== originalNatural ||
              stableStringify(config) !==
                stableStringify(editing.config ?? {})))
        )
          config.naturalGrade = form.grade
        if (!editing) {
          const definitions = isRecord(config.raceDefinitions)
            ? config.raceDefinitions
            : {}
          if (!form.grade || !isRecord(definitions[form.grade])) {
            setFormError(
              "Add a row for the natural grade before creating this race."
            )
            return
          }
        } else if (form.grade && form.grade !== editing.grade) {
          const definitions = isRecord(config.raceDefinitions)
            ? config.raceDefinitions
            : {}
          if (!isRecord(definitions[form.grade])) {
            setFormError(
              "The selected natural grade has no matching race gains row."
            )
            return
          }
        }
      }
      const configuredGrades = isRecord(config.grades) ? config.grades : {}
      if (
        ["classes", "professions"].includes(kind) &&
        !editing &&
        !isRecord(configuredGrades[form.grade])
      ) {
        setFormError(
          "Add a row for the initial grade before creating this entry."
        )
        return
      }
      if (
        ["classes", "professions"].includes(kind) &&
        editing &&
        form.grade !== editing.grade &&
        !isRecord(configuredGrades[form.grade])
      ) {
        setFormError(
          "The selected initial grade has no matching gains row. Add it or restore the previous grade."
        )
        return
      }
      if (
        ["classes", "professions"].includes(kind) &&
        !editing &&
        !config.grades
      )
        config.grades = {}
      // Only validate the per-grade rows when the config is actually new or
      // changed. A metadata-only legacy edit (or any edit whose config is
      // semantically unchanged) skips row validation, so legacy sparse rows - a
      // class row with `fixed: {}` and no attributes, for instance - remain
      // PATCHable without re-validating a config the server will not re-stamp.
      if (
        !editing ||
        stableStringify(config) !== stableStringify(editing.config ?? {})
      ) {
        const rowsKey = kind === "races" ? "raceDefinitions" : "grades"
        const rows = isRecord(config[rowsKey]) ? config[rowsKey] : {}
        for (const [grade, rawRow] of Object.entries(rows)) {
          if (!isRecord(rawRow)) continue
          const vectorKey = kind === "races" ? "perLevel" : "fixed"
          const freeKey = kind === "races" ? "freePerLevel" : "free"
          const rawVector = isRecord(rawRow[vectorKey]) ? rawRow[vectorKey] : {}
          if (
            Object.values(rawVector).some(
              (value) => typeof value !== "number" || !Number.isFinite(value)
            )
          ) {
            setFormError(`${grade}-grade attributes must be finite numbers.`)
            return
          }
          const free = rawRow[freeKey]
          if (
            free !== undefined &&
            (typeof free !== "number" || !Number.isInteger(free) || free < 0)
          ) {
            setFormError(
              `${grade}-grade free points must be a nonnegative integer.`
            )
            return
          }
          if (kind === "classes" || kind === "professions") {
            // The backend partialVectorSchema allows sparse vectors, so `fixed`
            // need not carry every attribute. It must still be a record (the
            // schema makes `fixed` required) when a row is authored/changed.
            const fixed = isRecord(rawRow.fixed) ? rawRow.fixed : null
            if (!fixed) {
              setFormError(
                `${grade}-grade rows require a fixed attribute object.`
              )
              return
            }
            if (
              typeof rawRow.free !== "number" ||
              !Number.isInteger(rawRow.free) ||
              rawRow.free < 0
            ) {
              setFormError(
                `${grade}-grade free points must be a nonnegative integer.`
              )
              return
            }
          }
          if (
            kind === "races" &&
            (typeof rawRow.id !== "string" || !rawRow.id.trim())
          ) {
            setFormError(`${grade}-grade race gains require an id.`)
            return
          }
        }
      }
    }
    if (
      kind === "equipment" &&
      !editing &&
      (!EQUIPMENT_SLOTS.includes(
        String(config.slot) as (typeof EQUIPMENT_SLOTS)[number]
      ) ||
        !RARITIES.includes(String(config.rarity) as (typeof RARITIES)[number]))
    ) {
      setFormError(
        "Choose a supported equipment slot and rarity before creating equipment."
      )
      return
    }
    if (
      kind === "equipment" &&
      editing &&
      isRecord(editing.config) &&
      typeof editing.config.slot === "string" &&
      editing.config.slot !== "Ring" &&
      ["ring1", "ring2"].includes(
        editing.config.slot.toLowerCase().replace(/\s+/g, "")
      ) &&
      stableStringify(config) !== stableStringify(editing.config) &&
      config.slot !== "Ring"
    ) {
      setFormError(
        "Legacy Ring 1/Ring 2 equipment must be explicitly migrated to Ring before changing config."
      )
      return
    }
    if (
      kind === "skills" &&
      !editing &&
      !RARITIES.includes(String(config.rarity) as (typeof RARITIES)[number])
    ) {
      setFormError("Choose a supported rarity before creating a skill.")
      return
    }
    if (kind === "skills") {
      if (!skillTrack) {
        setFormError("Choose a skill type before saving.")
        return
      }
      if (classChoices === null) {
        setFormError(
          "Class catalog is unavailable. Retry loading classes before saving."
        )
        return
      }
      const existingTrack = isRecord(editing?.config)
        ? editing.config.track
        : undefined
      if (
        !editing ||
        ["race", "class", "profession"].includes(String(existingTrack)) ||
        skillTrackTouched
      ) {
        config.track = skillTrack
      }
      if (classTie) {
        const originalTie = isRecord(editing?.config)
          ? editing.config.classStableId
          : undefined
        if (
          !classChoices.some((entry) => entry.stableId === classTie) &&
          originalTie !== classTie
        ) {
          setFormError(
            "Choose an active class, or keep/remove the existing archived class tie."
          )
          return
        }
        config.classStableId = classTie
      } else {
        delete config.classStableId
      }
    }
    setSubmitting(true)
    setFormError(null)
    try {
      const body = {
        name: form.name,
        ...(form.description !== (editing?.description ?? "")
          ? { description: form.description }
          : {}),
        ...(stableStringify(form.gradeDescriptions) !==
        stableStringify(
          (
            editing as
              | (CatalogItem & { gradeDescriptions?: Record<string, string> })
              | null
          )?.gradeDescriptions ?? {}
        )
          ? {
              gradeDescriptions: Object.fromEntries(
                Object.entries(form.gradeDescriptions)
                  .map(([grade, text]) => [grade, text.trim()])
                  .filter(([, text]) => text !== "")
              ),
            }
          : {}),
        ...(kind !== "gods" &&
        form.grade.trim() &&
        (kind !== "races" ||
          !editing ||
          form.grade !==
            (isRecord(editing.config) &&
            typeof editing.config.naturalGrade === "string"
              ? editing.config.naturalGrade
              : editing.grade))
          ? { grade: form.grade }
          : {}),
        ...(OPTIONAL_GRADE_KINDS.includes(kind) &&
        editing &&
        form.grade !== (editing.grade ?? "")
          ? { grade: form.grade || null }
          : {}),
        ...(form.sourceUrl.trim() ? { sourceUrl: form.sourceUrl } : {}),
        // On an EDIT whose parsed config is semantically unchanged from the
        // currently persisted one, omit `config` entirely so the PATCH does not
        // re-validate / re-stamp the config server-side. Only send `config` when
        // it actually changed (or on create). The comparison is a deep stable
        // stringify, so key reordering alone is treated as unchanged.
        ...(editing == null ||
        stableStringify(config) !== stableStringify(editing.config ?? {})
          ? { config }
          : {}),
      }
      if (editing) {
        await apiFetch<{ item: CatalogItem }>(
          `/api/catalog/${kind}/${editing.id}`,
          {
            ...jsonInit("PATCH", body),
          }
        )
        toast.success(`Updated "${form.name}".`)
      } else {
        await apiFetch<{ item: CatalogItem }>(`/api/catalog/${kind}`, {
          ...jsonInit("POST", body),
        })
        toast.success(`Created "${form.name}".`)
      }
      setDialogOpen(false)
      await load()
    } catch (err) {
      setFormError(
        err instanceof ApiError && err.status === 409
          ? `${err.message} This title may be linked to a character. Retry without changing its identity fields, or ask an administrator to resolve the link.`
          : err instanceof Error
            ? err.message
            : "Save failed."
      )
    } finally {
      setSubmitting(false)
    }
  }, [
    editing,
    form,
    gods,
    kind,
    load,
    skills,
    structuredKind,
    skillTrack,
    skillTrackTouched,
    classTie,
    classChoices,
  ])

  const openSource = React.useCallback((url: string | null) => {
    if (url) window.open(url, "_blank", "noopener")
  }, [])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-lg font-medium capitalize">
            {kind === "items" ? "Items" : kind}
          </h1>
          <p className="text-xs text-muted-foreground">
            Catalog entries for {kind === "items" ? "items" : kind}.
          </p>
        </div>
        {isAdmin ? (
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(event) => setShowArchived(event.target.checked)}
              />
              Show archived
            </label>
            <Button className="gap-1" onClick={openCreate}>
              <PlusIcon />
              {kind === "items" ? "New Item" : "New entry"}
            </Button>
            <Button variant="outline" onClick={openImport}>
              Import reviewed wiki entries
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                bulkGeneration.current += 1
                clearBulkPreview()
                setBulkFile(null)
                setBulkContent(null)
                setBulkFormat(null)
                setBulkLoading(false)
                setBulkApplying(false)
                setBulkOpen(true)
              }}
            >
              Import CSV/JSON
            </Button>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5 sm:max-w-sm">
        <Label htmlFor="catalog-search">Search</Label>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="catalog-search"
            className="pl-7"
            placeholder="Search by name or stable id"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {error ? (
        <Alert variant="destructive">
          {error}{" "}
          <Button
            variant="outline"
            className="ml-2"
            onClick={() => {
              setLoading(true)
              load()
            }}
          >
            Retry
          </Button>
        </Alert>
      ) : null}

      {unarchiveError ? (
        <Alert variant="destructive">{unarchiveError}</Alert>
      ) : null}

      {loading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-9 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Grade</TableHead>
                <TableHead>Stable id</TableHead>
                <TableHead>Source</TableHead>
                {isAdmin ? (
                  <TableHead className="text-right">Actions</TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={isAdmin ? 5 : 4}
                    className="text-center text-muted-foreground"
                  >
                    No catalog entries match.
                  </TableCell>
                </TableRow>
              ) : (
                <>
                  {visible
                    .filter(
                      (item) =>
                        kind !== "titles" ||
                        !isRecord(item.config) ||
                        !isRecord(item.config.improvement)
                    )
                    .map((item) => (
                      <TableRow key={item.id}>
                        <TableCell className="font-medium">
                          {item.name}
                          {item.archived ? (
                            <span className="ml-2 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                              Archived
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell>{item.grade ?? "-"}</TableCell>
                        <TableCell className="font-mono text-[0.6875rem]">
                          {item.stableId}
                        </TableCell>
                        <TableCell>
                          {item.sourceUrl ? (
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              aria-label="Open source"
                              onClick={() => openSource(item.sourceUrl)}
                            >
                              <LinkIcon />
                            </Button>
                          ) : (
                            "-"
                          )}
                        </TableCell>
                        {isAdmin ? (
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label="Edit"
                              onClick={() => openEdit(item)}
                            >
                              <PencilIcon />
                            </Button>
                            {item.archived ? (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={unarchiving === item.id}
                                onClick={() => unarchive(item)}
                              >
                                <ArchiveRestoreIcon />
                                {unarchiving === item.id
                                  ? "Unarchiving..."
                                  : "Unarchive"}
                              </Button>
                            ) : null}
                          </TableCell>
                        ) : null}
                      </TableRow>
                    ))}
                  {kind === "titles"
                    ? rankedSeries.map((seriesId) => {
                        const children = visible
                          .filter(
                            (entry) =>
                              isRecord(entry.config) &&
                              isRecord(entry.config.improvement) &&
                              entry.config.improvement.seriesId === seriesId
                          )
                          .sort(
                            (a, b) =>
                              Number(
                                (a.config as Record<string, unknown>)
                                  .improvement &&
                                  ((
                                    a.config as Record<
                                      string,
                                      { rank?: number }
                                    >
                                  ).improvement?.rank ??
                                    0)
                              ) -
                              Number(
                                (b.config as Record<string, { rank?: number }>)
                                  .improvement?.rank ?? 0
                              )
                          )
                        if (!children.length) return null
                        const expanded =
                          query.trim() !== "" ||
                          (expandedSeries[seriesId] ?? false)
                        return (
                          <React.Fragment key={`series-${seriesId}`}>
                            <TableRow>
                              <TableCell>
                                <button
                                  type="button"
                                  aria-expanded={expanded}
                                  aria-label={`${expanded ? "Collapse" : "Expand"} series ${seriesId}`}
                                  className="font-medium"
                                  onClick={() =>
                                    setExpandedSeries((current) => ({
                                      ...current,
                                      [seriesId]: !expanded,
                                    }))
                                  }
                                >
                                  {expanded ? "▾" : "▸"} {seriesId}
                                </button>
                              </TableCell>
                              <TableCell>{children.length} titles</TableCell>
                              <TableCell className="font-mono text-[0.6875rem]">
                                Series
                              </TableCell>
                              <TableCell>-</TableCell>
                              {isAdmin ? <TableCell /> : null}
                            </TableRow>
                            {expanded
                              ? children.map((child) => (
                                  <TableRow key={child.id}>
                                    <TableCell className="pl-8">
                                      {child.name}
                                      {child.archived ? (
                                        <span className="ml-2 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                                          Archived
                                        </span>
                                      ) : null}
                                    </TableCell>
                                    <TableCell>
                                      Rank{" "}
                                      {String(
                                        (
                                          child.config as Record<
                                            string,
                                            { rank?: number }
                                          >
                                        ).improvement?.rank ?? "-"
                                      )}
                                    </TableCell>
                                    <TableCell className="font-mono text-[0.6875rem]">
                                      {child.stableId}
                                    </TableCell>
                                    <TableCell>
                                      {child.sourceUrl ? (
                                        <Button
                                          variant="ghost"
                                          size="icon-xs"
                                          aria-label="Open source"
                                          onClick={() =>
                                            openSource(child.sourceUrl)
                                          }
                                        >
                                          <LinkIcon />
                                        </Button>
                                      ) : (
                                        "-"
                                      )}
                                    </TableCell>
                                    {isAdmin ? (
                                      <TableCell className="text-right">
                                        <Button
                                          variant="ghost"
                                          size="icon-sm"
                                          aria-label={`Edit ${child.name}`}
                                          onClick={() => openEdit(child)}
                                        >
                                          <PencilIcon />
                                        </Button>
                                        {child.archived ? (
                                          <Button
                                            variant="outline"
                                            size="sm"
                                            disabled={unarchiving === child.id}
                                            onClick={() => unarchive(child)}
                                          >
                                            <ArchiveRestoreIcon />
                                            Unarchive
                                          </Button>
                                        ) : null}
                                      </TableCell>
                                    ) : null}
                                  </TableRow>
                                ))
                              : null}
                          </React.Fragment>
                        )
                      })
                    : null}
                </>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent
          className={`max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden ${structuredKind ? "sm:max-w-6xl" : "sm:max-w-lg"}`}
        >
          <DialogHeader>
            <DialogTitle>
              {editing
                ? kind === "items"
                  ? "Edit Item"
                  : "Edit entry"
                : kind === "items"
                  ? "New Item"
                  : "New entry"}
            </DialogTitle>
            <DialogDescription>
              Configure the catalog entry. Optional config accepts a JSON
              object; invalid JSON is rejected before saving.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto overscroll-contain pr-1">
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cat-name">
                  Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="cat-name"
                  value={form.name}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, name: e.target.value }))
                  }
                />
              </div>
              {kind === "items" ||
              !form.grade ||
              ![...GRADES].includes(form.grade as (typeof GRADES)[number]) ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cat-description">Description</Label>
                  <Textarea
                    id="cat-description"
                    maxLength={8000}
                    value={form.description}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, description: e.target.value }))
                    }
                  />
                </div>
              ) : (
                <details className="rounded-md border p-3">
                  <summary className="cursor-pointer text-sm font-medium">
                    Legacy general description (not displayed in grade tabs)
                  </summary>
                  <div className="mt-3 flex flex-col gap-1.5">
                    <Label htmlFor="cat-description">
                      Legacy general description
                    </Label>
                    <Textarea
                      id="cat-description"
                      maxLength={8000}
                      value={form.description}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, description: e.target.value }))
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      This does not populate any grade-specific description.
                    </p>
                  </div>
                </details>
              )}
              {kind !== "items" &&
                (!!form.grade ||
                ["races", "classes", "professions", "skills"].includes(kind) ? (
                  <section
                    aria-label="Grade descriptions"
                    className="flex flex-col gap-2 rounded-md border p-3"
                  >
                    <h3 className="text-sm font-medium">
                      Descriptions by grade
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      Optional grade-specific descriptions. Blank text removes
                      that grade&apos;s description.
                    </p>
                    <div
                      role="tablist"
                      aria-label="Description grade"
                      className="flex flex-wrap gap-1"
                    >
                      {GRADES.map((grade) => (
                        <Button
                          key={grade}
                          type="button"
                          role="tab"
                          aria-selected={descriptionGrade === grade}
                          variant={
                            descriptionGrade === grade ? "secondary" : "outline"
                          }
                          size="sm"
                          onClick={() => setDescriptionGrade(grade)}
                        >
                          {grade}
                        </Button>
                      ))}
                    </div>
                    <Label htmlFor="grade-description">
                      {descriptionGrade}-grade description
                    </Label>
                    <Textarea
                      id="grade-description"
                      maxLength={8000}
                      value={form.gradeDescriptions[descriptionGrade] ?? ""}
                      placeholder="No description for this grade"
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          gradeDescriptions: {
                            ...current.gradeDescriptions,
                            [descriptionGrade]: event.target.value,
                          },
                        }))
                      }
                    />
                    {!form.gradeDescriptions[descriptionGrade]?.trim() ? (
                      <p className="text-xs text-muted-foreground">
                        No description for this grade
                      </p>
                    ) : null}
                  </section>
                ) : null)}
              {structuredKind ? (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="cat-grade">
                    {kind === "races" ? "Natural grade" : "Initial grade"}
                  </Label>
                  <Select
                    value={form.grade}
                    onValueChange={(grade) =>
                      setForm((f) => ({ ...f, grade: String(grade ?? "") }))
                    }
                  >
                    <SelectTrigger
                      id="cat-grade"
                      aria-label={
                        kind === "races" ? "Natural grade" : "Initial grade"
                      }
                      disabled={!structuredConfig}
                    >
                      <SelectValue placeholder="Choose a grade" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {GRADES.map((grade) => (
                          <SelectItem key={grade} value={grade}>
                            {grade}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  {kind === "races" ? (
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="race-type">Race type</Label>
                      <select
                        id="race-type"
                        className="h-9 rounded-md border bg-background px-3 text-sm"
                        value={
                          typeof structuredConfig?.raceType === "string"
                            ? structuredConfig.raceType
                            : ""
                        }
                        onChange={(e) =>
                          setConfigValue("raceType", e.target.value)
                        }
                      >
                        <option value="">Choose race type</option>
                        <option value="enlightened">Enlightened</option>
                        <option value="monster">Monstrous</option>
                      </select>
                    </div>
                  ) : null}
                  {(["races", "classes", "professions"] as string[]).includes(
                    kind
                  ) ? (
                    <div className="flex flex-col gap-2">
                      <p className="text-xs text-muted-foreground">
                        Per-level gains by grade. Blank rows are left unchanged;
                        enter 0 explicitly to save zero. Integrated characters
                        require a G-grade race row.
                      </p>
                      <div className="overflow-x-auto rounded-md border">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Grade</TableHead>
                              {ATTRIBUTE_KEYS.map((key) => (
                                <TableHead key={key}>{key}</TableHead>
                              ))}
                              <TableHead>Free points</TableHead>
                              <TableHead>Actions</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {GRADES.filter((grade) => {
                              const natural =
                                form.grade &&
                                GRADES.indexOf(grade) >=
                                  GRADES.indexOf(
                                    form.grade as (typeof GRADES)[number]
                                  )
                              const configured =
                                kind === "races"
                                  ? isRecord(
                                      structuredConfig?.raceDefinitions
                                    ) &&
                                    Object.hasOwn(
                                      structuredConfig.raceDefinitions,
                                      grade
                                    )
                                  : isRecord(structuredConfig?.grades) &&
                                    Object.hasOwn(
                                      structuredConfig.grades,
                                      grade
                                    )
                              return natural || configured || grade === "G"
                            }).map((grade) => {
                              const track =
                                kind === "races"
                                  ? isRecord(
                                      structuredConfig?.raceDefinitions
                                    ) &&
                                    isRecord(
                                      structuredConfig.raceDefinitions[grade]
                                    )
                                    ? (structuredConfig.raceDefinitions[
                                        grade
                                      ] as Record<string, unknown>)
                                    : {}
                                  : isRecord(structuredConfig?.grades) &&
                                      isRecord(structuredConfig.grades[grade])
                                    ? (structuredConfig.grades[grade] as Record<
                                        string,
                                        unknown
                                      >)
                                    : {}
                              const vectorKey =
                                kind === "races" ? "perLevel" : "fixed"
                              const vector = isRecord(track[vectorKey])
                                ? (track[vectorKey] as Record<string, unknown>)
                                : {}
                              const updateTrack = (
                                field: string,
                                value: unknown
                              ) => {
                                const outerKey =
                                  kind === "races"
                                    ? "raceDefinitions"
                                    : "grades"
                                const outer = isRecord(
                                  structuredConfig?.[outerKey]
                                )
                                  ? (structuredConfig[outerKey] as Record<
                                      string,
                                      unknown
                                    >)
                                  : {}
                                const old = isRecord(outer[grade])
                                  ? (outer[grade] as Record<string, unknown>)
                                  : {}
                                const slug =
                                  form.name
                                    .trim()
                                    .toLowerCase()
                                    .replace(/[^a-z0-9]+/g, "-")
                                    .replace(/^-|-$/g, "") ||
                                  editing?.stableId ||
                                  "entry"
                                const updated = {
                                  ...old,
                                  ...(kind === "races"
                                    ? {
                                        id:
                                          old.id ??
                                          `${slug}-${grade.toLowerCase()}`,
                                        freePerLevel: old.freePerLevel ?? 0,
                                        perLevel: old.perLevel ?? {},
                                      }
                                    : {
                                        free: old.free ?? 0,
                                        fixed: old.fixed ?? {},
                                      }),
                                  [field]: value,
                                }
                                setConfigValue(outerKey, {
                                  ...outer,
                                  [grade]: updated,
                                })
                              }
                              return (
                                <TableRow key={grade}>
                                  <TableHead scope="row">{grade}</TableHead>
                                  {ATTRIBUTE_KEYS.map((key) => (
                                    <TableCell key={key}>
                                      <Input
                                        aria-label={`${grade} ${key}`}
                                        type="number"
                                        min="0"
                                        step="1"
                                        disabled={!structuredConfig}
                                        inputMode="numeric"
                                        className="w-16"
                                        value={
                                          vector[key] == null
                                            ? ""
                                            : String(vector[key])
                                        }
                                        onChange={(e) =>
                                          updateTrack(vectorKey, {
                                            ...vector,
                                            [key]:
                                              e.target.value === ""
                                                ? undefined
                                                : Number.isFinite(
                                                      Number(e.target.value)
                                                    )
                                                  ? Number(e.target.value)
                                                  : vector[key],
                                          })
                                        }
                                      />
                                    </TableCell>
                                  ))}
                                  <TableCell>
                                    <Input
                                      aria-label={`${grade} Free points`}
                                      type="number"
                                      min="0"
                                      step="1"
                                      disabled={!structuredConfig}
                                      inputMode="numeric"
                                      className="w-20"
                                      value={
                                        track[
                                          kind === "races"
                                            ? "freePerLevel"
                                            : "free"
                                        ] == null
                                          ? ""
                                          : String(
                                              track[
                                                kind === "races"
                                                  ? "freePerLevel"
                                                  : "free"
                                              ]
                                            )
                                      }
                                      onChange={(e) =>
                                        updateTrack(
                                          kind === "races"
                                            ? "freePerLevel"
                                            : "free",
                                          e.target.value === ""
                                            ? undefined
                                            : Number.isFinite(
                                                  Number(e.target.value)
                                                )
                                              ? Number(e.target.value)
                                              : track[
                                                  kind === "races"
                                                    ? "freePerLevel"
                                                    : "free"
                                                ]
                                        )
                                      }
                                    />
                                  </TableCell>
                                  <TableCell>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      disabled={
                                        !Object.hasOwn(
                                          isRecord(
                                            structuredConfig?.[
                                              kind === "races"
                                                ? "raceDefinitions"
                                                : "grades"
                                            ]
                                          )
                                            ? (structuredConfig[
                                                kind === "races"
                                                  ? "raceDefinitions"
                                                  : "grades"
                                              ] as object)
                                            : {},
                                          grade
                                        )
                                      }
                                      onClick={() => {
                                        if (
                                          !window.confirm(
                                            `Remove the ${grade}-grade gains row?`
                                          )
                                        )
                                          return
                                        const key =
                                          kind === "races"
                                            ? "raceDefinitions"
                                            : "grades"
                                        const rows = isRecord(
                                          structuredConfig?.[key]
                                        )
                                          ? (structuredConfig[key] as Record<
                                              string,
                                              unknown
                                            >)
                                          : {}
                                        const next = { ...rows }
                                        delete next[grade]
                                        setConfigValue(key, next)
                                      }}
                                    >
                                      Remove
                                    </Button>
                                  </TableCell>
                                </TableRow>
                              )
                            })}
                          </TableBody>
                        </Table>
                      </div>
                      <section
                        aria-label="Grade skill grants"
                        className="flex flex-col gap-2 rounded-md border p-3"
                      >
                        <h3 className="text-sm font-medium">
                          Skills granted at each grade
                        </h3>
                        <p className="text-xs text-muted-foreground">
                          These are automatic grants for characters acquiring
                          this grade (race characters receive them when they
                          reach the grade). Catalog edits do not retroactively
                          grant skills to existing characters.
                        </p>
                        <Label htmlFor="skill-grant-grade">Grant grade</Label>
                        <div
                          aria-label="Grant grade"
                          className="flex flex-wrap gap-1"
                        >
                          {GRADES.map((grade) => (
                            <Button
                              key={grade}
                              type="button"
                              size="sm"
                              variant={
                                skillGrantGrade === grade
                                  ? "secondary"
                                  : "outline"
                              }
                              aria-pressed={skillGrantGrade === grade}
                              onClick={() => setSkillGrantGrade(grade)}
                            >
                              {grade}
                            </Button>
                          ))}
                        </div>
                        {(() => {
                          const configured = isRecord(
                            structuredConfig?.gradeGrantedSkillStableIds
                          )
                            ? structuredConfig.gradeGrantedSkillStableIds
                            : {}
                          const existing = Array.isArray(
                            configured[skillGrantGrade]
                          )
                            ? configured[skillGrantGrade].filter(
                                (value): value is string =>
                                  typeof value === "string"
                              )
                            : []
                          const uniqueExisting = [...new Set(existing)]
                          const addSkill = () => {
                            if (
                              !skillToGrant ||
                              existing.includes(skillToGrant)
                            )
                              return
                            setConfigValue("gradeGrantedSkillStableIds", {
                              ...configured,
                              [skillGrantGrade]: [
                                ...uniqueExisting,
                                skillToGrant,
                              ],
                            })
                            setSkillToGrant("")
                          }
                          const removeSkill = (stableId: string) => {
                            const remaining = uniqueExisting.filter(
                              (id) => id !== stableId
                            )
                            const next = { ...configured }
                            if (remaining.length)
                              next[skillGrantGrade] = remaining
                            else delete next[skillGrantGrade]
                            setConfigValue("gradeGrantedSkillStableIds", next)
                          }
                          const selectable = skills.filter(
                            (skill) => !existing.includes(skill.stableId)
                          )
                          const filteredSkills = selectable.filter((skill) =>
                            `${skill.name} ${skill.stableId}`
                              .toLocaleLowerCase()
                              .includes(skillGrantFilter.toLocaleLowerCase())
                          )
                          return (
                            <>
                              <ul className="flex flex-col gap-1">
                                {uniqueExisting.map((stableId) => {
                                  const skill = skills.find(
                                    (entry) => entry.stableId === stableId
                                  )
                                  return (
                                    <li
                                      key={stableId}
                                      className="flex items-center justify-between gap-2 text-sm"
                                    >
                                      <span>
                                        {skill?.name ??
                                          `${stableId} (archived or unavailable)`}
                                      </span>
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        aria-label={`Remove ${skill?.name ?? stableId}`}
                                        onClick={() => removeSkill(stableId)}
                                      >
                                        Remove
                                      </Button>
                                    </li>
                                  )
                                })}
                              </ul>
                              <div className="flex flex-wrap items-center gap-2">
                                <div className="flex w-full flex-col gap-1">
                                  <Label htmlFor="skill-grant-filter">
                                    Filter skills by name or ID
                                  </Label>
                                  <Input
                                    id="skill-grant-filter"
                                    value={skillGrantFilter}
                                    onChange={(event) =>
                                      setSkillGrantFilter(event.target.value)
                                    }
                                    placeholder="Search skills"
                                  />
                                </div>
                                <Label
                                  className="sr-only"
                                  htmlFor="skill-grant-choice"
                                >
                                  Skill to grant
                                </Label>
                                <select
                                  id="skill-grant-choice"
                                  aria-label="Skill to grant"
                                  className="h-auto max-h-48 min-w-48 overflow-y-auto rounded-md border bg-background px-3 text-sm"
                                  size={Math.min(
                                    8,
                                    Math.max(2, filteredSkills.length + 1)
                                  )}
                                  value={skillToGrant}
                                  onChange={(event) =>
                                    setSkillToGrant(event.target.value)
                                  }
                                >
                                  <option value="">Choose a skill</option>
                                  {skillToGrant &&
                                  !filteredSkills.some(
                                    (skill) => skill.stableId === skillToGrant
                                  ) ? (
                                    <option value={skillToGrant}>
                                      {selectable.find(
                                        (skill) =>
                                          skill.stableId === skillToGrant
                                      )?.name ?? skillToGrant}
                                    </option>
                                  ) : null}
                                  {filteredSkills.map((skill) => (
                                    <option
                                      key={skill.stableId}
                                      value={skill.stableId}
                                    >
                                      {skill.name}
                                    </option>
                                  ))}
                                </select>
                                <Button
                                  type="button"
                                  variant="outline"
                                  disabled={!skillToGrant}
                                  onClick={addSkill}
                                >
                                  Add skill
                                </Button>
                              </div>
                            </>
                          )
                        })()}
                      </section>
                    </div>
                  ) : null}
                </div>
              ) : !["equipment", "skills", "gods"].includes(kind) ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cat-grade">Grade</Label>
                  <Select
                    value={form.grade || "none"}
                    onValueChange={(grade) =>
                      setForm((f) => ({
                        ...f,
                        grade: grade === "none" ? "" : String(grade ?? ""),
                      }))
                    }
                  >
                    <SelectTrigger id="cat-grade" aria-label="Grade">
                      <SelectValue placeholder="No grade" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="none">No grade</SelectItem>
                        {GRADES.map((grade) => (
                          <SelectItem key={grade} value={grade}>
                            {grade}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              {kind === "titles"
                ? (() => {
                    const improvement = isRecord(structuredConfig?.improvement)
                      ? structuredConfig.improvement
                      : null
                    const enabled = improvement !== null
                    return (
                      <section
                        aria-label="Ranked series"
                        className="flex flex-col gap-3 rounded-md border p-3"
                      >
                        <label className="flex items-center gap-2 text-sm font-medium">
                          <input
                            aria-label="Ranked series"
                            type="checkbox"
                            checked={enabled}
                            onChange={(event) => {
                              if (event.target.checked)
                                updateImprovement({
                                  seriesId: "",
                                  rank: 1,
                                  minRaceGrade: "G",
                                })
                              else updateImprovement(null)
                            }}
                          />
                          Ranked series
                        </label>
                        {enabled ? (
                          <>
                            <div className="flex flex-col gap-1.5">
                              <Label htmlFor="title-series-id">Series ID</Label>
                              <Input
                                id="title-series-id"
                                list="title-series-suggestions"
                                value={String(improvement.seriesId ?? "")}
                                onChange={(event) =>
                                  updateImprovement({
                                    ...improvement,
                                    seriesId: event.target.value.trimStart(),
                                  })
                                }
                              />
                              <datalist id="title-series-suggestions">
                                {rankedSeries.map((series) => (
                                  <option key={series} value={series} />
                                ))}
                              </datalist>
                            </div>
                            <div className="flex flex-col gap-1.5">
                              <Label htmlFor="title-rank">Rank</Label>
                              <Input
                                id="title-rank"
                                type="number"
                                min="1"
                                max="100"
                                step="1"
                                value={String(improvement.rank ?? "")}
                                onChange={(event) =>
                                  updateImprovement({
                                    ...improvement,
                                    rank:
                                      event.target.value === ""
                                        ? ""
                                        : Number(event.target.value),
                                  })
                                }
                              />
                            </div>
                            <div className="flex flex-col gap-1.5">
                              <Label htmlFor="title-min-grade">
                                Minimum Race Grade
                              </Label>
                              <Select
                                value={String(improvement.minRaceGrade ?? "G")}
                                onValueChange={(value) =>
                                  updateImprovement({
                                    ...improvement,
                                    minRaceGrade: String(value ?? "G"),
                                  })
                                }
                              >
                                <SelectTrigger
                                  id="title-min-grade"
                                  aria-label="Minimum Race Grade"
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectGroup>
                                    {GRADES.map((grade) => (
                                      <SelectItem key={grade} value={grade}>
                                        {grade}
                                      </SelectItem>
                                    ))}
                                  </SelectGroup>
                                </SelectContent>
                              </Select>
                            </div>
                          </>
                        ) : null}
                      </section>
                    )
                  })()
                : null}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cat-source">Source URL</Label>
                <Input
                  id="cat-source"
                  value={form.sourceUrl}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, sourceUrl: e.target.value }))
                  }
                />
              </div>
              <div className="flex flex-col gap-1.5">
                {kind === "equipment" || kind === "skills" ? (
                  <div className="flex flex-col gap-2 rounded-md border p-3">
                    <p className="text-sm font-medium">
                      {kind === "equipment"
                        ? "Equipment details"
                        : "Skill rarity"}
                    </p>
                    {kind === "equipment" ? (
                      <>
                        <Label htmlFor="equip-slot">Slot</Label>
                        <select
                          id="equip-slot"
                          disabled={!structuredConfig}
                          className="h-9 rounded-md border bg-background px-3 text-sm"
                          value={
                            typeof structuredConfig?.slot === "string" &&
                            EQUIPMENT_SLOTS.includes(
                              structuredConfig.slot as (typeof EQUIPMENT_SLOTS)[number]
                            )
                              ? structuredConfig.slot
                              : typeof structuredConfig?.slot === "string"
                                ? structuredConfig.slot
                                : ""
                          }
                          onChange={(e) =>
                            setConfigValue("slot", e.target.value)
                          }
                        >
                          <option value="">Select equipment slot</option>
                          {typeof structuredConfig?.slot === "string" &&
                          !EQUIPMENT_SLOTS.includes(
                            structuredConfig.slot as (typeof EQUIPMENT_SLOTS)[number]
                          ) &&
                          !["ring1", "ring2"].includes(
                            structuredConfig.slot
                              .toLowerCase()
                              .replace(/\s+/g, "")
                          ) ? (
                            <option value={structuredConfig.slot}>
                              {structuredConfig.slot} (legacy)
                            </option>
                          ) : null}
                          {EQUIPMENT_SLOTS.map((slot) => (
                            <option key={slot} value={slot}>
                              {slot}
                            </option>
                          ))}
                        </select>
                        {typeof structuredConfig?.slot === "string" &&
                        ["ring1", "ring2"].includes(
                          structuredConfig.slot
                            .toLowerCase()
                            .replace(/\s+/g, "")
                        ) ? (
                          <p role="alert" className="text-xs text-destructive">
                            Legacy {structuredConfig.slot} config. Select Ring
                            to explicitly migrate before changing configuration.
                          </p>
                        ) : null}
                        <div className="flex flex-col gap-2">
                          <p className="text-sm font-medium">Equipment stats</p>
                          <p className="text-xs text-muted-foreground">
                            Flat bonuses apply before percent bonuses; percent
                            values are capped by game rules. Percent input is
                            converted to integer basis points.
                          </p>
                          <div className="overflow-x-auto rounded-md border">
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Attribute</TableHead>
                                  <TableHead>Flat</TableHead>
                                  <TableHead>Percent (%)</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {ATTRIBUTE_KEYS.map((key) => {
                                  const bonus = isRecord(
                                    structuredConfig?.bonus
                                  )
                                    ? structuredConfig.bonus
                                    : {}
                                  const percent = isRecord(
                                    structuredConfig?.percentBasisPoints
                                  )
                                    ? structuredConfig.percentBasisPoints
                                    : {}
                                  const changeVector = (
                                    vectorKey: string,
                                    attribute: string,
                                    value: number | undefined
                                  ) => {
                                    const current = isRecord(
                                      structuredConfig?.[vectorKey]
                                    )
                                      ? (structuredConfig[vectorKey] as Record<
                                          string,
                                          unknown
                                        >)
                                      : {}
                                    const next = { ...current }
                                    if (value === undefined)
                                      delete next[attribute]
                                    else next[attribute] = value
                                    setConfigValue(vectorKey, next)
                                  }
                                  return (
                                    <TableRow key={key}>
                                      <TableHead scope="row">{key}</TableHead>
                                      <TableCell>
                                        <Input
                                          aria-label={`${key} flat`}
                                          type="number"
                                          min="0"
                                          step="any"
                                          disabled={!structuredConfig}
                                          value={
                                            bonus[key] == null
                                              ? ""
                                              : String(bonus[key])
                                          }
                                          onChange={(event) =>
                                            changeVector(
                                              "bonus",
                                              key,
                                              event.target.value === ""
                                                ? undefined
                                                : Number(event.target.value)
                                            )
                                          }
                                        />
                                      </TableCell>
                                      <TableCell>
                                        <Input
                                          aria-label={`${key} percent`}
                                          type="number"
                                          min="0"
                                          step="0.01"
                                          disabled={!structuredConfig}
                                          value={
                                            percent[key] == null
                                              ? ""
                                              : String(
                                                  Number(percent[key]) / 100
                                                )
                                          }
                                          onChange={(event) =>
                                            changeVector(
                                              "percentBasisPoints",
                                              key,
                                              event.target.value === ""
                                                ? undefined
                                                : Math.round(
                                                    Number(event.target.value) *
                                                      100
                                                  )
                                            )
                                          }
                                        />
                                      </TableCell>
                                    </TableRow>
                                  )
                                })}
                              </TableBody>
                            </Table>
                          </div>
                          <p className="text-sm font-medium">
                            Derived HP / MP / SP
                          </p>
                          <div className="grid grid-cols-3 gap-2">
                            {["hp", "mp", "sp"].map((stat) => {
                              const flat = isRecord(
                                structuredConfig?.derivedFlat
                              )
                                ? structuredConfig.derivedFlat
                                : {}
                              const percent = isRecord(
                                structuredConfig?.derivedPercentBasisPoints
                              )
                                ? structuredConfig.derivedPercentBasisPoints
                                : {}
                              const update = (
                                key: string,
                                value: number | undefined
                              ) => {
                                const current = isRecord(
                                  structuredConfig?.[key]
                                )
                                  ? (structuredConfig[key] as Record<
                                      string,
                                      unknown
                                    >)
                                  : {}
                                const next = { ...current }
                                if (value === undefined) delete next[stat]
                                else next[stat] = value
                                setConfigValue(key, next)
                              }
                              return (
                                <div key={stat} className="flex flex-col gap-1">
                                  <span className="text-xs font-medium uppercase">
                                    {stat}
                                  </span>
                                  <Input
                                    aria-label={`${stat.toUpperCase()} derived flat`}
                                    type="number"
                                    min="0"
                                    step="any"
                                    placeholder="Flat"
                                    disabled={!structuredConfig}
                                    value={
                                      flat[stat] == null
                                        ? ""
                                        : String(flat[stat])
                                    }
                                    onChange={(e) =>
                                      update(
                                        "derivedFlat",
                                        e.target.value === ""
                                          ? undefined
                                          : Number(e.target.value)
                                      )
                                    }
                                  />
                                  <Input
                                    aria-label={`${stat.toUpperCase()} derived percent`}
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    placeholder="Percent (%)"
                                    disabled={!structuredConfig}
                                    value={
                                      percent[stat] == null
                                        ? ""
                                        : String(Number(percent[stat]) / 100)
                                    }
                                    onChange={(e) =>
                                      update(
                                        "derivedPercentBasisPoints",
                                        e.target.value === ""
                                          ? undefined
                                          : Math.round(
                                              Number(e.target.value) * 100
                                            )
                                      )
                                    }
                                  />
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      </>
                    ) : null}
                    {kind === "skills" ? (
                      <section
                        className="flex flex-col gap-2 rounded-md border p-3"
                        aria-label="Skill classification"
                      >
                        <Label htmlFor="skill-track">
                          Skill type <span className="text-destructive">*</span>
                        </Label>
                        <Select
                          value={skillTrack}
                          onValueChange={(value) => {
                            setSkillTrack(String(value ?? ""))
                            setSkillTrackTouched(true)
                          }}
                        >
                          <SelectTrigger
                            id="skill-track"
                            aria-label="Skill type"
                          >
                            <SelectValue placeholder="Choose a skill type" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value="race">Race</SelectItem>
                              <SelectItem value="class">Class</SelectItem>
                              <SelectItem value="profession">
                                Profession
                              </SelectItem>
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                        {editing &&
                        (!isRecord(editing.config) ||
                          !["race", "class", "profession"].includes(
                            String(editing.config.track)
                          )) ? (
                          <p
                            role="alert"
                            className="text-xs text-muted-foreground"
                          >
                            Legacy skill type is malformed or missing; Race is
                            selected as the migrated default.
                          </p>
                        ) : null}
                        <Label htmlFor="skill-class-tie">
                          Class tie (optional)
                        </Label>
                        {classChoicesError ? (
                          <Alert variant="destructive">
                            {classChoicesError}{" "}
                            <Button
                              type="button"
                              variant="outline"
                              onClick={() => void loadSkillClasses()}
                            >
                              Retry
                            </Button>
                          </Alert>
                        ) : null}
                        <Label htmlFor="skill-class-tie-filter">
                          Filter classes by name or ID
                        </Label>
                        <Input
                          id="skill-class-tie-filter"
                          value={classTieFilter}
                          onChange={(event) =>
                            setClassTieFilter(event.target.value)
                          }
                          placeholder="Search classes"
                        />
                        <select
                          id="skill-class-tie"
                          aria-label="Class tie"
                          className="h-auto max-h-48 overflow-y-auto rounded-md border bg-background px-3 text-sm"
                          value={classTie}
                          disabled={classChoices === null}
                          size={Math.min(
                            8,
                            Math.max(
                              2,
                              (classChoices ?? []).filter((entry) =>
                                `${entry.name} ${entry.stableId}`
                                  .toLocaleLowerCase()
                                  .includes(classTieFilter.toLocaleLowerCase())
                              ).length + 1
                            )
                          )}
                          onChange={(event) => setClassTie(event.target.value)}
                        >
                          <option value="">No class</option>
                          {classTie &&
                          !classChoices?.some(
                            (entry) =>
                              entry.stableId === classTie &&
                              `${entry.name} ${entry.stableId}`
                                .toLocaleLowerCase()
                                .includes(classTieFilter.toLocaleLowerCase())
                          ) ? (
                            <option value={classTie}>
                              {classChoices?.find(
                                (entry) => entry.stableId === classTie
                              )?.name ?? classTie}{" "}
                              (selected)
                            </option>
                          ) : null}
                          {classChoices
                            ?.filter((entry) =>
                              `${entry.name} ${entry.stableId}`
                                .toLocaleLowerCase()
                                .includes(classTieFilter.toLocaleLowerCase())
                            )
                            .map((entry) => (
                              <option
                                key={entry.stableId}
                                value={entry.stableId}
                              >
                                {entry.name}
                              </option>
                            ))}
                          {classTie &&
                          !classChoices?.some(
                            (entry) => entry.stableId === classTie
                          ) ? (
                            <option value={classTie}>
                              {classTie} (unavailable or archived; remove to
                              clear)
                            </option>
                          ) : null}
                        </select>
                        {classTie ? (
                          <p className="text-xs text-muted-foreground">
                            Class priority:{" "}
                            {classChoices?.find(
                              (entry) => entry.stableId === classTie
                            )?.name ?? classTie}
                            . This is display priority, not exclusivity.
                          </p>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            A class tie sets display priority only; it does not
                            restrict who may learn this skill.
                          </p>
                        )}
                      </section>
                    ) : null}
                    <Label htmlFor="cat-rarity">Rarity</Label>
                    <select
                      id="cat-rarity"
                      disabled={!structuredConfig}
                      className="h-9 rounded-md border bg-background px-3 text-sm"
                      value={
                        typeof structuredConfig?.rarity === "string" &&
                        RARITIES.includes(
                          structuredConfig.rarity as (typeof RARITIES)[number]
                        )
                          ? structuredConfig.rarity
                          : typeof structuredConfig?.rarity === "string"
                            ? structuredConfig.rarity
                            : ""
                      }
                      onChange={(e) => setConfigValue("rarity", e.target.value)}
                    >
                      <option value="">Select rarity</option>
                      {typeof structuredConfig?.rarity === "string" &&
                      !RARITIES.includes(
                        structuredConfig.rarity as (typeof RARITIES)[number]
                      ) ? (
                        <option value={structuredConfig.rarity}>
                          {structuredConfig.rarity} (legacy)
                        </option>
                      ) : null}
                      {RARITIES.map((rarity) => (
                        <option key={rarity} value={rarity}>
                          {rarity}
                        </option>
                      ))}
                    </select>
                    {kind === "equipment" ? (
                      <>
                        <section
                          className="flex flex-col gap-2 rounded-md border p-3"
                          aria-label="Granted skills"
                        >
                          <h3 className="text-sm font-medium">
                            Granted skills (while equipped)
                          </h3>
                          <p className="text-xs text-muted-foreground">
                            These skills are granted only while this equipment
                            is worn. Archived skills are inert; remove them here
                            if no longer wanted.
                          </p>
                          <Label htmlFor="granted-skill-picker">
                            Add a skill
                          </Label>
                          <select
                            id="granted-skill-picker"
                            disabled={!structuredConfig}
                            className="h-9 rounded-md border bg-background px-3 text-sm"
                            value=""
                            onChange={(event) => {
                              const id = event.target.value
                              if (!id) return
                              const current = Array.isArray(
                                structuredConfig?.grantedSkillStableIds
                              )
                                ? structuredConfig.grantedSkillStableIds.filter(
                                    (value): value is string =>
                                      typeof value === "string"
                                  )
                                : []
                              if (!current.includes(id))
                                updateEquipmentConfig("grantedSkillStableIds", [
                                  ...current,
                                  id,
                                ])
                            }}
                          >
                            <option value="">
                              Choose from unarchived skills
                            </option>
                            {skills
                              .filter(
                                (skill) =>
                                  !(
                                    (structuredConfig?.grantedSkillStableIds as unknown[]) ??
                                    []
                                  ).includes(skill.stableId)
                              )
                              .map((skill) => (
                                <option
                                  key={skill.stableId}
                                  value={skill.stableId}
                                >
                                  {skill.name}
                                </option>
                              ))}
                          </select>
                          {Array.isArray(
                            structuredConfig?.grantedSkillStableIds
                          ) &&
                            structuredConfig.grantedSkillStableIds.map(
                              (rawId) => {
                                const id =
                                  typeof rawId === "string"
                                    ? rawId
                                    : String(rawId)
                                const skill = skills.find(
                                  (candidate) => candidate.stableId === id
                                )
                                return (
                                  <div
                                    key={id}
                                    className="flex items-center justify-between gap-2 rounded-md bg-muted px-2 py-1.5 text-sm"
                                  >
                                    <span>
                                      {skill ? (
                                        <>
                                          {skill.name}{" "}
                                          <span className="text-muted-foreground">
                                            {Array.isArray(skill.config.tags) &&
                                            skill.config.tags.length > 0
                                              ? skill.config.tags.join(", ")
                                              : skill.stableId}
                                          </span>
                                        </>
                                      ) : (
                                        <>
                                          {id}{" "}
                                          <span className="text-destructive">
                                            Unavailable (archived or missing)
                                          </span>
                                        </>
                                      )}
                                    </span>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      aria-label={`Remove ${skill?.name ?? id}`}
                                      onClick={() =>
                                        updateEquipmentConfig(
                                          "grantedSkillStableIds",
                                          (
                                            structuredConfig.grantedSkillStableIds as unknown[]
                                          ).filter((value) => value !== rawId)
                                        )
                                      }
                                    >
                                      Remove
                                    </Button>
                                  </div>
                                )
                              }
                            )}
                        </section>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            disabled={!structuredConfig}
                            checked={structuredConfig?.soulbound === true}
                            onChange={(e) =>
                              setConfigValue("soulbound", e.target.checked)
                            }
                          />
                          Soulbound (metadata only)
                        </label>
                        <Label htmlFor="minimum-level">Minimum Level</Label>
                        <Input
                          id="minimum-level"
                          type="number"
                          min="0"
                          step="1"
                          disabled={!structuredConfig}
                          value={
                            typeof structuredConfig?.minimumLevel === "number"
                              ? structuredConfig.minimumLevel
                              : ""
                          }
                          onChange={(e) =>
                            updateEquipmentConfig(
                              "minimumLevel",
                              e.target.value === ""
                                ? undefined
                                : Number(e.target.value)
                            )
                          }
                        />
                        <Label htmlFor="required-level-type">
                          Required Level Type
                        </Label>
                        <select
                          id="required-level-type"
                          disabled={!structuredConfig}
                          className="h-9 rounded-md border bg-background px-3 text-sm"
                          value={
                            typeof structuredConfig?.requiredLevelType ===
                            "string"
                              ? structuredConfig.requiredLevelType
                              : ""
                          }
                          onChange={(e) =>
                            updateEquipmentConfig(
                              "requiredLevelType",
                              e.target.value || undefined
                            )
                          }
                        >
                          <option value="">Any</option>
                          <option value="class">Class</option>
                          <option value="profession">Profession</option>
                          <option value="humanoidRace">Humanoid Race</option>
                          <option value="monstrousRace">Monstrous Race</option>
                        </select>
                        <Label htmlFor="required-god">Required God</Label>
                        <select
                          id="required-god"
                          disabled={!structuredConfig}
                          className="h-9 rounded-md border bg-background px-3 text-sm"
                          value={
                            typeof structuredConfig?.requiredGodStableId ===
                              "string" &&
                            gods.some(
                              (god) =>
                                god.stableId ===
                                structuredConfig.requiredGodStableId
                            )
                              ? structuredConfig.requiredGodStableId
                              : ""
                          }
                          onChange={(e) => {
                            updateEquipmentConfig(
                              "requiredGodStableId",
                              e.target.value || undefined
                            )
                            if (!e.target.value)
                              updateEquipmentConfig(
                                "minimumBlessingTier",
                                undefined
                              )
                          }}
                        >
                          <option value="">No god requirement</option>
                          {gods.map((god) => (
                            <option key={god.stableId} value={god.stableId}>
                              {god.name}
                            </option>
                          ))}
                        </select>
                        <Label htmlFor="minimum-blessing-tier">
                          Minimum Blessing Tier
                        </Label>
                        <select
                          id="minimum-blessing-tier"
                          disabled={
                            !structuredConfig ||
                            !structuredConfig?.requiredGodStableId ||
                            !gods.some(
                              (god) =>
                                god.stableId ===
                                structuredConfig.requiredGodStableId
                            )
                          }
                          className="h-9 rounded-md border bg-background px-3 text-sm"
                          value={
                            typeof structuredConfig?.minimumBlessingTier ===
                            "string"
                              ? structuredConfig.minimumBlessingTier
                              : ""
                          }
                          onChange={(e) =>
                            updateEquipmentConfig(
                              "minimumBlessingTier",
                              e.target.value || undefined
                            )
                          }
                        >
                          <option value="">Any tier</option>
                          {[
                            "Baptism",
                            "Minor",
                            "Lesser",
                            "Intermediate",
                            "Major",
                            "Greater",
                            "Divine",
                            "True",
                          ].map((tier) => (
                            <option key={tier} value={tier}>
                              {tier}
                            </option>
                          ))}
                        </select>
                      </>
                    ) : null}
                    {(kind === "equipment" &&
                      typeof structuredConfig?.slot === "string" &&
                      !EQUIPMENT_SLOTS.includes(
                        structuredConfig.slot as (typeof EQUIPMENT_SLOTS)[number]
                      )) ||
                    (typeof structuredConfig?.rarity === "string" &&
                      !RARITIES.includes(
                        structuredConfig.rarity as (typeof RARITIES)[number]
                      )) ? (
                      <p role="alert" className="text-xs text-destructive">
                        Legacy value is not in the supported choices. Preserve
                        or correct it in Advanced JSON before editing these
                        metadata fields.
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {kind === "gods" ? (
                  <section
                    aria-label="Blessing tier bonuses"
                    className="flex flex-col gap-3 rounded-md border p-3"
                  >
                    <div>
                      <h3 className="text-sm font-medium">
                        Blessing tier bonuses
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        Configure stat bonuses by blessing tier. Keep a tier
                        with an empty effects list for narrative-only bonuses.
                      </p>
                    </div>
                    <Label htmlFor="blessing-tier">Blessing tier</Label>
                    <Select
                      value={blessingTier}
                      onValueChange={(value) =>
                        setBlessingTier(value as BlessingTier)
                      }
                    >
                      <SelectTrigger
                        id="blessing-tier"
                        aria-label="Blessing tier"
                      >
                        <SelectValue placeholder="Choose a tier" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {BLESSING_TIERS.map((tier) => (
                            <SelectItem key={tier} value={tier}>
                              {tier}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    {(() => {
                      const all = isRecord(structuredConfig?.blessingEffects)
                        ? structuredConfig.blessingEffects
                        : {}
                      const present = Object.hasOwn(all, blessingTier)
                      const rows = Array.isArray(all[blessingTier])
                        ? (all[blessingTier] as BlessingEffect[])
                        : []
                      const replace = (next: BlessingEffect[]) =>
                        updateBlessingEffects(blessingTier, next)
                      return (
                        <div className="flex flex-col gap-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs text-muted-foreground">
                              {present
                                ? rows.length
                                  ? `${rows.length} effect${rows.length === 1 ? "" : "s"}`
                                  : "Narrative-only tier (empty effects list)"
                                : "No numeric effects configured"}
                            </span>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={!structuredConfig}
                              onClick={() =>
                                replace([
                                  ...rows,
                                  { phase: "flat", amount: {} },
                                ])
                              }
                            >
                              Add effect
                            </Button>
                            {present ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                disabled={!structuredConfig}
                                onClick={() =>
                                  updateBlessingEffects(blessingTier, undefined)
                                }
                              >
                                Remove tier bonuses
                              </Button>
                            ) : null}
                          </div>
                          {rows.map((effect, index) => {
                            const vector =
                              effect.phase === "flat"
                                ? effect.amount
                                : effect.basisPoints
                            const updateVector = (
                              attribute: string,
                              raw: string
                            ) => {
                              const next = { ...(vector ?? {}) }
                              if (!raw) delete next[attribute]
                              else
                                next[attribute] =
                                  effect.phase === "flat"
                                    ? Number(raw)
                                    : Math.round(Number(raw) * 100)
                              replace(
                                rows.map((row, i) =>
                                  i === index
                                    ? effect.phase === "flat"
                                      ? { ...effect, amount: next }
                                      : { ...effect, basisPoints: next }
                                    : row
                                )
                              )
                            }
                            return (
                              <div
                                key={index}
                                className="flex flex-col gap-2 rounded-md border p-3"
                              >
                                <div className="flex items-center gap-2">
                                  <Label htmlFor={`blessing-phase-${index}`}>
                                    Effect phase
                                  </Label>
                                  <Select
                                    value={effect.phase}
                                    onValueChange={(phase) =>
                                      replace(
                                        rows.map((row, i) => {
                                          if (i !== index) return row
                                          const extra = { ...row } as Record<
                                            string,
                                            unknown
                                          >
                                          delete extra.amount
                                          delete extra.basisPoints
                                          return phase === "flat"
                                            ? ({
                                                ...extra,
                                                phase,
                                                amount: {},
                                              } as BlessingEffect)
                                            : ({
                                                ...extra,
                                                phase,
                                                basisPoints: {},
                                              } as BlessingEffect)
                                        })
                                      )
                                    }
                                  >
                                    <SelectTrigger
                                      id={`blessing-phase-${index}`}
                                      aria-label={`Effect ${index + 1} phase`}
                                    >
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectGroup>
                                        <SelectItem value="flat">
                                          Flat
                                        </SelectItem>
                                        <SelectItem value="percent">
                                          Percent
                                        </SelectItem>
                                      </SelectGroup>
                                    </SelectContent>
                                  </Select>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    aria-label={`Remove effect ${index + 1}`}
                                    onClick={() =>
                                      replace(
                                        rows.filter((_, i) => i !== index)
                                      )
                                    }
                                  >
                                    Remove effect
                                  </Button>
                                </div>
                                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                                  {ATTRIBUTE_KEYS.map((attribute) => (
                                    <div
                                      key={attribute}
                                      className="flex flex-col gap-1"
                                    >
                                      <Label
                                        htmlFor={`blessing-${index}-${attribute}`}
                                      >
                                        {attribute}
                                      </Label>
                                      <Input
                                        id={`blessing-${index}-${attribute}`}
                                        aria-label={`Effect ${index + 1} ${attribute}`}
                                        type="number"
                                        step={
                                          effect.phase === "flat" ? "1" : "0.01"
                                        }
                                        placeholder={
                                          effect.phase === "flat" ? "Flat" : "%"
                                        }
                                        value={
                                          vector?.[attribute] == null
                                            ? ""
                                            : effect.phase === "flat"
                                              ? String(vector[attribute])
                                              : String(vector[attribute] / 100)
                                        }
                                        onChange={(event) =>
                                          updateVector(
                                            attribute,
                                            event.target.value
                                          )
                                        }
                                      />
                                    </div>
                                  ))}
                                </div>
                                <p className="text-xs text-muted-foreground">
                                  {effect.phase === "flat"
                                    ? "Whole-number stat changes; negative values are valid debuffs."
                                    : "Enter a human-readable percent; values are saved as integer basis points."}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  Preview:{" "}
                                  {ATTRIBUTE_KEYS.flatMap((attribute) =>
                                    typeof vector?.[attribute] === "number"
                                      ? [
                                          `${attribute} ${effect.phase === "flat" ? (vector[attribute] >= 0 ? "+" : "") + vector[attribute] : (vector[attribute] >= 0 ? "+" : "") + (vector[attribute] / 100).toFixed(2) + "%"}`,
                                        ]
                                      : []
                                  ).join(" · ") || "No stat changes"}
                                </p>
                              </div>
                            )
                          })}
                        </div>
                      )
                    })()}
                  </section>
                ) : null}
                {true ? (
                  <details className="rounded-md border p-3">
                    <summary className="cursor-pointer text-sm font-medium">
                      Advanced JSON
                    </summary>
                    <p className="my-2 text-xs text-muted-foreground">
                      Unrecognized configuration is preserved. Invalid JSON
                      disables structured editing and saving.
                    </p>
                    <Label htmlFor="cat-config">Config (JSON)</Label>
                    <Textarea
                      id="cat-config"
                      className="max-h-[40vh] min-h-28 resize-y font-mono text-[0.6875rem]"
                      value={form.configText}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, configText: e.target.value }))
                      }
                    />
                  </details>
                ) : null}
              </div>
              {formError ? (
                <Alert variant="destructive">{formError}</Alert>
              ) : null}
            </div>
          </div>
          <DialogFooter showCloseButton>
            <Button
              onClick={save}
              disabled={
                submitting ||
                form.name.trim().length === 0 ||
                (hasStructuredEditor && !structuredConfig)
              }
            >
              {submitting ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {isAdmin ? (
        <Dialog open={importOpen} onOpenChange={setImportOpen}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Import reviewed wiki entries</DialogTitle>
              <DialogDescription>
                Preview the fixed reviewed manifest. No files are uploaded and
                no wiki is fetched.
              </DialogDescription>
            </DialogHeader>
            <Alert>
              No existing entry is overwritten; no automatic character grants;
              wiki-derived, review before use.
            </Alert>
            {importLoading ? <p role="status">Loading preview...</p> : null}
            {importPreview ? (
              <>
                <p>
                  {importPreview.createCount} to create;{" "}
                  {importPreview.skipCount} to skip existing.
                </p>
                <div className="max-h-72 overflow-y-auto rounded-md border">
                  <ul className="divide-y">
                    {importPreview.entries.map((entry) => (
                      <li
                        key={`${entry.kind}:${entry.stableId}`}
                        className="flex flex-col gap-1 p-3 text-sm"
                      >
                        <span className="font-medium">
                          {entry.name}{" "}
                          <span className="text-muted-foreground">
                            ({entry.kind})
                          </span>
                          <Badge variant="secondary">Proposed</Badge>
                        </span>
                        <span className="font-mono text-xs">
                          {entry.stableId}
                        </span>
                        <a
                          className="break-all text-primary underline"
                          href={entry.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {entry.sourceUrl}
                        </a>
                        <span className="flex flex-wrap gap-2">
                          <Badge>
                            {entry.status === "create"
                              ? "Create"
                              : "Skip existing"}
                          </Badge>
                        </span>
                        {entry.status === "skip_existing" && entry.existing ? (
                          <span className="flex flex-col gap-1 text-xs text-muted-foreground">
                            <span>
                              {`Existing preserved: ${entry.existing.name}`}
                              {entry.existing.archived ? " - Archived" : ""}
                            </span>
                            {entry.existing.sourceUrl ? (
                              <a
                                className="break-all text-primary underline"
                                href={entry.existing.sourceUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {entry.existing.sourceUrl}
                              </a>
                            ) : (
                              <span>No source URL</span>
                            )}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            ) : null}
            {importError ? (
              <Alert variant="destructive">{importError}</Alert>
            ) : null}
            {importResult ? <Alert>{importResult}</Alert> : null}
            <DialogFooter showCloseButton>
              <Button
                variant="outline"
                onClick={openImport}
                disabled={importLoading || importApplying}
              >
                Refresh preview
              </Button>
              <Button
                onClick={applyImport}
                disabled={
                  importLoading ||
                  importApplying ||
                  !!importError ||
                  !importPreview ||
                  importPreview.createCount === 0
                }
              >
                {importApplying ? "Applying..." : "Apply import"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
      {isAdmin ? (
        <Dialog
          open={bulkOpen}
          onOpenChange={(open) => {
            bulkGeneration.current += 1
            bulkPreviewRequest.current += 1
            setBulkOpen(open)
            if (!open) {
              setBulkFile(null)
              setBulkContent(null)
              setBulkFormat(null)
              setBulkLoading(false)
              setBulkApplying(false)
              clearBulkPreview()
            } else {
              setBulkFile(null)
              setBulkContent(null)
              setBulkFormat(null)
              setBulkLoading(false)
              setBulkApplying(false)
              clearBulkPreview()
            }
          }}
        >
          <DialogContent className="sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>Import CSV/JSON catalog entries</DialogTitle>
              <DialogDescription>
                Select a UTF-8 CSV or JSON file, preview proposed rows, then
                explicitly apply.
              </DialogDescription>
            </DialogHeader>
            <Alert>
              No existing entries are overwritten. Imports do not grant
              characters access. Review sources before applying.
            </Alert>
            <div className="flex flex-col gap-2">
              <Label htmlFor="bulk-catalog-file">
                Catalog file (maximum 1 MiB)
              </Label>
              <Input
                id="bulk-catalog-file"
                type="file"
                accept=".csv,.json,text/csv,application/json"
                onChange={(event) =>
                  void readBulkFile(event.target.files?.[0] ?? null)
                }
              />
              <p className="text-sm text-muted-foreground">
                Detected format: {bulkFormat ?? "not selected"}
                {bulkFile ? ` - ${bulkFile.name}` : ""}
              </p>
            </div>
            {bulkLoading ? <p role="status">Preparing preview...</p> : null}
            {bulkPreview ? (
              <>
                <p className="text-sm font-medium">
                  {bulkPreview.createCount} to create; {bulkPreview.skipCount}{" "}
                  to skip existing.
                </p>
                <div className="max-h-80 overflow-y-auto rounded-md border">
                  <ul className="divide-y">
                    {bulkPreview.entries.map((entry) => (
                      <li
                        key={`${entry.row}:${entry.kind}:${entry.stableId}`}
                        className="flex flex-col gap-1 p-3 text-sm"
                      >
                        <span className="text-xs text-muted-foreground">
                          Source row {entry.row}
                        </span>
                        <span className="font-medium">
                          {entry.name}{" "}
                          <span className="text-muted-foreground">
                            ({entry.kind})
                          </span>
                        </span>
                        <span className="font-mono text-xs">
                          {entry.stableId}
                        </span>
                        {entry.sourceUrl ? (
                          <a
                            className="break-all text-primary underline"
                            href={entry.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {entry.sourceUrl}
                          </a>
                        ) : (
                          <span>No source URL</span>
                        )}
                        <Badge variant="secondary">
                          {entry.status === "create"
                            ? "Create"
                            : "Skip existing"}
                        </Badge>
                        {entry.status === "skip_existing" && entry.existing ? (
                          <span className="text-xs text-muted-foreground">
                            Existing preserved: {entry.existing.name}
                            {entry.existing.archived ? " - Archived" : ""};{" "}
                            {entry.existing.sourceUrl ?? "No source URL"}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            ) : null}
            {bulkError ? (
              <Alert variant="destructive">{bulkError}</Alert>
            ) : null}
            {bulkResult ? <Alert role="status">{bulkResult}</Alert> : null}
            <DialogFooter showCloseButton>
              <Button
                variant="outline"
                onClick={() => void requestBulkPreview()}
                disabled={
                  !bulkContent || !bulkFormat || bulkLoading || bulkApplying
                }
              >
                {bulkError ===
                "Import succeeded, but refresh failed. Retry preview"
                  ? "Retry preview"
                  : "Preview file"}
              </Button>
              <Button
                onClick={applyBulk}
                disabled={
                  !bulkPreview ||
                  !bulkContent ||
                  bulkPreview.createCount === 0 ||
                  bulkLoading ||
                  bulkApplying ||
                  !!bulkError
                }
              >
                {bulkApplying ? "Applying..." : "Apply import"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  )
}
