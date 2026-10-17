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
- `grantedSkillStableIds?: string[]` - optional list of catalog `stableId`s of
  `skills` definitions whose **current** `config.effects` are granted as passive
  effects **while the title is attached and unarchived** (see "Title-granted
  passive skills" below). Each id must be nonempty and internally unique; an empty
  `[]` is allowed (the title grants no passive). On a NEW or config-changing write
  every id must resolve to an existing, unarchived `skills` entry; a missing or
  archived id is rejected with a 400 (`invalid_config`).

Title bonuses are **not** silently auto-granted: only titles a user explicitly
attaches produce effects. Effects synthesized from a title carry the generic
internal `provenance: "catalog"` value (the catalog provenance taxonomy no longer
exists). A title with no numeric `flat` / `percentBasisPoints` contributes no
effect **of its own** (an unresolved placeholder), matching the wiki-uncertain
note above - but it can still contribute an effect through `grantedSkillStableIds`,
whose granted passives are synthesized while the title is attached (see
"Title-granted passive skills" below).

## Title-granted passive skills

A `titles` catalog config may also declare `grantedSkillStableIds`: an array of
`skills` catalog `stableId`s whose passive effects the title grants **while it is
attached and unarchived**. This is **not** a permanent acquisition: no
`CharacterAssociation` SKILL link is created, no milestone skill offer is produced,
and no acquisition/history event is written. Removing the title (or losing its link
through a ranked replacement) immediately stops the granted passives.

- **Synthesis is live and current.** Each granted id resolves to a `skills`
  catalog definition; the CURRENT `config.effects` of that skill are synthesized
  live at read time (the same flat / percent synthesis as a linked SKILL
  association or an equipment-granted passive), sourced to `"<title> (<skill>)"`
  and never written into `Character.state`. Catalog skill stacking groups and
  conditions are preserved verbatim; no stat is ever inferred from a skill's name,
  and the skill's config name is used only when the catalog row actually exists.
  Editing a granted skill's `effects` therefore recalculates the live status
  without rewriting historical awards, exactly like any other catalog config.
- **No persistence, no history.** Attaching a title that grants skills does not
  store the skills in `Character.state` and creates no `skillOffer` and no skill
  acquisition journal entry. A grant is a read-time computation over the current,
  unarchived catalog config, mirroring how title/equipment effects are
  synthesized; the attached title link is the only persisted record.
- **Removal / ranked replacement.** Removing the title association removes its
  grants. A ranked title replacement displaces (deletes) the superseded rank link,
  so only the **current linked rank** survives; earlier-ranked titles' grants never
  accumulate. See "Ranked title improvement (sequential)" below.
- **Inert states.** An archived title is inert (it is skipped before its grants
  are read); an archived granted skill is inert (it is not in the unarchived-skill
  map, so it is skipped, never inferred). An unresolved grant is silently skipped
  at read time, never invented.
- **Linked skill priority and shared dedupe.** A skill already linked as a
  `CharacterAssociation` SKILL association takes priority: the linked association
  is applied, and the title grant for the same stableId is skipped. Otherwise a
  granted skill is applied **once**, even if it appears in multiple titles'
  `grantedSkillStableIds` and/or is granted by an equipped equipment item - the
  first surviving grant encountered across title AND equipment associations (in
  association order) wins, and no double stacking occurs. A granted-skill map is
  loaded on demand (only when an eligible attached title or equipped item actually
  grants a skill) and shared for the whole request, so a withStatus listing never
  issues a per-character lookup.
- **Write-time reference validation.** A NEW or config-changing title write must
  resolve every granted id to an existing, **unarchived** `skills` entry; holding a
  reference to a missing or archived skill is rejected with a 400
  (`invalid_config`) before any write. The catalog editor exposes a Granted skills
  control (listing active skills) for titles, and the same-batch reference rules
  cover editors / bulk uploads / the MCP publisher (see below).
- **Rename guard.** Renaming a `skills` catalog `stableId` is rejected with 409
  `skill_stable_id_in_use` while ANY `titles` config's `grantedSkillStableIds` -
  including an archived title row - still names the old id, otherwise the
  title-granted passive silently dangles and is skipped at read. Archiving a skill
  is always allowed (an archived granted skill is simply inert).
- **Same-batch references.** The same-batch reference handling for title granted
  skills differs by path:
  - **Catalog editor / single-entity write**: each id is resolved against the live
    catalog inside the write transaction; a missing or archived id is rejected with
    a 400 `invalid_config`. There is no batch here, so a referenced skill must
    already exist in the catalog (or be authored in the same bulk upload / MCP
    batch, below).
  - **MCP catalog publisher**: processes a whole batch atomically. A title that
    references a `skills` entry authored in the same batch is satisfiable because
    the batch is ordered by dependency topological ordering (an entry is written
    only after any NEW batch key it references, so a `skills` entry referenced
    by a title is written before that title), and the title's live validation
    sees it. A reference to a missing or archived skill outside the batch is
    rejected with a 400 `invalid_config` before any write.
  - **Bulk catalog upload**: the allow-set is built from existing unarchived
    `skills` rows plus any `skills` entry created by the same upload, so a title
    may reference a skill it authors in the same batch; a reference that is neither
    an unarchived existing skill nor a same-upload skill is rejected up front with
    400 `invalid_config` before any write.
  - **Trusted-backup character import path**: importing an old backup runs no
    write-time reference validation on a title's granted-skill references. A
    reference to a skill that no longer exists (or is archived) is simply skipped
    at read time; the unresolved grant is never invented and never errors the
    import.
- **No migration required.** `grantedSkillStableIds` lives in the existing
  `catalogDefinition.config` JSON blob and is read live; there is no new column,
  no schema migration, and no backfill. A legacy title config that predates the
  field reads back as `undefined` (the service treats it as granting nothing), and
  no existing character association is rewritten on load.

## Ranked title improvement (sequential)

### Catalog editor

Administrators configure ranked titles with the Ranked series controls rather
than editing JSON: choose a series ID (existing IDs are suggested, and new IDs
are allowed), rank 1-100, and minimum race grade G-S. The editor writes
`improvement` and its matching `upgradeGroup` together. Turning ranking off
removes those fields only when the upgrade group matches the ranking; a
different manual upgrade group is retained. The title catalog groups ranked
entries under expandable series rows ordered by rank. Search matches individual
titles within their series, and archived titles remain available via Show
archived.

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
  additive - no two series ranks coexist. A ranked title's `grantedSkillStableIds`
  apply only for the current linked rank; the displaced prior rank's grants never
  accumulate (see "Title-granted passive skills" above).
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
