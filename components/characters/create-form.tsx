"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import {
  ApiError,
  apiFetch,
  jsonInit,
  type CatalogItem,
  type CatalogListResponse,
  type CharacterResponse,
  type DraftData,
  type DraftResponse,
  type PortraitView,
  type SaveDraftRequest,
} from "@/lib/api"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@/components/ui/questionnaire"

const STORAGE_KEY = "primal-create-draft"

// Separate recovery key: while a local vs server draft conflict is unresolved,
// the device's local draft copy is kept here so a refresh cannot lose it. The
// live fallback in STORAGE_KEY is overwritten by whichever draft is applied.
const RECOVERY_KEY = "primal-create-recovery"

const ITEMS = [
  { name: "name", required: true },
  { name: "origin", required: true },
  { name: "race", required: true },
  { name: "class", required: true },
  { name: "profession", required: false },
  { name: "special", required: false },
  { name: "equipment", required: false },
  { name: "review", required: false },
] as const

// The questionnaire's item names in step order ("name" -> index 0, etc.). The
// server draft stores `step` as a numeric index; the wizard tracks it as the
// item name string, so the two are mapped on every round-trip.
const STEP_NAMES: string[] = ITEMS.map((item) => item.name)

/** Delay before an automatic draft save (debounce, in milliseconds). */
const AUTO_SAVE_DEBOUNCE_MS = 800

/** Max upload size accepted by the portrait endpoint (4 MiB). */
const MAX_PORTRAIT_BYTES = 4 * 1024 * 1024

const ALLOWED_PORTRAIT_TYPES = ["image/png", "image/jpeg", "image/webp"]

// The wizard's local draft uses string steps and a 'yes'/'none' flag for
// `special`, but only to surface legacy drafts that recorded a "has special
// abilities" flag - the UI no longer captures that choice. Only the server draft
// payload uses a numeric step, a boolean `special` and a string[] `equipment`, so
// these are mapped when crossing the API boundary. `equipment` is always empty
// here: the wizard has no equipment picker yet, so nothing is recorded until
// after the character is created. `special` is always written as `false`: special
// abilities are a deferred feature, so the wizard never submits `special=true`.
interface Draft {
  step: string
  name: string
  description: string
  origin: string
  raceId: string
  classId: string
  professionId: string
  special: string // 'yes' | 'none' (legacy only; the UI never sets 'yes')
  equipment: string // 'yes' | 'none' (always 'none'; no picker yet)
  // Draft-only metadata passthrough fields. Not rendered by this wizard but
  // preserved so a server draft never silently drops them. Neither is sent to
  // the create request (only name/description are supported identity fields).
  nickname: string | null
  pronouns: string | null
  ageDescription: string | null
  appearance: string | null
  biography: string | null
  notes: string | null
}

const EMPTY_DRAFT: Draft = {
  step: "name",
  name: "",
  description: "",
  origin: "",
  raceId: "",
  classId: "",
  professionId: "",
  special: "none",
  equipment: "none",
  nickname: null,
  pronouns: null,
  ageDescription: null,
  appearance: null,
  biography: null,
  notes: null,
}

type SaveState = "idle" | "saving" | "saved" | "error" | "conflict"

function stepNameToIndex(step: string): number {
  const idx = STEP_NAMES.indexOf(step)
  return idx >= 0 ? idx : 0
}

/** Restore a stored server step index as a valid questionnaire item name. */
function stepIndexToName(index: number): string {
  if (Number.isInteger(index) && index >= 0 && index < STEP_NAMES.length) {
    return STEP_NAMES[index]
  }
  return STEP_NAMES[0]
}

/** Map the wizard's string step and yes/no flags onto the server draft shape. */
function toServerData(draft: Draft): DraftData {
  const data: DraftData = { step: stepNameToIndex(draft.step) }
  if (draft.name) data.name = draft.name
  if (draft.description) data.description = draft.description
  if (draft.origin) data.origin = draft.origin as "integrated" | "born"
  if (draft.raceId) data.raceId = draft.raceId
  if (draft.classId) data.classId = draft.classId
  data.professionId = draft.professionId || null
  // The wizard no longer captures a "has special abilities" choice. Always
  // submit `special: false` so the UI never persists `special=true`: special
  // abilities are a deferred feature, and a legacy draft that recorded the flag
  // is normalized on the next save rather than carried as a character feature.
  data.special = false
  // Equipment is configured after the character is created - the wizard has no
  // equipment picker yet, so there are no IDs to record. Send an empty list
  // rather than a fake token, so the draft never claims a recorded choice.
  data.equipment = []
  if (draft.nickname != null) data.nickname = draft.nickname
  if (draft.pronouns != null) data.pronouns = draft.pronouns
  if (draft.ageDescription != null) data.ageDescription = draft.ageDescription
  if (draft.appearance != null) data.appearance = draft.appearance
  if (draft.biography != null) data.biography = draft.biography
  if (draft.notes != null) data.notes = draft.notes
  return data
}

