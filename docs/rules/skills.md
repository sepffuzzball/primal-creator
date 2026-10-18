# Skills

## Source & status

- Source: `https://the-primal-hunter.fandom.com/wiki/Skills`.
- The rarity tier ladder is **inferred** from many examples (wiki-uncertain as a
  formal registry). The **skill selection model** is a house choice, informed by
  the source.

## Verified

- Skills have **rarity tiers**. Observed tiers (in ascending order of power)
  include: Inferior, Common, Uncommon, Rare, Epic, Ancient, Legendary, Mythical,
  Unique. (Tier ordering inferred; the wiki orders by "rarity is a measure of
  power".)
- **Skill Rarity Adjustment:** when a being evolves from D-grade to C-grade, their
  skills undergo a rarity adjustment to match the user's current grade, which may
  lower a skill's rarity. This does **not** reduce the skill's capabilities, only
  its rarity. (Evidence: a real adjustment in the source text: "Supreme Stealth
  Attack (Epic) --> (Rare)".)
- **"Any skill can only be chosen once."**
- Skills are **grade-free**: a `skills` catalog entry carries no catalog `grade`
  band and no `gradeDescriptions` ladder (migration 20261017200000_skill_grade_removed
  cleared any authored values and first archived them into the migration-only
  `legacy_skill_grade_metadata` audit table). The `description` is the single
  authored prose for the skill; eligibility at an offer is by config `track`
  only, never a catalog grade. The grade at which a skill was earned is retained
  as **provenance only** (`earnedGrade`) - it is recorded on the offer and never
  gates any later behavior.
- Skills are attached to Starting Skills of classes/professions and to learned
  choices; some skills are granted through blessings and bloodlines (see
  `docs/rules/blessings.md` and `docs/rules/bloodlines.md`).
- A skill may also be granted **as a passive effect only** by an equipped
  `equipment` item or an attached `titles` entry via the joint
  `grantedSkillStableIds` config (see `docs/rules/equipment.md` and
  `docs/rules/titles.md`). This is not a permanent acquisition: no `SKILL`
  association is created, no milestone offer is produced, and the grant ends the
  moment the item/title is removed or loses eligibility.

## Wiki-uncertain

- The exact rarity ladder as a closed, canonical ordered list (the wiki lists known
  skills but several appear without descriptions, and the list is story-driven).
- The exact milestone schedule at which skill choices are offered (the wiki lists
  skills, not a per-level/per-grade "you may now choose" table).

## House assumption

The project models skill acquisition as **offered choices at milestones**, not
automatic awards. A milestone is a defined level or grade transition; at that point
the participant is presented a set of options and chooses. This is a project
decision, documented in `docs/rules/assumptions.md`, and aligns with the source
notion that skills are chosen rather than simply granted.

## Milestone offers (implemented model)

Skills are **offered, never auto-awarded**. The exact milestone schedule and skill
rarity ladder are treated as **data/configuration**, not hard-coded formulas, since
neither is pinned by a source table. The schedule is encoded per skill in the
catalog `config`; the service reads it live.

A `skills` catalog entry's config supports (all optional except `track`, which is
mandatory on a NEW or CONFIG-CHANGED entry; legacy entries missing it are read as
`"race"` by the migration backfill and an unknown track is read safely and ignored
for offers):

```ts
{
  // The advancing track this offer applies to: "race" | "class" | "profession".
  // Mandatory on a NEW or CONFIG-CHANGED skill. A legacy entry that predates the
  // mandatory track is backfilled to "race" by migration 0023 (in the archived
  // 0001..0023 chain, replaced by the 0.1.0 baseline); an arbitrary legacy
  // string is read safely and ignored for offers.
  track: "race" | "class" | "profession",
  // Optional legacy annotation: the track level at which this skill is offered.
  // No longer gates eligibility - a scheduled credit offers any matching-track skill
  // at any milestone of its track. Kept only as a readable legacy hint.
  milestone?: number,
  // Choice group the skill belongs to; options sharing a group are offered
  // together (defaults to "standard" when absent). IGNORED for a scheduled credit,
  // which always collapses into a single "standard" offer.
  choiceGroup?: string,
  // Restrict this skill to the selected class/profession catalog stableId. When
  // present - even as an empty array - the restriction applies via `includes`;
  // an empty list offers nothing, while an absent list imposes no restriction.
  // IGNORED for a scheduled credit (all matching-track skills are eligible).
  eligibleDefinitionStableIds?: string[],
  // Optional class tie. Priority-ONLY: a skill whose `classStableId` matches the
  // offer's snapshotted `classStableIdAtEarn` sorts FIRST among the offer options;
  // a nonmatching class-tied skill is still offered (never hidden), only later.
  // Never restricts eligibility. Must reference an existing class; a NEW selection
  // must be an ACTIVE class (an unchanged prior reference to an archived class is
  // tolerated).
  classStableId?: string,
  // Ordered rarity tier (Inferior..Divine, plus the incomparable `Unique`).
  // A NEW or CONFIG-CHANGED skill must declare a valid rarity; a legacy entry
  // without one stays readable and metadata-only-editable. Rarity is a display
  // badge and drives ONLY the legacy `upgradeGroup` fallback; it never gates a
  // declared `upgradeToStableIds` edge.
  rarity?: "Inferior" | "Common" | "Uncommon" | "Rare" | "Epic" | "Ancient"
    | "Legendary" | "Mythical" | "Sacred" | "Divine" | "Unique",
  // Declarative passive effects synthesized live into the character's status.
  effects?: Array<{
    phase: "flat" | "percent",
    amount?: Record<string, number>,      // flat (signed integers allowed)
    basisPoints?: Record<string, number>, // percent (non-negative integer bps)
    condition?: { kind: "always" } | { kind: "levelAtLeast"; track: string; level: number }
      | { kind: "gradeAtLeast"; grade: string },
    stacking?: "replace" | "stack" | "stackCapped",
    group?: string,
  }>,
  // Replacement group: acquiring a skill in this group never stacks with another
  // linked (or offered) skill in the same group; the superseded tier is removed.
  // This is used ONLY on select/grant to remove superseded linked skills. It is
  // never used as a GameEffect replace group: each `effects[].group` is the
  // per-effect stacking/replace group and is preserved as-is, so a single skill's
  // flat AND percent effects both apply.
  upgradeGroup?: string,
  // DIRECT outgoing successor skill stableIds (the skill upgrade graph). ABSENT
  // means the legacy `upgradeGroup` + `rarity` fallback resolves the successor at
  // runtime; an explicit `[]` means the skill is terminal (no successor, no
  // fallback); a nonempty list declares explicit targets - a skill may branch to
  // several. An edge is authoritative: the runtime ignores rarity, track and
  // upgrade group when following a declared edge, so a same-rarity, lower-rarity,
  // `Unique`, cross-group or cross-track target is allowed. Each id must be a
  // nonempty string and internally unique; the list is capped at 50. A self-link,
  // a missing/wrong-kind target, a duplicate stableId or a cycle through the
  // explicit-edge graph is a GRAPH error (validated by `validateSkillUpgradeGraph`),
  // not a config-shape error.
  upgradeToStableIds?: string[],
}
```

- A **NEW or CONFIG-CHANGED skill must declare a `track`** (`"race"`, `"class"` or
  `"profession"`). A config missing `track` is rejected by the service with
  `invalid_config`; the migration 0023 (archived `0001..0023` chain) backfills a
  missing `track` in persisted
  `skills` rows to `"race"` so a legacy entry stays readable without authoring
  every one. `milestone` is now an optional legacy annotation with no paired
  requirement and no offer gating.
- When a character **levels up** a class/profession track **or an independent
  (monster) race**, the service queries the unarchived `skills` catalog and keeps
  only entries whose config `track` **exactly** matches the advanced track. A skill
  carries no catalog grade band (migration 20261017200000_skill_grade_removed
  cleared it), so it is never filtered by the earned grade - eligibility is by
  config `track` ONLY, and a legacy skill row that still holds a non-null `grade`
  is still matched. The skill's `milestone` and `eligibleDefinitionStableIds`
  are legacy annotations **ignored** for a scheduled credit: every matching-typed
  skill is offered at any credit milestone. The `choiceGroup` is also ignored - all
  surviving options collapse into the single `"standard"` offer.
- The surviving entries are ordered deterministically **before insert**: a skill
  whose `classStableId` matches the offer's snapshotted `classStableIdAtEarn` (the
  character's selected CLASS at EARNING time) sorts first (class tie), then by name
  casefold, then stableId, then id. A nonmatching class-tied skill is never hidden -
  it merely sorts after a class match. Provenance (`earnedGrade`,
  `trackDefinitionStableId`, `classStableIdAtEarn`) is persisted on the offer;
  legacy/imported offers are never backfilled. **Exactly one offer per credit** is
  created (unique on character/track/level/choiceGroup) and carries read-only option
  snapshots (name + config), so a later catalog edit never rewrites what the
  character was actually offered. Quarter-only advances produce no offers.
- At read time each snapped option is exposed with a **live** `description` (the
  current catalog definition's `description` - a skill carries no authored
  grade-specific prose; only on a legacy skill row that still carries authored
  `gradeDescriptions` is the text at the offer's snapshotted `earnedGrade`
  preferred, else the `description`, and `null` when no linked definition
  resolves) alongside **snapshot-only** `rarity`, `skillType` and `classStableId`
  badges (each read from the immutable `configSnapshot`, never the live catalog
  config; a legacy snapshot's `skillType` falls back to the offer's own track). A
  later catalog edit therefore never relabels the badges of what the character was
  actually offered, while the freshest authored prose is still surfaced.
- The player (or an admin) **selects** one option from a pending offer; that links
  the skill as a character association (kind `SKILL`) and stamps the offer
  `selected`. Administrators can also **grant** a skill manually (provenance
  `manual`), which requires a non-empty reason. Selecting or granting a skill in an
  `upgradeGroup` atomically removes every linked skill in that group - superseded
  tiers never stack.
- Selecting or granting a skill that would replace one or more linked skills in
  the same `upgradeGroup` is **monotonic in rarity**: the incoming skill must be
  an ordered rarity strictly higher than EVERY linked skill it removes. A target
  with a missing or incomparable (`Unique`) rarity, a removed link with a missing
  or incomparable rarity, or a target that is not strictly higher is rejected with
  400 `skill_rarity_not_higher` and nothing is written. Skills with no group (or
  with no removable same-group links) are unaffected.
- A NEW or CONFIG-CHANGED skill must declare a valid `rarity` (the same ordered
  vocabulary as equipment: Inferior..Divine plus the incomparable `Unique`). A
  legacy skill without a rarity remains readable and metadata-only-editable; the
  service rejects a new/config-changing write that omits it with `invalid_config`,
  and the catalog-import `assertModernConfig` gate enforces the same for a NEW
  manifest skill.
- The **explicit upgrade endpoint** (`POST
/api/characters/[id]/skills/upgrade`, owner or admin) takes
  `{sourceDefinitionId?, definitionId, version, reason}` where `reason` is a
  mandatory at-most-500-character note. A linked skill may be upgraded **at any
  time** - there is no level/XP gate and no cost. Two flows are supported:
  - **Explicit-edge source.** The caller may name the exact source to upgrade
    from (`sourceDefinitionId`). When the named source's config declares its OWN
    `upgradeToStableIds` field (including `[]`), the target `definitionId` MUST
    be directly listed there: the upgrade follows the declared edge with NO
    rarity / rank / track / group gate, so a same-rarity, lower-rarity, `Unique`,
    cross-group or cross-track target is allowed. An explicit `[]` source is
    terminal, so any target is rejected. The CHOSEN source link is removed
    exactly once and its event recorded; the source may be an archived catalog
    entry (its config is still read), but the target must be an active
    (unarchived) `skills` entry. A nonempty target `upgradeGroup` that would
    collide with ANY OTHER still-linked skill is rejected (`link_collision`)
    rather than deleting that skill. Rejections are 400 `skill_upgrade_edge_missing`,
    `catalog_archived`, `skill_source_not_linked`, and 409 `link_collision`.
  - **Legacy target-only source (omitted).** When `sourceDefinitionId` is
    omitted, the legacy same-group flow applies ONLY when every eligible linked
    source is legacy (no own `upgradeToStableIds`); an explicit-edge source must
    be named by the caller rather than silently removed, else 400
    `skill_source_required`. The target must carry a valid ordered `rarity` and
    a nonempty `upgradeGroup`, and the character must hold EXACTLY ONE other
    linked skill in that group with a strictly lower ordered rarity; that link is
    replaced (never stacked). Same / missing / incomparable (`Unique`) /
    ambiguous (zero or multiple same-group links) / not-strictly-higher cases
    are all rejected with 400 `skill_rarity_not_higher`. The removed source link
    may be an archived catalog entry - its config is still read.
    The replacement runs atomically (SERIALIZABLE, CAS version increment, no XP
    cost), and the immutable `skill_upgrade` event snapshots the from/to stable ids,
    names, rarities, descriptions, the reason and the removed-link record.
- A catalog config edit that would change a **linked** skill's `rarity` or
  `upgradeGroup` is rejected with 409 `skill_rarity_conflict` (no write, prior
  snapshots never silently adjusted); metadata and description edits, and config
  edits that keep the rarity/group stable, are allowed. The check runs after the
  `link_collision` check, so a genuine group collision still reports
  `link_collision` first.
- A skill selected through an offer or granted manually is **not** stored in
  `Character.state`. Its passive effects are **synthesized live** from the current,
  unarchived catalog config at read time (history stays immutable), the same way
  titles/equipment effects are. Editing a skill's `effects` recalculates the live
  status without rewriting historical awards. An archived linked skill contributes
  no effect and is shown as unavailable.
- A **legacy `track` string** that is not `"race"` / `"class"` / `"profession"` is
  read safely (no parse error) and ignored for offers; a NEW or CONFIG-CHANGED skill
  must use the enum value or the service rejects it with `invalid_config`.
- A NEW or CONFIG-CHANGED skill that declares an optional **`classStableId`** must
  reference an existing `classes` catalog entry. A **prior** reference (the skill
  already ties to that same class) may be an archived class, but a **NEW** selection
  (a value that differs from the existing config) must reference an **active** class,
  and a create always requires an active class. On import paths the class may be
  authored by the same upload. The class tie drives **option ordering only** - it
  never restricts eligibility (a nonmatching class-tied skill is still offered, just
  later). Renaming a class's `stableId` is rejected with 409 `class_stable_id_in_use`
  while any skill config's `classStableId` still names the old id, so the class-tie
  priority is never silently defanged (archiving a class is always allowed).
- A catalog config edit that would put two **already-linked** skills on the same
  character into the same `upgradeGroup` is rejected with 409 `link_collision`
  (atomic rollback), just like an equipment `slot` or title `upgradeGroup`
  collision. Archived definitions are inert and never collide.
- A character **import** that restores an old backup is allowed to carry skills
  whose config has a legacy / missing rarity (snapshot restore) and to carry a
  higher-rarity variant with no prior same-group link; only a genuine same-group
  collision is rejected (`import_link_collision`), as before.

## Skill upgrade graph (directed branching)

A skill's successor is resolved either by a declared DIRECT edge or by the legacy
fallback:

- **`upgradeToStableIds` ABSENT** - the legacy `upgradeGroup` + `rarity` fallback
  applies: the runtime orders the skill's `upgradeGroup` members by rarity and
  derives the next strictly-higher rarity as the successor.
- **`upgradeToStableIds: []`** - the skill is explicitly terminal: no successor at
  all, and no fallback.
- **`upgradeToStableIds: [id..]`** - explicit direct successor targets; a skill may
  branch to several.

Rarity and track never matter to an edge: a same-rarity, lower-rarity, `Unique`,
cross-group or cross-track target is allowed. Because an edge is authoritative,
following it ignores the `upgradeGroup` / `rarity` ladder and can move across
groups or tracks.

- **Validation.** Every skill write (catalog import and the MCP publisher)
  validates the FINAL superimposed skill-upgrade graph across EVERY node,
  archived ones included, via `validateSkillUpgradeBatch`
  (`validateSkillUpgradeGraph`). Rejected in order: a duplicate stableId; a
  self-link (`skill "X" lists itself in upgradeToStableIds`); a target that does
  not resolve to a skill node (`skill "X" upgrades to missing stableId "Y"`); and
  a cycle through the explicit-edge graph (`cycle detected: X -> Y -> X`). A NEW
  or CHANGED outgoing edge of a proposed node that targets an ARCHIVED final node
  is rejected (`skill "X" upgrades to archived skill "Y"`); an UNCHANGED
  reference to an archived target stays allowed, including when the same batch
  archives that target.
- **Grouping.** Skills are grouped for display by their connected upgrade
  component - the weakly-connected components of the explicit-edge graph
  (`skillUpgradeComponents`) - so an edge chain/branch is shown as one group, and
  a node with no explicit edges is a singleton component. A skill that declares no
  `upgradeToStableIds` falls back to its legacy `upgradeGroup` for successor
  derivation, which keeps it connected to its same-group family. Archived and
  active nodes are treated equally.

## Skill-choice credit schedule (per grade)

In addition to the per-skill `milestone` entries, a class/profession track level-up
**or an independent (monster) race level-up** may award a skill-choice **credit** on
a **grade-keyed configurable schedule**, even when the catalog contains zero
matching skills at that level. House rules `skillChoiceIntervals` map each grade
(G/F/E/D/C/B/A/S) to the number of levels between credits (each an integer
`1..250`). When a track levels up, the service consults the pure helper
`isSkillChoiceMilestone(grade, level, intervals)`; on a milestone it creates exactly
one `choiceGroup: "standard"` offer for that `(track, level)`, even with zero
eligible skills.

The schedule uses the **stored track grade** when present (authoritative); a legacy
ungraded track falls back to its **race grade**. For a monster race the earned grade
is the race's own grade and the track stableId is the race's catalog stableId (the
race identity is preserved across evolution, never re-derived). A monster earns a
race skill offer and never a class/profession offer. Entries:

| Grade | Skill-choice entry | Default interval |
| ----- | ------------------ | ---------------- |
| G     | 0                  | 5                |
| F     | 0                  | 5                |
| E     | 25                 | 5                |
| D     | 100                | 20               |
| C     | 200                | 30               |
| B     | 350                | 40               |
| A     | 500                | 50               |
| S     | 750                | 60               |

A credit is earned only when ALL of these hold: `level > entry`;
`(level - entry) % interval === 0`; and `level` is within the grade's applicable
band, whose upper bound is EXCLUSIVE of the next grade's skill-choice entry (for a
non-S grade) or the grade's own inclusive band max (999, for the top grade S). The
grade's own entry never counts. A grade never awards merely for reaching its own
entry, and never awards at or past the next grade's entry - so an E-grade level-100
(whose next grade D begins at 100) does not earn an E credit, and a D-grade
level-200 (C begins at 200) does not earn a D credit.

