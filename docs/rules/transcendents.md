# Transcendents

## Source & status

- Source: `https://the-primal-hunter.fandom.com/wiki/Transcendent`,
  `https://the-primal-hunter.fandom.com/wiki/Bloodlines`,
  `https://the-primal-hunter.fandom.com/wiki/Titles`.
- The **definition**, the **known examples**, and the **cost** are verified. The
  exact trigger/threshold is **wiki-uncertain**.

## Verified

- **A transcendent is a person possessing a transcendent skill.**
- A **transcendent skill** is, per the Malefic Viper, "essentially a self-created
  skill that breaks some fundamental rules [...] otherwise not allowed within the
  system's current parameters and limitations."
- Transcendent skills are **extremely rare**; "there are 'more gods than
  transcendents'." They are akin to bloodline abilities but differ:
  - A **Bloodline** is innate to the Truesoul (see `docs/rules/bloodlines.md`).
  - A **transcendence** is something "surrendered" to an individual by the system
    upon that person meeting some invisible threshold and gaining enlightenment.
- Being a Transcendent also leads to a mutation of the soul, but is **far less
  pervasive** than a bloodline, because a transcendent skill is born from who the
  person already is.
- **Cost:** transcendent power can come at a heavy cost. Example: the Sword
  Saint's transcendent skill costs him **Path levels** to use.

## Known transcendents (verified list)

| Transcendent | Transcendent skill | Note |
| --- | --- | --- |
| The Holy Mother | Holyland | Creates a realm to house souls of the blessed |
| Eversmile | Karmic Annihilation | Severs records / makes them cease to exist |
| Valdemar | Fighting Spirit | A golden aura that crushes others' auras |
| Yip of Yore | Usurper of Legends | Acquires titles of others by condensing records |
| The Malefic Viper | Malefic Alchemy: Transmutation | Turns anything into suitable material |
| Aeon Clok | (time-stop) | Received after reaching S-grade |

## Wiki-uncertain

- The exact **threshold** at which the system offers transcendence (described as
  "some invisible threshold").
- Whether transcendence is grade-gated (one example is received after S-grade, but
  no general rule is stated).

## Verified titles

The Titles page lists a "Transcendents, Bloodlines and Unique Lifeforms" category
that includes a **Transcendent** title.

## Engine note

Model a transcendent as a **character quality plus a transcendent skill**, both of
which exist "outside the system."

The project implements this as:

- A **`transcendent_skills` catalog kind** (`/api/catalog/transcendent_skills`).
  Each entry's modern config is:
  ```ts
  {
    // Prose only - surfaced to the UI, never treated as a mechanical cost,
    // activation, or triggered always-on power. The engine never interprets it.
    costDescription?: string,   // e.g. "Loses a Path level to use"
    acquisitionNotes?: string,  // e.g. "Received after reaching S-grade"
    // Declarative passive effects synthesized live into the character's status.
    // May be [] for a narrative-only transcendent. REQUIRED on a NEW or
    // CONFIG-CHANGED entry (a missing list is rejected - never a fabricated
    // default bonus). Each effect uses the shared skill-effect schema
    // (flat/percent, condition, per-effect stacking group).
    passiveEffects: Array<{
      phase: "flat" | "percent",
      amount?: Record<string, number>,       // flat: finite integer vector
      basisPoints?: Record<string, number>,  // percent: nonnegative integer bps
      condition?: ...,
      stacking?: "replace" | "stack" | "stackCapped",
      group?: string,                        // per-effect stacking/replace group
    }>,
  }
  ```
  A **legacy** config that predates `passiveEffects` (e.g. only prose) stays
  readable and metadata-only-PATCHable; only a NEW/CONFIG-CHANGED write requires
  the modern shape.
- A **character association kind `transcendent`** (DB `TRANSCENDENT`) pointing at
  a `transcendent_skills` definition. A character may carry at most
  `maxTranscendentSkills` such links (admin-configurable via HouseRules, default
  3, bounded 0..8). Adding is an explicit user action (no automatic reward) and is
  rejected with `link_limit` once the cap is reached (the count includes archived
  links, so an over-cap grandfathered character can still remove but not add);
  removing unlinks only the named skill. Transcendent skills otherwise coexist -
  there is no blessing singleton and no `upgradeGroup` replacement. An archived
  definition can never be newly attached but an archived linked one can always be
  removed. Creating a character or importing a backup with more than the cap is
  rejected (`link_collision` / `import_link_collision`).
- A **derived `isTranscendent` boolean** on the character detail. Never persisted:
  it is recomputed at read time from whether at least one linked, **unarchived**
  `transcendent_skills` definition exists. Archiving the last active definition
  clears it; unarchiving restores it; unlinking the last one clears it.
- **Live passive effects**: the active `passiveEffects` of each linked, unarchived
  definition are synthesized into the character's live status at read time,
  exactly like a skill/blessing/bloodline effect. History (`Character.state` and
  the event journal) stays immutable; editing a transcendent skill's
  `passiveEffects` recalculates the live status without rewriting historical
  awards. Because the exact **threshold/reward** is wiki-uncertain, nothing here
  models a universal eligibility gate or an automatic bestowal - transcendence is
  only ever an explicit, human-directed link.

This is a **house model**: the wiki never pins the exact trigger or reward
mechanics, so the project treats transcendence as manually-assigned data and
never infers a formula for it.
