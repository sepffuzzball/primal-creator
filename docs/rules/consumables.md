# Consumables

## Source & status

- No standalone `Consumables` page exists on The Primal Hunter Wiki (verified via
  the MediaWiki API: `action=query&list=search&srsearch=consumable potion` returns
  only `Skills`).
- Consumables/potions are covered indirectly by:
  `https://the-primal-hunter.fandom.com/wiki/Profession`,
  `https://the-primal-hunter.fandom.com/wiki/Skills`, and
  `https://the-primal-hunter.fandom.com/wiki/Timeline`.
- The **grade-based rates** are **house assumptions** (not canon).

## Verified context (not a graded table)

- **Alchemy** is a crafting profession. The verified crafting archetypes include
  **Alchemist**, and the Alchemist profession starts with skills such as
  Herbology, Brew Potion, and Concoct Poison (`Profession`, `Skills`).
- Alchemy produces potions and poisons. The story prominently features
  health/mana potions and named poisons (e.g. a "Humansbane Poison" and
  "Dragonsbane Poison", and time spent "grinding potions" and "brewing Dragonsbane
  Poison") (`Timeline`).
- Potions/consumable items carry **rarity tiers** consistent with skills (the
  alchemy skills themselves have rarities, e.g. Brew Potion (Uncommon), Concoct
  Poison (Epic), Malefic Viper's Poison (Rare)). The exact rarity of a produced
  item is story-dependent and not captured in a table.

## Wiki-uncertain

- No source table gives **healing/restoration magnitudes by grade** or any
  published "tier of potion" the way skills have rarity tiers.
- No drop/craft rate is published. We deliberately do **not** invent per-grade
  restore values.

## House assumptions (configurable, pending citation)

The following are **requested default assumptions**, not canon:

- **Consumable grade rates: F3, E5, D15, C45** - i.e. the base rate/weight mapped
  to each grade band (F-grade: 3, E-grade: 5, D-grade: 15, C-grade: 45).

These are configurable and documented in `docs/rules/assumptions.md`. The engine
should expose them as parameters rather than hard-coded constants, and should not
assert them as canon without a source citation.
