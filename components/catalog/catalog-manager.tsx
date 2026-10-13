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

const PROVENANCE_OPTIONS = [
  { value: "verified", label: "Verified" },
  { value: "inferred", label: "Inferred" },
  { value: "house", label: "House" },
] as const

interface FormState {
  name: string
  description: string
  grade: string
  provenance: string
  sourceUrl: string
  configText: string
}

const EMPTY_FORM: FormState = {
  name: "",
  description: "",
  grade: "",
  provenance: "house",
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
    provenance: string
    status: "create" | "skip_existing"
    existing?: {
      id: string
      name: string
      sourceUrl: string | null
      provenance: string
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
    provenance: string
    status: "create" | "skip_existing"
    existing?: {
      id: string
      name: string
      sourceUrl: string | null
      provenance: string
      archived: boolean
    }
  }>
  createCount: number
  skipCount: number
}

function toForm(item: CatalogItem): FormState {
  return {
    name: item.name,
    description: item.description ?? "",
    grade: item.grade ?? "",
    provenance: item.provenance,
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
    setSubmitting(true)
    setFormError(null)
    try {
      const body = {
        name: form.name,
        ...(form.description.trim() ? { description: form.description } : {}),
        ...(form.grade.trim() ? { grade: form.grade } : {}),
        provenance: form.provenance,
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
  }, [editing, form, kind, load])

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
                <TableHead>Provenance</TableHead>
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
                    <TableCell className="capitalize">
                      {item.provenance}
                    </TableCell>
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
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit entry" : "New entry"}</DialogTitle>
            <DialogDescription>
              Configure the catalog entry. Invalid JSON in the config field is
              rejected before saving.
            </DialogDescription>
          </DialogHeader>
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
            <div className="grid grid-cols-2 gap-3">
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
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cat-provenance">Provenance</Label>
                <Select
                  value={form.provenance}
                  onValueChange={(value) =>
                    setForm((f) => ({
                      ...f,
                      provenance: value ?? f.provenance,
                    }))
                  }
                >
                  <SelectTrigger id="cat-provenance" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVENANCE_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
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
              <Label htmlFor="cat-config">Config (JSON)</Label>
              <Textarea
                id="cat-config"
                className="min-h-28 font-mono text-[0.6875rem]"
                value={form.configText}
                onChange={(e) =>
                  setForm((f) => ({ ...f, configText: e.target.value }))
                }
              />
            </div>
            {formError ? (
              <Alert variant="destructive">{formError}</Alert>
            ) : null}
          </div>
          <DialogFooter showCloseButton>
            <Button
              onClick={save}
              disabled={submitting || form.name.trim().length === 0}
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
                          {entry.provenance === "inferred" ? (
                            <Badge variant="secondary">Inferred</Badge>
                          ) : (
                            <Badge variant="secondary">
                              {entry.provenance}
                            </Badge>
                          )}
                        </span>
                        {entry.status === "skip_existing" && entry.existing ? (
                          <span className="flex flex-col gap-1 text-xs text-muted-foreground">
                            <span>
                              {`Existing preserved: ${entry.existing.name} (${entry.existing.provenance})`}
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
              characters access, and provenance is not independently verified.
              Review sources and provenance before applying.
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
                        <span>Provenance: {entry.provenance}</span>
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
                            Existing preserved: {entry.existing.name} (
                            {entry.existing.provenance})
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
