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
import { ATTRIBUTE_KEYS } from "@/lib/api"
import {
  EQUIPMENT_RARITIES,
  EQUIPMENT_SLOTS,
  EQUIPMENT_UNIQUE_RARITY,
} from "@/lib/server/schemas"

const GRADES = ["G", "F", "E", "D", "C", "B", "A", "S"] as const
const RARITIES = [...EQUIPMENT_RARITIES, EQUIPMENT_UNIQUE_RARITY] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

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

interface FormState {
  name: string
  description: string
  grade: string
  sourceUrl: string
  configText: string
}

const EMPTY_FORM: FormState = {
  name: "",
  description: "",
  grade: "",
  sourceUrl: "",
  configText: "{}",
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
  return {
    name: item.name,
    description: item.description ?? "",
    grade:
      item.kind === "races" && typeof config.naturalGrade === "string"
        ? config.naturalGrade
        : (item.grade ?? ""),
    sourceUrl: item.sourceUrl ?? "",
    configText: JSON.stringify(item.config ?? {}, null, 2),
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
  const blessingConfig = React.useMemo(() => {
    if (kind !== "blessings") return null
    try {
      const value: unknown = JSON.parse(form.configText || "{}")
      if (value == null || typeof value !== "object" || Array.isArray(value))
        return { valid: false as const, config: null, legacy: false }
      const config = value as Record<string, unknown>
      return {
        valid: true as const,
        config,
        legacy:
          Object.hasOwn(config, "grade") || Object.hasOwn(config, "effect"),
      }
    } catch {
      return { valid: false as const, config: null, legacy: false }
    }
  }, [form.configText, kind])
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
  const [submitting, setSubmitting] = React.useState(false)
  const [formError, setFormError] = React.useState<string | null>(null)
  const [showArchived, setShowArchived] = React.useState(false)
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
    setFormError(null)
    setDialogOpen(true)
  }, [])

  const openEdit = React.useCallback((item: CatalogItem) => {
    setEditing(item)
    setForm(toForm(item))
    setFormError(null)
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
    if (
      kind === "blessings" &&
      (Object.hasOwn(config, "grade") || Object.hasOwn(config, "effect"))
    ) {
      setFormError(
        "Legacy blessing config must be explicitly migrated to modern tier and effects config before saving."
      )
      return
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
                `${grade}-grade rows require a numeric value for every attribute.`
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
      kind === "skills" &&
      !editing &&
      !RARITIES.includes(String(config.rarity) as (typeof RARITIES)[number])
    ) {
      setFormError("Choose a supported rarity before creating a skill.")
      return
    }
    setSubmitting(true)
    setFormError(null)
    try {
      const body = {
        name: form.name,
        ...(form.description.trim() ? { description: form.description } : {}),
        ...(form.grade.trim() &&
        (kind !== "races" ||
          !editing ||
          form.grade !==
            (isRecord(editing.config) &&
            typeof editing.config.naturalGrade === "string"
              ? editing.config.naturalGrade
              : editing.grade))
          ? { grade: form.grade }
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
      setFormError(err instanceof Error ? err.message : "Save failed.")
    } finally {
      setSubmitting(false)
    }
  }, [editing, form, kind, load, structuredKind])

  const openSource = React.useCallback((url: string | null) => {
    if (url) window.open(url, "_blank", "noopener")
  }, [])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-lg font-medium capitalize">
            {kind}
          </h1>
          <p className="text-xs text-muted-foreground">
            Catalog entries for {kind}.
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
              New entry
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
                visible.map((item) => (
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
                ))
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
            <DialogTitle>{editing ? "Edit entry" : "New entry"}</DialogTitle>
            <DialogDescription>
              Configure the catalog entry. Invalid JSON in the config field is
              rejected before saving.
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
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cat-description">Description</Label>
                <Textarea
                  id="cat-description"
                  value={form.description}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, description: e.target.value }))
                  }
                />
              </div>
              {structuredKind ? (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="cat-grade">
                    {kind === "races" ? "Natural grade" : "Initial grade"}
                  </Label>
                  <div
                    id="cat-grade"
                    role="radiogroup"
                    aria-label={
                      kind === "races" ? "Natural grade" : "Initial grade"
                    }
                    className="grid grid-cols-8 overflow-hidden rounded-md border"
                    onKeyDown={(event) => {
                      const current = GRADES.indexOf(
                        form.grade as (typeof GRADES)[number]
                      )
                      const next =
                        event.key === "ArrowRight" || event.key === "ArrowDown"
                          ? (current + 1) % GRADES.length
                          : event.key === "ArrowLeft" || event.key === "ArrowUp"
                            ? (current - 1 + GRADES.length) % GRADES.length
                            : event.key === "Home"
                              ? 0
                              : event.key === "End"
                                ? GRADES.length - 1
                                : -1
                      if (next >= 0) {
                        event.preventDefault()
                        const buttons =
                          event.currentTarget.querySelectorAll("button")
                        ;(buttons[next] as HTMLButtonElement)?.focus()
                        setForm((f) => ({ ...f, grade: GRADES[next] }))
                      }
                    }}
                  >
                    {GRADES.map((grade) => (
                      <Button
                        key={grade}
                        type="button"
                        size="sm"
                        role="radio"
                        disabled={!structuredConfig}
                        variant={form.grade === grade ? "secondary" : "outline"}
                        aria-checked={form.grade === grade}
                        tabIndex={
                          form.grade === grade ||
                          (!form.grade && grade === GRADES[0])
                            ? 0
                            : -1
                        }
                        className="rounded-none border-0 border-r last:border-r-0 focus-visible:z-10"
                        onClick={() => setForm((f) => ({ ...f, grade }))}
                      >
                        {grade}
                      </Button>
                    ))}
                  </div>
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
                    </div>
                  ) : null}
                </div>
              ) : !["equipment", "skills"].includes(kind) ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cat-grade">Grade</Label>
                  <Input
                    id="cat-grade"
                    value={form.grade}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, grade: e.target.value }))
                    }
                  />
                </div>
              ) : null}
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
                {kind === "blessings" ? (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="cat-blessing-tier">Blessing tier</Label>
                    <Select
                      value={
                        blessingConfig?.valid &&
                        !blessingConfig.legacy &&
                        typeof blessingConfig.config.tier === "string"
                          ? blessingConfig.config.tier
                          : ""
                      }
                      disabled={!blessingConfig?.valid || blessingConfig.legacy}
                      onValueChange={(value) => {
                        if (
                          !value ||
                          !blessingConfig?.valid ||
                          blessingConfig.legacy
                        )
                          return
                        const next: Record<string, unknown> = {
                          ...blessingConfig.config,
                          tier: value,
                        }
                        if (
                          !editing &&
                          Object.keys(blessingConfig.config).length === 0
                        )
                          next.effects = []
                        setForm((current) => ({
                          ...current,
                          configText: JSON.stringify(next, null, 2),
                        }))
                      }}
                    >
                      <SelectTrigger id="cat-blessing-tier" className="w-full">
                        <SelectValue placeholder="Select a tier" />
                      </SelectTrigger>
                      <SelectContent>
                        {BLESSING_TIERS.map((tier) => (
                          <SelectItem key={tier} value={tier}>
                            {tier}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Tier is descriptive only; it does not imply numeric
                      effects.
                    </p>
                    {!blessingConfig?.valid ? (
                      <p role="alert" className="text-sm text-destructive">
                        Correct Config JSON before selecting a tier; current
                        edits are preserved.
                      </p>
                    ) : blessingConfig.legacy ? (
                      <p role="alert" className="text-sm text-destructive">
                        Legacy grade/effect config cannot be changed here.
                        Explicitly migrate to modern tier and effects config
                        first.
                      </p>
                    ) : null}
                  </div>
                ) : null}
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
                      </>
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
                        <Label htmlFor="min-race-level">
                          Minimum race level
                        </Label>
                        <Input
                          id="min-race-level"
                          type="number"
                          min="0"
                          disabled={!structuredConfig}
                          value={
                            typeof structuredConfig?.minRaceLevel === "number"
                              ? structuredConfig.minRaceLevel
                              : ""
                          }
                          onChange={(e) =>
                            setConfigValue(
                              "minRaceLevel",
                              e.target.value === ""
                                ? undefined
                                : Number(e.target.value)
                            )
                          }
                        />
                        <Label htmlFor="race-requirement">
                          Required race type
                        </Label>
                        <select
                          id="race-requirement"
                          disabled={!structuredConfig}
                          className="h-9 rounded-md border bg-background px-3 text-sm"
                          value={
                            typeof structuredConfig?.requiredRaceType ===
                            "string"
                              ? structuredConfig.requiredRaceType
                              : ""
                          }
                          onChange={(e) =>
                            setConfigValue(
                              "requiredRaceType",
                              e.target.value || undefined
                            )
                          }
                        >
                          <option value="">Any</option>
                          <option value="enlightened">
                            Humanoid (enlightened)
                          </option>
                          <option value="monster">Monstrous (monster)</option>
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
