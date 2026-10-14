/**
 * Jake Thayne catalog table for `pnpm db:seed`.
 *
 * This module carries the curated, version-controlled catalog data that the seed
 * applies to the database: the Human race table, Jake's five class progression
 * definitions, Jake's five alchemist profession progression definitions, and the
 * fifteen god names listed on the Gods wiki page. It is read by `prisma/seed.ts`
 * (never by app startup) and documented in `docs/catalog/wiki-reviewed.md` /
 * `docs/rules/{races,classes,professions}.md`.
 *
 * Provenance policy:
 *   - Every entry is `inferred`, not `verified`: the source is the fan-maintained
 *     The Primal Hunter Wiki (Fandom) - a secondary source - so nothing here is
 *     asserted as canon. (The reviewed import manifest deliberately uses the same
 *     label; this module follows the same policy.)
 *   - The gods list (name + category) is sourced from the Gods page
 *     `https://the-primal-hunter.fandom.com/wiki/Gods`; each individual sourceUrl
 *     points at the god's own wiki page. God config is left as `{}` - a god
 *     carries no numeric effect and no grade band, and the schema accepts an empty
 *     config, so no fabricated pantheon/divine-rank is asserted.
 *   - Class / profession / race per-level gains are stored as-is in `config`
 *     (e.g. `config.grades.<grade>` for a class/profession, or
 *     `config.raceDefinitions` for a race). No powers, titles or evolution paths
 *     are invented, and nothing is auto-granted to characters.
 *   - Descriptions here are concise ORIGINAL paraphrases of the source, not verbatim
 *     prose.
 *
 * Seed semantics (see `seedJakeCatalog`):
 *   - Create-only entries (the new classes, professions and every god) are inserted
 *     when their (kind, stableId) does not already exist. An existing row is
 *     PRESERVED untouched, so an admin-customized row is never overwritten and a
 *     repeated seed is idempotent.
 *   - The two legacy rows, Human (`races/human`) and Archer (`classes/archer`), are
 *     updated ONLY when every seed-owned field still equals the 0.0.2 baseline
 *     captured in the old `prisma/seed.ts` (name, description, grade, provenance,
 *     sourceUrl, archived, config - never timestamps). The find-and-update runs in
 *     a SERIALIZABLE transaction, so a concurrent admin edit that commits between
 *     the seed's read and write cannot be invisibly clobbered: the loser aborts
 *     with a serialization failure (P2034) or, on a missing-row create, a unique
 *     violation (P2002). The seed then re-reads the row OUTSIDE the transaction and
 *     preserves an admin-modified row (deferring the update) instead of overwriting
 *     it. A row that is missing is created; a row already at the replacement values
 *     is left alone.
 *   - The F-grade alchemist profession (`professions/alchemist-of-the-malefic-viper`)
 *     matches the reviewed manifest's stableId. If an admin imported the manifest
 *     first, the existing row is preserved; otherwise it is created.
 */

import {
  Prisma,
  PrismaClient,
  type CatalogKind,
  type Provenance,
} from "@prisma/client"

/** A single curated catalog entry the seed applies. */
export interface JakeCatalogEntry {
  kind: CatalogKind
  stableId: string
  name: string
  description: string
  grade: string | null
  provenance: "inferred"
  sourceUrl: string
  config: Record<string, unknown>
}

const ATTRIBUTES = [
  "strength",
  "agility",
  "endurance",
  "vitality",
  "toughness",
  "wisdom",
  "intelligence",
  "perception",
  "willpower",
] as const

function allEqual(value: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const attr of ATTRIBUTES) out[attr] = value
  return out
}

// ------------------------------------------------------------------ //
// Source URLs
// ------------------------------------------------------------------ //

const FANDOM_BASE = "https://the-primal-hunter.fandom.com/wiki/"
const JAKE_CLASS_URL = `${FANDOM_BASE}Jake_Thayne/Class`
const JAKE_PROFESSION_URL = `${FANDOM_BASE}Jake_Thayne/Profession`
const JAKE_RACE_URL = `${FANDOM_BASE}Jake_Thayne/Race`

// ------------------------------------------------------------------ //
// Race: Human (replacement + 0.0.2 baseline)
// ------------------------------------------------------------------ //

/**
 * The 0.0.2 baseline for the seeded Human row. This is what the previous
 * `prisma/seed.ts` wrote; the legacy guard compares the LIVE row against this
 * and only then updates it, so an admin edit is never clobbered.
 */
