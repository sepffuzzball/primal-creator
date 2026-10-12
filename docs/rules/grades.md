# Grades

## Source & status

- Primary source: `https://the-primal-hunter.fandom.com/wiki/Race_Level`
  (retrieved via the MediaWiki API on 2026-10-12).
- Supporting: `https://the-primal-hunter.fandom.com/wiki/Grades`,
  `https://the-primal-hunter.fandom.com/wiki/E-grade`, and
  `https://the-primal-hunter.fandom.com/wiki/Characters`.

## Verified

A grade is a band of levels on the grade ladder. The grade table below is taken
verbatim from the `Race Level` page (the only source we could retrieve in full):

| Grade | Levels | Notes |
| --- | --- | --- |
| G-grade | 0-9 | Applies only to newly integrated races |
| F-grade | 0-24 | First grade for all born into the system |
| E-grade | 25-99 | |
| D-grade | 100-199 | |
| C-grade | 200-349 | Evolving to C-grade requires a quest for most races |
| B-grade | 350-499 | |
| A-grade | 500-749 | |
| S-grade | 750-999 | The last rank before godhood for mortals |

Verified behaviors from the same page:

- **Newly integrated races** start at G-grade and automatically advance to F-grade
  at **level 10**. Anyone born into the system is automatically **F-grade** at
  birth.
- Reaching grades **above D** requires an **evolution quest** unless the being
  belongs to a higher-level race that reaches full maturity above that grade
  (e.g. High Elves advance to C-grade without a quest but need one for B-grade).
- **Beyond S-grade**, races enter the **divine grades** and become immortal.

## Sub-stages (early / mid / late / peak)

The [Grades](https://the-primal-hunter.fandom.com/wiki/Grades) page states that
grades range and that each tier is broken down into four stages:
**early, mid, late, and peak**. The
[E-grade](https://the-primal-hunter.fandom.com/wiki/E-grade) page gives concrete
boundaries for one grade only:

- Early E-grade: levels 25-50
- Mid E-grade: levels 50-75
- Late E-grade: levels 75-95
- Peak E-grade: levels 95-99

This confirms the four-stage model exists, but only the E-grade boundaries are
published. The boundaries for other grades are **wiki-uncertain** (inferred by
analogy, not confirmed per grade).

## Divine grades (above S)

From [Characters](https://the-primal-hunter.fandom.com/wiki/Characters): gods also
have a form of grades, the **Divine Grades**. The 4th layer of divinity is where
one becomes an intermediate God, and above peak gods are Godkings/Godqueens at the
10th layer of divinity. Ranks exist above Godkings/Godqueens (Primordials), but
their level is unknown. `Race_Level` notes that concerning the immortal grades
"we know little."

## Wiki-uncertain

- The exact sub-stage boundaries are published only for E-grade.
- The precise level at which a character becomes "divine" is not given; only that
  it is beyond S-grade (S is "the last rank before godhood for mortals").
- The G/F overlap (G covers 0-9, F covers 0-24) is intentional: G applies only to
  newly integrated races, F applies to anyone born into the system. It is not a
  contradiction, but it requires interpretation for an engine (see below).

## House assumption / engine note

The grade/level bands are used as-is from the source. To keep the engine
deterministic, the transition is modeled as data, not as a derived formula:
- A newly integrated participant is assigned **G-grade** at integration, then
  auto-advances to **F-grade at level 10** (source-verified).
- For a participant born into the system, the starting grade is **F-grade**.

We do not invent an XP curve to reach these bands; the bands are treated purely as
level ranges. See `docs/architecture/calculation-engine.md` and
`docs/rules/assumptions.md`.
