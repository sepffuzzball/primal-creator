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

## Ring slot & physical position

`Ring` is a **single catalog slot**, but a character may wear up to two rings, one
in each physical position. The chosen position is a **per-link** value persisted on
the association (`CharacterAssociation.equipmentPosition`, `"Ring 1"` or
`"Ring 2"`), never on the catalog config: an `equipment` entry with `slot: "Ring"`
is one catalog item, and exactly one link per definition is still allowed (the
unique `(characterId, definitionId)` constraint is unchanged).

- Equipping a Ring-slot item **requires** an explicit `equipmentPosition` on a NEW
  add (`400 ring_position_required`); a remove never requires one, and a non-ring
  equipment add forbids it (`400 position_not_allowed`).
- Adding a different Ring item to an **occupied** position atomically replaces only
  that position's link, leaving the other position untouched; a same-definition
  duplicate is still rejected, and a remove ignores position entirely.
- The catalog/item view always shows the canonical `Ring` slot; the worn position
  is surfaced separately as `equipmentPosition`. The live status uses the persisted
  position (or a legacy config-derived fallback) as the effective slot only to keep
  two rings distinct in the synthesized equipment list - the engine never treats
  the position as a separate cap.
- Editing a linked Ring-slot item to a different equipment category (or vice versa)
  is rejected with `409 equipment_position_conflict` until the item is unequipped.
  A legacy `Ring 1`/`Ring 2` catalog slot -> canonical `Ring` is a same-category
  edit that preserves each link's position (and rejects a collision with another
  ring already occupying the same active position).
- **Trusted-backup import (v3/v4).** A legacy v3/v4 backup carries no per-link
  `equipmentPosition`; the importer derives one from the CURRENT catalog's legacy
  `Ring 1`/`Ring 2` slot. When the current catalog slot has already been migrated
  to the generic `Ring` (so the catalog row itself provides no position), the
  importer recovers the position from the backup's own `definition.config.slot`
  snapshot - a pre-migration catalog still named `Ring 1`/`Ring 2`. Never from the
  advisory `liveState`/`status`. If neither the current catalog row nor the backup
  snapshot yields a position (or the snapshot names a non-ring slot), the import is
  rejected with `400 import_ring_position_required`; a v5 backup always carries the
  explicit position and never trusts the snapshot.

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
- `percentBasisPoints?: PartialVector` - nonnegative-integer **percentage**
  attribute bonuses expressed in basis points (10000 = 100%). Like `bonus`, this
  is a live-declared effect: when present on an eligible item it contributes a
  percentage of the pre-equipment attribute value (after any capped flat
  equipment bonus) on top of the flat `bonus`. It is never written into
  `Character.state`, and an ineligible or archived item's percent is inert along
  with its flat `bonus`.
- `derivedFlat?: Partial<Record<"hp" | "mp" | "sp", number>>` - nonnegative-integer
  **flat** bonuses applied directly to the derived HP/MP/SP maxima. Unlike the
  attribute `bonus`, these do **NOT** consume the per-attribute aggregate or
  overall equipment cap budgets, never compound, and only sum across items.
  Absent on legacy entries; the engine treats a missing field as 0.
- `derivedPercentBasisPoints?: Partial<Record<"hp" | "mp" | "sp", number>>` -
  nonnegative-integer **percentage** bonuses (basis points, 10000 = 100%) applied
  to the derived HP/MP/SP maxima. They are summed across all items and applied
  once to the positive (base + flat) value, never compounded, and likewise do not
  share the attribute equipment cap budgets. Absent on legacy entries; contributes 0. Both derived fields are synthesized live from the current catalog config at
  read time and are gated on eligibility exactly like the attribute bonus (an
  ineligible or archived item keeps them inert).
- `rarity?: string` - one of the canonical rarity tiers
  (`Inferior`/`Common`/`Uncommon`/`Rare`/`Epic`/`Ancient`/`Legendary`/`Mythical`/
  `Sacred`/`Divine`, or the incomparable `Unique`). Required for a NEW or
  config-changing write; legacy entries lacking it remain readable and
  metadata-PATCHable.
- `soulbound?: boolean` - bound-to-character flag (metadata only; exposed in
  inventory/detail views).
