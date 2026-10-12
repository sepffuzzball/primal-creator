# Lore & Rules Documentation

This documentation describes the source material (wiki lore/rules) that the
`primal-creator` calculation engine models, and it separates what is actually
verified from the source, what is uncertain on the wiki, and what we explicitly
chose as project assumptions.

## Research session

- **Subject:** The Primal Hunter system reference (races, grades, classes,
  professions, skills, titles, blessings, bloodlines, transcendents, evolution).
- **Research date:** 2026-10-12.
- **Source:** The Primal Hunter Wiki (Fandom): `https://the-primal-hunter.fandom.com`.
- **Access note:** Direct HTML page fetch returned HTTP 403 for most pages, so
  facts were gathered through (a) search-engine snippets and (b) the Fandom
  MediaWiki API (`/api.php?action=parse&prop=wikitext`), which is not blocked.
  Where a specific page could not be pulled in full, that detail is recorded as
  "wiki-uncertain" rather than asserted.

## Documentation set

| Path | Topic |
| --- | --- |
| `docs/lore/README.md` | This index, conventions, and source table |
| `docs/rules/grades.md` | Grade tiers, sub-stages, grade/level bands |
| `docs/rules/attributes.md` | Attributes/stats and stat gains |
| `docs/rules/leveling.md` | Leveling, XP, race-level rules |
| `docs/rules/races.md` | Races and the race-level formula |
| `docs/rules/classes.md` | Classes |
| `docs/rules/professions.md` | Professions |
| `docs/rules/skills.md` | Skills, rarity tiers, skill selection |
| `docs/rules/titles.md` | Titles |
| `docs/rules/equipment.md` | Equipment and rarity tiers |
| `docs/rules/consumables.md` | Consumables/potions |
| `docs/rules/blessings.md` | Blessings |
| `docs/rules/bloodlines.md` | Bloodlines |
| `docs/rules/transcendents.md` | Transcendents and transcendent skills |
| `docs/rules/evolution.md` | Evolution |
| `docs/rules/assumptions.md` | Consolidated project assumptions and toggles |
| `docs/architecture/calculation-engine.md` | Engine contract, phase pipeline, versioning |

## Verification conventions (used in every doc)

- **Verified** - The statement is directly supported by wiki text or the
  MediaWiki API. A source URL is given.
- **Wiki-uncertain** - The statement is inferred, only partially captured on the
  wiki, or a specific page could not be fully fetched. It should be re-checked
  against the source before being treated as canon.
- **House assumption** - A value or rule we chose for the project because no
  source states it, or because the source is ambiguous. These are **not canon**
  and are intentionally configurable. They are listed in `docs/rules/assumptions.md`.

## Source table

| Topic | URL |
| --- | --- |
| Race Level (grade bands, race-level formula, evolution gate, divine grades) | https://the-primal-hunter.fandom.com/wiki/Race_Level |
| Grades (tier sub-stages) | https://the-primal-hunter.fandom.com/wiki/Grades |
| E-grade detail | https://the-primal-hunter.fandom.com/wiki/E-grade |
| Races | https://the-primal-hunter.fandom.com/wiki/Races |
| Human | https://the-primal-hunter.fandom.com/wiki/Human |
| Jake Thayne / Race | https://the-primal-hunter.fandom.com/wiki/Jake_Thayne/Race |
| Classes | https://the-primal-hunter.fandom.com/wiki/Classes |
| Profession | https://the-primal-hunter.fandom.com/wiki/Profession |
| Skills | https://the-primal-hunter.fandom.com/wiki/Skills |
| Titles | https://the-primal-hunter.fandom.com/wiki/Titles |
| Perfect Evolution (B-grade) title | https://the-primal-hunter.fandom.com/wiki/Perfect_Evolution_(B-grade) |
| Evolution | https://the-primal-hunter.fandom.com/wiki/Evolution |
| Blessings | https://the-primal-hunter.fandom.com/wiki/Blessings |
| Bloodlines | https://the-primal-hunter.fandom.com/wiki/Bloodlines |
| Bloodline of the Primal Hunter | https://the-primal-hunter.fandom.com/wiki/Bloodline_of_the_Primal_Hunter |
| Transcendent | https://the-primal-hunter.fandom.com/wiki/Transcendent |
| Characters (gods / divine grades) | https://the-primal-hunter.fandom.com/wiki/Characters |
| Timeline (potion/alchemy work, time in grade) | https://the-primal-hunter.fandom.com/wiki/Timeline |
| Jake Thayne / Equipment (equipment data lives here) | https://the-primal-hunter.fandom.com/wiki/Jake_Thayne/Equipment |

### Where the wiki has no dedicated page

- **Equipment**: no page named `Equipment` exists (confirmed via the API -
  `missingtitle`). Equipment data lives on `Jake Thayne/Equipment`.
- **Consumables**: no page named `Consumables` exists. Potions/alchemy are
  covered by the `Profession` (crafting) and `Skills` pages plus story timeline
  entries.

## Documenting canon vs. assumptions at a glance

The project deliberately treats the source as authoritative where it speaks, and
as silent where it does not. Anything with no source is a **house assumption**
(see `docs/rules/assumptions.md`). The calculation engine never invents formulas
from thin air; it uses the sourced base values and the explicitly chosen
assumptions, all versioned (see `docs/architecture/calculation-engine.md`).
