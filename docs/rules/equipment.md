# Equipment

## Source & status

- No standalone `Equipment` page exists on The Primal Hunter Wiki (verified via
  the MediaWiki API: `action=parse&page=Equipment` returns `missingtitle`).
- Equipment data lives on `https://the-primal-hunter.fandom.com/wiki/Jake_Thayne/Equipment`
  (page id 407, fetched via API on 2026-10-12).
- The **rarity tier** scale is verified from that page. The **grade-based drop/
  quality percentages** are **house assumptions** (not quoted by any source).

## Verified (from `Jake Thayne/Equipment`)

- Equipment is tabulated by **slot** (e.g. Head, plus weapon slots) with name,
  rarity, and description.
- Equipment uses the same **rarity tiers** as skills, including at least:
  Inferior, Common, Uncommon, Rare, Epic, Ancient, Legendary, Mythical, Unique.
  Example entries: "Mask of the Golden Forest King (Unique)", "Venomfang (Rare)",
  "Windsorrow Bow (Rare)".
- Entries carry a **numeric tier/value** (e.g. 18, 63, 97, 188, 193, 196, 280).
  The meaning is not explicitly titled on the page; treat as item quality/level
  value (wiki-uncertain).
- Entries reference **level requirements** such as "Lvl 45+ in any humanoid race",
  and **grade-tagged materials** such as "a cloak born using a B-grade Chimera",
  "tempered leather from a powerful E-grade beast", and "for anyone below C-grade".

## Wiki-uncertain

- The exact meaning of the numeric column (value vs. level vs. quality).
- Whether equipment rarity/effect scales by grade in a quantifiable way, and the
  actual **probability distribution** of dropping a given rarity/grade.
- The general list of equipment slots (the page is Jake-specific).

## House assumptions (configurable, pending citation)

The following are **requested default assumptions**, not canon:

- **Individual equipment grade rate: 20%** - the probability an individual piece
  of equipment is treated as belonging to a given grade band.
- **Combined equipment rate: 15%** - the probability used when combining/rolling
  multiple pieces together.

Both are configurable and documented in `docs/rules/assumptions.md`. The engine
should treat these as parameters, not as sourced constants, and should not assert
them as canon without a source citation.
