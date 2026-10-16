# Leveling

## Source & status

- Source: `https://the-primal-hunter.fandom.com/wiki/Race_Level`,
  `https://the-primal-hunter.fandom.com/wiki/Evolution`,
  `https://the-primal-hunter.fandom.com/wiki/Skills`,
  `https://the-primal-hunter.fandom.com/wiki/E-grade`.
- The exact XP curve is **wiki-uncertain**; the wiki publishes level ranges and
  rules, not an experience-point table.

## Verified

- Leveling advances a participant's **race, class, and profession** levels. For
  enlightened races (e.g. humans) that can possess both a class and a profession,
  the **race level** displayed to others is the **average of the class and
  profession levels** (`Race_Level`). For monsters and beasts, race level is simply
  their level.
- **Starting grades / auto-advance:** newly integrated races begin at G-grade and
  automatically advance to F-grade at level 10; anyone born into the system is
  automatically F-grade at birth (`Race_Level`).
- **Grade gates:** reaching grades above D requires an evolution quest, unless the
  being is of a higher-level race that matures above that grade (`Race_Level`).
- **Evolution blocks XP:** "no further experience can be earned before the
  evolution is completed" (`Evolution`). See `docs/rules/evolution.md`.
- **Skills are not auto-awarded on level-up.** Skills are offered as choices at
  milestones and are not granted automatically (see `docs/rules/skills.md`).

## Wiki-uncertain

- No published XP-per-level table, no level-up XP formula, and no
  experience-per-monster formula. The wiki gives level bands and rules, not
  numeric XP constants.
- sub-stage boundaries (early/mid/late/peak) are published only for E-grade
  (levels 25-50, 50-75, 75-95, 95-99). Other grades are not pinned.

## House assumption / engine note

Because the XP curve is unsourced, the engine does **not** invent one. Instead it
operates on a **historical level awards snapshot**: it computes stat awards from
per-grade base values captured per level, rather than from a single derived XP
formula. See `docs/architecture/calculation-engine.md`. Where a multiplier is
needed but unsourced (e.g. derived resource pools), it remains an unresolved
configurable placeholder (`docs/rules/assumptions.md`).

## Skill-offer re-offer on a re-earned level

Because skills are **offered, never auto-awarded** (see `docs/rules/skills.md`),
leveling a class/profession track generates a pending skill offer per choice group.
Those offers are **append-only**: they may be **canceled** (stamping `canceledAt`)
rather than deleted, so their history is preserved. When a character **re-earns** a
level whose offer was canceled, the service re-offers it as a new **generation**:
it skips when an active (`canceledAt` null) offer already exists for that
`(track, level, choiceGroup)`, otherwise it creates a new offer with generation
`max existing + 1` and fresh option snapshots. This is the prerequisite for EXP
undo - undoing a level that awarded an offer cancels the pending offer instead of
deleting it, and re-earning the level re-offers it without ever rewriting the
historical offer.

## Skill-choice credit milestones