/** Map server draft data back onto the wizard's local representation. */
function fromServerData(data: DraftData): Partial<Draft> {
  const d: Partial<Draft> = {}
  if (typeof data.step === "number") d.step = stepIndexToName(data.step)
  if (typeof data.name === "string") d.name = data.name
  if (typeof data.description === "string") d.description = data.description
  if (typeof data.origin === "string") d.origin = data.origin
  if (typeof data.raceId === "string") d.raceId = data.raceId
  if (typeof data.classId === "string") d.classId = data.classId
  if (typeof data.professionId === "string") d.professionId = data.professionId
  if (typeof data.special === "boolean")
    d.special = data.special ? "yes" : "none"
  if (Array.isArray(data.equipment)) {
    d.equipment = data.equipment.length > 0 ? "yes" : "none"
  }
  if (data.nickname != null) d.nickname = data.nickname
  if (data.pronouns != null) d.pronouns = data.pronouns
  if (data.ageDescription != null) d.ageDescription = data.ageDescription
  if (data.appearance != null) d.appearance = data.appearance
  if (data.biography != null) d.biography = data.biography
  if (data.notes != null) d.notes = data.notes
  return d
}

function loadDraft(): Draft {
  if (typeof window === "undefined") return EMPTY_DRAFT
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY_DRAFT
    const parsed = JSON.parse(raw) as Partial<Draft>
    return { ...EMPTY_DRAFT, ...parsed }
  } catch {
    return EMPTY_DRAFT
  }
}

/** Load a persisted recovery copy, or null when none is stored. */
function loadRecoveryDraft(): Draft | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(RECOVERY_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Draft>
    return { ...EMPTY_DRAFT, ...parsed }
  } catch {
    return null
  }
}

/** Persist the recovery copy durably under the recovery key. */
function saveRecoveryDraft(draft: Draft): void {
  try {
    window.localStorage.setItem(RECOVERY_KEY, JSON.stringify(draft))
  } catch {
    // Ignore storage availability errors.
  }
}

/** Remove the recovery copy once a choice is resolved. */
function clearRecoveryKey(): void {
  try {
    window.localStorage.removeItem(RECOVERY_KEY)
  } catch {
    // Ignore storage availability errors.
  }
}

/** Whether a recovery copy is currently stored (an unresolved choice). */
function hasRecoveryKey(): boolean {
  if (typeof window === "undefined") return false
  try {
    return window.localStorage.getItem(RECOVERY_KEY) != null
  } catch {
    return false
  }
}

/** Whether the wizard carries any real (non-default) field values. */
function hasContent(draft: Draft): boolean {
  return (
    draft.name.length > 0 ||
    draft.description.length > 0 ||
    draft.origin.length > 0 ||
    draft.raceId.length > 0 ||
    draft.classId.length > 0 ||
    draft.professionId.length > 0 ||
    draft.special === "yes" ||
    draft.equipment === "yes" ||
    draft.nickname != null ||
    draft.pronouns != null ||
    draft.ageDescription != null ||
    draft.appearance != null ||
    draft.biography != null ||
    draft.notes != null
  )
}

/**
 * True when two drafts differ on any field the wizard carries. Every Draft key
 * is compared, including the metadata passthrough fields and any equipment
 * values, so a metadata-only divergent local copy still raises a recovery
 * prompt rather than being silently overwritten by the server draft.
 */
function draftsDiffer(a: Draft, b: Draft): boolean {
  return (
    a.step !== b.step ||
    a.name !== b.name ||
    a.description !== b.description ||
    a.origin !== b.origin ||
    a.raceId !== b.raceId ||
    a.classId !== b.classId ||
    a.professionId !== b.professionId ||
    a.special !== b.special ||
    a.equipment !== b.equipment ||
    a.nickname !== b.nickname ||
    a.pronouns !== b.pronouns ||
    a.ageDescription !== b.ageDescription ||
    a.appearance !== b.appearance ||
    a.biography !== b.biography ||
    a.notes !== b.notes
  )
}