export const LEGACY_HUMAN_BASELINE = {
  name: "Human",
  description:
    "Balanced/most numerous race. Humans possess both a class and a profession. Per-grade race gains are verified for F/E/D/C/B; G is an explicit house zero (unknown), see config.houseGrades.",
  grade: "F",
  provenance: "verified" as Provenance,
  sourceUrl: "https://the-primal-hunter.fandom.com/wiki/Human",
  archived: false,
  config: {
    naturalGrade: "F",
    verifiedGrades: ["F", "E", "D", "C", "B"],
    // G is not source-confirmed; configured explicitly at zero and labeled house.
    houseGrades: ["G"],
    raceDefinitions: {
      G: { id: "human:G", perLevel: allEqual(0), freePerLevel: 0 },
      F: { id: "human:F", perLevel: allEqual(1), freePerLevel: 5 },
      E: { id: "human:E", perLevel: allEqual(2), freePerLevel: 5 },
      D: { id: "human:D", perLevel: allEqual(6), freePerLevel: 15 },
      C: { id: "human:C", perLevel: allEqual(18), freePerLevel: 45 },
      B: { id: "human:B", perLevel: allEqual(54), freePerLevel: 135 },
    },
  },
}

/**
 * The 0.0.3 baseline for the seeded Human row. This carries the same table as the
 * sourced `HUMAN_ENTRY` but WITHOUT `raceType` (which 0.0.3 did not emit). It is
 * the guard baseline the seed now compares the LIVE Human row against: an
 * untouched 0.0.3 row matches and is promoted to `HUMAN_ENTRY` (gaining the
 * `raceType`), while an untouched 0.0.2 row (see `LEGACY_HUMAN_BASELINE`) no
 * longer matches any baseline and is preserved.
 */
export const LEGACY_HUMAN_BASELINE_V3 = {
  name: "Human",
  description:
    "Balanced/most numerous race. Humans possess both a class and a profession. Per-grade race gains are documented for G/F/E/D/C/B; see config.raceDefinitions.",
  grade: "F",
  provenance: "inferred" as Provenance,
  sourceUrl: JAKE_RACE_URL,
  archived: false,
  config: {
    naturalGrade: "F",
    inferredGrades: ["G", "F", "E", "D", "C", "B"],
    houseGrades: [],
    raceDefinitions: {
      G: { id: "human:G", perLevel: allEqual(1), freePerLevel: 1 },
      F: { id: "human:F", perLevel: allEqual(1), freePerLevel: 5 },
      E: { id: "human:E", perLevel: allEqual(2), freePerLevel: 5 },
      D: { id: "human:D", perLevel: allEqual(6), freePerLevel: 15 },
      C: { id: "human:C", perLevel: allEqual(18), freePerLevel: 45 },
      B: { id: "human:B", perLevel: allEqual(54), freePerLevel: 135 },
    },
  },
}

/**
 * The sourced Human table (Jake_Thayne/Race + Human). The G-grade line is now
 * sourced as +1 all / +1 free, so G moves out of the house-zero band.
 */
export const HUMAN_ENTRY: JakeCatalogEntry = {
  kind: "races",
  stableId: "human",
  name: "Human",
  description:
    "Balanced/most numerous race. Humans possess both a class and a profession. Per-grade race gains are documented for G/F/E/D/C/B; see config.raceDefinitions.",
  grade: "F",
  provenance: "inferred",
  sourceUrl: JAKE_RACE_URL,
  config: {
    // Human is an enlightened race: it selects an exact class/profession and its
    // race level is derived from those tracks (never race-only).
    raceType: "enlightened",
    naturalGrade: "F",
    // The sourced grade values are fan-wiki-inferred, not verified canon, so they
    // are recorded under inferredGrades rather than verifiedGrades.
    inferredGrades: ["G", "F", "E", "D", "C", "B"],
    houseGrades: [],
    raceDefinitions: {
      G: { id: "human:G", perLevel: allEqual(1), freePerLevel: 1 },
      F: { id: "human:F", perLevel: allEqual(1), freePerLevel: 5 },
      E: { id: "human:E", perLevel: allEqual(2), freePerLevel: 5 },
      D: { id: "human:D", perLevel: allEqual(6), freePerLevel: 15 },
      C: { id: "human:C", perLevel: allEqual(18), freePerLevel: 45 },
      B: { id: "human:B", perLevel: allEqual(54), freePerLevel: 135 },
    },
  },
}

// ------------------------------------------------------------------ //
// Classes
// ------------------------------------------------------------------ //