**G is special** because its next grade is F and F's skill-choice entry is 0 - the
same as G's own entry - so the "next grade's entry" cannot be the upper bound (it
would cap every G level). Instead G caps at the F band's published max (24),
exclusive: a G-grade track credits on the same cadence as F (levels 5/10/15/20 with a
G interval of 5) and never credits at the move into the next band (level 25). This
deliberately differs from the grade-band `entryLevel` (0 for G, 10 for F); the
skill-choice schedule overlays its own semantics.

At a credit milestone the offer options come only from unarchived skills whose
config `track` equals the advanced track. A skill carries no catalog grade band,
so it is never filtered by the earned grade - eligibility is by config `track`
ONLY. The skill's `milestone`, `choiceGroup` and
`eligibleDefinitionStableIds` are all **ignored** at a credit milestone: every
surviving skill collapses into the single `"standard"` offer (which is created even
when the list is empty). Credits are never multiplied per matching skill. Options
are ordered deterministically (class tie first, then name, then stableId, then id)
using the offer's snapshotted `classStableIdAtEarn`.

## Refreshing a pending scheduled credit (POST /api/characters/[id]/skills/refresh)

A scheduled (milestone) credit offer may be created at a level-up when the catalog
already contains zero matching skills (a zero-option credit). If a matching skill is
**authored later**, that offer does not automatically learn about it - the option set
was snapshotted at award time and the service never rewrites history. A refresh
exists to close that gap: it re-queries the unarchived `skills` catalog and appends
**only genuinely new eligible options** to each still-**pending scheduled** offer.

