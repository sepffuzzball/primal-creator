import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "@prisma/client"
import { createTestPrisma } from "@/lib/db/testPrisma"
import {
  seedJakeCatalog,
  HUMAN_ENTRY,
  ARCHER_ENTRY,
  JAKE_CLASSES,
  JAKE_PROFESSIONS,
  JAKE_GODS,
  JAKE_TITLES,
  LEGACY_HUMAN_BASELINE,
  LEGACY_HUMAN_BASELINE_V3,
  LEGACY_ARCHER_BASELINE,
} from "./jake-seed"

type TestStore = ReturnType<typeof createTestPrisma>["store"]

const FANDOM = "https://the-primal-hunter.fandom.com/wiki/"

function allEqual(value: number): Record<string, number> {
  const attrs = [
    "strength",
    "agility",
    "endurance",
    "vitality",
    "toughness",
    "wisdom",
    "intelligence",
    "perception",
    "willpower",
  ]
  const out: Record<string, number> = {}
  for (const attr of attrs) out[attr] = value
  return out
}

// Minimal structural views of the per-kind configs the assertions inspect. The
// seed stores these as JSON, so the tests read them back through these narrow
// views instead of reaching for `any`.
interface GradeVector {
  fixed: Record<string, number>
  free: number
}
interface TrackGradesConfig {
  grades: Record<string, GradeVector>
}
interface RaceDefinition {
  id: string
  perLevel: Record<string, number>
  freePerLevel: number
}
interface HumanRaceConfig {
  raceType?: string
  naturalGrade: string
  // The legacy 0.0.2 baseline config carries verifiedGrades; the sourced
  // replacement records its fan-wiki-inferred values under inferredGrades.
  verifiedGrades?: string[]
  inferredGrades: string[]
  houseGrades: string[]
  raceDefinitions: Record<string, RaceDefinition>
}

// The fifteen god names and their individual wiki pages, as recorded in the
// curated seed. The stableId is the deterministic slug of the name; the sourceUrl
// points at the god's own page.
const GOD_PAGES: Record<string, string> = {
  "Aeon Clok": "Aeon_Clok",
  Eversmile: "Eversmile",
  Rigoria: "Rigoria",
  Stormild: "Stormild",
  "The Blightfather": "Blightfather",
  "The Daofather": "The_Daofather",
  "The Holy Mother": "The_Holy_Mother",
  "The Malefic Viper": "The_Malefic_Viper",
  "The Starseizing Titan": "The_Starseizing_Titan",
  "The Wyrmgod of Nevermore": "Wyrmgod",
  Valdemar: "Valdemar",
  Yggdrasil: "Yggdrasil",
  "Oras the All-Seeing": "Oras_the_All-Seeing",
  Nevermore: "Nevermore",
  "Exalted Prima": "Exalted_Prima",
}

function snapshotCatalog(store: TestStore): string {
  return JSON.stringify(
    [...store.catalog.values()]
      .map((row) => ({
        kind: row.kind,
        stableId: row.stableId,
        name: row.name,
        grade: row.grade,
        sourceUrl: row.sourceUrl,
        archived: row.archived,
        config: row.config,
      }))
      .sort((a, b) =>
        `${a.kind}:${a.stableId}`.localeCompare(`${b.kind}:${b.stableId}`)
      )
  )
}

function seedPrismaOf(instance: ReturnType<typeof createTestPrisma>) {
  return instance.prisma as unknown as Parameters<typeof seedJakeCatalog>[0]
}

function makeKnownRequestError(code: string) {
  return new Prisma.PrismaClientKnownRequestError(`simulated ${code} error`, {
    code,
    clientVersion: "0.0.0-test",
  })
}

interface ConflictArm {
  /** The transaction write that the concurrent actor races against. */
  conflictOp: "update" | "create"
  code: "P2034" | "P2002"
  /** Apply the concurrent admin write AFTER the seed transaction has rolled back. */
  concurrent: () => void
}

/**
 * Arm a one-shot `$transaction` conflict on the mock. The seed's legacy
 * find-and-update is genuinely attempted (the mock rolls it back on the thrown
 * error), then `concurrent()` commits the admin's competing write once the
 * transaction has aborted, so the seed's outside-transaction re-read observes the
 * admin's version - exactly the concurrent-edit race the serializable isolation
 * is meant to surface. Only the first `$transaction` call is affected.
 */
