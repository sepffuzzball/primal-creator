# Races

## Source & status

- Source: `https://the-primal-hunter.fandom.com/wiki/Race_Level`,
  `https://the-primal-hunter.fandom.com/wiki/Races`,
  `https://the-primal-hunter.fandom.com/wiki/Human`,
  `https://the-primal-hunter.fandom.com/wiki/Jake_Thayne/Race`.
- The race-level **formula** is verified; the **rounding** and **single-track**
  behavior (a race with no class or no profession) are **wiki-uncertain** and are
  the subject of an explicit house assumption.

## Verified

- Race is a progression track tied to level. For monsters and beasts, race level is
  simply their level. For **enlightened races** that can possess both a class and a
  profession, the displayed race level is the **average of the class and
  profession levels** (`Race_Level`).
- Humans inherently can possess **both** a class and a profession (unlike most
  races, which may have only one or neither) (`Human`).
- Newly integrated races begin at G-grade and advance to F-grade at level 10; born
  -into-system beings start at F-grade (`Race_Level`). In the engine a born race
  starts at its selected race's `naturalGrade` (legacy fallback `F`), so the
  sourced F-grade-at-birth applies to a race whose natural grade is F (e.g.
  Human); see "Race type" below.

## Known races

The `Races` page lists (verified as a list, individual details vary):
Automaton, Beastkin, Demon, Dragonkin, Dryad, Dwarves, Elf, Gillkin, Harpy, Human,
Ifrit, Nahoom, Neurotar, Malefic Dragonkin, Ogre, Risen, Risen Human, Scalekin,
Starborne, Vampire. The page also groups known races by grade (C-grade/D-grade/
E-grade) and lists tutorial races.

## Race evolution

Races evolve between grades. Reaching grades above D usually requires an evolution
quest; higher-born races may skip a quest for a grade at which they are already
mature (e.g. High Elves advance to C-grade without a quest) (`Race_Level`,
`Evolution`). See `docs/rules/evolution.md`.

## Human specifics (verified examples)

- Human stat lines follow the "balanced/most numerous race" theme:
  G: +1 all / +1 free; F: +1 all / +5 free; E: +2 all / +5 free; D: +6 all / +15
  free; C: +18 all / +45 free; B: +54 all / +135 free (`Human`,
  `Jake_Thayne/Race`).
- At C-grade, humans may pick a **Path** (e.g. Path of the Gatherer, of the
  Warrior, of the Slayer, of the Hunter); each permanently increases a set of stats
  by 10% and can grant a Unique skill (wiki-uncertain whether all Paths are
  enumerated; several appear on `Human`).

## Wiki-uncertain

- **Rounding** of the race-level average (floor vs. nearest vs. ceiling) is not
  stated.
- **Missing track:** what the race level is when a race has a class but no
  profession (or vice versa) is not stated. The formula "average of class and
  profession" assumes both are present.

## House assumption

For the engine, we choose:

- **Round down (floor)** when averaging class and profession levels.
- Treat a **missing profession as level 0** (and, symmetrically, a missing class as
  level 0) when computing the race-level average.

These are explicit project choices, documented in `docs/rules/assumptions.md`,
pending a source citation. They are configurable.

## Race type (enlightened vs monster)

A race catalog entry's config carries an authoritative `raceType`:

- `enlightened` - the race is a class/profession-bearing people. It always selects
  an **exact class** at creation (`classId` is required) and may optionally select a
  profession. Its class/profession tracks are stamped with the race's `naturalGrade`
  (legacy fallback `F`) and the selected class row must be at that natural grade with
  a per-level config for it - no lower-grade fallback is permitted.
- `monster` - the race is race-only. It has **no class and no profession** (`classId`
  and `professionId` are always null). It advances on an **independent** race mode
  using a four-quarter cadence (see `advanceRaceQuarter`), and its race level comes
  purely from that race track. Its starting grade is its `naturalGrade`.

`raceType` and `naturalGrade` are both required on NEW race definitions and on any
config-changing edit. A legacy race config that omits `raceType` is interpreted as
`enlightened` (non-authoritative, preserved for existing backups and UI); a legacy
config that omits `naturalGrade` falls back to `F` for the class/profession stamp and
skips the exact-natural-grade eligibility check (enlightened). On a config-changing
edit of an ALREADY-TYPED race, either field may be omitted only when the existing row
already declares a valid value for it - that value is preserved rather than erased, so
a typed race never silently falls back to `F`. A legacy race that never declared
either field must supply BOTH on a config-changing edit (there is nothing to
preserve). An arbitrary grade string is rejected as an invalid `naturalGrade` on a
NEW or config-changing write.

For every race the engine requires a `raceDefinitions[<startingGrade>]` entry before
the character can be created (integrated starts at `G`; a monster or born race
starts at `naturalGrade`).

Trusted-backup import enforces the same split: a monster backup must carry a null
class identity, no profession, and no class/profession tracks in its state; an
enlightened backup must carry the class track (and a profession track iff it declares
a profession). See `docs/rules/leveling.md` for the four-quarter race advance and
`docs/rules/evolution.md` for race evolution.

## Seeded Human race (`db:seed`)

`pnpm db:seed` seeds the Human race table (`races/human`) from
`https://the-primal-hunter.fandom.com/wiki/Jake_Thayne/Race` (fan wiki, a
secondary source). The G-grade line is now
sourced as +1 all / +1 free, so G is no longer a house-zero placeholder. Because
these values are fan-wiki-inferred rather than verified canon, the sourced grade
list is recorded as `inferredGrades` (`["G","F","E","D","C","B"]`) and
`houseGrades` is empty. The engine's calculations use `config.raceDefinitions`
only - neither the grade-list key nor the house list affects the numbers. The
legacy 0.0.2 baseline keeps its own `verifiedGrades`/`houseGrades` so the seed
can detect an untouched 0.0.2 row and only then update it; an admin-modified row
is preserved and a repeated seed is idempotent. The seed also creates the fifteen
god names (metadata-only, empty config) referenced by the catalog's `gods` kind.
