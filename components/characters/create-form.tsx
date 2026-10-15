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
  type SpecialAbilitiesSelection,
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

// The eight-tier blessing hierarchy a god's blessing may be granted at. A
// blessing link is a god + exact tier; the tier is persisted verbatim on the
// link and the live effect is synthesized from the god's `blessingEffects[tier]`.
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

/**
 * Normalize a character-profile metadata field for the POST body. Converts ONLY
 * the exact empty string `""` to null (a blank field is omitted/cleared) and
 * otherwise passes the value through VERBATIM - leading/trailing whitespace and
 * newlines are never trimmed, so a multiline biography/notes value survives to
 * the server exactly as typed.
 */
function metadataOrNull(value: string | null | undefined): string | null {
  if (value === "") return null
  return value ?? null
}

// Separate recovery key: while a local vs server draft conflict is unresolved,
// the device's local draft copy is kept here so a refresh cannot lose it. The
// live fallback in STORAGE_KEY is overwritten by whichever draft is applied.
const RECOVERY_KEY = "primal-create-recovery"

const ITEMS = [
  { name: "raceType", required: true },
  { name: "name", required: true },
  { name: "origin", required: true },
  { name: "race", required: true },
  { name: "class", required: true },
  { name: "profession", required: false },
  { name: "special", required: false },
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
// after the character is created. `special` is always written as `false`: the
// legacy "has special abilities" yes/no flag is no longer captured (abilities
// are now linked explicitly via `specialAbilities`), so the wizard never submits
// `special=true`.
interface Draft {
  step: string
  raceType?: "enlightened" | "monster"
  name: string
  description: string
  origin: string
  raceId: string
  classId: string
  professionId: string
  special: string // 'yes' | 'none' (legacy only; the UI never sets 'yes')
  equipment: string // 'yes' | 'none' (always 'none'; no picker yet)
  // Optional profile fields are carried through local and server draft recovery.
  nickname: string | null
  pronouns: string | null
  ageDescription: string | null
  appearance: string | null
  biography: string | null
  notes: string | null
  specialAbilities: {
    blessing: { godId: string; tier: string } | null
    bloodlineIds: string[]
    transcendentSkillIds: string[]
  }
}

const EMPTY_DRAFT: Draft = {
  step: "raceType",
  raceType: undefined,
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
  specialAbilities: {
    blessing: null,
    bloodlineIds: [],
    transcendentSkillIds: [],
  },
}

/**
 * Coerce a possibly-malformed stored `specialAbilities` value into the
 * well-formed shape the wizard relies on. Legacy drafts may record the field as
 * null, a partial object, or with non-string ids / non-array lists; each case is
 * normalized to a safe default so `hasContent`, `draftsDiffer` and
 * `toServerData` never dereference undefined. Only the `specialAbilities` field
 * is touched - every other draft field is preserved unchanged.
 */
function normalizeSpecialAbilities(raw: unknown): Draft["specialAbilities"] {
  const src =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}
  let blessing: { godId: string; tier: string } | null = null
  const stored = src.blessing
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    const b = stored as Record<string, unknown>
    if (typeof b.godId === "string") {
      blessing = {
        godId: b.godId,
        tier: typeof b.tier === "string" ? b.tier : "Minor",
      }
    }
  }
  const bloodlineIds = Array.isArray(src.bloodlineIds)
    ? src.bloodlineIds.filter((x): x is string => typeof x === "string")
    : []
  const transcendentSkillIds = Array.isArray(src.transcendentSkillIds)
    ? src.transcendentSkillIds.filter((x): x is string => typeof x === "string")
    : []
  return { blessing, bloodlineIds, transcendentSkillIds }
}

/**
 * Merge a partial (possibly untrusted/localStorage) draft onto the default shape
 * and normalize the `specialAbilities` field so the rest of the wizard can assume
 * it is always a well-formed object.
 */
function normalizeDraft(partial: Partial<Draft>): Draft {
  const merged: Draft = { ...EMPTY_DRAFT, ...partial }
  if (merged.step === "equipment") merged.step = "review"
  if (!STEP_NAMES.includes(merged.step)) merged.step = "name"
  merged.specialAbilities = normalizeSpecialAbilities(merged.specialAbilities)
  return merged
}

type SaveState = "idle" | "saving" | "saved" | "error" | "conflict"

function visibleStepNames(raceType?: Draft["raceType"]): string[] {
  return ITEMS.filter(
    (item) =>
      raceType !== "monster" || !["class", "profession"].includes(item.name)
  ).map((item) => item.name)
}

function stepNameToIndex(step: string, raceType?: Draft["raceType"]): number {
  const effectiveStep =
    raceType === "monster" && (step === "class" || step === "profession")
      ? "special"
      : step
  if (!raceType) {
    const oldNames = [
      "name",
      "origin",
      "race",
      "class",
      "profession",
      "special",
      "review",
    ]
    const legacyIndex = oldNames.indexOf(effectiveStep)
    return legacyIndex >= 0 ? legacyIndex : 0
  }
  const idx = visibleStepNames(raceType).indexOf(effectiveStep)
  return idx >= 0 ? idx : 0
}

/** Restore a server step index; drafts without raceType use the legacy index map. */
function stepIndexToName(index: number, raceType?: Draft["raceType"]): string {
  // Historical seven-step server drafts predate the branch question.
  const oldNames = [
    "name",
    "origin",
    "race",
    "class",
    "profession",
    "special",
    "review",
  ]
  if (
    !raceType &&
    Number.isInteger(index) &&
    index >= 0 &&
    index < oldNames.length
  )
    return oldNames[index]
  const names = visibleStepNames(raceType)
  if (Number.isInteger(index) && index >= 0 && index < names.length)
    return names[index]
  if (Number.isInteger(index) && index >= names.length) return "review"
  return "raceType"
}

