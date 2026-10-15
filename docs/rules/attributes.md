# Attributes

## Source & status

- Source: `https://the-primal-hunter.fandom.com/wiki/Classes`,
  `https://the-primal-hunter.fandom.com/wiki/Profession`,
  `https://the-primal-hunter.fandom.com/wiki/Human`,
  `https://the-primal-hunter.fandom.com/wiki/Jake_Thayne/Race`.
- The wiki shows per-level stat bonuses but never publishes a formal attribute
  table, so the list of attribute names is **inferred** (wiki-uncertain).

## Verified

- Attributes are the numeric stats raised by a race, class, or profession **per
  level**, plus a separate pool of **Free Points** that the system awards each
  level and which the participant allocates at will.
- Every stat line on the wiki is written as "Stat bonuses per level: +X <Stat>,
  +Y <Stat>, ..., +N Free points."

Example Human stat lines (fan-wiki **inferred**, not source-verified canon):

- Human (G): +1 to all stats, +1 Free Point.
- Human (F): +1 to all stats, +5 Free Points.
- Human (E): +2 to all stats, +5 Free Points.
- Human (D): +6 to all stats, +15 Free Points.
- Human (C): +18 to all stats, +45 Free Points.
- Human (B): +54 to all stats, +135 Free Points.

The seeded Human row stores these as configurable data (see
`prisma/catalog/jake-seed.ts`): the fan wiki never publishes a formal attribute
table, so the numbers are configurable data, not lore canon. The **G** row is
inferred in particular - it models the born-into-system overlap grade and is not
drawn from a verified source table - so it must not be presented as source-verified
canon. (Sources consulted: `https://the-primal-hunter.fandom.com/wiki/Human` and
`https://the-primal-hunter.fandom.com/wiki/Jake_Thayne/Race`.)

## Inferred attribute names (wiki-uncertain)

The stat lines use shorthand names. The observed set spans:

- **Strength (Str)**
- **Agility (Agi)**
- **Endurance (End)**
- **Vitality (Vit)**
- **Toughness (Tough)**
- **Wisdom (Wis)**
- **Intelligence (Int)**
- **Perception (Per)**
- **Willpower (Will)**

This list is **inferred**, not asserted as an official closed set. Different
sources swap terminology (e.g. "Willpower" vs. "Will", "Vit" vs. "Tough"), and the
wiki does not provide a canonical attribute reference. Treat the set as
configurable data rather than hard-coded.

The engine fixes the **canonical nine** above (house rule). The wiki also shows
**Spirit (Spr)** in at least one profession line, but Spirit is deliberately
**excluded** from the canonical set (no canonical spirit).

## House assumption: derived resource multipliers

The source never states how many hit points, mana, or stamina are derived from the
attribute values, nor the multipliers. We deliberately do **not** invent defaults.
The engine exposes these as configurable, unresolved multipliers (see
`docs/rules/assumptions.md` and `docs/architecture/calculation-engine.md`).

## House rule: derived HP / MP / SP maxima

The engine additionally derives **authoritative** maxima for the three core
resource pools from the **final attributes after every phase**, including
temporary effects. These are always present (never `null`) and are independent of
the legacy configurable `resourceMultipliers` / `resourceFormulas` engine, which
stays untouched and continues to report `null` until a multiplier/formula is
supplied. Consumers that want the authoritative pool size should read
`StatusResult.derivedStats` instead of `resources`.

The derivation is per resource, is **not capped** by the equipment 20% /
15% attribute budgets, and does **not** compound across items:

- HP max is derived from final **Vitality**; MP max from final **Wisdom**; SP max
  from final **Endurance**.
- `base = finalAttribute * 10`.
- `flat` = the sum of each equipment item's `derivedFlat[resource]`. Legacy
  equipment with no `derivedFlat` (or a missing resource key) contributes 0.
- `pct` = the sum of each equipment item's `derivedPercentBasisPoints[resource]`,
  expressed in integer basis points (10000 = 100%). The sum is applied **once** to
  the positive `(base + flat)` value, never compounded item-by-item.
- `max = max(0, base + flat + floor(max(0, base + flat) * pct / 10000))`.
- A negative result is clamped to 0 (a negative flat or final attribute cannot
  produce a negative pool).

Because these derived bonuses do not consume the per-attribute aggregate or
overall equipment cap budgets, an equipment item may contribute both a capped
attribute bonus and an uncapped derived HP/MP/SP bonus without them interfering.
