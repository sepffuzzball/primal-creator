# Professions

## Source & status

- Source: `https://the-primal-hunter.fandom.com/wiki/Profession`,
  `https://the-primal-hunter.fandom.com/wiki/Human`.
- Stat-cap numbers are verified; the canonical list of professions is
  wiki-uncertain (the wiki gives archetypes, not a fixed registry).

## Verified

- Professions are an alternative way of growing through the system. They tend to
  be **less combat focused** than classes, though that varies by profession. They
  are colloquially split into **crafting** and **social** professions.
- Verified crafting archetypes: Tailor, Smith, Builder, Cook, Alchemist,
  Leatherworker, Artist.
- Verified social archetypes: Leader, Merchant, Manager, Priest, Host, Teacher.
- Professions grant per-level stat bonuses and Starting Skills (e.g. the
  Alchemist profession starts with Herbology, Brew Potion, Concoct Poison, etc.).
- **Per-level stat caps** for professions are published:
  - E-grade: max stats per level without restrictions is **22**; with severe
    restrictions it is **27**.
  - D-grade: max with severe restrictions is **80**; stated to imply approximately
    **66** without restrictions.
  - C-grade: max with severe restrictions is **240**.
- Humans can possess **both** a class and a profession; many races can possess only
  one (`Human`). This matters for the race-level formula (see `docs/rules/races.md`).

## Wiki-uncertain

- Whether the listed archetypes are exhaustive (the wiki presents them as known
  archetypes, not a complete registry).
- The exact profession available to a generic creator at each grade (the wiki's
  examples skew to Alchemist variants from Jake Thayne's story).
- Per-level caps for grades other than E, D, and C are not given.

## Engine note

Profession is modeled like class: a progression track with per-level bonuses and a
grade-based cap. If a race has **no profession**, the engine treats the missing
profession level as 0 per the house assumption in `docs/rules/races.md` and
`docs/rules/assumptions.md`.

As with class, a profession track may carry an **optional explicit grade**
(`TrackState.grade`) that independently caps the profession track's level-up at
the entry level of the **next** grade until the caller explicitly evolves the
profession grade via `evolveTrackGrade`. Quarter progress (0/25/50/75) is
preserved, and a profession may evolve ahead of the derived race grade when the
race level is below its own boundary. A profession state **without** a grade is
unaffected (legacy behavior preserved); the engine never infers one
(see `docs/rules/leveling.md`).

A new profession created through the wizard is stamped with the race's exact
`naturalGrade` grade (legacy fallback `F`) and a `stableId:<grade>` definition,
so the catalog must define a `<grade>`-grade per-level config
(`grades.<grade>`) for it - the service refuses to create such a profession
otherwise. Profession evolution is then a catalog-driven per-track path choice
with **no** grade-only legacy fallback (see `docs/rules/evolution.md`).

## Catalog definition (single-grade)

A `professions` catalog entry is a SINGLE-grade definition, exactly like a class:
its `grade` column is the one grade it belongs to, and its `config.grades` map
must authorize exactly that one grade - the key matching `grade` - with a valid
per-level row (a missing, extra, or mismatched grade row is rejected with 400
`invalid_config` on creation or a config/grade-changing edit). The optional
auto-grant map, when present, may only declare that same grade key
(`gradeGrantedSkillStableIds[<grade>]`). Races remain multi-grade: a `races`
entry authorizes many `raceDefinitions` (one per grade) and a separate
`gradeGrantedSkillStableIds` map keyed across all grades.

The admin editor renders a profession as a single row at one grade. Changing the
grade in the editor moves the existing `grades[<oldGrade>]` gains row (and any
`gradeGrantedSkillStableIds[<oldGrade>]` grants) onto the new grade key, so the
per-level progression and the auto-grants travel with the grade change. The grade
selector is disabled on a legacy multi-row entry, and a config-changing edit on
such an entry is refused until the rows are resolved to a single grade.

A profession carries no authored grade-specific prose: `gradeDescriptions`, when
sent on a new or config/grade-changing write, must be empty (`{}`) or omitted; a
non-empty map is rejected with 400 `invalid_grade_descriptions`. The legacy
`description` string is the prose for the profession's one grade, and it is what
the character detail **profession** tab shows (via `professionDescription`). A
legacy profession row that still stores an authored `gradeDescriptions` map keeps
returning it on the API (as `professionGradeDescription`), but the UI does not
display it - it shows the general `description` instead. Legacy authored grade
prose is never migrated or cleared; it is simply no longer shown by the UI nor
newly authored.

A **grade-only PATCH** - changing `grade` without supplying `config` in the same
PATCH - is rejected with 400 `invalid_config`, because otherwise the single-grade
`grades` map would be silently rekeyed to the wrong grade. A metadata-only PATCH
(no `grade`, no `config`) leaves a legacy empty or multi-row profession alone. A
legacy profession row that is empty or multi-grade stays readable and
metadata-only PATCHable but cannot be newly created that way, and a
config-changing PATCH must first normalize it to a single grade row. No database
migration clears or rewrites these rows today.

## Setting a profession after creation (set-once)

A character created without a profession (or that must be assigned later by an
owner/admin) can gain one through `POST /api/characters/[id]/profession`. This
is a **set-once** assignment: it links a `professions` catalog entry and opens a
`profession` progression track on a character that has neither. It never
re-assigns an existing profession.

Guards:

- Only an **enlightened** race with a **class track** may carry a profession. A
  monster (independent race mode) or a legacy classless imported character is
  rejected with 400 `profession_requires_class`. That mirrors the wizard rule: a
  profession is a class-adjacent track and cannot exist without a class.
- A character that already carries a `professionId` or a `profession` track is
  rejected with 409 `profession_already_set` (set once).
- The catalog entry must be an **active** (unarchived) `professions` definition;
  anything else is rejected (404 `catalog_not_found`, 400 `wrong_kind`,
  400 `catalog_archived`).

Grade gate:

- The profession is chosen EXACTLY at the character's **current race grade**
  (`state.race.grade`), the same way a creation wizard profession is stamped.
  The catalog entry's own `grade` must equal the current race grade (a mismatch
  is 400 `profession_grade_mismatch`) AND it must declare a
  `grades.<currentRaceGrade>` per-level config (missing is 400
  `profession_grade_config_missing`), exactly the per-grade gate a create-time
  profession goes through. No lower-grade fallback is used.

