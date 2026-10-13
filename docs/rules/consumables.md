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

## Two distinct consumable roles

The engine models consumables in exactly two ways, and the grade rates must not
be conflated between them:

1. **Permanent external stat gains.** A consumable can grant a **permanent**
   external attribute gain that is keyed to the character's race level. The grade
   rates (F3 / E5 / D15 / C45) are **per-level** caps on such permanent gains:
   the total permanent consumable capacity for an attribute is the sum of the
   per-level rate across every race level attained. This capacity is enforced at
   application time; once a gain is recorded in the permanent ledger it is a
   historical fact and is never re-capped by later config changes.

2. **Temporary potion effects.** A consumed potion can also produce a
   **temporary** effect that lasts only its effect duration. Temporary effects are
   bounded by their duration, **not** by the F3 / E5 / D15 / C45 grade rates.

## Inventory ownership (backend notes)

Consumables share the same per-definition owner-managed inventory quantity as
equipment (`CharacterInventoryItem.quantity`, bounded 1..999999). This is **house
bookkeeping**, not canon, and there is no item-instance or cap model. Consuming
requires the character to own at least one unit: `consumeCharacter` checks the
owned quantity and decrements/removes exactly one inside the SAME transaction as
the permanent/temporary effect validation, the character version CAS, and the
event journal. A failed cap, a missing duration, or a stale version rolls back
the stock change, the state and the journal together. The consume event records
the owned stock before and after (`stockPrior` / `stockAfter`).

- Manual acquisition is the only acquisition path in this stage (no crafted-drop
  or economy is invented). `POST /api/characters/[id]/inventory` with
  `operation: add | remove`, `quantity` 1..999999, a mandatory `sourceNote`
  (nonempty, <= 500 chars), and the CAS `version`. An `add` only accepts active
  (unarchived) consumable catalog entries; a `remove` is permitted for archived
  entries (owned stock may still be spent). The write runs under SERIALIZABLE
  isolation, CASes the character version, and appends an `inventory_adjust`
  journal event recording the prior/new quantity, the definition snapshot, the
  source note, and the acting user id. A P2034 (cannot serialize) or a stale
  version is a 409 that rolls back the change.
- Removing the final unit (quantity to 0) deletes the row - an absent row means
  zero owned stock (the DB CHECK constraint forbids quantity 0). Adding beyond
  999999 is rejected (`inventory_cap_exceeded`); removing beyond owned stock is
  rejected (`inventory_insufficient`).
- Inventory quantity alone never changes a character's live status; only the
  applied permanent/temporary effect does.

## Wiki-uncertain

- No source table gives **healing/restoration magnitudes by grade** or any
  published "tier of potion" the way skills have rarity tiers.
- No drop/craft rate is published. We deliberately do **not** invent per-grade
  restore values.

## House assumptions (configurable, pending citation)

The following are **requested default assumptions**, not canon. They run as
**HOUSE until a source citation is found** and are pending verification:

- **Consumable grade rates: F3, E5, D15, C45** - i.e. the base per-level rate/weight
  mapped to each grade band (F-grade: 3, E-grade: 5, D-grade: 15, C-grade: 45),
  applied cumulatively to **permanent** external stat gains per race level. These
  are HOUSE values pending verification; they are not asserted as canon without a
  source citation.
- **G-grade and unknown grades: rate 0** by default (`consumable.rates.G` unset). A
  born-F race counts levels 1..9 at the F rate (3) rather than the G rate, because
  the overlapping G/F bands are resolved by provenance, not by formula. Because an
  unknown grade has rate 0, the cumulative permanent-consumable capacity is 0 for a
  character whose race levels fall only in unknown/unconfigured bands - so a
  **positive permanent gain is rejected against zero capacity** (rather than
  inventing a multiplier).

These are configurable and documented in `docs/rules/assumptions.md`. The engine
should expose them as parameters rather than hard-coded constants, and should not
assert them as canon without a source citation.