- **Which offers.** Only offers with schedule-credit provenance (`earnedGrade` and
  `trackDefinitionStableId` both set) that are still active (not selected, not
  canceled) are considered. A legacy offer lacking provenance is left untouched.
- **Eligibility is identical to the original credit** (shared helper,
  `skillDefMatchesScheduledOffer`): only the config `track` must be exact - a skill
  carries no catalog grade band, so the saved earned grade never filters it. The
  `milestone` / `choiceGroup` / `eligibleDefinitionStableIds` annotations are
  ignored, and archived skills never appear. The appended options are re-sorted
  deterministically in the returned view (class tie matching the offer's
  `classStableIdAtEarn` first, then name casefold, then stableId, then id); a
  nonmatching class-tied skill is never hidden.
- **Immutability.** Existing option snapshots are never modified, even if the skill
  has since been edited or archived. Only new rows are appended; the DB unique
  `(offerId, definitionId)` plus `createMany({ skipDuplicates: true })` make a
  repeated refresh idempotent (no duplicates accumulate).
- **No CAS bump / no journal.** Refreshing only appends snapshot rows - it does NOT
  increment the character `version`, does not write a `progressionEvent`, and returns
  the reloaded character detail. It is owner/admin-only.
- **Concurrency with selection.** The refresh runs SERIALIZABLE. A selection that
  commits between the refresh's pending-offer read and its append can surface as a
  retryable 409 `serialization_conflict` (the transaction is rolled back, so no
  stray options are left behind). Appending to an offer that was selected mid-race is
  also harmless - it is an extra immutable snapshot; a retry filters the now-selected
  offer out, so options are never appended after a selection.

