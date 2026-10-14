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
  // scale its Perception bonus by grade (G +5%, F +10%, ...). Grade-specific
  // effects overlay the flat `effects` for matching grades.
  gradeEffects?: Partial<Record<Grade, SkillEffect[]>>,
  // Optional: forwarded as-is.
  upgradeGroup?: string,
}
```

`SkillEffect` is the shared flat/percent discriminated union used by skills,
blessings and bloodlines: `{ phase: "flat", amount }` or
`{ phase: "percent", basisPoints }`, each optionally carrying `condition`,
`stacking`, and `group`. The server validates that every effect vector is a
finite integer so the stored config is a plain JSON-safe data object.

Legacy entries carrying the old `{ grade, vector }` shape remain readable and
metadata-only-PATCHable; a create or config-changing update is rejected unless
`effects` is present.

## Character associations (wired)

Bloodlines can be attached to a character as an association. The server
synthesizes the declared `effects` (and, exactly when the character's current
race grade matches a key in `gradeEffects` and nothing otherwise, that grade's
effects) into the character's live `status` without rewriting the stored state,
so catalog edits recalculate live effects and never mutate historical awards.
Archived bloodlines are inert: a linked but archived definition contributes no
effect.

At most ONE bloodline link may exist on a character (active or archived),
enforced server-side, by the partial unique index at migration 0012, and across
create / association / import. Adding a bloodline atomically replaces EVERY
existing bloodline link on the character (active or archived), so a character
never holds two bloodlines. Selecting two bloodlines at create is a
`link_collision`; a concurrent duplicate writer surfaces as a
`bloodline_singleton_conflict`. A remove detaches only the named link. The
`upgradeGroup` remains part of the catalog config but is no longer an
add/select replacement criterion - the singleton is.
