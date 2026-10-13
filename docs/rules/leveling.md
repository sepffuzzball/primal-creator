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