## Offer cancellation (append-only) and re-offer

A pending skill offer is **append-only**: it is never deleted or rewritten. It may
be **canceled**, which stamps `canceledAt` on the row while leaving the historical
snapshot (offered options, selection) intact. A canceled offer stays visible to the
character as a historical record but is no longer selectable - answering it is a
409 `offer_canceled`. This is the prerequisite for EXP undo: undoing a level that
awarded an offer cancels the then-pending offer rather than deleting it, so the
history of what was offered (and when) is preserved.

- A **level-up undo** (`operation: "undo"`, see `docs/rules/leveling.md`) cancels
  each pending offer the level-up created: it stomps `canceledAt` on the offer ids
  recorded in the level-up journal (`skillOfferIds`), leaving the row and its option
  snapshots untouched. If the undo's journal does not carry offer ids (a legacy
  event), it cancels the active pending offers for the same `(track, level)` only
  when they are the sole active set; a **selected** offer (or an already-canceled
  one) blocks the undo with 409 `level_undo_blocked`.
- A canceled offer is never deleted; re-earning the level re-offers as described
  below.

- Each offer carries an `offerId`-independent `generation` (non-negative integer,
  default 0) that counts successive offers for the same
  `(characterId, track, level, choiceGroup)` base key. The initial offer is
  generation 0.