function armLegacyConflict(
  instance: ReturnType<typeof createTestPrisma>,
  arm: ConflictArm
): void {
  const realTx = instance.prisma.$transaction
  let armed = true
  instance.prisma.$transaction = ((
    cb: unknown,
    options?: { isolationLevel?: unknown }
  ) => {
    if (!armed) return realTx(cb as never, options)
    armed = false
    return realTx(async (tx) => {
      const wrappedTx = {
        ...tx,
        catalogDefinition: {
          ...tx.catalogDefinition,
          [arm.conflictOp]: async () => {
            throw makeKnownRequestError(arm.code)
          },
        },
      }
      return (cb as (t: unknown) => Promise<unknown>)(wrappedTx)
    }, options).then(
      (res) => res,
      (err) => {
        arm.concurrent()
        throw err
      }
    )
  }) as typeof instance.prisma.$transaction
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("Jake Thayne catalog seed (unit, mocked db)", () => {
  let instance: ReturnType<typeof createTestPrisma>
  let store: TestStore

  beforeEach(() => {
    instance = createTestPrisma()
    store = instance.store
  })

  // ------------------------------------------------------------------ //
  // Data table invariants
  // ------------------------------------------------------------------ //

  it("declares five classes with distinct grades and exactly one grades entry each", () => {
    expect(JAKE_CLASSES).toHaveLength(5)
    expect(JAKE_CLASSES.map((c) => c.grade)).toEqual(["F", "E", "D", "C", "B"])
    for (const cls of JAKE_CLASSES) {
      expect(cls.kind).toBe("classes")
      const grade = cls.grade as string
      const grades = cls.config.grades as Record<string, unknown>
      expect(Object.keys(grades)).toEqual([grade])
    }
    // Archer is the legacy class row and carries the sourced F-grade vector, not
    // the old house placeholder (agility + perception only).
    const archer = JAKE_CLASSES.find((c) => c.stableId === "archer")!
    expect(archer).not.toBeUndefined()
    const archerConfig = archer.config as unknown as TrackGradesConfig
    expect(archerConfig.grades.F.fixed).toEqual({
      perception: 2,
      agility: 1,
      endurance: 1,
      strength: 1,
    })
    expect(archerConfig.grades.F.free).toBe(1)
    expect(ARCHER_ENTRY).toBe(JAKE_CLASSES[0])
  })

  it("declares five professions with the manifest F stableId and -d/-c disambiguation", () => {
    expect(JAKE_PROFESSIONS).toHaveLength(5)
    expect(JAKE_PROFESSIONS.map((p) => p.grade)).toEqual([
      "F",
      "E",
      "D",
      "C",
      "B",
    ])
    const f = JAKE_PROFESSIONS.find((p) => p.grade === "F")!
    expect(f.stableId).toBe("alchemist-of-the-malefic-viper")
    const d = JAKE_PROFESSIONS.find((p) => p.grade === "D")!
    const c = JAKE_PROFESSIONS.find((p) => p.grade === "C")!
    // The source documents the same display name at both D and C; they are only
    // distinguishable by the -d / -c stableId suffixes.
    expect(d.name).toBe(c.name)
    expect(d.stableId).toBe("heretic-chosen-alchemist-of-the-malefic-viper-d")
    expect(c.stableId).toBe("heretic-chosen-alchemist-of-the-malefic-viper-c")
    for (const p of JAKE_PROFESSIONS) {
      expect(p.kind).toBe("professions")
      const grade = p.grade as string
      expect(Object.keys(p.config.grades as Record<string, unknown>)).toEqual([
        grade,
      ])
    }
  })

  it("declares fifteen gods, each metadata-only with an empty config and its own page", () => {
    expect(JAKE_GODS).toHaveLength(15)
    const names = JAKE_GODS.map((g) => g.name)
    expect(new Set(names).size).toBe(15)
    // Every god config stays { } - no fabricated pantheon/rank/numeric effect.
    for (const god of JAKE_GODS) {
      expect(god.kind).toBe("gods")
      expect(god.grade).toBeNull()
      expect(god.config).toEqual({})
    }
    // Each god cites its own wiki page (not merely the shared Gods index page).
    for (const god of JAKE_GODS) {
      const page = GOD_PAGES[god.name]
      expect(page).toBeDefined()
      expect(god.sourceUrl).toBe(`${FANDOM}${page}`)
    }
  })

  interface DungeonPioneerConfig {
    upgradeGroup?: string
    improvement?: { seriesId?: string; rank?: number; minRaceGrade?: string }
    flat?: Record<string, number>
  }

  // The cumulative all-attribute bonus per rank (1..15), mirrored from the seed so
  // the assertion is not a tautology against the same constant.
  const DP_TOTALS = [
    3, 6, 9, 12, 15, 24, 33, 42, 51, 60, 87, 114, 141, 168, 195,
  ]

  it("declares fifteen Dungeon Pioneer ranked titles with canonical numerals and the cumulative flat vector", () => {
    expect(JAKE_TITLES).toHaveLength(15)
    const numerals = [
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
    ]
    const serials: string[] = []
    for (let i = 0; i < JAKE_TITLES.length; i++) {
      const entry = JAKE_TITLES[i]
      const rank = i + 1
      const numeral = numerals[i]
      expect(entry.kind).toBe("titles")
      expect(entry.stableId).toBe(`dungeon-pioneer-${numeral.toLowerCase()}`)
      expect(entry.name).toBe(`Dungeon Pioneer ${numeral}`)
      expect(entry.sourceUrl).toBe(`${FANDOM}Dungeon_Pioneer`)
      serials.push(entry.stableId)

      // Grade mapping: ranks 1-5 E, 6-10 D, 11-15 C (mirrors minRaceGrade).
      const expectedGrade = rank <= 5 ? "E" : rank <= 10 ? "D" : "C"
      expect(entry.grade).toBe(expectedGrade)

      const config = entry.config as DungeonPioneerConfig
      expect(config.upgradeGroup).toBe("dungeon-pioneer")
      expect(config.improvement).toEqual({
        seriesId: "dungeon-pioneer",
        rank,
        minRaceGrade: expectedGrade,
      })
      // Flat bonus is the ONLY numeric effect: every attribute gets the cumulative
      // total; no percent/loot is fabricated.
      expect(config.flat).toEqual(allEqual(DP_TOTALS[i]))
      expect(Object.keys(config.flat ?? {}).length).toBe(9)
      // The flat amounts are nonnegative integers.
      for (const v of Object.values(config.flat ?? {})) {
        expect(Number.isInteger(v)).toBe(true)
        expect(v).toBeGreaterThanOrEqual(0)
      }
    }
    expect(new Set(serials).size).toBe(15)
  })

  it("persists the fifteen Dungeon Pioneer ranks and never auto-grants them", async () => {
    await seedJakeCatalog(seedPrismaOf(instance))
    const titles = [...store.catalog.values()].filter(
      (r) => r.kind === "titles"
    )
    expect(titles).toHaveLength(15)
    for (const row of titles) {
      expect(row.archived).toBe(false)
      expect(row.stableId).toMatch(/^dungeon-pioneer-/)
      const config = row.config as DungeonPioneerConfig
      expect(config.upgradeGroup).toBe("dungeon-pioneer")
      expect(config.improvement?.seriesId).toBe("dungeon-pioneer")
      expect(config.improvement?.rank).toBeGreaterThanOrEqual(1)
      expect(config.improvement?.rank).toBeLessThanOrEqual(15)
    }
    // A repeated seed is idempotent over the new rows too.
    await seedJakeCatalog(seedPrismaOf(instance))
    expect(store.catalog.size).toBe(41)
    expect(
      [...store.catalog.values()].filter((r) => r.kind === "titles")
    ).toHaveLength(15)
  })

  it("keeps the sourced Human race table and the legacy baselines intact", () => {
    expect(HUMAN_ENTRY.kind).toBe("races")
    expect(HUMAN_ENTRY.sourceUrl).toBe(`${FANDOM}Jake_Thayne/Race`)
    const config = HUMAN_ENTRY.config as Record<string, unknown>
    // Human is authoritative and enlightened: it always selects an exact
    // class/profession; it is never a race-only monster.
    expect(config.raceType).toBe("enlightened")
    expect(config.naturalGrade).toBe("F")
    expect(config.inferredGrades).toEqual(["G", "F", "E", "D", "C", "B"])
    expect(config.houseGrades).toEqual([])
    const defs = config.raceDefinitions as Record<string, RaceDefinition>
    expect(defs.G.perLevel).toEqual({
      strength: 1,
      agility: 1,
      endurance: 1,
      vitality: 1,
      toughness: 1,
      wisdom: 1,
      intelligence: 1,
      perception: 1,
      willpower: 1,
    })
    expect(defs.G.freePerLevel).toBe(1)
    expect(defs.F.freePerLevel).toBe(5)
    expect(defs.B.freePerLevel).toBe(135)

    // The 0.0.2 baseline the legacy guard compares against. Its verifiedGrades /
    // houseGrades are retained exactly so the seed can detect an untouched 0.0.2
    // row and only then update it.
    expect(
      (LEGACY_HUMAN_BASELINE.config as unknown as HumanRaceConfig).houseGrades
    ).toEqual(["G"])
    expect(
      (LEGACY_HUMAN_BASELINE.config as unknown as HumanRaceConfig)
        .verifiedGrades
    ).toEqual(["F", "E", "D", "C", "B"])
    expect(
      (LEGACY_HUMAN_BASELINE.config as unknown as HumanRaceConfig)
        .raceDefinitions.G.perLevel
    ).toEqual({
      strength: 0,
      agility: 0,
      endurance: 0,
      vitality: 0,
      toughness: 0,
      wisdom: 0,
      intelligence: 0,
      perception: 0,
      willpower: 0,
    })
    expect(
      (LEGACY_ARCHER_BASELINE.config as unknown as TrackGradesConfig).grades.F
        .fixed
    ).toEqual({
      agility: 2,
      perception: 1,
    })

    // The 0.0.3 guard baseline carries the sourced table WITHOUT raceType, so the
    // seed detects a current 0.0.3 row and promotes it to the sourced entry that
    // now carries raceType. It is never authoritative itself.
    expect(LEGACY_HUMAN_BASELINE_V3.name).toBe("Human")
    expect(
      (LEGACY_HUMAN_BASELINE_V3.config as unknown as HumanRaceConfig).raceType
    ).toBeUndefined()
    expect(
      (LEGACY_HUMAN_BASELINE_V3.config as unknown as HumanRaceConfig)
        .raceDefinitions.F.freePerLevel
    ).toBe(5)
  })

  it("uses no provenance taxonomy and never emits an evolutions row", () => {
    const all = [
      HUMAN_ENTRY,
      ARCHER_ENTRY,
      ...JAKE_CLASSES,
      ...JAKE_PROFESSIONS,
      ...JAKE_GODS,
    ]
    expect(all.every((e) => e.kind !== "evolutions")).toBe(true)
    // Every source URL is an https URL naming a host.
    for (const e of all) {
      expect(e.sourceUrl.startsWith("https://")).toBe(true)
    }
  })

  // ------------------------------------------------------------------ //
  // Seed behaviour against the mock
  // ------------------------------------------------------------------ //

  it("seeds the full Jake catalog without a character or evolution row", async () => {
    await seedJakeCatalog(seedPrismaOf(instance))
    expect(store.catalog.size).toBe(41)
    const kinds = [...store.catalog.values()].map((r) => r.kind)
    expect(kinds.filter((k) => k === "races")).toHaveLength(1)
    expect(kinds.filter((k) => k === "classes")).toHaveLength(5)
    expect(kinds.filter((k) => k === "professions")).toHaveLength(5)
    expect(kinds.filter((k) => k === "gods")).toHaveLength(15)
    expect(kinds.filter((k) => k === "titles")).toHaveLength(15)
    expect(kinds.includes("evolutions")).toBe(false)
    expect(store.characters.size).toBe(0)
    for (const row of store.catalog.values()) {
      expect(row.archived).toBe(false)
    }
  })

  it("is idempotent - a repeated seed adds no new rows and changes nothing", async () => {
    await seedJakeCatalog(seedPrismaOf(instance))
    const before = snapshotCatalog(store)
    await seedJakeCatalog(seedPrismaOf(instance))
    expect(store.catalog.size).toBe(41)
    expect(snapshotCatalog(store)).toBe(before)
  })

  it("preserves the untouched 0.0.2 Human row while updating the untouched Archer row", async () => {
    store.addCatalog({
      id: "human-baseline",
      kind: "races",
      stableId: "human",
      name: LEGACY_HUMAN_BASELINE.name,
      description: LEGACY_HUMAN_BASELINE.description,
      grade: LEGACY_HUMAN_BASELINE.grade,
      sourceUrl: LEGACY_HUMAN_BASELINE.sourceUrl,
      archived: LEGACY_HUMAN_BASELINE.archived,
      config: LEGACY_HUMAN_BASELINE.config,
    })
    store.addCatalog({
      id: "archer-baseline",
      kind: "classes",
      stableId: "archer",
      name: LEGACY_ARCHER_BASELINE.name,
      description: LEGACY_ARCHER_BASELINE.description,
      grade: LEGACY_ARCHER_BASELINE.grade,
      sourceUrl: LEGACY_ARCHER_BASELINE.sourceUrl,
      archived: LEGACY_ARCHER_BASELINE.archived,
      config: LEGACY_ARCHER_BASELINE.config,
    })
    await seedJakeCatalog(seedPrismaOf(instance))

    // A 0.0.2 Human row no longer matches the 0.0.3 guard baseline, so it is LEFT
    // AT THE LEGACY BASELINE (never promoted): it stays verified/house-zero and
    // gains no raceType.
    const human = store.catalog.get("human-baseline")!
    expect(human.name).toBe(LEGACY_HUMAN_BASELINE.name)
    expect(human.sourceUrl).toBe(LEGACY_HUMAN_BASELINE.sourceUrl)
    const humanConfig = human.config as unknown as HumanRaceConfig
    expect(humanConfig.raceType).toBeUndefined()
    expect(humanConfig.verifiedGrades).toEqual(["F", "E", "D", "C", "B"])
    expect(humanConfig.inferredGrades).toBeUndefined()
    expect(humanConfig.houseGrades).toEqual(["G"])
    expect(humanConfig.raceDefinitions.G.freePerLevel).toBe(0)

    // The Archer baseline is unchanged, so the untouched 0.0.2 Archer row is still
    // promoted to the sourced replacement.
    const archer = store.catalog.get("archer-baseline")!
    expect(archer.name).toBe(ARCHER_ENTRY.name)
    expect(archer.sourceUrl).toBe(ARCHER_ENTRY.sourceUrl)
    const archerConfig = archer.config as unknown as TrackGradesConfig
    expect(archerConfig.grades.F.fixed).toEqual({
      perception: 2,
      agility: 1,
      endurance: 1,
      strength: 1,
    })
    expect(archerConfig.grades.F.free).toBe(1)
  })

  it("promotes an untouched 0.0.3 Human row to the sourced entry that now carries raceType", async () => {
    store.addCatalog({
      id: "human-003",
      kind: "races",
      stableId: "human",
      name: LEGACY_HUMAN_BASELINE_V3.name,
      description: LEGACY_HUMAN_BASELINE_V3.description,
      grade: LEGACY_HUMAN_BASELINE_V3.grade,
      sourceUrl: LEGACY_HUMAN_BASELINE_V3.sourceUrl,
      archived: LEGACY_HUMAN_BASELINE_V3.archived,
      config: LEGACY_HUMAN_BASELINE_V3.config,
    })
    await seedJakeCatalog(seedPrismaOf(instance))

    const human = store.catalog.get("human-003")!
    expect(human.name).toBe(HUMAN_ENTRY.name)
    expect(human.sourceUrl).toBe(HUMAN_ENTRY.sourceUrl)
    const humanConfig = human.config as unknown as HumanRaceConfig
    expect(humanConfig.raceType).toBe("enlightened")
    expect(humanConfig.inferredGrades).toEqual(["G", "F", "E", "D", "C", "B"])
    expect(humanConfig.verifiedGrades).toBeUndefined()
    expect(humanConfig.houseGrades).toEqual([])
    expect(humanConfig.raceDefinitions.G.freePerLevel).toBe(1)
  })

  it("preserves an admin-modified Human/Archer row untouched", async () => {
    store.addCatalog({
      id: "human-modified",
      kind: "races",
      stableId: "human",
      name: "Custom Human",
      description: "admin-edited",
      grade: "D",
      sourceUrl: "https://example.com/custom-human",
      archived: false,
      config: { naturalGrade: "C", raceDefinitions: {}, houseGrades: [] },
    })
    store.addCatalog({
      id: "archer-modified",
      kind: "classes",
      stableId: "archer",
      name: "Custom Archer",
      description: "admin-edited",
      grade: "F",
      sourceUrl: "https://example.com/custom-archer",
      archived: false,
      config: {
        grades: { F: { fixed: { agility: 9, perception: 5 }, free: 3 } },
      },
    })
    await seedJakeCatalog(seedPrismaOf(instance))

    const human = store.catalog.get("human-modified")!
    expect(human.name).toBe("Custom Human")
    expect(human.grade).toBe("D")
    expect(human.sourceUrl).toBe("https://example.com/custom-human")
    expect((human.config as unknown as HumanRaceConfig).naturalGrade).toBe("C")

    const archer = store.catalog.get("archer-modified")!
    expect(archer.name).toBe("Custom Archer")
    expect(
      (archer.config as unknown as TrackGradesConfig).grades.F.fixed
    ).toEqual({
      agility: 9,
      perception: 5,
    })
  })

  it("preserves an existing F-grade alchemist profession from the reviewed manifest", async () => {
    store.addCatalog({
      id: "prof-existing",
      kind: "professions",
      stableId: "alchemist-of-the-malefic-viper",
      name: "Alchemist of the Malefic Viper",
      description: "description from the reviewed manifest",
      grade: "F",
      sourceUrl: `${FANDOM}Jake_Thayne/Profession`,
      archived: false,
      config: {
        grades: {
          F: {
            fixed: { vitality: 2, wisdom: 2, willpower: 1, toughness: 1 },
            free: 2,
          },
        },
      },
    })
    await seedJakeCatalog(seedPrismaOf(instance))
    const row = store.catalog.get("prof-existing")!
    // The manifest row is never overwritten by the seed.
    expect(row.description).toBe("description from the reviewed manifest")
    expect(store.catalog.size).toBe(41)
  })

  it("deferred on a P2034 serialization conflict, preserving a concurrently admin-modified row (no update after conflict)", async () => {
    // A 0.0.3 (V3 baseline) Human row exists, so the seed's guarded transaction
    // genuinely attempts the update (the row matches the baseline). A concurrent
    // serialization conflict (P2034) aborts it, and a concurrent admin edit has
    // already changed the row.
    store.addCatalog({
      id: "human-baseline-conflict",
      kind: "races",
      stableId: "human",
      name: LEGACY_HUMAN_BASELINE_V3.name,
      description: LEGACY_HUMAN_BASELINE_V3.description,
      grade: LEGACY_HUMAN_BASELINE_V3.grade,
      sourceUrl: LEGACY_HUMAN_BASELINE_V3.sourceUrl,
      archived: LEGACY_HUMAN_BASELINE_V3.archived,
      config: LEGACY_HUMAN_BASELINE_V3.config,
    })

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    armLegacyConflict(instance, {
      conflictOp: "update",
      code: "P2034",
      concurrent: () => {
        const row = store.catalog.get("human-baseline-conflict")!
        row.name = "Custom Human"
        row.description = "admin-edited"
        row.grade = "D"
        row.sourceUrl = "https://example.com/custom-human"
        row.config = { naturalGrade: "C", raceDefinitions: {}, houseGrades: [] }
      },
    })

    await seedJakeCatalog(seedPrismaOf(instance))

    // The concurrent admin edit wins: after the serialization conflict the seed
    // must NOT re-apply the sourced replacement over it.
    const human = store.catalog.get("human-baseline-conflict")!
    expect(human.name).toBe("Custom Human")
    expect(human.grade).toBe("D")
    expect(human.sourceUrl).toBe("https://example.com/custom-human")
    expect((human.config as unknown as HumanRaceConfig).naturalGrade).toBe("C")

    const logs = logSpy.mock.calls.map((c) => c[0] as string)
    expect(logs.some((l) => l.includes("deferred"))).toBe(true)
    expect(logs.some((l) => l.includes("preserved and not overwritten"))).toBe(
      true
    )
    expect(logs.some((l) => l.includes("Updated legacy race"))).toBe(false)
  })

  it("deferred on a P2002 missing-row create race, preserving a concurrently inserted admin row", async () => {
    // No Human row exists, so the seed attempts to create it. A concurrent actor
    // creates the same (kind, stableId) first (P2002); the seed must not clobber
    // that row and must not mark it as created/updated.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    armLegacyConflict(instance, {
      conflictOp: "create",
      code: "P2002",
      concurrent: () => {
        store.addCatalog({
          id: "human-race-admin",
          kind: "races",
          stableId: "human",
          name: "Custom Human",
          description: "admin-edited before the seed create",
          grade: "D",
          sourceUrl: "https://example.com/custom-human",
          archived: false,
          config: { naturalGrade: "C", raceDefinitions: {}, houseGrades: [] },
        })
      },
    })

    await seedJakeCatalog(seedPrismaOf(instance))

    // The concurrently inserted admin row survives untouched.
    const human = store.catalog.get("human-race-admin")!
    expect(human.name).toBe("Custom Human")
    expect((human.config as unknown as HumanRaceConfig).naturalGrade).toBe("C")

    const logs = logSpy.mock.calls.map((c) => c[0] as string)
    expect(logs.some((l) => l.includes("deferred"))).toBe(true)
    expect(logs.some((l) => l.includes("preserved and not overwritten"))).toBe(
      true
    )
    expect(logs.some((l) => l.includes("Created race"))).toBe(false)
  })
})
