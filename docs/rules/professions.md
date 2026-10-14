# Professions

## Source & status

- Source: `https://the-primal-hunter.fandom.com/wiki/Profession`,
  `https://the-primal-hunter.fandom.com/wiki/Human`.
- Stat-cap numbers are verified; the canonical list of professions is
  wiki-uncertain (the wiki gives archetypes, not a fixed registry).

## Verified

- Professions are an alternative way of growing through the system. They tend to
  be **less combat focused** than classes, though that varies by profession. They
  are colloquially split into **crafting** and **social** professions.
- Verified crafting archetypes: Tailor, Smith, Builder, Cook, Alchemist,
  Leatherworker, Artist.
- Verified social archetypes: Leader, Merchant, Manager, Priest, Host, Teacher.
- Professions grant per-level stat bonuses and Starting Skills (e.g. the
  Alchemist profession starts with Herbology, Brew Potion, Concoct Poison, etc.).
- **Per-level stat caps** for professions are published:
  - E-grade: max stats per level without restrictions is **22**; with severe
    restrictions it is **27**.
  - D-grade: max with severe restrictions is **80**; stated to imply approximately
    **66** without restrictions.
  - C-grade: max with severe restrictions is **240**.
- Humans can possess **both** a class and a profession; many races can possess only
  one (`Human`). This matters for the race-level formula (see `docs/rules/races.md`).

## Wiki-uncertain

- Whether the listed archetypes are exhaustive (the wiki presents them as known
  archetypes, not a complete registry).
- The exact profession available to a generic creator at each grade (the wiki's
  examples skew to Alchemist variants from Jake Thayne's story).
- Per-level caps for grades other than E, D, and C are not given.

## Engine note

Profession is modeled like class: a progression track with per-level bonuses and a
grade-based cap. If a race has **no profession**, the engine treats the missing
profession level as 0 per the house assumption in `docs/rules/races.md` and
`docs/rules/assumptions.md`.

As with class, a profession track may carry an **optional explicit grade**
(`TrackState.grade`) that independently caps the profession track's level-up at
the entry level of the **next** grade until the caller explicitly evolves the
profession grade via `evolveTrackGrade`. Quarter progress (0/25/50/75) is
preserved, and a profession may evolve ahead of the derived race grade when the
race level is below its own boundary. A profession state **without** a grade is
unaffected (legacy behavior preserved); the engine never infers one
(see `docs/rules/leveling.md`).

A new profession created through the wizard is stamped with an explicit `F`
grade and a `stableId:F` definition, so the catalog must define an `F`-grade
per-level config (`grades.F`) for it - the service refuses to create such a
profession otherwise. Profession evolution is then a catalog-driven per-track
path choice with **no** grade-only legacy fallback (see
`docs/rules/evolution.md`).

## Seeded profession definitions (`db:seed`)

`pnpm db:seed` seeds Jake Thayne's five alchemist profession progression
definitions (`prisma/catalog/jake-seed.ts`), sourced from
`https://the-primal-hunter.fandom.com/wiki/Jake_Thayne/Profession`, each labelled
`provenance: inferred` with exactly one `grades.<grade>` entry:

| Grade | Name | stableId |
| ----- | ---- | -------- |
| F | Alchemist of the Malefic Viper | `alchemist-of-the-malefic-viper` |
| E | Prodigious Alchemist of the Malefic Viper | `prodigious-alchemist-of-the-malefic-viper` |
| D | Heretic-Chosen Alchemist of the Malefic Viper | `heretic-chosen-alchemist-of-the-malefic-viper-d` |
| C | Heretic-Chosen Alchemist of the Malefic Viper | `heretic-chosen-alchemist-of-the-malefic-viper-c` |
| B | Primeval Alchemist of Malefic Origins | `primeval-alchemist-of-malefic-origins` |

The F-grade stableId deliberately matches the reviewed manifest
(`prisma/catalog/wiki-reviewed.ts`), so if an admin imports the manifest first the
existing row is preserved. The source documents the same display name at both D
and C, so those two entries are disambiguated by the `-d` / `-c` stableId
suffixes. All five are create-only: an existing row is never overwritten and a
repeated seed is idempotent.
