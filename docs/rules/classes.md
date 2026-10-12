# Classes

## Source & status

- Source: `https://the-primal-hunter.fandom.com/wiki/Classes`.
- Class **stat-cap** numbers are verified; the exact canonical enumeration of the
  six F-grade primary classes is only partially captured (wiki-uncertain in
  detail).

## Verified

- Classes are the **combat-focused** method of progressing through the system.
  They typically focus on killing enemies for experience. Their counterpart,
  `Profession`, focuses on non-combat growth.
- At **F-grade** a participant chooses from a small number of primary classes;
  although there is an uncountable number of classes, they derive from **6 primary
  ones** chosen at F grade. The wiki shows descriptions for the Warrior variants
  (Light, Medium, Heavy), a ranged/archer path, a Caster, and a Healer.
- Classes grant per-level stat bonuses and **Starting Skills** (e.g. Basic
  Archery, Mana Bolt, Heal). The starting skills are of low rarity (Inferior/
  Common).
- **Per-level stat caps** for classes are published per grade:
  - E-grade: max stats per level for a class without restrictions is **28**; with
    severe restrictions it is **34**.
  - D-grade: max with severe restrictions is **100**; stated to imply
    approximately **84** without restrictions.
- Classes upgrade across grades (F -> E -> D -> C -> B), and the specific upgrade
  lines grant larger per-level bonuses (e.g. Ambitious Hunter -> Avaricious
  Hunter, and the B-grade "Hunter-Champion of the Malefic Viper" lines).

## Wiki-uncertain

- The exact names of all six primary F-grade classes and their canonical ordering.
- Which classes are available at each grade for a generic creator (the wiki's
  examples are heavily Jake Thayne specific).
- The per-level stat caps for grades other than E and D are not given.

## Engine note

The engine should treat class as a progression track with per-level stat bonuses
and a grade-based **cap** that limits how much can be added in a grade. The cap
distribution is a house choice (see `docs/rules/assumptions.md`). No invented
formula is used to derive the caps; E-grade (28/34) and D-grade (84/100) are used
as sourced anchors where available.