/** Map the wizard's string step and yes/no flags onto the server draft shape. */
function toServerData(
  draft: Draft,
  inferredRaceType?: Draft["raceType"]
): DraftData {
  const raceType = draft.raceType ?? inferredRaceType
  const data: DraftData = { step: stepNameToIndex(draft.step, raceType) }
  if (raceType) data.raceType = raceType
  if (draft.name) data.name = draft.name
  if (draft.description) data.description = draft.description
  if (draft.origin) data.origin = draft.origin as "integrated" | "born"
  if (draft.raceId) data.raceId = draft.raceId
  if (draft.classId) data.classId = draft.classId
  data.professionId = draft.professionId || null
  // The wizard no longer captures a "has special abilities" choice. Always
  // submit `special: false` so the UI never persists `special=true`: abilities
  // are now linked explicitly via `specialAbilities`, and a legacy draft that
  // recorded the flag is normalized on the next save rather than carried as a
  // character feature.
  data.special = false
  data.specialAbilities = {
    blessing: draft.specialAbilities.blessing ?? undefined,
    bloodlineIds: [...(draft.specialAbilities.bloodlineIds ?? [])].sort(),
    transcendentSkillIds: [
      ...(draft.specialAbilities.transcendentSkillIds ?? []),
    ].sort(),
  }
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
  if (data.raceType === "enlightened" || data.raceType === "monster")
    d.raceType = data.raceType
  if (typeof data.step === "number")
    d.step = stepIndexToName(data.step, d.raceType)
  if (typeof data.name === "string") d.name = data.name
  if (typeof data.description === "string") d.description = data.description
  if (typeof data.origin === "string") d.origin = data.origin
  if (typeof data.raceId === "string") d.raceId = data.raceId
  if (typeof data.classId === "string") d.classId = data.classId
  if (typeof data.professionId === "string") d.professionId = data.professionId
  if (typeof data.special === "boolean")
    d.special = data.special ? "yes" : "none"
  if (data.specialAbilities)
    d.specialAbilities = {
      blessing: data.specialAbilities.blessing ?? null,
      bloodlineIds: data.specialAbilities.bloodlineIds ?? [],
      transcendentSkillIds: data.specialAbilities.transcendentSkillIds ?? [],
    }
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
    // Legacy drafts may carry a malformed or missing `specialAbilities` nested
    // object; normalize so the wizard's helpers never dereference undefined.
    return normalizeDraft(parsed)
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
    return normalizeDraft(parsed)
  } catch {
    return null
  }
}