- `minimumLevel?: number` - nonnegative integer minimum level on the track/race
  named by `requiredLevelType`. Setting this requires `requiredLevelType`
  (a level without a track/race type is a validation error).
- `requiredLevelType?: "class" | "profession" | "humanoidRace" | "monstrousRace"` -
  the eligibility axis. `class` / `profession` gate on the character's class /
  profession track level; `humanoidRace` / `monstrousRace` gate on the character's
  RACE level (never the total/class level) and additionally require the race
  catalog's `raceType` to be `enlightened` / `monster` respectively. The value alone
  (with no `minimumLevel`) means a TYPE restriction only: the track/race must exist
  and be of the requested type, but the level is not gated (treated as level 0).
- `minimumBlessingTier?: "Baptism" | "Minor" | "Lesser" | "Intermediate" | "Major" | "Greater" | "Divine" | "True"` -
  the lowest divine-patron blessing tier that satisfies the requirement. Setting
  this requires `requiredGodStableId` (a tier without a god is a validation error);
  when absent, a god requirement defaults to `Baptism` (the lowest tier).
- `requiredGodStableId?: string` - the catalog `stableId` of the god that must be
  the character's active divine patron. Must exist as an unarchived catalog god on
  a config-changing write (see "Write guard" below).
- `grantedSkillStableIds?: string[]` - optional list of catalog `stableId`s of
  `skills` definitions whose **current** `config.effects` are granted as passive
  effects **while the item is worn and eligible** (see "Equipment-granted passive
  skills" below). Each id must be nonempty and internally unique; an empty `[]` is
  allowed (the item grants no passive). On a NEW or config-changing write every id
  must resolve to an existing, unarchived `skills` entry; a missing or archived
  id is rejected with a 400 (`invalid_config`).
- `minRaceLevel?: number` - nonnegative integer minimum RACE level required to be
  eligible. **Legacy key**: still readable and enforced, but never authoritative on
  a NEW or config-changing write (the editor migrates it to the canonical
  `minimumLevel` / `requiredLevelType` pair).
- `requiredRaceType?: "enlightened" | "monster"` - the required race type; a
  missing value imposes no type restriction. **Legacy key**: still readable and
  enforced, but never authoritative on a NEW or config-changing write (migrated to
  `requiredLevelType`).

Slot normalization is comparison-only. `normalizeEquipmentSlot` maps documented
legacy aliases (`head`/`chest`/`cloak`/`bracers`/`gloves`/`boots`/`necklace`/
`ring1`/`ring2` and the spacing variants `ring 1`/`ring 2`) and case-insensitive
canonical values to a canonical slot purely for slot-collision / replacement /
import-integrity comparisons and for the modern-shape completeness guard. Legacy
`Ring 1`/`Ring 2` slot values normalize to the single canonical `Ring` slot for
category comparisons; the specific position is the per-link `equipmentPosition`,
never part of the canonical slot set. The original `config.slot` is never
rewritten.

## Eligibility & live bonus gating

### Requirement axes

An equipment config may carry a canonical requirement via `minimumLevel` /
`requiredLevelType`, and/or a divine-patron requirement via `requiredGodStableId` /
`minimumBlessingTier`. Each is resolved independently; an item is eligible only if
EVERY declared requirement is met. The legacy `minRaceLevel` /
`requiredRaceType` keys remain readable and enforced for an existing row (see
"Legacy backward compatibility" below).

- `class` / `profession`: the character must have the corresponding track
  (`state.tracks["class"]` / `state.tracks["profession"]`); `minimumLevel` is
  compared against that track's level. A missing track never qualifies (an
  `integrated` character always has a class track, but may have no profession
  track), so a profession requirement on a character with no profession track is
  unmet.
- `humanoidRace`: the character's authoritative race type must be `enlightened`
  (read from its race catalog config; an absent `raceType` defaults to
  `enlightened`) AND its RACE level, never the total/class level, must be at least
  `minimumLevel`. A missing/unknown race never qualifies.
- `monstrousRace`: the same, but the race type must be `monster`.
- `requiredGodStableId`: the character must have an active `BLESSING` association
  to an unarchived god whose catalog `stableId` equals the configured value. The
  bless link's `blessingTier` must be at or above `minimumBlessingTier` (default
  `Baptism` when absent; the ladder is Baptism < Minor < Lesser < Intermediate <
  Major < Greater < Divine < True). A missing bless link fails; a bless link to an
  archived god fails; a bless link to a different god fails. A missing/unknown
  `blessingTier` on the link fails whenever a god is required.