A class/profession level-up **or an independent (monster) race level-up** generates a
pending skill offer only when the level is a **skill-choice credit** under the
configurable per-grade schedule (`house_rules.config.skillChoiceIntervals`), not at
every level. The pure helper `isSkillChoiceMilestone(grade, level, intervals)`
decides this from the stored track grade (or the race grade for a legacy ungraded
track, or the race's own grade for a monster race). Every grade G..S is now
configurable; a G-grade track credits on the same cadence as F but is capped by the
F band (see `docs/rules/skills.md`). A monster race earns exactly one `"standard"`
offer per matching milestone - even with zero options - and never a class/profession
offer. See `docs/rules/skills.md` for the schedule and the single-`"standard"`-offer
semantics.

## Track grade ceiling (class / profession)

In addition to the grade gate that applies to the **derived race level**, a class
or profession track may carry an **optional explicit grade** (`TrackState.grade`).
This is a house-state addition, not a source claim, and it is never inferred for a
state that lacks it (legacy states stay untouched).

When a track grade is present, `advanceQuarter` applies an **independent
track-grade ceiling**: a level-up may reach exactly the entry level of the **next**
grade but may not push the track level past it until the caller explicitly evolves
the track grade via the pure engine function `evolveTrackGrade`. Quarter progress
(0/25/50/75) is preserved across that boundary, and the class/profession may evolve
ahead of the race: because this ceiling checks the **track level** (not the derived
race level), a class or profession can be advanced and evolved even while the
derived race level is still below its own grade boundary. The existing race-grade
gate remains separately enforced against the derived race level, so a race that
reaches its own threshold still blocks further derived race gain until the **race**
evolves.

`evolveTrackGrade(state, track, targetGrade, targetDefinitionId, config)` is a pure
validation function: it rejects an unknown or ungraded track, a target that is not
the immediate next grade, a track level outside the target grade band, a closed
grade gate, and an empty target definition id. On success it returns a new state
with only the track's `grade` and `definitionId` updated; historical awards and
every other ledger stay snapshotted, and the track then continues under the new
grade (and the new definition id, which must match on subsequent advances).

## Race-only advancement (monster)

A **monster** race is race-only: it has no class or profession track and its race
state carries `mode: "independent"`. It advances through the pure engine function
`advanceRaceQuarter(state, definition, config)` on a four-quarter cadence, mirroring
the way a class/profession quarter is consumed:

- Each race advance increments `state.race.quarter` by one (0 -> 1 -> 2 -> 3).
- On the **fourth** quarter the race level increments by one, `quarter` resets to 0,
  and the race award for the current grade is **snapshotted** into
  `historicalLevelAwards` with `track: "race"`. The award is taken from the race
  definition for the character's grade and is never fabricated at create - only a
  level-up snapshots it.
- The race track also enforces the **NEXT-grade entry threshold**: it will refuse a
  level-up that would push the race level past the next grade's entry level until
  the caller evolves the race grade.
- Advancement is mutually exclusive with the class/profession path: a monster
  summoning a `class`/`profession` advance is rejected (`invalid_track`), and an
  enlightened (derived) race advancing via the `race` track is rejected the same
  way.

See `docs/rules/races.md` for the `raceType` split that decides which path a race
takes.

## Grade ceiling level-up blockers (read-only)

The progression engine never mutates state on a read, and neither do the read-only
blocker helpers `gradeLevelUpBlockReason(state, track, config)` and
`gradeLevelUpBlockers(state, config)` exported from `lib/rules/progression.ts`.
They mirror the engine's actual grade gates exactly - a level-up may reach exactly
the entry level of the NEXT grade but may not push past it until the caller evolves
the grade - so a client can show which `+Level` buttons are disabled by the
authoritative current grade ceiling without re-deriving the rule.

- A **monster** (independent race) exposes only the `race` key, gated by the race's
  own level against the next race grade band's entry level.
- An **enlightened** (derived) race exposes only `class` and `profession`. The
  derived race gate is evaluated FIRST using the projected race level after the
  hypothetical track level-up (the same `raceDerivationStrategy` the engine uses),
  and is reported before any per-track ceiling. A track carries a track-grade
  ceiling only when it is explicitly graded; a legacy ungraded track never does. A
  derived race's level is the symmetric average of its tracks, so a class and a
  profession level-up no longer block independently - they project the same race
  level and are both blocked when it crosses the ceiling.

The service exposes this on `CharacterDetail.levelUpBlocked` (a
`Partial<Record<"race" | "class" | "profession", string>>`, present only for a
track a level-up actually blocks). It is computed in the detail read from the
stored state and current rules config - no second query and no mutation - so it is
always authoritative against the same grade table the progression engine runs.

## Authoritative EXP percentage (quarter cadence replaced)

The quarter index is no longer the primary progression input for new/modernized
state. Instead a **track** (class/profession) or an **independent (monster) race**
carries an optional authoritative `experiencePercent` (integer 0..99) on its state:

- `TrackState.experiencePercent` and `RaceState.experiencePercent` (independent
  race only) are the source of truth for the EXP percentage within the current
  level.
- When present, the track's `quarter` MUST equal `floor(experiencePercent / 25)`
  (enforced by the Zod schemas; a mismatched state is rejected on the API
  boundary). The `quarter` field itself is preserved as the legacy 25% turn
  boundary marker and is still what the quarter engine advances.
- When absent (a legacy state predating explicit EXP tracking), the engine never
  rewrites the state on a read. Reads fall back to the legacy quarter cadence:
  `experiencePercentFor(state, track)` resolves to the explicit percent when
  present, otherwise `quarter * 25`. A legacy state is given an explicit percent
  only when it is actually advanced (`advanceQuarter` / `advanceRaceQuarter`
  always set `experiencePercent = quarterAfter * 25` on the state they mutate).

The engine's quarter engine (`advanceQuarter` / `advanceRaceQuarter`) is reused
unchanged for the 25% turn boundaries and for level awards. The new pure function
`setExperiencePercent(state, track, target, definition, config)` is the
authoritative EXP gate:

- `target` is an integer 0..100. A target of 100 requests a level-up; 0..99 sets
  the percentage within the current level.
- The **race** track requires `state.race.mode === "independent"` (a monster); a
  class/profession track must already exist. A derived (enlightened) race never
  carries its own percent - its displayed percent is a read-only average of the
  available class/profession EXP percentages computed by the UI, and it does NOT
  change the configurable race-level strategy (which remains `deriveRaceLevel`).
- **Backward** (`target < current`): sets `experiencePercent` to `target` and
  `quarter` to `floor(target / 25)`, never decrements `state.turn`, never revokes
  awards, and reports `turnsAdvanced: 0`.
- **No-op** (`target === current`): returns the input state unchanged (no turn
  change).
- **Forward** (`target > current`): for each crossed 25/50/75/100 boundary it calls
  the existing `advanceQuarter` / `advanceRaceQuarter` exactly once, each of which
  increments `state.turn` and applies its own grade-gate, race-gain, evolution-offer
  and expiry logic. The final call at 100 levels up (or fails atomically on a grade
  gate). A target below 100 ends with `experiencePercent = target` and
  `quarter = floor(target / 25)`.

`levelUpFromExperience(state, track, definition, config)` is a thin wrapper over
`setExperiencePercent(..., 100)`: it may level from ANY percentage (including 0),
resets the percent to 0 after the level-up, and never synthesizes skill offers (the
service adds those only on an actual level-up). No percent-only engine effect or
stat gain is ever applied - only the level boundary grants stats, exactly as the
quarter engine already did.

## Service API: POST /api/characters/[id]/experience

The service exposes the authoritative EXP gate through
`POST /api/characters/[id]/experience` (authenticated owner/admin), a discriminated
`experienceSchema` request:

- `{ operation: "set", track, percent, version }` settles the authoritative
  experience percentage of the selected track. `percent` is an integer 0..100;
  a target below 100 settles within the current level, while a target of 100 is a
  level-up (the `advance`-equivalent). `version` is the CAS token.
- `{ operation: "levelUp", track, version }` is an instant level-up from any
  percentage and carries no `percent`; it is exactly
  `setExperiencePercent(..., 100)` / `levelUpFromExperience`.
- `{ operation: "undo", track, version }` is a safe compensating reversal of the
  most recent actual level-up on the selected track. It carries no `percent` (the
  EXP percentage to restore comes entirely from the immutable journal of the
  original level-up event, which this operation never rewrites). See
  "Level-up undo" below.

`track` accepts the same three vocabularies as `/advance`, and the same race-mode
rule applies: the race track is legal only for an independent (monster) race, and
a class/profession track is legal only for an enlightened race.

Behavior:

- A `set` with `percent < 100` records an `experience_set` progression event whose
  journal carries `percentBefore` / `percentAfter` / `turnsAdvanced`; no skill
  offers or popups are generated.
- A `set` with `percent === 100`, or a `levelUp`, performs an actual level-up and
  records an `advance` progression event whose journal carries
  `characterVersionAfter` (the committed version, for deterministic undo), the
  snapshotted award/raceGain, and any generated milestone skill offers (created
  exactly once inside the transaction).
- A no-op `set` (target equals the authoritative current percent) is rejected 400
  `experience_unchanged` without bumping the version or writing an event.
- A closed grade gate thrown by the pure engine aborts atomically (state, turn,
  offers, and event all roll back) and surfaces as 400 `grade_blocked`.
- A stale CAS version or P2034 serialization conflict surfaces as 409.

The mutation runs under SERIALIZABLE isolation and, like every character mutation,
validates the authoritative current definition and race mode before invoking the
pure engine functions.

## Level-up undo (operation: `undo`)

`POST /api/characters/[id]/experience` with `{ operation: "undo", track, version }`
performs a **safe compensating reversal** of the most recent live level-up on the
selected track. It restores the initial-snapshot "before" state from the immutable
journal of the original `advance` event, without ever rewriting or deleting that
event. The `track` vocabulary and race-mode rule are identical to `set`/`levelUp`
(the race track requires an independent/monster race; a class/profession track
requires an enlightened race).

### What it does

- **Locates** the most recent LIVE `advance` event whose journal carries
  `leveledUp: true`. `import_history` events (backup-import markers) are excluded
  entirely - they are never authoritative for the undo.
- **Deterministic ordering** by `createdAt` then `id`. If the latest level-up
  timestamp is shared by multiple progression events, the undo rejects rather than
  guessing.
- **Restores** the selected track to the journal's `levelBefore` / restored
  quarter / `experiencePercent`. For a derived (enlightened) race that gained a
  race level with the level-up, the race level is restored to
  `raceLevelBefore` and verified against `deriveRaceLevel`. For an independent
  (monster) race, the race track is restored directly.
- **Removes only the current-state award suffix**: the class/profession award at
  `levelAfter`, and (when a derived race gain was recorded) the matching race award
  at `raceLevelAfter`, are removed from `historicalLevelAwards`. Priority awards
  from earlier levels and the immutable `advance` event are left untouched.
- **Cancels** the generated milestone skill offers (append-only `canceledAt`
  stamp, never delete) that the level-up created; a pending offer is canceled, and
  re-earning the level re-offers it as the next `generation` (see
  `docs/rules/skills.md`).
- **Appends** a `level_undo` progression event carrying `undone: true`,
  `leveledUp: false`, the original `advance` event id (`originalEventId`), the
  award/raceGain snapshots, the canceled offer ids, and the post-undo version.
- The character CAS version is incremented; `state.turn` is **never** decreased
  (the undo does not rewind turn advances). The response journal reflects the
  restored level/quarter/percent.

### When it rejects (409 `level_undo_blocked`, no writes)

The undo refuses, writing nothing, when the reversal is not safe:

- no live `advance`-with-`leveledUp` event exists (or only `import_history`
  events do);
- the selected track is not the one that actually leveled up;
- the current state no longer matches the level-up's "after" snapshot (the level,
  race level, or the quarter/percent moved off the boundary);