/**
 * The 0.0.2 baseline for the seeded Archer class row (house placeholder). It
 * grants only agility + perception; the sourced Archer table below is the
 * replacement.
 */
export const LEGACY_ARCHER_BASELINE = {
  name: "Archer",
  description:
    "F-grade primary class. HOUSE PLACEHOLDER - the wiki does not document Archer's exact per-level stat gains, so config.grades.F is editable. Replace with a sourced value when available.",
  grade: "F",
  provenance: "house" as Provenance,
  sourceUrl: "https://the-primal-hunter.fandom.com/wiki/Classes",
  archived: false,
  config: {
    grades: {
      F: {
        fixed: { agility: 2, perception: 1 },
        free: 1,
      },
    },
  },
}

/**
 * Jake Thayne's five class progression definitions. `archer` is the legacy row
 * the seed updates under guard; the E/D/C/B definitions are create-only.
 *
 * Per the source ("Stat bonuses per level"), the values are per-level fixed
 * gains plus a per-level free-point allowance. Each definition carries exactly
 * ONE `grades.<grade>` entry (its own grade), so a graded class track resolves
 * to this line's per-level config.
 */
export const JAKE_CLASSES: readonly JakeCatalogEntry[] = [
  {
    kind: "classes",
    stableId: "archer",
    name: "Archer",
    description:
      "An F-grade primary class built around ranged combat with bows, fast and flexible, favoring agility over strength. Its per-level gains are stored in config.grades.F (inferred from Jake Thayne's class progression).",
    grade: "F",
    provenance: "inferred",
    sourceUrl: JAKE_CLASS_URL,
    config: {
      grades: {
        F: {
          fixed: { perception: 2, agility: 1, endurance: 1, strength: 1 },
          free: 1,
        },
      },
    },
  },
  {
    kind: "classes",
    stableId: "ambitious-hunter",
    name: "Ambitious Hunter",
    description:
      "An E-grade hunter class that seeks ever-stronger prey. Fast and flexible ranged combat favoring agility; per-level gains are stored in config.grades.E (inferred from Jake Thayne's class progression).",
    grade: "E",
    provenance: "inferred",
    sourceUrl: JAKE_CLASS_URL,
    config: {
      grades: {
        E: {
          fixed: { perception: 5, agility: 4, endurance: 3, strength: 2 },
          free: 4,
        },
      },
    },
  },
  {
    kind: "classes",
    stableId: "avaricious-arcane-hunter",
    name: "Avaricious Arcane Hunter",
    description:
      "A D-grade hunter class that fuses the pure Hunter path with arcane magic, driven by an endless hunger for power. Per-level gains are stored in config.grades.D (inferred from Jake Thayne's class progression).",
    grade: "D",
    provenance: "inferred",
    sourceUrl: JAKE_CLASS_URL,
    config: {
      grades: {
        D: {
          fixed: {
            perception: 20,
            agility: 12,
            intelligence: 12,
            wisdom: 10,
            endurance: 10,
            willpower: 6,
            strength: 6,
          },
          free: 10,
        },
      },
    },
  },
  {
    kind: "classes",
    stableId: "arcane-hunter-of-horizons-edge",
    name: "Arcane Hunter of Horizon's Edge",
    description:
      "A C-grade hunter class chasing an ever-receding horizon, wielding a bow alongside arcane and close-combat techniques. Per-level gains are stored in config.grades.C (inferred from Jake Thayne's class progression).",
    grade: "C",
    provenance: "inferred",
    sourceUrl: JAKE_CLASS_URL,
    config: {
      grades: {
        C: {
          fixed: {
            perception: 60,
            agility: 40,
            strength: 35,
            endurance: 30,
            intelligence: 25,
            wisdom: 25,
            willpower: 20,
          },
          free: 50,
        },
      },
    },
  },
  {
    kind: "classes",
    stableId: "arcane-hunter-of-the-boundless-horizon",
    name: "Arcane Hunter of the Boundless Horizon",
    description:
      "A B-grade hunter class pursuing the Event Horizon itself, using every means available to close in on it. Per-level gains are stored in config.grades.B (inferred from Jake Thayne's class progression).",
    grade: "B",
    provenance: "inferred",
    sourceUrl: JAKE_CLASS_URL,
    config: {
      grades: {
        B: {
          fixed: {
            perception: 200,
            agility: 150,
            strength: 125,
            endurance: 100,
            intelligence: 75,
            wisdom: 75,
            willpower: 30,
          },
          free: 125,
        },
      },
    },
  },
]