Write:

- The `profession` track is created at `{ level: 0, quarter: 0,
grade: currentRaceGrade, definitionId: "<stableId>:<grade>" }`; the
  `professionId` column, the engine state and the version are written together
  under the character's CAS version (a stale version 409s `version_conflict` and
  rolls back the state write + event).
- No level awards are granted. The class/race tracks, historical awards,
  allocations and every other ledger are left untouched, and the run uses
  SERIALIZABLE isolation (a concurrent write that cannot serialize surfaces as a
  retryable 409 `catalog_serialization_conflict`, never a raw 500).
- One immutable `profession_set` progression event is appended carrying the
  resolved stable id/name/grade and a before/after snapshot of the profession id
  and track.

## Seeded profession definitions (`db:seed`)

`pnpm db:seed` seeds Jake Thayne's five alchemist profession progression
definitions (`prisma/catalog/jake-seed.ts`), sourced from
`https://the-primal-hunter.fandom.com/wiki/Jake_Thayne/Profession`, each with
exactly one `grades.<grade>` entry:

| Grade | Name                                          | stableId                                          |
| ----- | --------------------------------------------- | ------------------------------------------------- |
| F     | Alchemist of the Malefic Viper                | `alchemist-of-the-malefic-viper`                  |
| E     | Prodigious Alchemist of the Malefic Viper     | `prodigious-alchemist-of-the-malefic-viper`       |
| D     | Heretic-Chosen Alchemist of the Malefic Viper | `heretic-chosen-alchemist-of-the-malefic-viper-d` |
| C     | Heretic-Chosen Alchemist of the Malefic Viper | `heretic-chosen-alchemist-of-the-malefic-viper-c` |
| B     | Primeval Alchemist of Malefic Origins         | `primeval-alchemist-of-malefic-origins`           |

The F-grade stableId deliberately matches the reviewed manifest
(`prisma/catalog/wiki-reviewed.ts`), so if an admin imports the manifest first the
existing row is preserved. The source documents the same display name at both D
and C, so those two entries are disambiguated by the `-d` / `-c` stableId
suffixes. All five are create-only: an existing row is never overwritten and a
repeated seed is idempotent.