- a later non-cosmetic event (advance / experience_set / allocate / evolve /
  consume / skill / associate / inventory / profession_set / level_undo)
  supersedes the level-up (purely cosmetic metadata / backup-import events are
  ignored);
- the track grade/definition changed since the award, or the exact
  `historicalLevelAwards` suffix no longer matches the journal snapshot;
- a generated skill offer was already **selected** (the skill cannot be removed by
  undoing the level);
- restoring the awards would leave the character in a **free-point deficit**
  (points allocated from the now-removed awards exceed the remaining pool).

A stale CAS `version` is still a `409 version_conflict`; a P2034 serialization
conflict is still a `409 serialization_conflict`. The original `advance` event is
never deleted, rewritten, or retroactively adjusted - only the current state is
compensated.

## Legacy /advance quarter endpoint

`POST /api/characters/[id]/advance` remains for legacy callers and is unchanged in
semantics: it advances a quarter at a time through `advanceQuarter` /
`advanceRaceQuarter`. The engine always synchronizes the authoritative
`experiencePercent` to `quarter * 25` on the state it mutates, so a legacy caller
that advances by quarters keeps the explicit EXP percent consistent with the quarter
index. New `advance` events also carry `characterVersionAfter` (the committed
version) in their journal to support deterministic undo; older events that predate
the field remain readable and undoable by falling back to the event's preceding
version.
