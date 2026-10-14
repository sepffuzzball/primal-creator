# Project Assumptions

This document collects every **explicit house choice** the project makes where
the source is silent or ambiguous. None of these are canon; they are configurable
project assumptions pending a source citation. Being explicit here is what keeps
the rest of the docs honest: verified facts are in the topic docs, and everything
else lives here.

## Convention

- Assumptions are intended to be **configurable**.
- Each assumption has a proposed key name (a dotted namespace) and a default value.
- Nothing here may be presented as canon in the UI or in documentation prose
  without a source citation.

## Admin-editable house rules

The defaults in sections 1 (equipment) and 2 (consumables) are NOT hard-coded. They
are served from a single server-wide `house_rules` row (`id = 'active'`, created and
seeded by migration `0007_house_rules`, never by the seed script) and edited by an
admin from the Settings page (`GET`/`PATCH /api/admin/rules`). The app-facing config
keys are `equipmentIndividualCapPercent`, `equipmentCombinedCapPercent` and
`consumableGradeRates.{F,E,D,C}`.

An admin edit takes effect on the NEXT read or mutation - live status is always
re-derived from the current validated config, and helpers never issue their own
hidden lookup. It never rewrites historically awarded stats or the persisted
`Character.state`; a recorded permanent-consumable gain is never re-capped. The
current house-rules version is surfaced as `rulesetVersion` on character reads when
the row exists.

## 1. Equipment grade rates

The source has no `Equipment` page and publishes no drop/quality distribution (see
`docs/rules/equipment.md`). Requested defaults, treated as placeholders:

- **Key:** `equipment.rate.individual` - **Default: 0.20** (20%)
- **Key:** `equipment.rate.combined` - **Default: 0.15** (15%)

In the app config these correspond to the admin-editable
`equipmentIndividualCapPercent` (20) and `equipmentCombinedCapPercent` (15) house
rules (see "Admin-editable house rules" above).

Meaning: the probability that an individual piece of equipment is treated as
belonging to a given grade band is 20%; when equipment is combined/rolled together
the rate is 15%.

## 2. Consumable grade rates

No `Consumables` page; no published drop/craft rates (see
`docs/rules/consumables.md`). Requested defaults, treated as placeholders:

- **Key:** `consumable.rates.F` - **Default: 3**
- **Key:** `consumable.rates.E` - **Default: 5**
- **Key:** `consumable.rates.D` - **Default: 15**
- **Key:** `consumable.rates.C` - **Default: 45**

These four rates are admin-editable server-wide defaults; in the app config they
are `consumableGradeRates.F` / `.E` / `.D` / `.C` (see "Admin-editable house rules"
above).

Meaning: a base per-level rate/weight mapped to each grade band (F, E, D, C),
applied **cumulatively to permanent external stat gains per race level**. A
character's permanent consumable capacity for an attribute is the sum of the
per-level rate across every race level attained through those bands. Temporary
potion effects are **not** capped by these rates - they use only their effect
duration.

- **G-grade and unknown grades: rate 0** by default (`consumable.rates.G` unset).
  A **born** race counts levels 1..9 at the **F rate** when its natural grade is F
  (e.g. Human) because it enters the system at that grade; an **integrated** race
  counts levels 1..9 at the **G rate** (0 unless configured). The overlapping G/F
  bands are resolved by origin, so we do not invent a canonical G multiplier;
  the F band applies only to a race whose `naturalGrade` is F, not universally.

## 3. Race-level rounding and missing track

The source confirms the **race level for an enlightened race is the average of the
class and profession levels** (`Race_Level`) but does not state rounding, nor what
to do when a race has only one track. Choices:

- **Key:** `race.rounding` - **Default: `floor`** (values are rounded down).
- **Key:** `race.missingTrack` - **Default: `0`** (a missing class or profession is
  treated as level 0 when averaging).

## 4. Cap distribution

Class and profession per-level cap numbers (e.g. E-grade class 28/34, D-grade
100/84; profession E-grade 22/27, D-grade 80/66, C-grade 240) are sourced for some
grades, but how a cap is **distributed across attributes** when the sum exceeds the
allowed maximum is not stated. House choice:

- **Key:** `caps.distribution` - **Default: `proportional`** (a grade cap is
  distributed across the stat bonuses proportionally to their source values, so the
  total never exceeds the cap).

The engine implements every proportional cap distribution with a
**deterministic largest-remainder apportionment** (ties broken by canonical
attribute / equipment order). It never silently exceeds a cap; the suppressed
portion is always reported in the trace.

### Equipment caps are aggregate / overall, not per-item

- **Individual = per-attribute aggregate (20%).** The SUM of all equipment bonuses
  applied to a single attribute may not exceed 20% of that attribute's
  pre-equipment value. This is **not** a per-item cap - an individual piece may
  contribute more than 20% as long as the attribute's aggregate stays within
  bounds.
- **Combined = overall sum (15%).** The SUM of all effective equipment bonuses
  across every attribute may not exceed 15% of the SUM of all pre-equipment
  attribute values. This is **not** a per-attribute cap - it applies to the total
  across all attributes.
- When the overall cap binds, the excess is distributed **across attributes and
  items** with the same deterministic proportional largest-remainder rule.

Neither cap is a per-item cap. See `docs/architecture/calculation-engine.md`.

## 5. Derived resource multipliers

The source never states how hit points, mana, stamina, or similar derived pools are
computed from attributes (see `docs/rules/attributes.md`). These are left
**unresolved**; we deliberately avoid inventing defaults. They should be exposed as
empty/placeholder config, not as hard-coded constants:

- **Keys (placeholders):** `derived.hpMultiplier`, `derived.manaMultiplier`,
  `derived.staminaMultiplier`. **Default: none** (unset unless a value is later
  cite-sourced).

## 6. Skill milestones

Skills are offered as choices at milestones and are **not** automatically awarded
(see `docs/rules/skills.md`). House choice:

- **Key:** `skills.awardMode` - **Default: `milestone`** (offered at defined
  milestones; participant chooses).

## 7. Transcendent trigger

The threshold for the system to offer transcendence is described only as "some
invisible threshold" (see `docs/rules/transcendents.md`). House choice:

- **Key:** `transcendent.mode` - **Default: `flag`** (treated as a configurable
  boolean/quality, not derived).

## 8. Evolution gating

Evolution blocks further experience gains until completed, and a multi-track
participant may defer one track (see `docs/rules/evolution.md`). House choice:

- **Key:** `evolution.blockExpWhilePending` - **Default: `true`** (matches source).
- **Key:** `evolution.allowDeferTrack` - **Default: `true`** (matches source).

## What is NOT assumed (kept unresolved on purpose)

- The XP curve per level.
- The per-grade sub-stage boundaries for grades other than E.
- Per-level stat caps for grades other than E/D (class) and E/D/C (profession).
- The numeric magnitude of blessing levels.
- Bloodline numeric gradients other than the Primal Hunter example.
- Derived resource pools.

These are recorded as "wiki-uncertain" in their respective rule docs. Do not fill
them with invented numbers; prefer configurable placeholders.
