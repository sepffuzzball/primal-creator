# Evolution

## Source & status

- Source: `https://the-primal-hunter.fandom.com/wiki/Evolution`,
  `https://the-primal-hunter.fandom.com/wiki/Race_Level`,
  `https://the-primal-hunter.fandom.com/wiki/Titles`,
  `https://the-primal-hunter.fandom.com/wiki/Perfect_Evolution_(B-grade)`.
- The core mechanics are **verified**. Archetype details are example-driven
  (wiki-uncertain in scope).

## Verified

- Evolution is a natural step for all multiverse entities. **To evolve is to move
  from one grade to another** (e.g. D-grade evolves into C-grade). The nature and
  benefits of evolution depend on all of a being's Records.
- **Postponing evolution may have adverse effects, and no further experience can
  be earned before the evolution is completed.**
- Beings with **more than a single evolution track** (a combination of race, class,
  and profession) may **postpone one of their evolution paths** in order to
  continue advancing the other, in pursuit of the **Perfect Evolution**. Jake
  Thayne notably postpones an evolution at each stage to gain the associated
  **title**.
- **Grade gates:** reaching grades above D requires an evolution quest unless the
  being is of a higher-level race that matures above that grade (`Race_Level`).
- **Evolution Archetypes** are described, including "Find Your Path" (assigned by
  the System to anyone whose Path has no clear progression). The Viper notes race
  evolution quests are **not** assigned to anyone born at a grade below their
  natural potential (example: Sylphie and True Dragons are born below their natural
  B-grade and get no race evolution quest until they surpass that natural level).

## Verified titles

Evolution titles are awarded for completing grade evolutions and for the
"perfect" version:
- Evolution (D) / Perfect Evolution (D-grade)
- Evolution (C) / Perfect Evolution (C-grade)
- Evolution (B) / Perfect Evolution (B-grade)

Perfect Evolution (B-grade) requires becoming a B-grade Human while race, class,
and profession are all at **level 349** simultaneously.

## Wiki-uncertain

- The full taxonomy of evolution archetypes (only "Find Your Path" is described in
  the retrieved text).
