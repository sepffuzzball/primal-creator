# Titles

## Source & status

- Source: `https://the-primal-hunter.fandom.com/wiki/Titles`,
  `https://the-primal-hunter.fandom.com/wiki/E-grade`,
  `https://the-primal-hunter.fandom.com/wiki/Evolution`,
  `https://the-primal-hunter.fandom.com/wiki/Blessings`,
  `https://the-primal-hunter.fandom.com/wiki/Perfect_Evolution_(B-grade)`.
- The title **categories** and some specific titles are verified. Whether any
  given title carries a mechanical stat bonus is often **wiki-uncertain** (many
  titles are story-flavored with no published numeric effect).

## Verified

- Titles are awarded from many sources. The `Titles` page groups them into:
  Tutorial, System Event, Prodigy, Dungeon, Nevermore, Nobility, Evolution,
  Blessing, Progenitor, Originator, Slayer, Transcendents/Bloodlines/Unique
  Lifeforms, and Misc.
- **Evolution titles** exist for reaching grade milestones, e.g. "Evolution (D)",
  "Perfect Evolution (D-grade)", "Evolution (C)", "Perfect Evolution (C-grade)",
  "Evolution (B)", "Perfect Evolution (B-grade)".
- **Perfect Evolution (B-grade)** is received by becoming a B-grade Human while
  race, class, and profession are all at level **349** at the same time.
- **E-grade awards no titles** (E-grade page states "No Titles are awarded for
  reaching E-grade").
- **Blessing titles** accompany blessings: e.g. "Holy Spirit", "Holder of a
  Godqueen's Divine Blessing", "Holder of a Primordial's Divine Blessing", and
  variants. The Blessings page confirms a title is acquired along with the
  blessing and that a blessing raises stats "both directly from the blessing and
  from the title that is acquired."
- **Postponing evolution** to gain an associated title is a documented behavior:
  Jake Thayne postpones an evolution at each stage to gain the related title
  (`Evolution`).

## Wiki-uncertain

- The precise mechanical effect of most titles (which stat/percent, and by how
  much). Only a few titles have published numeric effects.
- Whether titles are unique/exclusive or stackable is not generally documented.

## Engine note

The engine should model titles as effects that may carry configurable bonuses but
should not assume every title has a numeric effect. Where a bonus is sourced
(e.g. blessing titles raise stats, via `Blessings`), it is used; otherwise the
effect is an unresolved placeholder.

## Character attachment (catalog config)

Titles are attached to a saved character through a `CharacterAssociation` link
(`kind = TITLE`). The link references a catalog `titles` entry and is validated
against the **current, unarchived** catalog config at read time, so editing a
title's config recalculates a character's live status without rewriting any
historical award (the journal and `Character.state` are immutable).

The `config` for a `titles` catalog entry accepts the following fields, in
addition to the legacy `grade` / `grants` (which are preserved):

- `flat?: PartialVector` - nonnegative-integer flat attribute bonuses. Synthesized
  as a flat engine effect.
- `percentBasisPoints?: PartialVector` - nonnegative-integer integer basis points.
  Synthesized as a percent engine effect.
- `upgradeGroup?: string` - when set, a title attached to a character **replaces**
  any title already attached in the same upgrade group. Superseded tiers never
  stack; the journal records the old/new pair when a replacement happens.
- `improvement?: { seriesId: string, rank: integer 1..100, minRaceGrade: Grade }`
  - a strict subobject marking the title as a **ranked** entry in a sequential
    title-improvement series. `seriesId` names the series (must equal the entry's
    `upgradeGroup`), `rank` is its 1..100 position in the series, and
    `minRaceGrade` is the lowest race grade a character may hold to attach it. A
    ranked title must carry its `flat` bonus vector from the series catalog; the
    server does not invent one. A keepable title is created by omitting
    `improvement` (or by including only `flat` / `percentBasisPoints`).

Title bonuses are **not** silently auto-granted: only titles a user explicitly
attaches produce effects. Effects synthesized from a title carry the catalog
entry's `provenance` (`verified` / `inferred` / `house`) so nothing is presented
as canon. A title with no numeric `flat` / `percentBasisPoints` contributes no
effect (an unresolved placeholder), matching the wiki-uncertain note above.

## Ranked title improvement (sequential)

A ranked title is a member of a `seriesId` that represents a ladder of
improvements, e.g. the **Dungeon Pioneer** series ranks I-XV. A character holds
**at most one** title from a given series; the ranked entries replace one another
in order.

- **Attachment is catalog-driven and self-reported**: when a ranked title is
  attached, the server reads the rank / `minRaceGrade` / `seriesId` from the
  title's own `improvement` config. The attached character must be at
  `minRaceGrade` or higher (else 400 `title_grade_blocked`).
- **Strict one-by-one progression**: rank 1 may be attached freely (no prior).
  Rank N > 1 may only be attached when the character already holds exactly one
  in-series link of rank N-1 (an archived prior link still counts). A skipped or
  repeated rank, or a rank added when no prior rank is present, is rejected with
  400 `title_rank_conflict`. Because the old link is displaced, this is strictly
  additive - no two series ranks coexist.
- **A reason is required**: attaching a ranked title needs a nonempty `reason`
  (else 400 `title_reason_required`). The event snapshot carries the reason plus
  the title's `seriesId` / `rank` / `minRaceGrade`.
- **Ambiguous rank 1**: adding rank 1 over an unrelated (unranked) title that
  happens to share the same `upgradeGroup` is ambiguous and rejected with 400
  `title_rank_conflict` before any write.
- **Backups bypass the ladder**: a trusted backup may import a ranked title at any
  rank without prior rank history, but only if the imported race grade meets
  `minRaceGrade` (else 400 `import_grade_blocked`).

### Catalog edits

Changing or removing a ranked title's `improvement` identity (`seriesId` /
`rank` / `minRaceGrade`) on a title that is currently linked to a character is
rejected with 409 `title_improvement_conflict` before any write. Metadata/name
and `flat` / `percentBasisPoints` bonus edits are allowed while the identity
stays stable, and promoting a linked but previously unranked title to ranked is
allowed (the prior identity was absent).

## Dungeon Pioneer series (verified titles)

The **Dungeon Pioneer** ranks come from the wiki's `Dungeon_Pioneer` page
(`https://the-primal-hunter.fandom.com/wiki/Dungeon_Pioneer`). The 15 ranked
entries are named **Dungeon Pioneer I** through **Dungeon Pioneer XV** (canonical
roman numerals IX and XIV). Provenance is inferred; the bonus magnitudes are
cumulative flat all-stat totals drawn from the series catalog, not invented by
the engine:

| Rank  | Grade tier | Cumulative all-stat flat total |
| ----- | ---------- | ------------------------------ |
| I-V   | E (1-5)    | 3, 6, 9, 12, 15                |
| VI-X  | D (6-10)   | 24, 33, 42, 51, 60             |
| XI-XV | C (11-15)  | 87, 114, 141, 168, 195         |

Each entry sets `upgradeGroup` and `improvement.seriesId` to `dungeon-pioneer`,
`minRaceGrade` mirroring its grade tier, and `flat` to the named cumulative
total. The series is create-only seed data (idempotent): no title is auto-granted
and a character must be explicitly attached to gain it. `rank` 1 carries no
in-series prior and is the entry point; each subsequent rank requires the prior
rank link, as documented above.
