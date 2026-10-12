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
  -into-system beings start at F-grade (`Race_Level`).

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