/** The Archer replacement (legacy guard) is the F-grade class definition. */
export const ARCHER_ENTRY: JakeCatalogEntry = JAKE_CLASSES[0]

// ------------------------------------------------------------------ //
// Professions
// ------------------------------------------------------------------ //

/**
 * Jake Thayne's five alchemist profession progression definitions. The F-grade
 * entry's stableId deliberately matches the reviewed manifest
 * (`alchemist-of-the-malefic-viper`) so an imported manifest row is preserved and
 * only created when absent. The D and C entries share the display name
 * "Heretic-Chosen Alchemist of the Malefic Viper" (the source lists the same
 * name at both levels) and are disambiguated by the `-d` / `-c` stableId
 * suffixes. Every other stableId is a deterministic readable slug.
 */
export const JAKE_PROFESSIONS: readonly JakeCatalogEntry[] = [
  {
    kind: "professions",
    stableId: "alchemist-of-the-malefic-viper",
    name: "Alchemist of the Malefic Viper",
    description:
      "An F-grade poison-focused alchemy profession. Its per-level gains are stored in config.grades.F (inferred from Jake Thayne's profession progression).",
    grade: "F",
    provenance: "inferred",
    sourceUrl: JAKE_PROFESSION_URL,
    config: {
      grades: {
        F: {
          fixed: { vitality: 2, wisdom: 2, willpower: 1, toughness: 1 },
          free: 2,
        },
      },
    },
  },
  {
    kind: "professions",
    stableId: "prodigious-alchemist-of-the-malefic-viper",
    name: "Prodigious Alchemist of the Malefic Viper",
    description:
      "An E-grade alchemist line distinguished by prodigal talent, specializing in poisons. Per-level gains are stored in config.grades.E (inferred from Jake Thayne's profession progression).",
    grade: "E",
    provenance: "inferred",
    sourceUrl: JAKE_PROFESSION_URL,
    config: {
      grades: {
        E: {
          fixed: {
            vitality: 4,
            wisdom: 4,
            willpower: 3,
            toughness: 2,
            intelligence: 2,
          },
          free: 5,
        },
      },
    },
  },
  {
    kind: "professions",
    stableId: "heretic-chosen-alchemist-of-the-malefic-viper-d",
    name: "Heretic-Chosen Alchemist of the Malefic Viper",
    description:
      "A D-grade alchemist line walking the paradox of the Malefic Viper's chosen yet heretic. Per-level gains are stored in config.grades.D (inferred from Jake Thayne's profession progression).",
    grade: "D",
    provenance: "inferred",
    sourceUrl: JAKE_PROFESSION_URL,
    config: {
      grades: {
        D: {
          fixed: {
            willpower: 15,
            wisdom: 15,
            vitality: 14,
            intelligence: 10,
            toughness: 10,
          },
          free: 10,
        },
      },
    },
  },
  {
    kind: "professions",
    stableId: "heretic-chosen-alchemist-of-the-malefic-viper-c",
    name: "Heretic-Chosen Alchemist of the Malefic Viper",
    description:
      "A C-grade continuation of the Heretic-Chosen alchemist path, further along the same paradoxical course. Per-level gains are stored in config.grades.C (inferred from Jake Thayne's profession progression).",
    grade: "C",
    provenance: "inferred",
    sourceUrl: JAKE_PROFESSION_URL,
    config: {
      grades: {
        C: {
          fixed: {
            willpower: 50,
            wisdom: 50,
            vitality: 40,
            intelligence: 30,
            toughness: 25,
          },
          free: 35,
        },
      },
    },
  },
  {
    kind: "professions",
    stableId: "primeval-alchemist-of-malefic-origins",
    name: "Primeval Alchemist of Malefic Origins",
    description:
      "A B-grade alchemist line that moves beyond the Viper's legacy to explore primeval origins. Per-level gains are stored in config.grades.B (inferred from Jake Thayne's profession progression).",
    grade: "B",
    provenance: "inferred",
    sourceUrl: JAKE_PROFESSION_URL,
    config: {
      grades: {
        B: {
          fixed: {
            wisdom: 175,
            willpower: 150,
            perception: 100,
            vitality: 100,
            toughness: 60,
          },
          free: 125,
        },
      },
    },
  },
]

// ------------------------------------------------------------------ //
// Titles
// ------------------------------------------------------------------ //

const DUNGEON_PIONEER_URL = `${FANDOM_BASE}Dungeon_Pioneer`

