"use client"

import * as React from "react"
import { toast } from "sonner"

import { cn } from "cn"

import {
  apiFetch,
  jsonInit,
  type CharacterDetail,
  type EvolveResponse,
  type EvolutionOptionView,
  type EvolutionOptionsResult,
} from "@/lib/api"
import { Alert } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

function TrackNameBadge({ option }: { option: EvolutionOptionView }) {
  const label =
    option.track === "race"
      ? "Race"
      : option.track === "class"
        ? "Class"
        : "Profession"
  return (
    <Badge variant="outline">
      {label}: {option.toTrackName}
    </Badge>
  )
}

/**
 * Class/profession evolution dialog.
 *
 * This is deliberately per-track: it only ever evolves the selected class or
 * profession track's own `grade`/`definitionId` and never suggests changing the
 * race grade. The options are the contextual next-grade-only catalog paths for
 * that track, and there is no class/profession grade-only legacy fallback - so
 * when the track has no explicit grade (a legacy graded-unknown state) this
 * dialog shows the note below and offers no paths.
 *
 * The parent mounts this only while a track is selected, so it starts fresh on
 * every open and fetches its options on mount.
 */
export function TrackEvolutionDialog({
  track,
  character,
  isAdmin,
  onClose,
  onEvolved,
}: {
  track: "class" | "profession"
  character: CharacterDetail
  isAdmin: boolean
  onClose: () => void
  onEvolved: () => void
}) {
  const trackName = track === "class" ? "Class" : "Profession"
  const trackState = character.state.tracks[track]
  const trackGrade = trackState?.grade
  const trackLevel = trackState?.level ?? 0

  const [options, setOptions] = React.useState<EvolutionOptionsResult | null>(
    null
  )
  const [error, setError] = React.useState<string | null>(null)
  const [selectedOptionId, setSelectedOptionId] = React.useState("")
  const [reason, setReason] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [reloadKey, setReloadKey] = React.useState(0)

  // Loading is derived, never stored: we are loading while we have neither
  // options nor an error. This keeps the mount effect free of synchronous
  // setState (the React Compiler lint forbids it).
  const loading = options == null && error == null

  React.useEffect(() => {
    if (trackGrade == null) return
    let ignore = false
    apiFetch<EvolutionOptionsResult>(
      `/api/characters/${character.id}/evolutions?track=${track}`
    )
      .then((res) => {
        if (ignore) return
        setOptions(res)
        const firstSelectable = res.options.find(
          (o) => o.eligible && (isAdmin ? true : !o.manualReview)
        )
        setSelectedOptionId(firstSelectable?.id ?? res.options[0]?.id ?? "")
        setError(null)
      })
      .catch((err) => {
        if (ignore) return
        setError(err instanceof Error ? err.message : "Failed to load options.")
        setOptions(null)
      })
    return () => {
      ignore = true
    }
  }, [track, trackGrade, reloadKey, character.id, isAdmin])

  const selectedOption = (options?.options ?? []).find(
    (o) => o.id === selectedOptionId
  )
  const canConfirm =
    options != null &&
    selectedOption?.eligible === true &&
    (!selectedOption.manualReview || (isAdmin && reason.trim().length > 0))

  const submit = React.useCallback(async () => {
    if (!selectedOption) return
    setBusy(true)
    setError(null)
    try {
      await apiFetch<EvolveResponse>(`/api/characters/${character.id}/evolve`, {
        ...jsonInit("POST", {
          track,
          optionId: selectedOption.id,
          version: character.version,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        }),
      })
      toast.success(
        `Evolved ${trackName.toLowerCase()} grade to ${selectedOption.toGrade}.`
      )
      onClose()
      onEvolved()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Evolution failed.")
    } finally {
      setBusy(false)
    }
  }, [
    character.id,
    character.version,
    track,
    trackName,
    selectedOption,
    reason,
    onClose,
    onEvolved,
  ])

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Evolve {trackName.toLowerCase()} grade</DialogTitle>
          <DialogDescription>
            This only progresses the {trackName.toLowerCase()} track&apos;s own
            grade and definition. The race grade is never touched.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1 text-xs/relaxed text-muted-foreground">
          <span>
            Current {trackName.toLowerCase()} grade:{" "}
            <span className="font-medium">{trackGrade ?? "unknown"}</span>
          </span>
          <span>
            {trackName} level: <span className="font-medium">{trackLevel}</span>
          </span>
        </div>

        {trackGrade == null ? (
          <p className="text-xs/relaxed text-muted-foreground">
            This {trackName.toLowerCase()} track has no explicit grade yet (a
            legacy state). There are no class/profession evolution paths to
            offer until it is given an explicit grade.
          </p>
        ) : loading ? (
          <p className="text-xs text-muted-foreground">
            Loading {trackName.toLowerCase()} evolution options...
          </p>
        ) : error ? (
          <div className="flex flex-col gap-2">
            <Alert variant="destructive">{error}</Alert>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setReloadKey((k) => k + 1)}
            >
              Retry
            </Button>
          </div>
        ) : options == null ? (
          <p className="text-xs text-muted-foreground">
            Could not load {trackName.toLowerCase()} evolution options.
          </p>
        ) : (options.options ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No {trackName.toLowerCase()} evolution options are available yet.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {(options.options ?? []).map((option) => {
              const selected = option.id === selectedOptionId
              const selectable = option.eligible
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => {
                    if (!selectable) return
                    setSelectedOptionId(option.id)
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
                    <TrackNameBadge option={option} />
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
                    {option.sourceUrl ? `Source: ${option.sourceUrl}` : null}
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
          </div>
        )}

        {selectedOption?.manualReview && isAdmin ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="track-evolve-reason">
              Reason (required to override manual requirements)
            </Label>
            <Input
              id="track-evolve-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        ) : null}

        {error && options != null ? (
          <p role="alert" className="text-xs/relaxed text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canConfirm || busy}>
            {busy
              ? "Evolving..."
              : `Evolve to ${selectedOption?.toGrade ?? "-"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
