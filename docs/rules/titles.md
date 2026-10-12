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