/**
 * The canonical Roman numeral for each Dungeon Pioneer rank (1..15). Carried
 * verbatim in the entry name (e.g. "Dungeon Pioneer IX"); the stableId is the
 * lowercase numeral (`dungeon-pioneer-ix`).
 */
const DUNGEON_PIONEER_NUMERALS = [
  "I",
  "II",
  "III",
  "IV",
  "V",
  "VI",
  "VII",
  "VIII",
  "IX",
  "X",
  "XI",
  "XII",
  "XIII",
  "XIV",
  "XV",
] as const

interface DungeonPioneerRankSpec {
  rank: number
  grade: string
  minRaceGrade: string
}

/**
 * The rank table for the Dungeon Pioneer progression. Ranks 1-5 are E-grade,
 * 6-10 are D-grade and 11-15 are C-grade; the minRaceGrade mirrors the rank's own
 * grade (a character's race grade is the authority for the progression gate, so a
 * rank may only be attached when the character's race grade is at least this).
 * The catalog-level `grade` is the rank's tier, never an enforced gate on its own.
 */
const DUNGEON_PIONEER_RANKS: readonly DungeonPioneerRankSpec[] = [
  { rank: 1, grade: "E", minRaceGrade: "E" },
  { rank: 2, grade: "E", minRaceGrade: "E" },
  { rank: 3, grade: "E", minRaceGrade: "E" },
  { rank: 4, grade: "E", minRaceGrade: "E" },
  { rank: 5, grade: "E", minRaceGrade: "E" },
  { rank: 6, grade: "D", minRaceGrade: "D" },
  { rank: 7, grade: "D", minRaceGrade: "D" },
  { rank: 8, grade: "D", minRaceGrade: "D" },
  { rank: 9, grade: "D", minRaceGrade: "D" },
  { rank: 10, grade: "D", minRaceGrade: "D" },
  { rank: 11, grade: "C", minRaceGrade: "C" },
  { rank: 12, grade: "C", minRaceGrade: "C" },
  { rank: 13, grade: "C", minRaceGrade: "C" },
  { rank: 14, grade: "C", minRaceGrade: "C" },
  { rank: 15, grade: "C", minRaceGrade: "C" },
]

/**
 * The cumulative all-attribute bonus for each Dungeon Pioneer rank (1..15). Each
 * rank adds this total to EVERY one of the nine attributes (`config.flat`), so a
 * rank is strictly better than the prior - never a partial or fabricated
 * percent/loot package. Sourced as an inferred reading; there is no per-rank
 * numeric table asserted.
 */
const DUNGEON_PIONEER_TOTALS = [
  3, 6, 9, 12, 15, 24, 33, 42, 51, 60, 87, 114, 141, 168, 195,
] as const

/**
 * The fifteen Dungeon Pioneer ranked title definitions (ranks I..XV).
 *
 * Every entry is create-only and metadata-only from the engine's perspective: the
 * flat bonus is the ONLY numeric effect (no fabricated `percentBasisPoints` or
 * loot), and each title's config declares the `improvement` descriptor used by the
 * sequential rank gate plus the matching `upgradeGroup` (== seriesId). Nothing is
 * auto-granted; a player attaches each rank through the association API.
 */
export const JAKE_TITLES: readonly JakeCatalogEntry[] =
  DUNGEON_PIONEER_RANKS.map((spec, index) => {
    const numeral = DUNGEON_PIONEER_NUMERALS[index]
    const total = DUNGEON_PIONEER_TOTALS[index]
    return {
      kind: "titles",
      stableId: `dungeon-pioneer-${numeral.toLowerCase()}`,
      name: `Dungeon Pioneer ${numeral}`,
      description:
        `A rank ${numeral} Dungeon Pioneer title. Rather than invent a per-rank numeric ` +
        `effect, the cumulative all-attribute bonus is sourced into config.flat ` +
        `(${total} to every attribute). Requires race grade ${spec.minRaceGrade} or higher.`,
      grade: spec.grade,
      provenance: "inferred",
      sourceUrl: DUNGEON_PIONEER_URL,
      config: {
        upgradeGroup: "dungeon-pioneer",
        improvement: {
          seriesId: "dungeon-pioneer",
          rank: spec.rank,
          minRaceGrade: spec.minRaceGrade,
        },
        flat: allEqual(total),
      },
    }
  })

// ------------------------------------------------------------------ //
// Gods
// ------------------------------------------------------------------ //

interface GodSeed {
  name: string
  page: string
  description: string
}

