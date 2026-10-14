/**
 * Manually reviewed, version-controlled catalog manifest derived from the
 * fan-maintained The Primal Hunter Wiki (Fandom).
 *
 * This is NOT a scrape. Each entry is curated by hand and every claim is backed
 * by the exact source URL recorded on the entry. Nothing here is fetched at
 * runtime: the admin import (see docs/catalog/wiki-reviewed.md and
 * `lib/db/catalog-import.ts`) reads this static array and applies it to the
 * database as an explicit, admin-opt-in operation. The catalog is never mutated
 * by `db:seed` or app startup.
 *
 * Provenance policy:
 *   - The wiki is a secondary source, so none of this is asserted as canon; the
 *     manifest deliberately carries no provenance taxonomy. The reviewed catalog
 *     simply stores the source URL and the vetted entry config.
 *   - Entry kinds: `professions`, `blessings`, `bloodlines`, `skills`, `titles`.
 *   - Blessings / bloodlines / skills that carry no numeric effect in the source
 *     are stored with `effects: []` rather than a fabricated universal bonus.
 *     Skills that have no configured milestone are stored without `track` /
 *     `milestone`, so they are never auto-offered.
 *
 * Source terms: the Fandom wiki forbids automated scraping (direct page fetches
 * often return 403), so entries are reviewed manually and never re-fetched.
 */

import type { WikiReviewedEntry } from "@/lib/db/catalog-import"

/** The single manifest source the admin import applies. */
export const WIKI_REVIEWED_SOURCE = "wiki-reviewed" as const

/**
 * The curated manifest. `WIKI_REVIEWED_ENTRIES` is read by
 * `GET` / `POST /api/admin/catalog-import`; see `lib/db/catalog-import.ts`.
 */
export const WIKI_REVIEWED_ENTRIES: readonly WikiReviewedEntry[] = [
  {
    kind: "professions",
    stableId: "alchemist-of-the-malefic-viper",
    name: "Alchemist of the Malefic Viper",
    description:
      "An F-grade profession built around potion-craft and alchemy. Per the wiki it grants fixed vitality, wisdom, willpower and toughness plus free points at F grade; the exact per-level numbers are an inferred reading of the source and are stored as config.grades.F so an admin can correct them.",
    grade: "F",
    sourceUrl:
      "https://the-primal-hunter.fandom.com/wiki/Jake_Thayne/Profession",
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
    kind: "blessings",
    stableId: "true-blessing-malefic-viper",
    name: "True Blessing of the Malefic Viper",
    description:
      "The True-tier blessing of the Malefic Viper. Its effects are recorded as narrative-only here: blessing tiers evolve in the source and the numerical stage at this tier is not pinned by a reliable table, so no numeric bonus is invented (effects stays an empty list).",
    sourceUrl:
      "https://the-primal-hunter.fandom.com/wiki/True_Blessing_of_the_Malefic_Viper",
    config: {
      tier: "True",
      effects: [],
    },
  },
  {
    kind: "bloodlines",
    stableId: "bloodline-primal-hunter",
    name: "Bloodline of the Primal Hunter",
    description:
      "The bloodline of the Primal Hunter. Grade-specific effects are deliberately empty because the wiki documents only fragmentary grade evidence; no general numeric default is inferred and the gradeEffects map stays empty for future curation.",
    sourceUrl:
      "https://the-primal-hunter.fandom.com/wiki/Bloodline_of_the_Primal_Hunter",
    config: {
      effects: [],
      gradeEffects: {},
    },
  },
  {
    kind: "skills",
    stableId: "one-step-mile",
    name: "One Step Mile",
    description:
      "A descriptive speed skill. It carries no configured track/milestone, so the offer generator never auto-offers it at a class/profession milestone; it is metadata-only until an admin adds a milestone.",
    sourceUrl: "https://the-primal-hunter.fandom.com/wiki/One_Step_Mile",
    config: {
      effects: [],
      rarity: "Ancient",
    },
  },
  {
    kind: "skills",
    stableId: "gaze-of-the-apex-hunter",
    name: "Gaze of the Apex Hunter",
    description:
      "A descriptive skill of the Apex Hunter. Like One Step Mile it has no configured track/milestone, so it is never auto-offered at a milestone.",
    sourceUrl:
      "https://the-primal-hunter.fandom.com/wiki/Gaze_of_the_Apex_Hunter",
    config: {
      effects: [],
      rarity: "Legendary",
    },
  },
  {
    kind: "titles",
    stableId: "legendary-prodigy",
    name: "Legendary Prodigy",
    description:
      "A title granting a flat +10 and a +10% boost to all nine attributes. The values are an inferred reading and are stored as config flat/percentBasisPoints so an admin can correct them against the source.",
    sourceUrl: "https://the-primal-hunter.fandom.com/wiki/Legendary_Prodigy",
    config: {
      flat: {
        strength: 10,
        agility: 10,
        endurance: 10,
        vitality: 10,
        toughness: 10,
        perception: 10,
        intelligence: 10,
        wisdom: 10,
        willpower: 10,
      },
      percentBasisPoints: {
        strength: 1000,
        agility: 1000,
        endurance: 1000,
        vitality: 1000,
        toughness: 1000,
        perception: 1000,
        intelligence: 1000,
        wisdom: 1000,
        willpower: 1000,
      },
    },
  },
]
