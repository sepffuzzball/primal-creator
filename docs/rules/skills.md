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
- Skills are attached to Starting Skills of classes/professions and to learned
  choices; some skills are granted through blessings and bloodlines (see
  `docs/rules/blessings.md` and `docs/rules/bloodlines.md`).

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

A `skills` catalog entry's config supports (all optional, or partial for legacy
entries that remain readable/editable as metadata-only):

```ts
{
  // The advancing track this offer applies to: "class" | "profession".
  // Legacy entries may carry an arbitrary string; it is read safely and ignored
  // for offers. A NEW or CONFIG-CHANGED skill must use the enum value.
  track?: "class" | "profession",
  // The track level at which this skill is offered (non-negative integer).
  milestone?: number,
  // Choice group the skill belongs to; options sharing a group are offered
  // together (defaults to "standard" when absent).
  choiceGroup?: string,
  // Restrict this skill to the selected class/profession catalog stableId. When
  // present - even as an empty array - the restriction applies via `includes`;
  // an empty list offers nothing, while an absent list imposes no restriction.
  eligibleDefinitionStableIds?: string[],
  // Ordered rarity tier (Inferior..Divine, plus the incomparable `Unique`).
  // A NEW or CONFIG-CHANGED skill must declare a valid rarity; a legacy entry
  // without one stays readable and metadata-only-editable.
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
}
```

- An **offer-eligible milestone skill requires BOTH `track` and `milestone`**.
  A new/changed config that declares exactly one is rejected by the service with
  `invalid_config`; a legacy entry with neither (or a metadata-only partial) stays
  readable and editable.
- When a character **levels up** a class/profession track, the service queries the
  unarchived `skills` catalog and keeps only entries whose config `track` /
  `milestone` **exactly** match the advanced track and the reached level, whose
  explicit catalog `grade` (when set) **exactly equals** the character's current
  race grade (no inferred compatibility), and whose `eligibleDefinitionStableIds`
  (when present) includes the character's selected class/profession stableId.
- The surviving entries are grouped by `choiceGroup ?? "standard"`. **Exactly one
  offer per group** is created (unique on character/track/level/choiceGroup) and
  carries read-only option snapshots (name + config), so a later catalog edit never
  rewrites what the character was actually offered. Quarter-only advances produce
  no offers.
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
  `{definitionId, version, reason}` and upgrades the character's current linked
  skill in an `upgradeGroup` to a strictly higher-ordered rarity variant of the
  same group. The target must be an active `skills` entry carrying both a valid
  `rarity` and a nonempty `upgradeGroup`; the character must hold EXACTLY ONE
  other linked skill in that group with a strictly lower ordered rarity. Same /
  missing / incomparable (`Unique`) / ambiguous (zero or multiple same-group
  links) / not-strictly-higher cases are all rejected with 400
  `skill_rarity_not_higher`. The replacement runs atomically (SERIALIZABLE, CAS
  version increment, no XP cost), and the immutable `skill_upgrade` event
  snapshots the from/to stable ids, names, rarities, descriptions, the reason and
  the removed-link record. The removed source link may be an archived catalog
  entry - its config is still read.
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
- A **legacy `track` string** that is not `"class"` / `"profession"` is read
  safely (no parse error) and ignored for offers; a NEW or CONFIG-CHANGED skill
  must use the enum value or the service rejects it with `invalid_config`.
- A catalog config edit that would put two **already-linked** skills on the same
  character into the same `upgradeGroup` is rejected with 409 `link_collision`
  (atomic rollback), just like an equipment `slot` or title `upgradeGroup`
  collision. Archived definitions are inert and never collide.
- A character **import** that restores an old backup is allowed to carry skills
  whose config has a legacy / missing rarity (snapshot restore) and to carry a
  higher-rarity variant with no prior same-group link; only a genuine same-group
  collision is rejected (`import_link_collision`), as before.

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
nullable `canceledAt`. A legacy v6 backup (`primal-character/6`) carries the same
append-only offer state, while a v3/v4/v5 backup omits both and the importer
defaults them to `0`/`null`. A current backup is never "rewound": the importer
preserves every offered option snapshot verbatim and restores canceled offers as
canceled (so a restore does not re-activate a canceled offer or restamp its
cancellation time). Legacy `primal-character/3` through `/6` backups are still
accepted, but only when they carry no `blessing` association - the legacy
`blessings` catalog kind was retired, so a legacy doc with an old blessing link
is rejected with an actionable 400 migration notice even when it would otherwise
resolve. The importer rejects:

- a **duplicate** `(track, level, choiceGroup, generation)` key
  (`import_duplicate_offer`),
- more than **one active** offer for the same base key (`import_offer_conflict`),
  and
- a row that is both **selected and canceled** (`import_selected_canceled`).

## Engine note

Skill rarity is used as a qualitative scale. The engine should treat the rarity
ladder and the milestone schedule as **data/configuration**, not as hard-coded
formulas, since neither is pinned by a source table.