/**
 * The fifteen gods listed by name on the Gods page
 * (`https://the-primal-hunter.fandom.com/wiki/Gods`), each backed by its own
 * wiki page. The config is intentionally `{}`: a god carries no numeric effect
 * and no grade band, so no pantheon/divine-rank is asserted.
 */
const GOD_SEEDS: readonly GodSeed[] = [
  {
    name: "Aeon Clok",
    page: "Aeon_Clok",
    description:
      "A primordial god of the first era; one of the two 'Hidden Ones' who keep to their own research and avoid mortal affairs and godly politics.",
  },
  {
    name: "Eversmile",
    page: "Eversmile",
    description:
      "A primordial god of the first era; the other 'Hidden One', also drawn to research over mortal affairs.",
  },
  {
    name: "Rigoria",
    page: "Rigoria",
    description:
      "A primordial god of the first era described as 'the Maker', associated with the Automata Legion.",
  },
  {
    name: "Stormild",
    page: "Stormild",
    description:
      "A primordial god of the first era associated with elementals and recognized as a leader by many of them, though she heads no formal faction.",
  },
  {
    name: "The Blightfather",
    page: "Blightfather",
    description:
      "A primordial god of the first era who leads the Empire of Blight.",
  },
  {
    name: "The Daofather",
    page: "The_Daofather",
    description: "A primordial god of the first era who leads the Dao Sect.",
  },
  {
    name: "The Holy Mother",
    page: "The_Holy_Mother",
    description: "A primordial god of the first era who leads the Holy Church.",
  },
  {
    name: "The Malefic Viper",
    page: "The_Malefic_Viper",
    description:
      "A primordial god of the first era who leads the Order of the Malefic Viper and is Jake Thayne's patron.",
  },
  {
    name: "The Starseizing Titan",
    page: "The_Starseizing_Titan",
    description:
      "A primordial god of the first era, a unique lifeform with no faction of its own.",
  },
  {
    name: "The Wyrmgod of Nevermore",
    page: "Wyrmgod",
    description:
      "A primordial dragon god of the first era, associated with Nevermore.",
  },
  {
    name: "Valdemar",
    page: "Valdemar",
    description: "A primordial god of the first era associated with Valhal.",
  },
  {
    name: "Yggdrasil",
    page: "Yggdrasil",
    description:
      "A primordial god of the first era associated with the Pantheon of Life.",
  },
  {
    name: "Oras the All-Seeing",
    page: "Oras_the_All-Seeing",
    description:
      "A void god born in the void; listed among the void gods who have never died.",
  },
  {
    name: "Nevermore",
    page: "Nevermore",
    description:
      "A bound god born of an object or place rather than a living being.",
  },
  {
    name: "Exalted Prima",
    page: "Exalted_Prima",
    description:
      "A bound god born of an object or place rather than a living being.",
  },
]

/**
 * The fifteen god entries derived from `GOD_SEEDS`. Each is create-only; an
 * existing row with the same (kind, stableId) is preserved.
 */
export const JAKE_GODS: readonly JakeCatalogEntry[] = GOD_SEEDS.map((god) => ({
  kind: "gods",
  stableId: slugify(god.name),
  name: god.name,
  description: god.description,
  grade: null,
  provenance: "inferred",
  sourceUrl: `${FANDOM_BASE}${god.page}`,
  config: {},
}))

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

// ------------------------------------------------------------------ //
// DB helpers
// ------------------------------------------------------------------ //

function createData(
  entry: JakeCatalogEntry
): Prisma.CatalogDefinitionCreateInput {
  return {
    kind: entry.kind,
    stableId: entry.stableId,
    name: entry.name,
    description: entry.description,
    grade: entry.grade,
    provenance: entry.provenance,
    sourceUrl: entry.sourceUrl,
    archived: false,
    config: entry.config as Prisma.InputJsonValue,
  }
}

