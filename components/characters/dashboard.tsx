"use client"

import * as React from "react"
import Link from "next/link"
import {
  ArchiveIcon,
  DownloadIcon,
  PlusIcon,
  SearchIcon,
  UploadIcon,
  UserIcon,
} from "lucide-react"
import { toast } from "sonner"

import {
  apiFetch,
  jsonInit,
  type CharacterListItem,
  type CharacterResponse,
  type CharactersResponse,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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

type ArchiveFilter = "active" | "archived" | "all"
type SortOrder = "updatedDesc" | "updatedAsc" | "nameAsc"

interface DashboardState {
  query: string
  archive: ArchiveFilter
  sort: SortOrder
}

const STORAGE_KEY = "primal-dashboard-state"

function formatUpdated(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

function loadState(): DashboardState {
  if (typeof window === "undefined") {
    return { query: "", archive: "active", sort: "updatedDesc" }
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { query: "", archive: "active", sort: "updatedDesc" }
    const parsed = JSON.parse(raw) as Partial<DashboardState>
    return {
      query: typeof parsed.query === "string" ? parsed.query : "",
      archive:
        parsed.archive === "archived" || parsed.archive === "all"
          ? parsed.archive
          : "active",
      sort:
        parsed.sort === "updatedAsc" || parsed.sort === "nameAsc"
          ? parsed.sort
          : "updatedDesc",
    }
  } catch {
    return { query: "", archive: "active", sort: "updatedDesc" }
  }
}

export function CharactersDashboard() {
  const [characters, setCharacters] = React.useState<
    CharacterListItem[] | null
  >(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [prefs, setPrefs] = React.useState<DashboardState>(() => loadState())
  const [pendingArchive, setPendingArchive] =
    React.useState<CharacterListItem | null>(null)
  const [archiving, setArchiving] = React.useState(false)
  const [importing, setImporting] = React.useState(false)
  const [importConfirm, setImportConfirm] = React.useState<{
    fileName: string
    document: unknown
  } | null>(null)
  const importFileRef = React.useRef<HTMLInputElement | null>(null)

  const importFileChange = React.useCallback((file: File | undefined) => {
    if (!file) return
    const MB_BYTES = 1024 * 1024
    if (file.size > 2 * MB_BYTES) {
      toast.error(`"${file.name}" is larger than the 2MiB import limit.`)
      return
    }
    file
      .text()
      .then((text) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          toast.error(`"${file.name}" is not valid JSON.`)
          return
        }
        setImportConfirm({ fileName: file.name, document: parsed })
      })
      .catch(() => toast.error(`Could not read "${file.name}".`))
  }, [])

  const load = React.useCallback(async () => {
    try {
      const res = await apiFetch<CharactersResponse>(
        "/api/characters?withStatus=1&archived=1"
      )
      setCharacters(res.characters)
      setError(null)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load characters."
      )
    } finally {
      setLoading(false)
    }
  }, [])

  const confirmImport = React.useCallback(async () => {
    if (!importConfirm) return
    setImporting(true)
    try {
      await apiFetch<CharacterResponse>("/api/characters/import", {
        ...jsonInit("POST", { document: importConfirm.document }),
      })
      toast.success("Character imported as an unverified backup.")
      setImportConfirm(null)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed.")
    } finally {
      setImporting(false)
    }
  }, [importConfirm, load])

  React.useEffect(() => {
    let active = true
    apiFetch<CharactersResponse>("/api/characters?withStatus=1&archived=1")
      .then((res) => {
        if (!active) return
        setCharacters(res.characters)
        setError(null)
      })
      .catch((err) => {
        if (!active) return
        setError(
          err instanceof Error ? err.message : "Failed to load characters."
        )
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  // Persist the dashboard view state (search / filter / sort) across reloads.
  React.useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
    } catch {
      // Ignore storage quota / availability errors.
    }
  }, [prefs])

  const visible = React.useMemo(() => {
    if (!characters) return []
    const query = prefs.query.trim().toLowerCase()
    const list = characters.filter((c) => {
      const matchesQuery =
        query.length === 0 || c.name.toLowerCase().includes(query)
      const matchesArchive =
        prefs.archive === "all" ||
        (prefs.archive === "archived" && c.archived) ||
        (prefs.archive === "active" && !c.archived)
      return matchesQuery && matchesArchive
    })
    return [...list].sort((a, b) => {
      if (prefs.sort === "nameAsc") return a.name.localeCompare(b.name)
      if (prefs.sort === "updatedAsc")
        return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime()
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    })
  }, [characters, prefs])

  const confirmArchive = React.useCallback(async () => {
    if (!pendingArchive) return
    setArchiving(true)
    try {
      await apiFetch(`/api/characters/${pendingArchive.id}`, {
        method: "DELETE",
      })
      toast.success(`Archived "${pendingArchive.name}".`)
      setPendingArchive(null)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Archive failed.")
    } finally {
      setArchiving(false)
    }
  }, [pendingArchive, load])

  const restoreCharacter = React.useCallback(
    async (item: CharacterListItem) => {
      try {
        await apiFetch<CharacterResponse>(`/api/characters/${item.id}`, {
          ...jsonInit("PATCH", { archived: false }),
        })
        toast.success(`Restored "${item.name}".`)
        await load()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Restore failed.")
      }
    },
    [load]
  )

  const exportCharacter = React.useCallback(async (item: CharacterListItem) => {
    try {
      const res = await fetch(`/api/characters/${item.id}/export`)
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
      a.download = `${item.name.replace(/[^a-z0-9\-_ ]+/gi, "").trim() || "character"}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast.success(`Exported "${item.name}".`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed.")
    }
  }, [])

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-lg font-medium">Characters</h1>
        <p className="text-xs text-muted-foreground">
          Manage and forge your characters.
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex flex-col gap-1.5 sm:flex-1">
          <Label htmlFor="character-search">Search</Label>
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="character-search"
              className="pl-7"
              placeholder="Search by name"
              value={prefs.query}
              onChange={(e) =>
                setPrefs((p) => ({ ...p, query: e.target.value }))
              }
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="archive-filter">Status</Label>
          <Select
            value={prefs.archive}
            onValueChange={(value) =>
              setPrefs((p) => ({ ...p, archive: value as ArchiveFilter }))
            }
          >
            <SelectTrigger id="archive-filter" className="w-[10rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sort-order">Sort</Label>
          <Select
            value={prefs.sort}
            onValueChange={(value) =>
              setPrefs((p) => ({ ...p, sort: value as SortOrder }))
            }
          >
            <SelectTrigger id="sort-order" className="w-[11rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="updatedDesc">Recently updated</SelectItem>
              <SelectItem value="updatedAsc">Least recently</SelectItem>
              <SelectItem value="nameAsc">Name (A-Z)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-xs text-destructive">
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
        </div>
      ) : null}

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <CardTitle className="h-4 w-2/3 animate-pulse rounded bg-muted" />
              </CardHeader>
              <CardContent>
                <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Link
            href="/characters/new"
            className="group flex min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
          >
            <PlusIcon className="size-6" />
            <span className="text-xs">Create a character</span>
          </Link>

          <button
            type="button"
            onClick={() => importFileRef.current?.click()}
            className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
          >
            <UploadIcon className="size-6" />
            <span className="text-xs">Import from backup</span>
          </button>

          <input
            ref={importFileRef}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={(e) => {
              importFileChange(e.target.files?.[0])
              e.target.value = ""
            }}
          />

          {visible.map((item) => {
            return (
              <Card key={item.id}>
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle>
                      <Link
                        href={`/characters/${item.id}`}
                        className="hover:underline"
                      >
                        {item.name}
                      </Link>
                    </CardTitle>
                    {item.archived ? (
                      <Badge variant="outline">Archived</Badge>
                    ) : null}
                  </div>
                  <CardDescription>
                    {[item.raceName, item.className, item.professionName]
                      .filter(Boolean)
                      .join(" / ") || "No choices yet"}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <UserIcon className="size-3.5" />
                      <span className="truncate">
                        {item.description?.trim() || "No description"}
                      </span>
                    </div>
                    <div className="text-[0.6875rem] text-muted-foreground">
                      Updated {formatUpdated(item.updatedAt)}
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="xs"
                        className="gap-1"
                        onClick={() => exportCharacter(item)}
                      >
                        <DownloadIcon />
                        Export
                      </Button>
                      {item.archived ? (
                        <Button
                          variant="outline"
                          size="xs"
                          className="gap-1"
                          onClick={() => restoreCharacter(item)}
                        >
                          <ArchiveIcon />
                          Restore
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="xs"
                          className="gap-1"
                          onClick={() => setPendingArchive(item)}
                        >
                          <ArchiveIcon />
                          Archive
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {!loading && characters && visible.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-xs text-muted-foreground">
          No characters match your filters.
        </div>
      ) : null}

      <Dialog
        open={!!pendingArchive}
        onOpenChange={(open) => !open && setPendingArchive(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive character</DialogTitle>
            <DialogDescription>
              Archive &quot;{pendingArchive?.name}&quot;? It will be hidden from
              your list. You can re-enable it later.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton>
            <Button
              variant="destructive"
              onClick={confirmArchive}
              disabled={archiving}
            >
              {archiving ? "Archiving..." : "Archive"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!importConfirm}
        onOpenChange={(open) => !open && setImportConfirm(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import backup</DialogTitle>
            <DialogDescription>
              Importing &quot;{importConfirm?.fileName ?? ""}&quot; as a new
              character owned by you.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 text-xs/relaxed text-muted-foreground">
            <p>
              This backup is <span className="font-medium">unverified</span>:
              imported history is kept as source provenance, and the live status
              is recomputed from the current catalog.
            </p>
            <p>
              Any catalog definition the backup references (race, class,
              profession, titles, equipment or skills) that is missing,
              archived, or the wrong kind is{" "}
              <span className="font-medium">rejected</span>, and nothing is
              imported.
            </p>
            <p>
              The import never overwrites an existing character; it always
              creates a new one.
            </p>
          </div>
          <DialogFooter showCloseButton>
            <Button
              variant="outline"
              onClick={() => setImportConfirm(null)}
              disabled={importing}
            >
              Cancel
            </Button>
            <Button onClick={confirmImport} disabled={importing}>
              {importing ? "Importing..." : "Import"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
