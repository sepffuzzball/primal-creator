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

## Race evolution (next-grade candidates)

Race evolution is no longer gated by catalog `evolutions` paths. A race evolves
into ANY unarchived compatible race definition at exactly the next grade, in the
same advancement mode (same `raceType`). There is no legacy grade-only fallback.

### Candidates

GET `/api/characters/[id]/evolutions?track=race` (owner/admin, default `race`)
returns `{ options, legacyAvailable: false }`. Each option is a DESTINATION race
catalog definition that:

- is unarchived;
- advances in the SAME mode as the current race (`raceType` matches - an
  enlightened race can never evolve into a monster race without an explicit
  conversion);
- defines the next grade's `raceDefinitions[toGrade]`.

`fromGrade` is the character's current race grade and `toGrade` is always the
immediately following grade (one step at a time per the engine's grade-ceiling
gate). `id` is the destination race definition id. `legacyAvailable` is always
false: there is no grade-only house fallback to offer.

Each option exposes `eligible` (no engine-level blocker applies) and `blockers`
(the unmet engine-level requirements, empty when eligible). The only blockers are
the engine's own grade-band / grade-gate checks (the pure `evolveGrade` gate), so
GET agrees with POST.

### POST /api/characters/[id]/evolve

- **Race choice** (`{track: "race", optionId, version, reason?}`): the server
  re-fetches the destination row and re-validates ALL of the predicates that built
  the GET option INSIDE the SERIALIZABLE transaction - the destination must exist,
  be unarchived, be a `races` definition, advance in the same `raceType`, and
  define `raceDefinitions[toGrade]`; otherwise the request is rejected with a
  specific error code. The pure engine `evolveGrade` then runs against the TARGET
  race's rules config only (no invented rewards/skills); the character's
  `raceId`, race grade and race `definitionId` are updated, while class/profession
  tracks, `historicalLevelAwards` and `allocations` are preserved. The journal
  records the option id, the old and new race/definition snapshots, and any reason.
- There is no legacy grade-only payload: every request must name `track` and an
  `optionId`, so a missing track is a 400 validation error.

## Class/profession track evolution (next-grade candidates)

Class and profession tracks are **graded** independently of the race (see
`docs/rules/classes.md` and `docs/rules/professions.md`). Their evolution is a
per-track next-grade candidate choice from the definitions catalog - there is no
grade-only legacy fallback for class/profession and no catalog path/title/manual
gate.

### Candidates

GET `/api/characters/[id]/evolutions?track=class|profession` (owner/admin)
returns `{ options, legacyAvailable: false }`. Each option is a DESTINATION
class/profession catalog definition that:

- is unarchived;
- defines the next grade's `grades[toGrade]` gain (a class/profession with no
  per-grade config for the next grade is not a candidate).

`fromGrade` is the track's own grade and `toGrade` is always the immediately
following grade. `id` is the destination definition id. `legacyAvailable` is
always false.

A track without an explicit `grade` (a legacy graded-unknown state) returns no
options and no fallback - the UI shows a note that there is nothing to offer until
the track is given an explicit grade.

Each option exposes `eligible` and `blockers` from the engine-level grade-band /
grade-gate checks (the pure `evolveTrackGrade` gate), so GET agrees with POST.

### POST /api/characters/[id]/evolve

- **Track choice** (`{track: "class"|"profession", optionId, version, reason?}`):
  the server re-fetches the destination row and re-validates inside the
  SERIALIZABLE transaction - the destination must exist, be unarchived, be a
  class/profession definition of the right kind, and define `grades[toGrade]`;
  otherwise the request is rejected. The engine `evolveTrackGrade` runs against
  the character's rules config and changes ONLY the target track's `grade` and
  `definitionId`; the race grade and every other ledger (`historicalLevelAwards`,
  `allocations`, associations) are preserved. The character's `classId` or
  `professionId` is updated and the journal records the option id, old/new
  definition ids, and any reason.
- The race grade is never auto-changed by a class/profession evolution.