- **Re-offer on a re-earned level:** when a character re-earns a level, the
  service first checks for an existing **active** (`canceledAt` null) offer for
  that base key. If one exists, it is preserved and no new offer is created. If
  none exists (the prior offer was canceled), a new offer is created as the next
  generation (`max existing generation + 1`), with fresh option snapshots from the
  current unarchived `skills` catalog. The canceled offer and its snapshots are
  never modified - only superseded.
- At most **one active** offer may exist per base key at any time; multiple
  generations may coexist as historical (canceled) records.

## Backup import (v7)

The current backup schema is `primal-character/7`, and every exported skill offer
carries the full append-only offer state: a non-negative `generation` and a
nullable `canceledAt`. A scheduled offer additionally carries the schedule-credit
provenance `earnedGrade` (the grade whose skill-choice interval awarded the offer),
`trackDefinitionStableId` (the selected track's catalog stableId at the moment the
credit was earned) and `classStableIdAtEarn` (the character's selected CLASS
snapshotted at EARNING time for a class/profession credit, null for a monster race
credit) - the grade/track pair are emitted **together**, and `classStableIdAtEarn`
is emitted within that same provenance block (it is nullable and omitted on a
legacy offer, whose backup shape is unchanged). The importer persists all three
columns and validates the pair: a malformed grade, an empty stableId, or one
present without the other is rejected; `classStableIdAtEarn` only needs to be
nonempty when present. A legacy v6 backup
(`primal-character/6`) carries the same append-only offer state (but no provenance,
which reads back as null), while a v3/v4/v5 backup omits both `generation` and
`canceledAt` and the importer defaults them to `0`/`null`. A current backup is never
"rewound": the importer preserves every offered option snapshot verbatim and
restores canceled offers as canceled (so a restore does not re-activate a canceled
offer or restamp its cancellation time). Legacy `primal-character/3` through `/6`
backups are still accepted, but only when they carry no `blessing` association - the
legacy `blessings` catalog kind was retired, so a legacy doc with an old blessing
link is rejected with an actionable 400 migration notice even when it would
otherwise resolve. The importer rejects:

