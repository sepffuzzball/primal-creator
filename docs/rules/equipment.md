# Equipment

## Source & status

- No standalone `Equipment` page exists on The Primal Hunter Wiki (verified via
  the MediaWiki API: `action=parse&page=Equipment` returns `missingtitle`).
- Equipment data lives on `https://the-primal-hunter.fandom.com/wiki/Jake_Thayne/Equipment`
  (page id 407, fetched via API on 2026-10-12).
- The **rarity tier** scale is verified from that page. The **grade-based drop/
  quality percentages** are **house assumptions** (not quoted by any source).

## Verified (from `Jake Thayne/Equipment`)

- Equipment is tabulated by **slot** (e.g. Head, plus weapon slots) with name,
  rarity, and description.
- Equipment uses the same **rarity tiers** as skills, including at least:
  Inferior, Common, Uncommon, Rare, Epic, Ancient, Legendary, Mythical, Unique.
  Example entries: "Mask of the Golden Forest King (Unique)", "Venomfang (Rare)",
  "Windsorrow Bow (Rare)".
- Entries carry a **numeric tier/value** (e.g. 18, 63, 97, 188, 193, 196, 280).
  The meaning is not explicitly titled on the page; treat as item quality/level
  value (wiki-uncertain).
- Entries reference **level requirements** such as "Lvl 45+ in any humanoid race",
  and **grade-tagged materials** such as "a cloak born using a B-grade Chimera",
  "tempered leather from a powerful E-grade beast", and "for anyone below C-grade".

## Wiki-uncertain

- The exact meaning of the numeric column (value vs. level vs. quality).
- Whether equipment rarity/effect scales by grade in a quantifiable way, and the
  actual **probability distribution** of dropping a given rarity/grade.
- The general list of equipment slots (the page is Jake-specific).

## House assumptions (configurable, pending citation)

The following are **requested default assumptions**, not canon:

- **Individual equipment grade rate: 20%** - the probability an individual piece
  of equipment is treated as belonging to a given grade band.
- **Combined equipment rate: 15%** - the probability used when combining/rolling
  multiple pieces together.

Both are configurable and documented in `docs/rules/assumptions.md`. The engine
should treat these as parameters, not as sourced constants, and should not assert
them as canon without a source citation.

## Character attachment (catalog config)

Equipment is attached to a saved character via a `CharacterAssociation` link
(`kind = EQUIPMENT`), referencing a catalog `equipment` entry. This is **direct
equip** onto the character. The referenced definition is never deleted while a
link points to it (`ON DELETE RESTRICT`).

## Inventory ownership (backend notes)

Equipment is now backed by an owner-managed inventory quantity rather than item
instances. This is **house bookkeeping**, not canon: ownership is expressed only
as a per-definition integer count (`CharacterInventoryItem.quantity`, bounded
1..999999). There is no item-instance uniqueness, no stored slot on an inventory
row, and no capacity/stacking model. A link is still direct-equip (see above);
the inventory quantity is the recorded number owned.

- Every `CharacterAssociation` link carries `legacyUnowned`. Preexisting
  EQUIPMENT links (created before ownership existed) are backfilled to
  `legacyUnowned = true` and may remain equipped and removable even with zero
  owned stock. A newly created equipment link requires owned stock and is never
  grandfathered (`legacyUnowned = false`).
- Adding an equipment link requires the character to own at least one unit
  (`quantity >= 1`) of that definition inside the association transaction;
  otherwise the add 400s (`inventory_insufficient`). Replacing the same slot
  unlinks the old link but does not destroy its recorded stock.
- A removal cannot discard the final owned unit while the item is still equipped:
  dropping stock to zero with an EQUIPMENT link present 409s
  (`inventory_equipped`) and leaves the row/link untouched (no auto-unequip).
  This applies to any EQUIPMENT link with owned stock (grandfathered or not,
  including an archived linked definition); a grandfathered link already at zero
  stock has no inventory row, so it never blocks a removal. Removing down to at
  least one unit is always allowed.
- Manual acquisition/spending is `POST /api/characters/[id]/inventory` with
  `operation: add | remove` (see docs/rules/consumables.md for the shared
  inventory journal semantics). No acquisition/crafting economy is invented here;
  the journal records only the prior/new quantity and the user-supplied note.

The `config` for an `equipment` catalog entry carries the existing fields (which
are preserved) plus the new authoritative metadata:

- `slot: string` - the equipment slot (e.g. Head, weapon slot). Equipping an item
  replaces whatever currently occupies the same slot; the journal records the old
  and new items. This is preserved verbatim on write (no synonym coercion).
- `bonus?: PartialVector` - nonnegative-integer attribute bonuses. With `slot`
  absent, an entry contributes nothing.
- `rarity?: string` - one of the canonical rarity tiers
  (`Inferior`/`Common`/`Uncommon`/`Rare`/`Epic`/`Ancient`/`Legendary`/`Mythical`/
  `Sacred`/`Divine`, or the incomparable `Unique`). Required for a NEW or
  config-changing write; legacy entries lacking it remain readable and
  metadata-PATCHable.
- `soulbound?: boolean` - bound-to-character flag (metadata only; exposed in
  inventory/detail views).
- `minRaceLevel?: number` - nonnegative integer minimum RACE level required to be
  eligible (metadata only).
- `requiredRaceType?: "enlightened" | "monster"` - the required race type; a
  missing value imposes no type restriction.

Slot normalization is comparison-only. `normalizeEquipmentSlot` maps documented
legacy aliases (`head`/`chest`/`cloak`/`bracers`/`gloves`/`boots`/`necklace`/
`ring1`/`ring2`) and case-insensitive canonical values to a canonical slot purely
for slot-collision / replacement / import-integrity comparisons and for the
modern-shape completeness guard. The original `config.slot` is never rewritten.

## Eligibility & live bonus gating

An equipment config with a `requiredRaceType` maps `enlightened` to humanoid
races and `monster` to monstrous races (a character's authoritative type is read
from its race catalog config; an absent `raceType` defaults to `enlightened`).
`minRaceLevel` is checked against the character's RACE level, never the
total/class level.

A linked item whose requirement is currently unmet is still linked and shown - the
link, inventory stock and journal are untouched - but its bonus is NOT
synthesized into the live status until the character qualifies. An ineligible
item therefore adds no bonus (represented as an empty bonus) while it stays
equipped and visible. On ADD, an unmet requirement is rejected with a 400
(`equipment_requirements_unmet`); the stock-owned add that consumes inventory is
allowed only when the eligibility check passes (no partial mutation on denial).

Import of a trusted backup does NOT reject an old equipped link merely because the
requirement is unmet; the live eligibility is recomputed at read time and
historical snapshots are left untouched.

The inventory and detail views expose minimal equipment metadata (rarity /
soulbound / declared requirements) and a live `equipmentEligibility`
(`{ eligible, reason? }`) so a client can show why a linked item contributes no
bonus yet.

Equipment bonuses are synthesized live from the **current, unarchived** catalog
config at read time and never written into `Character.state`, so editing an item's
config recalculates status without rewriting history. The caps (20% per-attribute
aggregate / 15% overall) are house assumptions documented in
`docs/rules/assumptions.md`.

No equipment is silently auto-granted; only items a user explicitly equips produce
bonuses.
