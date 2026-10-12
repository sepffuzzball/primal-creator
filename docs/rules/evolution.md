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