- a **duplicate** `(track, level, choiceGroup, generation)` key
  (`import_duplicate_offer`),
- more than **one active** offer for the same base key (`import_offer_conflict`),
  and
- a row that is both **selected and canceled** (`import_selected_canceled`).

## Per-grade automatic skill grants

Alongside the milestone `choice` model, a race/class/profession catalog config may
declare **automatic** grade-granted skills via `gradeGrantedSkillStableIds`. This is
an optional, grade-keyed map; a missing or `{}` value means the entry declares no
auto-grant (it reads back as an empty map, never a fabricated list). The field is
optional and only meaningful on `races` / `classes` / `professions` configs.

```ts
{
  // Grade-specific automatic skill grants, keyed by the grade ladder (G..S).
  // Each list holds `skills` catalog stableId entries granted automatically at
  // the moment the character reaches that grade. Keys are STRICT (only G..S are
  // accepted; a typo like "H" is rejected). Each list must be internally unique
  // and every id nonempty.
  gradeGrantedSkillStableIds?: Partial<Record<Grade, string[]>>,
}
```

- **When the grant fires.** On character **create** the service applies the race
  entry at `state.race.grade` (G for an integrated character, the race's natural
  grade for a born one) and the class/profession entries at their OWN starting
  track grade. On **profession assignment** it applies the profession entry at the
  grade the newly assigned track is stamped with (the character's current race
  grade). On **evolution** it applies the entry at the TARGET grade of the NEW
  selected catalog definition. The race, then class, then profession grant order is
  deterministic. A monster race has no class/profession tracks, so only the race
  grant applies.
