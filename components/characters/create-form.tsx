"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import {
  apiFetch,
  jsonInit,
  type CatalogItem,
  type CatalogListResponse,
  type CharacterResponse,
} from "@/lib/api"
import { Alert } from "@/components/ui/alert"
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

interface Draft {
  step: string
  name: string
  description: string
  origin: string
  raceId: string
  classId: string
  professionId: string
  special: string
  equipment: string
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

  const setField = React.useCallback((field: keyof Draft, value: string) => {
    setDraft((d) => ({ ...d, [field]: value }))
  }, [])

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

  // Persist the draft (including the current step) for refresh recovery.
  React.useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(draft))
    } catch {
      // Ignore storage availability errors.
    }
  }, [draft])

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

  const onSubmit = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      setSubmitting(true)
      try {
        const res = await apiFetch<CharacterResponse>("/api/characters", {
          ...jsonInit("POST", {
            name: draft.name,
            description: draft.description,
            origin: draft.origin,
            raceId,
            classId,
            ...(professionId ? { professionId } : {}),
          }),
        })
        window.localStorage.removeItem(STORAGE_KEY)
        toast.success(`Created "${res.character.name}".`)
        router.push(`/characters/${res.character.id}`)
        router.refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Creation failed.")
      } finally {
        setSubmitting(false)
      }
    },
    [draft, router, raceId, classId, professionId]
  )

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-lg font-medium">Create a character</h1>
        <p className="text-xs text-muted-foreground">
          An eight-step questionnaire. Your progress is saved locally so a
          refresh will not lose it.
        </p>
      </div>

      {catalogError ? (
        <Alert variant="destructive">{catalogError}</Alert>
      ) : null}

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
            defaultValue={draft.name}
            onChange={(e) => setField("name", e.target.value)}
          />
          <QuestionnaireInput
            placeholder="Description (optional)"
            defaultValue={draft.description}
            onChange={(e) => setField("description", e.target.value)}
          />
        </QuestionnaireItem>

        <QuestionnaireItem name="origin" required>
          <QuestionnaireTitle>Origin</QuestionnaireTitle>
          <QuestionnaireDescription>
            Where does your character come from? This sets their starting grade
            progression.
          </QuestionnaireDescription>
          <QuestionnaireChoices>
            <QuestionnaireChoice
              value="born"
              defaultChecked={draft.origin === "born"}
              onChange={(e) => e.target.checked && setField("origin", "born")}
            >
              Born
              <QuestionnaireChoiceDescription>
                Born into the system. Starts at F grade.
              </QuestionnaireChoiceDescription>
            </QuestionnaireChoice>
            <QuestionnaireChoice
              value="integrated"
              defaultChecked={draft.origin === "integrated"}
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
                defaultChecked={raceId === race.id}
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
            <p className="text-xs text-muted-foreground">Loading classes...</p>
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
                defaultChecked={classId === cls.id}
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
              defaultChecked={professionId === ""}
              onChange={(e) => e.target.checked && setField("professionId", "")}
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
                defaultChecked={professionId === prof.id}
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
            Special abilities are not yet modeled by the calculation engine, so
            this choice is recorded as information only and does not alter any
            numbers.
          </QuestionnaireDescription>
          <QuestionnaireChoices>
            <QuestionnaireChoice
              value="none"
              defaultChecked={draft.special === "none"}
              onChange={(e) => e.target.checked && setField("special", "none")}
            >
              None
              <QuestionnaireChoiceDescription>
                No special abilities recorded.
              </QuestionnaireChoiceDescription>
            </QuestionnaireChoice>
            <QuestionnaireChoice
              value="yes"
              defaultChecked={draft.special === "yes"}
              onChange={(e) => e.target.checked && setField("special", "yes")}
            >
              Has special abilities
              <QuestionnaireChoiceDescription>
                Recorded, but not yet calculated.
              </QuestionnaireChoiceDescription>
            </QuestionnaireChoice>
          </QuestionnaireChoices>
        </QuestionnaireItem>

        <QuestionnaireItem name="equipment">
          <QuestionnaireTitle>Equipment</QuestionnaireTitle>
          <QuestionnaireDescription>
            Equipment is not yet modeled for created characters, so this choice
            is recorded as information only and does not alter any numbers.
          </QuestionnaireDescription>
          <QuestionnaireChoices>
            <QuestionnaireChoice
              value="none"
              defaultChecked={draft.equipment === "none"}
              onChange={(e) =>
                e.target.checked && setField("equipment", "none")
              }
            >
              None
              <QuestionnaireChoiceDescription>
                No equipment recorded.
              </QuestionnaireChoiceDescription>
            </QuestionnaireChoice>
            <QuestionnaireChoice
              value="yes"
              defaultChecked={draft.equipment === "yes"}
              onChange={(e) => e.target.checked && setField("equipment", "yes")}
            >
              Has equipment
              <QuestionnaireChoiceDescription>
                Recorded, but not yet calculated.
              </QuestionnaireChoiceDescription>
            </QuestionnaireChoice>
          </QuestionnaireChoices>
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
              <span className="text-muted-foreground">Special abilities: </span>
              {draft.special === "yes" ? "Recorded (not calculated)" : "None"}
            </div>
            <div>
              <span className="text-muted-foreground">Equipment: </span>
              {draft.equipment === "yes" ? "Recorded (not calculated)" : "None"}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {draft.special === "yes" || draft.equipment === "yes" ? (
              <>
                Selected special abilities or equipment are captured here but
                are not yet wired into the engine, so no numbers are inferred
                from them.
              </>
            ) : null}
          </p>
          <QuestionnaireChoices>
            <QuestionnaireChoice value="confirmed" defaultChecked>
              Looks good - create this character
            </QuestionnaireChoice>
          </QuestionnaireChoices>
        </QuestionnaireItem>

        <QuestionnaireActions>
          <QuestionnairePrevious>Back</QuestionnairePrevious>
          <QuestionnaireNext>Next</QuestionnaireNext>
          <QuestionnaireSubmit>
            {submitting ? "Creating..." : "Create character"}
          </QuestionnaireSubmit>
        </QuestionnaireActions>
      </Questionnaire>
    </div>
  )
}
