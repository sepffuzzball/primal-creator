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

## Engine note

Skill rarity is used as a qualitative scale. The engine should treat the rarity
ladder and the milestone schedule as **data/configuration**, not as hard-coded
formulas, since neither is pinned by a source table.