A `requiredLevelType` value alone (with no `minimumLevel`) is a TYPE restriction
only - the track/race must exist and be of the requested kind, but the level is not
gated (treated as level 0). The divine-patron requirement is separate: a god
requirement always has a level gate (the bless tier), independent of
`requiredLevelType`.

### Suppression, not detachment

A linked item whose requirement is currently unmet is still linked and shown - the
link, inventory stock and journal are untouched - but its bonus is NOT
synthesized into the live status until the character qualifies. This applies to
the flat `bonus`, the `percentBasisPoints` contribution, AND the derived
`derivedFlat` / `derivedPercentBasisPoints`: an ineligible item adds no bonus of
any kind (represented as an empty bonus / empty percent / zero derived) while it
stays equipped and visible. On ADD, an unmet requirement is rejected with a 400
(`equipment_requirements_unmet`); the stock-owned add that consumes inventory is
allowed only when the eligibility check passes (no partial mutation on denial).

The user-facing `reason` on `equipmentEligibility` identifies precisely which
requirement failed (e.g. a level below `minimumLevel`, a missing/incorrect track or
race type, a missing bless link, a bless tier below the required minimum, an
archived god), so a client can explain why a linked item contributes no bonus yet.

Import of a trusted backup does NOT reject an old equipped link merely because the
requirement is unmet; the live eligibility is recomputed at read time and
historical snapshots are left untouched.

### Legacy backward compatibility

