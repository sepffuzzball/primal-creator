# Classes

## Source & status

- Source: `https://the-primal-hunter.fandom.com/wiki/Classes`.
- Class **stat-cap** numbers are verified; the exact canonical enumeration of the
  six F-grade primary classes is only partially captured (wiki-uncertain in
  detail).

## Verified

- Classes are the **combat-focused** method of progressing through the system.
  They typically focus on killing enemies for experience. Their counterpart,
  `Profession`, focuses on non-combat growth.
- At **F-grade** a participant chooses from a small number of primary classes;
  although there is an uncountable number of classes, they derive from **6 primary
  ones** chosen at F grade. The wiki shows descriptions for the Warrior variants
  (Light, Medium, Heavy), a ranged/archer path, a Caster, and a Healer.
- Classes grant per-level stat bonuses and **Starting Skills** (e.g. Basic
  Archery, Mana Bolt, Heal). The starting skills are of low rarity (Inferior/
  Common).
- **Per-level stat caps** for classes are published per grade:
  - E-grade: max stats per level for a class without restrictions is **28**; with
    severe restrictions it is **34**.
  - D-grade: max with severe restrictions is **100**; stated to imply
    approximately **84** without restrictions.
- Classes upgrade across grades (F -> E -> D -> C -> B), and the specific upgrade
  lines grant larger per-level bonuses (e.g. Ambitious Hunter -> Avaricious
  Hunter, and the B-grade "Hunter-Champion of the Malefic Viper" lines).

## Wiki-uncertain

- The exact names of all six primary F-grade classes and their canonical ordering.
- Which classes are available at each grade for a generic creator (the wiki's
  examples are heavily Jake Thayne specific).
- The per-level stat caps for grades other than E and D are not given.

## Engine note

The engine should treat class as a progression track with per-level stat bonuses
and a grade-based **cap** that limits how much can be added in a grade. The cap
distribution is a house choice (see `docs/rules/assumptions.md`). No invented
formula is used to derive the caps; E-grade (28/34) and D-grade (84/100) are used
as sourced anchors where available.

A class track may also carry an **optional explicit grade** on its track state
(`TrackState.grade`); this is a house-state addition, not a source claim. When a
class grade is present, the class track's level-up is independently capped at the
entry level of the **next** grade (the track may reach exactly that threshold but
may not pass it) until the caller explicitly evolves the class grade via the pure
engine function `evolveTrackGrade`. Quarter progress (0/25/50/75) is preserved
across that boundary, and the class may evolve ahead of the derived race grade
when the race level is still below its own boundary. A class state **without** a
grade is unaffected (legacy behavior preserved); the engine never infers one
(see `docs/rules/leveling.md`).

A new class created through the wizard is stamped with the race's **natural grade**
(legacy `F` fallback when the race config declares none) and a
`stableId:<grade>` definition, so the catalog must define a `<grade>`-grade
per-level config (`grades.<grade>`) for it - the service refuses to create such a
class otherwise. For an enlightened race the selected class must be **at** that
natural grade (exact match, no lower-grade fallback) AND define a per-level config
for it; a class at any other grade is rejected with `invalid_class_grade`. Class
evolution is then a catalog-driven per-track path choice with **no** grade-only
legacy fallback (see `docs/rules/evolution.md`). A monster race is race-only and
carries no class at all (see `docs/rules/races.md`).

## Catalog definition (single-grade)

A `classes` catalog entry is a SINGLE-grade definition: its `grade` column is the
one grade it belongs to, and its `config.grades` map must authorize exactly that
one grade - the key matching `grade` - with a valid per-level row (a missing,
extra, or mismatched grade row is rejected with 400 `invalid_config` on creation
or a config/grade-changing edit). The optional auto-grant map, when present, may
only declare that same grade key (`gradeGrantedSkillStableIds[<grade>]`); a key
for any other grade is rejected. Races are the opposite and remain multi-grade: a
`races` entry authorizes many `raceDefinitions` (one per grade) and a separate
`gradeGrantedSkillStableIds` map keyed across all grades.

The admin editor renders a class as a single row at one grade. Changing the grade
in the editor moves the existing `grades[<oldGrade>]` gains row (and any
`gradeGrantedSkillStableIds[<oldGrade>]` grants) onto the new grade key, so the
per-level progression and the auto-grants travel with the grade change. The grade
selector is disabled on a legacy multi-row entry, and a config-changing edit on
such an entry is refused until the rows are resolved to a single grade.

A class carries no authored grade-specific prose: `gradeDescriptions`, when sent
on a new or config/grade-changing write, must be empty (`{}`) or omitted; a
non-empty map is rejected with 400 `invalid_grade_descriptions`. The legacy
`description` string is the prose for the class's one grade, and it is what the
character detail **class** tab shows (via `classDescription`). A legacy class row
that still stores an authored `gradeDescriptions` map keeps returning it on the
API (as `classGradeDescription`), but the UI does not display it - it shows the
general `description` instead. Legacy authored grade prose is never migrated or
cleared; it is simply no longer shown by the UI nor newly authored.

A **grade-only PATCH** - changing `grade` without supplying `config` in the same
PATCH - is rejected with 400 `invalid_config`, because otherwise the single-grade
`grades` map would be silently rekeyed to the wrong grade. A metadata-only PATCH
(no `grade`, no `config`) leaves a legacy empty or multi-row class alone.

A legacy class row that is **empty** (no `grades` entry for any grade) or
**multi-grade** (more than one `grades` row) stays readable and metadata-only
PATCHable (name, description, sourceUrl, archived). It cannot be newly created
that way, and a config-changing PATCH must first normalize it to a single grade
row - the editor refuses a config change on such an entry until the rows are
resolved. No database migration clears or rewrites these rows today; the deployed
catalog still contains 18 legacy zero-row classes, which remain visible and
metadata-editable but must be normalized before their progression config can
change.

## Seeded class definitions (`db:seed`)

`pnpm db:seed` seeds the curated Jake Thayne class progression
(`prisma/catalog/jake-seed.ts`), sourced from
`https://the-primal-hunter.fandom.com/wiki/Jake_Thayne/Class`. Every row
(secondary fan-wiki source) carries exactly one `grades.<grade>` entry for its own
grade:

| Grade | Name                                   | stableId                                 |
| ----- | -------------------------------------- | ---------------------------------------- |
| F     | Archer                                 | `archer`                                 |
| E     | Ambitious Hunter                       | `ambitious-hunter`                       |
| D     | Avaricious Arcane Hunter               | `avaricious-arcane-hunter`               |
| C     | Arcane Hunter of Horizon's Edge        | `arcane-hunter-of-horizons-edge`         |
| B     | Arcane Hunter of the Boundless Horizon | `arcane-hunter-of-the-boundless-horizon` |

The legacy `classes/archer` row (a house placeholder granting only agility +
perception) is updated to the sourced F-grade Archer values only when it still
matches the 0.0.2 baseline; an admin-modified row is preserved. The E/D/C/B
definitions are create-only, so a repeated seed is idempotent and never
overwrites an admin-customized row.