- Whether evolution has a time cost or a resource cost (only "no experience can be
  earned before completed" is stated).
- The numeric stat jump provided by a race evolution (e.g. Human D->C gives +18
  all / +45 free; B-grade gives +54 all / +135 free) is sourced per grade, not as a
  generic evolution formula.

## Engine note

Evolution must be modeled as a **phase gate** in the engine:
- It is triggered at a grade boundary (generally above D, or at a race's natural
  grade).
- While an evolution is pending/not completed, **further experience gains are
  blocked** (source-verified).
- A participant with multiple tracks may defer one track's evolution to keep
  advancing the other.

The engine does **not** invent an evolution XP formula; the block is modeled as
data. See `docs/architecture/calculation-engine.md`.

## Race evolution paths (catalog-driven)

Race evolution in the app is not hard-coded to a single house formula. The
catalog `evolutions` kind defines contextual RACE evolution paths, and the
service exposes them as a choice the owner/admin must resolve before the grade
changes.

### Config shape

An **active race path** carries a full, validated config:
`track: "race"`, `fromRaceStableId`, `toRaceStableId`, `fromGrade`, `toGrade`,
plus the optional `minRaceLevel`, `requiredTitleStableIds`,
`requiredSkillStableIds` and `manualRequirementsText`. Any entry missing a
required field is not a usable path.

A **legacy metadata-only** config (the old `{from, to, titleId}` shape) stays
readable and editable, but is not selectable as a path. The service rejects a
NEW or CONFIG-CHANGED `evolutions` entry that is not a valid full race path,
mirroring the consumables/skills hardening.

### GET /api/characters/[id]/evolutions (owner/admin)

Returns `{ options, legacyAvailable }` where each option describes one path that
matches the character's **current race stableId, current grade, and the NEXT
grade** (evolution is one step at a time per the engine's grade-ceiling gate).
Archived entries, malformed configs, wrong-race / wrong-grade / non-next-grade
entries, and paths whose destination race is missing, archived, or has no
`raceDefinitions[toGrade]` are ignored.

Each option exposes `eligible` (the mechanical requirements are met) and
`blockers` (the unmet requirements) computed from the race/grade match,
`minRaceLevel`, and the required title/skill associations (linked, unarchived
definitions). `manualReview` is true when the path carries a
`manualRequirementsText` narrative gate. `legacyAvailable` is true **only when
no valid catalog path matches** - the client then falls back to the legacy
grade-only house evolution.

### POST /api/characters/[id]/evolve

- **Path choice** (`{optionId, version, reason?}`): the server re-evaluates the
  path eligibility inside the transaction. The destination race must exist, be
  enabled, and define `raceDefinitions[toGrade]`, otherwise the request is
  rejected. The engine evolution runs against the TARGET race's rules config
  only (no invented rewards/skills); the character's `raceId`, race grade and
  race `definitionId` are updated, while class/profession tracks,
  `historicalLevelAwards` and `allocations` are preserved. The journal records
  the option id, the prerequisites, and any (user or admin) reason.
- **Manual gate:** a user reason never bypasses a mechanical blocker. A
  `manualRequirementsText` gate is bypassed only by a **nonempty admin reason**.
- **Legacy grade-only** (`{grade, version}`): if ANY valid catalog path to the
  requested grade exists (even when every such path is currently blocked), the
  request is rejected with `409 evolution_choice_required` so the client must
  submit an `optionId`. Only when no valid path exists does the legacy grade-only
  house fallback run as before.

## Class/profession track evolution paths (catalog-driven)

Class and profession tracks are **graded** independently of the race. A new
character created through the wizard is stamped with the race's **natural grade**
(legacy `F` fallback when the race config declares none) and a
`stableId:<grade>` definition on each selected track (see
`docs/rules/classes.md` and `docs/rules/professions.md`), so the class and
profession each have their **own** progression gate and never inherit the race
grade. For these tracks evolution is a per-track catalog path choice - there is
**no** grade-only legacy fallback for class/profession.

### Config shape

An **active class/profession path** carries a full, validated config:
`track: "class"` or `track: "profession"`, `fromDefinitionStableId`,
`toDefinitionStableId`, `fromGrade`, `toGrade`, plus the optional `minTrackLevel`,
`requiredTitleStableIds`, `requiredSkillStableIds` and
`manualRequirementsText`. Any entry missing a required field is not a usable path.

A **legacy metadata-only** config (the old `{from, to, titleId}` shape) stays
readable and editable, but is not selectable as a path. The service rejects a
NEW or CONFIG-CHANGED `evolutions` entry that is not a valid **full race path OR
a full class/profession path**, mirroring the consumables/skills hardening.

### GET /api/characters/[id]/evolutions?track=class|profession (owner/admin)

The endpoint accepts an optional `?track=race|class|profession` query param
(default `race`). For `class`/`profession` it returns `{ options,
legacyAvailable: false }` where each option matches the character's **current
class/profession definition stableId, that track's OWN grade, and the NEXT
track grade** (one step at a time). Archived entries, malformed configs,
wrong-track / wrong-definition / wrong-grade / non-next-grade entries, and paths
whose destination definition is missing, archived, or has no
`grades[toGrade]` are ignored.

Each option exposes `eligible` and `blockers` from the definition-stableId match,
the track grade match, `minTrackLevel`, and the required title/skill
associations; `manualReview` is true when the path carries a
`manualRequirementsText` narrative gate.

A track without an explicit `grade` (a legacy graded-unknown state) returns no
options and no fallback - the UI shows a note that there is nothing to offer until
the track is given an explicit grade.

### POST /api/characters/[id]/evolve

- **Track path choice** (`{track: "class"|"profession", optionId, version,
  reason?}`): the server re-evaluates the path eligibility inside the transaction.
  The destination definition must exist, be enabled, and define
  `grades[toGrade]`, otherwise the request is rejected. The engine
  `evolveTrackGrade` runs against the character's rules config and changes **only
  the target track's** `grade` and `definitionId`; the race grade and every other
  ledger (`historicalLevelAwards`, `allocations`, associations) are preserved. The
  character's `classId` or `professionId` is updated and the journal records the
  option id, the prerequisites, the old/new definition ids, and any (user or
  admin) reason.
- **Manual gate:** a user reason never bypasses a mechanical blocker. A
  `manualRequirementsText` gate is bypassed only by a **nonempty admin reason**.
- The race grade is never auto-changed by a class/profession evolution.