An existing catalog row that still carries `minRaceLevel` / `requiredRaceType`
continues to be read and enforced. The legacy semantics are: `requiredRaceType`
maps `enlightened` to humanoid races and `monster` to monstrous races (as above),
and `minRaceLevel` is checked against the character's RACE level. These legacy keys
are never treated as authoritative on a NEW or config-changing write (see "Write
guard" below); a row that carries them is migrated by the editor to the canonical
pair before it is written again.

### Write guard

On a catalog **create** or a **config-changing update** (and on a reviewed-manifest
import), an equipment config that carries the legacy `minRaceLevel` /
`requiredRaceType` keys is rejected with a 400 (`invalid_config`) - the editor is
expected to have migrated such a config to the canonical `minimumLevel` /
`requiredLevelType` pair, so persisting the legacy keys is never allowed. A
metadata-only PATCH (no requirement change) on an existing row keeps whatever is
already stored. A config-changing write must also resolve any `requiredGodStableId`
to a god that exists and is unarchived (400 `invalid_config` if not); renaming a god
catalog row's `stableId` to a value still referenced by an existing equipment config
is blocked so the patron reference cannot silently dangle. Archiving a god is
allowed; it merely renders the referencing item ineligible (it stays linked with
its bonus suppressed), never blocking the archive or forcing an unequip.

The inventory and detail views expose minimal equipment metadata (rarity /
soulbound / declared requirements) and a live `equipmentEligibility`
(`{ eligible, reason? }`) so a client can show why a linked item contributes no
bonus yet.

Equipment bonuses (both the flat `bonus` and the `percentBasisPoints` contribution,
plus any `derivedFlat` / `derivedPercentBasisPoints`) are synthesized live from the
**current, unarchived** catalog config at read time and never written into
`Character.state`, so editing an item's config recalculates status without
rewriting history. The caps (20% per-attribute aggregate / 15% overall) are house
assumptions documented in `docs/rules/assumptions.md`.

## Equipment-granted passive skills

An `equipment` config may declare `grantedSkillStableIds`: an array of `skills`
catalog `stableId`s whose passive effects the item grants **while it is worn and
eligible**. This is **not** a permanent association: no `CharacterAssociation`
SKILL link is created, no milestone skill offer is produced, and removing the item
(or losing eligibility) immediately stops the granted passives.

- Each granted id resolves to a `skills` catalog definition; the CURRENT
  `config.effects` of that skill are synthesized live at read time (same flat /
  percent synthesis as a linked SKILL association), sourced to `"<item> (<skill>)"`
  and never written into `Character.state`. Catalog skill stacking groups and
  conditions are preserved verbatim; no stat is ever inferred from a skill's name,
  and the skill's config name is used only when the catalog row actually exists.
- The granted passives are gated on the SAME `eligible` boolean as the item's
  attribute bonus. An ineligible, inventory-only, or removed item contributes no
  granted passive. Archiving a skill after it is equipped renders that granted
  passive inert (only unarchived skills resolve); archiving the item does likewise.
- **No double counting.** A granted skill is applied once, even if it appears in
  multiple equipment items' `grantedSkillStableIds` and/or is already linked as a
  `CharacterAssociation` SKILL association: an existing linked SKILL association
  takes priority, otherwise the first equipped item (association order) wins.
- While a NEW or config-changing write must resolve every granted id to an
  existing, unarchived skill (400 `invalid_config` otherwise), a trusted-backup
  import of an old equipped link may reference a skill that no longer exists; the
  unresolved grant is simply skipped at read time, never invented.

## Equipment percentage bonus & shared caps

An eligible item may declare a `percentBasisPoints` vector alongside its flat
`bonus`. The engine applies it **after** the capped flat equipment bonus and
**before** temporary effects, so it never compounds onto another item's percent
and never runs before the flat equipment caps have clamped the base.

- The percent request for an attribute is
  `floor((preEquipment[attr] + appliedFlat[attr]) * basisPoints / 10000)`, clamped
  to at least 0 when the base is negative. Here `preEquipment[attr]` is the value
  immediately before any equipment bonus (the same reference used to cap flat
  bonuses), and `appliedFlat[attr]` is the **capped** flat bonus that was already
  applied.
- Percent requests share the **same individual and combined equipment budgets**
  as flat bonuses. For each attribute, the remaining individual budget is
  `max(0, floor(preEquipment[attr] * individualCapPercent / 100) - flatApplied[attr])`,
  and the remaining overall budget is
  `max(0, floor(sum(preEquipment) * combinedCapPercent / 100) - sum(flatApplied))`.
  Percent requests across multiple items are capped with the same deterministic
  largest-remainder tie ordering used for flat bonuses, so the outcome is stable
  and never depends on attribute iteration order.
- An item that is ineligible or archived contributes **neither** a flat bonus nor a
  percent request; both are inert and nothing is reserved from the shared budgets.
- The combined status (`requested` / `applied` / `suppressed`) for an item or the
  equipment aggregate includes both the flat and the percent contribution. The
  `capUsage` reasons explicitly distinguish an **equipment-percent** cap (names
  `equipment-percent-individual` / `equipment-percent-overall`) from the flat
  equipment caps, while the flat cap reason strings are preserved verbatim.
- The live status trace exposes the percent contribution in its own
  `equipment-percent` phase, emitted **only** for an attribute whose percent
  request is nonzero. Consequently, equipment with no percent bonus (or no
  eligible percent) produces status output identical to the legacy zero-percent
  form: no `equipment-percent` phase at all, and no shape change for existing
  imports. This phase is skipped entirely in the generic pre-equipment phase
  (percentage effects are equipment-only).

No equipment is silently auto-granted; only items a user explicitly equips produce
bonuses.

## Derived HP/MP/SP bonuses

While the attribute `bonus` (flat and percent) is clamped by the 20%/15% equipment
budgets, an item may separately grant bonuses to the derived HP/MP/SP maxima via
`derivedFlat` and `derivedPercentBasisPoints`. These are computed by the engine
independently of the attribute equipment caps, never compound across items (the
percent is summed across all items and applied once to the positive base + flat
value), and never reduce an attribute's requested/applied equipment contribution.
Consequently a derived bonus cannot be suppressed by the 20% individual or 15%
overall attribute budgets - the attribute cap path is left entirely untouched.

Both derived fields are gated on eligibility exactly like the attribute bonus: an
ineligible or archived item keeps them inert (contributing nothing to the
HP/MP/SP maxima). They are synthesized live from the current, unarchived catalog
config at read time and are never written into `Character.state`; they are
mirrored in the state equipment schema (`derivedFlat` / `derivedPercentBasisPoints`
over `hp` / `mp` / `sp`) so a serialized or trusted-backup state that already
carries them round-trips intact, and a legacy state without them still parses
(contributing 0).