- **Resolution.** Each referenced stableId must resolve to an existing, unarchived
  `skills` catalog definition. A missing or archived reference is never a hard
  failure at acquisition - it is **skipped** and journaled (never invented, never
  crash an otherwise-valid create/profession-set/evolve). A NEW or CONFIG-CHANGED
  race/class/profession write runs the same resolution against the live catalog and
  REJECTS a missing or archived reference with `invalid_config` up front (an
  archived skill would render the grade grant permanently inert); the import
  paths build an allow-set so a skill authored by the same upload/import counts as
  unarchived.
- **Persistence.** A granted skill is linked as an ordinary `CharacterAssociation`
  (kind `SKILL`) and acquired ONCE per definition; it is never re-offered at a
  later milestone. The acquisition does not store the skill in `Character.state`
  and offers no milestone `skillOffer` - it is a direct link, synthesized live like
  any other SKILL association.
- **Duplicate / upgrade policy.** Requesting a skill that is ALREADY owned - either
  the exact same skill, or another skill whose `upgradeGroup` collides - does not
  stack. The collision is resolved by searching the upgrade group's current
  unarchived skills for the NEXT authored rarity STRICTLY HIGHER than the strongest
  owned skill in the group (the ordered ladder Inferior, Common, Uncommon, Rare,
  Epic, Ancient, Legendary, Mythical, Sacred, Divine; `Unique` is incomparable and
  never strictly higher). When such a skill exists it replaces the owned skill(s)
  (one-group invariant preserved); when no eligible authored upgrade exists the
  owned skill is retained and the request journals a no-op. Ties at the same lowest
  eligible rarity break on stableId lexicographic order.