function updateData(
  entry: JakeCatalogEntry
): Prisma.CatalogDefinitionUpdateInput {
  return {
    name: entry.name,
    description: entry.description,
    grade: entry.grade,
    provenance: entry.provenance,
    sourceUrl: entry.sourceUrl,
    archived: false,
    config: entry.config as Prisma.InputJsonValue,
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return a === b
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((item, i) => deepEqual(item, b[i]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    if (aKeys.length !== bKeys.length) return false
    return aKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(b, key) &&
        deepEqual(a[key], b[key])
    )
  }
  return false
}

interface SeedBaseline {
  name: string
  description: string
  grade: string
  provenance: Provenance
  sourceUrl: string
  archived: boolean
  config: Record<string, unknown>
}

interface ComparableCatalogRow {
  name: string
  description: string | null
  grade: string | null
  provenance: string | null
  sourceUrl: string | null
  archived: boolean
  config: unknown
}

function comparableRow(row: {
  name: string
  description?: string | null
  grade?: string | null
  provenance?: string | null
  sourceUrl?: string | null
  archived?: boolean
  config: unknown
}): ComparableCatalogRow {
  return {
    name: row.name,
    description: row.description ?? null,
    grade: row.grade ?? null,
    provenance: row.provenance ?? null,
    sourceUrl: row.sourceUrl ?? null,
    archived: row.archived ?? false,
    config: row.config,
  }
}

function normBaseline(baseline: SeedBaseline): ComparableCatalogRow {
  return {
    name: baseline.name,
    description: baseline.description,
    grade: baseline.grade,
    provenance: baseline.provenance,
    sourceUrl: baseline.sourceUrl,
    archived: baseline.archived,
    config: baseline.config,
  }
}

function matchesBaseline(
  row: Parameters<typeof comparableRow>[0],
  baseline: SeedBaseline
): boolean {
  return deepEqual(comparableRow(row), normBaseline(baseline))
}

function isUniqueViolation(err: unknown): boolean {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002"
  ) {
    return true
  }
  return (
    !!err &&
    typeof err === "object" &&
    (err as { code?: string }).code === "P2002"
  )
}

function isSerializationFailure(err: unknown): boolean {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2034"
  ) {
    return true
  }
  return (
    !!err &&
    typeof err === "object" &&
    (err as { code?: string }).code === "P2034"
  )
}

/**
 * Apply the curated Jake catalog. This is the single entry point `prisma/seed.ts`
 * calls; it never creates characters or evolution paths.
 */
export async function seedJakeCatalog(prisma: PrismaClient): Promise<void> {
  // Race: Human (legacy guarded update or create). The guard baseline is the
  // 0.0.3 pre-raceType config, so a current row (0.0.3) is promoted to the sourced
  // entry (gaining `raceType`); an untouched 0.0.2 row no longer matches and is
  // preserved.
  await upsertLegacy(
    prisma,
    "races",
    "human",
    LEGACY_HUMAN_BASELINE_V3,
    HUMAN_ENTRY,
    "race"
  )

  // Class: Archer (legacy guarded update or create).
  await upsertLegacy(
    prisma,
    "classes",
    "archer",
    LEGACY_ARCHER_BASELINE,
    ARCHER_ENTRY,
    "class"
  )

  // Remaining classes (E/D/C/B) are create-only.
  for (const cls of JAKE_CLASSES) {
    if (cls.stableId === "archer") continue
    await createIfMissing(prisma, cls, "class")
  }

  // Professions are create-only (the F-grade row matches the reviewed manifest
  // and is preserved when already present).
  for (const prof of JAKE_PROFESSIONS) {
    await createIfMissing(prisma, prof, "profession")
  }

  // The 15 Dungeon Pioneer ranked titles are create-only (never auto-granted).
  for (const title of JAKE_TITLES) {
    await createIfMissing(prisma, title, "title")
  }

  // Gods are create-only.
  for (const god of JAKE_GODS) {
    await createIfMissing(prisma, god, "god")
  }
}

/**
 * Update a legacy seeded row only when it still equals the 0.0.2 baseline.
 * Missing -> create; modified -> preserve (and log why); already at the
 * replacement -> leave alone.
 *
 * Concurrency: the find-and-update runs in a SERIALIZABLE transaction so the
 * guard is never racing an admin edit. If a concurrent admin write commits
 * after our read but before our write, PostgreSQL aborts one of the two
 * transactions - here the seed - with a serialization failure (P2034), or with
 * a unique violation (P2002) when the read saw a missing row and a concurrent
 * actor created it first. In either case we do NOT mark the row updated and we
 * do NOT blindly retry the write: we re-read the current row OUTSIDE the
 * transaction and classify it, so an admin-modified row is preserved (and
 * logged as deferred / conflict). A future, non-conflicting seed run re-applies
 * the replacement.
 */
