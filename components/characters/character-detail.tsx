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
} from "lucide-react"

import {
  apiFetch,
  jsonInit,
  ATTRIBUTE_KEYS,
  type AttributeKey,
  type CharacterDetail,
  type CharacterResponse,
  type AdvanceResponse,
  type AllocateResponse,
  type ExportResponse,
  type EvolveResponse,
  type Grade,
  type JournalDelta,
} from "@/lib/api"
import { AppShell } from "@/components/app-shell"
import { AllocationEditor } from "@/components/characters/allocation-editor"
import { Alert } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
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

export function CharacterDetail() {
  const params = useParams<{ id: string }>()
  const id = params.id

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

  const evolve = React.useCallback(
    async (target: Grade) => {
      if (!character) return
      setEvolveBusy(true)
      setEvolveError(null)
      try {
        const res = await apiFetch<EvolveResponse>(
          `/api/characters/${character.id}/evolve`,
          {
            ...jsonInit("POST", {
              grade: target,
              version: character.version,
            }),
          }
        )
        setEvolveOpen(false)
        toast.success(`Evolved race grade to ${res.journal.to}.`)
        await reload()
      } catch (err) {
        setEvolveError(err instanceof Error ? err.message : "Evolution failed.")
      } finally {
        setEvolveBusy(false)
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

  if (loading && !character) {
    return (
      <AppShell breadcrumbs={[{ label: "Character" }]}>
        <div className="flex flex-col gap-4">
          <div className="h-6 w-1/3 animate-pulse rounded bg-muted" />
          <div className="h-32 animate-pulse rounded-lg bg-muted" />
        </div>
      </AppShell>
    )
  }

  if (error && !character) {
    return (
      <AppShell breadcrumbs={[{ label: "Character" }]}>
        <Alert variant="destructive">
          {error}{" "}
          <Button variant="outline" className="ml-2" onClick={reload}>
            Retry
          </Button>
        </Alert>
      </AppShell>
    )
  }

  if (!character) return null

  const state = character.state
  const classTrack = state.tracks["class"]
  const professionTrack = state.tracks["profession"]
  const status = character.status
  const raceGrade = state.race.grade
  const evolveTarget = evolutionTarget(state.race.level, raceGrade)

  const breadcrumbs = [
    { label: "Characters", href: "/" },
    { label: character.name },
  ]

  return (
    <AppShell breadcrumbs={breadcrumbs}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate font-heading text-lg font-medium">
                {character.name}
              </h1>
              {character.archived ? <Badge>Archived</Badge> : null}
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
          </div>
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
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            onClick={() => {
              setEvolveError(null)
              setEvolveOpen(true)
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

        <Tabs value={activeTab} onValueChange={(v) => v && setActiveTab(v)}>
          <TabsList variant="line">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="attributes">Attributes</TabsTrigger>
            <TabsTrigger value="identity">
              Race / Class / Profession
            </TabsTrigger>
            <TabsTrigger value="skills">Skills</TabsTrigger>
            <TabsTrigger value="equipment">Equipment</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
            <TabsTrigger value="notes">Notes</TabsTrigger>
          </TabsList>

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
                <p className="text-xs text-muted-foreground">
                  Skills are not yet tracked on characters. A character does not
                  record skill references yet, so none can be shown here.
                </p>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="equipment" className="pt-3">
            {status && status.equipment.items.length > 0 ? (
              <div className="overflow-x-auto rounded-lg border">
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
                          {ATTRIBUTE_KEYS.filter(
                            (a) => item.suppressed[a] !== 0
                          )
                            .map((a) => `${a}:${item.suppressed[a]}`)
                            .join(", ") || "0"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <Card>
                <CardContent>
                  <p className="text-xs text-muted-foreground">
                    No equipment is attached to this character yet. Equipment
                    bonuses are not currently granted, so no values are
                    calculated here.
                  </p>
                </CardContent>
              </Card>
            )}
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
              <p className="text-xs text-muted-foreground">
                Loading history...
              </p>
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
                    <Label htmlFor="note-description">
                      Notes / description
                    </Label>
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
                This progresses race grade only - from {raceGrade} to{" "}
                {evolveTarget ?? ""}. Class/profession evolution is not selected
                yet, so the system will not auto-choose an option for you.
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
                onClick={() => evolveTarget && evolve(evolveTarget)}
                disabled={evolveBusy || !evolveTarget}
              >
                {evolveBusy
                  ? "Evolving..."
                  : `Evolve to ${evolveTarget ?? "-"}`}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AppShell>
  )
}