- **Journaling.** The `create`, `profession_set` and `evolve` journal entries carry
  a `skillGrants` snapshot (present only when the acquisition actually granted or
  attempted a grade skill) with `granted`, `upgraded`, `noop`, `skipped` and
  `superseded` arrays, each recording the stableId (and name where known) plus the
  source grade. A failed/missing reference is always listed in `skipped`, never
  omitted. When MULTIPLE track grants fire in the same transaction (race+class or
  class+profession), the journal is reconciled against the FINAL persisted plan so
  it never claims the acquisition wrote a link it did not:
  - `granted` lists only links that are actually persisted and had NO pre-existing
    same-group source displaced - including a final link that a later in-transaction
    chain of same-group plans resolved to.
  - `upgraded` is written ONLY when a real same-group link that was persisted before
    the transaction is displaced; it reports the actual pre/post transition from
    that persisted source to the final link (never an "upgrade" from an
    intermediate the same transaction planned but never wrote).
  - `superseded` records every intermediate a transaction planned but never
    persisted (e.g. a Common tier planned at a race grade that a later class grant
    upgraded away), once each, with its ORIGINAL planned grade.
  - A skill that was planned as a `granted` link but was upgraded away by a later
    grant in the same acquisition is reported as `superseded` (with its originating
    grade), never as a live `granted` link. Only skills actually persisted appear
    under `granted`/`upgraded`, and no journal entry claims a displaced source is
    still linked.
- **Rename block.** Renaming a `skills` stableId is rejected with 409
  `skill_stable_id_in_use` while ANY race/class/profession config's
  `gradeGrantedSkillStableIds` (for any grade, including an archived track row)
  still names the old id - otherwise the grade grant silently dangles and the skill
  is silently skipped at acquisition. Archiving a skill is always allowed (an
  archived granted skill is simply inert). The same rename guard also covers
  equipment `grantedSkillStableIds` references.
- **Legacy / export.** A config that predates the field grants nothing (it reads
  back as `[]`/an empty map). No retroactive grant is issued on import: the
  exported association links remain the existing backup model, and importing a
  backup never re-creates a grade-grant that was not already linked.

## Engine note

Skill rarity is used as a qualitative scale. The engine should treat the rarity
ladder and the milestone schedule as **data/configuration**, not as hard-coded
formulas, since neither is pinned by a source table. The skill upgrade graph
(`upgradeToStableIds`) is likewise data: the engine follows declared DIRECT edges
verbatim and falls back to the legacy `upgradeGroup`/`rarity` ordering only when a
skill declares no edge, never synthesizing a successor on its own.
