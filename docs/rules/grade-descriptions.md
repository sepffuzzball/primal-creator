# Grade descriptions

## What this is

A catalog item can carry an **independently authored** map of grade-specific
descriptions: a `gradeDescriptions` object keyed by the closed grade set
**G / F / E / D / C / B / A / S**, where each value is a free-text blurb for that
grade band. It is a _separate_ field and is in no way derived from the legacy
`description` string, which stays on the item unchanged.

The purpose is to let a catalog entry describe the same subject differently at
different grade tiers (for example, what a bloodline offers at A-grade versus what
it offered at F-grade) without collapsing that nuance into a single `description`.

## Shape

```json
{
  "gradeDescriptions": {
    "F": "A humble beginning.",
    "A": "At this tier the bloodline fully awakens."
  }
}
```

- Keys must be from the closed grade set **G/F/E/D/C/B/A/S**. A key outside that
  set (a typo such as `"H"`, or an unsupported `"S+"`) is rejected, not silently
  dropped. This is strict by design.
- Values are trimmed; leading/trailing whitespace is stripped. A value must be
  **non-blank** (at least one character after trimming) and at most **8000**
  characters. A blank or oversized value is rejected.
- An empty object `{}` is valid and means "no grade-specific descriptions" - it is
  the same as the field being absent (on create) or having nothing stored.
- The map is **partial**: it need not include every grade. Only the supplied grades
  have a description.

## Semantics

- **Independent from `description`.** `gradeDescriptions` never populates from and
  is never populated from `description`. Writing one does not touch the other, and
  reading one never synthesizes the other. The legacy `description` string and the
  grade map are two distinct, independently edited fields.
- **Never revalidates a legacy config.** A `gradeDescriptions`-only update is
  metadata-only: it does not run the per-kind config parser that a config change
  would run. This means a legacy or partial `config` that would be rejected by a
  config edit stays untouched and valid when the admin only edits the grade
  descriptions. (A config change still revalidates as before.)
- **Clear vs. preserve.** On an update (PATCH):
  - omitting `gradeDescriptions` **preserves** the stored map;
  - sending `{}` **clears** it (stores nothing).
- **Old rows read back `{}`.** A row created before this field existed, or one
  whose DB value is `null`/not an object, reads back as an empty map `{}` - never
  as `null`. When reading, non-grade keys and non-string/blank values that somehow
  reach the store are dropped defensively and valid strings are trimmed.
- **Not a character/engine rule.** Grade descriptions are presentation/editorial
  content; they do not change how a grade or its level band is computed. See
  [docs/rules/grades.md](grades.md) for the grade subsystem itself.

## Where it applies

The field is accepted wherever a catalog item can be created or edited:

- `POST` / `PATCH /api/admin/catalog` (create and update) - optional, as above.
- Bulk import (`docs/catalog/bulk-import.md`) - optional `gradeDescriptions` JSON
  key and optional `gradeDescriptions` CSV header (a JSON object string).

It is authored by the graded kinds that carry a grade ladder: bloodlines,
equipment, races, titles, transcendents, and the like. `races` in
particular is - and remains - a multi-grade kind: a race authorizes many
`raceDefinitions` and a `gradeGrantedSkillStableIds` map keyed across all grades,
and it is the one graded kind whose character-detail **race** tab displays the
authored grade prose (`raceGradeDescription`).

`classes` and `professions` are the exception. Each is a SINGLE-grade definition
whose legacy `description` string IS the prose for that one grade, so neither
authors new grade-specific prose: a non-empty `gradeDescriptions` on a new or
config/grade-changing class/profession write is rejected with 400
`invalid_grade_descriptions`, while an empty `{}` (a legal clear) or an omitted
value is fine. Their `grade` column is never null on a fresh definition. The
character-detail **class** and **profession** tabs display the general
`description` (`classDescription` / `professionDescription`), never a grade map.
The single-grade catalog definition invariant is covered in
[docs/rules/classes.md](classes.md) and [docs/rules/professions.md](professions.md).

A kind that has no grade ladder at all (currencies, skills, gods) is
ignored/stored as `{}` - the map simply ends up empty - and a non-empty map there
is likewise rejected with `invalid_grade_descriptions`.

It has no effect on, and is unrelated to, UI, equipment-slot, percent-based, or
ring mechanics.

## Character detail exposure

An **owner-authorized character detail read** (`GET /api/characters/[id]`, and
every mutation response that returns a full `character`) surfaces the authored
grade prose for the character's own linked race / class / profession at the
character's **own** grades. It is read straight off the catalog definition rows,
never synthesized, and never derived from engine effects or backups.

- `CharacterDetail.raceGradeDescription: string | null` is the authored prose at
  `state.race.grade` on the character's linked race definition.
- `CharacterDetail.classGradeDescription: string | null` is the authored prose at
  `state.tracks.class.grade` on the linked class definition.
- `CharacterDetail.professionGradeDescription: string | null` is the authored
  prose at `state.tracks.profession.grade` on the linked profession definition.

Rules for these three fields:

- The lookup grade is the **track's own** grade for class/profession, never the
  race grade. A legacy class/profession track with **no explicit grade**
  (`state.tracks.class.grade` absent) reads back `null` - the engine never infers
  a grade, and neither does this view.
- A missing definition row, a missing grade, or a `gradeDescriptions` map with no
  entry for that grade all read back `null`.
- They **never fall back to the legacy `description`** string. The general
  `description` field is preserved unchanged and is completely independent.
- **Backward-compatible readbacks.** On a NEW class/profession, neither
  `classGradeDescription` nor `professionGradeDescription` is ever authored (no
  `gradeDescriptions` map), so both read back `null`. The two fields exist on the
  `CharacterDetail` API only so a legacy class/profession row that still stores an
  authored `gradeDescriptions` map keeps exposing it. The character-detail UI does
  not use them: the **class** and **profession** tabs render the general
  `description` (`character.classDescription` / `character.professionDescription`).
  Only the **race** tab displays grade prose (`character.raceGradeDescription`).

Linked **associations** (skills, equipment, titles, blessings, bloodlines,
transcendents) expose `CharacterAssociationView.gradeDescription?: string` when
the linked definition declares a grade. The prose is looked up at the
**definition's own** `grade` band, never the character's race grade. A definition
with `grade: null`, or with no authored text at its grade, yields an absent field
(`undefined`), never a fallback to `description`.

Archived catalog definitions stay readable to the character's owner: archiving a
race / class / profession (or an associated definition) does **not** strip the
grade prose from an existing character's detail. This only narrows what the
public catalog lists; it never loosens or hides an owner's record. The character
detail reads its race/class/profession/association rows directly regardless of
their `archived` flag.
