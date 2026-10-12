"use client"

import * as React from "react"
import { toast } from "sonner"
import { PlusIcon, SearchIcon, PencilIcon, LinkIcon } from "lucide-react"

import {
  apiFetch,
  jsonInit,
  type CatalogItem,
  type CatalogListResponse,
} from "@/lib/api"
import { useAppShell } from "@/components/app-shell"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
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

  const load = React.useCallback(async () => {
    try {
      const res = await apiFetch<CatalogListResponse>(`/api/catalog/${kind}`)
      setItems(res.items)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load catalog.")
    } finally {
      setLoading(false)
    }
  }, [kind])

  React.useEffect(() => {
    let active = true
    apiFetch<CatalogListResponse>(`/api/catalog/${kind}`)
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
  }, [kind])

  const visible = React.useMemo(() => {
    if (!items) return []
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.stableId.toLowerCase().includes(q)
    )
  }, [items, query])

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
        config,
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
          <Button className="gap-1" onClick={openCreate}>
            <PlusIcon />
            New entry
          </Button>
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
                    <TableCell className="font-medium">{item.name}</TableCell>
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
    </div>
  )
}
