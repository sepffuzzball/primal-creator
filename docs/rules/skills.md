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

## Engine note

Skill rarity is used as a qualitative scale. The engine should treat the rarity
ladder and the milestone schedule as **data/configuration**, not as hard-coded
formulas, since neither is pinned by a source table.