async function upsertLegacy(
  prisma: PrismaClient,
  kind: CatalogKind,
  stableId: string,
  baseline: SeedBaseline,
  replacement: JakeCatalogEntry,
  label: string
): Promise<void> {
  try {
    const outcome = await prisma.$transaction(
      async (tx) => {
        const row = await tx.catalogDefinition.findUnique({
          where: { kind_stableId: { kind, stableId } },
        })
        if (!row) {
          await tx.catalogDefinition.create({
            data: { ...createData(replacement) },
          })
          return "created"
        }
        if (matchesBaseline(row, baseline)) {
          await tx.catalogDefinition.update({
            where: { id: row.id },
            data: updateData(replacement),
          })
          return "updated"
        }
        if (deepEqual(comparableRow(row), comparableRow(replacement))) {
          return "current"
        }
        return "admin_modified"
      },
      // Serializable makes the read set a serialization dependency on the legacy
      // row, so a concurrent admin edit cannot both commit and be invisibly
      // overwritten: the loser aborts with P2034 (or P2002 on a missing-row
      // create) and is handled below.
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )

    switch (outcome) {
      case "created":
        console.log(
          `  Created ${label} "${replacement.name}" (${stableId}) from sourced data.`
        )
        break
      case "updated":
        console.log(
          `  Updated legacy ${label} "${replacement.name}" (${stableId}) with sourced values (was unmodified 0.0.2 baseline).`
        )
        break
      case "current":
        console.log(
          `  ${label} "${stableId}" already up to date; left unchanged.`
        )
        break
      case "admin_modified":
        console.log(
          `  ${label} "${stableId}" was modified; preserved and not overwritten.`
        )
        break
      default:
        break
    }
  } catch (err) {
    if (isSerializationFailure(err) || isUniqueViolation(err)) {
      await handleLegacyConflict(
        prisma,
        kind,
        stableId,
        baseline,
        replacement,
        label,
        err
      )
      return
    }
    throw err
  }
}

/**
 * Handle a transaction aborted by a concurrent write. The transaction already
 * rolled back, so the legacy row was NOT marked updated. Re-read the current row
 * OUTSIDE the transaction and classify it; never blindly re-apply the update
 * without re-checking the baseline. An admin-modified row is preserved (and
 * logged as deferred / conflict); a row still at the baseline (or already at the
 * replacement) is deferred to a future, non-conflicting seed run.
 */
async function handleLegacyConflict(
  prisma: PrismaClient,
  kind: CatalogKind,
  stableId: string,
  baseline: SeedBaseline,
  replacement: JakeCatalogEntry,
  label: string,
  err: unknown
): Promise<void> {
  const code = isUniqueViolation(err) ? "P2002" : "P2034"
  const cause =
    code === "P2002"
      ? "a concurrent create of the missing row"
      : "a concurrent write (serialization conflict)"

  const row = await prisma.catalogDefinition.findUnique({
    where: { kind_stableId: { kind, stableId } },
  })

  if (!row) {
    console.log(
      `  ${label} "${stableId}" deferred: ${cause} and the row is absent; will retry on a future seed.`
    )
    return
  }

  if (matchesBaseline(row, baseline)) {
    // Still at the untouched baseline - nothing was clobbered. Defer rather than
    // blindly retrying an unguarded update.
    console.log(
      `  ${label} "${stableId}" deferred: ${cause}; left at 0.0.2 baseline, will update on a future seed.`
    )
    return
  }

  if (deepEqual(comparableRow(row), comparableRow(replacement))) {
    console.log(
      `  ${label} "${stableId}" deferred: ${cause}; row already at sourced values, left unchanged.`
    )
    return
  }

  // Admin-modified row: the concurrent admin edit wins, so preserve it.
  console.log(
    `  ${label} "${stableId}" deferred: modified concurrently (${code}); preserved and not overwritten.`
  )
}

/** Create a row when its (kind, stableId) is absent; an existing row is kept. */
async function createIfMissing(
  prisma: PrismaClient,
  entry: JakeCatalogEntry,
  label: string
): Promise<void> {
  const existing = await prisma.catalogDefinition.findUnique({
    where: { kind_stableId: { kind: entry.kind, stableId: entry.stableId } },
  })
  if (existing) {
    console.log(
      `  ${label} "${entry.name}" (${entry.stableId}) already exists; preserved.`
    )
    return
  }
  try {
    await prisma.catalogDefinition.create({ data: createData(entry) })
    console.log(
      `  Created ${label} "${entry.name}" (${entry.stableId}, grade ${entry.grade ?? "n/a"}).`
    )
  } catch (err) {
    if (isUniqueViolation(err)) {
      console.log(
        `  ${label} "${entry.name}" (${entry.stableId}) already exists; preserved.`
      )
      return
    }
    throw err
  }
}
