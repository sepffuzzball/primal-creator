# Bloodlines

## Source & status

- Source: `https://the-primal-hunter.fandom.com/wiki/Bloodlines`,
  `https://the-primal-hunter.fandom.com/wiki/Bloodline_of_the_Primal_Hunter`,
  `https://the-primal-hunter.fandom.com/wiki/Transcendent`.
- The **definition** and the **one concrete scaling example** are verified. The
  general scaling of most bloodlines is **wiki-uncertain** (the wiki catalogs
  holders, not numeric effects).

## Verified

- Bloodlines are **innate sources of power tied to an individual's truesoul**,
  rather than granted through the System. They represent inherited or naturally
  awakened traits that can significantly influence a being's potential, abilities,
  Records, Path, Skills, and Evolution. The Bloodlines page states flatly: "A
  bloodline exists outside the system."
- **Bloodlines vs. Transcendences** (from the Transcendent page): a Bloodline is an
  innate augmentation of the Truesoul that affects the person at all times and
  shapes their personality, with no real way to separate the two. (Contrast with a
  Transcendent skill; see `docs/rules/transcendents.md`.)
- Bloodlines are tied to a **Patriarch/Matriarch**. The Bloodlines page provides a
  table of Bloodline Holder, Bloodline, and Patriarch/Matriarch (e.g. Jake Thayne /
  Bloodline of the Primal Hunter / Yes; The Malefic Viper / Bloodline of the
  Immortal Mind / No; The First Sage / Bloodline of the Immortal Mind / Yes; plus
  several others).

## Verified scaling example: Bloodline of the Primal Hunter

From `Bloodline of the Primal Hunter`: a unique, innate ability that **evolves
with the holder** rather than being a flat, set permanent buff. It grants a
per-grade Perception bonus:

- G-grade: +5% to Perception
- F-grade: +10% to Perception
- E-grade: +15% to Perception
- D-grade: +20% to Perception
- C-grade: +25% to Perception
- B-grade: +30% to Perception

This is the clearest verified per-grade gradient and is a good template for how a
bloodline might scale by grade.

The Bloodline of the Primal Hunter is NOT part of the curated seed catalog
(`prisma/seed.ts` -> `prisma/catalog/jake-seed.ts`, the 41 curated entries). Its
entry lives in the admin opt-in reviewed wiki manifest
`prisma/catalog/wiki-reviewed.ts`, applied only when an admin calls
`POST /api/admin/catalog-import`. That entry is deliberately
`{ effects: [], gradeEffects: {} }` - the wiki's per-grade gradient is
illustrative, not yet curated, so no numeric bonus and no per-grade override is
invented; its stats are left unknown (see `docs/catalog/wiki-reviewed.md`).

## Wiki-uncertain

- The **numeric effect** of most bloodlines (this table is Jake-specific; other
  bloodlines are listed without a numeric gradient).
- Whether bloodline effects are always a flat percent-by-grade or can be absolute
  or derived. Only the one example is published.
- Whether bloodline effects interact with caps in a defined way.

## Engine note

Treat bloodlines as innate, outside-the-System modifiers that may scale **by
grade**. Where a numeric gradient is sourced (the Primal Hunter bloodline), use it;
otherwise leave bloodline values as configurable data rather than inventing
defaults.

## Catalog config (modern shape)

A `bloodlines` catalog entry must declare the modern shape on create or any
config-changing update:

```ts
{
  // Required: the typed flat/percent declarative effects. May be [] for a
  // narrative-only bloodline (the wiki catalogs holders, not numeric effects).
  // Every vector value must be a finite integer (never a float, NaN or Infinity).
  effects: SkillEffect[],
  // Optional: per-grade effect lists, so a bloodline like the Primal Hunter's can
  // scale its Perception bonus by grade (G +5%, F +10%, ...). When a key for the
  // character's current race grade exists, that grade's effects REPLACE all base
  // `effects` (including conditional/grouped base effects) for that character; an
  // explicit [] for the current grade suppresses base. When no key matches, the
  // flat `effects` apply. There is NO fallback to another grade's effects.
  gradeEffects?: Partial<Record<Grade, SkillEffect[]>>,
  // Optional: forwarded as-is.
  upgradeGroup?: string,
}
```

`SkillEffect` is the shared flat/percent discriminated union used by skills,
blessings and bloodlines: `{ phase: "flat", amount }` or
`{ phase: "percent", basisPoints }`, each optionally carrying `condition`,
`stacking`, and `group`. A `flat` `amount` is a partial vector of finite integers
(whole numbers only, never a float); a `percent` `basisPoints` is a partial vector
of nonnegative integer basis points, where **100 basis points = 1%** (so a +5%
bonus is stored as `500`, not `5`). The server validates that every vector value
is a finite integer, so the stored config is a plain JSON-safe data object.

Advanced JSON stays available for any effect the simple flat/percent controls
cannot express unambiguously - effects carrying `condition`, `group`, or
`stacking`, or multiple simple effects for the same phase - and is never discarded
by the visual editor.

Legacy entries carrying the old `{ grade, vector }` shape remain readable and
metadata-only-PATCHable but are **inert**: they contribute no synthesized effect
(no invented numeric bonus). A create or config-changing update is rejected unless
`effects` is present.

## Character associations (wired)

Bloodlines can be attached to a character as an association. The server
synthesizes effects into the character's live `status` without rewriting the
stored state, so catalog edits recalculate live effects and never mutate
historical awards. The resolution is exactly:

- If the character's current race grade has **no** entry in `gradeEffects`, the
  base `effects` apply as declared.
- If the current race grade **does** have an entry, that grade's effects
  **replace** the base `effects` entirely - including any conditional or grouped
  base effects. An explicit `[]` for that grade suppresses base, so the bloodline
  contributes no effect at that grade.
- There is **no grade fallback**: a missing grade key means base applies; a
  present key (even an empty one) replaces base and never falls back to another
  grade's effects.

Archived bloodlines are inert: a linked but archived definition contributes no
effect.

At most ONE bloodline link may exist on a character (active or archived),
enforced server-side, by the partial unique index at migration 0012 (a migration
in the archived `0001..0023` chain, replaced by the 0.1.0 baseline), and across
create / association / import. Adding a bloodline atomically replaces EVERY
existing bloodline link on the character (active or archived), so a character
never holds two bloodlines. Selecting two bloodlines at create is a
`link_collision`; a concurrent duplicate writer surfaces as a
`bloodline_singleton_conflict`. A remove detaches only the named link. The
`upgradeGroup` remains part of the catalog config but is no longer an
add/select replacement criterion - the singleton is.

## Visual editor (catalog manager)

The bloodline editor in the catalog manager exposes a **Base** scope plus one
scope per grade. Editing **Base** edits the flat `effects`; editing a **grade**
scope edits `gradeEffects[grade]`.

- A grade without an existing override falls back to Base, and its controls are
  disabled until an override exists; a **Create empty override** button sets
  `gradeEffects[grade] = []`, which explicitly suppresses Base for that grade.
- A grade with an existing override shows a **Clear override** button that
  removes the grade key and restores the fallback to Base.
- Flat bonuses are whole integers (no rounding); percent bonuses are entered as
  nonnegative percentages up to 2 decimals and saved as integer basis points
  (100 = 1%).
- Advanced JSON is retained for effects the simple controls cannot represent
  unambiguously (conditions, groups, stacking, or multiple simple effects for one
  phase); the editor does not discard JSON it cannot edit.

There is no grade fallback in the editor either: a grade with no override uses
Base, while a grade with an override (even an empty one) never falls back to Base
or to another grade.