export function CreateCharacterForm() {
  const router = useRouter()
  const [draft, setDraft] = React.useState<Draft>(() => loadDraft())
  const [races, setRaces] = React.useState<CatalogItem[] | null>(null)
  const [classes, setClasses] = React.useState<CatalogItem[] | null>(null)
  const [professions, setProfessions] = React.useState<CatalogItem[] | null>(
    null
  )
  const [catalogError, setCatalogError] = React.useState<string | null>(null)
  const [catalogLoading, setCatalogLoading] = React.useState(true)
  const [submitting, setSubmitting] = React.useState(false)

  // Server draft sync state.
  const [ready, setReady] = React.useState(false)
  const [draftLoadError, setDraftLoadError] = React.useState<string | null>(
    null
  )
  const [saveState, setSaveState] = React.useState<SaveState>("idle")
  const [saveError, setSaveError] = React.useState<string | null>(null)
  // A recovery copy left by a previous session means a local vs server draft
  // choice is still unresolved. Seed both from the storage key lazily so the
  // banner and the autosave pause survive a refresh.
  const [showRecoverLocal, setShowRecoverLocal] = React.useState<boolean>(
    () => {
      return loadRecoveryDraft() != null
    }
  )
  const [localRecoverDraft, setLocalRecoverDraft] =
    React.useState<Draft | null>(() => loadRecoveryDraft())
  const [portraitFile, setPortraitFile] = React.useState<File | null>(null)

  const draftRef = React.useRef<Draft>(draft)
  const versionRef = React.useRef<number | null>(null)
  const serverPresentRef = React.useRef(false)
  // Reference to the single in-flight save operation. Every save loop sets this
  // and clears it in its `finally`, so `flushSave` can await the exact promise
  // instead of polling and risking a hang.
  const saveInFlightRef = React.useRef<Promise<boolean> | null>(null)
  const dirtyRef = React.useRef(false)
  const skipFirstSaveRef = React.useRef(true)
  const skipNextSaveRef = React.useRef(false)
  const saveStateRef = React.useRef<SaveState>(saveState)

  React.useEffect(() => {
    draftRef.current = draft
  }, [draft])

  React.useEffect(() => {
    saveStateRef.current = saveState
  }, [saveState])

  const setField = React.useCallback((field: keyof Draft, value: string) => {
    setDraft((d) => ({ ...d, [field]: value }))
  }, [])

  const applyDraft = React.useCallback((next: Draft) => {
    draftRef.current = next
    setDraft(next)
  }, [])

  // Apply the fetched server draft to local state. Called only from asynchronous
  // contexts (effect `.then`, event handlers), never synchronously from an effect,
  // so the server draft never triggers a cascading render.
  const applyServerDraft = React.useCallback(
    (res: DraftResponse) => {
      setDraftLoadError(null)
      const localNow = draftRef.current
      if (res.draft) {
        versionRef.current = res.draft.version
        serverPresentRef.current = true
        const next = { ...EMPTY_DRAFT, ...fromServerData(res.draft.data) }
        // Server is authoritative by default. Offer recovery only when the local
        // draft has real content that diverges from the server AND no recovery
        // choice is already pending. The recovery copy is persisted under its own
        // key so a refresh cannot lose it.
        if (
          hasContent(localNow) &&
          draftsDiffer(localNow, next) &&
          !hasRecoveryKey()
        ) {
          setLocalRecoverDraft(localNow)
          setShowRecoverLocal(true)
          saveRecoveryDraft(localNow)
        }
        applyDraft(next)
      } else {
        versionRef.current = null
        serverPresentRef.current = false
        // No server draft exists, so there is no local vs server conflict to
        // resolve: the device draft stands. Any lingering recovery copy from a
        // previous session is resolved and cleared so Save/Create re-enable.
        clearRecoveryKey()
        setLocalRecoverDraft(null)
        setShowRecoverLocal(false)
      }
      setReady(true)
    },
    [applyDraft]
  )

  const loadServerDraft = React.useCallback(async () => {
    try {
      const res = await apiFetch<DraftResponse>("/api/drafts")
      applyServerDraft(res)
    } catch (err) {
      setDraftLoadError(
        err instanceof Error ? err.message : "Could not sync the draft."
      )
    }
  }, [applyServerDraft])

  React.useEffect(() => {
    let active = true
    async function load() {
      setCatalogLoading(true)
      setCatalogError(null)
      try {
        const [raceRes, classRes, profRes] = await Promise.all([
          apiFetch<CatalogListResponse>("/api/catalog/races"),
          apiFetch<CatalogListResponse>("/api/catalog/classes"),
          apiFetch<CatalogListResponse>("/api/catalog/professions"),
        ])
        if (!active) return
        setRaces(raceRes.items)
        setClasses(classRes.items)
        setProfessions(profRes.items)
      } catch (err) {
        if (active) {
          setCatalogError(
            err instanceof Error ? err.message : "Failed to load catalog."
          )
        }
      } finally {
        if (active) setCatalogLoading(false)
      }
    }
    load()
    return () => {
      active = false
    }
  }, [])

  // A recovery copy persisted by a previous session means a local vs server draft
  // choice is still unresolved, so `localRecoverDraft` / `showRecoverLocal` are
  // seeded lazily below and autosave stays paused until the user decides.

  // Fetch the authenticated server draft on mount. Autosave does not run until
  // this resolves, so we never PUT before knowing the current version.
  React.useEffect(() => {
    let active = true
    apiFetch<DraftResponse>("/api/drafts")
      .then((res) => {
        if (!active) return
        applyServerDraft(res)
      })
      .catch((err) => {
        if (!active) return
        setDraftLoadError(
          err instanceof Error ? err.message : "Could not sync the draft."
        )
      })
    return () => {
      active = false
    }
  }, [applyServerDraft])

  // A single in-flight PUT at a time. `performSave` reads the latest draft and
  // version from refs, so a queued re-run always persists the newest state.
  const performSave = React.useCallback(async (): Promise<boolean> => {
    setSaveState("saving")
    setSaveError(null)
    try {
      const data = toServerData(draftRef.current)
      const body: SaveDraftRequest = { data }
      if (versionRef.current != null) body.version = versionRef.current
      const res = await apiFetch<DraftResponse>("/api/drafts", {
        ...jsonInit("PUT", body),
      })
      if (!res.draft) {
        throw new Error("Server did not return a draft.")
      }
      versionRef.current = res.draft.version
      serverPresentRef.current = true
      setSaveState("saved")
      return true
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setSaveState("conflict")
        setSaveError(err.message)
      } else {
        setSaveState("error")
        setSaveError(
          err instanceof Error ? err.message : "Failed to save the draft."
        )
      }
      return false
    }
  }, [])

  // Coalesces saves into a single in-flight operation, returning a boolean that
  // says whether the latest draft was persisted. If a save is already running it
  // returns that same promise instead of starting a second one; any edits made
  // meanwhile are picked up by the running loop's `dirty` re-check.
  const saveLoop = React.useCallback((): Promise<boolean> => {
    if (saveInFlightRef.current) return saveInFlightRef.current
    if (!dirtyRef.current) return Promise.resolve(true)
    const run = (async (): Promise<boolean> => {
      try {
        do {
          dirtyRef.current = false
          const ok = await performSave()
          // A conflict/error stops the loop until the user resolves it; the
          // server's newer data is never silently clobbered.
          if (!ok) return false
        } while (dirtyRef.current)
        return true
      } finally {
        saveInFlightRef.current = null
      }
    })()
    saveInFlightRef.current = run
    return run
  }, [performSave])

  // Debounced autosave. Not started until the server GET resolves; paused while
  // a conflict is waiting for the user to choose an action, and while a local
  // recovery choice is unresolved.
  React.useEffect(() => {
    if (!ready) return
    if (skipFirstSaveRef.current) {
      skipFirstSaveRef.current = false
      // The server GET resolved to no draft while this device carries real
      // draft content: persist it immediately so the device draft is backed up
      // and the later create has a known draft version. This deliberately
      // overrides the usual first-save skip. An empty draft is left untouched
      // until the user edits. saveLoop coalesces with any in-flight save and
      // the PUT carries no version, so React Strict Mode can never issue a
      // second server create.
      if (!serverPresentRef.current && hasContent(draftRef.current)) {
        dirtyRef.current = true
        void saveLoop()
      }
      return
    }
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false
      return
    }
    if (saveStateRef.current === "conflict") return
    if (showRecoverLocal) return
    const timer = setTimeout(() => {
      dirtyRef.current = true
      void saveLoop()
    }, AUTO_SAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [draft, ready, saveLoop, showRecoverLocal])

  // Persist the draft (including the current step) to localStorage as an
  // offline fallback. The binary portrait is never stored here.
  React.useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(draft))
    } catch {
      // Ignore storage availability errors.
    }
  }, [draft])

  // 409 conflict resolution: discard local changes and adopt the server draft.
  const reloadFromServer = React.useCallback(async () => {
    setSaveError(null)
    try {
      const res = await apiFetch<DraftResponse>("/api/drafts")
      if (res.draft) {
        versionRef.current = res.draft.version
        serverPresentRef.current = true
        applyDraft({ ...EMPTY_DRAFT, ...fromServerData(res.draft.data) })
      } else {
        versionRef.current = null
        serverPresentRef.current = false
        applyDraft({ ...EMPTY_DRAFT })
      }
      setSaveState("idle")
      skipNextSaveRef.current = true
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : "Failed to reload the draft."
      )
      setSaveState("error")
    }
  }, [applyDraft])

  // 409 conflict resolution: fetch the current version, then overwrite the
  // server by saving the local draft at that exact version.
  const retryOverwrite = React.useCallback(async () => {
    setSaveError(null)
    try {
      const res = await apiFetch<DraftResponse>("/api/drafts")
      if (res.draft) {
        versionRef.current = res.draft.version
        serverPresentRef.current = true
      } else {
        versionRef.current = null
        serverPresentRef.current = false
      }
      await performSave()
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : "Failed to retry the save."
      )
      setSaveState("error")
    }
  }, [performSave])

  // Keep the server draft: discard the device's draft, clear the recovery copy
  // and resume autosave. Fetches the authoritative server draft first.
  const keepServerDraft = React.useCallback(async () => {
    setSaveError(null)
    try {
      const res = await apiFetch<DraftResponse>("/api/drafts")
      if (res.draft) {
        versionRef.current = res.draft.version
        serverPresentRef.current = true
        applyDraft({ ...EMPTY_DRAFT, ...fromServerData(res.draft.data) })
      } else {
        versionRef.current = null
        serverPresentRef.current = false
        applyDraft({ ...EMPTY_DRAFT })
      }
      clearRecoveryKey()
      setLocalRecoverDraft(null)
      setShowRecoverLocal(false)
      setSaveState("idle")
      skipNextSaveRef.current = true
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : "Failed to keep the server draft."
      )
      setSaveState("error")
    }
  }, [applyDraft])

  // Overwrite the server draft with the device's draft: GET the current server
  // version, then PUT the local draft at that exact version (a 409 is still
  // possible if the server changes between the two calls). Autosave stays paused
  // while the explicit overwrite is in flight and only resumes once it resolves.
  const recoverLocal = React.useCallback(async () => {
    if (!localRecoverDraft) return
    applyDraft(localRecoverDraft)
    setSaveError(null)
    try {
      const res = await apiFetch<DraftResponse>("/api/drafts")
      if (res.draft) {
        versionRef.current = res.draft.version
        serverPresentRef.current = true
      } else {
        versionRef.current = null
        serverPresentRef.current = false
      }
      const ok = await performSave()
      // A failed (e.g. 409) overwrite keeps recovery pending so autosave stays
      // paused and the user can re-choose.
      if (!ok) return
      clearRecoveryKey()
      setLocalRecoverDraft(null)
      setShowRecoverLocal(false)
      skipNextSaveRef.current = true
    } catch (err) {
      setSaveError(
        err instanceof Error
          ? err.message
          : "Failed to overwrite the server draft."
      )
      setSaveState("error")
    }
  }, [localRecoverDraft, applyDraft, performSave])

  const handleSaveClick = React.useCallback(() => {
    // While a local vs server recovery choice is unresolved, a manual Save must
    // not PUT - only the explicit 'Overwrite server draft' action may.
    if (showRecoverLocal) return
    dirtyRef.current = true
    void saveLoop()
  }, [saveLoop, showRecoverLocal])

  // Flush any pending/saving draft so a new create uses the current version.
  // Awaits the single in-flight save promise (or starts one), so it can never
  // hang: a failed save resolves to false and onSubmit aborts.
  const flushSave = React.useCallback(async (): Promise<boolean> => {
    // While a local vs server recovery choice is unresolved, neither save nor
    // create may touch the server - only the explicit 'Overwrite server draft'
    // action may. Report false so onSubmit aborts the create without POSTing.
    if (showRecoverLocal) return false
    // The server GET has not resolved (still in flight or failed), so the
    // server draft's existence and version are unknown. Report false so
    // onSubmit aborts the create: a create must never POST without knowing
    // whether a draft exists and its version (the create route only consumes a
    // draft when draftVersion is supplied). The user must use 'Retry sync'
    // first.
    if (!ready) return false
    // If a save is already running, wait for it to settle first.
    if (saveInFlightRef.current) {
      const ok = await saveInFlightRef.current
      // A failed save immediately reports false - do not force another attempt
      // that would just hit the same conflict.
      if (!ok) return false
    }
    // Force a save of the latest draft (no-op if already clean) and await it.
    dirtyRef.current = true
    return await saveLoop()
  }, [saveLoop, showRecoverLocal, ready])

  async function uploadPortraitAfterCreate(
    characterId: string,
    file: File
  ): Promise<void> {
    const form = new FormData()
    form.append("file", file)
    await apiFetch<PortraitView>(`/api/characters/${characterId}/portrait`, {
      method: "POST",
      body: form,
    })
  }

  // Restored selections are validated against the loaded catalog. If a stored id
  // no longer exists (catalog changed since the draft was saved), fall back to an
  // empty selection rather than submitting a stale reference.
  const raceId = races?.some((r) => r.id === draft.raceId) ? draft.raceId : ""
  const classId = classes?.some((c) => c.id === draft.classId)
    ? draft.classId
    : ""
  const professionId =
    draft.professionId === "" ||
    (professions?.some((p) => p.id === draft.professionId) ?? false)
      ? draft.professionId
      : ""

  const raceName = races?.find((r) => r.id === raceId)?.name ?? null
  const className = classes?.find((c) => c.id === classId)?.name ?? null
  const professionName =
    professions?.find((p) => p.id === professionId)?.name ?? null

  function onPortraitFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    if (file.size > MAX_PORTRAIT_BYTES) {
      toast.error("Portrait must be 4 MiB or smaller.")
      return
    }
    if (!ALLOWED_PORTRAIT_TYPES.includes(file.type)) {
      toast.error("Portrait must be a PNG, JPEG or WebP image.")
      return
    }
    setPortraitFile(file)
  }

  const onSubmit = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      // Do not POST while a local vs server recovery choice is unresolved (the
      // user must deliberately resolve via 'Overwrite server draft' / 'Keep
      // server draft' first) or until the server GET succeeds (otherwise the
      // draft version is unknown and creation would proceed without touching the
      // draft, or flushSave would refuse). The submit button is disabled for the
      // same reasons; this guard is defense in depth.
      if (showRecoverLocal || !ready) return
      setSubmitting(true)
      try {
        // Flush any pending autosave so the create uses the current draft
        // version. A conflict/error aborts creation without clobbering data.
        const saved = await flushSave()
        if (!saved) return

        const body: {
          name: string
          description?: string
          origin: "integrated" | "born"
          raceId: string
          classId: string
          professionId?: string
          draftVersion?: number
        } = {
          name: draft.name,
          origin: draft.origin as "integrated" | "born",
          raceId,
          classId,
          ...(professionId ? { professionId } : {}),
        }
        if (draft.description) body.description = draft.description
        // CAS: only the matching draft is consumed atomically with creation.
        if (versionRef.current != null) body.draftVersion = versionRef.current

        const res = await apiFetch<CharacterResponse>("/api/characters", {
          ...jsonInit("POST", body),
        })
        // Only clear the offline fallback and any pending recovery copy after the
        // character is confirmed.
        window.localStorage.removeItem(STORAGE_KEY)
        window.localStorage.removeItem(RECOVERY_KEY)
        toast.success(`Created "${res.character.name}".`)

        // Optional portrait picker: uploaded after create. If this fails the
        // character is still created, so it is not part of the atomic create.
        if (portraitFile) {
          try {
            await uploadPortraitAfterCreate(res.character.id, portraitFile)
            toast.success("Portrait uploaded.")
          } catch (err) {
            toast.error(
              err instanceof Error
                ? `Character created, but portrait upload failed: ${err.message}`
                : "Character created, but portrait upload failed."
            )
          }
        }

        router.push(`/characters/${res.character.id}`)
        router.refresh()
      } catch (err) {
        // Creation failed: the draft stays intact, so nothing is lost.
        toast.error(err instanceof Error ? err.message : "Creation failed.")
      } finally {
        setSubmitting(false)
      }
    },
    [
      draft,
      router,
      raceId,
      classId,
      professionId,
      flushSave,
      portraitFile,
      showRecoverLocal,
      ready,
    ]
  )

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-lg font-medium">Create a character</h1>
        <p className="text-xs text-muted-foreground">
          An eight-step questionnaire. Your progress is saved to the server and
          locally so a refresh will not lose it.
        </p>
      </div>

      {catalogError ? (
        <Alert variant="destructive">{catalogError}</Alert>
      ) : null}

      {draftLoadError ? (
        <Alert variant="destructive">
          <div className="flex flex-col gap-1">
            <span>{draftLoadError}</span>
            <Button
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() => void loadServerDraft()}
            >
              Retry sync
            </Button>
          </div>
        </Alert>
      ) : null}

      {showRecoverLocal && localRecoverDraft ? (
        <Alert variant="destructive">
          <div className="flex flex-col gap-1">
            <span>
              A saved draft on this device differs from the server draft.
              Autosave is paused. Choose which draft to keep.
            </span>
            <div className="flex flex-wrap gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => void recoverLocal()}
              >
                Overwrite server draft
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => void keepServerDraft()}
              >
                Keep server draft
              </Button>
            </div>
          </div>
        </Alert>
      ) : null}

      {saveState === "conflict" ? (
        <Alert variant="destructive">
          <div className="flex flex-col gap-1">
            <span>
              {saveError ?? "Draft conflict."} Autosave is paused - choose what
              to keep.
            </span>
            <div className="flex flex-wrap gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void reloadFromServer()}
              >
                Reload server
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void retryOverwrite()}
              >
                Retry (overwrite)
              </Button>
            </div>
          </div>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleSaveClick}
          disabled={
            submitting ||
            showRecoverLocal ||
            saveState === "saving" ||
            saveState === "conflict"
          }
        >
          Save draft
        </Button>
        <span className="text-xs text-muted-foreground">
          {saveState === "saving"
            ? "Saving..."
            : saveState === "saved"
              ? "Saved"
              : saveState === "error"
                ? (saveError ?? "Save failed")
                : null}
        </span>
      </div>

      {/* While a local vs server recovery choice is pending, the wizard shows
          the applied server draft, so freeze its fields: edits would otherwise
          diverge from the recovery snapshot and 'Overwrite server draft' would
          restore something other than what is displayed. Disabling the whole
          wizard also blocks step navigation during the unresolved choice. */}
      <fieldset disabled={showRecoverLocal} className="contents">
        <Questionnaire
          items={ITEMS.map((i) => ({ name: i.name, required: i.required }))}
          item={draft.step}
          onItemChange={(name) => setField("step", name)}
          onSubmit={onSubmit}
        >
          <QuestionnaireProgress />

          <QuestionnaireItem name="name" required>
            <QuestionnaireTitle>Name</QuestionnaireTitle>
            <QuestionnaireDescription>
              Give your character a name. The description is optional.
            </QuestionnaireDescription>
            <QuestionnaireInput
              placeholder="Character name"
              value={draft.name}
              onChange={(e) => setField("name", e.target.value)}
            />
            <QuestionnaireInput
              placeholder="Description (optional)"
              value={draft.description}
              onChange={(e) => setField("description", e.target.value)}
            />
          </QuestionnaireItem>

          <QuestionnaireItem name="origin" required>
            <QuestionnaireTitle>Origin</QuestionnaireTitle>
            <QuestionnaireDescription>
              Where does your character come from? This sets their starting
              grade progression.
            </QuestionnaireDescription>
            <QuestionnaireChoices>
              <QuestionnaireChoice
                value="born"
                checked={draft.origin === "born"}
                onChange={(e) => e.target.checked && setField("origin", "born")}
              >
                Born
                <QuestionnaireChoiceDescription>
                  Born into the system. Starts at F grade.
                </QuestionnaireChoiceDescription>
              </QuestionnaireChoice>
              <QuestionnaireChoice
                value="integrated"
                checked={draft.origin === "integrated"}
                onChange={(e) =>
                  e.target.checked && setField("origin", "integrated")
                }
              >
                Integrated
                <QuestionnaireChoiceDescription>
                  Newly integrated into the system. Starts at G grade.
                </QuestionnaireChoiceDescription>
              </QuestionnaireChoice>
            </QuestionnaireChoices>
          </QuestionnaireItem>

          <QuestionnaireItem name="race" required>
            <QuestionnaireTitle>Race</QuestionnaireTitle>
            <QuestionnaireDescription>
              Select a race from the catalog.
            </QuestionnaireDescription>
            {catalogLoading && !races ? (
              <p className="text-xs text-muted-foreground">Loading races...</p>
            ) : null}
            {races && races.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No races are available in the catalog yet.
              </p>
            ) : null}
            <QuestionnaireChoices>
              {races?.map((race) => (
                <QuestionnaireChoice
                  key={race.id}
                  value={race.id}
                  checked={raceId === race.id}
                  onChange={(e) =>
                    e.target.checked && setField("raceId", race.id)
                  }
                >
                  {race.name}
                  {race.grade ? (
                    <QuestionnaireChoiceDescription>
                      Grade {race.grade}
                      {race.description ? ` - ${race.description}` : ""}
                    </QuestionnaireChoiceDescription>
                  ) : (
                    <QuestionnaireChoiceDescription>
                      {race.description}
                    </QuestionnaireChoiceDescription>
                  )}
                </QuestionnaireChoice>
              ))}
            </QuestionnaireChoices>
          </QuestionnaireItem>

          <QuestionnaireItem name="class" required>
            <QuestionnaireTitle>Class</QuestionnaireTitle>
            <QuestionnaireDescription>
              Select a class from the catalog.
            </QuestionnaireDescription>
            {catalogLoading && !classes ? (
              <p className="text-xs text-muted-foreground">
                Loading classes...
              </p>
            ) : null}
            {classes && classes.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No classes are available in the catalog yet.
              </p>
            ) : null}
            <QuestionnaireChoices>
              {classes?.map((cls) => (
                <QuestionnaireChoice
                  key={cls.id}
                  value={cls.id}
                  checked={classId === cls.id}
                  onChange={(e) =>
                    e.target.checked && setField("classId", cls.id)
                  }
                >
                  {cls.name}
                  {cls.grade ? (
                    <QuestionnaireChoiceDescription>
                      Grade {cls.grade}
                      {cls.description ? ` - ${cls.description}` : ""}
                    </QuestionnaireChoiceDescription>
                  ) : (
                    <QuestionnaireChoiceDescription>
                      {cls.description}
                    </QuestionnaireChoiceDescription>
                  )}
                </QuestionnaireChoice>
              ))}
            </QuestionnaireChoices>
          </QuestionnaireItem>

          <QuestionnaireItem name="profession">
            <QuestionnaireTitle>Profession</QuestionnaireTitle>
            <QuestionnaireDescription>
              A profession is optional. Choose None if your character has none.
            </QuestionnaireDescription>
            {catalogLoading && !professions ? (
              <p className="text-xs text-muted-foreground">
                Loading professions...
              </p>
            ) : null}
            <QuestionnaireChoices>
              <QuestionnaireChoice
                value=""
                checked={professionId === ""}
                onChange={(e) =>
                  e.target.checked && setField("professionId", "")
                }
              >
                None
                <QuestionnaireChoiceDescription>
                  No profession.
                </QuestionnaireChoiceDescription>
              </QuestionnaireChoice>
              {professions?.map((prof) => (
                <QuestionnaireChoice
                  key={prof.id}
                  value={prof.id}
                  checked={professionId === prof.id}
                  onChange={(e) =>
                    e.target.checked && setField("professionId", prof.id)
                  }
                >
                  {prof.name}
                  <QuestionnaireChoiceDescription>
                    {prof.description}
                  </QuestionnaireChoiceDescription>
                </QuestionnaireChoice>
              ))}
            </QuestionnaireChoices>
          </QuestionnaireItem>

          <QuestionnaireItem name="special">
            <QuestionnaireTitle>Special abilities</QuestionnaireTitle>
            <QuestionnaireDescription>
              Blessings, bloodlines and transcendents can be defined in the
              encyclopedia, but they are not yet attached to a new character.
              Nothing is recorded here, so no numbers are affected.
            </QuestionnaireDescription>
            {draft.special === "yes" ? (
              <p className="text-xs text-muted-foreground">
                This draft recorded special abilities, but they are not yet
                attached to a character. Configure them when the feature is
                available.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Not assigned. Configure when the feature is available.
              </p>
            )}
          </QuestionnaireItem>

          <QuestionnaireItem name="equipment">
            <QuestionnaireTitle>Equipment</QuestionnaireTitle>
            <QuestionnaireDescription>
              Equipment is configured after the character is created, so nothing
              is recorded here and no numbers are affected yet.
            </QuestionnaireDescription>
            <p className="text-xs text-muted-foreground">
              Assign equipment on the character page after creation.
            </p>
          </QuestionnaireItem>

          <QuestionnaireItem name="review">
            <QuestionnaireTitle>Review</QuestionnaireTitle>
            <QuestionnaireDescription>
              Confirm your choices. Attributes are calculated server-side; at
              level 0 your base attributes are all 0 with no awards granted yet.
            </QuestionnaireDescription>
            <div className="flex flex-col gap-1 rounded-lg border bg-input/20 p-3 text-xs/relaxed">
              <div>
                <span className="text-muted-foreground">Name: </span>
                {draft.name || <span className="text-muted-foreground">-</span>}
              </div>
              <div>
                <span className="text-muted-foreground">Origin: </span>
                {draft.origin ? (
                  <span className="capitalize">{draft.origin}</span>
                ) : (
                  <span className="text-muted-foreground">-</span>
                )}
              </div>
              <div>
                <span className="text-muted-foreground">Race: </span>
                {raceName ?? <span className="text-muted-foreground">-</span>}
              </div>
              <div>
                <span className="text-muted-foreground">Class: </span>
                {className ?? <span className="text-muted-foreground">-</span>}
              </div>
              <div>
                <span className="text-muted-foreground">Profession: </span>
                {professionName ?? <span>None</span>}
              </div>
              <div>
                <span className="text-muted-foreground">
                  Special abilities:{" "}
                </span>
                Not assigned
              </div>
              <div>
                <span className="text-muted-foreground">Equipment: </span>
                Configure after character creation
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Blessings, bloodlines and transcendents are defined in the
              encyclopedia but not yet attached to a character; configure them
              when the feature is available.
            </p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="create-portrait">Portrait (optional)</Label>
              <Input
                id="create-portrait"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={onPortraitFileChange}
                className="bg-input/20"
              />
              {portraitFile ? (
                <p className="text-xs text-muted-foreground">
                  &quot;{portraitFile.name}&quot; will be uploaded after the
                  character is created. If that upload fails, the character is
                  still created.
                </p>
              ) : null}
            </div>
            <QuestionnaireChoices>
              <QuestionnaireChoice value="confirmed" defaultChecked>
                Looks good - create this character
              </QuestionnaireChoice>
            </QuestionnaireChoices>
          </QuestionnaireItem>

          <QuestionnaireActions>
            <QuestionnairePrevious>Back</QuestionnairePrevious>
            <QuestionnaireNext>Next</QuestionnaireNext>
            <QuestionnaireSubmit
              disabled={submitting || showRecoverLocal || !ready}
            >
              {submitting ? "Creating..." : "Create character"}
            </QuestionnaireSubmit>
          </QuestionnaireActions>
        </Questionnaire>
      </fieldset>
    </div>
  )
}