/** Persist the live draft under the primary storage key. */
function saveLocalDraft(draft: Draft): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(draft))
  } catch {
    // Ignore storage availability errors.
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
    !!draft.specialAbilities.blessing ||
    draft.specialAbilities.bloodlineIds.length > 0 ||
    draft.specialAbilities.transcendentSkillIds.length > 0 ||
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
    (a.raceType !== b.raceType &&
      (!a.raceId || !b.raceId || a.raceId !== b.raceId)) ||
    a.name !== b.name ||
    a.description !== b.description ||
    a.origin !== b.origin ||
    a.raceId !== b.raceId ||
    a.classId !== b.classId ||
    a.professionId !== b.professionId ||
    a.specialAbilities.blessing?.godId !== b.specialAbilities.blessing?.godId ||
    a.specialAbilities.blessing?.tier !== b.specialAbilities.blessing?.tier ||
    JSON.stringify([...a.specialAbilities.bloodlineIds].sort()) !==
      JSON.stringify([...b.specialAbilities.bloodlineIds].sort()) ||
    JSON.stringify([...a.specialAbilities.transcendentSkillIds].sort()) !==
      JSON.stringify([...b.specialAbilities.transcendentSkillIds].sort()) ||
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

/**
 * Validate the special-abilities selection against the loaded ability catalogs.
 * Returns an actionable error message, or null when the selection is valid.
 *
 * A selection (any selected blessing / bloodline / transcendent-skill id) is
 * valid only when all three ability catalogs loaded, every selected id resolves
 * to an UNARCHIVED definition of the matching list (an archived entry is inert
 * and cannot be newly linked), and no two selected bloodlines share the same
 * nonempty `upgradeGroup` (group-replacement semantics would silently collapse
 * one). A missing/archived id and a group collision are surfaced so the user can
 * fix the draft rather than submitting an association the server 400s.
 *
 * No selection is always valid: an empty selection grants nothing, so a catalog
 * failure must never block submission of a draft that chose no abilities.
 */
function specialValidationError(
  draft: Draft,
  blessings: CatalogItem[] | null,
  bloodlines: CatalogItem[] | null,
  transcendentSkills: CatalogItem[] | null
): string | null {
  const { blessing, bloodlineIds, transcendentSkillIds } =
    draft.specialAbilities
  const anySelection =
    !!blessing || bloodlineIds.length > 0 || transcendentSkillIds.length > 0
  // No selection: nothing to validate, so submission can proceed even when the
  // ability catalogs failed (the base catalogs gate the required race/class items).
  if (!anySelection) return null

  if (!blessings || !bloodlines || !transcendentSkills) {
    return "Ability catalogs could not be loaded. Retry to validate the selected abilities."
  }

  if (blessing) {
    const god = blessings.find((b) => b.id === blessing.godId)
    if (!god) {
      return `The selected blessing god "${blessing.godId}" is no longer in the catalog. Re-select a god or choose None.`
    }
    if (god.archived) {
      return `The selected blessing god "${god.name}" is archived and cannot be linked. Re-select an available god or choose None.`
    }
  }

  const selectedBloodlines = bloodlineIds.map((id) =>
    bloodlines.find((b) => b.id === id)
  )
  if (bloodlineIds.length > 1) {
    return "This draft has multiple bloodlines. Select one bloodline again before continuing."
  }
  for (let i = 0; i < bloodlineIds.length; i++) {
    const id = bloodlineIds[i]
    const def = selectedBloodlines[i]
    if (!def) {
      return `The selected bloodline "${id}" is no longer in the catalog. Remove it or select an available bloodline.`
    }
    if (def.archived) {
      return `The selected bloodline "${def.name}" is archived and cannot be linked. Remove it or select an available bloodline.`
    }
  }
  const upgradeGroups = new Map<string, string>()
  for (const def of selectedBloodlines) {
    // All selected ids were resolved above, but `def` is still typed as possibly
    // undefined; skip defensively (the prior loop already returned on a miss).
    if (!def) continue
    const group = def.config?.upgradeGroup
    if (typeof group === "string" && group.length > 0) {
      const prior = upgradeGroups.get(group)
      if (prior != null) {
        return `Bloodlines "${prior}" and "${def.name}" both occupy upgrade group "${group}". Select only one bloodline per upgrade group.`
      }
      upgradeGroups.set(group, def.name)
    }
  }

  for (const id of transcendentSkillIds) {
    const def = transcendentSkills.find((t) => t.id === id)
    if (!def) {
      return `The selected transcendent skill "${id}" is no longer in the catalog. Remove it or select an available transcendent skill.`
    }
    if (def.archived) {
      return `The selected transcendent skill "${def.name}" is archived and cannot be linked. Remove it or select an available transcendent skill.`
    }
  }

  return null
}

export function CreateCharacterForm() {
  const router = useRouter()
  const [draft, setDraft] = React.useState<Draft>(() => loadDraft())
  const [races, setRaces] = React.useState<CatalogItem[] | null>(null)
  const [classes, setClasses] = React.useState<CatalogItem[] | null>(null)
  const [professions, setProfessions] = React.useState<CatalogItem[] | null>(
    null
  )
  const [blessings, setBlessings] = React.useState<CatalogItem[] | null>(null)
  const [bloodlines, setBloodlines] = React.useState<CatalogItem[] | null>(null)
  const [transcendentSkills, setTranscendentSkills] = React.useState<
    CatalogItem[] | null
  >(null)
  const [catalogError, setCatalogError] = React.useState<string | null>(null)
  const [catalogLoading, setCatalogLoading] = React.useState(true)
  // Ability catalogs (blessings / bloodlines / transcendent skills) load and fail
  // independently of the base catalogs. A failure here must not prevent the base
  // catalogs from loading, so a no-selection draft can still be created, but it
  // MUST block submission once a selection exists (see `specialValidationError`).
  const [abilityCatalogError, setAbilityCatalogError] = React.useState<
    string | null
  >(null)
  const [maxTranscendentSkills, setMaxTranscendentSkills] = React.useState<
    number | null
  >(null)
  const [creationRulesError, setCreationRulesError] = React.useState<
    string | null
  >(null)
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

  const chosenRace = races?.find((race) => race.id === draft.raceId)
  const raceType: Draft["raceType"] = chosenRace
    ? chosenRace.config?.raceType === "monster"
      ? "monster"
      : "enlightened"
    : (draft.raceType ??
      (draft.raceId || draft.classId ? "enlightened" : undefined))
  const setRaceType = (value: "enlightened" | "monster") =>
    setDraft((current) => {
      const sameBranch = value === raceType
      return {
        ...current,
        raceType: value,
        ...(sameBranch ? {} : { raceId: "", classId: "", professionId: "" }),
        step:
          current.step === "raceType" || !sameBranch ? "name" : current.step,
      }
    })
  const visibleItems = raceType
    ? ITEMS.filter(
        (item) =>
          raceType !== "monster" || !["class", "profession"].includes(item.name)
      )
    : ITEMS.filter((item) => item.name === "raceType")
  const visibleStepNames: string[] = visibleItems.map((item) => item.name)
  const naturalGrade = (chosenRace?.config?.naturalGrade ?? "F") as string
  const hasExplicitNaturalGrade = chosenRace?.config?.naturalGrade != null
  const gradeDefinitions = (entry: CatalogItem) => {
    const grades = entry.config?.grades
    return (
      (!hasExplicitNaturalGrade || entry.grade === naturalGrade) &&
      !!grades &&
      typeof grades === "object" &&
      !!(grades as Record<string, unknown>)[naturalGrade] &&
      typeof (grades as Record<string, unknown>)[naturalGrade] === "object" &&
      Object.keys((grades as Record<string, object>)[naturalGrade]).length > 0
    )
  }
  const eligibleClasses = classes?.filter(gradeDefinitions) ?? []
  const eligibleProfessions = professions?.filter(gradeDefinitions) ?? []

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
        const next = normalizeDraft(fromServerData(res.draft.data))
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
        // No server draft exists, so there is no live conflict to resolve, but a
        // recovery snapshot left by a previous session must not be discarded.
        // Restore it as the device draft (it is the most recent real local
        // content) unless the current live draft carries its own content that
        // differs, in which case surface the explicit recovery choice so nothing
        // is silently clobbered. The restored snapshot is persisted under
        // STORAGE_KEY before RECOVERY_KEY is cleared so a refresh cannot lose it,
        // and the initial autosave create then saves it.
        const recovery = loadRecoveryDraft()
        const current = draftRef.current
        if (
          recovery &&
          hasContent(current) &&
          draftsDiffer(current, recovery)
        ) {
          setLocalRecoverDraft(recovery)
          setShowRecoverLocal(true)
        } else if (recovery) {
          applyDraft(recovery)
          saveLocalDraft(recovery)
          clearRecoveryKey()
          setLocalRecoverDraft(null)
          setShowRecoverLocal(false)
        } else {
          clearRecoveryKey()
          setLocalRecoverDraft(null)
          setShowRecoverLocal(false)
        }
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

  // Fetch only the ability catalogs. Reused by both the initial mount load and the
  // special-step Retry action so a catalog failure can be retried WITHOUT a full
  // page reload (the in-memory draft and the current step are preserved). Returns
  // whether the reload succeeded, so callers can decide how to surface it.
  const loadAbilityCatalogs = React.useCallback(async (): Promise<boolean> => {
    try {
      const [blessingRes, bloodlineRes, skillRes] = await Promise.all([
        apiFetch<CatalogListResponse>("/api/catalog/gods"),
        apiFetch<CatalogListResponse>("/api/catalog/bloodlines"),
        apiFetch<CatalogListResponse>("/api/catalog/transcendent_skills"),
      ])
      setBlessings(blessingRes.items)
      setBloodlines(bloodlineRes.items)
      setTranscendentSkills(skillRes.items)
      setAbilityCatalogError(null)
      return true
    } catch (err) {
      setAbilityCatalogError(
        err instanceof Error ? err.message : "Failed to load ability catalogs."
      )
      return false
    }
  }, [])

  const loadCreationRules = React.useCallback(async (): Promise<boolean> => {
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
      return true
    } catch (err) {
      setCreationRulesError(
        err instanceof Error ? err.message : "Could not load creation rules."
      )
      return false
    }
  }, [])

  React.useEffect(() => {
    let active = true
    async function loadBaseCatalogs() {
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
    // The base and ability catalogs load independently: a failure in the ability
    // catalogs must not prevent the base catalogs from loading, so a draft with
    // no ability selection can still be created once race/class are chosen. The
    // ability load reuses the same `loadAbilityCatalogs` used by the Retry action.
    void loadBaseCatalogs()
    // Defer the ability load off the synchronous effect body so no setState runs
    // inline before the awaited catalog fetches resolve.
    Promise.resolve().then(() => {
      void loadAbilityCatalogs()
      void loadCreationRules()
    })
    return () => {
      active = false
    }
  }, [loadAbilityCatalogs, loadCreationRules])

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
      const savedDraft = draftRef.current
      const savedRace = races?.find((race) => race.id === savedDraft.raceId)
      const inferredRaceType = savedRace
        ? savedRace.config?.raceType === "monster"
          ? "monster"
          : "enlightened"
        : undefined
      const data = toServerData(savedDraft, inferredRaceType)
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
  }, [races])

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
    // While a local vs server recovery choice is pending, autosave must not run
    // at all - not even the first-save create. This check comes BEFORE the
    // skipFirstSaveRef branch so a pending choice never writes the device's
    // current (live) draft to the server: only the explicit overwrite/keep
    // action persists, so the chosen snapshot is never clobbered by the live
    // draft. `skipFirstSaveRef` stays true here and is handled by the explicit
    // resolution handler, which persists the chosen snapshot exactly once.
    if (showRecoverLocal) return
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
        applyDraft(normalizeDraft(fromServerData(res.draft.data)))
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
        applyDraft(normalizeDraft(fromServerData(res.draft.data)))
      } else {
        versionRef.current = null
        serverPresentRef.current = false
        applyDraft({ ...EMPTY_DRAFT })
      }
      clearRecoveryKey()
      setLocalRecoverDraft(null)
      setShowRecoverLocal(false)
      setSaveState("idle")
      // The server draft (or empty state) is now authoritative, so the queued
      // first-save create must not rewrite it. The chosen snapshot was already
      // resolved explicitly; mark the first save as handled so autosave resumes
      // cleanly for subsequent edits without a second write.
      skipFirstSaveRef.current = false
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
      // The chosen (device) snapshot was just persisted by `performSave`. Mark
      // the first-save create as handled so the autosave effect does not issue a
      // second, duplicate PUT of the same snapshot (a pending choice must never
      // result in two writes), and skip the immediate next save so the snapshot
      // we just wrote is not re-saved.
      skipFirstSaveRef.current = false
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
    // not PUT - only the explicit 'Use device draft' action may.
    if (showRecoverLocal) return
    dirtyRef.current = true
    void saveLoop()
  }, [saveLoop, showRecoverLocal])

  // Flush any pending/saving draft so a new create uses the current version.
  // Awaits the single in-flight save promise (or starts one), so it can never
  // hang: a failed save resolves to false and onSubmit aborts.
  const flushSave = React.useCallback(async (): Promise<boolean> => {
    // While a local vs server recovery choice is unresolved, neither save nor
    // create may touch the server - only the explicit 'Use device draft'
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
  const classId = eligibleClasses.some((c) => c.id === draft.classId)
    ? draft.classId
    : ""
  const professionId =
    draft.professionId === "" ||
    eligibleProfessions.some((p) => p.id === draft.professionId)
      ? draft.professionId
      : ""

  const raceName = races?.find((r) => r.id === raceId)?.name ?? null
  const className = classes?.find((c) => c.id === classId)?.name ?? null
  const professionName =
    professions?.find((p) => p.id === professionId)?.name ?? null

  // The special-abilities selection is valid only when the ability catalogs
  // loaded and every selected id resolves to an unarchived definition (and no
  // bloodline upgrade-group collision). Used to disable the submit button and to
  // abort before flushSave/POST so an invalid selection is never silently
  // dropped. With no selection the error is always null (see the helper).
  const specialError =
    specialValidationError(draft, blessings, bloodlines, transcendentSkills) ??
    (draft.specialAbilities.transcendentSkillIds.length > 0 &&
    maxTranscendentSkills == null
      ? "Creation rules could not be loaded. Retry to validate transcendent selections."
      : maxTranscendentSkills != null &&
          draft.specialAbilities.transcendentSkillIds.length >
            maxTranscendentSkills
        ? `This draft exceeds the transcendent maximum of ${maxTranscendentSkills}. Remove selections before continuing.`
        : null)

  // Stored ids that are no longer in the loaded ability catalog. They are still
  // rendered (checked) so the user can remove them, rather than being invisible
  // and unresolvable.
  const orphanBloodlineIds = draft.specialAbilities.bloodlineIds.filter(
    (id) => !bloodlines?.some((b) => b.id === id)
  )
  const orphanTranscendentSkillIds =
    draft.specialAbilities.transcendentSkillIds.filter(
      (id) => !transcendentSkills?.some((t) => t.id === id)
    )

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
      // user must deliberately resolve via 'Use device draft' / 'Use server
      // draft' first) or until the server GET succeeds (otherwise the
      // draft version is unknown and creation would proceed without touching the
      // draft, or flushSave would refuse). The submit button is disabled for the
      // same reasons; this guard is defense in depth.
      if (showRecoverLocal || !ready || !raceType) return
      // An invalid special-abilities selection must abort BEFORE the flushSave
      // (and thus before the POST): the draft stays intact and nothing is
      // silently dropped. The error is surfaced inline on the special and review
      // steps. The submit button is disabled for the same reason; this guard is
      // defense in depth (e.g. a form submit via Enter).
      if (specialError) return
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
          classId: string | null
          professionId: string | null
          draftVersion?: number
          specialAbilities: SpecialAbilitiesSelection
          nickname: string | null
          pronouns: string | null
          ageDescription: string | null
          appearance: string | null
          biography: string | null
          notes: string | null
        } = {
          name: draft.name,
          origin: draft.origin as "integrated" | "born",
          raceId,
          classId: raceType === "monster" ? null : classId,
          professionId: raceType === "monster" ? null : professionId || null,
          specialAbilities: toServerData(draft).specialAbilities!,
          nickname: metadataOrNull(draft.nickname),
          pronouns: metadataOrNull(draft.pronouns),
          ageDescription: metadataOrNull(draft.ageDescription),
          appearance: metadataOrNull(draft.appearance),
          biography: metadataOrNull(draft.biography),
          notes: metadataOrNull(draft.notes),
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
      raceType,
      router,
      raceId,
      classId,
      professionId,
      flushSave,
      portraitFile,
      showRecoverLocal,
      ready,
      specialError,
    ]
  )

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-lg font-medium">Create a character</h1>
        <p className="text-xs text-muted-foreground">
          A branching character questionnaire. Your progress is saved to the
          server and locally so a refresh will not lose it.
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
              A saved draft on this device differs from the draft on the server.
              Autosave is paused. Choose which draft to keep.
            </span>
            <div className="flex flex-wrap gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => void recoverLocal()}
              >
                Use device draft
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => void keepServerDraft()}
              >
                Use server draft
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
          diverge from the recovery snapshot and 'Use device draft' would
          restore something other than what is displayed. Disabling the whole
          wizard also blocks step navigation during the unresolved choice. */}
      <fieldset disabled={showRecoverLocal} className="contents">
        <Questionnaire
          items={visibleItems.map((i) => ({
            name: i.name,
            required: i.required,
          }))}
          item={
            visibleStepNames.includes(
              raceType === "monster" &&
                (draft.step === "class" || draft.step === "profession")
                ? "special"
                : draft.step
            )
              ? ((raceType === "monster" &&
                (draft.step === "class" || draft.step === "profession")
                  ? "special"
                  : draft.step) as (typeof ITEMS)[number]["name"])
              : (visibleStepNames[0] as (typeof ITEMS)[number]["name"])
          }
          onItemChange={(name) => setField("step", name)}
          onSubmit={onSubmit}
        >
          <QuestionnaireProgress />

          <QuestionnaireItem name="raceType" required>
            <QuestionnaireTitle>Character kind</QuestionnaireTitle>
            <QuestionnaireDescription>
              Choose a path before naming your character.
            </QuestionnaireDescription>
            <QuestionnaireChoices>
              <QuestionnaireChoice
                value="enlightened"
                checked={raceType === "enlightened"}
                onClick={() => setRaceType("enlightened")}
              >
                Enlightened
              </QuestionnaireChoice>
              <QuestionnaireChoice
                value="monster"
                checked={raceType === "monster"}
                onClick={() => setRaceType("monster")}
              >
                Monster
              </QuestionnaireChoice>
            </QuestionnaireChoices>
          </QuestionnaireItem>

          {raceType ? (
            <>
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
                  aria-label="Nickname"
                  placeholder="Nickname (optional)"
                  maxLength={200}
                  value={draft.nickname ?? ""}
                  onChange={(e) => setField("nickname", e.target.value)}
                />
                <QuestionnaireInput
                  aria-label="Pronouns"
                  placeholder="Pronouns (optional)"
                  maxLength={100}
                  value={draft.pronouns ?? ""}
                  onChange={(e) => setField("pronouns", e.target.value)}
                />
                <QuestionnaireInput
                  aria-label="Age description (optional)"
                  placeholder="Age description (optional)"
                  maxLength={4000}
                  value={draft.ageDescription ?? ""}
                  onChange={(e) => setField("ageDescription", e.target.value)}
                />
                <QuestionnaireInput
                  aria-label="Appearance (optional)"
                  placeholder="Appearance (optional)"
                  maxLength={8000}
                  value={draft.appearance ?? ""}
                  onChange={(e) => setField("appearance", e.target.value)}
                />
                <QuestionnaireInput
                  aria-label="Biography (optional)"
                  placeholder="Biography (optional)"
                  maxLength={8000}
                  value={draft.biography ?? ""}
                  onChange={(e) => setField("biography", e.target.value)}
                />
                <QuestionnaireInput
                  aria-label="Notes (optional)"
                  placeholder="Notes (optional)"
                  maxLength={4000}
                  value={draft.notes ?? ""}
                  onChange={(e) => setField("notes", e.target.value)}
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
                    onChange={(e) =>
                      e.target.checked && setField("origin", "born")
                    }
                  >
                    Born
                    <QuestionnaireChoiceDescription>
                      Born into the system. Starts at the race&apos;s natural
                      grade.
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
                  <p className="text-xs text-muted-foreground">
                    Loading races...
                  </p>
                ) : null}
                {races && races.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No races are available in the catalog yet.
                  </p>
                ) : null}
                <QuestionnaireChoices>
                  {races
                    ?.filter(
                      (race) =>
                        (race.config?.raceType === "monster"
                          ? "monster"
                          : "enlightened") === raceType
                    )
                    .map((race) => {
                      const invalid =
                        !race.config?.raceDefinitions ||
                        typeof race.config.raceDefinitions !== "object" ||
                        !(
                          race.config.raceDefinitions as Record<string, unknown>
                        )[
                          draft.origin === "integrated"
                            ? "G"
                            : ((race.config?.naturalGrade as
                                string | undefined) ?? "F")
                        ]
                      return (
                        <QuestionnaireChoice
                          key={race.id}
                          value={race.id}
                          checked={raceId === race.id}
                          disabled={invalid}
                          onChange={(e) =>
                            e.target.checked &&
                            setDraft((d) => ({
                              ...d,
                              raceId: race.id,
                              classId: "",
                              professionId: "",
                            }))
                          }
                        >
                          {race.name}
                          <QuestionnaireChoiceDescription>
                            Natural grade{" "}
                            {String(race.config?.naturalGrade ?? "F")}
                            {race.config?.raceType == null
                              ? " (legacy unclassified; treated as enlightened)"
                              : ""}
                            {invalid
                              ? ` - unavailable: no race definition at starting grade ${draft.origin === "integrated" ? "G" : String(race.config?.naturalGrade ?? "F")}`
                              : ""}
                            {race.description ? ` - ${race.description}` : ""}
                          </QuestionnaireChoiceDescription>
                        </QuestionnaireChoice>
                      )
                    })}
                </QuestionnaireChoices>
              </QuestionnaireItem>

              {raceType !== "monster" ? (
                <QuestionnaireItem name="class" required>
                  <QuestionnaireTitle>Class</QuestionnaireTitle>
                  <QuestionnaireDescription>
                    Select a class from the catalog.
                  </QuestionnaireDescription>
                  {chosenRace && !hasExplicitNaturalGrade ? (
                    <p className="text-xs text-muted-foreground">
                      Legacy race has no naturalGrade. Grade F configuration is
                      used; catalog row grades are treated as legacy metadata.
                    </p>
                  ) : null}
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
                    {eligibleClasses.map((cls) => (
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
                  {eligibleClasses.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No class definitions are configured for grade{" "}
                      {naturalGrade}.
                    </p>
                  ) : null}
                </QuestionnaireItem>
              ) : null}

              {raceType !== "monster" ? (
                <QuestionnaireItem name="profession">
                  <QuestionnaireTitle>Profession</QuestionnaireTitle>
                  <QuestionnaireDescription>
                    A profession is optional. Choose None if your character has
                    none.
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
                    {eligibleProfessions.map((prof) => (
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
                  {eligibleProfessions.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No profession definitions are configured for grade{" "}
                      {naturalGrade}.
                    </p>
                  ) : null}
                </QuestionnaireItem>
              ) : null}

              <QuestionnaireItem name="special">
                <QuestionnaireTitle>Special abilities</QuestionnaireTitle>
                <QuestionnaireDescription>
                  Select optional catalog entries. No eligibility or effects are
                  inferred here.
                </QuestionnaireDescription>
                {draft.special === "yes" ? (
                  <p className="text-xs text-muted-foreground">
                    This legacy draft had a special-abilities flag, not a
                    catalog selection. Choose entries again if desired.
                  </p>
                ) : null}
                {specialError ? (
                  <Alert variant="destructive">{specialError}</Alert>
                ) : null}
                {creationRulesError ? (
                  <Alert variant="destructive">
                    <div className="flex flex-col gap-2">
                      <span>{creationRulesError}</span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void loadCreationRules()}
                      >
                        Retry rules
                      </Button>
                    </div>
                  </Alert>
                ) : null}
                {!blessings || !bloodlines || !transcendentSkills ? (
                  <div className="flex flex-col gap-2 text-xs text-muted-foreground">
                    <span>
                      {abilityCatalogError
                        ? `Catalog unavailable: ${abilityCatalogError}`
                        : "Loading ability catalogs..."}
                    </span>
                    {abilityCatalogError ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void loadAbilityCatalogs()}
                      >
                        Retry
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {/* The "None" blessing choice is rendered unconditionally so the
                special step always carries a real answered QuestionnaireChoice
                and can be navigated past even when the ability catalogs fail (a
                no-selection draft gains nothing that needs validating). The
                catalog-loaded blessing choices are kept in the same group. */}
                <section
                  aria-labelledby="create-blessings-heading"
                  className="flex flex-col gap-2 rounded-lg border p-3"
                >
                  <h4
                    id="create-blessings-heading"
                    className="text-sm font-medium"
                  >
                    Blessings
                  </h4>
                  <QuestionnaireChoices>
                    <QuestionnaireChoice
                      value=""
                      checked={!draft.specialAbilities.blessing}
                      onChange={() =>
                        setDraft((d) => ({
                          ...d,
                          specialAbilities: {
                            ...d.specialAbilities,
                            blessing: null,
                          },
                        }))
                      }
                    >
                      None
                    </QuestionnaireChoice>
                    {blessings
                      ?.filter(
                        (x) =>
                          !x.archived ||
                          x.id === draft.specialAbilities.blessing?.godId
                      )
                      .map((x) => (
                        <QuestionnaireChoice
                          key={x.id}
                          value={x.id}
                          checked={
                            draft.specialAbilities.blessing?.godId === x.id
                          }
                          onChange={() =>
                            setDraft((d) => {
                              const current = d.specialAbilities.blessing
                              return {
                                ...d,
                                specialAbilities: {
                                  ...d.specialAbilities,
                                  blessing: {
                                    godId: x.id,
                                    tier:
                                      current?.godId === x.id
                                        ? current.tier
                                        : "Minor",
                                  },
                                },
                              }
                            })
                          }
                        >
                          {x.name}
                          {x.archived
                            ? " (Unavailable - re-select required)"
                            : null}
                          <QuestionnaireChoiceDescription>
                            {[x.grade, x.description]
                              .filter(Boolean)
                              .join(" - ")}
                          </QuestionnaireChoiceDescription>
                        </QuestionnaireChoice>
                      ))}
                  </QuestionnaireChoices>
                  {draft.specialAbilities.blessing ? (
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                      <span>Blessing tier</span>
                      <select
                        className="rounded-md border p-1.5 text-sm"
                        value={draft.specialAbilities.blessing.tier}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            specialAbilities: {
                              ...d.specialAbilities,
                              blessing: {
                                ...d.specialAbilities.blessing!,
                                tier: e.target.value,
                              },
                            },
                          }))
                        }
                      >
                        {BLESSING_TIERS.map((tier) => (
                          <option key={tier} value={tier}>
                            {tier}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </section>
                {blessings && bloodlines && transcendentSkills ? (
                  <>
                    <p className="text-xs font-medium">
                      Bloodline (choose one)
                    </p>
                    <label className="flex gap-2 rounded-md border p-2 text-sm">
                      <input
                        type="radio"
                        name="create-bloodline"
                        checked={
                          draft.specialAbilities.bloodlineIds.length === 0
                        }
                        onChange={() =>
                          setDraft((d) => ({
                            ...d,
                            specialAbilities: {
                              ...d.specialAbilities,
                              bloodlineIds: [],
                            },
                          }))
                        }
                      />
                      <span>None</span>
                    </label>
                    {draft.specialAbilities.bloodlineIds.length > 1 ? (
                      <Alert variant="destructive">
                        <div className="flex flex-col gap-2">
                          <span>
                            This recovered draft has multiple bloodlines.
                            Explicitly choose one to continue.
                          </span>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                setDraft((d) => ({
                                  ...d,
                                  specialAbilities: {
                                    ...d.specialAbilities,
                                    bloodlineIds: [],
                                  },
                                }))
                              }
                            >
                              Choose None
                            </Button>
                            {draft.specialAbilities.bloodlineIds.map((id) => (
                              <Button
                                key={id}
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  setDraft((d) => ({
                                    ...d,
                                    specialAbilities: {
                                      ...d.specialAbilities,
                                      bloodlineIds: [id],
                                    },
                                  }))
                                }
                              >
                                Keep{" "}
                                {bloodlines.find((b) => b.id === id)?.name ??
                                  id}
                              </Button>
                            ))}
                          </div>
                        </div>
                      </Alert>
                    ) : null}
                    {bloodlines
                      .filter(
                        (x) =>
                          !x.archived ||
                          draft.specialAbilities.bloodlineIds.includes(x.id)
                      )
                      .map((x) => {
                        const group = x.config.upgradeGroup
                        const conflict =
                          !!group &&
                          draft.specialAbilities.bloodlineIds.some(
                            (id) =>
                              id !== x.id &&
                              bloodlines.find((b) => b.id === id)?.config
                                .upgradeGroup === group
                          )
                        const checked =
                          draft.specialAbilities.bloodlineIds.includes(x.id)
                        return (
                          <label
                            key={x.id}
                            className="flex gap-2 rounded-md border p-2 text-sm"
                          >
                            <input
                              type="radio"
                              name="create-bloodline"
                              checked={checked}
                              disabled={x.archived}
                              onChange={(e) =>
                                setDraft((d) => ({
                                  ...d,
                                  specialAbilities: {
                                    ...d.specialAbilities,
                                    bloodlineIds: e.target.checked
                                      ? [x.id]
                                      : [],
                                  },
                                }))
                              }
                            />
                            <span>
                              {x.name}
                              {x.archived
                                ? " (Unavailable - re-select required)"
                                : null}
                              <small className="block text-muted-foreground">
                                {[
                                  x.grade,
                                  x.description,
                                  conflict
                                    ? "Conflicts with a selected bloodline upgrade group"
                                    : "",
                                ]
                                  .filter(Boolean)
                                  .join(" - ")}
                              </small>
                            </span>
                          </label>
                        )
                      })}
                    {orphanBloodlineIds.map((id) => (
                      <label
                        key={`orphan-bloodline-${id}`}
                        className="flex gap-2 rounded-md border p-2 text-sm"
                      >
                        <input
                          type="radio"
                          name="create-bloodline"
                          checked={draft.specialAbilities.bloodlineIds.includes(
                            id
                          )}
                          onChange={(e) =>
                            setDraft((d) => ({
                              ...d,
                              specialAbilities: {
                                ...d.specialAbilities,
                                bloodlineIds: e.target.checked ? [id] : [],
                              },
                            }))
                          }
                        />
                        <span>
                          {id}
                          <small className="block text-muted-foreground">
                            (Unavailable)
                          </small>
                        </span>
                      </label>
                    ))}
                    <p className="text-xs font-medium">Transcendent skills</p>
                    <p className="text-xs text-muted-foreground">
                      Selected{" "}
                      {draft.specialAbilities.transcendentSkillIds.length} /
                      maximum {maxTranscendentSkills ?? "not loaded"}
                    </p>
                    {transcendentSkills
                      .filter(
                        (x) =>
                          !x.archived ||
                          draft.specialAbilities.transcendentSkillIds.includes(
                            x.id
                          )
                      )
                      .map((x) => (
                        <label
                          key={x.id}
                          className="flex gap-2 rounded-md border p-2 text-sm"
                        >
                          <input
                            type="checkbox"
                            checked={draft.specialAbilities.transcendentSkillIds.includes(
                              x.id
                            )}
                            disabled={
                              !draft.specialAbilities.transcendentSkillIds.includes(
                                x.id
                              ) &&
                              (draft.specialAbilities.transcendentSkillIds
                                .length >= (maxTranscendentSkills ?? 0) ||
                                x.archived)
                            }
                            onChange={(e) =>
                              setDraft((d) => ({
                                ...d,
                                specialAbilities: {
                                  ...d.specialAbilities,
                                  transcendentSkillIds: e.target.checked
                                    ? [
                                        ...d.specialAbilities
                                          .transcendentSkillIds,
                                        x.id,
                                      ]
                                    : d.specialAbilities.transcendentSkillIds.filter(
                                        (id) => id !== x.id
                                      ),
                                },
                              }))
                            }
                          />
                          <span>
                            {x.name}
                            {x.archived
                              ? " (Unavailable - re-select required)"
                              : null}
                            <small className="block text-muted-foreground">
                              {[x.grade, x.description]
                                .filter(Boolean)
                                .join(" - ")}
                            </small>
                          </span>
                        </label>
                      ))}
                    {orphanTranscendentSkillIds.map((id) => (
                      <label
                        key={`orphan-transcendent-${id}`}
                        className="flex gap-2 rounded-md border p-2 text-sm"
                      >
                        <input
                          type="checkbox"
                          checked={draft.specialAbilities.transcendentSkillIds.includes(
                            id
                          )}
                          onChange={(e) =>
                            setDraft((d) => ({
                              ...d,
                              specialAbilities: {
                                ...d.specialAbilities,
                                transcendentSkillIds: e.target.checked
                                  ? [
                                      ...d.specialAbilities
                                        .transcendentSkillIds,
                                      id,
                                    ]
                                  : d.specialAbilities.transcendentSkillIds.filter(
                                      (tid) => tid !== id
                                    ),
                              },
                            }))
                          }
                        />
                        <span>
                          {id}
                          <small className="block text-muted-foreground">
                            (Unavailable)
                          </small>
                        </span>
                      </label>
                    ))}
                  </>
                ) : null}
              </QuestionnaireItem>

              <QuestionnaireItem name="review">
                <QuestionnaireTitle>Review</QuestionnaireTitle>
                <QuestionnaireDescription>
                  Confirm your choices. Stats are calculated server-side; at
                  level 0 your base attributes are all 0 with no awards granted
                  yet.
                </QuestionnaireDescription>
                <div className="flex flex-col gap-1 rounded-lg border bg-input/20 p-3 text-xs/relaxed">
                  <div>
                    <span className="text-muted-foreground">Name: </span>
                    {draft.name || (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </div>
                  {(
                    [
                      "nickname",
                      "pronouns",
                      "ageDescription",
                      "appearance",
                      "biography",
                      "notes",
                    ] as const
                  ).map((field) => (
                    <div key={field}>
                      <span className="text-muted-foreground">
                        {field === "ageDescription"
                          ? "Age description"
                          : field[0].toUpperCase() + field.slice(1)}
                        :{" "}
                      </span>
                      {draft[field]?.trim() ? (
                        <span
                          className={
                            field === "biography"
                              ? "line-clamp-4 whitespace-pre-wrap"
                              : "whitespace-pre-wrap"
                          }
                        >
                          {draft[field]}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">
                          Not provided
                        </span>
                      )}
                    </div>
                  ))}
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
                    {raceName ?? (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </div>
                  <div>
                    <span className="text-muted-foreground">
                      Starting grade:{" "}
                    </span>
                    {draft.origin === "integrated" ? "G" : naturalGrade}
                  </div>
                  {raceType === "monster" ? null : (
                    <>
                      <div>
                        <span className="text-muted-foreground">Class: </span>
                        {className ?? (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </div>
                    </>
                  )}
                  <div>
                    <span className="text-muted-foreground">Profession: </span>
                    {professionName ?? <span>None</span>}
                  </div>
                  <div>
                    <span className="text-muted-foreground">
                      Special abilities:{" "}
                    </span>
                    {[
                      draft.specialAbilities.blessing &&
                        `${draft.specialAbilities.blessing.tier} Blessing of ${
                          blessings?.find(
                            (x) =>
                              x.id === draft.specialAbilities.blessing?.godId
                          )?.name ?? draft.specialAbilities.blessing.godId
                        }`,
                      ...draft.specialAbilities.bloodlineIds.map(
                        (id) =>
                          bloodlines?.find((x) => x.id === id)?.name ??
                          `${id} (Unavailable)`
                      ),
                      ...draft.specialAbilities.transcendentSkillIds.map(
                        (id) =>
                          transcendentSkills?.find((x) => x.id === id)?.name ??
                          `${id} (Unavailable)`
                      ),
                    ]
                      .filter(Boolean)
                      .join(", ") || "None"}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Ability selections are linked atomically with character
                  creation. Portrait upload, if chosen, happens after creation
                  and is not atomic.
                </p>
                {specialError ? (
                  <Alert variant="destructive">{specialError}</Alert>
                ) : null}
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
                      character is created. If that upload fails, the character
                      is still created.
                    </p>
                  ) : null}
                </div>
                <QuestionnaireChoices>
                  <QuestionnaireChoice value="confirmed" defaultChecked>
                    Looks good - create this character
                  </QuestionnaireChoice>
                </QuestionnaireChoices>
              </QuestionnaireItem>
            </>
          ) : null}

          <QuestionnaireActions>
            <QuestionnairePrevious>Back</QuestionnairePrevious>
            <QuestionnaireNext>Next</QuestionnaireNext>
            <QuestionnaireSubmit
              disabled={
                submitting ||
                showRecoverLocal ||
                !ready ||
                !raceType ||
                !!specialError
              }
            >
              {submitting ? "Creating..." : "Create character"}
            </QuestionnaireSubmit>
          </QuestionnaireActions>
        </Questionnaire>
      </fieldset>
    </div>
  )
}
