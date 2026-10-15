import { beforeEach, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/db/client"
import {
  adjustCharacterInventory,
  advanceCharacter,
  allocateCharacter,
  applyAdvance,
  applyAllocate,
  applyEvolve,
  associateCharacter,
  buildRulesConfig,
  createCatalogItem,
  createCharacter,
  createInitialState,
  deserializeState,
  evolveCharacter,
  experienceCharacter,
  exportCharacter,
  getCatalogItem,
  getCharacter,
  getCharacterInventory,
  getEvolutionOptions,
  importCharacter,
  listCatalog,
  listCharacters,
  raceGradeBandBlockers,
  resolveTrackDefinition,
  serializeState,
  setCharacterProfession,
  skillCharacter,
  toListItem,
  updateCatalogItem,
  updateCharacter,
  upgradeSkill,
} from "@/lib/db/service"
import {
  IMPORT_SCHEMA_V3,
  IMPORT_SCHEMA_V4,
  IMPORT_SCHEMA_V5,
  IMPORT_SCHEMA_V6,
  IMPORT_SCHEMA_V7,
  IMPORT_RULESET_VERSION,
  characterImportDocumentSchema,
  type CharacterImportDocument,
} from "@/lib/server/import-schema"
import { associationSchema } from "@/lib/server/schemas"
import { DEFAULT_HOUSE_RULES_CONFIG } from "./ruleset"
import {
  createCharacterState,
  defaultRulesConfig,
  makeVector,
  type Attribute,
  type AttributeVector,
  type CharacterState,
  type Grade,
  type TrackDefinition,
} from "@/lib/rules"

// A realistic in-memory Prisma mock so the service-level optimistic-concurrency
// (CAS) tests run with no database. The mock enforces the same `version`
// semantics that a real Prisma `updateMany({ where: { id, version } })` does:
// a stale version matches 0 rows and the service 409s without writing an event.
type TestStore = import("./testPrisma").TestPrismaInstance["store"]
const dbMock = vi.hoisted(() => ({ store: undefined as unknown as TestStore }))

vi.mock("@/lib/db/client", async () => {
  const { createTestPrisma } = await import("./testPrisma")
  const instance = createTestPrisma()
  dbMock.store = instance.store
  return { prisma: instance.prisma, default: instance.prisma }
})

const user = { id: "user-1", email: "u@example.com", isAdmin: false }

function allEqual(n: number): AttributeVector {
  const out = {} as AttributeVector
  const keys: Attribute[] = [
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
  for (const a of keys) {
    out[a] = n
  }
  return out
}

const humanRace = {
  kind: "races",
  stableId: "human",
  name: "Human",
  config: {
    raceDefinitions: {
      F: { id: "human:F", perLevel: allEqual(1), freePerLevel: 5 },
      E: { id: "human:E", perLevel: allEqual(2), freePerLevel: 5 },
      D: { id: "human:D", perLevel: allEqual(6), freePerLevel: 15 },
    },
  },
}

const archerClass = {
  kind: "classes",
  stableId: "archer",
  name: "Archer",
  config: {
    grades: {
      F: { fixed: { agility: 2, perception: 1 }, free: 1 },
    },
  },
}

describe("buildRulesConfig", () => {
  it("builds race definitions from a verified human row", () => {
    const config = buildRulesConfig(humanRace)
    expect(config.raceDefinitions?.F).toEqual({
      id: "human:F",
      perLevel: makeVector(allEqual(1)),
      freePerLevel: 5,
    })
    expect(config.raceDefinitions?.D?.freePerLevel).toBe(15)
    // Derived resources stay unresolved (null) - no invented formula.
    expect(config.resourceMultipliers).toBeNull()
    expect(config.raceDerivationStrategy).toBe("floorHalfAvg")
  })

  it("keeps engine defaults when no race is supplied", () => {
    const config = buildRulesConfig(null)
    expect(config.raceDefinitions).toBeUndefined()
    expect(config.gradeTable.length).toBeGreaterThan(0)
  })
})

describe("createInitialState", () => {
  it("starts integrated characters at race grade G, level 0", () => {
    const state = createInitialState("integrated", humanRace, null)
    expect(state.race.grade).toBe("G")
    expect(state.race.level).toBe(0)
    expect(state.tracks.class).toEqual({
      level: 0,
      quarter: 0,
      definitionId: "",
    })
    // No profession => no profession track.
    expect(state.tracks.profession).toBeUndefined()
    expect(state.historicalLevelAwards).toEqual([])
    expect(state.baseAttributes.strength).toBe(0)
  })

  it("starts born characters at race grade F, level 0", () => {
    const state = createInitialState("born", humanRace, null)
    expect(state.race.grade).toBe("F")
    expect(state.race.level).toBe(0)
  })

  it("starts an integrated monster at race grade G regardless of natural grade", () => {
    const monster = {
      kind: "races",
      stableId: "wyrm",
      name: "Wyrm",
      config: {
        raceType: "monster",
        naturalGrade: "B",
        raceDefinitions: {
          G: { id: "wyrm:G", perLevel: { strength: 2 }, freePerLevel: 1 },
          B: { id: "wyrm:B", perLevel: { strength: 2 }, freePerLevel: 1 },
        },
      },
    }
    const state = createInitialState("integrated", monster, null)
    expect(state.race.grade).toBe("G")
    expect(state.race.mode).toBe("independent")
    expect(state.race.origin).toBe("integrated")
    // A monster has no class/profession tracks.
    expect(Object.keys(state.tracks)).toEqual([])
  })

  it("starts a born monster at the race's natural grade", () => {
    const monster = {
      kind: "races",
      stableId: "wyrm",
      name: "Wyrm",
      config: {
        raceType: "monster",
        naturalGrade: "B",
        raceDefinitions: {
          G: { id: "wyrm:G", perLevel: { strength: 2 }, freePerLevel: 1 },
          B: { id: "wyrm:B", perLevel: { strength: 2 }, freePerLevel: 1 },
        },
      },
    }
    const state = createInitialState("born", monster, null)
    expect(state.race.grade).toBe("B")
    expect(state.race.mode).toBe("independent")
    expect(state.race.origin).toBe("born")
  })

  it("creates a profession track only when one is provided", () => {
    const profession = {
      kind: "professions",
      stableId: "alchemist",
      name: "Alchemist",
      config: {},
    }
    const state = createInitialState("born", humanRace, profession)
    expect(state.tracks.profession).toBeDefined()
  })
})

describe("state serialization round-trip", () => {
  it("preserves engine state through serialize/deserialize", () => {
    const state = createInitialState("born", humanRace, null)
    const json = serializeState(state)
    const back = deserializeState(json)
    expect(back).toEqual(state)
  })
})

describe("applyAdvance", () => {
  const definition: TrackDefinition = {
    id: "archer:F",
    name: "Archer",
    fixed: makeVector({ agility: 2, perception: 1 }),
    free: 1,
  }

  it("advances quarters and awards a snapshotted level-up after four advances", () => {
    const config = buildRulesConfig(humanRace)
    let state = createInitialState("integrated", humanRace, null)
    let lastJournal: unknown
    for (let i = 0; i < 4; i++) {
      const result = applyAdvance(state, "class", definition, config)
      state = result.state
      lastJournal = result.journal
    }
    expect(state.tracks.class.level).toBe(1)
    expect(state.turn).toBe(4)
    expect(state.historicalLevelAwards).toHaveLength(1)
    expect(state.historicalLevelAwards[0].track).toBe("class")
    const journal = lastJournal as { leveledUp: boolean }
    expect(journal.leveledUp).toBe(true)
  })

  it("throws for an unknown track", () => {
    const config = buildRulesConfig(humanRace)
    const state = createInitialState("born", humanRace, null)
    expect(() => applyAdvance(state, "profession", definition, config)).toThrow(
      /no "profession" track/
    )
  })

  it("preserves historical awards across a track definition transition", () => {
    const config = buildRulesConfig(humanRace)
    let state = createInitialState("integrated", humanRace, null)
    const defF: TrackDefinition = {
      id: "archer:F",
      name: "Archer",
      fixed: makeVector({ agility: 2 }),
      free: 1,
    }
    // Level the class once under the F definition, snapshotting a historical award.
    for (let i = 0; i < 4; i++) {
      state = applyAdvance(state, "class", defF, config).state
    }
    expect(state.historicalLevelAwards).toHaveLength(1)
    expect(state.tracks.class.definitionId).toBe("archer:F")

    // After an evolution the correct definition changes; advancing with the new
    // definition must swap definitionId but never clear prior historical awards.
    const defE: TrackDefinition = {
      id: "archer:E",
      name: "Archer",
      fixed: makeVector({ agility: 4 }),
      free: 2,
    }
    const after = applyAdvance(state, "class", defE, config)
    expect(after.state.tracks.class.definitionId).toBe("archer:E")
    expect(after.state.historicalLevelAwards).toHaveLength(1)
    expect(after.state.historicalLevelAwards[0].track).toBe("class")
    expect(after.state.historicalLevelAwards[0].free).toBe(1)
  })
})

describe("applyAllocate", () => {
  it("allocates only available free points", () => {
    const config = buildRulesConfig(humanRace)
    const definition: TrackDefinition = {
      id: "archer:F",
      name: "Archer",
      fixed: makeVector({ agility: 2 }),
      free: 1,
    }
    let state = createInitialState("born", humanRace, null)
    for (let i = 0; i < 4; i++)
      state = applyAdvance(state, "class", definition, config).state
    // After one class level-up we have 1 free point.
    const next = applyAllocate(state, { agility: 1 })
    expect(next.allocations).toHaveLength(1)
    expect(next.allocations[0].points.agility).toBe(1)
  })

  it("rejects allocation beyond available points", () => {
    const state = createInitialState("born", humanRace, null)
    expect(() => applyAllocate(state, { strength: 5 })).toThrow(
      /exceeds available points/
    )
  })
})

describe("applyEvolve", () => {
  it("evolves a qualifying character to a supported grade", () => {
    const config = buildRulesConfig(humanRace)
    let state = createInitialState("integrated", humanRace, null)
    // Force a qualifying race level for F (entry 10).
    state = {
      ...state,
      tracks: {
        class: { level: 10, quarter: 0, definitionId: "archer:F" },
        profession: { level: 10, quarter: 0, definitionId: "" },
      },
      race: { ...state.race, level: 10 },
    }
    const result = applyEvolve(state, "F", config)
    expect(result.state.race.grade).toBe("F")
    expect(result.journal).toMatchObject({ from: "G", to: "F" })
  })

  it("rejects an evolution the character does not yet qualify for", () => {
    const config = buildRulesConfig(humanRace)
    const state = createInitialState("integrated", humanRace, null)
    expect(() => applyEvolve(state, "F", config)).toThrow(/does not qualify/)
  })
})

describe("resolveTrackDefinition", () => {
  it("picks the grade definition matching the character grade", () => {
    const state = createCharacterState({
      baseAttributes: makeVector({}),
      tracks: { class: { level: 10, quarter: 0, definitionId: "" } },
      race: { level: 10, grade: "F", mode: "derived" },
    })
    const def = resolveTrackDefinition(archerClass, state, "class")
    expect(def?.id).toBe("archer:F")
  })

  it("falls back to the lowest defined grade when the character grade has none", () => {
    const state = createCharacterState({
      baseAttributes: makeVector({}),
      tracks: { class: { level: 0, quarter: 0, definitionId: "" } },
      race: { level: 0, grade: "G", mode: "derived" },
    })
    const def = resolveTrackDefinition(archerClass, state, "class")
    expect(def?.id).toBe("archer:F")
  })

  it("returns null when the catalog row defines no per-grade gains", () => {
    const state = createCharacterState({
      baseAttributes: makeVector({}),
      tracks: { class: { level: 0, quarter: 0, definitionId: "" } },
      race: { level: 0, grade: "G", mode: "derived" },
    })
    const def = resolveTrackDefinition(
      { kind: "classes", stableId: "x", name: "X", config: {} },
      state,
      "class"
    )
    expect(def).toBeNull()
  })
})

describe("defaultRulesConfig", () => {
  it("exposes the documented consumable grade rates", () => {
    const config = defaultRulesConfig()
    expect(config.consumableGradeRates).toEqual({ F: 3, E: 5, D: 15, C: 45 })
  })
})

describe("optimistic concurrency (CAS)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function integratedState(): unknown {
    return serializeState(createInitialState("integrated", null, null))
  }

  function seedClassCatalog() {
    dbMock.store.addCatalog({
      id: "cls-1",
      kind: "classes",
      stableId: "archer",
      name: "Archer",
      config: { grades: { F: { fixed: { agility: 2 }, free: 1 } } },
    })
  }

  function seedCharacter(
    overrides: Partial<Record<string, unknown>> = {}
  ): unknown {
    return dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      classId: "cls-1",
      state: integratedState(),
      version: 0,
      ...(overrides as Record<string, unknown>),
    })
  }

  // A stale-version mutation must 409 and, critically, must NOT insert a
  // progression event. The service only writes the event after the CAS succeeds,
  // so a rejected CAS leaves the journal empty.
  function assertOneConflict(results: PromiseSettledResult<unknown>[]) {
    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    const reason = (rejected[0] as PromiseRejectedResult).reason
    expect(reason).toMatchObject({ status: 409, code: "version_conflict" })
  }

  it("createCharacter creates the character and its 'create' event atomically", async () => {
    dbMock.store.addCatalog({
      id: "race-1",
      kind: "races",
      stableId: "human",
      name: "Human",
      config: {
        raceDefinitions: {
          G: { id: "human:G", perLevel: { strength: 1 }, freePerLevel: 1 },
          F: { id: "human:F", perLevel: { strength: 1 }, freePerLevel: 1 },
        },
      },
    })
    seedClassCatalog()
    const detail = await createCharacter(
      { name: "N", origin: "integrated", raceId: "race-1", classId: "cls-1" },
      user
    )
    expect(detail.id).toBeTruthy()
    // Both the row and the journal entry exist: the create + event are one unit.
    expect(dbMock.store.characters.size).toBe(1)
    expect(dbMock.store.events).toHaveLength(1)
    expect(dbMock.store.events[0].kind).toBe("create")
    expect(dbMock.store.events[0].characterId).toBe(detail.id)
  })

  it("maps a serialization failure (P2034) on character create to 409 serialization_conflict and rolls back character/event/draft", async () => {
    seedClassCatalog()
    dbMock.store.addCatalog({
      id: "race-1",
      kind: "races",
      stableId: "human",
      name: "Human",
      config: {
        raceType: "enlightened",
        naturalGrade: "F",
        raceDefinitions: {
          G: { id: "human:G", perLevel: { strength: 1 }, freePerLevel: 1 },
          F: { id: "human:F", perLevel: { strength: 1 }, freePerLevel: 1 },
        },
      },
    })
    dbMock.store.addDraft({
      userId: user.id,
      data: { step: 4, name: "Kael" },
      version: 5,
    })
    // A concurrent admin raceType edit commits while this create is in flight. The
    // SERIALIZABLE transaction detects the conflict and aborts the create with a
    // P2034, which the service must surface as a meaningful 409 rather than a raw
    // 500, and must roll back the character / event / draft consume entirely.
    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce({
      name: "PrismaClientKnownRequestError",
      code: "P2034",
    })
    try {
      await expect(
        createCharacter(
          {
            name: "Kael",
            origin: "integrated",
            raceId: "race-1",
            classId: "cls-1",
            draftVersion: 5,
          },
          user
        )
      ).rejects.toMatchObject({ status: 409, code: "serialization_conflict" })
    } finally {
      spy.mockRestore()
    }
    expect(dbMock.store.characters.size).toBe(0)
    expect(dbMock.store.events).toHaveLength(0)
    expect(dbMock.store.drafts.size).toBe(1)
  })

  it("rejects a concurrent race type change to monster without creating an inconsistent character (type re-read under the transaction)", async () => {
    seedClassCatalog()
    dbMock.store.addCatalog({
      id: "race-1",
      kind: "races",
      stableId: "human",
      name: "Human",
      config: {
        raceType: "enlightened",
        naturalGrade: "F",
        raceDefinitions: {
          G: { id: "human:G", perLevel: { strength: 1 }, freePerLevel: 1 },
          F: { id: "human:F", perLevel: { strength: 1 }, freePerLevel: 1 },
        },
      },
    })
    dbMock.store.addDraft({
      userId: user.id,
      data: { step: 4, name: "Kael" },
      version: 5,
    })
    // Simulate the admin editing the race's raceType to monster AFTER the wizard
    // read the race but BEFORE the create transaction's insert. The authoritative
    // type must be re-read only under the transaction snapshot, so the create
    // landing on a monster (no class) rejects with invalid_class instead of
    // writing an inconsistent enlightened-styled character.
    const originalTransaction = prisma.$transaction
    const spy = vi
      .spyOn(prisma, "$transaction")
      .mockImplementation((cb, opts) => {
        const race = dbMock.store.catalog.get("race-1")
        if (race) {
          race.config = {
            raceType: "monster",
            naturalGrade: "F",
            raceDefinitions: race.config.raceDefinitions ?? {},
          }
        }
        return originalTransaction(cb, opts)
      })
    try {
      await expect(
        createCharacter(
          {
            name: "Kael",
            origin: "integrated",
            raceId: "race-1",
            classId: "cls-1",
            draftVersion: 5,
          },
          user
        )
      ).rejects.toMatchObject({ status: 400, code: "invalid_class" })
    } finally {
      spy.mockRestore()
    }
    expect(dbMock.store.characters.size).toBe(0)
    expect(dbMock.store.events).toHaveLength(0)
    expect(dbMock.store.drafts.size).toBe(1)
  })

  it("createCharacter does not create a character or event when the race is missing", async () => {
    seedClassCatalog()
    await expect(
      createCharacter(
        {
          name: "N",
          origin: "integrated",
          raceId: "missing",
          classId: "cls-1",
        },
        user
      )
    ).rejects.toMatchObject({ status: 404 })
    expect(dbMock.store.characters.size).toBe(0)
    expect(dbMock.store.events).toHaveLength(0)
  })

  it("createCharacter consumes the matching draft atomically when draftVersion is provided", async () => {
    seedClassCatalog()
    dbMock.store.addCatalog({
      id: "race-1",
      kind: "races",
      stableId: "human",
      name: "Human",
      config: {
        raceDefinitions: {
          G: { id: "human:G", perLevel: { strength: 1 }, freePerLevel: 1 },
          F: { id: "human:F", perLevel: { strength: 1 }, freePerLevel: 1 },
        },
      },
    })
    dbMock.store.addDraft({
      userId: user.id,
      data: { step: 4, name: "Kael" },
      version: 5,
    })
    const detail = await createCharacter(
      {
        name: "Kael",
        origin: "integrated",
        raceId: "race-1",
        classId: "cls-1",
        draftVersion: 5,
      },
      user
    )
    expect(detail.id).toBeTruthy()
    // Character + event exist AND the matched draft is gone (one atomic unit).
    expect(dbMock.store.characters.size).toBe(1)
    expect(dbMock.store.events).toHaveLength(1)
    expect(dbMock.store.events[0].kind).toBe("create")
    expect(dbMock.store.drafts.size).toBe(0)
  })

  it("createCharacter rejects a stale draftVersion and rolls back the character and event", async () => {
    seedClassCatalog()
    dbMock.store.addCatalog({
      id: "race-1",
      kind: "races",
      stableId: "human",
      name: "Human",
      config: {
        raceDefinitions: {
          G: { id: "human:G", perLevel: { strength: 1 }, freePerLevel: 1 },
          F: { id: "human:F", perLevel: { strength: 1 }, freePerLevel: 1 },
        },
      },
    })
    dbMock.store.addDraft({
      userId: user.id,
      data: { step: 4, name: "Kael" },
      version: 5,
    })
    await expect(
      createCharacter(
        {
          name: "Kael",
          origin: "integrated",
          raceId: "race-1",
          classId: "cls-1",
          draftVersion: 3,
        },
        user
      )
    ).rejects.toMatchObject({ status: 409, code: "draft_conflict" })
    // No character, no create event, and the draft is preserved.
    expect(dbMock.store.characters.size).toBe(0)
    expect(dbMock.store.events).toHaveLength(0)
    expect(dbMock.store.drafts.size).toBe(1)
    expect(
      ([...dbMock.store.drafts.values()][0] as { version: number }).version
    ).toBe(5)
  })

  it("createCharacter leaves the draft untouched when draftVersion is absent", async () => {
    seedClassCatalog()
    dbMock.store.addCatalog({
      id: "race-1",
      kind: "races",
      stableId: "human",
      name: "Human",
      config: {
        raceDefinitions: {
          G: { id: "human:G", perLevel: { strength: 1 }, freePerLevel: 1 },
          F: { id: "human:F", perLevel: { strength: 1 }, freePerLevel: 1 },
        },
      },
    })
    dbMock.store.addDraft({
      userId: user.id,
      data: { step: 4, name: "Kael" },
      version: 5,
    })
    const detail = await createCharacter(
      {
        name: "Kael",
        origin: "integrated",
        raceId: "race-1",
        classId: "cls-1",
      },
      user
    )
    expect(detail.id).toBeTruthy()
    // Non-wizard clients never touch the draft.
    expect(dbMock.store.characters.size).toBe(1)
    expect(dbMock.store.events).toHaveLength(1)
    expect(dbMock.store.drafts.size).toBe(1)
    expect(
      ([...dbMock.store.drafts.values()][0] as { version: number }).version
    ).toBe(5)
  })

  it("updateCharacter rejects a stale version and never writes a stale event", async () => {
    seedCharacter({ version: 5 })
    const first = await updateCharacter(
      "chr-1",
      { name: "New", version: 5 },
      user
    )
    expect(first.version).toBe(6)
    expect(first.name).toBe("New")
    expect(dbMock.store.events).toHaveLength(1)
    expect(dbMock.store.events[0].kind).toBe("update")

    // A concurrent request still holding version 5 must not overwrite.
    await expect(
      updateCharacter("chr-1", { name: "Stale", version: 5 }, user)
    ).rejects.toMatchObject({ status: 409, code: "version_conflict" })

    const fresh = dbMock.store.characters.get("chr-1")!
    expect(fresh.name).toBe("New")
    expect(fresh.version).toBe(6)
    expect(dbMock.store.events).toHaveLength(1)
  })

  it("updateCharacter uses the DB-captured version when the client omits it", async () => {
    seedCharacter({ version: 3 })
    const updated = await updateCharacter("chr-1", { name: "Patched" }, user)
    expect(updated.version).toBe(4)
    expect(updated.name).toBe("Patched")
  })

  it("updateCharacter rejects one of two concurrent same-version requests", async () => {
    seedCharacter({ version: 5 })
    const results = await Promise.allSettled([
      updateCharacter("chr-1", { name: "A", version: 5 }, user),
      updateCharacter("chr-1", { name: "B", version: 5 }, user),
    ])
    assertOneConflict(results)
    const fresh = dbMock.store.characters.get("chr-1")!
    expect(fresh.version).toBe(6)
    // Only the winning write persists; the stale write was discarded, not
    // applied over the winner.
    expect(["A", "B"]).toContain(fresh.name)
    expect(dbMock.store.events).toHaveLength(1)
  })

  it("advanceCharacter rejects a stale version and never writes a stale event", async () => {
    seedClassCatalog()
    seedCharacter()
    const first = await advanceCharacter(
      "chr-1",
      { track: "class", version: 0 },
      user
    )
    expect(first.character.version).toBe(1)
    expect(dbMock.store.events).toHaveLength(1)
    expect(dbMock.store.events[0].kind).toBe("advance")

    await expect(
      advanceCharacter("chr-1", { track: "class", version: 0 }, user)
    ).rejects.toMatchObject({ status: 409, code: "version_conflict" })

    const fresh = dbMock.store.characters.get("chr-1")!
    expect(fresh.version).toBe(1)
    expect(dbMock.store.events).toHaveLength(1)
  })

  it("advanceCharacter rejects one of two concurrent same-version requests", async () => {
    seedClassCatalog()
    seedCharacter()
    const results = await Promise.allSettled([
      advanceCharacter("chr-1", { track: "class", version: 0 }, user),
      advanceCharacter("chr-1", { track: "class", version: 0 }, user),
    ])
    assertOneConflict(results)
    const fresh = dbMock.store.characters.get("chr-1")!
    expect(fresh.version).toBe(1)
    expect(dbMock.store.events).toHaveLength(1)
  })

  it("allocateCharacter rejects a stale version and never writes a stale event", async () => {
    const state = createInitialState("born", null, null)
    state.historicalLevelAwards.push({
      track: "class",
      level: 1,
      definitionId: "d",
      fixed: makeVector({ strength: 1 }),
      free: 10,
    })
    seedCharacter({ state: serializeState(state), version: 1 })

    const first = await allocateCharacter(
      "chr-1",
      { allocation: { strength: 1 }, version: 1 },
      user
    )
    expect(first.character.version).toBe(2)
    expect(dbMock.store.events).toHaveLength(1)
    expect(dbMock.store.events[0].kind).toBe("allocate")

    await expect(
      allocateCharacter(
        "chr-1",
        { allocation: { strength: 2 }, version: 1 },
        user
      )
    ).rejects.toMatchObject({ status: 409, code: "version_conflict" })

    const fresh = dbMock.store.characters.get("chr-1")!
    expect(fresh.version).toBe(2)
    expect(dbMock.store.events).toHaveLength(1)
  })

  it("allocateCharacter rejects one of two concurrent same-version requests", async () => {
    const state = createInitialState("born", null, null)
    state.historicalLevelAwards.push({
      track: "class",
      level: 1,
      definitionId: "d",
      fixed: makeVector({ strength: 1 }),
      free: 10,
    })
    seedCharacter({ state: serializeState(state), version: 1 })
    const results = await Promise.allSettled([
      allocateCharacter(
        "chr-1",
        { allocation: { strength: 1 }, version: 1 },
        user
      ),
      allocateCharacter(
        "chr-1",
        { allocation: { agility: 1 }, version: 1 },
        user
      ),
    ])
    assertOneConflict(results)
    const fresh = dbMock.store.characters.get("chr-1")!
    expect(fresh.version).toBe(2)
    expect(dbMock.store.events).toHaveLength(1)
  })

  it("evolveCharacter rejects a stale version and never writes a stale event", async () => {
    dbMock.store.addCatalog({
      id: "race-2",
      kind: "races",
      stableId: "elf",
      name: "Elf",
      config: {
        raceDefinitions: {
          F: { id: "elf:F", perLevel: { agility: 2 }, freePerLevel: 2 },
        },
      },
    })
    const state = createInitialState("integrated", null, null)
    state.tracks.class = { level: 20, quarter: 0, definitionId: "archer:F" }
    seedCharacter({ state: serializeState(state), version: 1 })

    // A concurrent, unrelated mutation already bumped the version to 2 (grade
    // untouched). The evolution to F is otherwise valid (grade G, race level 10),
    // so it must 409 on the stale version rather than write an event or grade.
    await updateCharacter("chr-1", { name: "Renamed", version: 1 }, user)
    await expect(
      evolveCharacter(
        "chr-1",
        { track: "race", optionId: "race-2", version: 1 },
        user
      )
    ).rejects.toMatchObject({ status: 409, code: "version_conflict" })

    const fresh = dbMock.store.characters.get("chr-1")!
    expect(fresh.version).toBe(2)
    // No evolve event, no grade change - only the update event remains.
    expect(dbMock.store.events).toHaveLength(1)
    expect(dbMock.store.events[0].kind).toBe("update")
  })

  it("evolveCharacter handles two concurrent same-version requests with one winner", async () => {
    dbMock.store.addCatalog({
      id: "race-2",
      kind: "races",
      stableId: "elf",
      name: "Elf",
      config: {
        raceDefinitions: {
          F: { id: "elf:F", perLevel: { agility: 2 }, freePerLevel: 2 },
        },
      },
    })
    const state = createInitialState("integrated", null, null)
    state.tracks.class = { level: 20, quarter: 0, definitionId: "archer:F" }
    seedCharacter({ state: serializeState(state), version: 2 })
    const results = await Promise.allSettled([
      evolveCharacter(
        "chr-1",
        { track: "race", optionId: "race-2", version: 2 },
        user
      ),
      evolveCharacter(
        "chr-1",
        { track: "race", optionId: "race-2", version: 2 },
        user
      ),
    ])
    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    // The loser either 409s (it read grade G before the winner committed) or
    // 400s (it read grade F after the winner committed, so F is no longer a
    // higher grade). Either way only one evolve event is ever written.
    const reason = (rejected[0] as PromiseRejectedResult).reason as {
      status?: number
    }
    expect(reason.status).toBeGreaterThanOrEqual(400)
    expect(dbMock.store.characters.get("chr-1")!.version).toBe(3)
    expect(dbMock.store.events).toHaveLength(1)
    expect(dbMock.store.events[0].kind).toBe("evolve")
  })
})

describe("race adoption (monster vs enlightened)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function seedMonsterRace() {
    dbMock.store.addCatalog({
      id: "race-m",
      kind: "races",
      stableId: "wyrm",
      name: "Wyrm",
      config: {
        raceType: "monster",
        naturalGrade: "F",
        raceDefinitions: {
          F: { id: "wyrm:F", perLevel: { strength: 2 }, freePerLevel: 1 },
        },
      },
    })
  }

  function seedEnlightenedRace() {
    dbMock.store.addCatalog({
      id: "race-e",
      kind: "races",
      stableId: "human",
      name: "Human",
      config: {
        raceType: "enlightened",
        naturalGrade: "F",
        raceDefinitions: {
          G: { id: "human:G", perLevel: { strength: 1 }, freePerLevel: 1 },
          F: { id: "human:F", perLevel: { strength: 1 }, freePerLevel: 1 },
        },
      },
    })
  }

  function seedClassF() {
    dbMock.store.addCatalog({
      id: "cls-f",
      kind: "classes",
      stableId: "archer",
      name: "Archer",
      grade: "F",
      config: { grades: { F: { fixed: { agility: 2 }, free: 1 } } },
    })
  }

  function seedClassE() {
    dbMock.store.addCatalog({
      id: "cls-e",
      kind: "classes",
      stableId: "mage",
      name: "Mage",
      grade: "E",
      config: { grades: { E: { fixed: { wisdom: 2 }, free: 1 } } },
    })
  }

  function seedProfessionF() {
    dbMock.store.addCatalog({
      id: "prof-f",
      kind: "professions",
      stableId: "alchemist",
      name: "Alchemist",
      grade: "F",
      config: { grades: { F: { fixed: { wisdom: 1 }, free: 1 } } },
    })
  }

  it("creates a monster as race-only with independent mode and no tracks", async () => {
    seedMonsterRace()
    const detail = await createCharacter(
      {
        name: "Wyrm",
        origin: "born",
        raceId: "race-m",
        classId: null,
        professionId: null,
      },
      user
    )
    expect(detail.classId).toBeNull()
    expect(detail.professionId).toBeNull()
    const state = detail.state as CharacterState
    expect(state.race.mode).toBe("independent")
    expect(state.race.grade).toBe("F")
    expect(state.race.quarter).toBe(0)
    expect(Object.keys(state.tracks)).toEqual([])
  })

  it("rejects a class or profession on a monster", async () => {
    seedMonsterRace()
    seedClassF()
    seedProfessionF()
    await expect(
      createCharacter(
        {
          name: "Wyrm",
          origin: "born",
          raceId: "race-m",
          classId: "cls-f",
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "invalid_class" })
    await expect(
      createCharacter(
        {
          name: "Wyrm",
          origin: "born",
          raceId: "race-m",
          classId: null,
          professionId: "prof-f",
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "invalid_profession" })
  })

  it("rejects a null class on an enlightened race", async () => {
    seedEnlightenedRace()
    seedClassF()
    await expect(
      createCharacter(
        {
          name: "Human",
          origin: "integrated",
          raceId: "race-e",
          classId: null,
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "invalid_class" })
  })

  it("enforces exact natural-grade eligibility for an enlightened race", async () => {
    seedEnlightenedRace()
    seedClassF()
    // A class at the natural grade (F) with an F config is accepted.
    const ok = await createCharacter(
      {
        name: "Archer",
        origin: "born",
        raceId: "race-e",
        classId: "cls-f",
      },
      user
    )
    expect((ok.state as CharacterState).tracks.class.grade).toBe("F")

    // A class NOT at the natural grade is rejected, even though it defines a track.
    seedClassE()
    await expect(
      createCharacter(
        {
          name: "Mage",
          origin: "born",
          raceId: "race-e",
          classId: "cls-e",
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "invalid_class_grade" })
  })

  it("requires a race definition for the starting grade at create", async () => {
    // Enlightened race with only an F definition: an integrated character starts
    // at G and must be rejected.
    dbMock.store.addCatalog({
      id: "race-no-g",
      kind: "races",
      stableId: "human",
      name: "Human",
      config: {
        raceType: "enlightened",
        naturalGrade: "F",
        raceDefinitions: {
          F: { id: "human:F", perLevel: { strength: 1 }, freePerLevel: 1 },
        },
      },
    })
    seedClassF()
    await expect(
      createCharacter(
        {
          name: "Human",
          origin: "integrated",
          raceId: "race-no-g",
          classId: "cls-f",
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "invalid_race_grade" })
  })

  it("creates an integrated monster at grade G and advances using the G race definition", async () => {
    dbMock.store.addCatalog({
      id: "race-m-g",
      kind: "races",
      stableId: "wyrm",
      name: "Wyrm",
      config: {
        raceType: "monster",
        naturalGrade: "B",
        raceDefinitions: {
          G: { id: "wyrm:G", perLevel: { strength: 2 }, freePerLevel: 1 },
          B: { id: "wyrm:B", perLevel: { strength: 2 }, freePerLevel: 1 },
        },
      },
    })
    const created = await createCharacter(
      {
        name: "Wyrm",
        origin: "integrated",
        raceId: "race-m-g",
        classId: null,
      },
      user
    )
    const state = created.state as CharacterState
    expect(state.race.grade).toBe("G")
    expect(state.race.mode).toBe("independent")
    // Advancing the race track four quarters levels up and snapshots the G-per-level
    // definition, not the monster's natural B grade.
    let version = created.version
    let charId = created.id
    let current = state
    for (let i = 0; i < 4; i++) {
      const { character } = await advanceCharacter(
        charId,
        { track: "race", version },
        user
      )
      current = character.state as CharacterState
      version = character.version
      charId = character.id
    }
    expect(current.race.level).toBe(1)
    expect(current.race.quarter).toBe(0)
    expect(current.historicalLevelAwards[0]).toMatchObject({
      track: "race",
      definitionId: "wyrm:G",
    })
  })

  it("creates a born monster at its natural grade", async () => {
    dbMock.store.addCatalog({
      id: "race-m-b",
      kind: "races",
      stableId: "wyrm",
      name: "Wyrm",
      config: {
        raceType: "monster",
        naturalGrade: "B",
        raceDefinitions: {
          B: { id: "wyrm:B", perLevel: { strength: 2 }, freePerLevel: 1 },
        },
      },
    })
    const created = await createCharacter(
      { name: "Wyrm", origin: "born", raceId: "race-m-b", classId: null },
      user
    )
    const state = created.state as CharacterState
    expect(state.race.grade).toBe("B")
    expect(state.race.mode).toBe("independent")
  })

  it("rejects an integrated monster whose race lacks a G definition", async () => {
    dbMock.store.addCatalog({
      id: "race-m-no-g",
      kind: "races",
      stableId: "wyrm",
      name: "Wyrm",
      config: {
        raceType: "monster",
        naturalGrade: "B",
        raceDefinitions: {
          B: { id: "wyrm:B", perLevel: { strength: 2 }, freePerLevel: 1 },
        },
      },
    })
    await expect(
      createCharacter(
        {
          name: "Wyrm",
          origin: "integrated",
          raceId: "race-m-no-g",
          classId: null,
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "invalid_race_grade" })
  })

  it("advances a monster on the race-only four-quarter cadence", async () => {
    seedMonsterRace()
    const created = await createCharacter(
      {
        name: "Wyrm",
        origin: "born",
        raceId: "race-m",
        classId: null,
      },
      user
    )
    let version = created.version
    let charId = created.id
    let state = created.state as CharacterState
    for (let i = 0; i < 3; i++) {
      const { character: c } = await advanceCharacter(
        charId,
        { track: "race", version },
        user
      )
      state = c.state as CharacterState
      version = c.version
      charId = c.id
    }
    expect(state.race.quarter).toBe(3)
    expect(state.race.level).toBe(0)
    // The fourth quarter levels up and snapshots the race award.
    const { character: c4 } = await advanceCharacter(
      charId,
      { track: "race", version },
      user
    )
    state = c4.state as CharacterState
    expect(state.race.level).toBe(1)
    expect(state.race.quarter).toBe(0)
    expect(state.historicalLevelAwards).toHaveLength(1)
    expect(state.historicalLevelAwards[0].track).toBe("race")
    expect(state.historicalLevelAwards[0].fixed.strength).toBe(2)
  })

  it("rejects a class/profession advance on a monster and a race advance on an enlightened race", async () => {
    seedMonsterRace()
    const created = await createCharacter(
      { name: "Wyrm", origin: "born", raceId: "race-m", classId: null },
      user
    )
    await expect(
      advanceCharacter(created.id, { track: "class", version: 0 }, user)
    ).rejects.toMatchObject({ status: 400, code: "invalid_track" })

    seedEnlightenedRace()
    seedClassF()
    const human = await createCharacter(
      {
        name: "Human",
        origin: "integrated",
        raceId: "race-e",
        classId: "cls-f",
      },
      user
    )
    await expect(
      advanceCharacter(human.id, { track: "race", version: 0 }, user)
    ).rejects.toMatchObject({ status: 400, code: "invalid_track" })
  })

  // Monster import/export classification lives with the race-adoption rules: a
  // monster is race-only, so its imported identity must carry no class/profession
  // reference and its imported state must declare no class/profession track.
  function monsterState(): CharacterState {
    return createInitialState(
      "born",
      {
        kind: "races",
        stableId: "wyrm",
        name: "Wyrm",
        config: {
          raceType: "monster",
          naturalGrade: "F",
          raceDefinitions: {
            F: { id: "wyrm:F", perLevel: { strength: 2 }, freePerLevel: 1 },
          },
        },
      },
      null
    )
  }

  function monsterDoc(
    overrides: {
      class?: { stableId: string | null }
      profession?: { stableId: string } | null
      state?: CharacterState
    } = {}
  ): CharacterImportDocument {
    const state = overrides.state ?? monsterState()
    const identityClass = overrides.class ?? { stableId: null }
    const identityProfession =
      overrides.profession !== undefined ? overrides.profession : null
    return {
      schema: IMPORT_SCHEMA_V3,
      rulesetVersion: IMPORT_RULESET_VERSION,
      identity: {
        name: "Wyrm",
        description: null,
        origin: "born",
        race: { stableId: "wyrm" },
        class: identityClass,
        profession: identityProfession,
      },
      state: serializeState(state) as CharacterImportDocument["state"],
      liveState: {},
      status: {},
      associations: [],
      events: [],
      skillOffers: [],
    } as CharacterImportDocument
  }

  it("imports a monster backup as race-only with null class and no tracks", async () => {
    seedMonsterRace()
    const imported = await importCharacter(monsterDoc(), user)
    expect(imported.classId).toBeNull()
    expect(imported.professionId).toBeNull()
    const state = imported.state as CharacterState
    expect(state.race.mode).toBe("independent")
    expect(state.race.quarter).toBe(0)
    expect(state.race.grade).toBe("F")
    expect(Object.keys(state.tracks)).toEqual([])
  })

  it("rejects an imported monster that declares a class identity", async () => {
    seedMonsterRace()
    await expect(
      importCharacter(monsterDoc({ class: { stableId: "archer" } }), user)
    ).rejects.toMatchObject({ status: 400, code: "invalid_import" })
  })

  it("rejects an imported monster that declares a profession identity", async () => {
    seedMonsterRace()
    await expect(
      importCharacter(
        monsterDoc({ profession: { stableId: "alchemist" } }),
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "invalid_import" })
  })

  it("rejects an imported monster state that declares a class track", async () => {
    seedMonsterRace()
    const state = monsterState()
    state.tracks["class"] = { level: 0, quarter: 0, definitionId: "archer:F" }
    await expect(
      importCharacter(monsterDoc({ state }), user)
    ).rejects.toMatchObject({ status: 400, code: "invalid_import" })
  })

  it("rejects an imported monster state that declares a profession track", async () => {
    seedMonsterRace()
    const state = monsterState()
    state.tracks["profession"] = {
      level: 0,
      quarter: 0,
      definitionId: "alchemist:G",
    }
    await expect(
      importCharacter(monsterDoc({ state }), user)
    ).rejects.toMatchObject({ status: 400, code: "invalid_import" })
  })

  it("rejects an imported monster whose race mode is derived (race_type/mode mismatch)", async () => {
    seedMonsterRace()
    const state = monsterState()
    state.race.mode = "derived"
    await expect(
      importCharacter(monsterDoc({ state }), user)
    ).rejects.toMatchObject({
      status: 400,
      code: "import_race_mode_mismatch",
    })
  })

  it("rejects an imported enlightened (legacy no-raceType) state whose race mode is independent", async () => {
    // A legacy race config with no raceType defaults to enlightened (derived mode).
    dbMock.store.addCatalog({
      id: "race-legacy",
      kind: "races",
      stableId: "wyrm",
      name: "Wyrm",
      config: {
        naturalGrade: "F",
        raceDefinitions: {
          F: { id: "wyrm:F", perLevel: { strength: 2 }, freePerLevel: 1 },
        },
      },
    })
    seedClassF()
    // The state declares independent (monster) mode; the resolved race is
    // enlightened, so the mode mismatch must win over the derived-mode track
    // validation.
    const state = monsterState()
    state.race.mode = "independent"
    const doc = monsterDoc({ state, class: { stableId: "archer" } })
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "import_race_mode_mismatch",
    })
  })

  it("exports a monster with a null class/profession identity and no tracks", async () => {
    seedMonsterRace()
    const created = await createCharacter(
      { name: "Wyrm", origin: "born", raceId: "race-m", classId: null },
      user
    )
    const exported = (await exportCharacter(created.id, user)) as Record<
      string,
      unknown
    >
    const identity = exported.identity as {
      class: { stableId: string | null }
      profession: { stableId: string } | null
    }
    expect(identity.class.stableId).toBeNull()
    expect(identity.profession).toBeNull()
    const state = exported.state as CharacterState
    expect(state.race.mode).toBe("independent")
    expect(state.race.quarter).toBe(0)
    expect(Object.keys(state.tracks)).toEqual([])
  })

  it("rejects an imported monster race level past the next grade entry level (import_grade_blocked)", async () => {
    seedMonsterRace()
    const state = monsterState()
    // The monster advances race-only; F's next grade is E (entryLevel 25). A level
    // past that threshold can never advance (the first level-up would reject), so
    // the import must be rejected before any write.
    state.race.level = 26
    await expect(
      importCharacter(monsterDoc({ state }), user)
    ).rejects.toMatchObject({ status: 400, code: "import_grade_blocked" })
    // No character row was created.
    expect(dbMock.store.characters.size).toBe(0)
  })

  it("accepts an imported monster race level exactly at the next grade entry level", async () => {
    seedMonsterRace()
    const state = monsterState()
    // Equality is allowed: F level 25 sits exactly at the E threshold (25).
    state.race.level = 25
    const imported = await importCharacter(monsterDoc({ state }), user)
    expect((imported.state as CharacterState).race.level).toBe(25)
  })

  it("accepts a born monster at a higher natural grade with level 0", async () => {
    // A race with a high natural grade, imported at level 0, must not be rejected
    // just because the stored grade is higher than the starting grade.
    dbMock.store.addCatalog({
      id: "race-m-b",
      kind: "races",
      stableId: "wyrm",
      name: "Wyrm",
      config: {
        raceType: "monster",
        naturalGrade: "B",
        raceDefinitions: {
          B: { id: "wyrm:B", perLevel: { strength: 2 }, freePerLevel: 1 },
        },
      },
    })
    const state = monsterState()
    state.race.grade = "B"
    state.race.level = 0
    const doc = monsterDoc({ state })
    const imported = await importCharacter(doc, user)
    const importedState = imported.state as CharacterState
    expect(importedState.race.grade).toBe("B")
    expect(importedState.race.level).toBe(0)
  })
})

describe("createCharacter special abilities (atomic selection)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  // A minimal valid race + class so `createCharacter` only needs a
  // `specialAbilities` selection to exercise the new path.
  function seedCreateBase() {
    dbMock.store.addCatalog({
      id: "race-1",
      kind: "races",
      stableId: "human",
      name: "Human",
      config: {
        raceDefinitions: {
          G: { id: "human:G", perLevel: { strength: 1 }, freePerLevel: 1 },
        },
      },
    })
    dbMock.store.addCatalog({
      id: "cls-1",
      kind: "classes",
      stableId: "archer",
      name: "Archer",
      config: { grades: { F: { fixed: { agility: 2 }, free: 1 } } },
    })
  }

  function seedBlessing(
    id: string,
    config: Record<string, unknown>,
    extra: Partial<{ archived: boolean }> = {}
  ): unknown {
    // A blessing link now points at a `gods` definition; the legacy `blessings`
    // catalog kind is retired. Accept BOTH the modern god config ({blessingEffects})
    // and the legacy blessing config ({tier, effects}) so existing fixtures keep
    // their shape: the legacy shape is normalized into a single blessingEffects
    // entry. The god id is used directly as the association definitionId.
    const normalized =
      config.blessingEffects != null
        ? { ...config }
        : {
            blessingEffects: {
              [(config.tier as string | undefined) ?? "Minor"]:
                config.effects ?? [],
            },
          }
    return dbMock.store.addCatalog({
      id,
      kind: "gods",
      stableId: id,
      name: `Blessing ${id}`,
      config: normalized,
      ...(extra.archived != null ? { archived: extra.archived } : {}),
    })
  }

  function seedBloodline(
    id: string,
    config: Record<string, unknown>,
    extra: Partial<{ archived: boolean }> = {}
  ): unknown {
    return dbMock.store.addCatalog({
      id,
      kind: "bloodlines",
      stableId: id,
      name: `Bloodline ${id}`,
      config,
      ...(extra.archived != null ? { archived: extra.archived } : {}),
    })
  }

  function seedTranscendent(
    id: string,
    config: Record<string, unknown>,
    extra: Partial<{ archived: boolean }> = {}
  ): unknown {
    return dbMock.store.addCatalog({
      id,
      kind: "transcendent_skills",
      stableId: id,
      name: `Transcendent ${id}`,
      config,
      ...(extra.archived != null ? { archived: extra.archived } : {}),
    })
  }

  function flatDelta(status: unknown, name: string): number | undefined {
    const phases = (
      status as {
        traces?: Array<{
          attribute: string
          phases: Array<{ phase: string; delta: number }>
        }>
      }
    ).traces?.find((t) => t.attribute === name)?.phases
    return phases?.find((p) => p.phase === "flat")?.delta
  }

  it("links a blessing, bloodline and transcendent skill atomically and synthesizes their declared effects", async () => {
    seedCreateBase()
    seedBlessing("bless-1", {
      tier: "Minor",
      effects: [{ phase: "flat", amount: { strength: 5 } }],
    })
    seedBloodline("blood-1", {
      effects: [{ phase: "flat", amount: { agility: 3 } }],
    })
    seedTranscendent("trans-1", {
      passiveEffects: [{ phase: "flat", amount: { perception: 4 } }],
    })
    const detail = await createCharacter(
      {
        name: "Kael",
        origin: "integrated",
        raceId: "race-1",
        classId: "cls-1",
        specialAbilities: {
          blessing: { godId: "bless-1", tier: "Minor" },
          bloodlineIds: ["blood-1"],
          transcendentSkillIds: ["trans-1"],
        },
      },
      user
    )
    // All three links are persisted with their catalog kind.
    expect(detail.associations.map((a) => a.kind).sort()).toEqual([
      "blessing",
      "bloodline",
      "transcendent",
    ])
    expect(detail.isTranscendent).toBe(true)
    // Each declared effect is synthesized live into status.
    expect(flatDelta(detail.status, "strength")).toBe(5)
    expect(flatDelta(detail.status, "agility")).toBe(3)
    expect(flatDelta(detail.status, "perception")).toBe(4)
    // The stored `state` stays immutable - effects live only in the live merge.
    expect(
      (detail.state as { activeEffects: unknown[] }).activeEffects
    ).toEqual([])
    // The create journal records a snapshot + provenance of each selection.
    const payload = dbMock.store.events[0].payload as {
      specialAbilities: {
        blessing: { id: string; provenance: string }
        bloodlines: Array<{ id: string; provenance: string }>
        transcendentSkills: Array<{ id: string; provenance: string }>
      }
    }
    expect(dbMock.store.events[0].kind).toBe("create")
    expect(payload.specialAbilities.blessing).toMatchObject({
      id: "bless-1",
      provenance: "catalog",
    })
    expect(payload.specialAbilities.bloodlines[0]).toMatchObject({
      id: "blood-1",
      provenance: "catalog",
    })
    expect(payload.specialAbilities.transcendentSkills[0]).toMatchObject({
      id: "trans-1",
      provenance: "catalog",
    })
    expect(dbMock.store.associations).toHaveLength(3)
  })

  it("rejects a missing special-ability id and rolls back (no character/event/link)", async () => {
    seedCreateBase()
    await expect(
      createCharacter(
        {
          name: "Kael",
          origin: "integrated",
          raceId: "race-1",
          classId: "cls-1",
          specialAbilities: {
            blessing: { godId: "missing-bless", tier: "Minor" },
          },
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "catalog_not_found" })
    expect(dbMock.store.characters.size).toBe(0)
    expect(dbMock.store.events).toHaveLength(0)
    expect(dbMock.store.associations).toHaveLength(0)
  })

  it("rejects a special-ability id of the wrong catalog kind", async () => {
    seedCreateBase()
    // A bloodline requested as a blessing is the wrong kind.
    seedBloodline("blood-1", { effects: [] })
    await expect(
      createCharacter(
        {
          name: "Kael",
          origin: "integrated",
          raceId: "race-1",
          classId: "cls-1",
          specialAbilities: {
            blessing: { godId: "blood-1", tier: "Minor" },
          },
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "wrong_kind" })
    expect(dbMock.store.characters.size).toBe(0)
    expect(dbMock.store.events).toHaveLength(0)
    expect(dbMock.store.associations).toHaveLength(0)
  })

  it("rejects an archived special-ability definition and rolls back", async () => {
    seedCreateBase()
    seedBlessing("bless-1", { effects: [] }, { archived: true })
    await expect(
      createCharacter(
        {
          name: "Kael",
          origin: "integrated",
          raceId: "race-1",
          classId: "cls-1",
          specialAbilities: {
            blessing: { godId: "bless-1", tier: "Minor" },
          },
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "catalog_archived" })
    expect(dbMock.store.characters.size).toBe(0)
    expect(dbMock.store.events).toHaveLength(0)
    expect(dbMock.store.associations).toHaveLength(0)
  })

  it("rejects a duplicate bloodline selection as a link_collision (two bloodline slots)", async () => {
    seedCreateBase()
    seedBloodline("blood-1", { effects: [] })
    await expect(
      createCharacter(
        {
          name: "Kael",
          origin: "integrated",
          raceId: "race-1",
          classId: "cls-1",
          specialAbilities: { bloodlineIds: ["blood-1", "blood-1"] },
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "link_collision" })
    expect(dbMock.store.characters.size).toBe(0)
    expect(dbMock.store.events).toHaveLength(0)
    expect(dbMock.store.associations).toHaveLength(0)
  })

  it("rejects selecting two bloodlines (at most one may be linked)", async () => {
    seedCreateBase()
    seedBloodline("blood-1", { effects: [], upgradeGroup: "primal" })
    seedBloodline("blood-2", { effects: [], upgradeGroup: "primal" })
    await expect(
      createCharacter(
        {
          name: "Kael",
          origin: "integrated",
          raceId: "race-1",
          classId: "cls-1",
          specialAbilities: { bloodlineIds: ["blood-1", "blood-2"] },
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "link_collision" })
    expect(dbMock.store.characters.size).toBe(0)
    expect(dbMock.store.events).toHaveLength(0)
    expect(dbMock.store.associations).toHaveLength(0)
  })

  it("rejects a create that selects more than the configured transcendent cap", async () => {
    seedCreateBase()
    for (let i = 1; i <= 4; i++) {
      seedTranscendent(`trans-${i}`, { passiveEffects: [] })
    }
    await expect(
      createCharacter(
        {
          name: "Kael",
          origin: "integrated",
          raceId: "race-1",
          classId: "cls-1",
          specialAbilities: {
            transcendentSkillIds: ["trans-1", "trans-2", "trans-3", "trans-4"],
          },
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "link_collision" })
    expect(dbMock.store.characters.size).toBe(0)
    expect(dbMock.store.events).toHaveLength(0)
    expect(dbMock.store.associations).toHaveLength(0)
  })

  it("rolls back links, character and event on a stale draftVersion", async () => {
    seedCreateBase()
    seedBlessing("bless-1", { effects: [] })
    dbMock.store.addDraft({
      userId: user.id,
      data: { step: 4, name: "Kael" },
      version: 5,
    })
    await expect(
      createCharacter(
        {
          name: "Kael",
          origin: "integrated",
          raceId: "race-1",
          classId: "cls-1",
          specialAbilities: {
            blessing: { godId: "bless-1", tier: "Minor" },
          },
          draftVersion: 3,
        },
        user
      )
    ).rejects.toMatchObject({ status: 409, code: "draft_conflict" })
    expect(dbMock.store.characters.size).toBe(0)
    expect(dbMock.store.events).toHaveLength(0)
    expect(dbMock.store.associations).toHaveLength(0)
    // The draft is preserved - the stale consume never committed.
    expect(dbMock.store.drafts.size).toBe(1)
  })

  it("creates a character with no abilities when specialAbilities is omitted", async () => {
    seedCreateBase()
    const detail = await createCharacter(
      {
        name: "Kael",
        origin: "integrated",
        raceId: "race-1",
        classId: "cls-1",
      },
      user
    )
    expect(detail.associations).toHaveLength(0)
    expect(detail.isTranscendent).toBe(false)
    expect(dbMock.store.associations).toHaveLength(0)
    expect(flatDelta(detail.status, "strength")).toBe(0)
    // No specialAbilities block is written to the journal when nothing is selected.
    const payload = dbMock.store.events[0].payload as Record<string, unknown>
    expect("specialAbilities" in payload).toBe(false)
  })

  it("does not grant a power from a legacy draft special:true without an explicit selection", async () => {
    seedCreateBase()
    // The draft carries the legacy `special` flag but no `specialAbilities`.
    dbMock.store.addDraft({
      userId: user.id,
      data: { step: 4, name: "Kael", special: true },
      version: 4,
    })
    const detail = await createCharacter(
      {
        name: "Kael",
        origin: "integrated",
        raceId: "race-1",
        classId: "cls-1",
        draftVersion: 4,
      },
      user
    )
    expect(detail.associations).toHaveLength(0)
    expect(detail.isTranscendent).toBe(false)
    expect(dbMock.store.associations).toHaveLength(0)
    expect(flatDelta(detail.status, "strength")).toBe(0)
    expect(dbMock.store.events).toHaveLength(1)
    const payload = dbMock.store.events[0].payload as Record<string, unknown>
    expect("specialAbilities" in payload).toBe(false)
    // The draft was consumed because the create succeeded.
    expect(dbMock.store.drafts.size).toBe(0)
  })
})

describe("character profile metadata (create/read/edit/clear)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function seedRaceClass() {
    dbMock.store.addCatalog({
      id: "race-1",
      kind: "races",
      stableId: "human",
      name: "Human",
      config: {
        raceDefinitions: {
          G: { id: "human:G", perLevel: { strength: 1 }, freePerLevel: 1 },
        },
      },
    })
    dbMock.store.addCatalog({
      id: "cls-1",
      kind: "classes",
      stableId: "archer",
      name: "Archer",
      config: { grades: { F: { fixed: { agility: 2 }, free: 1 } } },
    })
  }

  function defaultIdentity() {
    return {
      name: "Imported",
      description: null,
      origin: "integrated" as const,
      race: { stableId: "human" },
      class: { stableId: "archer" },
      profession: null,
    }
  }

  function makeV3Doc(
    identityOverride: Record<string, unknown> = {}
  ): CharacterImportDocument {
    return {
      schema: IMPORT_SCHEMA_V3,
      rulesetVersion: IMPORT_RULESET_VERSION,
      identity: {
        ...defaultIdentity(),
        ...identityOverride,
      } as CharacterImportDocument["identity"],
      state: serializeState(createInitialState("integrated", null, null)),
      liveState: {},
      status: {},
      associations: [],
      events: [],
      skillOffers: [],
    } as CharacterImportDocument
  }

  function makeV4Doc(
    identityOverride: Record<string, unknown> = {}
  ): CharacterImportDocument {
    return {
      schema: IMPORT_SCHEMA_V4,
      rulesetVersion: IMPORT_RULESET_VERSION,
      identity: {
        ...defaultIdentity(),
        ...identityOverride,
      } as CharacterImportDocument["identity"],
      state: serializeState(createInitialState("integrated", null, null)),
      liveState: {},
      status: {},
      associations: [],
      inventory: [],
      events: [],
      skillOffers: [],
    } as CharacterImportDocument
  }

  it("creates a character with profile metadata and returns it in detail", async () => {
    seedRaceClass()
    const detail = await createCharacter(
      {
        name: "Kael",
        origin: "integrated",
        raceId: "race-1",
        classId: "cls-1",
        nickname: "Kael",
        pronouns: "they/them",
        ageDescription: "A youthful 30",
        appearance: "Tall, dark hair",
        biography: "Grew up in the lowlands",
        notes: "Private GM notes",
      },
      user
    )
    expect(detail.nickname).toBe("Kael")
    expect(detail.pronouns).toBe("they/them")
    expect(detail.ageDescription).toBe("A youthful 30")
    expect(detail.appearance).toBe("Tall, dark hair")
    expect(detail.biography).toBe("Grew up in the lowlands")
    expect(detail.notes).toBe("Private GM notes")
    // The create journal names only the supplied metadata fields, never the prose.
    const createPayload = dbMock.store.events[0].payload as Record<
      string,
      unknown
    >
    expect(createPayload.metadataFields).toEqual([
      "nickname",
      "pronouns",
      "ageDescription",
      "appearance",
      "biography",
      "notes",
    ])
  })

  it("creates a character with omitted metadata as null", async () => {
    seedRaceClass()
    const detail = await createCharacter(
      { name: "N", origin: "integrated", raceId: "race-1", classId: "cls-1" },
      user
    )
    expect(detail.nickname).toBeNull()
    expect(detail.pronouns).toBeNull()
    expect(detail.ageDescription).toBeNull()
    expect(detail.appearance).toBeNull()
    expect(detail.biography).toBeNull()
    expect(detail.notes).toBeNull()
  })

  it("reads profile metadata through getCharacter", async () => {
    seedRaceClass()
    const created = await createCharacter(
      {
        name: "N",
        origin: "integrated",
        raceId: "race-1",
        classId: "cls-1",
        nickname: "Kael",
      },
      user
    )
    const read = await getCharacter(created.id, user)
    expect(read.nickname).toBe("Kael")
    expect(read.pronouns).toBeNull()
  })

  it("edits and clears profile metadata through updateCharacter", async () => {
    seedRaceClass()
    const created = await createCharacter(
      { name: "N", origin: "integrated", raceId: "race-1", classId: "cls-1" },
      user
    )
    const updated = await updateCharacter(
      created.id,
      {
        nickname: "Renamed",
        pronouns: null,
        biography: "new bio",
        version: created.version,
      },
      user
    )
    expect(updated.nickname).toBe("Renamed")
    expect(updated.pronouns).toBeNull()
    expect(updated.biography).toBe("new bio")
    const cleared = await updateCharacter(
      created.id,
      { nickname: null, version: updated.version },
      user
    )
    expect(cleared.nickname).toBeNull()
    expect(cleared.biography).toBe("new bio")
  })

  it("records the update journal as changed field names + actor, never the prose", async () => {
    seedRaceClass()
    const created = await createCharacter(
      { name: "N", origin: "integrated", raceId: "race-1", classId: "cls-1" },
      user
    )
    await updateCharacter(
      created.id,
      {
        appearance: "Very long appearance prose ".repeat(10),
        notes: "private",
      },
      user
    )
    // events[0] is the create event; events[1] is the update event.
    const payload = dbMock.store.events[1].payload as Record<string, unknown>
    expect(payload.changedFields).toEqual(["appearance", "notes"])
    expect(payload.actorId).toBe(user.id)
    // The long prose / private notes are not duplicated into the journal.
    expect(payload.appearance).toBeUndefined()
    expect(payload.notes).toBeUndefined()
  })

  it("round-trips profile metadata through export and re-import (v4)", async () => {
    seedRaceClass()
    const src = await createCharacter(
      {
        name: "Kael",
        origin: "integrated",
        raceId: "race-1",
        classId: "cls-1",
        nickname: "Kael",
        pronouns: "they/them",
        appearance: "Tall, dark hair",
        biography: "Grew up in the lowlands",
        notes: "Private GM notes",
      },
      user
    )
    const exported = (await exportCharacter(
      src.id,
      user
    )) as unknown as CharacterImportDocument
    const identity = exported.identity as Record<string, unknown>
    expect(identity.nickname).toBe("Kael")
    expect(identity.notes).toBe("Private GM notes")

    const imported = await importCharacter(exported, user)
    expect(imported.nickname).toBe("Kael")
    expect(imported.pronouns).toBe("they/them")
    expect(imported.appearance).toBe("Tall, dark hair")
    expect(imported.biography).toBe("Grew up in the lowlands")
    expect(imported.notes).toBe("Private GM notes")
  })

  it("imports a v3/v4 backup with metadata fields absent as null", async () => {
    seedRaceClass()
    const imported = await importCharacter(makeV3Doc(), user)
    expect(imported.nickname).toBeNull()
    expect(imported.pronouns).toBeNull()
    expect(imported.ageDescription).toBeNull()
    expect(imported.appearance).toBeNull()
    expect(imported.biography).toBeNull()
    expect(imported.notes).toBeNull()
  })

  it("imports a v4 backup with metadata fields populated", async () => {
    seedRaceClass()
    const doc = makeV4Doc({
      nickname: "Kael",
      pronouns: "they/them",
      ageDescription: "30",
      appearance: "Tall",
      biography: "Lowlands",
      notes: "GM note",
    })
    const imported = await importCharacter(doc, user)
    expect(imported.nickname).toBe("Kael")
    expect(imported.pronouns).toBe("they/them")
    expect(imported.ageDescription).toBe("30")
    expect(imported.appearance).toBe("Tall")
    expect(imported.biography).toBe("Lowlands")
    expect(imported.notes).toBe("GM note")
  })

  it("preserves exact whitespace and newlines in multiline metadata through create/update/read", async () => {
    seedRaceClass()
    const bio = "\n  first line\n  second line  \n\n"
    const notes = "  \nleading space line\n\tindented\t\n"
    const created = await createCharacter(
      {
        name: "N",
        origin: "integrated",
        raceId: "race-1",
        classId: "cls-1",
        biography: bio,
        notes,
      },
      user
    )
    // The create must not trim leading/trailing whitespace or newlines.
    expect(created.biography).toBe(bio)
    expect(created.notes).toBe(notes)

    const read = await getCharacter(created.id, user)
    expect(read.biography).toBe(bio)
    expect(read.notes).toBe(notes)

    const updated = await updateCharacter(
      created.id,
      {
        biography: bio + "\nappended  ",
        notes: notes + "more\t",
        version: created.version,
      },
      user
    )
    expect(updated.biography).toBe(bio + "\nappended  ")
    expect(updated.notes).toBe(notes + "more\t")
  })

  it("stores an empty-string metadata field as null, never as an empty value", async () => {
    seedRaceClass()
    const created = await createCharacter(
      {
        name: "N",
        origin: "integrated",
        raceId: "race-1",
        classId: "cls-1",
        biography: "",
        notes: "x",
        pronouns: "",
      },
      user
    )
    // The exact empty string is normalized to NULL; a non-empty value survives.
    expect(created.biography).toBeNull()
    expect(created.pronouns).toBeNull()
    expect(created.notes).toBe("x")
    // An empty-string field is NOT recorded as supplied metadata.
    const createPayload = dbMock.store.events[0].payload as Record<
      string,
      unknown
    >
    expect(createPayload.metadataFields).toEqual(["notes"])
  })
})

describe("associateCharacter (titles / equipment)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function seedCharacterWithBase(attrs: Record<string, number> = {}) {
    const state = createInitialState("integrated", null, null)
    state.baseAttributes = {
      strength: 0,
      agility: 0,
      endurance: 0,
      vitality: 0,
      toughness: 0,
      wisdom: 0,
      intelligence: 0,
      perception: 0,
      willpower: 0,
      ...attrs,
    }
    return dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      state: serializeState(state),
      version: 0,
    })
  }

  function seedTitle(
    id: string,
    config: Record<string, unknown>,
    extra: Partial<{ name: string; archived: boolean }> = {}
  ) {
    return dbMock.store.addCatalog({
      id,
      kind: "titles",
      stableId: id,
      name: extra.name ?? `Title ${id}`,
      config,
      ...(extra.archived != null ? { archived: extra.archived } : {}),
    })
  }

  function seedEquipment(
    id: string,
    config: Record<string, unknown>,
    extra: Partial<{ name: string; archived: boolean }> = {}
  ) {
    return dbMock.store.addCatalog({
      id,
      kind: "equipment",
      stableId: id,
      name: extra.name ?? `Gear ${id}`,
      config,
      ...(extra.archived != null ? { archived: extra.archived } : {}),
    })
  }

  function seedStock(definitionId: string, quantity = 10) {
    return dbMock.store.addInventoryItem({
      characterId: "chr-1",
      definitionId,
      quantity,
    })
  }

  it("adds a title link and synthesizes its flat effect into status", async () => {
    seedCharacterWithBase()
    seedTitle("title-1", { flat: { strength: 5 }, upgradeGroup: "hero" })
    const res = await associateCharacter(
      "chr-1",
      { kind: "title", definitionId: "title-1", operation: "add", version: 0 },
      user
    )
    expect(res.character.version).toBe(1)
    expect(res.character.associations).toHaveLength(1)
    expect(res.character.associations[0]).toMatchObject({
      definitionId: "title-1",
      kind: "title",
      name: "Title title-1",
      upgradeGroup: "hero",
    })
    // Live status must include the synthesized flat effect.
    const strengthTrace = res.character.status?.traces.find(
      (t) => t.attribute === "strength"
    )
    const flatPhase = strengthTrace?.phases.find((p) => p.phase === "flat")
    expect(flatPhase?.delta).toBe(5)
    // Journal entry is immutable and records the add.
    expect(dbMock.store.events).toHaveLength(1)
    expect(dbMock.store.events[0].kind).toBe("associate")
    expect(dbMock.store.events[0].payload).toMatchObject({
      operation: "add",
      kind: "title",
      definitionId: "title-1",
    })
  })

  it("adds an equipment link and synthesizes its live bonus (capped by base)", async () => {
    seedCharacterWithBase({ strength: 100 })
    seedEquipment("gear-1", { slot: "head", bonus: { strength: 10 } })
    seedStock("gear-1")
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "gear-1",
        operation: "add",
        version: 0,
      },
      user
    )
    expect(res.character.associations).toHaveLength(1)
    expect(res.character.associations[0]).toMatchObject({
      definitionId: "gear-1",
      kind: "equipment",
      name: "Gear gear-1",
      slot: "head",
    })
    const items = res.character.status?.equipment.items ?? []
    expect(items).toHaveLength(1)
    expect(items[0].requested.strength).toBe(10)
    // 20% individual cap of 100 = 20, so the full 10 applies.
    expect(items[0].applied.strength).toBe(10)
    expect(items[0].suppressed.strength).toBe(0)
  })

  it("synthesizes the combined flat + percent live bonus when the item is eligible", async () => {
    seedCharacterWithBase({ strength: 100 })
    seedEquipment("gear-pct", {
      slot: "head",
      bonus: { strength: 10 },
      percentBasisPoints: { strength: 1000 }, // 10%
    })
    seedStock("gear-pct")
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "gear-pct",
        operation: "add",
        version: 0,
      },
      user
    )
    const items = res.character.status?.equipment.items ?? []
    expect(items).toHaveLength(1)
    // flat request 10; percent request floor((100 + 10) * 0.1) = 11.
    expect(items[0].requested.strength).toBe(21)
    // flat 10 caps within the 20% individual budget; the percent shares the
    // remaining individual budget (10) but the overall 15% budget has only 5 left
    // (15 - 10 already consumed by flat), so the combined applied is 15.
    expect(items[0].applied.strength).toBe(15)
    expect(items[0].suppressed.strength).toBe(6)
    // The equipment-percent cap is surfaced explicitly in the status aggregate.
    const aggregate = res.character.status?.equipment
    expect(aggregate?.requested.strength).toBe(21)
    expect(aggregate?.applied.strength).toBe(15)
    expect(aggregate?.suppressed.strength).toBe(6)
    const pctOverall = aggregate?.capUsage.find(
      (c) => c.name === "equipment-percent-overall"
    )
    expect(pctOverall).toBeDefined()
    // The trace records the percent contribution in its own phase.
    const strengthTrace = res.character.status?.traces.find(
      (t) => t.attribute === "strength"
    )
    const phases = strengthTrace?.phases.map((p) => p.phase) ?? []
    expect(phases).toContain("equipment-percent")
    const pctPhase = strengthTrace?.phases.find(
      (p) => p.phase === "equipment-percent"
    )
    expect(pctPhase?.delta).toBe(5)
  })

  it("does not synthesize an equipment percent bonus while the item is ineligible", async () => {
    seedCharacterWithBase({ strength: 100 })
    // The character's race level is 0, below the declared requirement.
    seedEquipment("gear-inel", {
      slot: "head",
      bonus: { strength: 10 },
      percentBasisPoints: { strength: 1000 },
      minRaceLevel: 5,
    })
    seedStock("gear-inel")
    // Link the item directly (bypassing the associateCharacter add gate, which
    // rejects an unmet requirement with a 400) so the ineligible link can be read
    // live and proven inert.
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "gear-inel",
      kind: "EQUIPMENT",
    })
    const detail = await getCharacter("chr-1", user)
    const items = detail.status?.equipment.items ?? []
    expect(items).toHaveLength(1)
    // Ineligible => both flat and percent are inert (no request, no contribution).
    expect(items[0].requested.strength).toBe(0)
    expect(items[0].applied.strength).toBe(0)
    expect(items[0].suppressed.strength).toBe(0)
    // No equipment-percent trace phase is emitted for an inert percent request.
    const strengthTrace = detail.status?.traces.find(
      (t) => t.attribute === "strength"
    )
    const phases = strengthTrace?.phases.map((p) => p.phase) ?? []
    expect(phases).not.toContain("equipment-percent")
  })

  it("synthesizes derived HP/MP/SP maxima bonuses from catalog config without disturbing attribute caps", async () => {
    // Base attributes large enough that the 20%/15% attribute equipment caps apply
    // to the flat attribute bonus but never touch the derived resource maxima.
    seedCharacterWithBase({ vitality: 100, wisdom: 100, endurance: 100 })
    seedEquipment("gear-derived", {
      slot: "head",
      bonus: { vitality: 10 },
      derivedFlat: { hp: 50, mp: 25 },
      derivedPercentBasisPoints: { hp: 1000, mp: 2000 }, // 10% HP / 20% MP
    })
    seedStock("gear-derived")
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "gear-derived",
        operation: "add",
        version: 0,
      },
      user
    )
    const items = res.character.status?.equipment.items ?? []
    expect(items).toHaveLength(1)
    // The attribute equipment bonus is capped as usual: vitality 10 on base 100
    // (20% individual cap = 20, 15% overall cap = 15) applies fully.
    expect(items[0].requested.vitality).toBe(10)
    expect(items[0].applied.vitality).toBe(10)
    expect(items[0].suppressed.vitality).toBe(0)
    // The derived resource maxima are computed independently of the attribute caps.
    const derived = res.character.status?.derivedStats
    expect(derived).toBeDefined()
    // HP base = final vitality (110) * 10 = 1100; flat +50; percent
    // floor((1100 + 50) * 0.1) = 115 => 1265.
    expect(derived?.hp).toBe(1265)
    // MP base = wisdom (100) * 10 = 1000; flat +25; percent
    // floor((1000 + 25) * 0.2) = 205 => 1230.
    expect(derived?.mp).toBe(1230)
    // SP base = endurance (100) * 10 = 1000; no flat / percent => 1000.
    expect(derived?.sp).toBe(1000)
  })

  it("keeps equipment derived HP/MP/SP bonuses inert while the item is ineligible", async () => {
    seedCharacterWithBase({ vitality: 100, wisdom: 100, endurance: 100 })
    // The character's race level is 0, below the declared requirement.
    seedEquipment("gear-inel-derived", {
      slot: "head",
      bonus: { vitality: 10 },
      derivedFlat: { hp: 50, mp: 25 },
      derivedPercentBasisPoints: { hp: 1000, mp: 2000 },
      minRaceLevel: 5,
    })
    seedStock("gear-inel-derived")
    // Link the item directly (bypassing the associateCharacter add gate, which
    // rejects an unmet requirement with a 400) so the ineligible link can be read
    // live and proven inert.
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "gear-inel-derived",
      kind: "EQUIPMENT",
    })
    const detail = await getCharacter("chr-1", user)
    const items = detail.status?.equipment.items ?? []
    expect(items).toHaveLength(1)
    // Ineligible => flat attribute bonus is inert (no request, no contribution).
    expect(items[0].requested.vitality).toBe(0)
    expect(items[0].applied.vitality).toBe(0)
    expect(items[0].suppressed.vitality).toBe(0)
    // The derived HP/MP/SP maxima bonuses are inert too: only the base remains.
    const derived = detail.status?.derivedStats
    expect(derived?.hp).toBe(1000)
    expect(derived?.mp).toBe(1000)
    expect(derived?.sp).toBe(1000)
  })

  it("equipment add replaces the item currently equipped in the same slot", async () => {
    seedCharacterWithBase({ strength: 100 })
    seedEquipment("gear-1", { slot: "head", bonus: { strength: 10 } })
    seedEquipment("gear-2", { slot: "head", bonus: { strength: 20 } })
    seedStock("gear-1")
    seedStock("gear-2")
    await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "gear-1",
        operation: "add",
        version: 0,
      },
      user
    )
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "gear-2",
        operation: "add",
        version: 1,
      },
      user
    )
    // Only the new item remains linked.
    expect(res.character.associations.map((a) => a.definitionId)).toEqual([
      "gear-2",
    ])
    // The event records the displaced old item.
    const event = dbMock.store.events[dbMock.store.events.length - 1]
    expect(event.payload).toMatchObject({
      operation: "add",
      kind: "equipment",
      definitionId: "gear-2",
      added: { id: "gear-2", name: "Gear gear-2" },
      removed: [{ definitionId: "gear-1", name: "Gear gear-1" }],
    })
    const removedArr = (event.payload as { removed: Array<{ id: string }> })
      .removed
    expect(removedArr).toHaveLength(1)
    expect(removedArr[0].id).toBeTruthy()
    expect(
      (event.payload as { definition: { slot: string } }).definition.slot
    ).toBe("head")
    expect(res.character.version).toBe(2)
  })

  it("title add replaces the title in the same upgrade group and never stacks", async () => {
    seedCharacterWithBase()
    seedTitle("title-1", { flat: { strength: 5 }, upgradeGroup: "evolution" })
    seedTitle("title-2", { flat: { strength: 9 }, upgradeGroup: "evolution" })
    await associateCharacter(
      "chr-1",
      { kind: "title", definitionId: "title-1", operation: "add", version: 0 },
      user
    )
    const res = await associateCharacter(
      "chr-1",
      { kind: "title", definitionId: "title-2", operation: "add", version: 1 },
      user
    )
    expect(res.character.associations.map((a) => a.definitionId)).toEqual([
      "title-2",
    ])
    // The live status must reflect only the superseding title.
    const strengthTrace = res.character.status?.traces.find(
      (t) => t.attribute === "strength"
    )
    const flatPhase = strengthTrace?.phases.find((p) => p.phase === "flat")
    expect(flatPhase?.delta).toBe(9)
    expect(dbMock.store.events).toHaveLength(2)
  })

  it("removes only the linked entry", async () => {
    seedCharacterWithBase()
    seedTitle("title-1", { flat: { strength: 5 } })
    await associateCharacter(
      "chr-1",
      { kind: "title", definitionId: "title-1", operation: "add", version: 0 },
      user
    )
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "title",
        definitionId: "title-1",
        operation: "remove",
        version: 1,
      },
      user
    )
    expect(res.character.associations).toHaveLength(0)
    expect(res.character.version).toBe(2)
    expect(dbMock.store.events).toHaveLength(2)
    expect(dbMock.store.events[1].payload).toMatchObject({
      operation: "remove",
      kind: "title",
      definitionId: "title-1",
    })
  })

  it("rejects duplicate add, archived and wrong-kind definitions", async () => {
    seedCharacterWithBase()
    seedTitle("title-1", { flat: { strength: 5 } })
    seedEquipment("gear-1", { slot: "head" })
    seedTitle("title-archived", { flat: {} }, { archived: true })

    await associateCharacter(
      "chr-1",
      { kind: "title", definitionId: "title-1", operation: "add", version: 0 },
      user
    )
    // Duplicate.
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "title",
          definitionId: "title-1",
          operation: "add",
          version: 1,
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "duplicate" })
    // Archived.
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "title",
          definitionId: "title-archived",
          operation: "add",
          version: 1,
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "catalog_archived" })
    // Wrong kind (equipment definition requested as a title).
    await expect(
      associateCharacter(
        "chr-1",
        { kind: "title", definitionId: "gear-1", operation: "add", version: 1 },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "wrong_kind" })
    // Remove something never linked.
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "equipment",
          definitionId: "gear-1",
          operation: "remove",
          version: 1,
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "not_linked" })
  })

  it("rejects a stale version (409) and never leaks an event or a link", async () => {
    seedCharacterWithBase()
    seedTitle("title-1", { flat: { strength: 5 } })
    seedTitle("title-2", { flat: { agility: 3 } })
    const first = await associateCharacter(
      "chr-1",
      { kind: "title", definitionId: "title-1", operation: "add", version: 0 },
      user
    )
    expect(first.character.version).toBe(1)
    expect(dbMock.store.events).toHaveLength(1)

    // A concurrent request still holding version 0, adding a NEW (non-duplicate)
    // definition, must not create a link/event on a stale version.
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "title",
          definitionId: "title-2",
          operation: "add",
          version: 0,
        },
        user
      )
    ).rejects.toMatchObject({ status: 409, code: "version_conflict" })

    expect(dbMock.store.characters.get("chr-1")!.version).toBe(1)
    expect(dbMock.store.events).toHaveLength(1)
    expect(dbMock.store.associations).toHaveLength(1)
    expect(dbMock.store.associations[0].definitionId).toBe("title-1")
  })

  it("remove permits an archived linked catalog entry (only add is blocked)", async () => {
    seedCharacterWithBase()
    seedTitle("title-1", { flat: { strength: 5 } })
    await associateCharacter(
      "chr-1",
      { kind: "title", definitionId: "title-1", operation: "add", version: 0 },
      user
    )
    // Archive the linked definition after it was attached.
    dbMock.store.addCatalog({
      id: "title-1",
      kind: "titles",
      stableId: "title-1",
      name: "Title title-1",
      config: { flat: { strength: 5 } },
      archived: true,
    })
    // Remove must still succeed - the category is archived but still linked.
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "title",
        definitionId: "title-1",
        operation: "remove",
        version: 1,
      },
      user
    )
    expect(res.character.associations).toHaveLength(0)
    expect(res.character.version).toBe(2)
    // Adding an archived definition is still rejected.
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "title",
          definitionId: "title-1",
          operation: "add",
          version: 2,
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "catalog_archived" })
  })

  it("equipment add removes ALL existing items in the same slot atomically", async () => {
    seedCharacterWithBase({ strength: 100 })
    seedEquipment("gear-1", { slot: "head", bonus: { strength: 10 } })
    seedEquipment("gear-2", { slot: "head", bonus: { strength: 20 } })
    seedEquipment("gear-3", { slot: "head", bonus: { strength: 30 } })
    seedStock("gear-1")
    seedStock("gear-2")
    seedStock("gear-3")
    // Two items already occupy the same slot on the character (e.g. legacy data).
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "gear-1",
      kind: "EQUIPMENT",
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "gear-2",
      kind: "EQUIPMENT",
    })
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "gear-3",
        operation: "add",
        version: 0,
      },
      user
    )
    expect(res.character.associations.map((a) => a.definitionId)).toEqual([
      "gear-3",
    ])
    const event = dbMock.store.events[dbMock.store.events.length - 1]
    const removed = (
      event.payload as {
        removed: Array<{ id: string; definitionId: string; name: string }>
      }
    ).removed
    expect(removed.map((r) => r.definitionId).sort()).toEqual([
      "gear-1",
      "gear-2",
    ])
    expect(res.character.version).toBe(1)
  })

  it("title add removes ALL existing titles in the same upgrade group", async () => {
    seedCharacterWithBase()
    seedTitle("title-1", { flat: { strength: 5 }, upgradeGroup: "evolution" })
    seedTitle("title-2", { flat: { strength: 9 }, upgradeGroup: "evolution" })
    seedTitle("title-3", { flat: { strength: 13 }, upgradeGroup: "evolution" })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "title-1",
      kind: "TITLE",
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "title-2",
      kind: "TITLE",
    })
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "title",
        definitionId: "title-3",
        operation: "add",
        version: 0,
      },
      user
    )
    expect(res.character.associations.map((a) => a.definitionId)).toEqual([
      "title-3",
    ])
    expect(
      res.character.associations.every((a) => a.definitionArchived === false)
    ).toBe(true)
  })

  it("Ring add requires an explicit position (400 ring_position_required)", async () => {
    seedCharacterWithBase()
    seedEquipment("ring-a", { slot: "Ring", bonus: { strength: 5 } })
    seedStock("ring-a")
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "equipment",
          definitionId: "ring-a",
          operation: "add",
          version: 0,
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "ring_position_required" })
    // Nothing was linked.
    expect(dbMock.store.associations).toHaveLength(0)
  })

  it("Ring add rejects an invalid position value via the schema", async () => {
    seedCharacterWithBase()
    seedEquipment("ring-a", { slot: "Ring", bonus: { strength: 5 } })
    seedStock("ring-a")
    // The associationSchema itself rejects a position that is not Ring 1 / Ring 2.
    expect(
      associationSchema.safeParse({
        kind: "equipment",
        definitionId: "ring-a",
        operation: "add",
        version: 0,
        equipmentPosition: "Ring",
      }).success
    ).toBe(false)
  })

  it("non-Ring equipment add forbids a ring position (400 position_not_allowed)", async () => {
    seedCharacterWithBase()
    seedEquipment("neck-1", { slot: "Neck", bonus: { strength: 5 } })
    seedStock("neck-1")
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "equipment",
          definitionId: "neck-1",
          operation: "add",
          version: 0,
          equipmentPosition: "Ring 1",
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "position_not_allowed" })
    expect(dbMock.store.associations).toHaveLength(0)
  })

  it("adding a Ring 1 then a Ring 2 item keeps both distinct rings", async () => {
    seedCharacterWithBase({ strength: 100 })
    seedEquipment("ring-a", { slot: "Ring", bonus: { strength: 10 } })
    seedEquipment("ring-b", { slot: "Ring", bonus: { strength: 20 } })
    seedStock("ring-a")
    seedStock("ring-b")
    await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "ring-a",
        operation: "add",
        version: 0,
        equipmentPosition: "Ring 1",
      },
      user
    )
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "ring-b",
        operation: "add",
        version: 1,
        equipmentPosition: "Ring 2",
      },
      user
    )
    expect(res.character.associations).toHaveLength(2)
    // The single canonical "Ring" slot is shown on both; the worn position is the
    // per-link equipmentPosition, never conflated with the slot.
    const byId = Object.fromEntries(
      res.character.associations.map((a) => [a.definitionId, a])
    )
    expect(byId["ring-a"]).toMatchObject({
      kind: "equipment",
      slot: "Ring",
      equipmentPosition: "Ring 1",
    })
    expect(byId["ring-b"]).toMatchObject({
      kind: "equipment",
      slot: "Ring",
      equipmentPosition: "Ring 2",
    })
    expect(res.character.version).toBe(2)
  })

  it("adding a different Ring in an occupied position replaces only that position", async () => {
    seedCharacterWithBase({ strength: 100 })
    seedEquipment("ring-a", { slot: "Ring", bonus: { strength: 10 } })
    seedEquipment("ring-b", { slot: "Ring", bonus: { strength: 20 } })
    seedStock("ring-a")
    seedStock("ring-b")
    await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "ring-a",
        operation: "add",
        version: 0,
        equipmentPosition: "Ring 1",
      },
      user
    )
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "ring-b",
        operation: "add",
        version: 1,
        equipmentPosition: "Ring 1",
      },
      user
    )
    // Only the new item remains linked - the old ring at the same position was
    // displaced, and the event records it.
    expect(res.character.associations.map((a) => a.definitionId)).toEqual([
      "ring-b",
    ])
    expect(res.character.associations[0]).toMatchObject({
      equipmentPosition: "Ring 1",
    })
    const event = dbMock.store.events[dbMock.store.events.length - 1]
    const removed = (
      event.payload as {
        removed: Array<{ definitionId: string }>
      }
    ).removed
    expect(removed.map((r) => r.definitionId)).toEqual(["ring-a"])
  })

  it("rejects a duplicate same-definition Ring add even when the other position is free", async () => {
    seedCharacterWithBase()
    seedEquipment("ring-a", { slot: "Ring", bonus: { strength: 10 } })
    seedStock("ring-a")
    await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "ring-a",
        operation: "add",
        version: 0,
        equipmentPosition: "Ring 1",
      },
      user
    )
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "equipment",
          definitionId: "ring-a",
          operation: "add",
          version: 1,
          equipmentPosition: "Ring 2",
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "duplicate" })
    // The original link is untouched.
    expect(dbMock.store.associations).toHaveLength(1)
  })

  it("Ring remove ignores the supplied position (position is add-only)", async () => {
    seedCharacterWithBase()
    seedEquipment("ring-a", { slot: "Ring", bonus: { strength: 5 } })
    seedStock("ring-a")
    await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "ring-a",
        operation: "add",
        version: 0,
        equipmentPosition: "Ring 1",
      },
      user
    )
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "ring-a",
        operation: "remove",
        version: 1,
        equipmentPosition: "Ring 2",
      },
      user
    )
    expect(res.character.associations).toHaveLength(0)
    expect(res.character.version).toBe(2)
  })

  it("synthesizes the combined flat + percent live bonus for a Ring-slot item", async () => {
    seedCharacterWithBase({ strength: 100 })
    seedEquipment("ring-pct", {
      slot: "Ring",
      bonus: { strength: 10 },
      percentBasisPoints: { strength: 1000 }, // 10%
    })
    seedStock("ring-pct")
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "ring-pct",
        operation: "add",
        version: 0,
        equipmentPosition: "Ring 1",
      },
      user
    )
    const items = res.character.status?.equipment.items ?? []
    expect(items).toHaveLength(1)
    expect(items[0].requested.strength).toBe(21)
    expect(items[0].applied.strength).toBe(15)
    expect(items[0].suppressed.strength).toBe(6)
  })
})

describe("ranked title progression (associateCharacter)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function seedCharacter(grade: Grade): unknown {
    const state = createInitialState("integrated", null, null)
    state.race = { ...state.race, grade }
    return dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      state: serializeState(state),
      version: 0,
    })
  }

  function seedRankedTitle(
    id: string,
    rank: number,
    minRaceGrade: Grade,
    total: number,
    extra: Partial<{ name: string; archived: boolean }> = {}
  ): unknown {
    return dbMock.store.addCatalog({
      id,
      kind: "titles",
      stableId: id,
      name: extra.name ?? `Pioneer ${rank}`,
      config: {
        upgradeGroup: "dungeon-pioneer",
        improvement: {
          seriesId: "dungeon-pioneer",
          rank,
          minRaceGrade,
        },
        flat: allEqual(total),
      },
      ...(extra.archived != null ? { archived: extra.archived } : {}),
    })
  }

  function seedUnrankedTitle(
    id: string,
    config: Record<string, unknown>,
    extra: Partial<{ name: string; archived: boolean }> = {}
  ): unknown {
    return dbMock.store.addCatalog({
      id,
      kind: "titles",
      stableId: id,
      name: extra.name ?? `Title ${id}`,
      config,
      ...(extra.archived != null ? { archived: extra.archived } : {}),
    })
  }

  it("adds ranked titles strictly one-by-one across the E->D grade tiers, replacing the prior", async () => {
    seedCharacter("D")
    // Seed ranks 1..6 (1-5 E-tier, 6 D-tier).
    for (let rank = 1; rank <= 6; rank++) {
      seedRankedTitle(`dp-${rank}`, rank, rank <= 5 ? "E" : "D", rank * 3)
    }
    let expectedVersion = 0
    let prevId: string | null = null
    for (let rank = 1; rank <= 6; rank++) {
      const id = `dp-${rank}`
      const res = await associateCharacter(
        "chr-1",
        {
          kind: "title",
          definitionId: id,
          operation: "add",
          version: expectedVersion,
          reason: `cleared rank ${rank}`,
        },
        user
      )
      expectedVersion++
      // Only the latest rank remains linked; the prior is atomically replaced.
      expect(res.character.associations.map((a) => a.definitionId)).toEqual([
        id,
      ])
      expect(res.character.version).toBe(expectedVersion)
      expect(res.character.associations[0].improvement).toEqual({
        seriesId: "dungeon-pioneer",
        rank,
        minRaceGrade: rank <= 5 ? "E" : "D",
      })
      if (prevId != null) {
        // The removal journal names the superseded prior rank.
        const event = dbMock.store.events[dbMock.store.events.length - 1]
        const removed = (
          event.payload as { removed: Array<{ definitionId: string }> }
        ).removed
        expect(removed.some((r) => r.definitionId === prevId)).toBe(true)
      }
      prevId = id
    }
    // The final event carries the full improvement snapshot and the reason.
    const event = dbMock.store.events[dbMock.store.events.length - 1]
    expect(event.payload).toMatchObject({
      operation: "add",
      kind: "title",
      definitionId: "dp-6",
      reason: "cleared rank 6",
      definition: {
        id: "dp-6",
        improvement: {
          seriesId: "dungeon-pioneer",
          rank: 6,
          minRaceGrade: "D",
        },
      },
    })
  })

  it("rejects a ranked title add without a reason (no write or event)", async () => {
    seedCharacter("D")
    seedRankedTitle("dp-1", 1, "E", 3)
    await expect(
      associateCharacter(
        "chr-1",
        { kind: "title", definitionId: "dp-1", operation: "add", version: 0 },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "title_reason_required" })
    // Nothing written: version unchanged, no event, no link.
    expect(dbMock.store.characters.get("chr-1")!.version).toBe(0)
    expect(dbMock.store.events).toHaveLength(0)
    expect(dbMock.store.associations).toHaveLength(0)
  })

  it("rejects a skipped/no prior rank with title_rank_conflict", async () => {
    seedCharacter("D")
    seedRankedTitle("dp-1", 1, "E", 3)
    seedRankedTitle("dp-3", 3, "E", 9)
    // Rank 3 with no prior at all.
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "title",
          definitionId: "dp-3",
          operation: "add",
          version: 0,
          reason: "x",
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "title_rank_conflict" })
    // Add rank 1, then jump to rank 3 (skipping rank 2).
    await associateCharacter(
      "chr-1",
      {
        kind: "title",
        definitionId: "dp-1",
        operation: "add",
        version: 0,
        reason: "x",
      },
      user
    )
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "title",
          definitionId: "dp-3",
          operation: "add",
          version: 1,
          reason: "x",
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "title_rank_conflict" })
  })

  it("rejects a low race grade against a ranked title minRaceGrade", async () => {
    seedCharacter("E") // E-grade character cannot take a D-grade rank.
    seedRankedTitle("dp-6", 6, "D", 24)
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "title",
          definitionId: "dp-6",
          operation: "add",
          version: 0,
          reason: "x",
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "title_grade_blocked" })
  })

  it("rejects a duplicate series link (rank 1 cannot downgrade over a later rank)", async () => {
    seedCharacter("D")
    seedRankedTitle("dp-1", 1, "E", 3)
    seedRankedTitle("dp-2", 2, "E", 6)
    await associateCharacter(
      "chr-1",
      {
        kind: "title",
        definitionId: "dp-1",
        operation: "add",
        version: 0,
        reason: "x",
      },
      user
    )
    // Adding rank 1 again (same definition) is a duplicate.
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "title",
          definitionId: "dp-1",
          operation: "add",
          version: 1,
          reason: "x",
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "duplicate" })
    // Adding rank 1 while rank 2 is present (after progressing) is a downgrade.
    await associateCharacter(
      "chr-1",
      {
        kind: "title",
        definitionId: "dp-2",
        operation: "add",
        version: 1,
        reason: "x",
      },
      user
    )
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "title",
          definitionId: "dp-1",
          operation: "add",
          version: 2,
          reason: "x",
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "title_rank_conflict" })
  })

  it("rejects an ambiguous rank 1 over an unrelated title in the same upgrade group", async () => {
    seedCharacter("D")
    // An unrelated (unranked) title that happens to occupy the same upgrade group.
    seedUnrankedTitle("unrelated", {
      flat: { strength: 5 },
      upgradeGroup: "dungeon-pioneer",
    })
    seedRankedTitle("dp-1", 1, "E", 3)
    await associateCharacter(
      "chr-1",
      {
        kind: "title",
        definitionId: "unrelated",
        operation: "add",
        version: 0,
      },
      user
    )
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "title",
          definitionId: "dp-1",
          operation: "add",
          version: 1,
          reason: "x",
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "title_rank_conflict" })
    // The unrelated title is untouched.
    expect(dbMock.store.associations.map((a) => a.definitionId)).toEqual([
      "unrelated",
    ])
  })

  it("counts an archived prior title link for rank progression", async () => {
    seedCharacter("D")
    seedRankedTitle("dp-1", 1, "E", 3)
    seedRankedTitle("dp-2", 2, "E", 6)
    await associateCharacter(
      "chr-1",
      {
        kind: "title",
        definitionId: "dp-1",
        operation: "add",
        version: 0,
        reason: "x",
      },
      user
    )
    // Archive the linked rank-1 definition (still linked).
    dbMock.store.addCatalog({
      id: "dp-1",
      kind: "titles",
      stableId: "dp-1",
      name: "Pioneer 1",
      config: {
        upgradeGroup: "dungeon-pioneer",
        improvement: {
          seriesId: "dungeon-pioneer",
          rank: 1,
          minRaceGrade: "E",
        },
        flat: allEqual(3),
      },
      archived: true,
    })
    // Rank 2 can still be added: the archived rank-1 link is the required prior.
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "title",
        definitionId: "dp-2",
        operation: "add",
        version: 1,
        reason: "x",
      },
      user
    )
    expect(res.character.associations.map((a) => a.definitionId)).toEqual([
      "dp-2",
    ])
  })

  it("rejects a non-owner (unauthorized) ranked title add", async () => {
    seedCharacter("D")
    seedRankedTitle("dp-1", 1, "E", 3)
    const stranger = { id: "user-2", email: "s@example.com", isAdmin: false }
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "title",
          definitionId: "dp-1",
          operation: "add",
          version: 0,
          reason: "x",
        },
        stranger
      )
    ).rejects.toMatchObject({ status: 403, code: "forbidden" })
  })

  it("accepts the Baptism tier on a blessing add and records it in the event", async () => {
    const state = createInitialState("integrated", null, null)
    dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      state: serializeState(state),
      version: 0,
    })
    dbMock.store.addCatalog({
      id: "bless-baptism",
      kind: "gods",
      stableId: "bless-baptism",
      name: "Baptism Blessing",
      config: { blessingEffects: { Baptism: [] } },
    })
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "blessing",
        definitionId: "bless-baptism",
        operation: "add",
        version: 0,
        tier: "Baptism",
      },
      user
    )
    expect(res.character.associations).toHaveLength(1)
    expect(res.character.associations[0].kind).toBe("blessing")
    const event = dbMock.store.events[dbMock.store.events.length - 1]
    expect(event.payload).toMatchObject({
      kind: "blessing",
      definition: { tier: "Baptism", id: "bless-baptism" },
    })
  })

  it("rejects a rank>1 add when an unrelated title occupies the same upgrade group", async () => {
    seedCharacter("D")
    seedRankedTitle("dp-1", 1, "E", 3)
    seedRankedTitle("dp-2", 2, "E", 6)
    seedUnrankedTitle("stray", {
      flat: { strength: 5 },
      upgradeGroup: "dungeon-pioneer",
    })
    // Seed the prior rank AND the unrelated title directly, so the add flow's
    // same-group deletion cannot remove the prior before the rank gate runs.
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "dp-1",
      kind: "TITLE",
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "stray",
      kind: "TITLE",
    })
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "title",
          definitionId: "dp-2",
          operation: "add",
          version: 0,
          reason: "x",
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "title_rank_conflict" })
    // Nothing written: no link changed, no event, version unchanged.
    expect(dbMock.store.characters.get("chr-1")!.version).toBe(0)
    expect(dbMock.store.events).toHaveLength(0)
    expect(
      dbMock.store.associations
        .map((a) => a.definitionId)
        .sort((a, b) => a.localeCompare(b))
    ).toEqual(["dp-1", "stray"])
  })

  it("accepts a rank>1 add when only the prior series link occupies the upgrade group", async () => {
    seedCharacter("D")
    seedRankedTitle("dp-1", 1, "E", 3)
    seedRankedTitle("dp-2", 2, "E", 6)
    // Seed only the prior rank link; no unrelated same-group title.
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "dp-1",
      kind: "TITLE",
    })
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "title",
        definitionId: "dp-2",
        operation: "add",
        version: 0,
        reason: "x",
      },
      user
    )
    expect(res.character.associations.map((a) => a.definitionId)).toEqual([
      "dp-2",
    ])
    expect(res.character.version).toBe(1)
  })

  it("rejects adding an unranked title into an upgrade group held by a ranked title (400 title_rank_conflict)", async () => {
    seedCharacter("D")
    seedRankedTitle("dp-1", 1, "E", 3)
    // Link the ranked rank-1 title first; it is the authority for rank progression.
    await associateCharacter(
      "chr-1",
      {
        kind: "title",
        definitionId: "dp-1",
        operation: "add",
        version: 0,
        reason: "x",
      },
      user
    )
    // An ordinary (unranked) title that happens to occupy the same upgrade group
    // would silently displace the ranked title and bypass its rank sequence, so it
    // must be rejected BEFORE any same-group link is removed.
    seedUnrankedTitle("plain", {
      flat: { strength: 5 },
      upgradeGroup: "dungeon-pioneer",
    })
    await expect(
      associateCharacter(
        "chr-1",
        { kind: "title", definitionId: "plain", operation: "add", version: 1 },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "title_rank_conflict" })
    // Nothing written: the ranked title stays linked, version unchanged, no event.
    expect(dbMock.store.associations.map((a) => a.definitionId)).toEqual([
      "dp-1",
    ])
    expect(dbMock.store.characters.get("chr-1")!.version).toBe(1)
    expect(dbMock.store.events).toHaveLength(1)
  })

  it("allows an unranked title to replace another unranked title in the same upgrade group", async () => {
    seedCharacter("D")
    seedUnrankedTitle("plain-1", {
      flat: { strength: 5 },
      upgradeGroup: "hero",
    })
    seedUnrankedTitle("plain-2", {
      flat: { strength: 9 },
      upgradeGroup: "hero",
    })
    await associateCharacter(
      "chr-1",
      { kind: "title", definitionId: "plain-1", operation: "add", version: 0 },
      user
    )
    const res = await associateCharacter(
      "chr-1",
      { kind: "title", definitionId: "plain-2", operation: "add", version: 1 },
      user
    )
    expect(res.character.associations.map((a) => a.definitionId)).toEqual([
      "plain-2",
    ])
    expect(res.character.version).toBe(2)
  })
})

describe("associateCharacter (blessings / bloodlines)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function seedCharacter(
    attrs: { strength?: number } = {},
    grade: Grade = "G"
  ): unknown {
    const state = createInitialState("integrated", null, null)
    if (attrs.strength != null) state.baseAttributes.strength = attrs.strength
    state.race = { ...state.race, grade }
    return dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      state: serializeState(state),
      version: 0,
    })
  }

  function seedBlessing(
    id: string,
    config: Record<string, unknown>,
    extra: Partial<{ name: string; archived: boolean }> = {}
  ): unknown {
    // A blessing link points at a `gods` definition; normalize the legacy
    // `{tier, effects}` blessing config into a god `blessingEffects` entry.
    const normalized =
      config.blessingEffects != null
        ? { ...config }
        : {
            blessingEffects: {
              [(config.tier as string | undefined) ?? "Minor"]:
                config.effects ?? [],
            },
          }
    return dbMock.store.addCatalog({
      id,
      kind: "gods",
      stableId: id,
      name: extra.name ?? `Blessing ${id}`,
      config: normalized,
      ...(extra.archived != null ? { archived: extra.archived } : {}),
    })
  }

  function seedBloodline(
    id: string,
    config: Record<string, unknown>,
    extra: Partial<{ name: string; archived: boolean }> = {}
  ): unknown {
    return dbMock.store.addCatalog({
      id,
      kind: "bloodlines",
      stableId: id,
      name: extra.name ?? `Bloodline ${id}`,
      config,
      ...(extra.archived != null ? { archived: extra.archived } : {}),
    })
  }

  function flatDelta(status: unknown, name: string): number | undefined {
    const phases = (
      status as {
        traces?: Array<{
          attribute: string
          phases: Array<{ phase: string; delta: number }>
        }>
      }
    ).traces?.find((t) => t.attribute === name)?.phases
    return phases?.find((p) => p.phase === "flat")?.delta
  }

  it("adds a blessing link and synthesizes its declared effect into status", async () => {
    seedCharacter({ strength: 100 })
    seedBlessing("bless-1", {
      tier: "Minor",
      effects: [{ phase: "flat", amount: { strength: 5 } }],
    })
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "blessing",
        definitionId: "bless-1",
        operation: "add",
        version: 0,
        tier: "Minor",
      },
      user
    )
    expect(res.character.version).toBe(1)
    expect(res.character.associations).toHaveLength(1)
    expect(res.character.associations[0]).toMatchObject({
      definitionId: "bless-1",
      kind: "blessing",
      name: "Blessing bless-1",
    })
    expect(flatDelta(res.character.status, "strength")).toBe(5)
    expect(
      (res.character.state as { activeEffects: unknown[] }).activeEffects
    ).toHaveLength(0)
    expect(dbMock.store.events).toHaveLength(1)
    expect(dbMock.store.events[0].kind).toBe("associate")
    const payload = dbMock.store.events[0].payload as {
      operation: string
      kind: string
      definitionId: string
      definition: Record<string, string | null>
      removed: unknown[]
    }
    expect(payload.operation).toBe("add")
    expect(payload.kind).toBe("blessing")
    expect(payload.definitionId).toBe("bless-1")
    // The event carries a full definition snapshot with kind and tier.
    expect(payload.definition).toMatchObject({
      id: "bless-1",
      name: "Blessing bless-1",
      kind: "gods",
      stableId: "bless-1",
      tier: "Minor",
    })
  })

  it("rejects a blessing add that omits the tier with 400 invalid_blessing_tier", async () => {
    seedCharacter()
    seedBlessing("bless-1", {
      tier: "Minor",
      effects: [{ phase: "flat", amount: { strength: 5 } }],
    })
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "blessing",
          definitionId: "bless-1",
          operation: "add",
          version: 0,
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "invalid_blessing_tier" })
    // Nothing was written: no association link and no event.
    expect(dbMock.store.associations).toHaveLength(0)
    expect(dbMock.store.events).toHaveLength(0)
  })

  it("blessing add atomically replaces ALL existing blessing links, including archived", async () => {
    seedCharacter()
    seedBlessing("bless-a", {
      tier: "Lesser",
      effects: [{ phase: "flat", amount: { strength: 3 } }],
    })
    seedBlessing(
      "bless-archived",
      { tier: "Lesser", effects: [{ phase: "flat", amount: { strength: 1 } }] },
      { archived: true }
    )
    seedBlessing("bless-new", {
      tier: "Greater",
      effects: [{ phase: "flat", amount: { strength: 9 } }],
    })
    // A legacy active blessing and an archived blessing link both exist.
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "bless-a",
      kind: "BLESSING",
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "bless-archived",
      kind: "BLESSING",
    })
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "blessing",
        definitionId: "bless-new",
        operation: "add",
        version: 0,
        tier: "Greater",
      },
      user
    )
    expect(res.character.associations.map((a) => a.definitionId)).toEqual([
      "bless-new",
    ])
    const event = dbMock.store.events[dbMock.store.events.length - 1]
    const removed = (
      event.payload as {
        removed: Array<{ definitionId: string; name: string }>
      }
    ).removed
    expect(removed.map((r) => r.definitionId).sort()).toEqual([
      "bless-a",
      "bless-archived",
    ])
  })

  it("blessing remove detaches only the named link", async () => {
    seedCharacter()
    seedBlessing("bless-1", {
      tier: "Minor",
      effects: [{ phase: "flat", amount: { strength: 5 } }],
    })
    seedBlessing("bless-2", {
      tier: "Minor",
      effects: [{ phase: "flat", amount: { strength: 7 } }],
    })
    await associateCharacter(
      "chr-1",
      {
        kind: "blessing",
        definitionId: "bless-1",
        operation: "add",
        version: 0,
        tier: "Minor",
      },
      user
    )
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "blessing",
        definitionId: "bless-2",
        operation: "add",
        version: 1,
        tier: "Minor",
      },
      user
    )
    expect(res.character.associations).toHaveLength(1)
    expect(res.character.associations[0].definitionId).toBe("bless-2")
    const removed = await associateCharacter(
      "chr-1",
      {
        kind: "blessing",
        definitionId: "bless-2",
        operation: "remove",
        version: 2,
      },
      user
    )
    expect(removed.character.associations).toHaveLength(0)
    expect(removed.character.version).toBe(3)
    expect(dbMock.store.events).toHaveLength(3)
    expect(dbMock.store.events[2].payload).toMatchObject({
      operation: "remove",
      kind: "blessing",
      definitionId: "bless-2",
    })
  })

  it("rejects a duplicate, archived and wrong-kind blessing add, and never stacks", async () => {
    seedCharacter()
    seedBlessing("bless-1", {
      tier: "Minor",
      effects: [{ phase: "flat", amount: { strength: 5 } }],
    })
    seedBlessing(
      "bless-archived",
      { tier: "Minor", effects: [] },
      { archived: true }
    )
    seedBloodline("blood-1", { effects: [] })
    await associateCharacter(
      "chr-1",
      {
        kind: "blessing",
        definitionId: "bless-1",
        operation: "add",
        version: 0,
        tier: "Minor",
      },
      user
    )
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "blessing",
          definitionId: "bless-1",
          operation: "add",
          version: 1,
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "duplicate" })
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "blessing",
          definitionId: "bless-archived",
          operation: "add",
          version: 1,
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "catalog_archived" })
    // A bloodline definition requested as a blessing is the wrong kind.
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "blessing",
          definitionId: "blood-1",
          operation: "add",
          version: 1,
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "wrong_kind" })
    expect(dbMock.store.associations).toHaveLength(1)
  })

  it("rejects a stale version (409) and rolls back a blessing add with no event", async () => {
    seedCharacter()
    seedBlessing("bless-1", {
      tier: "Minor",
      effects: [{ phase: "flat", amount: { strength: 5 } }],
    })
    seedBlessing("bless-2", {
      tier: "Greater",
      effects: [{ phase: "flat", amount: { strength: 9 } }],
    })
    const first = await associateCharacter(
      "chr-1",
      {
        kind: "blessing",
        definitionId: "bless-1",
        operation: "add",
        version: 0,
        tier: "Minor",
      },
      user
    )
    expect(first.character.version).toBe(1)
    expect(dbMock.store.events).toHaveLength(1)
    // A concurrent request still holding version 0 adding a NEW blessing (not a
    // duplicate) must not mutate the character or leak an event.
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "blessing",
          definitionId: "bless-2",
          operation: "add",
          version: 0,
          tier: "Greater",
        },
        user
      )
    ).rejects.toMatchObject({ status: 409, code: "version_conflict" })
    expect(dbMock.store.characters.get("chr-1")!.version).toBe(1)
    expect(dbMock.store.events).toHaveLength(1)
    expect(dbMock.store.associations.map((a) => a.definitionId)).toEqual([
      "bless-1",
    ])
  })

  it("removes an archived linked blessing (only add is blocked)", async () => {
    seedCharacter()
    seedBlessing("bless-1", {
      tier: "Minor",
      effects: [{ phase: "flat", amount: { strength: 5 } }],
    })
    await associateCharacter(
      "chr-1",
      {
        kind: "blessing",
        definitionId: "bless-1",
        operation: "add",
        version: 0,
        tier: "Minor",
      },
      user
    )
    dbMock.store.addCatalog({
      id: "bless-1",
      kind: "gods",
      stableId: "bless-1",
      name: "Blessing bless-1",
      config: { blessingEffects: { Minor: [] } },
      archived: true,
    })
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "blessing",
        definitionId: "bless-1",
        operation: "remove",
        version: 1,
      },
      user
    )
    expect(res.character.associations).toHaveLength(0)
  })

  it("adding a second bloodline replaces the first (at most one bloodline)", async () => {
    seedCharacter({ strength: 100 })
    seedBloodline("blood-1", {
      effects: [{ phase: "flat", amount: { strength: 3 } }],
    })
    seedBloodline("blood-2", {
      effects: [{ phase: "flat", amount: { strength: 4 } }],
    })
    await associateCharacter(
      "chr-1",
      {
        kind: "bloodline",
        definitionId: "blood-1",
        operation: "add",
        version: 0,
      },
      user
    )
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "bloodline",
        definitionId: "blood-2",
        operation: "add",
        version: 1,
      },
      user
    )
    // The singleton rule means the second bloodline supersedes the first, so only
    // blood-2 remains linked.
    expect(
      res.character.associations.map((a) => a.definitionId).sort()
    ).toEqual(["blood-2"])
    // Only the surviving bloodline's +4 applies (blood-1's +3 is superseded).
    expect(flatDelta(res.character.status, "strength")).toBe(4)
    expect(dbMock.store.events).toHaveLength(2)
  })

  it("bloodline add replaces every existing bloodline link, not just a shared group", async () => {
    seedCharacter({ strength: 100 })
    seedBloodline("blood-1", {
      upgradeGroup: "primal",
      effects: [{ phase: "flat", amount: { strength: 3 } }],
    })
    seedBloodline("blood-2", {
      upgradeGroup: "primal",
      effects: [{ phase: "flat", amount: { strength: 9 } }],
    })
    seedBloodline("blood-3", {
      effects: [{ phase: "flat", amount: { strength: 1 } }],
    })
    await associateCharacter(
      "chr-1",
      {
        kind: "bloodline",
        definitionId: "blood-1",
        operation: "add",
        version: 0,
      },
      user
    )
    await associateCharacter(
      "chr-1",
      {
        kind: "bloodline",
        definitionId: "blood-3",
        operation: "add",
        version: 1,
      },
      user
    )
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "bloodline",
        definitionId: "blood-2",
        operation: "add",
        version: 2,
      },
      user
    )
    // A bloodline add displaces EVERY existing bloodline link (active or archived),
    // not only those sharing an upgrade group, so blood-1 and blood-3 are removed.
    expect(
      res.character.associations.map((a) => a.definitionId).sort()
    ).toEqual(["blood-2"])
    const event = dbMock.store.events[dbMock.store.events.length - 1]
    const removed = (
      event.payload as {
        removed: Array<{ definitionId: string }>
      }
    ).removed
    expect(removed.map((r) => r.definitionId)).toEqual(["blood-3"])
    // Only the replacing bloodline's +9 applies.
    expect(flatDelta(res.character.status, "strength")).toBe(9)
  })

  it("synthesizes typed flat, percent and condition on a blessing, honoring the condition", async () => {
    seedCharacter({ strength: 100 }, "G")
    seedBlessing("bless-cond", {
      tier: "Minor",
      effects: [
        { phase: "flat", amount: { strength: 5 } },
        { phase: "percent", basisPoints: { strength: 1000 } },
        {
          phase: "flat",
          amount: { strength: 10 },
          condition: { kind: "gradeAtLeast", grade: "D" },
        },
      ],
    })
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "blessing",
        definitionId: "bless-cond",
        operation: "add",
        version: 0,
        tier: "Minor",
      },
      user
    )
    const state = res.character.state as { activeEffects: unknown[] }
    expect(state.activeEffects).toHaveLength(0)
    let trace = res.character.status!.traces.find(
      (t) => t.attribute === "strength"
    )!
    let flat = trace.phases.find((p) => p.phase === "flat")!
    expect(flat.delta).toBe(5)
    const percent = trace.phases.find((p) => p.phase === "percent")!
    expect(percent).toBeDefined()
    // Elevate the character to grade D so the gradeAtLeast condition is met.
    const stored = dbMock.store.characters.get("chr-1")!
    const storedState = deserializeState(stored.state)
    storedState.race.grade = "D" as Grade
    stored.state = serializeState(storedState)
    const detail = await getCharacter("chr-1", user)
    trace = detail.status!.traces.find((t) => t.attribute === "strength")!
    flat = trace.phases.find((p) => p.phase === "flat")!
    expect(flat.delta).toBe(15)
  })

  it("scales a bloodline by the EXACT race grade and never falls back to another grade", async () => {
    seedCharacter({ strength: 100 }, "G")
    seedBloodline("blood-scale", {
      effects: [{ phase: "flat", amount: { strength: 1 } }],
      gradeEffects: {
        G: [{ phase: "percent", basisPoints: { strength: 500 } }],
        F: [{ phase: "percent", basisPoints: { strength: 1000 } }],
      },
    })
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "bloodline",
        definitionId: "blood-scale",
        operation: "add",
        version: 0,
      },
      user
    )
    let trace = res.character.status!.traces.find(
      (t) => t.attribute === "strength"
    )!
    let flat = trace.phases.find((p) => p.phase === "flat")!
    expect(flat.delta).toBe(1)
    const gPercent = trace.phases.find((p) => p.phase === "percent")!
    expect(gPercent).toBeDefined()
    expect(gPercent.delta).toBe(5) // +5% on the base/derived 100
    // Grade E has no gradeEffects entry: the bloodline contributes NO percent
    // bonus (no fallback to F or G), so only the base flat applies. The percent
    // phase is always present in the trace but its delta must be 0.
    const stored = dbMock.store.characters.get("chr-1")!
    const storedState = deserializeState(stored.state)
    storedState.race.grade = "E" as Grade
    stored.state = serializeState(storedState)
    const detail = await getCharacter("chr-1", user)
    trace = detail.status!.traces.find((t) => t.attribute === "strength")!
    flat = trace.phases.find((p) => p.phase === "flat")!
    expect(flat.delta).toBe(1)
    const ePercent = trace.phases.find((p) => p.phase === "percent")!
    expect(ePercent.delta).toBe(0)
  })

  it("a catalog blessing live edit changes status but never rewrites stored state or awards", async () => {
    seedCharacter({ strength: 100 })
    seedBlessing("bless-live", {
      tier: "Lesser",
      effects: [{ phase: "flat", amount: { strength: 5 } }],
    })
    await associateCharacter(
      "chr-1",
      {
        kind: "blessing",
        definitionId: "bless-live",
        operation: "add",
        version: 0,
        tier: "Lesser",
      },
      user
    )
    const before = await getCharacter("chr-1", user)
    expect(flatDelta(before.status, "strength")).toBe(5)
    const beforeVersion = before.version
    const beforeState = before.state
    // Edit the god's blessing effect magnitude for the Lesser tier in the catalog.
    await updateCatalogItem("gods", "bless-live", {
      config: {
        blessingEffects: {
          Lesser: [{ phase: "flat", amount: { strength: 10 } }],
        },
      },
    })
    const after = await getCharacter("chr-1", user)
    expect(flatDelta(after.status, "strength")).toBe(10)
    // No character mutation: version and stored state are untouched; no event.
    expect(after.version).toBe(beforeVersion)
    expect(after.state).toEqual(beforeState)
    expect(
      (after.state as { activeEffects: unknown[] }).activeEffects
    ).toHaveLength(0)
    // The catalog edit itself does not write any character progression event.
    expect(dbMock.store.events).toHaveLength(1)
    expect(dbMock.store.events[0].kind).toBe("associate")
  })

  it("maps a concurrent blessing singleton conflict (P2002) to a 409, never a 500", async () => {
    seedCharacter()
    seedBlessing("bless-1", { tier: "Minor", effects: [] })
    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce({
      name: "PrismaClientKnownRequestError",
      code: "P2002",
      meta: { target: ["characterId"] },
    })
    try {
      await expect(
        associateCharacter(
          "chr-1",
          {
            kind: "blessing",
            definitionId: "bless-1",
            operation: "add",
            version: 0,
          },
          user
        )
      ).rejects.toMatchObject({
        status: 409,
        code: "blessing_singleton_conflict",
      })
    } finally {
      spy.mockRestore()
    }
    // The race that lost the singleton did not write anything.
    expect(dbMock.store.associations).toHaveLength(0)
  })

  it("maps a generic non-blessing association unique race to a retryable 409, never a blessing conflict", async () => {
    seedCharacter()
    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce({
      name: "PrismaClientKnownRequestError",
      code: "P2002",
      meta: { target: ["characterId", "definitionId"] },
    })
    try {
      // The same-title/equipment/bloodline slot is not a blessing singleton, so
      // the unique-race mapping must NOT label it as one.
      await expect(
        associateCharacter(
          "chr-1",
          {
            kind: "title",
            definitionId: "title-1",
            operation: "add",
            version: 0,
          },
          user
        )
      ).rejects.toMatchObject({
        status: 409,
        code: "association_conflict",
      })
    } finally {
      spy.mockRestore()
    }
  })

  it("the partial unique index rejects a second BLESSING link for the same character", async () => {
    seedCharacter()
    seedBlessing("bless-1", { tier: "Minor", effects: [] })
    seedBlessing("bless-2", { tier: "Minor", effects: [] })
    await prisma.characterAssociation.create({
      data: { characterId: "chr-1", definitionId: "bless-1", kind: "BLESSING" },
    })
    await expect(
      prisma.characterAssociation.create({
        data: {
          characterId: "chr-1",
          definitionId: "bless-2",
          kind: "BLESSING",
        },
      })
    ).rejects.toMatchObject({ code: "P2002" })
    // Only the first link survived (the index is a hard guard, not a soft one).
    expect(dbMock.store.associations).toHaveLength(1)
  })
})

describe("transcendent skills (associations / derived quality / live effects)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function seedCharacter(
    attrs: { strength?: number } = {},
    grade: Grade = "G"
  ): unknown {
    const state = createInitialState("integrated", null, null)
    if (attrs.strength != null) state.baseAttributes.strength = attrs.strength
    state.race = { ...state.race, grade }
    return dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      state: serializeState(state),
      version: 0,
    })
  }

  function seedTranscendent(
    id: string,
    config: Record<string, unknown>,
    extra: Partial<{ name: string; archived: boolean }> = {}
  ): unknown {
    return dbMock.store.addCatalog({
      id,
      kind: "transcendent_skills",
      stableId: id,
      name: extra.name ?? `Transcendent ${id}`,
      config,
      ...(extra.archived != null ? { archived: extra.archived } : {}),
    })
  }

  function flatDelta(status: unknown, name: string): number | undefined {
    const phases = (
      status as {
        traces?: Array<{
          attribute: string
          phases: Array<{ phase: string; delta: number }>
        }>
      }
    ).traces?.find((t) => t.attribute === name)?.phases
    return phases?.find((p) => p.phase === "flat")?.delta
  }

  it("rejects a NEW transcendent skill that omits passiveEffects (no fabricated default)", async () => {
    await expect(
      createCatalogItem("transcendent_skills", {
        stableId: "trans-1",
        name: "Holyland",
        config: { costDescription: "Loses a Path level to use" },
      })
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("creates a narrative-only transcendent skill with an explicit empty passiveEffects", async () => {
    const item = await createCatalogItem("transcendent_skills", {
      stableId: "trans-1",
      name: "Holyland",
      config: {
        passiveEffects: [],
        acquisitionNotes: "A realm to house the souls of the blessed.",
      },
    })
    expect(item.kind).toBe("transcendent_skills")
    expect(item.config.passiveEffects).toEqual([])
  })

  it("reads a legacy transcendent config without passiveEffects and allows a metadata-only PATCH", async () => {
    dbMock.store.addCatalog({
      id: "trans-legacy",
      kind: "transcendent_skills",
      stableId: "trans-legacy",
      name: "Legacy",
      config: { costDescription: "Heavy cost" },
    })
    const item = await getCatalogItem("transcendent_skills", "trans-legacy")
    expect(item.config).toMatchObject({ costDescription: "Heavy cost" })
    // A metadata-only PATCH (no config) keeps the legacy config readable.
    const patched = await updateCatalogItem(
      "transcendent_skills",
      "trans-legacy",
      {
        name: "Legacy Renamed",
      }
    )
    expect(patched.name).toBe("Legacy Renamed")
    expect(patched.config).toMatchObject({ costDescription: "Heavy cost" })
    // A config-changing PATCH without passiveEffects is rejected.
    await expect(
      updateCatalogItem("transcendent_skills", "trans-legacy", {
        config: { costDescription: "New" },
      })
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
  })

  it("rejects an association on a character the user does not own (403 via the owner guard)", async () => {
    seedCharacter()
    seedTranscendent("trans-1", { passiveEffects: [] })
    const other = { id: "user-2", email: "other@example.com", isAdmin: false }
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "transcendent",
          definitionId: "trans-1",
          operation: "add",
          version: 0,
        },
        other
      )
    ).rejects.toMatchObject({ status: 403 })
    expect(dbMock.store.associations).toHaveLength(0)
  })

  it("rejects a stale version (409) and rolls back the transcendent link and event", async () => {
    seedCharacter()
    seedTranscendent("trans-1", { passiveEffects: [] })
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "transcendent",
          definitionId: "trans-1",
          operation: "add",
          version: 99,
        },
        user
      )
    ).rejects.toMatchObject({ status: 409, code: "version_conflict" })
    expect(dbMock.store.associations).toHaveLength(0)
    expect(dbMock.store.events).toHaveLength(0)
  })

  it("lets two distinct transcendent skills coexist (no blessing singleton or upgradeGroup replacement)", async () => {
    seedCharacter()
    seedTranscendent("trans-a", {
      passiveEffects: [{ phase: "flat", amount: { strength: 3 } }],
    })
    seedTranscendent("trans-b", {
      passiveEffects: [{ phase: "flat", amount: { agility: 2 } }],
    })
    await associateCharacter(
      "chr-1",
      {
        kind: "transcendent",
        definitionId: "trans-a",
        operation: "add",
        version: 0,
      },
      user
    )
    const after1 = await associateCharacter(
      "chr-1",
      {
        kind: "transcendent",
        definitionId: "trans-b",
        operation: "add",
        version: 1,
      },
      user
    )
    expect(after1.character.associations).toHaveLength(2)
    expect(
      after1.character.associations.map((a) => a.definitionId).sort()
    ).toEqual(["trans-a", "trans-b"])
    expect(after1.character.isTranscendent).toBe(true)
    // Both distinct skills apply independently.
    expect(flatDelta(after1.character.status, "strength")).toBe(3)
    expect(flatDelta(after1.character.status, "agility")).toBe(2)
  })

  it("rejects adding a transcendent skill once the configured cap is reached", async () => {
    seedCharacter()
    for (const id of ["trans-a", "trans-b", "trans-c", "trans-d"]) {
      seedTranscendent(id, { passiveEffects: [] })
    }
    await associateCharacter(
      "chr-1",
      {
        kind: "transcendent",
        definitionId: "trans-a",
        operation: "add",
        version: 0,
      },
      user
    )
    await associateCharacter(
      "chr-1",
      {
        kind: "transcendent",
        definitionId: "trans-b",
        operation: "add",
        version: 1,
      },
      user
    )
    await associateCharacter(
      "chr-1",
      {
        kind: "transcendent",
        definitionId: "trans-c",
        operation: "add",
        version: 2,
      },
      user
    )
    // The cap (default 3) is reached; a fourth add is rejected before any write.
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "transcendent",
          definitionId: "trans-d",
          operation: "add",
          version: 3,
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "link_limit" })
    expect(dbMock.store.associations.map((a) => a.definitionId).sort()).toEqual(
      ["trans-a", "trans-b", "trans-c"]
    )
    expect(dbMock.store.characters.get("chr-1")!.version).toBe(3)
  })

  it("removes an archived linked transcendent (only add is blocked)", async () => {
    seedCharacter()
    seedTranscendent("trans-1", {
      passiveEffects: [{ phase: "flat", amount: { strength: 5 } }],
    })
    await associateCharacter(
      "chr-1",
      {
        kind: "transcendent",
        definitionId: "trans-1",
        operation: "add",
        version: 0,
      },
      user
    )
    // Archive the linked definition.
    dbMock.store.addCatalog({
      id: "trans-1",
      kind: "transcendent_skills",
      stableId: "trans-1",
      name: "Transcendent trans-1",
      config: { passiveEffects: [{ phase: "flat", amount: { strength: 5 } }] },
      archived: true,
    })
    // Adding an archived entry is blocked.
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "transcendent",
          definitionId: "trans-1",
          operation: "add",
          version: 1,
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "catalog_archived" })
    // Removing an archived linked entry is allowed.
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "transcendent",
        definitionId: "trans-1",
        operation: "remove",
        version: 1,
      },
      user
    )
    expect(res.character.associations).toHaveLength(0)
  })

  it("derives isTranscendent only from an unarchived link: archive clears, unarchive restores, unlink clears", async () => {
    seedCharacter()
    seedTranscendent("trans-1", { passiveEffects: [] })
    const added = await associateCharacter(
      "chr-1",
      {
        kind: "transcendent",
        definitionId: "trans-1",
        operation: "add",
        version: 0,
      },
      user
    )
    expect(added.character.isTranscendent).toBe(true)
    // Archive the linked definition -> derived flag false.
    dbMock.store.addCatalog({
      id: "trans-1",
      kind: "transcendent_skills",
      stableId: "trans-1",
      name: "Transcendent trans-1",
      config: { passiveEffects: [] },
      archived: true,
    })
    const archivedDetail = await getCharacter("chr-1", user)
    expect(archivedDetail.isTranscendent).toBe(false)
    // Unarchive restores true.
    dbMock.store.addCatalog({
      id: "trans-1",
      kind: "transcendent_skills",
      stableId: "trans-1",
      name: "Transcendent trans-1",
      config: { passiveEffects: [] },
      archived: false,
    })
    const restoredDetail = await getCharacter("chr-1", user)
    expect(restoredDetail.isTranscendent).toBe(true)
    // Unlink the last active definition clears it.
    const removed = await associateCharacter(
      "chr-1",
      {
        kind: "transcendent",
        definitionId: "trans-1",
        operation: "remove",
        version: 1,
      },
      user
    )
    expect(removed.character.isTranscendent).toBe(false)
  })

  it("synthesizes passive effects live from the current config (source/provenance/distinct ids) and never rewrites stored state; an archived link is inert", async () => {
    seedCharacter({ strength: 100 })
    seedTranscendent("trans-1", {
      passiveEffects: [{ phase: "flat", amount: { strength: 5 } }],
    })
    await associateCharacter(
      "chr-1",
      {
        kind: "transcendent",
        definitionId: "trans-1",
        operation: "add",
        version: 0,
      },
      user
    )
    const before = await getCharacter("chr-1", user)
    expect(flatDelta(before.status, "strength")).toBe(5)
    const beforeVersion = before.version
    const beforeState = before.state

    // Edit the effect magnitude in the catalog.
    await updateCatalogItem("transcendent_skills", "trans-1", {
      config: { passiveEffects: [{ phase: "flat", amount: { strength: 10 } }] },
    })
    const after = await getCharacter("chr-1", user)
    expect(flatDelta(after.status, "strength")).toBe(10)
    // No character mutation: version and stored state are untouched; no event.
    expect(after.version).toBe(beforeVersion)
    expect(after.state).toEqual(beforeState)
    expect(
      (after.state as { activeEffects: unknown[] }).activeEffects
    ).toHaveLength(0)
    expect(dbMock.store.events).toHaveLength(1)

    // The live effect carries the definition source + provenance + a distinct id.
    const portable = await exportCharacter("chr-1", user)
    const active = (
      portable.liveState as {
        activeEffects: Array<{ source: string; provenance: string; id: string }>
      }
    ).activeEffects
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({
      source: "Transcendent trans-1",
      provenance: "catalog",
      phase: "flat",
      amount: { strength: 10 },
    })
    expect(active[0].id).toBe("trans-1:eff-0")

    // Archive the linked definition -> inert (no synthesized effect, updated status).
    dbMock.store.addCatalog({
      id: "trans-1",
      kind: "transcendent_skills",
      stableId: "trans-1",
      name: "Transcendent trans-1",
      config: { passiveEffects: [{ phase: "flat", amount: { strength: 10 } }] },
      archived: true,
    })
    const archivedDetail = await getCharacter("chr-1", user)
    // When the linked definition is archived it contributes no effect; the "flat"
    // phase is still present in the trace but its delta must be 0.
    expect(flatDelta(archivedDetail.status, "strength")).toBe(0)
    expect(archivedDetail.isTranscendent).toBe(false)
  })

  it("exports multiple distinct transcendent links with stable ids and leaves historical state untouched", async () => {
    seedCharacter()
    seedTranscendent(
      "trans-a",
      { passiveEffects: [{ phase: "flat", amount: { strength: 3 } }] },
      { name: "Holyland" }
    )
    seedTranscendent(
      "trans-b",
      {
        passiveEffects: [
          { phase: "percent", basisPoints: { perception: 500 } },
        ],
      },
      { name: "Fighting Spirit" }
    )
    await associateCharacter(
      "chr-1",
      {
        kind: "transcendent",
        definitionId: "trans-a",
        operation: "add",
        version: 0,
      },
      user
    )
    await associateCharacter(
      "chr-1",
      {
        kind: "transcendent",
        definitionId: "trans-b",
        operation: "add",
        version: 1,
      },
      user
    )
    const portable = await exportCharacter("chr-1", user)
    expect(portable.isTranscendent).toBe(true)
    const assocs = portable.associations as Array<{
      kind: string
      definition: { stableId: string }
    }>
    expect(assocs).toHaveLength(2)
    expect(assocs.every((a) => a.kind === "transcendent")).toBe(true)
    expect(assocs.map((a) => a.definition.stableId).sort()).toEqual([
      "trans-a",
      "trans-b",
    ])
    // The stored `state` (historical awards) stays untouched.
    expect(
      (portable.state as { activeEffects: unknown[] }).activeEffects
    ).toEqual([])
  })
})

describe("updateCatalogItem link-collision rejection", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })
  function seedState() {
    const state = createInitialState("integrated", null, null)
    state.baseAttributes = {
      strength: 0,
      agility: 0,
      endurance: 0,
      vitality: 0,
      toughness: 0,
      wisdom: 0,
      intelligence: 0,
      perception: 0,
      willpower: 0,
    }
    return dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      state: serializeState(state),
      version: 0,
    })
  }

  function seedEquipment(id: string, config: Record<string, unknown>): unknown {
    return dbMock.store.addCatalog({
      id,
      kind: "equipment",
      stableId: id,
      name: `Gear ${id}`,
      config,
    })
  }

  function seedTitle(id: string, config: Record<string, unknown>): unknown {
    return dbMock.store.addCatalog({
      id,
      kind: "titles",
      stableId: id,
      name: `Title ${id}`,
      config,
    })
  }

  function seedSkill(id: string, config: Record<string, unknown>): unknown {
    return dbMock.store.addCatalog({
      id,
      kind: "skills",
      stableId: id,
      name: `Skill ${id}`,
      config,
    })
  }

  function seedBlessing(
    id: string,
    config: Record<string, unknown>,
    extra: Partial<{ name: string; archived: boolean }> = {}
  ): unknown {
    // A blessing link points at a `gods` definition; normalize the legacy
    // `{tier, effects}` blessing config into a god `blessingEffects` entry.
    const normalized =
      config.blessingEffects != null
        ? { ...config }
        : {
            blessingEffects: {
              [(config.tier as string | undefined) ?? "Minor"]:
                config.effects ?? [],
            },
          }
    return dbMock.store.addCatalog({
      id,
      kind: "gods",
      stableId: id,
      name: extra.name ?? `Blessing ${id}`,
      config: normalized,
      ...(extra.archived != null ? { archived: extra.archived } : {}),
    })
  }

  function seedBloodline(
    id: string,
    config: Record<string, unknown>,
    extra: Partial<{ name: string; archived: boolean }> = {}
  ): unknown {
    return dbMock.store.addCatalog({
      id,
      kind: "bloodlines",
      stableId: id,
      name: extra.name ?? `Bloodline ${id}`,
      config,
      ...(extra.archived != null ? { archived: extra.archived } : {}),
    })
  }

  it("rejects an equipment config edit that would collide a slot on a linked character (409)", async () => {
    seedState()
    seedEquipment("gear-1", { slot: "head", bonus: { strength: 10 } })
    seedEquipment("gear-2", { slot: "body", bonus: { strength: 20 } })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "gear-1",
      kind: "EQUIPMENT",
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "gear-2",
      kind: "EQUIPMENT",
    })
    await expect(
      updateCatalogItem("equipment", "gear-2", {
        config: { slot: "head", bonus: { strength: 20 }, rarity: "Common" },
      })
    ).rejects.toMatchObject({ status: 409, code: "link_collision" })
    // The update never applied - gear-2 still sits in the body slot.
    expect(
      (dbMock.store.catalog.get("gear-2")!.config as { slot: string }).slot
    ).toBe("body")
  })

  it("allows an equipment config edit that does not collide", async () => {
    seedState()
    seedEquipment("gear-1", { slot: "head", bonus: { strength: 10 } })
    seedEquipment("gear-2", { slot: "body", bonus: { strength: 20 } })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "gear-1",
      kind: "EQUIPMENT",
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "gear-2",
      kind: "EQUIPMENT",
    })
    const item = await updateCatalogItem("equipment", "gear-2", {
      config: { slot: "feet", bonus: { strength: 20 }, rarity: "Common" },
    })
    expect((item.config as { slot: string }).slot).toBe("feet")
  })

  it("rejects a title upgrade-group edit that would collide on a linked character (409)", async () => {
    seedState()
    seedTitle("title-1", { flat: { strength: 5 }, upgradeGroup: "hero" })
    seedTitle("title-2", { flat: { strength: 9 }, upgradeGroup: "villain" })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "title-1",
      kind: "TITLE",
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "title-2",
      kind: "TITLE",
    })
    await expect(
      updateCatalogItem("titles", "title-2", {
        config: { flat: { strength: 9 }, upgradeGroup: "hero" },
      })
    ).rejects.toMatchObject({ status: 409, code: "link_collision" })
    expect(
      (
        dbMock.store.catalog.get("title-2")!.config as {
          upgradeGroup: string
        }
      ).upgradeGroup
    ).toBe("villain")
  })

  it("maps a serialization failure (P2034) on a linked-title catalog update to a 409, never a 500", async () => {
    seedState()
    seedTitle("title-1", {
      flat: { strength: 5 },
      upgradeGroup: "hero",
      improvement: { seriesId: "hero", rank: 1, minRaceGrade: "F" },
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "title-1",
      kind: "TITLE",
    })
    // A concurrent `associateCharacter` claims rank on this linked title (or
    // another catalog edit races the row) while this title update reads the linked
    // associations. The SERIALIZABLE transaction detects the conflict and aborts
    // with P2034, which the service must surface as a 409 rather than a raw 500,
    // and must not apply the config change.
    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce({
      name: "PrismaClientKnownRequestError",
      code: "P2034",
    })
    try {
      await expect(
        updateCatalogItem("titles", "title-1", {
          config: {
            flat: { strength: 6 },
            upgradeGroup: "hero",
            improvement: { seriesId: "hero", rank: 1, minRaceGrade: "F" },
          },
        })
      ).rejects.toMatchObject({
        status: 409,
        code: "catalog_serialization_conflict",
      })
    } finally {
      spy.mockRestore()
    }
    // The rejected update left the catalog row untouched (flat still 5).
    expect(
      (
        dbMock.store.catalog.get("title-1")!.config as {
          flat: { strength: number }
        }
      ).flat.strength
    ).toBe(5)
  })

  it("does not reject a config edit on an archived definition (it is inert)", async () => {
    seedState()
    seedEquipment("gear-1", { slot: "head", bonus: { strength: 10 } })
    seedEquipment("gear-2", { slot: "body", bonus: { strength: 20 } })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "gear-1",
      kind: "EQUIPMENT",
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "gear-2",
      kind: "EQUIPMENT",
    })
    // gear-2 becomes archived: editing its slot to head is now allowed because
    // the archived definition synthesizes no effect.
    const item = await updateCatalogItem("equipment", "gear-2", {
      archived: true,
      config: { slot: "head", bonus: { strength: 20 }, rarity: "Common" },
    })
    expect(item.archived).toBe(true)
    expect((item.config as { slot: string }).slot).toBe("head")
  })

  it("rejects a skill upgrade-group config edit that would collide on a linked character (409)", async () => {
    seedState()
    seedSkill("sk-1", {
      effects: [{ phase: "flat", amount: { strength: 5 } }],
    })
    seedSkill("sk-2", {
      upgradeGroup: "tier",
      effects: [{ phase: "flat", amount: { strength: 9 } }],
    })
    // A character already linked to both skills.
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "sk-1",
      kind: "SKILL",
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "sk-2",
      kind: "SKILL",
    })
    await expect(
      updateCatalogItem("skills", "sk-1", {
        config: {
          upgradeGroup: "tier",
          rarity: "Common",
          effects: [{ phase: "flat", amount: { strength: 5 } }],
        },
      })
    ).rejects.toMatchObject({ status: 409, code: "link_collision" })
    // The update never applied - sk-1 still has no upgradeGroup.
    expect(
      (
        dbMock.store.catalog.get("sk-1")!.config as {
          upgradeGroup?: string
        }
      ).upgradeGroup
    ).toBeUndefined()
  })

  it("rejects a linked skill config edit that changes its rarity or upgrade group (409 skill_rarity_conflict)", async () => {
    seedState()
    seedSkill("sk-1", {
      effects: [{ phase: "flat", amount: { strength: 5 } }],
    })
    seedSkill("sk-2", {
      upgradeGroup: "tier",
      effects: [{ phase: "flat", amount: { strength: 9 } }],
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "sk-1",
      kind: "SKILL",
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "sk-2",
      kind: "SKILL",
    })
    // Editing linked sk-1 to add a rarity AND a distinct upgrade group does not
    // collide, but it changes a linked skill's rarity/group, so the stability
    // guard rejects it (409) and nothing is written.
    await expect(
      updateCatalogItem("skills", "sk-1", {
        config: {
          upgradeGroup: "other-tier",
          rarity: "Common",
          effects: [{ phase: "flat", amount: { strength: 5 } }],
        },
      })
    ).rejects.toMatchObject({ status: 409, code: "skill_rarity_conflict" })
    // The update never applied - sk-1 still has no rarity / upgradeGroup.
    expect(
      (
        dbMock.store.catalog.get("sk-1")!.config as {
          upgradeGroup?: string
          rarity?: string
        }
      ).upgradeGroup
    ).toBeUndefined()
    expect(
      (
        dbMock.store.catalog.get("sk-1")!.config as {
          upgradeGroup?: string
          rarity?: string
        }
      ).rarity
    ).toBeUndefined()
  })

  it("unarchiving a god linked as a blessing succeeds even with another blessing link (gods are collision-exempt)", async () => {
    seedState()
    seedBlessing("bless-1", {
      tier: "Minor",
      effects: [{ phase: "flat", amount: { strength: 5 } }],
    })
    // bless-2 is currently archived; unarchiving it is a gods config edit, and the
    // service no longer applies slot/upgrade-group collision checks to gods.
    seedBlessing(
      "bless-2",
      { tier: "Lesser", effects: [{ phase: "flat", amount: { strength: 3 } }] },
      { archived: true }
    )
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "bless-1",
      kind: "BLESSING",
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "bless-2",
      kind: "BLESSING",
    })
    const item = await updateCatalogItem("gods", "bless-2", {
      archived: false,
    })
    // The unarchive applied - bless-2 is now active.
    expect(item.archived).toBe(false)
    expect(dbMock.store.catalog.get("bless-2")!.archived).toBe(false)
  })

  it("applies a config edit to a god linked as a blessing without a collision (409)", async () => {
    seedState()
    seedBlessing("bless-1", {
      tier: "Minor",
      effects: [{ phase: "flat", amount: { strength: 5 } }],
    })
    // A second blessing link exists but is archived.
    seedBlessing(
      "bless-2",
      { tier: "Lesser", effects: [{ phase: "flat", amount: { strength: 3 } }] },
      { archived: true }
    )
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "bless-1",
      kind: "BLESSING",
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "bless-2",
      kind: "BLESSING",
    })
    // Editing the god's blessingEffects config while unarchiving it does not collide.
    const item = await updateCatalogItem("gods", "bless-2", {
      archived: false,
      config: {
        blessingEffects: {
          Greater: [{ phase: "flat", amount: { strength: 9 } }],
        },
      },
    })
    expect(item.archived).toBe(false)
    expect(item.config).toMatchObject({
      blessingEffects: {
        Greater: [{ phase: "flat", amount: { strength: 9 } }],
      },
    })
  })

  it("allows unarchiving a god when the character has no other active blessing", async () => {
    seedState()
    seedBlessing(
      "bless-1",
      { tier: "Lesser", effects: [{ phase: "flat", amount: { strength: 3 } }] },
      { archived: true }
    )
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "bless-1",
      kind: "BLESSING",
    })
    const item = await updateCatalogItem("gods", "bless-1", {
      archived: false,
    })
    expect(item.archived).toBe(false)
  })

  it("rejects a bloodline upgrade-group config edit that would collide on a linked character (409)", async () => {
    seedState()
    seedBloodline("blood-1", { effects: [], upgradeGroup: "alpha" })
    seedBloodline("blood-2", { effects: [], upgradeGroup: "beta" })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "blood-1",
      kind: "BLOODLINE",
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "blood-2",
      kind: "BLOODLINE",
    })
    await expect(
      updateCatalogItem("bloodlines", "blood-2", {
        config: { effects: [], upgradeGroup: "alpha" },
      })
    ).rejects.toMatchObject({ status: 409, code: "link_collision" })
    // The update never applied - blood-2 still has its own group.
    expect(
      (
        dbMock.store.catalog.get("blood-2")!.config as {
          upgradeGroup: string
        }
      ).upgradeGroup
    ).toBe("beta")
  })

  it("allows a bloodline upgrade-group config edit that does not collide", async () => {
    seedState()
    seedBloodline("blood-1", { effects: [], upgradeGroup: "alpha" })
    seedBloodline("blood-2", { effects: [], upgradeGroup: "beta" })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "blood-1",
      kind: "BLOODLINE",
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "blood-2",
      kind: "BLOODLINE",
    })
    // Editing blood-2 to a distinct group does not collide.
    const item = await updateCatalogItem("bloodlines", "blood-2", {
      config: { effects: [], upgradeGroup: "gamma" },
    })
    expect((item.config as { upgradeGroup: string }).upgradeGroup).toBe("gamma")
  })

  it("rejects changing the improvement identity of a linked ranked title (409 title_improvement_conflict)", async () => {
    seedState()
    seedTitle("title-1", {
      upgradeGroup: "dungeon-pioneer",
      improvement: { seriesId: "dungeon-pioneer", rank: 1, minRaceGrade: "E" },
      flat: allEqual(3),
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "title-1",
      kind: "TITLE",
    })
    // Bumping the rank changes the improvement identity on a linked title.
    await expect(
      updateCatalogItem("titles", "title-1", {
        config: {
          upgradeGroup: "dungeon-pioneer",
          improvement: {
            seriesId: "dungeon-pioneer",
            rank: 2,
            minRaceGrade: "E",
          },
          flat: allEqual(6),
        },
      })
    ).rejects.toMatchObject({ status: 409, code: "title_improvement_conflict" })
    // The update never applied - title-1 is still rank 1.
    expect(
      (
        dbMock.store.catalog.get("title-1")!.config as {
          improvement: { rank: number }
        }
      ).improvement.rank
    ).toBe(1)
  })

  it("rejects removing the improvement identity of a linked ranked title (409 title_improvement_conflict)", async () => {
    seedState()
    seedTitle("title-1", {
      upgradeGroup: "dungeon-pioneer",
      improvement: { seriesId: "dungeon-pioneer", rank: 1, minRaceGrade: "E" },
      flat: allEqual(3),
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "title-1",
      kind: "TITLE",
    })
    // Dropping the improvement on a linked title is a removal of the identity.
    await expect(
      updateCatalogItem("titles", "title-1", {
        config: {
          upgradeGroup: "dungeon-pioneer",
          flat: allEqual(3),
        },
      })
    ).rejects.toMatchObject({ status: 409, code: "title_improvement_conflict" })
    // title-1 still carries the improvement.
    expect(
      (
        dbMock.store.catalog.get("title-1")!.config as {
          improvement?: { rank: number }
        }
      ).improvement?.rank
    ).toBe(1)
  })

  it("allows an owner to edit the metadata/bonus of a ranked title they currently hold (identity stable)", async () => {
    seedState()
    seedTitle("title-1", {
      upgradeGroup: "dungeon-pioneer",
      improvement: { seriesId: "dungeon-pioneer", rank: 1, minRaceGrade: "E" },
      flat: allEqual(3),
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "title-1",
      kind: "TITLE",
    })
    // A name/bonus edit keeps the improvement identity intact, so it is allowed.
    const item = await updateCatalogItem("titles", "title-1", {
      name: "Dungeon Pioneer Renamed",
      config: {
        upgradeGroup: "dungeon-pioneer",
        improvement: {
          seriesId: "dungeon-pioneer",
          rank: 1,
          minRaceGrade: "E",
        },
        flat: allEqual(9),
      },
    })
    expect(item.name).toBe("Dungeon Pioneer Renamed")
    const cfg = item.config as {
      improvement: { rank: number }
      flat: { strength: number }
    }
    expect(cfg.improvement.rank).toBe(1)
    expect(cfg.flat.strength).toBe(9)
  })

  it("allows changing the improvement identity of an unlinked ranked title (no links)", async () => {
    seedState()
    seedTitle("title-1", {
      upgradeGroup: "dungeon-pioneer",
      improvement: { seriesId: "dungeon-pioneer", rank: 1, minRaceGrade: "E" },
      flat: allEqual(3),
    })
    // The title is not assigned to any character, so the identity can change.
    const item = await updateCatalogItem("titles", "title-1", {
      config: {
        upgradeGroup: "dungeon-pioneer",
        improvement: {
          seriesId: "dungeon-pioneer",
          rank: 2,
          minRaceGrade: "E",
        },
        flat: allEqual(6),
      },
    })
    const cfg = item.config as { improvement: { rank: number } }
    expect(cfg.improvement.rank).toBe(2)
  })

  it("rejects adding an improvement to a linked unranked title (409 title_improvement_conflict)", async () => {
    seedState()
    seedTitle("title-1", {
      flat: { strength: 5 },
      upgradeGroup: "dungeon-pioneer",
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "title-1",
      kind: "TITLE",
    })
    // Adding an improvement to a title that had none is an identity ADD on a
    // linked title; the link is the authority, so it is rejected (no write).
    await expect(
      updateCatalogItem("titles", "title-1", {
        config: {
          upgradeGroup: "dungeon-pioneer",
          improvement: {
            seriesId: "dungeon-pioneer",
            rank: 1,
            minRaceGrade: "E",
          },
          flat: allEqual(3),
        },
      })
    ).rejects.toMatchObject({ status: 409, code: "title_improvement_conflict" })
    // The promotion never applied - title-1 still carries no improvement.
    expect(
      (
        dbMock.store.catalog.get("title-1")!.config as {
          improvement?: { rank: number }
        }
      ).improvement
    ).toBeUndefined()
  })

  it("allows promoting an unlinked unranked title to ranked (the prior identity was absent)", async () => {
    seedState()
    seedTitle("title-1", {
      flat: { strength: 5 },
      upgradeGroup: "dungeon-pioneer",
    })
    // No character references this title, so promoting it to ranked is allowed.
    const item = await updateCatalogItem("titles", "title-1", {
      config: {
        upgradeGroup: "dungeon-pioneer",
        improvement: {
          seriesId: "dungeon-pioneer",
          rank: 1,
          minRaceGrade: "E",
        },
        flat: allEqual(3),
      },
    })
    const cfg = item.config as { improvement: { rank: number } }
    expect(cfg.improvement.rank).toBe(1)
  })
})

describe("updateCatalogItem race type in use", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function seedRace(id: string, config: Record<string, unknown>): unknown {
    return dbMock.store.addCatalog({
      id,
      kind: "races",
      stableId: id,
      name: `Race ${id}`,
      config,
    })
  }

  function seedCharacterReferencing(raceId: string): void {
    const state = createInitialState("integrated", null, null)
    dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      raceId,
      state: serializeState(state),
      version: 0,
    })
  }

  const monsterConfig = {
    raceType: "monster",
    naturalGrade: "F",
    raceDefinitions: {
      F: { id: "wyrm:F", perLevel: { strength: 2 }, freePerLevel: 1 },
    },
  }

  it("rejects changing raceType while characters reference the race (409 race_type_in_use)", async () => {
    seedRace("race-m", monsterConfig)
    seedCharacterReferencing("race-m")
    await expect(
      updateCatalogItem("races", "race-m", {
        config: { raceType: "enlightened", naturalGrade: "F" },
      })
    ).rejects.toMatchObject({ status: 409, code: "race_type_in_use" })
    // No conversion: the race stays a monster.
    expect(
      (dbMock.store.catalog.get("race-m")!.config as { raceType: string })
        .raceType
    ).toBe("monster")
  })

  it("allows changing raceType when no character references the race", async () => {
    seedRace("race-m", monsterConfig)
    const item = await updateCatalogItem("races", "race-m", {
      config: { raceType: "enlightened", naturalGrade: "F" },
    })
    expect((item.config as { raceType: string }).raceType).toBe("enlightened")
  })

  it("allows a same-type config edit on a referenced race", async () => {
    seedRace("race-m", monsterConfig)
    seedCharacterReferencing("race-m")
    const item = await updateCatalogItem("races", "race-m", {
      config: { raceType: "monster", naturalGrade: "B" },
    })
    expect((item.config as { raceType: string }).raceType).toBe("monster")
    expect((item.config as { naturalGrade: string }).naturalGrade).toBe("B")
  })

  it("allows an archival toggle on a referenced race (type unchanged)", async () => {
    seedRace("race-m", monsterConfig)
    seedCharacterReferencing("race-m")
    const item = await updateCatalogItem("races", "race-m", { archived: true })
    expect(item.archived).toBe(true)
    expect(item.config).toMatchObject({ raceType: "monster" })
  })

  it("rejects a default-raceType change on a legacy race referenced by characters (409 race_type_in_use)", async () => {
    // A legacy race config (no raceType) reads as "enlightened". Changing it to a
    // monster type while characters reference it must reject before any write.
    seedRace("race-legacy", {
      naturalGrade: "F",
      raceDefinitions: {
        F: { id: "wyrm:F", perLevel: { strength: 2 }, freePerLevel: 1 },
      },
    })
    seedCharacterReferencing("race-legacy")
    await expect(
      updateCatalogItem("races", "race-legacy", {
        config: { raceType: "monster", naturalGrade: "F" },
      })
    ).rejects.toMatchObject({ status: 409, code: "race_type_in_use" })
    expect(
      (
        dbMock.store.catalog.get("race-legacy")!.config as {
          raceType?: string
        }
      ).raceType
    ).toBeUndefined()
  })
})

describe("exportCharacter (associations / live state)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function seedCharacterWithBase() {
    const state = createInitialState("integrated", null, null)
    state.baseAttributes = {
      strength: 5,
      agility: 0,
      endurance: 0,
      vitality: 0,
      toughness: 0,
      wisdom: 0,
      intelligence: 0,
      perception: 0,
      willpower: 0,
    }
    return dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      state: serializeState(state),
      version: 0,
    })
  }

  function seedTitle(
    id: string,
    config: Record<string, unknown>,
    extra: Partial<{ name: string; archived: boolean }> = {}
  ): unknown {
    return dbMock.store.addCatalog({
      id,
      kind: "titles",
      stableId: id,
      name: extra.name ?? `Title ${id}`,
      config,
      ...(extra.archived != null ? { archived: extra.archived } : {}),
    })
  }

  function seedEquipment(
    id: string,
    config: Record<string, unknown>,
    extra: Partial<{ name: string; archived: boolean }> = {}
  ): unknown {
    return dbMock.store.addCatalog({
      id,
      kind: "equipment",
      stableId: id,
      name: extra.name ?? `Gear ${id}`,
      config,
      ...(extra.archived != null ? { archived: extra.archived } : {}),
    })
  }

  function seedStock(definitionId: string, quantity = 10) {
    return dbMock.store.addInventoryItem({
      characterId: "chr-1",
      definitionId,
      quantity,
    })
  }

  function seedSkill(
    id: string,
    config: Record<string, unknown>,
    extra: Partial<{ name: string; archived: boolean }> = {}
  ): unknown {
    return dbMock.store.addCatalog({
      id,
      kind: "skills",
      stableId: id,
      name: extra.name ?? `Skill ${id}`,
      config,
      ...(extra.archived != null ? { archived: extra.archived } : {}),
    })
  }

  it("exports associations with a definition snapshot and the synthesized liveState", async () => {
    seedCharacterWithBase()
    seedTitle("title-1", { flat: { strength: 5 }, upgradeGroup: "hero" })
    seedEquipment("gear-1", { slot: "head", bonus: { strength: 10 } })
    seedStock("gear-1")
    await associateCharacter(
      "chr-1",
      { kind: "title", definitionId: "title-1", operation: "add", version: 0 },
      user
    )
    await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "gear-1",
        operation: "add",
        version: 1,
      },
      user
    )
    const portable = await exportCharacter("chr-1", user)
    expect(portable.schema).toBe("primal-character/7")
    expect(portable.rulesetVersion).toBe(IMPORT_RULESET_VERSION)
    expect(portable.identity).toMatchObject({
      name: "Test",
      origin: "integrated",
      race: { stableId: null },
      class: { stableId: null },
      profession: null,
    })
    // Base state is untouched; the live state adds the synthesized pieces.
    expect((portable.state as { equipment: unknown[] }).equipment).toEqual([])
    expect(
      (portable.liveState as { equipment: unknown[] }).equipment
    ).toHaveLength(1)
    expect(
      (portable.liveState as { activeEffects: unknown[] }).activeEffects.length
    ).toBeGreaterThan(0)
    expect(portable.status).toBeDefined()

    const assoc = portable.associations as Array<{
      kind: "title" | "equipment"
      definition: {
        id: string
        name: string
        kind: string
        config: Record<string, unknown>
        archived: boolean
        stableId: string
        updatedAt: string
      }
    }>
    expect(assoc).toHaveLength(2)
    const titleAssoc = assoc.find((a) => a.kind === "title")!
    expect(titleAssoc.definition).toMatchObject({
      id: "title-1",
      name: "Title title-1",
      kind: "titles",
      archived: false,
      stableId: "title-1",
    })
    expect(titleAssoc.definition.config.flat).toEqual({ strength: 5 })
    expect(typeof titleAssoc.definition.updatedAt).toBe("string")
    const eqAssoc = assoc.find((a) => a.kind === "equipment")!
    expect(eqAssoc.definition.config.slot).toBe("head")
  })

  it("keeps an archived linked association but drops it from the live state", async () => {
    seedCharacterWithBase()
    seedTitle("title-1", { flat: { strength: 5 } })
    await associateCharacter(
      "chr-1",
      { kind: "title", definitionId: "title-1", operation: "add", version: 0 },
      user
    )
    // Archive the linked definition after attachment; then export.
    dbMock.store.addCatalog({
      id: "title-1",
      kind: "titles",
      stableId: "title-1",
      name: "Title title-1",
      config: { flat: { strength: 5 } },
      archived: true,
    })
    const portable = await exportCharacter("chr-1", user)
    const assoc = portable.associations as Array<{
      definition: { archived: boolean; id: string }
    }>
    expect(assoc).toHaveLength(1)
    expect(assoc[0].definition.archived).toBe(true)
    // The live state no longer synthesizes the archived title's effect.
    expect(
      (portable.liveState as { activeEffects: unknown[] }).activeEffects
    ).toHaveLength(0)
  })

  it("exports a granted skill as kind 'skill' with its liveState effect, alongside title/equipment", async () => {
    seedCharacterWithBase()
    seedTitle("title-1", { flat: { strength: 5 }, upgradeGroup: "hero" })
    seedEquipment("gear-1", { slot: "head", bonus: { strength: 10 } })
    seedStock("gear-1")
    seedSkill("skill-1", {
      effects: [{ phase: "flat", amount: { strength: 7 } }],
    })
    const admin = { ...user, isAdmin: true }
    await associateCharacter(
      "chr-1",
      { kind: "title", definitionId: "title-1", operation: "add", version: 0 },
      user
    )
    await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "gear-1",
        operation: "add",
        version: 1,
      },
      user
    )
    await skillCharacter(
      "chr-1",
      {
        operation: "grant",
        definitionId: "skill-1",
        version: 2,
        reason: "story",
      },
      admin
    )
    const portable = await exportCharacter("chr-1", user)
    const assoc = portable.associations as Array<{
      kind: "title" | "equipment" | "skill"
      definition: {
        id: string
        name: string
        kind: string
        config: Record<string, unknown>
        archived: boolean
        stableId: string
        updatedAt: string
      }
    }>
    expect(assoc).toHaveLength(3)
    const skillAssoc = assoc.find((a) => a.kind === "skill")!
    expect(skillAssoc.definition).toMatchObject({
      id: "skill-1",
      name: "Skill skill-1",
      kind: "skills",
      archived: false,
      stableId: "skill-1",
    })
    expect(skillAssoc.definition.config.effects).toEqual([
      { phase: "flat", amount: { strength: 7 } },
    ])
    // Titles and equipment are still labeled correctly; nothing leaks onto them.
    expect(assoc.find((a) => a.kind === "title")!.definition.id).toBe("title-1")
    expect(assoc.find((a) => a.kind === "equipment")!.definition.id).toBe(
      "gear-1"
    )
    // The live state must synthesize the granted skill's flat effect.
    const effects = (
      portable.liveState as {
        activeEffects: Array<{
          source: string
          amount: Record<string, number>
        }>
      }
    ).activeEffects
    expect(effects.find((e) => e.source === "Skill skill-1")).toMatchObject({
      id: "skill-1:eff-0",
      phase: "flat",
      amount: { strength: 7 },
    })
  })

  it("exports a selected skill offer as kind 'skill' with its liveState effect", async () => {
    seedCharacterWithBase()
    seedSkill("skill-1", {
      effects: [{ phase: "flat", amount: { agility: 4 } }],
    })
    // Seed a pending skill offer whose single option is the skill definition.
    dbMock.store.skillOffers.push({
      id: "offer-1",
      characterId: "chr-1",
      track: "class",
      level: 1,
      choiceGroup: "standard",
      generation: 0,
      canceledAt: null,
      selectedDefinitionId: null,
      offeredAt: new Date(),
      selectedAt: null,
    })
    dbMock.store.skillOfferOptions.push({
      id: "opt-1",
      offerId: "offer-1",
      definitionId: "skill-1",
      nameSnapshot: "Skill skill-1",
      configSnapshot: {},
    })
    const selected = await skillCharacter(
      "chr-1",
      {
        operation: "select",
        offerId: "offer-1",
        definitionId: "skill-1",
        version: 0,
      },
      user
    )
    expect(selected.character.associations[0].kind).toBe("skill")
    const portable = await exportCharacter("chr-1", user)
    const assoc = portable.associations as Array<{
      kind: "title" | "equipment" | "skill"
      definition: { id: string; kind: string; name: string }
    }>
    expect(assoc).toHaveLength(1)
    expect(assoc[0].kind).toBe("skill")
    expect(assoc[0].definition).toMatchObject({
      id: "skill-1",
      kind: "skills",
      name: "Skill skill-1",
    })
    const effects = (
      portable.liveState as {
        activeEffects: Array<{
          source: string
          amount: Record<string, number>
        }>
      }
    ).activeEffects
    expect(effects).toHaveLength(1)
    expect(effects[0]).toMatchObject({
      id: "skill-1:eff-0",
      phase: "flat",
      amount: { agility: 4 },
    })
  })
})

describe("race evolution (next-grade candidates)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function seedRace(
    id: string,
    stableId: string,
    name: string,
    config: Record<string, unknown>,
    extra: Partial<{ archived: boolean }> = {}
  ) {
    dbMock.store.addCatalog({
      id,
      kind: "races",
      stableId,
      name,
      config,
      ...extra,
    })
  }

  function seedClass(
    id: string,
    stableId: string,
    name: string,
    grades: Record<string, { fixed: Record<string, number>; free: number }>
  ) {
    dbMock.store.addCatalog({
      id,
      kind: "classes",
      stableId,
      name,
      config: { grades },
    })
  }

  function seedCharacter(overrides: Record<string, unknown> = {}) {
    const state = createInitialState("integrated", null, null)
    state.race = {
      level: 10,
      grade: "G",
      mode: "derived",
      origin: "integrated",
    }
    state.tracks.class = { level: 20, quarter: 0, definitionId: "" }
    return dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      raceId: "race-human",
      classId: "cls-1",
      state: serializeState(state),
      version: 0,
      ...(overrides as Record<string, unknown>),
    })
  }

  it("builds next-grade candidates from unarchived races sharing the raceType", async () => {
    seedRace("race-human", "human", "Human", {
      raceDefinitions: {
        G: { id: "human:G", perLevel: { strength: 1 }, freePerLevel: 1 },
      },
    })
    seedRace("race-elf", "elf", "Elf", {
      raceDefinitions: {
        F: { id: "elf:F", perLevel: { agility: 2 }, freePerLevel: 2 },
      },
    })
    seedRace("race-dwarf", "dwarf", "Dwarf", {
      raceDefinitions: {
        F: { id: "dwarf:F", perLevel: { strength: 2 }, freePerLevel: 2 },
      },
    })
    // A monster race advances in a different mode, so it must not be offered to an
    // enlightened race.
    seedRace("race-beast", "beast", "Beast", {
      raceType: "monster",
      naturalGrade: "F",
      raceDefinitions: {
        F: { id: "beast:F", perLevel: { strength: 3 }, freePerLevel: 2 },
      },
    })
    seedCharacter()

    const res = await getEvolutionOptions("chr-1", user)
    expect(res.legacyAvailable).toBe(false)
    expect(res.options.map((o) => o.id).sort()).toEqual([
      "race-dwarf",
      "race-elf",
    ])
    for (const option of res.options) {
      expect(option).toMatchObject({
        fromGrade: "G",
        toGrade: "F",
        track: "race",
        eligible: true,
        blockers: [],
      })
      expect(option.toTrackName).toBe(option.name)
    }
  })

  it("filters out archived, missing-next-grade and raceType-mismatched destinations", async () => {
    seedRace("race-human", "human", "Human", {
      raceDefinitions: {
        G: { id: "human:G", perLevel: { strength: 1 }, freePerLevel: 1 },
      },
    })
    seedRace("race-elf", "elf", "Elf", {
      raceDefinitions: {
        F: { id: "elf:F", perLevel: { agility: 2 }, freePerLevel: 2 },
      },
    })
    seedRace(
      "race-archived",
      "archived",
      "Archived",
      {
        raceDefinitions: {
          F: { id: "archived:F", perLevel: { strength: 1 }, freePerLevel: 1 },
        },
      },
      { archived: true }
    )
    seedRace("race-no-f", "no-f", "NoF", {
      raceDefinitions: {
        G: { id: "no-f:G", perLevel: { strength: 1 }, freePerLevel: 1 },
      },
    })
    seedRace("race-beast", "beast", "Beast", {
      raceType: "monster",
      raceDefinitions: {
        F: { id: "beast:F", perLevel: { strength: 3 }, freePerLevel: 2 },
      },
    })
    seedCharacter()

    const res = await getEvolutionOptions("chr-1", user)
    expect(res.legacyAvailable).toBe(false)
    expect(res.options.map((o) => o.id)).toEqual(["race-elf"])
  })

  it("surfaces a grade-band blocker on GET and rejects the same choice on POST", async () => {
    seedRace("race-human", "human", "Human", {
      raceDefinitions: {
        G: { id: "human:G", perLevel: { strength: 1 }, freePerLevel: 1 },
      },
    })
    seedRace("race-elf", "elf", "Elf", {
      raceDefinitions: {
        F: { id: "elf:F", perLevel: { agility: 2 }, freePerLevel: 2 },
      },
    })
    // Class level 0 => derived race level 0, below F's entry level (10).
    const state = createInitialState("integrated", null, null)
    state.race = { level: 0, grade: "G", mode: "derived", origin: "integrated" }
    state.tracks.class = { level: 0, quarter: 0, definitionId: "" }
    seedCharacter({ state: serializeState(state) })

    const res = await getEvolutionOptions("chr-1", user)
    expect(res.options).toHaveLength(1)
    expect(res.options[0].eligible).toBe(false)
    expect(res.options[0].blockers).toContain(
      "race level 0 does not qualify for F (needs 10-24)"
    )

    await expect(
      evolveCharacter(
        "chr-1",
        { track: "race", optionId: "race-elf", version: 0 },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "evolution" })
  })

  it("rejects a POST that would cross raceType with race_type_mismatch and no write", async () => {
    seedRace("race-human", "human", "Human", {
      raceDefinitions: {
        G: { id: "human:G", perLevel: { strength: 1 }, freePerLevel: 1 },
      },
    })
    seedRace("race-beast", "beast", "Beast", {
      raceType: "monster",
      raceDefinitions: {
        F: { id: "beast:F", perLevel: { strength: 3 }, freePerLevel: 2 },
      },
    })
    seedCharacter()

    await expect(
      evolveCharacter(
        "chr-1",
        { track: "race", optionId: "race-beast", version: 0 },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "race_type_mismatch" })

    expect(dbMock.store.events).toHaveLength(0)
    const fresh = dbMock.store.characters.get("chr-1")!
    expect(fresh.raceId).toBe("race-human")
    expect(fresh.version).toBe(0)
  })

  it("rejects an unknown destination with evolution_destination_missing and no write", async () => {
    seedRace("race-human", "human", "Human", {
      raceDefinitions: {
        G: { id: "human:G", perLevel: { strength: 1 }, freePerLevel: 1 },
      },
    })
    seedCharacter()

    await expect(
      evolveCharacter(
        "chr-1",
        { track: "race", optionId: "race-nope", version: 0 },
        user
      )
    ).rejects.toMatchObject({
      status: 404,
      code: "evolution_destination_missing",
    })
    expect(dbMock.store.events).toHaveLength(0)
  })

  it("rejects an archived destination with catalog_archived and no write", async () => {
    seedRace("race-human", "human", "Human", {
      raceDefinitions: {
        G: { id: "human:G", perLevel: { strength: 1 }, freePerLevel: 1 },
      },
    })
    seedRace(
      "race-archived",
      "archived",
      "Archived",
      {
        raceDefinitions: {
          F: { id: "archived:F", perLevel: { strength: 1 }, freePerLevel: 1 },
        },
      },
      { archived: true }
    )
    seedCharacter()

    await expect(
      evolveCharacter(
        "chr-1",
        { track: "race", optionId: "race-archived", version: 0 },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "catalog_archived" })
    expect(dbMock.store.events).toHaveLength(0)
  })

  it("rejects a destination that lacks the next grade's race definition", async () => {
    seedRace("race-human", "human", "Human", {
      raceDefinitions: {
        G: { id: "human:G", perLevel: { strength: 1 }, freePerLevel: 1 },
      },
    })
    seedRace("race-no-f", "no-f", "NoF", {
      raceDefinitions: {
        G: { id: "no-f:G", perLevel: { strength: 1 }, freePerLevel: 1 },
      },
    })
    seedCharacter()

    await expect(
      evolveCharacter(
        "chr-1",
        { track: "race", optionId: "race-no-f", version: 0 },
        user
      )
    ).rejects.toMatchObject({
      status: 400,
      code: "evolution_destination_definition_missing",
    })
    expect(dbMock.store.events).toHaveLength(0)
  })

  it("evolves a qualifying race to the next grade and preserves class/profession ledgers", async () => {
    seedRace("race-human", "human", "Human", {
      raceDefinitions: {
        G: { id: "human:G", perLevel: { strength: 1 }, freePerLevel: 1 },
      },
    })
    seedRace("race-elf", "elf", "Elf", {
      raceDefinitions: {
        F: { id: "elf:F", perLevel: { agility: 2 }, freePerLevel: 2 },
      },
    })
    const base = createInitialState("integrated", null, null)
    base.race = { level: 10, grade: "G", mode: "derived", origin: "integrated" }
    base.tracks.class = { level: 20, quarter: 0, definitionId: "" }
    base.historicalLevelAwards.push({
      track: "class",
      level: 1,
      definitionId: "archer:F",
      fixed: makeVector({ agility: 2 }),
      free: 1,
    })
    base.allocations.push({
      id: "alloc-0",
      source: "available-points",
      at: 0,
      points: makeVector({ agility: 1 }),
    })
    seedCharacter({ state: serializeState(base) })

    const res = await evolveCharacter(
      "chr-1",
      { track: "race", optionId: "race-elf", version: 0 },
      user
    )
    expect(res.character.version).toBe(1)
    expect(res.character.raceId).toBe("race-elf")
    expect(res.character.raceName).toBe("Elf")
    const state = deserializeState(res.character.state)
    expect(state.race.grade).toBe("F")
    expect(state.race.definitionId).toBe("elf:F")
    expect(state.tracks.class.level).toBe(20)
    expect(state.historicalLevelAwards).toHaveLength(1)
    expect(state.historicalLevelAwards[0]).toMatchObject({ track: "class" })
    expect(state.allocations).toHaveLength(1)
    expect(res.journal).toMatchObject({
      from: "G",
      to: "F",
      optionId: "race-elf",
      source: "catalog",
    })
  })

  it("uses the destination race definitions for future race awards", async () => {
    seedRace("race-human", "human", "Human", {
      raceDefinitions: {
        G: { id: "human:G", perLevel: { strength: 1 }, freePerLevel: 1 },
      },
    })
    seedRace("race-elf", "elf", "Elf", {
      raceDefinitions: {
        F: { id: "elf:F", perLevel: { agility: 2 }, freePerLevel: 2 },
      },
    })
    seedClass("cls-1", "archer", "Archer", {
      F: { fixed: { agility: 2 }, free: 1 },
    })

    const state = createInitialState("integrated", null, null)
    state.race = {
      level: 19,
      grade: "G",
      mode: "derived",
      origin: "integrated",
    }
    state.tracks.class = { level: 20, quarter: 3, definitionId: "" }
    state.tracks.profession = { level: 19, quarter: 0, definitionId: "" }
    seedCharacter({ state: serializeState(state) })

    const evolved = await evolveCharacter(
      "chr-1",
      { track: "race", optionId: "race-elf", version: 0 },
      user
    )
    expect(evolved.character.raceId).toBe("race-elf")

    // A class level-up bumps the derived race level from 19 to 20 and snapshots
    // the award against the destination race's definition (elf:F).
    const advanced = await advanceCharacter(
      "chr-1",
      { track: "class", version: 1 },
      user
    )
    const newState = deserializeState(advanced.character.state)
    const raceAwards = newState.historicalLevelAwards.filter(
      (a) => a.track === "race"
    )
    expect(raceAwards.length).toBeGreaterThan(0)
    expect(raceAwards.at(-1)!.definitionId).toBe("elf:F")
  })

  it("rolls back a race evolution on a stale version with no event", async () => {
    seedRace("race-human", "human", "Human", {
      raceDefinitions: {
        G: { id: "human:G", perLevel: { strength: 1 }, freePerLevel: 1 },
      },
    })
    seedRace("race-elf", "elf", "Elf", {
      raceDefinitions: {
        F: { id: "elf:F", perLevel: { agility: 2 }, freePerLevel: 2 },
      },
    })
    seedCharacter({ version: 2 })

    // An unrelated mutation bumps the version to 3.
    await updateCharacter("chr-1", { name: "Renamed", version: 2 }, user)

    await expect(
      evolveCharacter(
        "chr-1",
        { track: "race", optionId: "race-elf", version: 2 },
        user
      )
    ).rejects.toMatchObject({ status: 409, code: "version_conflict" })

    const fresh = dbMock.store.characters.get("chr-1")!
    expect(fresh.raceId).toBe("race-human")
    expect(fresh.version).toBe(3)
    // Only the update event was written; the race evolve never committed.
    expect(dbMock.store.events).toHaveLength(1)
    expect(dbMock.store.events[0].kind).toBe("update")
  })

  it("evolves a monster race to a same-type (monster) destination", async () => {
    seedRace("race-wyrm", "wyrm", "Wyrm", {
      raceType: "monster",
      naturalGrade: "F",
      raceDefinitions: {
        F: { id: "wyrm:F", perLevel: { strength: 2 }, freePerLevel: 1 },
      },
    })
    seedRace("race-beast", "beast", "Beast", {
      raceType: "monster",
      raceDefinitions: {
        E: { id: "beast:E", perLevel: { strength: 3 }, freePerLevel: 2 },
      },
    })

    const base = createInitialState("born", null, null)
    base.tracks = {}
    base.race = {
      level: 30,
      grade: "F",
      mode: "independent",
      origin: "born",
      quarter: 0,
    }
    seedCharacter({ state: serializeState(base), raceId: "race-wyrm" })

    const res = await evolveCharacter(
      "chr-1",
      { track: "race", optionId: "race-beast", version: 0 },
      user
    )
    expect(res.character.version).toBe(1)
    expect(res.character.raceId).toBe("race-beast")
    expect(res.character.raceName).toBe("Beast")
    const state = deserializeState(res.character.state)
    expect(state.race.grade).toBe("E")
    // A same-type evolution never changes the race mode (no implicit conversion).
    expect(state.race.mode).toBe("independent")
    expect(state.race.definitionId).toBe("beast:E")
  })

  it("maps a serialization failure (P2034) on evolve to 409 serialization_conflict and rolls back the evolution state/event", async () => {
    seedRace("race-human", "human", "Human", {
      raceDefinitions: {
        G: { id: "human:G", perLevel: { strength: 1 }, freePerLevel: 1 },
      },
    })
    seedRace("race-elf", "elf", "Elf", {
      raceDefinitions: {
        F: { id: "elf:F", perLevel: { agility: 2 }, freePerLevel: 2 },
      },
    })
    seedCharacter()
    const before = dbMock.store.characters.get("chr-1")!
    const beforeState = before.state
    // A concurrent admin edit to the destination race's config commits while this
    // evolve is in flight. The SERIALIZABLE transaction detects the conflict and
    // aborts with P2034, which the service must surface as a 409 rather than a raw
    // 500, and must not advance the character state or write a stray evolve event.
    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce({
      name: "PrismaClientKnownRequestError",
      code: "P2034",
    })
    try {
      await expect(
        evolveCharacter(
          "chr-1",
          { track: "race", optionId: "race-elf", version: 0 },
          user
        )
      ).rejects.toMatchObject({ status: 409, code: "serialization_conflict" })
    } finally {
      spy.mockRestore()
    }
    const after = dbMock.store.characters.get("chr-1")!
    expect(after.state).toBe(beforeState)
    expect(after.version).toBe(0)
    expect(dbMock.store.events).toHaveLength(0)
  })

  it("blocks a race option when the target grade's gate is closed", () => {
    // The service config leaves grade gates open, so the gate-closed blocker is
    // exercised at the pure level. A closed gate must block even a qualifying level.
    const config = defaultRulesConfig()
    config.gradeGates.F = false
    expect(raceGradeBandBlockers("F", 10, config)).toContain(
      "grade gate closed for F"
    )
  })
})

describe("class/profession track evolution (next-grade candidates)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function seedClass(
    id: string,
    stableId: string,
    name: string,
    grades: Record<string, { fixed: Record<string, number>; free: number }>
  ) {
    dbMock.store.addCatalog({
      id,
      kind: "classes",
      stableId,
      name,
      config: { grades },
    })
  }

  function seedProfession(
    id: string,
    stableId: string,
    name: string,
    grades: Record<string, { fixed: Record<string, number>; free: number }>
  ) {
    dbMock.store.addCatalog({
      id,
      kind: "professions",
      stableId,
      name,
      config: { grades },
    })
  }

  function seedRace(
    id: string,
    stableId: string,
    name: string,
    config: Record<string, unknown>
  ) {
    dbMock.store.addCatalog({
      id,
      kind: "races",
      stableId,
      name,
      config,
    })
  }

  function seedGradedCharacter(
    opts: {
      raceId?: string | null
      classId?: string | null
      classStableId?: string
      classGrade?: Grade
      classLevel?: number
      professionId?: string | null
      professionStableId?: string
      professionGrade?: Grade
      professionLevel?: number
      raceGrade?: Grade
      raceLevel?: number
      version?: number
    } = {}
  ) {
    const classRow = opts.classStableId
      ? ({ stableId: opts.classStableId } as Parameters<
          typeof createInitialState
        >[3])
      : undefined
    const profRow = (
      opts.professionStableId
        ? ({ stableId: opts.professionStableId } as Parameters<
            typeof createInitialState
          >[2])
        : null
    ) as Parameters<typeof createInitialState>[2]
    const state = createInitialState("integrated", null, profRow, classRow)
    state.race = {
      level: opts.raceLevel ?? 0,
      grade: opts.raceGrade ?? "G",
      mode: "derived",
      origin: "integrated",
    }
    if (opts.classStableId && state.tracks.class) {
      state.tracks.class.level = opts.classLevel ?? 0
      if (opts.classGrade) {
        state.tracks.class.grade = opts.classGrade
        state.tracks.class.definitionId = `${opts.classStableId}:${opts.classGrade}`
      }
    }
    if (opts.professionStableId && state.tracks.profession) {
      state.tracks.profession.level = opts.professionLevel ?? 0
      if (opts.professionGrade) {
        state.tracks.profession.grade = opts.professionGrade
        state.tracks.profession.definitionId = `${opts.professionStableId}:${opts.professionGrade}`
      }
    }
    return dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      raceId: opts.raceId ?? null,
      classId: opts.classId ?? null,
      professionId: opts.professionId ?? null,
      state: serializeState(state),
      version: opts.version ?? 0,
    })
  }

  it("stamps F grade and stableId:F definition for a graded class/profession", () => {
    const classRow = {
      stableId: "archer",
    } as Parameters<typeof createInitialState>[3]
    const profRow = {
      stableId: "alchemist",
    } as Parameters<typeof createInitialState>[2]
    const state = createInitialState("integrated", null, profRow, classRow)
    expect(state.tracks.class.grade).toBe("F")
    expect(state.tracks.class.definitionId).toBe("archer:F")
    expect(state.tracks.profession.grade).toBe("F")
    expect(state.tracks.profession.definitionId).toBe("alchemist:F")
    // The race grade stays origin-driven; the class grade is independent.
    expect(state.race.grade).toBe("G")
  })

  it("returns contextual next-grade class options and never a legacy fallback", async () => {
    seedClass("cls-archer", "archer", "Archer", {
      F: { fixed: { agility: 2 }, free: 1 },
      E: { fixed: { agility: 3 }, free: 1 },
    })
    seedClass("cls-lancer", "lancer", "Lancer", {
      E: { fixed: { strength: 3 }, free: 1 },
    })
    // A class with no E grade is never a candidate.
    seedClass("cls-mage", "mage", "Mage", {
      F: { fixed: { agility: 2 }, free: 1 },
    })
    seedGradedCharacter({
      classId: "cls-archer",
      classStableId: "archer",
      classGrade: "F",
      classLevel: 30,
    })

    const res = await getEvolutionOptions("chr-1", user, "class")
    expect(res.legacyAvailable).toBe(false)
    expect(res.options.map((o) => o.id)).toEqual(["cls-archer", "cls-lancer"])
    for (const option of res.options) {
      expect(option).toMatchObject({
        fromGrade: "F",
        toGrade: "E",
        track: "class",
        eligible: true,
        blockers: [],
      })
    }
  })

  it("gates class evolution by the class grade, independent of the race grade", async () => {
    seedClass("cls-archer", "archer", "Archer", {
      F: { fixed: { agility: 2 }, free: 1 },
      E: { fixed: { agility: 3 }, free: 1 },
    })
    seedRace("race-human", "human", "Human", {
      raceDefinitions: {
        G: { id: "human:G", perLevel: { strength: 1 }, freePerLevel: 1 },
        F: { id: "human:F", perLevel: { strength: 1 }, freePerLevel: 1 },
      },
    })
    // Race grade G, class grade F: the two progression gates are independent.
    seedGradedCharacter({
      classId: "cls-archer",
      classStableId: "archer",
      classGrade: "F",
      raceGrade: "G",
      classLevel: 30,
    })

    // track=class targets the class's next grade (E), not the race's next grade (F).
    const clsRes = await getEvolutionOptions("chr-1", user, "class")
    expect(clsRes.options).toHaveLength(1)
    expect(clsRes.options[0].toGrade).toBe("E")
    expect(clsRes.legacyAvailable).toBe(false)

    // track=race targets the race's next grade (F), unaffected by the class grade.
    const raceRes = await getEvolutionOptions("chr-1", user, "race")
    expect(raceRes.options).toHaveLength(1)
    expect(raceRes.options[0].toGrade).toBe("F")
    expect(raceRes.legacyAvailable).toBe(false)
  })

  it("filters profession options the same way and rejects an unknown track destination", async () => {
    seedProfession("prof-alc", "alchemist", "Alchemist", {
      F: { fixed: { agility: 2 }, free: 1 },
      E: { fixed: { agility: 3 }, free: 1 },
    })
    seedGradedCharacter({
      professionId: "prof-alc",
      professionStableId: "alchemist",
      professionGrade: "F",
      professionLevel: 30,
    })

    const res = await getEvolutionOptions("chr-1", user, "profession")
    expect(res.legacyAvailable).toBe(false)
    expect(res.options.map((o) => o.id)).toEqual(["prof-alc"])
    expect(res.options[0]).toMatchObject({ toGrade: "E", track: "profession" })

    // The evolve POST requires a destination definition of the right kind; a
    // profession POST pointed at a class row is a missing destination.
    seedClass("cls-archer", "archer", "Archer", {
      F: { fixed: { agility: 2 }, free: 1 },
    })
    await expect(
      evolveCharacter(
        "chr-1",
        { track: "profession", optionId: "cls-archer", version: 0 },
        user
      )
    ).rejects.toMatchObject({
      status: 404,
      code: "evolution_destination_missing",
    })
  })

  it("marks a track option blocked below the target band and agrees with the POST rejection", async () => {
    seedClass("cls-archer", "archer", "Archer", {
      F: { fixed: { agility: 2 }, free: 1 },
      E: { fixed: { agility: 3 }, free: 1 },
    })
    // The class track is F grade but its level (5) is below the E band entry (25),
    // so the next-grade evolve cannot be taken yet.
    seedGradedCharacter({
      classId: "cls-archer",
      classStableId: "archer",
      classGrade: "F",
      classLevel: 5,
    })

    const res = await getEvolutionOptions("chr-1", user, "class")
    expect(res.options).toHaveLength(1)
    expect(res.options[0].eligible).toBe(false)
    expect(res.options[0].blockers).toEqual([
      expect.stringContaining("class level 5 does not qualify for E"),
    ])

    // GET must agree with POST: the pure evolveTrackGrade engine also rejects the
    // choice because the track level is below the target band's entry level.
    await expect(
      evolveCharacter(
        "chr-1",
        { track: "class", optionId: "cls-archer", version: 0 },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "evolution" })
  })

  it("evolves a qualifying class to the destination definition and next grade", async () => {
    seedClass("cls-archer", "archer", "Archer", {
      F: { fixed: { agility: 2 }, free: 1 },
      E: { fixed: { agility: 3 }, free: 1 },
    })
    seedClass("cls-ranger", "ranger", "Ranger", {
      F: { fixed: { agility: 2 }, free: 1 },
      E: { fixed: { agility: 4 }, free: 1 },
    })
    seedGradedCharacter({
      classId: "cls-archer",
      classStableId: "archer",
      classGrade: "F",
      classLevel: 30,
    })

    const res = await evolveCharacter(
      "chr-1",
      { track: "class", optionId: "cls-ranger", version: 0 },
      user
    )
    expect(res.character.classId).toBe("cls-ranger")
    const state = deserializeState(res.character.state)
    expect(state.tracks.class.grade).toBe("E")
    expect(state.tracks.class.definitionId).toBe("ranger:E")
    // Race grade and historical awards are untouched.
    expect(state.race.grade).toBe("G")
    expect(state.historicalLevelAwards).toHaveLength(0)
    expect(res.journal).toMatchObject({
      track: "class",
      from: "F",
      to: "E",
      source: "track",
      optionId: "cls-ranger",
    })
  })

  it("rolls back a class evolution on a stale version with no event", async () => {
    seedClass("cls-archer", "archer", "Archer", {
      F: { fixed: { agility: 2 }, free: 1 },
      E: { fixed: { agility: 3 }, free: 1 },
    })
    seedGradedCharacter({
      classId: "cls-archer",
      classStableId: "archer",
      classGrade: "F",
      classLevel: 30,
      version: 2,
    })
    // An unrelated mutation bumps the version to 3.
    await updateCharacter("chr-1", { name: "Renamed", version: 2 }, user)

    await expect(
      evolveCharacter(
        "chr-1",
        { track: "class", optionId: "cls-archer", version: 2 },
        user
      )
    ).rejects.toMatchObject({ status: 409, code: "version_conflict" })

    const fresh = dbMock.store.characters.get("chr-1")!
    expect(fresh.classId).toBe("cls-archer")
    expect(fresh.version).toBe(3)
    // Only the update event was written; the class evolve never committed.
    expect(dbMock.store.events).toHaveLength(1)
    expect(dbMock.store.events[0].kind).toBe("update")
  })

  it("returns no class options and rejects track evolve, on a legacy ungraded track", async () => {
    seedClass("cls-archer", "archer", "Archer", {
      F: { fixed: { agility: 2 }, free: 1 },
      E: { fixed: { agility: 3 }, free: 1 },
    })
    // Legacy state: no explicit grade, empty definitionId.
    const state = createInitialState("integrated", null, null)
    state.tracks.class = { level: 0, quarter: 0, definitionId: "" }
    dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      classId: "cls-archer",
      state: serializeState(state),
      version: 0,
    })

    const res = await getEvolutionOptions("chr-1", user, "class")
    expect(res.options).toHaveLength(0)
    expect(res.legacyAvailable).toBe(false)

    await expect(
      evolveCharacter(
        "chr-1",
        { track: "class", optionId: "cls-archer", version: 0 },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "track_grade_unknown" })
  })

  it("preserves a graded class/profession track across export/import state roundtrip", async () => {
    seedClass("cls-archer", "archer", "Archer", {
      F: { fixed: { agility: 2 }, free: 1 },
    })
    seedRace("race-human", "human", "Human", {
      raceDefinitions: {
        G: { id: "human:G", perLevel: { strength: 1 }, freePerLevel: 1 },
      },
    })
    const classRow = { stableId: "archer" } as Parameters<
      typeof createInitialState
    >[3]
    const state = createInitialState("integrated", null, null, classRow)
    dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      raceId: "race-human",
      classId: "cls-archer",
      state: serializeState(state),
      version: 0,
    })

    const portable = await exportCharacter("chr-1", user)
    const imported = await importCharacter(
      portable as CharacterImportDocument,
      user
    )
    const importedState = deserializeState(imported.state)
    expect(importedState.tracks.class.grade).toBe("F")
    expect(importedState.tracks.class.definitionId).toBe("archer:F")
  })
})

describe("importCharacter (trusted backup v3)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function addImportCatalog(
    kind: string,
    id: string,
    config: Record<string, unknown>,
    extra: Partial<{ name: string; archived: boolean }> = {}
  ): unknown {
    return dbMock.store.addCatalog({
      id,
      kind,
      stableId: id,
      name: extra.name ?? id,
      config,
      ...(extra.archived != null ? { archived: extra.archived } : {}),
    })
  }

  function seedRaceClass() {
    addImportCatalog(
      "races",
      "human",
      {
        raceDefinitions: {
          G: { id: "human:G", perLevel: allEqual(1), freePerLevel: 5 },
        },
      },
      { name: "Human" }
    )
    addImportCatalog(
      "classes",
      "archer",
      {
        grades: {
          F: { fixed: {}, free: 0 },
          G: { fixed: {}, free: 0 },
        },
      },
      { name: "Archer" }
    )
  }

  type ImportDocPartial = Omit<Partial<CharacterImportDocument>, "state"> & {
    state?: CharacterState
  }

  // The unit import tests intentionally build a legacy v3 document: it has no
  // `inventory` field and no `legacyUnowned` marker, so the importer grandfathers
  // every equipment link and imports no stock.
  type ImportV3Document = Extract<
    CharacterImportDocument,
    { schema: typeof IMPORT_SCHEMA_V3 }
  >

  type ImportV4Document = Extract<
    CharacterImportDocument,
    { schema: typeof IMPORT_SCHEMA_V4 }
  >

  function importDoc(partial: ImportDocPartial = {}): ImportV3Document {
    const { state: rawState, ...rest } = partial
    return {
      schema: IMPORT_SCHEMA_V3,
      rulesetVersion: IMPORT_RULESET_VERSION,
      identity: {
        name: "Imported",
        description: null,
        origin: "integrated",
        race: { stableId: "human" },
        class: { stableId: "archer" },
        profession: null,
      },
      state: serializeState(
        rawState ?? createInitialState("integrated", null, null)
      ) as CharacterImportDocument["state"],
      liveState: {},
      status: {},
      associations: [],
      events: [],
      skillOffers: [],
      ...rest,
    } as ImportV3Document
  }

  type V4DocPartial = Partial<ImportV4Document> & { state?: CharacterState }

  function v4Doc(partial: V4DocPartial = {}): ImportV4Document {
    const { state: rawState, ...rest } = partial
    return {
      schema: IMPORT_SCHEMA_V4,
      rulesetVersion: IMPORT_RULESET_VERSION,
      identity: {
        name: "Imported",
        description: null,
        origin: "integrated",
        race: { stableId: "human" },
        class: { stableId: "archer" },
        profession: null,
      },
      state: serializeState(
        rawState ?? createInitialState("integrated", null, null)
      ) as ImportV4Document["state"],
      liveState: {},
      status: {},
      associations: [],
      inventory: [],
      events: [],
      skillOffers: [],
      ...rest,
    } as ImportV4Document
  }

  type ImportV6Document = Extract<
    CharacterImportDocument,
    { schema: typeof IMPORT_SCHEMA_V6 }
  >

  type V6DocPartial = Partial<ImportV6Document> & { state?: CharacterState }

  function v6Doc(partial: V6DocPartial = {}): ImportV6Document {
    const { state: rawState, ...rest } = partial
    return {
      schema: IMPORT_SCHEMA_V6,
      rulesetVersion: IMPORT_RULESET_VERSION,
      identity: {
        name: "Imported",
        description: null,
        origin: "integrated",
        race: { stableId: "human" },
        class: { stableId: "archer" },
        profession: null,
      },
      state: serializeState(
        rawState ?? createInitialState("integrated", null, null)
      ) as CharacterImportDocument["state"],
      liveState: {},
      status: {},
      associations: [],
      inventory: [],
      events: [],
      skillOffers: [],
      ...rest,
    } as ImportV6Document
  }

  type ImportV7Document = Extract<
    CharacterImportDocument,
    { schema: typeof IMPORT_SCHEMA_V7 }
  >

  type V7DocPartial = Partial<ImportV7Document> & { state?: CharacterState }

  function v7Doc(partial: V7DocPartial = {}): ImportV7Document {
    const { state: rawState, ...rest } = partial
    return {
      schema: IMPORT_SCHEMA_V7,
      rulesetVersion: IMPORT_RULESET_VERSION,
      identity: {
        name: "Imported",
        description: null,
        origin: "integrated",
        race: { stableId: "human" },
        class: { stableId: "archer" },
        profession: null,
      },
      state: serializeState(
        rawState ?? createInitialState("integrated", null, null)
      ) as CharacterImportDocument["state"],
      liveState: {},
      status: {},
      associations: [],
      inventory: [],
      events: [],
      skillOffers: [],
      ...rest,
    } as ImportV7Document
  }

  it("imports a valid v3 backup as a new imported character owned by the importer", async () => {
    seedRaceClass()
    addImportCatalog(
      "professions",
      "alchemist",
      { grades: { G: { fixed: {}, free: 0 } } },
      { name: "Alchemist" }
    )
    addImportCatalog(
      "titles",
      "title-1",
      { upgradeGroup: "hero" },
      { name: "Heroic" }
    )
    addImportCatalog("equipment", "gear-1", { slot: "head" }, { name: "Helm" })
    addImportCatalog("skills", "skill-1", {}, { name: "Skill One" })

    const state = createInitialState("integrated", null, null)
    state.tracks.profession = { level: 0, quarter: 0, definitionId: "prof" }

    const doc = importDoc({
      identity: {
        name: "Imported Hero",
        description: "A backup",
        origin: "integrated",
        race: { stableId: "human" },
        class: { stableId: "archer" },
        profession: { stableId: "alchemist" },
      },
      state,
      associations: [
        { kind: "title", definition: { kind: "titles", stableId: "title-1" } },
        {
          kind: "equipment",
          definition: { kind: "equipment", stableId: "gear-1" },
        },
        { kind: "skill", definition: { kind: "skills", stableId: "skill-1" } },
      ],
      skillOffers: [
        {
          track: "class",
          level: 1,
          choiceGroup: "standard",
          selectedStableId: "skill-1",
          offeredAt: "2026-01-01T00:00:00.000Z",
          options: [
            {
              stableId: "skill-1",
              nameSnapshot: "Skill One",
              configSnapshot: {},
            },
          ],
        },
      ],
      events: [
        { kind: "create", payload: { foo: 1 } },
        { kind: "advance", payload: { level: 1 } },
      ],
    })

    const result = await importCharacter(doc, user)
    expect(result.imported).toBe(true)
    expect(result.origin).toBe("integrated")
    expect(result.raceName).toBe("Human")
    expect(result.className).toBe("Archer")
    expect(result.professionName).toBe("Alchemist")
    expect(result.associations).toHaveLength(3)
    expect(result.skillOffers).toHaveLength(1)
    expect(result.skillOffers[0].selectedDefinitionId).toBe("skill-1")

    const created = [...dbMock.store.characters.values()][0]
    expect(created.ownerId).toBe(user.id)
    expect(created.version).toBe(0)
    expect(created.imported).toBe(true)
    expect(created.raceId).toBe("human")
    expect(created.classId).toBe("archer")
    expect(created.professionId).toBe("alchemist")

    const evs = dbMock.store.events.filter((e) => e.characterId === created.id)
    expect(evs.map((e) => e.kind)).toEqual([
      "import_history",
      "import_history",
      "import",
    ])
    expect((evs[0].payload as { sourceKind: string }).sourceKind).toBe("create")
    expect((evs[2].payload as { rulesetVersion: string }).rulesetVersion).toBe(
      IMPORT_RULESET_VERSION
    )
  })

  it("maps a serialization failure (P2034) on import to 409 serialization_conflict and rolls back character/associations/events", async () => {
    seedRaceClass()
    // A concurrent admin edit to the imported race's config (e.g. raceType) commits
    // while this import is in flight. The SERIALIZABLE transaction detects the
    // conflict and aborts with P2034, which the service must surface as a 409
    // rather than a raw 500, and must roll back the character / links / events
    // entirely (no partially-imported character, no stray import event).
    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce({
      name: "PrismaClientKnownRequestError",
      code: "P2034",
    })
    try {
      await expect(importCharacter(importDoc(), user)).rejects.toMatchObject({
        status: 409,
        code: "serialization_conflict",
      })
    } finally {
      spy.mockRestore()
    }
    // The rejected import left no character, event, association or offer behind.
    expect(dbMock.store.characters.size).toBe(0)
    expect(dbMock.store.events).toHaveLength(0)
    expect(dbMock.store.associations).toHaveLength(0)
    expect(dbMock.store.skillOffers).toHaveLength(0)
  })

  it("rejects a backup whose race stableId is not in the catalog", async () => {
    addImportCatalog("classes", "archer", {
      grades: { G: { fixed: {}, free: 0 } },
    })
    await expect(importCharacter(importDoc(), user)).rejects.toMatchObject({
      status: 400,
      code: "import_catalog_missing",
    })
  })

  it("rejects an imported identity whose race definition is archived", async () => {
    addImportCatalog("races", "human", {}, { archived: true })
    addImportCatalog("classes", "archer", {
      grades: { G: { fixed: {}, free: 0 } },
    })
    await expect(importCharacter(importDoc(), user)).rejects.toMatchObject({
      status: 400,
      code: "import_catalog_archived",
    })
  })

  it("rejects an association definition that is not in the catalog", async () => {
    seedRaceClass()
    const doc = importDoc({
      associations: [
        { kind: "title", definition: { kind: "titles", stableId: "ghost" } },
      ],
    })
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "import_link_missing",
    })
  })

  it("rejects an association whose definition kind does not match the link kind", async () => {
    seedRaceClass()
    addImportCatalog("titles", "title-1", {})
    const doc = importDoc({
      associations: [
        {
          kind: "equipment",
          definition: { kind: "titles", stableId: "title-1" },
        },
      ],
    })
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "import_kind_mismatch",
    })
  })

  it("rejects the same catalog definition linked more than once", async () => {
    seedRaceClass()
    addImportCatalog("titles", "title-1", {})
    const doc = importDoc({
      associations: [
        { kind: "title", definition: { kind: "titles", stableId: "title-1" } },
        { kind: "title", definition: { kind: "titles", stableId: "title-1" } },
      ],
    })
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "import_duplicate_link",
    })
  })

  it("rejects two active equipment links that occupy the same slot", async () => {
    seedRaceClass()
    addImportCatalog("equipment", "gear-1", { slot: "head" }, { name: "Helm" })
    addImportCatalog("equipment", "gear-2", { slot: "head" }, { name: "Crown" })
    const doc = importDoc({
      associations: [
        {
          kind: "equipment",
          definition: { kind: "equipment", stableId: "gear-1" },
        },
        {
          kind: "equipment",
          definition: { kind: "equipment", stableId: "gear-2" },
        },
      ],
    })
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "import_link_collision",
    })
  })

  it("imports a grandfathered equipment link whose requirement is currently unmet (kept, shown inert)", async () => {
    seedRaceClass()
    addImportCatalog("equipment", "gear-1", {
      slot: "Weapon",
      rarity: "Common",
      bonus: { strength: 30 },
      minRaceLevel: 5,
    })
    // A v3 state whose race level (0, the default) is below the item's
    // requirement.
    const doc = importDoc({
      associations: [
        {
          kind: "equipment",
          definition: { kind: "equipment", stableId: "gear-1" },
        },
      ],
    })
    // The import must NOT reject merely because the requirement is currently unmet.
    const result = await importCharacter(doc, user)
    expect(result.associations).toHaveLength(1)
    expect(result.associations[0].definitionId).toBeTruthy()
    // The item is shown but its bonus is not synthesized while ineligible.
    const items = result.status?.equipment.items ?? []
    expect(items).toHaveLength(1)
    expect(items[0].name).toBeTruthy()
    expect(items[0].applied.strength).toBe(0)
  })

  it("rejects two active title links sharing an upgrade group", async () => {
    seedRaceClass()
    addImportCatalog("titles", "title-1", { upgradeGroup: "hero" })
    addImportCatalog("titles", "title-2", { upgradeGroup: "hero" })
    const doc = importDoc({
      associations: [
        { kind: "title", definition: { kind: "titles", stableId: "title-1" } },
        { kind: "title", definition: { kind: "titles", stableId: "title-2" } },
      ],
    })
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "import_link_collision",
    })
  })

  it("preserves an archived association inertly when its definition still exists", async () => {
    seedRaceClass()
    addImportCatalog(
      "titles",
      "title-1",
      { upgradeGroup: "hero" },
      { archived: true }
    )
    const doc = importDoc({
      associations: [
        { kind: "title", definition: { kind: "titles", stableId: "title-1" } },
      ],
    })
    const result = await importCharacter(doc, user)
    expect(result.associations).toHaveLength(1)
    expect(result.associations[0].definitionArchived).toBe(true)
  })

  it("imports blessing and bloodline associations by stableId", async () => {
    seedRaceClass()
    addImportCatalog(
      "gods",
      "god-1",
      {
        pantheon: "Test Pantheon",
        divineRank: "God",
        blessingEffects: { Minor: [] },
      },
      { name: "God One" }
    )
    addImportCatalog(
      "bloodlines",
      "blood-1",
      { effects: [] },
      { name: "Blood One" }
    )
    const doc = v7Doc({
      associations: [
        {
          kind: "blessing",
          definition: { kind: "gods", stableId: "god-1" },
          tier: "Minor",
        },
        {
          kind: "bloodline",
          definition: { kind: "bloodlines", stableId: "blood-1" },
        },
      ],
    })
    const result = await importCharacter(doc, user)
    expect(result.associations).toHaveLength(2)
    expect(result.associations.map((a) => a.kind).sort()).toEqual([
      "blessing",
      "bloodline",
    ])
    // Rejected kinds would have been persisted as the surviving TITLE/EQUIPMENT/
    // SKILL kinds; the imported blessing/bloodline must use the new DB kinds.
    const kinds = dbMock.store.associations.map((a) => a.kind).sort()
    expect(kinds).toEqual(["BLESSING", "BLOODLINE"])
  })

  it("imports multiple distinct transcendent links by stableId and derives isTranscendent (no singleton)", async () => {
    seedRaceClass()
    addImportCatalog(
      "transcendent_skills",
      "trans-1",
      { passiveEffects: [] },
      { name: "Holyland" }
    )
    addImportCatalog(
      "transcendent_skills",
      "trans-2",
      { passiveEffects: [] },
      { name: "Fighting Spirit" }
    )
    const doc = importDoc({
      associations: [
        {
          kind: "transcendent",
          definition: { kind: "transcendent_skills", stableId: "trans-1" },
        },
        {
          kind: "transcendent",
          definition: { kind: "transcendent_skills", stableId: "trans-2" },
        },
      ],
    })
    const result = await importCharacter(doc, user)
    expect(result.associations).toHaveLength(2)
    expect(result.associations.map((a) => a.kind).sort()).toEqual([
      "transcendent",
      "transcendent",
    ])
    expect(result.isTranscendent).toBe(true)
    // Distinct DB kinds are persisted, never a blessing singleton.
    const kinds = dbMock.store.associations.map((a) => a.kind).sort()
    expect(kinds).toEqual(["TRANSCENDENT", "TRANSCENDENT"])
    // Historical (stored engine) state is unaffected by synthesized effects.
    const stored = dbMock.store.characters.get(result.id)!
    expect(
      (stored.state as { activeEffects: unknown[] }).activeEffects
    ).toEqual([])
  })

  it("rejects an import carrying more than the configured transcendent cap", async () => {
    seedRaceClass()
    for (let i = 1; i <= 4; i++) {
      addImportCatalog(
        "transcendent_skills",
        `trans-${i}`,
        { passiveEffects: [] },
        { name: `Transcendent ${i}` }
      )
    }
    const doc = importDoc({
      associations: [1, 2, 3, 4].map((i) => ({
        kind: "transcendent",
        definition: { kind: "transcendent_skills", stableId: `trans-${i}` },
      })),
    })
    // A backup carrying more than the cap (default 3) is rejected before any write.
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "import_link_collision",
    })
    // No character, event or link is written.
    expect(dbMock.store.characters.size).toBe(0)
    expect(dbMock.store.events).toHaveLength(0)
    expect(dbMock.store.associations).toHaveLength(0)
  })

  it("rejects an association whose definition kind does not match a transcendent link kind", async () => {
    seedRaceClass()
    addImportCatalog(
      "skills",
      "skill-1",
      { effects: [] },
      { name: "Skill One" }
    )
    const doc = importDoc({
      associations: [
        {
          kind: "transcendent",
          definition: { kind: "skills", stableId: "skill-1" },
        },
      ],
    })
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "import_kind_mismatch",
    })
  })

  it("rejects more than one active blessing on import", async () => {
    seedRaceClass()
    addImportCatalog(
      "gods",
      "god-1",
      { blessingEffects: { Minor: [] } },
      {
        name: "God One",
      }
    )
    addImportCatalog(
      "gods",
      "god-2",
      { blessingEffects: { Minor: [] } },
      {
        name: "God Two",
      }
    )
    const doc = v7Doc({
      associations: [
        {
          kind: "blessing",
          definition: { kind: "gods", stableId: "god-1" },
          tier: "Minor",
        },
        {
          kind: "blessing",
          definition: { kind: "gods", stableId: "god-2" },
          tier: "Minor",
        },
      ],
    })
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "import_link_collision",
    })
  })

  it("rejects the SAME blessing catalog definition referenced twice on import as a link collision", async () => {
    seedRaceClass()
    addImportCatalog(
      "gods",
      "god-1",
      { blessingEffects: { Minor: [] } },
      {
        name: "God One",
      }
    )
    const doc = v7Doc({
      associations: [
        {
          kind: "blessing",
          definition: { kind: "gods", stableId: "god-1" },
          tier: "Minor",
        },
        {
          kind: "blessing",
          definition: { kind: "gods", stableId: "god-1" },
          tier: "Minor",
        },
      ],
    })
    // A duplicated blessing is a single-slot collision, never a generic duplicate
    // link - the resolver counts blessing refs BEFORE the per-ref duplicate guard.
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "import_link_collision",
    })
  })

  it("rejects an active + archived blessing pair on import as a link collision", async () => {
    seedRaceClass()
    addImportCatalog(
      "gods",
      "god-1",
      { blessingEffects: { Minor: [] } },
      {
        name: "God One",
      }
    )
    addImportCatalog(
      "gods",
      "god-2",
      { blessingEffects: { Minor: [] } },
      {
        name: "God Two",
        archived: true,
      }
    )
    const doc = v7Doc({
      associations: [
        {
          kind: "blessing",
          definition: { kind: "gods", stableId: "god-1" },
          tier: "Minor",
        },
        {
          kind: "blessing",
          definition: { kind: "gods", stableId: "god-2" },
          tier: "Minor",
        },
      ],
    })
    // An archived blessing still occupies the single blessing slot, so an
    // active + archived pair is a collision, not an inert append.
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "import_link_collision",
    })
  })

  it("rejects two bloodlines on import (at most one bloodline link)", async () => {
    seedRaceClass()
    addImportCatalog(
      "bloodlines",
      "blood-1",
      { upgradeGroup: "primal", effects: [] },
      { name: "Blood One" }
    )
    addImportCatalog(
      "bloodlines",
      "blood-2",
      { upgradeGroup: "primal", effects: [] },
      { name: "Blood Two" }
    )
    const doc = importDoc({
      associations: [
        {
          kind: "bloodline",
          definition: { kind: "bloodlines", stableId: "blood-1" },
        },
        {
          kind: "bloodline",
          definition: { kind: "bloodlines", stableId: "blood-2" },
        },
      ],
    })
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "import_link_collision",
    })
  })

  it("ignores archived definitions when checking import collisions for non-singleton kinds", async () => {
    seedRaceClass()
    // A single blessing (an archived one would still count toward the singleton).
    addImportCatalog(
      "gods",
      "god-1",
      { blessingEffects: { Minor: [] } },
      {
        name: "God One",
      }
    )
    addImportCatalog(
      "titles",
      "title-1",
      { upgradeGroup: "hero", effects: [] },
      { name: "Title One" }
    )
    addImportCatalog(
      "titles",
      "title-arch",
      { upgradeGroup: "hero", effects: [] },
      { name: "Title Arch", archived: true }
    )
    const doc = v7Doc({
      associations: [
        {
          kind: "blessing",
          definition: { kind: "gods", stableId: "god-1" },
          tier: "Minor",
        },
        {
          kind: "title",
          definition: { kind: "titles", stableId: "title-1" },
        },
        {
          kind: "title",
          definition: { kind: "titles", stableId: "title-arch" },
        },
      ],
    })
    // The archived title-arch shares the "hero" group with title-1 but is inert,
    // so it is ignored by the active-only collision check and imports cleanly.
    const result = await importCharacter(doc, user)
    expect(result.associations).toHaveLength(3)
  })

  it("rejects an active plus archived blessing on import (two total blessings)", async () => {
    seedRaceClass()
    addImportCatalog(
      "gods",
      "god-1",
      { blessingEffects: { Minor: [] } },
      {
        name: "God One",
      }
    )
    addImportCatalog(
      "gods",
      "god-arch",
      { blessingEffects: { Minor: [] } },
      {
        name: "God Arch",
        archived: true,
      }
    )
    const doc = v7Doc({
      associations: [
        {
          kind: "blessing",
          definition: { kind: "gods", stableId: "god-1" },
          tier: "Minor",
        },
        {
          kind: "blessing",
          definition: { kind: "gods", stableId: "god-arch" },
          tier: "Minor",
        },
      ],
    })
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "import_link_collision",
    })
    // No character, event or link is written.
    expect(dbMock.store.characters.size).toBe(0)
    expect(dbMock.store.events).toHaveLength(0)
    expect(dbMock.store.associations).toHaveLength(0)
  })

  it("round-trips blessing and bloodline link kinds through export/import", async () => {
    seedRaceClass()
    addImportCatalog(
      "gods",
      "god-1",
      { blessingEffects: { Minor: [] } },
      { name: "God One" }
    )
    addImportCatalog(
      "bloodlines",
      "blood-1",
      { effects: [] },
      { name: "Blood One" }
    )
    const created = await createCharacter(
      {
        name: "N",
        origin: "integrated",
        raceId: "human",
        classId: "archer",
      },
      user
    )
    await associateCharacter(
      created.id,
      {
        kind: "blessing",
        definitionId: "god-1",
        tier: "Minor",
        operation: "add",
        version: 0,
      },
      user
    )
    await associateCharacter(
      created.id,
      {
        kind: "bloodline",
        definitionId: "blood-1",
        operation: "add",
        version: 1,
      },
      user
    )
    const exported = (await exportCharacter(
      created.id,
      user
    )) as unknown as CharacterImportDocument
    const imported = await importCharacter(exported, user)
    expect(imported.associations.map((a) => a.kind).sort()).toEqual([
      "blessing",
      "bloodline",
    ])
    // The v7 export carries the exact blessing tier and re-import preserves it,
    // so a god + tier link round-trips with nothing dropped to null.
    const exportedAssocs = (
      exported as {
        associations: Array<{ kind: string; tier?: string | null }>
      }
    ).associations
    expect(exportedAssocs.find((a) => a.kind === "blessing")).toMatchObject({
      tier: "Minor",
    })
    expect(
      imported.associations.find((a) => a.kind === "blessing")
    ).toMatchObject({ tier: "Minor" })
    const kinds = dbMock.store.associations
      .filter((a) => a.characterId === imported.id)
      .map((a) => a.kind)
      .sort()
    expect(kinds).toEqual(["BLESSING", "BLOODLINE"])
  })

  it("rejects a duplicate skill offer identity", async () => {
    seedRaceClass()
    addImportCatalog("skills", "skill-1", {})
    addImportCatalog("skills", "skill-2", {})
    const doc = importDoc({
      skillOffers: [
        {
          track: "class",
          level: 1,
          choiceGroup: "standard",
          options: [
            { stableId: "skill-1", nameSnapshot: "x", configSnapshot: {} },
          ],
        },
        {
          track: "class",
          level: 1,
          choiceGroup: "standard",
          options: [
            { stableId: "skill-2", nameSnapshot: "y", configSnapshot: {} },
          ],
        },
      ],
    })
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "import_duplicate_offer",
    })
  })

  it("rejects a skill offer option not in the catalog", async () => {
    seedRaceClass()
    const doc = importDoc({
      skillOffers: [
        {
          track: "class",
          level: 1,
          choiceGroup: "standard",
          options: [
            { stableId: "ghost-skill", nameSnapshot: "x", configSnapshot: {} },
          ],
        },
      ],
    })
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "import_option_missing",
    })
  })

  it("rejects a selected skill that is not one of the offer's options", async () => {
    seedRaceClass()
    addImportCatalog("skills", "skill-1", {})
    addImportCatalog("skills", "other", {})
    const doc = importDoc({
      associations: [
        { kind: "skill", definition: { kind: "skills", stableId: "skill-1" } },
      ],
      skillOffers: [
        {
          track: "class",
          level: 1,
          choiceGroup: "standard",
          selectedStableId: "skill-1",
          options: [
            { stableId: "other", nameSnapshot: "x", configSnapshot: {} },
          ],
        },
      ],
    })
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "import_selected_not_in_options",
    })
  })

  it("accepts a selected skill offer whose skill was upgraded away (no longer linked)", async () => {
    seedRaceClass()
    addImportCatalog("skills", "skill-1", {}, { name: "Skill One" })
    addImportCatalog("skills", "skill-2", {}, { name: "Skill Two" })
    // An upgrade in the same group replaced skill-1's link with skill-2, but the
    // historical offer still selects skill-1. The offer's selection must remain
    // a faithful record even though skill-1 is no longer a current association.
    const doc = importDoc({
      associations: [
        { kind: "skill", definition: { kind: "skills", stableId: "skill-2" } },
      ],
      skillOffers: [
        {
          track: "class",
          level: 1,
          choiceGroup: "standard",
          selectedStableId: "skill-1",
          options: [
            {
              stableId: "skill-1",
              nameSnapshot: "Skill One",
              configSnapshot: {},
            },
          ],
        },
      ],
    })
    const result = await importCharacter(doc, user)
    expect(result.skillOffers).toHaveLength(1)
    expect(result.skillOffers[0].selectedDefinitionId).toBe("skill-1")
  })

  it("rejects a state that over-allocates free points", async () => {
    seedRaceClass()
    const state = createInitialState("integrated", null, null)
    state.allocations = [
      { id: "a", source: "manual", at: 0, points: allEqual(1) },
    ]
    const doc = importDoc({ state })
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "invalid_import",
    })
  })

  it("rejects a non-integer allocation value", async () => {
    seedRaceClass()
    const state = createInitialState("integrated", null, null)
    state.historicalLevelAwards = [
      {
        track: "class",
        level: 1,
        definitionId: "award",
        fixed: allEqual(0),
        free: 10,
      },
    ]
    state.allocations = [
      {
        id: "a",
        source: "manual",
        at: 0,
        points: { ...allEqual(0), strength: 0.5 },
      },
    ]
    const doc = importDoc({ state })
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "invalid_import",
    })
  })

  it("rejects a backup whose identity.origin disagrees with state.race.origin", async () => {
    seedRaceClass()
    const doc = importDoc({
      identity: {
        name: "Imported",
        description: null,
        origin: "born",
        race: { stableId: "human" },
        class: { stableId: "archer" },
        profession: null,
      },
    })
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "invalid_import",
    })
  })

  it("rejects a derived-race backup whose race level is inconsistent with the tracks", async () => {
    seedRaceClass()
    const state = createInitialState("integrated", null, null)
    state.race.level = 5
    const doc = importDoc({ state })
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "invalid_import",
    })
  })

  it("preserves historical award definitionIds verbatim and remaps current track definitionIds to local stableId references", async () => {
    seedRaceClass()
    addImportCatalog(
      "professions",
      "alchemist",
      { grades: { G: { fixed: {}, free: 0 } } },
      { name: "Alchemist" }
    )
    const state = createInitialState("integrated", null, null)
    state.tracks.class.definitionId = "orig:class"
    state.tracks.profession = {
      level: 0,
      quarter: 0,
      definitionId: "orig:prof",
    }
    state.historicalLevelAwards = [
      {
        track: "class",
        level: 1,
        definitionId: "legacy:award",
        fixed: allEqual(0),
        free: 3,
      },
    ]
    const doc = importDoc({
      identity: {
        name: "Imported",
        description: null,
        origin: "integrated",
        race: { stableId: "human" },
        class: { stableId: "archer" },
        profession: { stableId: "alchemist" },
      },
      state,
    })
    const result = await importCharacter(doc, user)
    const stored = deserializeState(result.state)
    expect(stored.tracks.class.definitionId).toBe("archer:G")
    expect(stored.tracks.profession?.definitionId).toBe("alchemist:G")
    expect(stored.historicalLevelAwards[0].definitionId).toBe("legacy:award")
  })

  it("preserves the historical selectedAt of a selected skill offer", async () => {
    seedRaceClass()
    addImportCatalog("skills", "skill-1", {}, { name: "Skill One" })
    const selectedAt = new Date("2026-01-02T03:04:05.000Z")
    const doc = importDoc({
      skillOffers: [
        {
          track: "class",
          level: 1,
          choiceGroup: "standard",
          selectedStableId: "skill-1",
          selectedAt: selectedAt.toISOString(),
          options: [
            {
              stableId: "skill-1",
              nameSnapshot: "Skill One",
              configSnapshot: {},
            },
          ],
        },
      ],
    })
    await importCharacter(doc, user)
    // The read API does not expose selectedAt; inspect the persisted offer row.
    const storedOffer = dbMock.store.skillOffers.find(
      (o) => o.selectedDefinitionId != null
    )
    expect(storedOffer?.selectedAt?.getTime()).toBe(selectedAt.getTime())
  })

  it("round-trips a selected skill offer whose skill was later upgraded away", async () => {
    seedRaceClass()
    addImportCatalog(
      "skills",
      "skill-1",
      { upgradeGroup: "core", rarity: "Common" },
      { name: "Skill One" }
    )
    addImportCatalog(
      "skills",
      "skill-2",
      { upgradeGroup: "core", rarity: "Uncommon" },
      { name: "Skill Two" }
    )

    const src = await createCharacter(
      {
        name: "Upgrader",
        origin: "integrated",
        raceId: "human",
        classId: "archer",
      },
      user
    )

    // Offer the level-1 pick and select skill-1.
    dbMock.store.skillOffers.push({
      id: "off-1",
      characterId: src.id,
      track: "class",
      level: 1,
      choiceGroup: "standard",
      generation: 0,
      canceledAt: null,
      selectedDefinitionId: null,
      offeredAt: new Date("2026-01-01T00:00:00.000Z"),
      selectedAt: null,
    })
    dbMock.store.skillOfferOptions.push({
      id: "opt-1",
      offerId: "off-1",
      definitionId: "skill-1",
      nameSnapshot: "Skill One",
      configSnapshot: {},
    })
    await skillCharacter(
      src.id,
      {
        operation: "select",
        offerId: "off-1",
        definitionId: "skill-1",
        version: 0,
      },
      user
    )

    // Offer the level-2 pick and select skill-2 (same upgrade group). Selecting it
    // replaces the skill-1 link, so only skill-2 remains as an association.
    dbMock.store.skillOffers.push({
      id: "off-2",
      characterId: src.id,
      track: "class",
      level: 2,
      choiceGroup: "standard",
      generation: 0,
      canceledAt: null,
      selectedDefinitionId: null,
      offeredAt: new Date("2026-01-02T00:00:00.000Z"),
      selectedAt: null,
    })
    dbMock.store.skillOfferOptions.push({
      id: "opt-2",
      offerId: "off-2",
      definitionId: "skill-2",
      nameSnapshot: "Skill Two",
      configSnapshot: {},
    })
    await skillCharacter(
      src.id,
      {
        operation: "select",
        offerId: "off-2",
        definitionId: "skill-2",
        version: 1,
      },
      user
    )

    // The exported document carries only skill-2 as a live association, yet the
    // historical level-1 offer still selects skill-1. Import must preserve it.
    const doc = (await exportCharacter(
      src.id,
      user
    )) as unknown as CharacterImportDocument
    expect(doc.associations).toHaveLength(1)
    expect(doc.associations[0].definition.stableId).toBe("skill-2")
    const imported = await importCharacter(doc, user)
    const levelOne = imported.skillOffers.find((o) => o.level === 1)
    expect(levelOne?.selectedDefinitionId).toBe("skill-1")
  })

  // A supplied skill-offer `canceledAt` must be a real timestamp. An invalid value
  // is rejected with 400 invalid_import BEFORE any write - it is never silently
  // restamped to "now", so a canceled offer's cancellation instant is preserved.
  it.each(["not-a-date", ""])(
    "rejects a v6 backup with an invalid skill-offer canceledAt %j (no write)",
    async (bad) => {
      seedRaceClass()
      const doc = v6Doc({
        skillOffers: [
          {
            track: "class",
            level: 1,
            choiceGroup: "standard",
            generation: 0,
            canceledAt: bad,
            options: [],
          },
        ],
      })
      await expect(importCharacter(doc, user)).rejects.toMatchObject({
        status: 400,
        code: "invalid_import",
      })
      expect(dbMock.store.characters.size).toBe(0)
      expect(dbMock.store.skillOffers).toHaveLength(0)
    }
  )

  it("rejects a legacy v3 backup with an invalid skill-offer canceledAt (no write)", async () => {
    seedRaceClass()
    const doc = importDoc({
      skillOffers: [
        {
          track: "class",
          level: 1,
          choiceGroup: "standard",
          canceledAt: "not-a-date",
          options: [],
        },
      ],
    })
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "invalid_import",
    })
    expect(dbMock.store.characters.size).toBe(0)
    expect(dbMock.store.skillOffers).toHaveLength(0)
  })

  it("preserves a canceled offer's exact ISO canceledAt through v6 import and re-export", async () => {
    seedRaceClass()
    addImportCatalog("skills", "skill-1", {}, { name: "Skill One" })
    const canceledAt = new Date("2026-03-03T12:00:00.000Z")
    const doc = v6Doc({
      skillOffers: [
        {
          track: "class",
          level: 1,
          choiceGroup: "standard",
          generation: 1,
          canceledAt: canceledAt.toISOString(),
          offeredAt: "2026-03-03T00:00:00.000Z",
          options: [
            {
              stableId: "skill-1",
              nameSnapshot: "Skill One",
              configSnapshot: {},
            },
          ],
        },
      ],
    })
    const imported = await importCharacter(doc, user)
    const stored = dbMock.store.skillOffers.find(
      (o) => o.characterId === imported.id
    )
    expect(stored?.canceledAt?.getTime()).toBe(canceledAt.getTime())
    // Re-export reproduces the exact original ISO instant (never a "now" restamp).
    const reexported = (await exportCharacter(
      imported.id,
      user
    )) as unknown as CharacterImportDocument
    expect(
      (reexported.skillOffers[0] as { canceledAt: string | null }).canceledAt
    ).toBe(canceledAt.toISOString())
  })

  it("rejects a state missing the required class track", async () => {
    seedRaceClass()
    const state = createInitialState("integrated", null, null)
    delete state.tracks["class"]
    const doc = importDoc({ state })
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "invalid_import",
    })
  })

  it("rejects a profession track present without a profession identity", async () => {
    seedRaceClass()
    const state = createInitialState("integrated", null, null)
    state.tracks.profession = { level: 0, quarter: 0, definitionId: "" }
    const doc = importDoc({ state })
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "invalid_import",
    })
  })

  it("rejects a profession identity declared without a profession track", async () => {
    seedRaceClass()
    addImportCatalog(
      "professions",
      "alchemist",
      { grades: { G: { fixed: {}, free: 0 } } },
      { name: "Alchemist" }
    )
    const doc = importDoc({
      identity: {
        name: "Imported",
        description: null,
        origin: "integrated",
        race: { stableId: "human" },
        class: { stableId: "archer" },
        profession: { stableId: "alchemist" },
      },
    })
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "invalid_import",
    })
  })

  it("rejects an unknown track key in the imported state", async () => {
    seedRaceClass()
    const state = createInitialState("integrated", null, null)
    state.tracks["extra"] = { level: 0, quarter: 0, definitionId: "" }
    const doc = importDoc({ state })
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "invalid_import",
    })
  })

  it("rejects a class catalog that defines no track level-up (not advanceable)", async () => {
    addImportCatalog(
      "races",
      "human",
      {
        raceDefinitions: {
          G: { id: "human:G", perLevel: allEqual(1), freePerLevel: 5 },
        },
      },
      { name: "Human" }
    )
    addImportCatalog("classes", "archer", { grades: {} }, { name: "Archer" })
    await expect(importCharacter(importDoc(), user)).rejects.toMatchObject({
      status: 400,
      code: "invalid_import",
    })
  })

  it("maps the track definitionId by the chosen-grade fallback and remains advanceable", async () => {
    // The class catalog defines only grade F, but the imported character's race
    // grade is G (integrated). The importer must store the FALLBACK definition
    // (`archer:F`), not a naive `archer:G`, so advancing still works.
    addImportCatalog(
      "races",
      "human",
      {
        raceDefinitions: {
          G: { id: "human:G", perLevel: allEqual(1), freePerLevel: 5 },
        },
      },
      { name: "Human" }
    )
    addImportCatalog(
      "classes",
      "archer",
      { grades: { F: { fixed: {}, free: 0 } } },
      { name: "Archer" }
    )
    const result = await importCharacter(importDoc(), user)
    const stored = deserializeState(result.state)
    expect(stored.tracks.class.definitionId).toBe("archer:F")
    const advanced = await advanceCharacter(
      result.id,
      { track: "class", version: 0 },
      user
    )
    expect(advanced.character.version).toBe(1)
  })

  it("rejects a malformed track level/quarter with invalid_import", async () => {
    seedRaceClass()
    const doc = importDoc()
    const badState = {
      ...(doc.state as Record<string, unknown>),
      tracks: { class: { level: -1, quarter: 0, definitionId: "" } },
    }
    await expect(
      importCharacter({ ...doc, state: badState as never }, user)
    ).rejects.toMatchObject({ status: 400, code: "invalid_import" })
  })

  it("rejects a graded class track already past its next-grade entry threshold", async () => {
    seedRaceClass()
    const state = createInitialState("integrated", null, null)
    // A graded F class at level 26 would fail its first level-up (E enters at 25),
    // so the import must reject before any write.
    state.tracks.class = {
      level: 26,
      quarter: 0,
      definitionId: "archer:F",
      grade: "F",
    }
    state.race.level = Math.floor(26 / 2) // derived floorHalfAvg, no profession
    await expect(
      importCharacter(importDoc({ state }), user)
    ).rejects.toMatchObject({ status: 400, code: "invalid_import" })
  })

  it("permits a graded class track exactly at the next-grade entry threshold (F25)", async () => {
    seedRaceClass()
    const state = createInitialState("integrated", null, null)
    state.tracks.class = {
      level: 25,
      quarter: 0,
      definitionId: "archer:F",
      grade: "F",
    }
    state.race.level = Math.floor(25 / 2) // 12
    const result = await importCharacter(importDoc({ state }), user)
    const stored = deserializeState(result.state)
    expect(stored.tracks.class.level).toBe(25)
    expect(stored.tracks.class.grade).toBe("F")
  })

  it("rejects a graded profession track already past its next-grade entry threshold", async () => {
    seedRaceClass()
    addImportCatalog(
      "professions",
      "alchemist",
      { grades: { F: { fixed: {}, free: 0 } } },
      { name: "Alchemist" }
    )
    const state = createInitialState("integrated", null, null)
    state.tracks.profession = {
      level: 26,
      quarter: 0,
      definitionId: "alchemist:F",
      grade: "F",
    }
    state.race.level = Math.floor((0 + 26) / 2) // 13
    const doc = importDoc({
      identity: {
        ...importDoc().identity,
        profession: { stableId: "alchemist" },
      },
      state,
    })
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "invalid_import",
    })
  })

  it("permits a graded profession track exactly at the next-grade entry threshold (F25)", async () => {
    seedRaceClass()
    addImportCatalog(
      "professions",
      "alchemist",
      { grades: { F: { fixed: {}, free: 0 } } },
      { name: "Alchemist" }
    )
    const state = createInitialState("integrated", null, null)
    state.tracks.profession = {
      level: 25,
      quarter: 0,
      definitionId: "alchemist:F",
      grade: "F",
    }
    state.race.level = Math.floor((0 + 25) / 2) // 12
    const doc = importDoc({
      identity: {
        ...importDoc().identity,
        profession: { stableId: "alchemist" },
      },
      state,
    })
    const result = await importCharacter(doc, user)
    const stored = deserializeState(result.state)
    expect(stored.tracks.profession.level).toBe(25)
    expect(stored.tracks.profession.grade).toBe("F")
  })

  it("rejects a graded track in the final grade above its band max", async () => {
    seedRaceClass()
    addImportCatalog(
      "classes",
      "mage",
      { grades: { S: { fixed: {}, free: 0 } } },
      { name: "Mage" }
    )
    const state = createInitialState("integrated", null, null)
    state.tracks.class = {
      level: 1000,
      quarter: 0,
      definitionId: "mage:S",
      grade: "S",
    }
    state.race.level = Math.floor(1000 / 2) // 500
    const doc = importDoc({
      identity: { ...importDoc().identity, class: { stableId: "mage" } },
      state,
    })
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "invalid_import",
    })
  })

  it("permits a graded track in the final grade at exactly its band max", async () => {
    seedRaceClass()
    addImportCatalog(
      "classes",
      "mage",
      { grades: { S: { fixed: {}, free: 0 } } },
      { name: "Mage" }
    )
    const state = createInitialState("integrated", null, null)
    state.tracks.class = {
      level: 999,
      quarter: 0,
      definitionId: "mage:S",
      grade: "S",
    }
    state.race.level = Math.floor(999 / 2) // 499
    const doc = importDoc({
      identity: { ...importDoc().identity, class: { stableId: "mage" } },
      state,
    })
    const result = await importCharacter(doc, user)
    const stored = deserializeState(result.state)
    expect(stored.tracks.class.level).toBe(999)
    expect(stored.tracks.class.grade).toBe("S")
  })

  it("creates a new character and never overwrites an existing one", async () => {
    seedRaceClass()
    const existing = dbMock.store.addCharacter({
      id: "chr-existing",
      ownerId: user.id,
      name: "Existing",
      state: serializeState(createInitialState("integrated", null, null)),
      version: 0,
    })
    const doc = importDoc()
    const result = await importCharacter(doc, user)
    expect(result.id).not.toBe(existing.id)
    expect(dbMock.store.characters.size).toBe(2)
    expect(dbMock.store.characters.get(existing.id)?.name).toBe("Existing")
  })

  it("rejects importing a ranked title whose backup race grade is below minRaceGrade (import_grade_blocked)", async () => {
    seedRaceClass()
    addImportCatalog(
      "titles",
      "dp-6",
      {
        upgradeGroup: "dungeon-pioneer",
        improvement: {
          seriesId: "dungeon-pioneer",
          rank: 6,
          minRaceGrade: "D",
        },
        flat: allEqual(24),
      },
      { name: "Dungeon Pioneer VI" }
    )
    // The backup's race grade is E, below the title's D requirement.
    const state = createInitialState("integrated", null, null)
    state.race = { ...state.race, grade: "E" }
    const doc = importDoc({
      state,
      associations: [
        { kind: "title", definition: { kind: "titles", stableId: "dp-6" } },
      ],
    })
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "import_grade_blocked",
    })
    // Nothing was written: the import rolled back the whole character.
    expect(dbMock.store.characters.size).toBe(0)
    expect(dbMock.store.associations).toHaveLength(0)
  })

  it("imports a ranked title at rank > 1 without any prior rank history", async () => {
    seedRaceClass()
    addImportCatalog(
      "titles",
      "dp-5",
      {
        upgradeGroup: "dungeon-pioneer",
        improvement: {
          seriesId: "dungeon-pioneer",
          rank: 5,
          minRaceGrade: "E",
        },
        flat: allEqual(15),
      },
      { name: "Dungeon Pioneer V" }
    )
    // A backup is a trusted association snapshot: rank 5 needs no ranks 1-4.
    const state = createInitialState("integrated", null, null)
    state.race = { ...state.race, grade: "D" }
    const doc = importDoc({
      state,
      associations: [
        { kind: "title", definition: { kind: "titles", stableId: "dp-5" } },
      ],
    })
    const result = await importCharacter(doc, user)
    expect(result.associations).toHaveLength(1)
    expect(result.associations[0].definitionId).toBe("dp-5")
    expect(result.associations[0].improvement).toEqual({
      seriesId: "dungeon-pioneer",
      rank: 5,
      minRaceGrade: "E",
    })
  })

  it("round-trips a ranked title: export carries the association and re-import restores the improvement", async () => {
    seedRaceClass()
    addImportCatalog(
      "titles",
      "dp-3",
      {
        upgradeGroup: "dungeon-pioneer",
        improvement: {
          seriesId: "dungeon-pioneer",
          rank: 3,
          minRaceGrade: "E",
        },
        flat: allEqual(9),
      },
      { name: "Dungeon Pioneer III" }
    )
    const state = createInitialState("integrated", null, null)
    state.race = { ...state.race, grade: "D" }
    dbMock.store.addCharacter({
      id: "chr-rank",
      ownerId: user.id,
      name: "Ranked",
      raceId: "human",
      classId: "archer",
      state: serializeState(state),
      version: 0,
    })
    dbMock.store.addAssociation({
      characterId: "chr-rank",
      definitionId: "dp-3",
      kind: "TITLE",
    })

    const portable = (await exportCharacter(
      "chr-rank",
      user
    )) as CharacterImportDocument
    const titleAssoc = portable.associations.find((a) => a.kind === "title")
    expect(titleAssoc).toBeDefined()

    const imported = await importCharacter(portable, user)
    expect(imported.associations).toHaveLength(1)
    expect(imported.associations[0].definitionId).toBe("dp-3")
    expect(imported.associations[0].improvement).toEqual({
      seriesId: "dungeon-pioneer",
      rank: 3,
      minRaceGrade: "E",
    })
  })

  describe("trusted-backup v4 import (inventory + grandfathered marker)", () => {
    it("imports a v4 backup with owned stock and an equipment association, preserving the marker", async () => {
      seedRaceClass()
      addImportCatalog(
        "equipment",
        "gear-1",
        { slot: "head" },
        { name: "Helm" }
      )
      addImportCatalog(
        "items",
        "consum-1",
        { type: "permanent", amount: { strength: 1 } },
        { name: "Ration" }
      )

      const doc = v4Doc({
        associations: [
          {
            kind: "equipment",
            definition: { kind: "equipment", stableId: "gear-1" },
            legacyUnowned: false,
          },
        ],
        inventory: [
          {
            definition: { kind: "equipment", stableId: "gear-1" },
            quantity: 2,
          },
          {
            definition: { kind: "items", stableId: "consum-1" },
            quantity: 5,
          },
        ],
      })
      const result = await importCharacter(doc, user)
      expect(result.imported).toBe(true)
      expect(result.associations).toHaveLength(1)
      const storedAssoc = dbMock.store.associations.find(
        (a) => a.characterId === result.id
      )
      expect(storedAssoc?.legacyUnowned).toBe(false)
      const storedInv = dbMock.store.inventory.filter(
        (i) => i.characterId === result.id
      )
      expect(storedInv).toHaveLength(2)
      expect(storedInv.find((i) => i.definitionId === "gear-1")?.quantity).toBe(
        2
      )
      expect(
        storedInv.find((i) => i.definitionId === "consum-1")?.quantity
      ).toBe(5)
      // The returned detail exposes imported inventory rows.
      expect(result.inventory).toHaveLength(2)
      expect(
        result.inventory.find((i) => i.definitionId === "gear-1")?.quantity
      ).toBe(2)
    })

    it("preserves a grandfathered equipment link that owns zero stock", async () => {
      seedRaceClass()
      addImportCatalog(
        "equipment",
        "gear-1",
        { slot: "head" },
        { name: "Helm" }
      )
      const doc = v4Doc({
        associations: [
          {
            kind: "equipment",
            definition: { kind: "equipment", stableId: "gear-1" },
            legacyUnowned: true,
          },
        ],
        inventory: [],
      })
      const result = await importCharacter(doc, user)
      expect(result.associations).toHaveLength(1)
      const storedAssoc = dbMock.store.associations.find(
        (a) => a.characterId === result.id
      )
      expect(storedAssoc?.legacyUnowned).toBe(true)
      expect(result.inventory).toHaveLength(0)
    })

    it("rejects a non-grandfathered equipment link that owns no stock", async () => {
      seedRaceClass()
      addImportCatalog(
        "equipment",
        "gear-1",
        { slot: "head" },
        { name: "Helm" }
      )
      const before = dbMock.store.characters.size
      const doc = v4Doc({
        associations: [
          {
            kind: "equipment",
            definition: { kind: "equipment", stableId: "gear-1" },
            legacyUnowned: false,
          },
        ],
        inventory: [],
      })
      await expect(importCharacter(doc, user)).rejects.toMatchObject({
        status: 400,
        code: "import_stock_missing",
      })
      // Full rollback: no character row, no progression events.
      expect(dbMock.store.characters.size).toBe(before)
      expect(dbMock.store.events).toHaveLength(0)
    })

    it("rejects inventory that references a missing catalog definition", async () => {
      seedRaceClass()
      const before = dbMock.store.characters.size
      const doc = v4Doc({
        inventory: [
          { definition: { kind: "equipment", stableId: "ghost" }, quantity: 1 },
        ],
      })
      await expect(importCharacter(doc, user)).rejects.toMatchObject({
        status: 400,
        code: "import_stock_missing",
      })
      expect(dbMock.store.characters.size).toBe(before)
      expect(dbMock.store.events).toHaveLength(0)
    })

    it("rejects duplicate inventory references for the same definition", async () => {
      seedRaceClass()
      addImportCatalog(
        "equipment",
        "gear-1",
        { slot: "head" },
        { name: "Helm" }
      )
      const before = dbMock.store.characters.size
      const doc = v4Doc({
        inventory: [
          {
            definition: { kind: "equipment", stableId: "gear-1" },
            quantity: 1,
          },
          {
            definition: { kind: "equipment", stableId: "gear-1" },
            quantity: 2,
          },
        ],
      })
      await expect(importCharacter(doc, user)).rejects.toMatchObject({
        status: 400,
        code: "import_duplicate_stock",
      })
      expect(dbMock.store.characters.size).toBe(before)
      expect(dbMock.store.events).toHaveLength(0)
    })

    it("rejects legacyUnowned:true on a non-equipment association", async () => {
      seedRaceClass()
      addImportCatalog(
        "titles",
        "title-1",
        { upgradeGroup: "hero" },
        { name: "Heroic" }
      )
      const before = dbMock.store.characters.size
      const doc = v4Doc({
        associations: [
          {
            kind: "title",
            definition: { kind: "titles", stableId: "title-1" },
            // TypeScript's v4 non-equipment association only admits false; a `true`
            // is exercised at runtime to prove the importer rejects it.
            legacyUnowned: true as false,
          },
        ],
      })
      await expect(importCharacter(doc, user)).rejects.toMatchObject({
        status: 400,
        code: "import_legacy_unowned_non_equipment",
      })
      expect(dbMock.store.characters.size).toBe(before)
      expect(dbMock.store.events).toHaveLength(0)
    })

    it("allows archived catalog stock to be imported inert", async () => {
      seedRaceClass()
      addImportCatalog(
        "equipment",
        "gear-1",
        { slot: "head" },
        { name: "Helm", archived: true }
      )
      const doc = v4Doc({
        associations: [
          {
            kind: "equipment",
            definition: { kind: "equipment", stableId: "gear-1" },
            legacyUnowned: false,
          },
        ],
        inventory: [
          {
            definition: { kind: "equipment", stableId: "gear-1" },
            quantity: 1,
          },
        ],
      })
      const result = await importCharacter(doc, user)
      expect(result.associations).toHaveLength(1)
      expect(result.inventory).toHaveLength(1)
    })

    it("records the backup schema and stock count in the import marker", async () => {
      seedRaceClass()
      addImportCatalog(
        "equipment",
        "gear-1",
        { slot: "head" },
        { name: "Helm" }
      )
      const doc = v4Doc({
        associations: [
          {
            kind: "equipment",
            definition: { kind: "equipment", stableId: "gear-1" },
            legacyUnowned: false,
          },
        ],
        inventory: [
          {
            definition: { kind: "equipment", stableId: "gear-1" },
            quantity: 7,
          },
        ],
      })
      const result = await importCharacter(doc, user)
      const importEvent = dbMock.store.events.find(
        (e) => e.characterId === result.id && e.kind === "import"
      )
      const payload = importEvent!.payload as Record<string, unknown>
      expect(payload.backupSchema).toBe("primal-character/4")
      expect(payload.inventoryCount).toBe(1)
    })

    it("round-trips a v4 backup: equipped stock and items survive export and re-import", async () => {
      seedRaceClass()
      addImportCatalog(
        "equipment",
        "gear-1",
        { slot: "head" },
        { name: "Helm" }
      )
      addImportCatalog(
        "items",
        "consum-1",
        { type: "permanent", amount: { strength: 1 } },
        { name: "Ration" }
      )
      const state = createInitialState("integrated", null, null)
      dbMock.store.addCharacter({
        id: "chr-r",
        ownerId: user.id,
        name: "Round",
        raceId: "human",
        classId: "archer",
        state: serializeState(state),
      })
      dbMock.store.addInventoryItem({
        characterId: "chr-r",
        definitionId: "gear-1",
        quantity: 3,
      })
      dbMock.store.addInventoryItem({
        characterId: "chr-r",
        definitionId: "consum-1",
        quantity: 4,
      })
      dbMock.store.addAssociation({
        characterId: "chr-r",
        definitionId: "gear-1",
        kind: "EQUIPMENT",
      })

      const portable = (await exportCharacter(
        "chr-r",
        user
      )) as CharacterImportDocument
      expect(portable.schema).toBe("primal-character/7")
      const inv = (portable as { inventory: Array<{ quantity: number }> })
        .inventory
      expect(inv).toHaveLength(2)
      const eqAssoc = (
        portable as {
          associations: Array<{ kind: string; legacyUnowned?: boolean }>
        }
      ).associations.find((a) => a.kind === "equipment")
      expect(eqAssoc?.legacyUnowned).toBe(false)

      const imported = await importCharacter(portable, user)
      expect(imported.inventory).toHaveLength(2)
      expect(
        imported.inventory.find((i) => i.definitionId === "gear-1")?.quantity
      ).toBe(3)
      expect(
        imported.inventory.find((i) => i.definitionId === "consum-1")?.quantity
      ).toBe(4)
      const storedAssoc = dbMock.store.associations.find(
        (a) => a.characterId === imported.id
      )
      expect(storedAssoc?.legacyUnowned).toBe(false)
    })

    it("recovers a Ring 2 position from a v4 backup definition.config.slot snapshot when the current catalog slot is Ring", async () => {
      seedRaceClass()
      addImportCatalog(
        "equipment",
        "ring-snap",
        { slot: "Ring" },
        { name: "Ring Snap" }
      )
      const doc = v4Doc({
        associations: [
          {
            kind: "equipment",
            definition: {
              kind: "equipment",
              stableId: "ring-snap",
              config: { slot: "Ring 2" },
            },
            legacyUnowned: true,
          },
        ],
        inventory: [],
      })
      const result = await importCharacter(doc, user)
      expect(result.associations).toHaveLength(1)
      expect(result.associations[0]).toMatchObject({
        kind: "equipment",
        slot: "Ring",
        equipmentPosition: "Ring 2",
      })
      const stored = dbMock.store.associations.find(
        (a) => a.characterId === result.id
      )
      expect(stored?.equipmentPosition).toBe("Ring 2")
      // The recovered position survives a v5 export.
      const exported = (await exportCharacter(
        result.id,
        user
      )) as CharacterImportDocument
      const eq = (
        exported.associations as Array<{
          kind: string
          equipmentPosition?: string | null
        }>
      ).find((a) => a.kind === "equipment")
      expect(eq?.equipmentPosition).toBe("Ring 2")
    })
  })

  it("recovers a Ring 2 position from a v3 backup definition.config.slot snapshot when the current catalog slot is Ring", async () => {
    seedRaceClass()
    addImportCatalog(
      "equipment",
      "ring-snap",
      { slot: "Ring" },
      { name: "Ring Snap" }
    )
    const doc = importDoc({
      associations: [
        {
          kind: "equipment",
          definition: {
            kind: "equipment",
            stableId: "ring-snap",
            config: { slot: "Ring 2" },
          },
        },
      ],
    })
    const result = await importCharacter(doc, user)
    expect(result.associations).toHaveLength(1)
    expect(result.associations[0]).toMatchObject({
      kind: "equipment",
      slot: "Ring",
      equipmentPosition: "Ring 2",
    })
    const stored = dbMock.store.associations.find(
      (a) => a.characterId === result.id
    )
    expect(stored?.equipmentPosition).toBe("Ring 2")
    // The recovered position survives a v5 export.
    const exported = (await exportCharacter(
      result.id,
      user
    )) as CharacterImportDocument
    const eq = (
      exported.associations as Array<{
        kind: string
        equipmentPosition?: string | null
      }>
    ).find((a) => a.kind === "equipment")
    expect(eq?.equipmentPosition).toBe("Ring 2")
  })

  it("rejects a v3 Ring link with no position and no definition.config snapshot (import_ring_position_required)", async () => {
    seedRaceClass()
    addImportCatalog(
      "equipment",
      "ring-snap",
      { slot: "Ring" },
      { name: "Ring Snap" }
    )
    const doc = importDoc({
      associations: [
        {
          kind: "equipment",
          definition: { kind: "equipment", stableId: "ring-snap" },
        },
      ],
    })
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "import_ring_position_required",
    })
  })

  it("rejects a v3 Ring link whose definition.config.slot snapshot is a non-ring slot (import_ring_position_required)", async () => {
    seedRaceClass()
    addImportCatalog(
      "equipment",
      "ring-snap",
      { slot: "Ring" },
      { name: "Ring Snap" }
    )
    const doc = importDoc({
      associations: [
        {
          kind: "equipment",
          definition: {
            kind: "equipment",
            stableId: "ring-snap",
            config: { slot: "Head" },
          },
        },
      ],
    })
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "import_ring_position_required",
    })
  })

  it("v5 uses the explicit position and never trusts the definition.config.slot snapshot", async () => {
    seedRaceClass()
    addImportCatalog(
      "equipment",
      "ring-snap",
      { slot: "Ring" },
      { name: "Ring Snap" }
    )
    // A v5 document carries no per-link equipmentPosition, but DOES carry a
    // definition.config.slot snapshot naming Ring 2. The v5 import must NOT derive
    // from the snapshot - only the explicit position counts - so it is rejected.
    const base = v4Doc({
      associations: [
        {
          kind: "equipment",
          definition: {
            kind: "equipment",
            stableId: "ring-snap",
            config: { slot: "Ring 2" },
          },
          legacyUnowned: true,
        },
      ],
      inventory: [],
    })
    const doc = {
      ...base,
      schema: IMPORT_SCHEMA_V5,
    } as CharacterImportDocument
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "import_ring_position_required",
    })
  })

  it("rejects a v5 backup whose equipment link omits equipmentPosition at the schema layer (Zod 400, no write)", () => {
    // The v5 equipment schema REQUIRES equipmentPosition; a backup that omits it
    // must fail Zod validation (the route maps this to a 400) before any write.
    // The rest of the document is a valid v5 shape, so the rejection is purely the
    // missing per-link position.
    const doc = {
      ...v4Doc({ inventory: [] }),
      schema: IMPORT_SCHEMA_V5,
      associations: [
        {
          kind: "equipment",
          definition: { kind: "equipment", stableId: "ring-1" },
          legacyUnowned: true,
        },
      ],
    } as unknown as CharacterImportDocument
    const parsed = characterImportDocumentSchema.safeParse(doc)
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((i) => i.path.includes("equipmentPosition"))
      ).toBe(true)
    }
  })

  it("rejects a v5 Ring link with an explicit null position even when the current catalog slot is legacy Ring 1 (import_ring_position_required)", async () => {
    seedRaceClass()
    addImportCatalog(
      "equipment",
      "ring-legacy-1",
      { slot: "Ring 1" },
      { name: "Legacy Band" }
    )
    // v5 must never fall back to the CURRENT catalog's legacy Ring 1 slot: an
    // explicit null in the backup means "no position", so it is rejected.
    const doc = {
      ...v4Doc({ inventory: [] }),
      schema: IMPORT_SCHEMA_V5,
      associations: [
        {
          kind: "equipment",
          definition: { kind: "equipment", stableId: "ring-legacy-1" },
          legacyUnowned: true,
          equipmentPosition: null,
        },
      ],
    } as unknown as CharacterImportDocument
    await expect(importCharacter(doc, user)).rejects.toMatchObject({
      status: 400,
      code: "import_ring_position_required",
    })
  })

  it("imports a v5 non-ring equipment link with an explicit null position (never a category mismatch)", async () => {
    seedRaceClass()
    addImportCatalog("equipment", "helm-1", { slot: "Head" }, { name: "Helm" })
    const doc = {
      ...v4Doc({ inventory: [] }),
      schema: IMPORT_SCHEMA_V5,
      associations: [
        {
          kind: "equipment",
          definition: { kind: "equipment", stableId: "helm-1" },
          legacyUnowned: true,
          equipmentPosition: null,
        },
      ],
    } as unknown as CharacterImportDocument
    const result = await importCharacter(doc, user)
    expect(result.associations).toHaveLength(1)
    expect(result.associations[0]).toMatchObject({
      kind: "equipment",
      slot: "Head",
    })
    // A non-ring link stores null position in the DB.
    const stored = dbMock.store.associations.find(
      (a) => a.characterId === result.id
    )
    expect(stored?.equipmentPosition).toBeNull()
  })

  it("exporting a v5 non-ring equipment link serializes equipmentPosition:null and survives a real JSON round-trip + schema parse", async () => {
    seedRaceClass()
    addImportCatalog("equipment", "helm-1", { slot: "Head" }, { name: "Helm" })
    addImportCatalog("equipment", "ring-1", { slot: "Ring" }, { name: "Band" })
    const state = createInitialState("integrated", null, null)
    dbMock.store.addCharacter({
      id: "chr-nr",
      ownerId: user.id,
      name: "Non-ring",
      raceId: "human",
      classId: "archer",
      state: serializeState(state),
    })
    // Owned stock for the non-ring helmet (non-grandfathered), plus a
    // grandfathered ring that owns no stock.
    dbMock.store.addInventoryItem({
      characterId: "chr-nr",
      definitionId: "helm-1",
      quantity: 2,
    })
    dbMock.store.addAssociation({
      characterId: "chr-nr",
      definitionId: "helm-1",
      kind: "EQUIPMENT",
      legacyUnowned: false,
    })
    dbMock.store.addAssociation({
      characterId: "chr-nr",
      definitionId: "ring-1",
      kind: "EQUIPMENT",
      legacyUnowned: true,
      equipmentPosition: "Ring 2",
    })

    const portable = (await exportCharacter(
      "chr-nr",
      user
    )) as CharacterImportDocument
    expect(portable.schema).toBe("primal-character/7")

    // A real wire round-trip. JSON.stringify drops undefined values, which is what
    // used to delete equipmentPosition from a non-ring link and make the strict v5
    // schema reject the backup. The position must now serialize as explicit null.
    const wire = JSON.parse(JSON.stringify(portable)) as CharacterImportDocument
    const parsed = characterImportDocumentSchema.parse(wire)
    const eqAssocs = (
      parsed.associations as Array<{
        kind: string
        equipmentPosition?: string | null
        definition: { stableId: string }
      }>
    ).filter((a) => a.kind === "equipment")
    const helm = eqAssocs.find((a) => a.definition.stableId === "helm-1")
    expect(helm?.equipmentPosition).toBeNull()
    const ring = eqAssocs.find((a) => a.definition.stableId === "ring-1")
    expect(ring?.equipmentPosition).toBe("Ring 2")

    // The parsed backup imports with stock and grandfathered markers preserved and
    // the ring position unchanged.
    const imported = await importCharacter(wire, user)
    expect(imported.associations).toHaveLength(2)
    const storedHelm = dbMock.store.associations.find(
      (a) => a.characterId === imported.id && a.definitionId === "helm-1"
    )
    expect(storedHelm?.legacyUnowned).toBe(false)
    expect(storedHelm?.equipmentPosition).toBeNull()
    const storedRing = dbMock.store.associations.find(
      (a) => a.characterId === imported.id && a.definitionId === "ring-1"
    )
    expect(storedRing?.legacyUnowned).toBe(true)
    expect(storedRing?.equipmentPosition).toBe("Ring 2")
    expect(
      imported.inventory.find((i) => i.definitionId === "helm-1")?.quantity
    ).toBe(2)
    expect(
      imported.inventory.find((i) => i.definitionId === "ring-1")
    ).toBeUndefined()
  })
})

describe("catalog race raceType enforcement", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  it("creates a race with an explicit raceType", async () => {
    const item = await createCatalogItem("races", {
      stableId: "wyrm",
      name: "Wyrm",
      config: {
        raceType: "monster",
        naturalGrade: "F",
        raceDefinitions: {
          F: { id: "wyrm:F", perLevel: { strength: 1 }, freePerLevel: 1 },
        },
      },
    })
    expect(item.config).toMatchObject({ raceType: "monster" })
  })

  it("rejects creating a race without raceType (legacy config)", async () => {
    await expect(
      createCatalogItem("races", {
        stableId: "wyrm",
        name: "Wyrm",
        config: {
          naturalGrade: "F",
          raceDefinitions: {
            F: { id: "wyrm:F", perLevel: { strength: 1 }, freePerLevel: 1 },
          },
        },
      })
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("rejects creating a race with an invalid raceType", async () => {
    await expect(
      createCatalogItem("races", {
        stableId: "wyrm",
        name: "Wyrm",
        config: { raceType: "humanoid", naturalGrade: "F" },
      })
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("allows a metadata-only PATCH on a legacy race (config unchanged)", async () => {
    dbMock.store.addCatalog({
      id: "race-legacy",
      kind: "races",
      stableId: "wyrm",
      name: "Wyrm",
      config: {
        naturalGrade: "F",
        raceDefinitions: {
          F: { id: "wyrm:F", perLevel: { strength: 1 }, freePerLevel: 1 },
        },
      },
    })
    const item = await updateCatalogItem("races", "race-legacy", {
      name: "Renamed Wyrm",
    })
    expect(item.name).toBe("Renamed Wyrm")
    // The legacy config is preserved untouched.
    expect((item.config as Record<string, unknown>).raceType).toBeUndefined()
    expect((item.config as Record<string, unknown>).naturalGrade).toBe("F")
  })

  it("requires raceType on a config-changing PATCH of a legacy race that never declared one", async () => {
    dbMock.store.addCatalog({
      id: "race-legacy",
      kind: "races",
      stableId: "wyrm",
      name: "Wyrm",
      config: {
        naturalGrade: "F",
        raceDefinitions: {
          F: { id: "wyrm:F", perLevel: { strength: 1 }, freePerLevel: 1 },
        },
      },
    })
    await expect(
      updateCatalogItem("races", "race-legacy", {
        config: { naturalGrade: "G" },
      })
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    // The update never applied - the row is unchanged.
    expect(
      (
        dbMock.store.catalog.get("race-legacy")!.config as Record<
          string,
          unknown
        >
      ).naturalGrade
    ).toBe("F")
  })

  it("preserves an existing explicit raceType when a config-changing PATCH omits it", async () => {
    dbMock.store.addCatalog({
      id: "race-m",
      kind: "races",
      stableId: "wyrm",
      name: "Wyrm",
      config: {
        raceType: "monster",
        naturalGrade: "F",
        raceDefinitions: {
          F: { id: "wyrm:F", perLevel: { strength: 1 }, freePerLevel: 1 },
        },
      },
    })
    const item = await updateCatalogItem("races", "race-m", {
      config: { naturalGrade: "G" },
    })
    // The existing explicit raceType is preserved into the new config.
    expect(item.config).toMatchObject({
      raceType: "monster",
      naturalGrade: "G",
    })
  })

  it("rejects a config-changing PATCH with an invalid raceType", async () => {
    dbMock.store.addCatalog({
      id: "race-m",
      kind: "races",
      stableId: "wyrm",
      name: "Wyrm",
      config: {
        raceType: "monster",
        naturalGrade: "F",
        raceDefinitions: {
          F: { id: "wyrm:F", perLevel: { strength: 1 }, freePerLevel: 1 },
        },
      },
    })
    await expect(
      updateCatalogItem("races", "race-m", {
        config: { raceType: "humanoid", naturalGrade: "F" },
      })
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    // The update never applied.
    expect(
      (dbMock.store.catalog.get("race-m")!.config as Record<string, unknown>)
        .raceType
    ).toBe("monster")
  })

  it("rejects creating a race without a naturalGrade (modern shape requires both)", async () => {
    await expect(
      createCatalogItem("races", {
        stableId: "wyrm",
        name: "Wyrm",
        config: {
          raceType: "monster",
          raceDefinitions: {
            F: { id: "wyrm:F", perLevel: { strength: 1 }, freePerLevel: 1 },
          },
        },
      })
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("rejects creating a race with an arbitrary invalid naturalGrade", async () => {
    await expect(
      createCatalogItem("races", {
        stableId: "wyrm",
        name: "Wyrm",
        config: { raceType: "enlightened", naturalGrade: "Z" },
      })
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("preserves an existing naturalGrade when a config-changing PATCH omits it", async () => {
    dbMock.store.addCatalog({
      id: "race-m",
      kind: "races",
      stableId: "wyrm",
      name: "Wyrm",
      config: {
        raceType: "monster",
        naturalGrade: "F",
        raceDefinitions: {
          F: { id: "wyrm:F", perLevel: { strength: 1 }, freePerLevel: 1 },
        },
      },
    })
    const item = await updateCatalogItem("races", "race-m", {
      config: { raceType: "monster" },
    })
    // The existing explicit naturalGrade is preserved (never silently dropped into
    // the legacy F fallback), just as the existing raceType would be.
    expect(item.config).toMatchObject({
      raceType: "monster",
      naturalGrade: "F",
    })
  })

  it("rejects a config-changing PATCH with an invalid naturalGrade", async () => {
    dbMock.store.addCatalog({
      id: "race-m",
      kind: "races",
      stableId: "wyrm",
      name: "Wyrm",
      config: {
        raceType: "monster",
        naturalGrade: "F",
        raceDefinitions: {
          F: { id: "wyrm:F", perLevel: { strength: 1 }, freePerLevel: 1 },
        },
      },
    })
    await expect(
      updateCatalogItem("races", "race-m", {
        config: { raceType: "monster", naturalGrade: "Z" },
      })
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    // The update never applied.
    expect(
      (dbMock.store.catalog.get("race-m")!.config as Record<string, unknown>)
        .naturalGrade
    ).toBe("F")
  })

  it("requires both raceType and naturalGrade on a config-changing PATCH of a legacy race that declares neither", async () => {
    dbMock.store.addCatalog({
      id: "race-legacy",
      kind: "races",
      stableId: "wyrm",
      name: "Wyrm",
      config: {
        raceDefinitions: {
          F: { id: "wyrm:F", perLevel: { strength: 1 }, freePerLevel: 1 },
        },
      },
    })
    // Supplying only a raceType is not enough - there is no existing naturalGrade
    // to preserve, so the modern shape must be explicit.
    await expect(
      updateCatalogItem("races", "race-legacy", {
        config: { raceType: "enlightened" },
      })
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    // The update never applied.
    expect(
      (
        dbMock.store.catalog.get("race-legacy")!.config as Record<
          string,
          unknown
        >
      ).raceType
    ).toBeUndefined()
  })
})

describe("catalog blessing / bloodline / god foundations", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function seedGod(
    id: string,
    stableId: string,
    extra: { archived?: boolean } = {}
  ): unknown {
    return dbMock.store.addCatalog({
      id,
      kind: "gods",
      stableId,
      name: `God ${stableId}`,
      config: { pantheon: "Test Pantheon" },
      ...(extra.archived != null ? { archived: extra.archived } : {}),
    })
  }

  it("creates a gods entry with blessingEffects at a valid tier", async () => {
    const item = await createCatalogItem("gods", {
      stableId: "malefic-viper",
      name: "Malefic Viper",
      config: {
        pantheon: "Void",
        divineRank: "God",
        blessingEffects: {
          Major: [{ phase: "flat", amount: { strength: 5 } }],
        },
      },
    })
    expect(item.config).toMatchObject({
      pantheon: "Void",
      divineRank: "God",
      blessingEffects: {
        Major: [{ phase: "flat", amount: { strength: 5 } }],
      },
    })
  })

  it("creates a gods entry with no blessingEffects (unbound)", async () => {
    const item = await createCatalogItem("gods", {
      stableId: "unbound-god",
      name: "Unbound God",
      config: { pantheon: "Void", divineRank: "God" },
    })
    expect(item.config).toMatchObject({ pantheon: "Void", divineRank: "God" })
    expect(item.config).not.toHaveProperty("blessingEffects")
  })

  it("maps a serialization failure (P2034) on gods create to a 409, never a 500", async () => {
    seedGod("god-serial", "serial-god")
    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce({
      name: "PrismaClientKnownRequestError",
      code: "P2034",
    })
    try {
      await expect(
        createCatalogItem("gods", {
          stableId: "serial-god",
          name: "Serializable God",
          config: { blessingEffects: { Minor: [] } },
        })
      ).rejects.toMatchObject({
        status: 409,
        code: "catalog_serialization_conflict",
      })
    } finally {
      spy.mockRestore()
    }
    // The rejected create left no row behind.
    expect(dbMock.store.catalog.size).toBe(1) // the seeded god only
  })

  it("rejects a gods entry with an invalid blessingEffects tier key", async () => {
    await expect(
      createCatalogItem("gods", {
        name: "Typo God",
        config: { blessingEffects: { minor: [] } },
      })
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("rejects a gods blessingEffects effect vector that is not a finite integer", async () => {
    await expect(
      createCatalogItem("gods", {
        name: "Fractional God",
        config: {
          blessingEffects: {
            Minor: [{ phase: "flat", amount: { strength: 1.5 } }],
          },
        },
      })
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("passes through unknown god config keys on create (permissive read)", async () => {
    const item = await createCatalogItem("gods", {
      stableId: "legacy-god",
      name: "Legacy God",
      config: { grade: "F", effect: { strength: 3 }, pantheon: "Void" },
    })
    expect(item.config).toMatchObject({
      grade: "F",
      effect: { strength: 3 },
      pantheon: "Void",
    })
  })

  it("allows a metadata-only PATCH on a gods entry (config unchanged)", async () => {
    dbMock.store.addCatalog({
      id: "legacy-god",
      kind: "gods",
      stableId: "legacy-god",
      name: "Old God",
      config: { grade: "F", effect: { strength: 3 } },
    })
    const item = await updateCatalogItem("gods", "legacy-god", {
      name: "Renamed God",
    })
    expect(item.name).toBe("Renamed God")
    expect((item.config as Record<string, unknown>).effect).toMatchObject({
      strength: 3,
    })
  })

  it("allows a config-changing PATCH on a gods entry (passthrough shape kept)", async () => {
    dbMock.store.addCatalog({
      id: "legacy-god",
      kind: "gods",
      stableId: "legacy-god",
      name: "Old God",
      config: { grade: "F", effect: { strength: 3 } },
    })
    const item = await updateCatalogItem("gods", "legacy-god", {
      config: {
        grade: "F",
        effect: { strength: 3 },
        blessingEffects: { Minor: [] },
      },
    })
    expect(item.config).toMatchObject({
      grade: "F",
      effect: { strength: 3 },
      blessingEffects: { Minor: [] },
    })
  })

  it("creates a modern bloodline (narrative-only effects) with no FK", async () => {
    const item = await createCatalogItem("bloodlines", {
      stableId: "bl-line-1",
      name: "Bloodline of the Primal Hunter",
      config: {
        effects: [],
        gradeEffects: {
          G: [{ phase: "percent", basisPoints: { perception: 500 } }],
        },
      },
    })
    expect(item.config).toMatchObject({ effects: [] })
    expect((item.config as Record<string, unknown>).gradeEffects).toMatchObject(
      {
        G: [{ phase: "percent", basisPoints: { perception: 500 } }],
      }
    )
  })

  it("rejects a legacy bloodline (no effects) on create", async () => {
    await expect(
      createCatalogItem("bloodlines", {
        name: "Old Bloodline",
        config: { grade: "F", vector: { strength: 2 } },
      })
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("creates a gods entry with pantheon/divineRank metadata", async () => {
    const item = await createCatalogItem("gods", {
      stableId: "malefic-viper",
      name: "Malefic Viper",
      config: { pantheon: "Void", divineRank: "God" },
    })
    expect(item.config).toMatchObject({ pantheon: "Void", divineRank: "God" })
  })

  it("allows a god stableId change even while a blessing character link references it", async () => {
    seedGod("god-1", "stable-god")
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "god-1",
      kind: "BLESSING",
      blessingTier: "Minor",
    })
    // Gods carry no patron FK and are exempt from the link-collision guard, so a
    // referenced god's stableId can be renamed freely (the link stores definitionId).
    const item = await updateCatalogItem("gods", "god-1", {
      stableId: "renamed-god",
    })
    expect(item.stableId).toBe("renamed-god")
  })

  it("allows a god stableId change when no blessing references it", async () => {
    seedGod("god-1", "stable-god")
    const item = await updateCatalogItem("gods", "god-1", {
      stableId: "renamed-god",
    })
    expect(item.stableId).toBe("renamed-god")
  })

  it("rejects a gods create that carries a non-null catalog grade", async () => {
    await expect(
      createCatalogItem("gods", {
        stableId: "graded-god",
        name: "Graded God",
        grade: "S",
        config: { pantheon: "Void" },
      })
    ).rejects.toMatchObject({ status: 400, code: "invalid_grade" })
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("creates a gods entry with no grade (grade reads back null)", async () => {
    const item = await createCatalogItem("gods", {
      stableId: "ungraded-god",
      name: "Ungraded God",
      config: { pantheon: "Void" },
    })
    expect(item.grade).toBeNull()
  })

  it("rejects a gods PATCH that sets a non-null catalog grade", async () => {
    dbMock.store.addCatalog({
      id: "migrated-god",
      kind: "gods",
      stableId: "migrated-god",
      name: "Migrated God",
      config: { pantheon: "Void" },
      grade: null,
    })
    await expect(
      updateCatalogItem("gods", "migrated-god", { grade: "A" })
    ).rejects.toMatchObject({ status: 400, code: "invalid_grade" })
    // The row is unchanged; the rejected PATCH never wrote.
    const row = dbMock.store.catalog.get("migrated-god")!
    expect(row.grade).toBeNull()
  })

  it("allows a metadata-only PATCH on a migrated god (grade stays null)", async () => {
    dbMock.store.addCatalog({
      id: "migrated-god",
      kind: "gods",
      stableId: "migrated-god",
      name: "Migrated God",
      config: { pantheon: "Void" },
      grade: null,
    })
    const item = await updateCatalogItem("gods", "migrated-god", {
      name: "Renamed God",
    })
    expect(item.name).toBe("Renamed God")
    expect(item.grade).toBeNull()
  })

  it("allows a gods PATCH that clears grade to null (no-op on a migrated row)", async () => {
    dbMock.store.addCatalog({
      id: "migrated-god",
      kind: "gods",
      stableId: "migrated-god",
      name: "Migrated God",
      config: { pantheon: "Void" },
      grade: null,
    })
    const item = await updateCatalogItem("gods", "migrated-god", {
      grade: null,
    })
    expect(item.grade).toBeNull()
  })
})

describe("updateCatalogItem PATCH grade semantics (clear optional grades, never clear required)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function seedCatalog(
    id: string,
    kind: string,
    config: Record<string, unknown> = {},
    grade: string | null = null,
    name = `Entry ${id}`
  ): unknown {
    return dbMock.store.addCatalog({
      id,
      kind,
      stableId: id,
      name,
      config,
      grade,
    })
  }

  it("clears a title's optional catalog grade when the PATCH sends grade: null", async () => {
    seedCatalog("title-g", "titles", { flat: { strength: 3 } }, "C", "Title G")
    const item = await updateCatalogItem("titles", "title-g", { grade: null })
    expect(item.grade).toBeNull()
    const row = dbMock.store.catalog.get("title-g")!
    expect(row.grade).toBeNull()
  })

  it("clears an item's optional catalog grade when the PATCH sends grade: null", async () => {
    seedCatalog("item-g", "items", {}, "D", "Item G")
    const item = await updateCatalogItem("items", "item-g", { grade: null })
    expect(item.grade).toBeNull()
    const row = dbMock.store.catalog.get("item-g")!
    expect(row.grade).toBeNull()
  })

  it("clears a bloodline's optional catalog grade when the PATCH sends grade: null", async () => {
    seedCatalog("blood-g", "bloodlines", { effects: [] }, "B", "Blood G")
    const item = await updateCatalogItem("bloodlines", "blood-g", {
      grade: null,
    })
    expect(item.grade).toBeNull()
    const row = dbMock.store.catalog.get("blood-g")!
    expect(row.grade).toBeNull()
  })

  it("clears a transcendent skill's optional catalog grade when the PATCH sends grade: null", async () => {
    seedCatalog(
      "trans-g",
      "transcendent_skills",
      { passiveEffects: [] },
      "A",
      "Trans G"
    )
    const item = await updateCatalogItem("transcendent_skills", "trans-g", {
      grade: null,
    })
    expect(item.grade).toBeNull()
  })

  it("leaves an existing grade untouched when the PATCH omits grade", async () => {
    seedCatalog(
      "title-keep",
      "titles",
      { flat: { strength: 3 } },
      "C",
      "Title Keep"
    )
    const item = await updateCatalogItem("titles", "title-keep", {
      name: "Renamed Title",
    })
    expect(item.grade).toBe("C")
    expect(item.name).toBe("Renamed Title")
  })

  it("preserves description and gradeDescriptions when clearing only grade", async () => {
    seedCatalog(
      "title-desc",
      "titles",
      { flat: { strength: 3 } },
      "C",
      "Title Desc"
    )
    const item = await updateCatalogItem("titles", "title-desc", {
      grade: null,
      description: "New description",
    })
    expect(item.grade).toBeNull()
    expect(item.description).toBe("New description")
    expect(item.gradeDescriptions).toEqual({})
  })

  it("rejects a grade: null clear on a race with 400 invalid_grade (no write)", async () => {
    seedCatalog("race-null", "races", {}, "B", "Race Null")
    await expect(
      updateCatalogItem("races", "race-null", { grade: null })
    ).rejects.toMatchObject({ status: 400, code: "invalid_grade" })
    const row = dbMock.store.catalog.get("race-null")!
    expect(row.grade).toBe("B")
  })

  it("rejects a grade: null clear on a class and profession with 400 invalid_grade", async () => {
    seedCatalog("cls-null", "classes", {}, "F", "Class Null")
    seedCatalog("prof-null", "professions", {}, "E", "Prof Null")
    await expect(
      updateCatalogItem("classes", "cls-null", { grade: null })
    ).rejects.toMatchObject({ status: 400, code: "invalid_grade" })
    await expect(
      updateCatalogItem("professions", "prof-null", { grade: null })
    ).rejects.toMatchObject({ status: 400, code: "invalid_grade" })
  })

  it("allows a gods PATCH that clears grade to null (legal and no-op)", async () => {
    seedCatalog("god-null", "gods", { pantheon: "Void" }, null, "God Null")
    const item = await updateCatalogItem("gods", "god-null", { grade: null })
    expect(item.grade).toBeNull()
  })

  it("still applies a non-null grade on an optional kind (no accidental clear)", async () => {
    seedCatalog(
      "title-up",
      "titles",
      { flat: { strength: 3 } },
      "C",
      "Title Up"
    )
    const item = await updateCatalogItem("titles", "title-up", { grade: "A" })
    expect(item.grade).toBe("A")
  })
})

describe("skill offers (milestone choice model)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function classState(
    level: number,
    quarter: number,
    grade: Grade = "F"
  ): unknown {
    const state = createInitialState("integrated", null, null)
    state.tracks.class = { level, quarter, definitionId: "archer:F" }
    state.race = { ...state.race, level: 10, grade }
    return serializeState(state)
  }

  function seedClassCatalog(stableId = "archer") {
    dbMock.store.addCatalog({
      id: "cls-1",
      kind: "classes",
      stableId,
      name: "Archer",
      config: { grades: { F: { fixed: { agility: 2 }, free: 1 } } },
    })
  }

  function seedCharacterForSkill(
    level: number,
    quarter: number,
    grade: Grade = "F"
  ): unknown {
    return dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      classId: "cls-1",
      state: classState(level, quarter, grade),
      version: 0,
    })
  }

  function seedSkill(
    id: string,
    config: Record<string, unknown>,
    extra: Partial<{
      name: string
      grade: string
      archived: boolean
    }> = {}
  ): unknown {
    return dbMock.store.addCatalog({
      id,
      kind: "skills",
      stableId: id,
      name: extra.name ?? `Skill ${id}`,
      config,
      ...(extra.grade ? { grade: extra.grade } : {}),
      ...(extra.archived != null ? { archived: extra.archived } : {}),
    })
  }

  function seedOffer(
    id: string,
    opts: {
      characterId?: string
      track?: string
      level?: number
      choiceGroup?: string
      generation?: number
      canceledAt?: Date | null
      options: Array<{
        definitionId: string
        nameSnapshot?: string
        configSnapshot?: unknown
      }>
      selectedDefinitionId?: string | null
    }
  ): void {
    const characterId = opts.characterId ?? "chr-1"
    dbMock.store.skillOffers.push({
      id,
      characterId,
      track: opts.track ?? "class",
      level: opts.level ?? 4,
      choiceGroup: opts.choiceGroup ?? "standard",
      generation: opts.generation ?? 0,
      canceledAt: opts.canceledAt ?? null,
      selectedDefinitionId: opts.selectedDefinitionId ?? null,
      offeredAt: new Date(),
      selectedAt: opts.selectedDefinitionId ? new Date() : null,
    })
    for (const o of opts.options) {
      dbMock.store.skillOfferOptions.push({
        id: `opt-${id}-${o.definitionId}`,
        offerId: id,
        definitionId: o.definitionId,
        nameSnapshot: o.nameSnapshot ?? `Skill ${o.definitionId}`,
        configSnapshot: o.configSnapshot ?? {},
      })
    }
  }

  it("creates no skill offers on a quarter-only advance", async () => {
    seedClassCatalog()
    seedCharacterForSkill(4, 2)
    seedSkill("sk-1", {
      track: "class",
      milestone: 5,
      effects: [{ phase: "flat", amount: { strength: 1 }, stacking: "stack" }],
    })
    const res = await advanceCharacter(
      "chr-1",
      { track: "class", version: 0 },
      user
    )
    const journal = res.journal as { leveledUp: boolean }
    expect(journal.leveledUp).toBe(false)
    expect(res.character.skillOffers).toHaveLength(0)
    expect(dbMock.store.skillOffers).toHaveLength(0)
  })

  it("offers a single choice group with multiple options once on a level-up", async () => {
    seedClassCatalog()
    seedCharacterForSkill(3, 3)
    seedSkill("sk-1", {
      track: "class",
      milestone: 4,
      effects: [{ phase: "flat", amount: { strength: 1 }, stacking: "stack" }],
    })
    seedSkill("sk-2", {
      track: "class",
      milestone: 4,
      effects: [{ phase: "flat", amount: { agility: 2 }, stacking: "stack" }],
    })
    const res = await advanceCharacter(
      "chr-1",
      { track: "class", version: 0 },
      user
    )
    const journal = res.journal as { leveledUp: boolean; levelAfter: number }
    expect(journal.leveledUp).toBe(true)
    expect(journal.levelAfter).toBe(4)
    expect(dbMock.store.skillOffers).toHaveLength(1)
    expect(res.character.skillOffers).toHaveLength(1)
    const offer = res.character.skillOffers[0]
    expect(offer.track).toBe("class")
    expect(offer.level).toBe(4)
    expect(offer.choiceGroup).toBe("standard")
    expect(offer.options).toHaveLength(2)
    expect(offer.options.map((o) => o.definitionId).sort()).toEqual([
      "sk-1",
      "sk-2",
    ])
  })

  it("offers only skills matching the advanced track and the selected class", async () => {
    seedClassCatalog("archer")
    seedCharacterForSkill(3, 3)
    seedSkill("sk-class-any", {
      track: "class",
      milestone: 4,
      effects: [{ phase: "flat", amount: { strength: 1 }, stacking: "stack" }],
    })
    seedSkill("sk-class-archer", {
      track: "class",
      milestone: 4,
      eligibleDefinitionStableIds: ["archer"],
      effects: [{ phase: "flat", amount: { strength: 2 }, stacking: "stack" }],
    })
    seedSkill("sk-class-mage", {
      track: "class",
      milestone: 4,
      eligibleDefinitionStableIds: ["mage"],
      effects: [{ phase: "flat", amount: { strength: 3 }, stacking: "stack" }],
    })
    seedSkill("sk-prof", {
      track: "profession",
      milestone: 4,
      effects: [{ phase: "flat", amount: { strength: 4 }, stacking: "stack" }],
    })
    const res = await advanceCharacter(
      "chr-1",
      { track: "class", version: 0 },
      user
    )
    expect(res.character.skillOffers).toHaveLength(1)
    const offer = res.character.skillOffers[0]
    expect(offer.options.map((o) => o.definitionId).sort()).toEqual([
      "sk-class-any",
      "sk-class-archer",
    ])
    // The profession skill is not offered because the character advanced "class".
    expect(offer.options.some((o) => o.definitionId === "sk-prof")).toBe(false)
  })

  it("marks a selected offer as selected and links the skill; pending offers stay pending", async () => {
    seedCharacterForSkill(0, 0)
    seedSkill("sk-1", { track: "class", milestone: 4, effects: [] })
    seedSkill("sk-2", { track: "class", milestone: 4, effects: [] })
    seedSkill("sk-3", { track: "class", milestone: 8, effects: [] })
    seedOffer("off-1", {
      options: [{ definitionId: "sk-1" }, { definitionId: "sk-2" }],
    })
    // A separate, still-pending offer.
    seedOffer("off-2", {
      level: 8,
      options: [{ definitionId: "sk-3" }],
    })
    const res = await skillCharacter(
      "chr-1",
      {
        operation: "select",
        offerId: "off-1",
        definitionId: "sk-1",
        version: 0,
      },
      user
    )
    expect(res.character.version).toBe(1)
    const offer = res.character.skillOffers.find((o) => o.id === "off-1")!
    expect(offer.selectedDefinitionId).toBe("sk-1")
    // The options are still listed (snapshots), so the choice remains visible.
    expect(offer.options).toHaveLength(2)
    expect(
      res.character.associations.some(
        (a) => a.definitionId === "sk-1" && a.kind === "skill"
      )
    ).toBe(true)
    // The other offer remains pending.
    const other = res.character.skillOffers.find((o) => o.id === "off-2")!
    expect(other.selectedDefinitionId).toBeNull()
    expect(other.options).toHaveLength(1)
    const ev = dbMock.store.events.find((e) => e.kind === "skill_select")!
    expect(ev.payload).toMatchObject({
      operation: "select",
      offerId: "off-1",
      definitionId: "sk-1",
    })
  })

  it("rejects duplicate acquisition, repeat selection and a stale version (409)", async () => {
    seedCharacterForSkill(0, 0)
    seedSkill("sk-1", { track: "class", milestone: 4, effects: [] })
    seedSkill("sk-2", { track: "class", milestone: 4, effects: [] })
    // sk-1 is already acquired (e.g. granted earlier).
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "sk-1",
      kind: "SKILL",
    })
    seedOffer("off-1", {
      options: [{ definitionId: "sk-1" }, { definitionId: "sk-2" }],
    })
    // Duplicate: sk-1 already linked.
    await expect(
      skillCharacter(
        "chr-1",
        {
          operation: "select",
          offerId: "off-1",
          definitionId: "sk-1",
          version: 0,
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "duplicate" })
    // Stale version: selecting a non-duplicate option with a stale version.
    await expect(
      skillCharacter(
        "chr-1",
        {
          operation: "select",
          offerId: "off-1",
          definitionId: "sk-2",
          version: 9,
        },
        user
      )
    ).rejects.toMatchObject({ status: 409, code: "version_conflict" })
    const ok = await skillCharacter(
      "chr-1",
      {
        operation: "select",
        offerId: "off-1",
        definitionId: "sk-2",
        version: 0,
      },
      user
    )
    expect(ok.character.version).toBe(1)
    // Repeat: the offer is now answered, selecting again is rejected.
    await expect(
      skillCharacter(
        "chr-1",
        {
          operation: "select",
          offerId: "off-1",
          definitionId: "sk-2",
          version: 1,
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "offer_already_selected" })
    // The stale attempt leaked no association or event.
    expect(
      dbMock.store.associations.filter(
        (a) => a.definitionId === "sk-2" && a.kind === "SKILL"
      )
    ).toHaveLength(1)
    expect(dbMock.store.events).toHaveLength(1)
  })

  it("limits grants to admins (owners select but cannot grant)", async () => {
    seedCharacterForSkill(0, 0)
    seedSkill("sk-1", { track: "class", milestone: 4, effects: [] })
    // A non-admin owner granting is forbidden.
    await expect(
      skillCharacter(
        "chr-1",
        {
          operation: "grant",
          definitionId: "sk-1",
          version: 0,
          reason: "because",
        },
        user
      )
    ).rejects.toMatchObject({ status: 403, code: "forbidden" })
    // A grant requires a non-empty reason.
    const admin = { id: "admin-1", email: "a@example.com", isAdmin: true }
    await expect(
      skillCharacter(
        "chr-1",
        {
          operation: "grant",
          definitionId: "sk-1",
          version: 0,
          reason: "   ",
        },
        admin
      )
    ).rejects.toMatchObject({ status: 400, code: "reason_required" })
    // An admin grant links the skill and records provenance "manual".
    const res = await skillCharacter(
      "chr-1",
      {
        operation: "grant",
        definitionId: "sk-1",
        version: 0,
        reason: "because",
      },
      admin
    )
    expect(res.character.version).toBe(1)
    expect(
      res.character.associations.some(
        (a) => a.definitionId === "sk-1" && a.kind === "skill"
      )
    ).toBe(true)
    const ev = dbMock.store.events.find((e) => e.kind === "skill_grant")!
    expect(ev.payload).toMatchObject({
      operation: "grant",
      definitionId: "sk-1",
      reason: "because",
      provenance: "manual",
    })
  })

  it("rejects selecting an archived offered option", async () => {
    seedCharacterForSkill(0, 0)
    seedSkill(
      "sk-1",
      { track: "class", milestone: 4, effects: [] },
      { archived: true }
    )
    seedOffer("off-1", { options: [{ definitionId: "sk-1" }] })
    await expect(
      skillCharacter(
        "chr-1",
        {
          operation: "select",
          offerId: "off-1",
          definitionId: "sk-1",
          version: 0,
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "catalog_archived" })
    // Nothing was written.
    expect(dbMock.store.associations).toHaveLength(0)
    expect(dbMock.store.events).toHaveLength(0)
  })

  it("removes every linked skill in the same upgrade group (never stacks)", async () => {
    seedCharacterForSkill(0, 0)
    seedSkill("sk-low", {
      track: "class",
      milestone: 4,
      upgradeGroup: "tier",
      rarity: "Common",
      effects: [],
    })
    seedSkill("sk-high", {
      track: "class",
      milestone: 4,
      upgradeGroup: "tier",
      rarity: "Uncommon",
      effects: [],
    })
    // The lower tier was already acquired.
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "sk-low",
      kind: "SKILL",
    })
    seedOffer("off-1", { options: [{ definitionId: "sk-high" }] })
    const res = await skillCharacter(
      "chr-1",
      {
        operation: "select",
        offerId: "off-1",
        definitionId: "sk-high",
        version: 0,
      },
      user
    )
    const skillDefs = res.character.associations
      .filter((a) => a.kind === "skill")
      .map((a) => a.definitionId)
    expect(skillDefs).toEqual(["sk-high"])
    const ev = dbMock.store.events.find((e) => e.kind === "skill_select")!
    expect(ev.payload).toMatchObject({
      removed: [{ definitionId: "sk-low", name: "Skill sk-low" }],
    })
  })

  it("synthesizes skill effects live from the current catalog without rewriting history", async () => {
    seedCharacterForSkill(0, 0)
    seedSkill("sk-1", {
      track: "class",
      milestone: 4,
      rarity: "Common",
      effects: [{ phase: "flat", amount: { strength: 5 }, stacking: "stack" }],
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "sk-1",
      kind: "SKILL",
    })
    let detail = await getCharacter("chr-1", user)
    let strengthTrace = detail.status!.traces.find(
      (t) => t.attribute === "strength"
    )!
    let flat = strengthTrace.phases.find((p) => p.phase === "flat")!
    expect(flat.delta).toBe(5)
    // The stored state never contains the synthesized effect.
    expect(
      (detail.state as { activeEffects: unknown[] }).activeEffects
    ).toHaveLength(0)

    // Editing the skill's effects recalculates the live status; the rarity/group
    // stay stable so the linked-skill stability guard permits the edit.
    await updateCatalogItem("skills", "sk-1", {
      config: {
        track: "class",
        milestone: 4,
        rarity: "Common",
        effects: [
          { phase: "flat", amount: { strength: 10 }, stacking: "stack" },
        ],
      },
    })
    detail = await getCharacter("chr-1", user)
    strengthTrace = detail.status!.traces.find(
      (t) => t.attribute === "strength"
    )!
    flat = strengthTrace.phases.find((p) => p.phase === "flat")!
    expect(flat.delta).toBe(10)
    expect(
      (detail.state as { activeEffects: unknown[] }).activeEffects
    ).toHaveLength(0)
  })

  it("applies BOTH flat and percent effects of one upgrade-grouped skill (groups are per-effect)", async () => {
    seedCharacterForSkill(0, 0)
    // A single skill carrying an upgradeGroup still has its flat AND percent
    // effects applied independently: the upgradeGroup is only a select/grant
    // replacement group, never an effect replace group.
    seedSkill("sk-both", {
      track: "class",
      milestone: 4,
      upgradeGroup: "tier",
      effects: [
        { phase: "flat", amount: { strength: 5 } },
        { phase: "percent", basisPoints: { strength: 1000 } },
      ],
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "sk-both",
      kind: "SKILL",
    })
    const detail = await getCharacter("chr-1", user)
    const strengthTrace = detail.status!.traces.find(
      (t) => t.attribute === "strength"
    )!
    // The flat effect survives (it is not collapsed into the percent effect).
    const flat = strengthTrace.phases.find((p) => p.phase === "flat")!
    expect(flat.delta).toBe(5)
    const percent = strengthTrace.phases.find((p) => p.phase === "percent")!
    expect(percent).toBeDefined()
    // History stays immutable: the synthesized effects are not persisted.
    expect(
      (detail.state as { activeEffects: unknown[] }).activeEffects
    ).toHaveLength(0)
  })

  it("treats a present-but-empty eligibleDefinitionStableIds as no offers", async () => {
    seedClassCatalog("archer")
    seedCharacterForSkill(3, 3)
    seedSkill("sk-restrict-empty", {
      track: "class",
      milestone: 4,
      eligibleDefinitionStableIds: [],
      effects: [{ phase: "flat", amount: { strength: 1 } }],
    })
    const res = await advanceCharacter(
      "chr-1",
      { track: "class", version: 0 },
      user
    )
    expect(res.character.skillOffers).toHaveLength(0)
    expect(dbMock.store.skillOffers).toHaveLength(0)
  })

  it("does not duplicate an offer for an already-existing (character, track, level, choiceGroup)", async () => {
    seedClassCatalog("archer")
    seedCharacterForSkill(3, 3)
    seedSkill("sk-1", {
      track: "class",
      milestone: 4,
      effects: [{ phase: "flat", amount: { strength: 1 } }],
    })
    // A pre-existing offer for level 4 already covers the same identity.
    seedOffer("off-pre", {
      level: 4,
      options: [{ definitionId: "sk-1" }],
    })
    const res = await advanceCharacter(
      "chr-1",
      { track: "class", version: 0 },
      user
    )
    // No duplicate was created; the pre-existing offer remains the only one.
    expect(dbMock.store.skillOffers).toHaveLength(1)
    expect(dbMock.store.skillOffers[0].id).toBe("off-pre")
    expect(res.character.skillOffers).toHaveLength(1)
    const journal = res.journal as { skillOffers?: unknown }
    expect(journal.skillOffers).toBeUndefined()
  })

  it("ignores a legacy arbitrary track string for offers and still reads safely", async () => {
    seedClassCatalog("archer")
    seedCharacterForSkill(3, 3)
    // A legacy entry whose `track` is not one of the enum values: it must parse on
    // read (no 500), be ignored for offers, and its effects must still be safe.
    seedSkill("sk-legacy", {
      track: "Class",
      milestone: 4,
      effects: [{ phase: "flat", amount: { strength: 1 } }],
    })
    const res = await advanceCharacter(
      "chr-1",
      { track: "class", version: 0 },
      user
    )
    expect(res.character.skillOffers).toHaveLength(0)
  })

  it("rejects selecting a canceled offer (409 offer_canceled)", async () => {
    seedCharacterForSkill(0, 0)
    seedSkill("sk-1", { track: "class", milestone: 4, effects: [] })
    // An offer that was voided (e.g. by an EXP undo) is no longer selectable.
    seedOffer("off-canceled", {
      options: [{ definitionId: "sk-1" }],
      canceledAt: new Date(),
    })
    await expect(
      skillCharacter(
        "chr-1",
        {
          operation: "select",
          offerId: "off-canceled",
          definitionId: "sk-1",
          version: 0,
        },
        user
      )
    ).rejects.toMatchObject({ status: 409, code: "offer_canceled" })
    // The rejection wrote nothing.
    expect(dbMock.store.associations).toHaveLength(0)
    expect(dbMock.store.events).toHaveLength(0)
  })

  it("re-offers at the next generation after a cancellation, preserving the canceled record", async () => {
    seedClassCatalog("archer")
    seedCharacterForSkill(3, 3)
    seedSkill("sk-1", {
      track: "class",
      milestone: 4,
      effects: [{ phase: "flat", amount: { strength: 1 } }],
    })
    // A prior offer sharing the base key was canceled. It must not block a
    // re-offer, and it must never be deleted or rewritten (append-only).
    seedOffer("off-canceled", {
      level: 4,
      canceledAt: new Date(),
      generation: 0,
      options: [{ definitionId: "sk-1" }],
    })
    const res = await advanceCharacter(
      "chr-1",
      { track: "class", version: 0 },
      user
    )
    // Both the preserved canceled record and the new generation exist.
    expect(dbMock.store.skillOffers).toHaveLength(2)
    const canceled = dbMock.store.skillOffers.find(
      (o) => o.id === "off-canceled"
    )!
    expect(canceled.canceledAt).toBeInstanceOf(Date)
    expect(canceled.generation).toBe(0)
    // The re-offer is created at the next generation and is actable.
    const reoffer = res.character.skillOffers.find(
      (o) => o.id !== "off-canceled"
    )!
    expect(reoffer.generation).toBe(1)
    expect(reoffer.canceledAt).toBeNull()
    const stored = dbMock.store.skillOffers.find((o) => o.id === reoffer.id)!
    expect(stored.generation).toBe(1)
    expect(stored.canceledAt).toBeNull()
  })
})

describe("skill catalog config (legacy track + validation)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  it("reads a legacy arbitrary track string safely and still synthesizes its effects", async () => {
    const state = createInitialState("integrated", null, null)
    dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      state: serializeState(state),
      version: 0,
    })
    // A legacy entry carries an arbitrary track string; it must parse on read and
    // its effects must still apply (the track is only used for offers).
    dbMock.store.addCatalog({
      id: "sk-legacy",
      kind: "skills",
      stableId: "sk-legacy",
      name: "Legacy Skill",
      config: {
        track: "Class",
        milestone: 4,
        effects: [{ phase: "flat", amount: { strength: 7 } }],
      },
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "sk-legacy",
      kind: "SKILL",
    })
    const detail = await getCharacter("chr-1", user)
    const strengthTrace = detail.status!.traces.find(
      (t) => t.attribute === "strength"
    )!
    const flat = strengthTrace.phases.find((p) => p.phase === "flat")!
    expect(flat.delta).toBe(7)
  })

  it("rejects a new skill whose track is not class|profession", async () => {
    await expect(
      createCatalogItem("skills", {
        name: "Odd",
        config: { track: "Class", milestone: 4 },
      })
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("rejects a config-changing PATCH whose track is not class|profession", async () => {
    dbMock.store.addCatalog({
      id: "sk-ok",
      kind: "skills",
      stableId: "sk-ok",
      name: "Ok",
      config: { track: "class", milestone: 4, rarity: "Common" },
    })
    const ok = await updateCatalogItem("skills", "sk-ok", {
      config: { track: "profession", milestone: 4, rarity: "Common" },
    })
    expect((ok.config as { track: string }).track).toBe("profession")
    await expect(
      updateCatalogItem("skills", "sk-ok", {
        config: { track: "Profession", milestone: 4, rarity: "Common" },
      })
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    // The rejected update never applied.
    expect(
      (dbMock.store.catalog.get("sk-ok")!.config as { track: string }).track
    ).toBe("profession")
  })

  it("retains its own stacking semantics for a grouped legacy effect without stacking", async () => {
    const state = createInitialState("integrated", null, null)
    dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      state: serializeState(state),
      version: 0,
    })
    // A legacy effect that predates the stacking field: it must still parse and
    // default to "stack" (never a 500).
    dbMock.store.addCatalog({
      id: "sk-ms",
      kind: "skills",
      stableId: "sk-ms",
      name: "Missing Stacking",
      config: {
        track: "class",
        milestone: 4,
        effects: [{ phase: "flat", amount: { strength: 3 } }],
      },
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "sk-ms",
      kind: "SKILL",
    })
    const detail = await getCharacter("chr-1", user)
    const strengthTrace = detail.status!.traces.find(
      (t) => t.attribute === "strength"
    )!
    const flat = strengthTrace.phases.find((p) => p.phase === "flat")!
    expect(flat.delta).toBe(3)
  })
})

describe("skill explicit upgrade (POST /characters/[id]/skills/upgrade)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function seedCatalogSkill(
    id: string,
    config: Record<string, unknown>,
    extra: Partial<{
      name: string
      grade: string
      archived: boolean
      description: string | null
    }> = {}
  ): unknown {
    return dbMock.store.addCatalog({
      id,
      kind: "skills",
      stableId: id,
      name: extra.name ?? `Skill ${id}`,
      description: extra.description ?? null,
      config,
      ...(extra.grade ? { grade: extra.grade } : {}),
      ...(extra.archived != null ? { archived: extra.archived } : {}),
    })
  }

  function seedCharacterWithSkills() {
    dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      state: serializeState(createInitialState("integrated", null, null)),
      version: 0,
    })
  }

  function linkSkill(characterId: string, definitionId: string): void {
    dbMock.store.addAssociation({
      characterId,
      definitionId,
      kind: "SKILL",
    })
  }

  it("rejects a non-owner (403 forbidden)", async () => {
    seedCharacterWithSkills()
    seedCatalogSkill("sk-low", {
      track: "class",
      milestone: 4,
      upgradeGroup: "tier",
      rarity: "Common",
      effects: [],
    })
    seedCatalogSkill("sk-high", {
      track: "class",
      milestone: 4,
      upgradeGroup: "tier",
      rarity: "Uncommon",
      effects: [],
    })
    linkSkill("chr-1", "sk-low")
    const other = { id: "user-2", email: "u2@example.com", isAdmin: false }
    await expect(
      upgradeSkill(
        "chr-1",
        { definitionId: "sk-high", version: 0, reason: "because" },
        other
      )
    ).rejects.toMatchObject({ status: 403, code: "forbidden" })
    expect(dbMock.store.events).toHaveLength(0)
  })

  it("upgrades a linked skill to a strictly higher-ordered rarity and records a snapshot event", async () => {
    seedCharacterWithSkills()
    seedCatalogSkill(
      "sk-low",
      {
        track: "class",
        milestone: 4,
        upgradeGroup: "tier",
        rarity: "Common",
        effects: [],
      },
      { description: "low tier" }
    )
    seedCatalogSkill(
      "sk-high",
      {
        track: "class",
        milestone: 4,
        upgradeGroup: "tier",
        rarity: "Uncommon",
        effects: [],
      },
      { description: "high tier" }
    )
    linkSkill("chr-1", "sk-low")
    const res = await upgradeSkill(
      "chr-1",
      { definitionId: "sk-high", version: 0, reason: "promotion" },
      user
    )
    expect(res.character.version).toBe(1)
    const skills = res.character.associations
      .filter((a) => a.kind === "skill")
      .map((a) => a.definitionId)
    expect(skills).toEqual(["sk-high"])
    const ev = dbMock.store.events.find((e) => e.kind === "skill_upgrade")!
    expect(ev.payload).toMatchObject({
      operation: "upgrade",
      definitionId: "sk-high",
      reason: "promotion",
      from: {
        definitionId: "sk-low",
        stableId: "sk-low",
        name: "Skill sk-low",
        rarity: "Common",
        description: "low tier",
      },
      to: {
        definitionId: "sk-high",
        stableId: "sk-high",
        name: "Skill sk-high",
        rarity: "Uncommon",
        description: "high tier",
      },
      removed: [{ definitionId: "sk-low", name: "Skill sk-low" }],
    })
  })

  it("rejects an upgrade to the same rarity (not strictly higher)", async () => {
    seedCharacterWithSkills()
    seedCatalogSkill("sk-low", {
      track: "class",
      milestone: 4,
      upgradeGroup: "tier",
      rarity: "Common",
      effects: [],
    })
    seedCatalogSkill("sk-same", {
      track: "class",
      milestone: 4,
      upgradeGroup: "tier",
      rarity: "Common",
      effects: [],
    })
    linkSkill("chr-1", "sk-low")
    await expect(
      upgradeSkill(
        "chr-1",
        { definitionId: "sk-same", version: 0, reason: "because" },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "skill_rarity_not_higher" })
    expect(dbMock.store.associations).toHaveLength(1)
    expect(dbMock.store.events).toHaveLength(0)
  })

  it("rejects a target with a missing or incomparable (Unique) rarity", async () => {
    seedCharacterWithSkills()
    seedCatalogSkill("sk-low", {
      track: "class",
      milestone: 4,
      upgradeGroup: "tier",
      rarity: "Common",
      effects: [],
    })
    seedCatalogSkill("sk-no-rar", {
      track: "class",
      milestone: 4,
      upgradeGroup: "tier",
      effects: [],
    })
    seedCatalogSkill("sk-unique", {
      track: "class",
      milestone: 4,
      upgradeGroup: "tier",
      rarity: "Unique",
      effects: [],
    })
    linkSkill("chr-1", "sk-low")
    await expect(
      upgradeSkill(
        "chr-1",
        { definitionId: "sk-no-rar", version: 0, reason: "x" },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "skill_rarity_not_higher" })
    await expect(
      upgradeSkill(
        "chr-1",
        { definitionId: "sk-unique", version: 0, reason: "x" },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "skill_rarity_not_higher" })
  })

  it("rejects a source with a missing or incomparable (Unique) rarity", async () => {
    seedCharacterWithSkills()
    seedCatalogSkill("sk-low", {
      track: "class",
      milestone: 4,
      upgradeGroup: "tier",
      effects: [],
    })
    seedCatalogSkill("sk-high", {
      track: "class",
      milestone: 4,
      upgradeGroup: "tier",
      rarity: "Rare",
      effects: [],
    })
    linkSkill("chr-1", "sk-low")
    await expect(
      upgradeSkill(
        "chr-1",
        { definitionId: "sk-high", version: 0, reason: "x" },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "skill_rarity_not_higher" })
  })

  it("rejects a source with the incomparable Unique rarity", async () => {
    seedCharacterWithSkills()
    seedCatalogSkill("sk-unique-src", {
      track: "class",
      milestone: 4,
      upgradeGroup: "tier",
      rarity: "Unique",
      effects: [],
    })
    seedCatalogSkill("sk-high", {
      track: "class",
      milestone: 4,
      upgradeGroup: "tier",
      rarity: "Rare",
      effects: [],
    })
    linkSkill("chr-1", "sk-unique-src")
    await expect(
      upgradeSkill(
        "chr-1",
        { definitionId: "sk-high", version: 0, reason: "x" },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "skill_rarity_not_higher" })
  })

  it("rejects zero or multiple same-group source links (ambiguous), and a no-group target", async () => {
    seedCharacterWithSkills()
    seedCatalogSkill("sk-a", {
      track: "class",
      milestone: 4,
      upgradeGroup: "tier",
      rarity: "Common",
      effects: [],
    })
    seedCatalogSkill("sk-b", {
      track: "class",
      milestone: 4,
      upgradeGroup: "tier",
      rarity: "Common",
      effects: [],
    })
    seedCatalogSkill("sk-high", {
      track: "class",
      milestone: 4,
      upgradeGroup: "tier",
      rarity: "Rare",
      effects: [],
    })
    seedCatalogSkill("sk-ungrouped", {
      track: "class",
      milestone: 4,
      rarity: "Rare",
      effects: [],
    })
    // zero sources: nothing to upgrade
    await expect(
      upgradeSkill(
        "chr-1",
        { definitionId: "sk-high", version: 0, reason: "x" },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "skill_rarity_not_higher" })
    // two sources in same group: ambiguous
    linkSkill("chr-1", "sk-a")
    linkSkill("chr-1", "sk-b")
    await expect(
      upgradeSkill(
        "chr-1",
        { definitionId: "sk-high", version: 0, reason: "x" },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "skill_rarity_not_higher" })
    // target with no upgradeGroup
    await expect(
      upgradeSkill(
        "chr-1",
        { definitionId: "sk-ungrouped", version: 0, reason: "x" },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "skill_rarity_not_higher" })
  })

  it("rejects an archived target and a duplicate (already-linked) target", async () => {
    seedCharacterWithSkills()
    seedCatalogSkill("sk-low", {
      track: "class",
      milestone: 4,
      upgradeGroup: "tier",
      rarity: "Common",
      effects: [],
    })
    seedCatalogSkill(
      "sk-high",
      {
        track: "class",
        milestone: 4,
        upgradeGroup: "tier",
        rarity: "Uncommon",
        effects: [],
      },
      { archived: true }
    )
    seedCatalogSkill("sk-dup", {
      track: "class",
      milestone: 4,
      upgradeGroup: "tier",
      rarity: "Uncommon",
      effects: [],
    })
    linkSkill("chr-1", "sk-low")
    await expect(
      upgradeSkill(
        "chr-1",
        { definitionId: "sk-high", version: 0, reason: "x" },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "catalog_archived" })
    // duplicate: linking sk-dup as well would leave it already acquired
    linkSkill("chr-1", "sk-dup")
    await expect(
      upgradeSkill(
        "chr-1",
        { definitionId: "sk-dup", version: 0, reason: "x" },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "duplicate" })
  })

  it("allows an upgrade away from an ARCHIVED source link, using its config", async () => {
    seedCharacterWithSkills()
    seedCatalogSkill(
      "sk-old",
      {
        track: "class",
        milestone: 4,
        upgradeGroup: "tier",
        rarity: "Common",
        effects: [],
      },
      { archived: true }
    )
    seedCatalogSkill("sk-new", {
      track: "class",
      milestone: 4,
      upgradeGroup: "tier",
      rarity: "Rare",
      effects: [],
    })
    linkSkill("chr-1", "sk-old")
    const res = await upgradeSkill(
      "chr-1",
      { definitionId: "sk-new", version: 0, reason: "replacement" },
      user
    )
    expect(res.character.version).toBe(1)
    const skills = res.character.associations
      .filter((a) => a.kind === "skill")
      .map((a) => a.definitionId)
    expect(skills).toEqual(["sk-new"])
    const ev = dbMock.store.events.find((e) => e.kind === "skill_upgrade")!
    expect(ev.payload).toMatchObject({
      from: { definitionId: "sk-old", rarity: "Common" },
      to: { definitionId: "sk-new", rarity: "Rare" },
    })
  })

  it("rejects a target of the wrong catalog kind", async () => {
    seedCharacterWithSkills()
    seedCatalogSkill("sk-low", {
      track: "class",
      milestone: 4,
      upgradeGroup: "tier",
      rarity: "Common",
      effects: [],
    })
    linkSkill("chr-1", "sk-low")
    dbMock.store.addCatalog({
      id: "cls-1",
      kind: "classes",
      stableId: "cls-1",
      name: "Archer",
      config: {},
    })
    await expect(
      upgradeSkill(
        "chr-1",
        { definitionId: "cls-1", version: 0, reason: "x" },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "wrong_kind" })
  })

  it("maps a serialization failure (P2034) on upgrade to 409 serialization_conflict and rolls back event/link/CAS", async () => {
    seedCharacterWithSkills()
    seedCatalogSkill(
      "sk-low",
      {
        track: "class",
        milestone: 4,
        upgradeGroup: "tier",
        rarity: "Common",
        effects: [],
      },
      { description: "low tier" }
    )
    seedCatalogSkill(
      "sk-high",
      {
        track: "class",
        milestone: 4,
        upgradeGroup: "tier",
        rarity: "Uncommon",
        effects: [],
      },
      { description: "high tier" }
    )
    linkSkill("chr-1", "sk-low")
    // A concurrent character write that cannot serialize aborts the upgrade with
    // P2034, which the service must surface as a 409 rather than a raw 500, and
    // must not write a stray event, replace the source link, or bump the CAS
    // version.
    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce({
      name: "PrismaClientKnownRequestError",
      code: "P2034",
    })
    try {
      await expect(
        upgradeSkill(
          "chr-1",
          { definitionId: "sk-high", version: 0, reason: "promotion" },
          user
        )
      ).rejects.toMatchObject({ status: 409, code: "serialization_conflict" })
    } finally {
      spy.mockRestore()
    }
    expect(dbMock.store.events).toHaveLength(0)
    expect(dbMock.store.associations).toHaveLength(1)
    expect(dbMock.store.associations[0].definitionId).toBe("sk-low")
    expect(dbMock.store.characters.get("chr-1")!.version).toBe(0)
  })
})

describe("skill rarity monotonic guard (select/grant)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function seedClassCatalog(stableId = "archer") {
    dbMock.store.addCatalog({
      id: "cls-1",
      kind: "classes",
      stableId,
      name: "Archer",
      config: { grades: { F: { fixed: { agility: 2 }, free: 1 } } },
    })
  }

  function seedCharacterForSkill(level: number, quarter: number): unknown {
    const state = createInitialState("integrated", null, null)
    state.tracks.class = { level, quarter, definitionId: "archer:F" }
    state.race = { ...state.race, level: 10, grade: "F" }
    return dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      classId: "cls-1",
      state: serializeState(state),
      version: 0,
    })
  }

  function seedSkill(id: string, config: Record<string, unknown>): void {
    dbMock.store.addCatalog({
      id,
      kind: "skills",
      stableId: id,
      name: `Skill ${id}`,
      config,
    })
  }

  function seedOffer(
    id: string,
    options: Array<{ definitionId: string }>
  ): void {
    dbMock.store.skillOffers.push({
      id,
      characterId: "chr-1",
      track: "class",
      level: 4,
      choiceGroup: "standard",
      generation: 0,
      canceledAt: null,
      selectedDefinitionId: null,
      offeredAt: new Date(),
      selectedAt: null,
    })
    for (const o of options) {
      dbMock.store.skillOfferOptions.push({
        id: `opt-${id}-${o.definitionId}`,
        offerId: id,
        definitionId: o.definitionId,
        nameSnapshot: `Skill ${o.definitionId}`,
        configSnapshot: {},
      })
    }
  }

  it("rejects a select whose target is not strictly higher than the removed link", async () => {
    seedClassCatalog()
    seedCharacterForSkill(0, 0)
    seedSkill("sk-low", {
      track: "class",
      milestone: 4,
      upgradeGroup: "tier",
      rarity: "Uncommon",
      effects: [],
    })
    seedSkill("sk-high", {
      track: "class",
      milestone: 4,
      upgradeGroup: "tier",
      rarity: "Common",
      effects: [],
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "sk-low",
      kind: "SKILL",
    })
    seedOffer("off-1", [{ definitionId: "sk-high" }])
    await expect(
      skillCharacter(
        "chr-1",
        {
          operation: "select",
          offerId: "off-1",
          definitionId: "sk-high",
          version: 0,
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "skill_rarity_not_higher" })
    // Nothing was written: sk-low stays, the offer stays pending, no event.
    expect(
      dbMock.store.associations.filter(
        (a) => a.definitionId === "sk-high" && a.kind === "SKILL"
      )
    ).toHaveLength(0)
    expect(dbMock.store.skillOffers[0].selectedDefinitionId).toBeNull()
    expect(dbMock.store.events).toHaveLength(0)
  })

  it("rejects a select whose target has no ordered rarity", async () => {
    seedClassCatalog()
    seedCharacterForSkill(0, 0)
    seedSkill("sk-low", {
      track: "class",
      milestone: 4,
      upgradeGroup: "tier",
      rarity: "Common",
      effects: [],
    })
    seedSkill("sk-no-rar", {
      track: "class",
      milestone: 4,
      upgradeGroup: "tier",
      effects: [],
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "sk-low",
      kind: "SKILL",
    })
    seedOffer("off-1", [{ definitionId: "sk-no-rar" }])
    await expect(
      skillCharacter(
        "chr-1",
        {
          operation: "select",
          offerId: "off-1",
          definitionId: "sk-no-rar",
          version: 0,
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "skill_rarity_not_higher" })
  })

  it("rejects a select that would remove an incomparable (Unique) linked skill", async () => {
    seedClassCatalog()
    seedCharacterForSkill(0, 0)
    seedSkill("sk-unique", {
      track: "class",
      milestone: 4,
      upgradeGroup: "tier",
      rarity: "Unique",
      effects: [],
    })
    seedSkill("sk-high", {
      track: "class",
      milestone: 4,
      upgradeGroup: "tier",
      rarity: "Sacred",
      effects: [],
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "sk-unique",
      kind: "SKILL",
    })
    seedOffer("off-1", [{ definitionId: "sk-high" }])
    await expect(
      skillCharacter(
        "chr-1",
        {
          operation: "select",
          offerId: "off-1",
          definitionId: "sk-high",
          version: 0,
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "skill_rarity_not_higher" })
  })

  it("leaves skills with no group untouched (they stack, no guard)", async () => {
    seedClassCatalog()
    seedCharacterForSkill(0, 0)
    seedSkill("sk-a", {
      track: "class",
      milestone: 4,
      rarity: "Rare",
      effects: [],
    })
    seedSkill("sk-b", {
      track: "class",
      milestone: 4,
      rarity: "Epic",
      effects: [],
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "sk-a",
      kind: "SKILL",
    })
    // Both are offer options; sk-a is already linked, sk-b is not. Selecting sk-b
    // has no upgrade group, so no same-group removal is attempted and no rarity
    // guard applies.
    seedOffer("off-1", [{ definitionId: "sk-b" }])
    const res = await skillCharacter(
      "chr-1",
      {
        operation: "select",
        offerId: "off-1",
        definitionId: "sk-b",
        version: 0,
      },
      user
    )
    const skills = res.character.associations
      .filter((a) => a.kind === "skill")
      .map((a) => a.definitionId)
    expect(skills).toEqual(["sk-a", "sk-b"])
  })
})

describe("house rules threading (admin-editable defaults)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function seedDefaultRules() {
    dbMock.store.addHouseRules({
      id: "active",
      version: 0,
      config: DEFAULT_HOUSE_RULES_CONFIG,
    })
  }

  function seedClassCatalog() {
    dbMock.store.addCatalog({
      id: "cls-1",
      kind: "classes",
      stableId: "archer",
      name: "Archer",
      config: { grades: { F: { fixed: { agility: 2 }, free: 1 } } },
    })
  }

  function integratedState(): unknown {
    return serializeState(createInitialState("integrated", null, null))
  }

  function seedCharacter(overrides: Record<string, unknown> = {}): unknown {
    return dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      classId: "cls-1",
      state: integratedState(),
      version: 0,
      ...(overrides as Record<string, unknown>),
    })
  }

  it("equipment applied/suppressed reflects a lowered individual cap after a rule edit", async () => {
    seedDefaultRules()
    const state = createInitialState("integrated", null, null)
    state.baseAttributes.strength = 100
    dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      state: serializeState(state),
      version: 0,
    })
    dbMock.store.addCatalog({
      id: "gear-1",
      kind: "equipment",
      stableId: "gear-1",
      name: "Gear",
      config: { slot: "head", bonus: { strength: 10 } },
    })
    dbMock.store.addInventoryItem({
      characterId: "chr-1",
      definitionId: "gear-1",
      quantity: 10,
    })
    const before = await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "gear-1",
        operation: "add",
        version: 0,
      },
      user
    )
    const beforeItem = before.character.status!.equipment.items[0]
    expect(before.character.rulesetVersion).toBe(0)
    expect(beforeItem.applied.strength).toBe(10)
    expect(beforeItem.suppressed.strength).toBe(0)

    // The service reloads house rules per request, so a lowered individual cap is
    // reflected on the NEXT read with no re-association - live status is derived
    // from the current config.
    dbMock.store.addHouseRules({
      id: "active",
      version: 1,
      config: {
        ...DEFAULT_HOUSE_RULES_CONFIG,
        equipmentIndividualCapPercent: 5,
      },
    })
    const after = await getCharacter("chr-1", user)
    const afterItem = after.status!.equipment.items[0]
    expect(after.rulesetVersion).toBe(1)
    expect(afterItem.applied.strength).toBe(5)
    expect(afterItem.suppressed.strength).toBe(5)
    // The stored state is never rewritten by a rule change.
    expect(
      (after.state as { baseAttributes: { strength: number } }).baseAttributes
        .strength
    ).toBe(100)
    expect(after.associations.map((a) => a.definitionId)).toEqual(["gear-1"])
  })

  it("lowers permanent-consumable remaining when the grade rate drops", async () => {
    seedDefaultRules()
    const state = createInitialState("born", null, null)
    state.race = { ...state.race, level: 10, grade: "F" as Grade }
    state.permanentGains.push({
      id: "cons-0",
      source: "consumable",
      kind: "consumable",
      vector: { strength: 10 },
      requested: { strength: 10 },
      gradeAtApplication: "F",
      raceLevelAtApplication: 10,
      capRemainingAfter: { strength: 20 },
      appliedAt: 0,
    })
    dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      state: serializeState(state),
      version: 0,
      origin: "born",
    })

    const before = await getCharacter("chr-1", user)
    expect(before.permanentConsumableCap).toMatchObject({ strength: 30 })
    expect(before.permanentConsumableRemaining).toMatchObject({ strength: 20 })

    // Lower the F rate from 3 to 2: capacity is re-derived, the already-earned
    // immutable gain stays, and the remaining capacity clamps to the new ceiling.
    dbMock.store.addHouseRules({
      id: "active",
      version: 1,
      config: {
        ...DEFAULT_HOUSE_RULES_CONFIG,
        consumableGradeRates: {
          ...DEFAULT_HOUSE_RULES_CONFIG.consumableGradeRates,
          F: 2,
        },
      },
    })
    const after = await getCharacter("chr-1", user)
    expect(after.permanentConsumableCap).toMatchObject({ strength: 20 })
    expect(after.permanentConsumableRemaining).toMatchObject({ strength: 10 })
  })

  it("never rewrites historical awards when the house rules change", async () => {
    seedDefaultRules()
    seedClassCatalog()
    seedCharacter()
    // Advance the class track four quarters to snapshot one historical award.
    let detail = await advanceCharacter(
      "chr-1",
      { track: "class", version: 0 },
      user
    )
    for (let v = 1; v < 4; v++) {
      detail = await advanceCharacter(
        "chr-1",
        { track: "class", version: v },
        user
      )
    }
    const beforeState = detail.character.state
    const beforeAwards = (
      beforeState as {
        historicalLevelAwards: Array<{ track: string; free: number }>
      }
    ).historicalLevelAwards
    expect(beforeAwards.length).toBe(1)

    // Changing both house-rule knobs must not touch the stored, snapshotted awards.
    dbMock.store.addHouseRules({
      id: "active",
      version: 1,
      config: {
        ...DEFAULT_HOUSE_RULES_CONFIG,
        equipmentIndividualCapPercent: 5,
        consumableGradeRates: {
          ...DEFAULT_HOUSE_RULES_CONFIG.consumableGradeRates,
          F: 2,
        },
      },
    })
    const after = await getCharacter("chr-1", user)
    expect(after.version).toBe(detail.character.version)
    expect(after.state).toEqual(beforeState)
    const afterAwards = (
      after.state as {
        historicalLevelAwards: Array<{ track: string; free: number }>
      }
    ).historicalLevelAwards
    expect(afterAwards).toEqual(beforeAwards)
    expect(afterAwards[0]).toMatchObject({ track: "class" })
  })
})

describe("listCatalog (archived visibility)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function seedRace(id: string, extra: Partial<{ archived: boolean }> = {}) {
    return dbMock.store.addCatalog({
      id,
      kind: "races",
      stableId: id,
      name: `Race ${id}`,
      config: {},
      ...(extra.archived != null ? { archived: extra.archived } : {}),
    })
  }

  it("default list returns only active definitions", async () => {
    seedRace("race-active")
    seedRace("race-archived", { archived: true })

    const items = await listCatalog("races")
    expect(items.map((i) => i.stableId)).toEqual(["race-active"])
    expect(items.every((i) => i.archived === false)).toBe(true)
  })

  it("includeArchived:true returns both active and archived definitions", async () => {
    seedRace("race-active")
    seedRace("race-archived", { archived: true })

    const items = await listCatalog("races", { includeArchived: true })
    const ids = items.map((i) => i.stableId).sort()
    expect(ids).toEqual(["race-active", "race-archived"])
    expect(items.find((i) => i.stableId === "race-archived")?.archived).toBe(
      true
    )
  })

  it("includeArchived:false (explicit) behaves like the default (active-only)", async () => {
    seedRace("race-active")
    seedRace("race-archived", { archived: true })

    const items = await listCatalog("races", { includeArchived: false })
    expect(items.map((i) => i.stableId)).toEqual(["race-active"])
  })

  it("only returns definitions of the requested kind even with includeArchived", async () => {
    seedRace("race-active")
    dbMock.store.addCatalog({
      id: "title-archived",
      kind: "titles",
      stableId: "title-archived",
      name: "Title archived",
      config: {},
      archived: true,
    })

    const items = await listCatalog("races", { includeArchived: true })
    const ids = items.map((i) => i.stableId).sort()
    expect(ids).toEqual(["race-active"])
  })
})

describe("character inventory (owner-managed quantities)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function seedState() {
    const state = createInitialState("integrated", null, null)
    return dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      state: serializeState(state),
      version: 0,
    })
  }

  function seedCatalog(
    id: string,
    kind: string,
    config: Record<string, unknown>,
    extra: Partial<{ name: string; archived: boolean }> = {}
  ): unknown {
    return dbMock.store.addCatalog({
      id,
      kind,
      stableId: id,
      name: extra.name ?? `${kind} ${id}`,
      config,
      ...(extra.archived != null ? { archived: extra.archived } : {}),
    })
  }

  function seedEquipment(
    id: string,
    config: Record<string, unknown>,
    extra: Partial<{ name: string; archived: boolean }> = {}
  ): unknown {
    return seedCatalog(id, "equipment", config, extra)
  }

  function seedConsumable(
    id: string,
    config: Record<string, unknown>,
    extra: Partial<{ name: string; archived: boolean }> = {}
  ): unknown {
    return seedCatalog(id, "items", config, extra)
  }

  function seedStock(definitionId: string, quantity: number) {
    return dbMock.store.addInventoryItem({
      characterId: "chr-1",
      definitionId,
      quantity,
    })
  }

  const other = { id: "user-2", email: "x@y", isAdmin: false }

  function addBody(overrides: Record<string, unknown> = {}) {
    return {
      operation: "add" as const,
      definitionId: "gear-1" as const,
      quantity: 1,
      version: 0,
      sourceNote: "bookkeeping",
      ...overrides,
    }
  }

  it("lets an owner add and remove inventory, and rejects a non-owner", async () => {
    seedState()
    seedEquipment("gear-1", { slot: "head" })
    const res = await adjustCharacterInventory("chr-1", addBody(), user)
    expect(res.version).toBe(1)
    expect(res.inventory).toHaveLength(1)
    expect(res.inventory[0]).toMatchObject({
      definitionId: "gear-1",
      quantity: 1,
      kind: "equipment",
    })

    const res2 = await adjustCharacterInventory(
      "chr-1",
      {
        operation: "remove",
        definitionId: "gear-1",
        quantity: 1,
        version: 1,
        sourceNote: "spent",
      },
      user
    )
    expect(res2.inventory).toHaveLength(0)
    expect(res2.version).toBe(2)

    await expect(
      adjustCharacterInventory("chr-1", addBody({ version: 2 }), other)
    ).rejects.toMatchObject({ status: 403, code: "forbidden" })
  })

  it("lets an admin adjust any character and read any character's inventory", async () => {
    seedState()
    seedEquipment("gear-1", { slot: "head" })
    const admin = { ...user, isAdmin: true }
    const res = await adjustCharacterInventory("chr-1", addBody(), admin)
    expect(res.inventory).toHaveLength(1)
    await expect(getCharacterInventory("chr-1", admin)).resolves.toMatchObject({
      version: 1,
    })
  })

  it("reads a character's inventory with the current version", async () => {
    seedState()
    seedConsumable("pot-1", { type: "permanent", amount: { strength: 1 } })
    seedStock("pot-1", 2)
    const { inventory, version } = await getCharacterInventory("chr-1", user)
    expect(version).toBe(0)
    expect(inventory).toHaveLength(1)
    expect(inventory[0]).toMatchObject({
      definitionId: "pot-1",
      quantity: 2,
      kind: "items",
    })
    await expect(getCharacterInventory("chr-1", other)).rejects.toMatchObject({
      status: 403,
    })
  })

  it("rejects an add that would exceed the 999999 cap", async () => {
    seedState()
    seedEquipment("gear-1", { slot: "head" })
    const res = await adjustCharacterInventory(
      "chr-1",
      addBody({ quantity: 999999 }),
      user
    )
    expect(res.inventory[0].quantity).toBe(999999)
    await expect(
      adjustCharacterInventory(
        "chr-1",
        addBody({ quantity: 1, version: 1 }),
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "inventory_cap_exceeded" })
    // The failed cap write never mutated anything.
    expect(dbMock.store.inventory[0].quantity).toBe(999999)
    expect(dbMock.store.characters.get("chr-1")!.version).toBe(1)
    expect(dbMock.store.events).toHaveLength(1)
  })

  it("removing the final unit deletes the row", async () => {
    seedState()
    seedConsumable("pot-1", { type: "permanent", amount: { strength: 1 } })
    seedStock("pot-1", 1)
    const res = await adjustCharacterInventory(
      "chr-1",
      {
        operation: "remove",
        definitionId: "pot-1",
        quantity: 1,
        version: 0,
        sourceNote: "x",
      },
      user
    )
    expect(res.inventory).toHaveLength(0)
    expect(dbMock.store.inventory).toHaveLength(0)
  })

  it("rejects removing the final unit while the item is equipped (inventory_equipped, no auto-unequip)", async () => {
    seedState()
    seedEquipment("gear-1", { slot: "head" })
    seedStock("gear-1", 1)
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "gear-1",
      kind: "EQUIPMENT",
      legacyUnowned: false,
    })
    await expect(
      adjustCharacterInventory(
        "chr-1",
        {
          operation: "remove",
          definitionId: "gear-1",
          quantity: 1,
          version: 0,
          sourceNote: "spent",
        },
        user
      )
    ).rejects.toMatchObject({ status: 409, code: "inventory_equipped" })
    // No auto-unequip: the link stays, the stock row survives untouched, the CAS
    // version never bumps, and no journal event is written.
    expect(dbMock.store.associations).toHaveLength(1)
    expect(dbMock.store.inventory).toHaveLength(1)
    expect(dbMock.store.inventory[0].quantity).toBe(1)
    expect(dbMock.store.characters.get("chr-1")!.version).toBe(0)
    expect(dbMock.store.events).toHaveLength(0)
  })

  it("allows removing all but one unit while equipped (count > 1 may decrease to 1)", async () => {
    seedState()
    seedEquipment("gear-1", { slot: "head" })
    seedStock("gear-1", 3)
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "gear-1",
      kind: "EQUIPMENT",
      legacyUnowned: false,
    })
    const res = await adjustCharacterInventory(
      "chr-1",
      {
        operation: "remove",
        definitionId: "gear-1",
        quantity: 2,
        version: 0,
        sourceNote: "spent",
      },
      user
    )
    expect(res.inventory).toHaveLength(1)
    expect(res.inventory[0].quantity).toBe(1)
    expect(res.version).toBe(1)
    expect(dbMock.store.associations).toHaveLength(1)
    expect(dbMock.store.events).toHaveLength(1)
  })

  it("rejects removing the final equipped unit even when the linked definition is archived", async () => {
    seedState()
    seedEquipment("gear-1", { slot: "head" }, { archived: true })
    seedStock("gear-1", 1)
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "gear-1",
      kind: "EQUIPMENT",
      legacyUnowned: false,
    })
    await expect(
      adjustCharacterInventory(
        "chr-1",
        {
          operation: "remove",
          definitionId: "gear-1",
          quantity: 1,
          version: 0,
          sourceNote: "spent",
        },
        user
      )
    ).rejects.toMatchObject({ status: 409, code: "inventory_equipped" })
    expect(dbMock.store.inventory[0].quantity).toBe(1)
  })

  it("rejects removing the final unit while equipped even on a grandfathered legacy link that owns stock", async () => {
    seedState()
    seedEquipment("gear-1", { slot: "head" })
    seedStock("gear-1", 1)
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "gear-1",
      kind: "EQUIPMENT",
      legacyUnowned: true,
    })
    await expect(
      adjustCharacterInventory(
        "chr-1",
        {
          operation: "remove",
          definitionId: "gear-1",
          quantity: 1,
          version: 0,
          sourceNote: "spent",
        },
        user
      )
    ).rejects.toMatchObject({ status: 409, code: "inventory_equipped" })
    expect(dbMock.store.associations[0].legacyUnowned).toBe(true)
    expect(dbMock.store.inventory[0].quantity).toBe(1)
  })

  it("removing the final unit while NOT equipped still deletes the row", async () => {
    seedState()
    seedEquipment("gear-1", { slot: "head" })
    seedStock("gear-1", 1)
    const res = await adjustCharacterInventory(
      "chr-1",
      {
        operation: "remove",
        definitionId: "gear-1",
        quantity: 1,
        version: 0,
        sourceNote: "spent",
      },
      user
    )
    expect(res.inventory).toHaveLength(0)
    expect(dbMock.store.inventory).toHaveLength(0)
  })

  it("rejects a remove beyond owned stock", async () => {
    seedState()
    seedConsumable("pot-1", { type: "permanent", amount: { strength: 1 } })
    seedStock("pot-1", 2)
    await expect(
      adjustCharacterInventory(
        "chr-1",
        {
          operation: "remove",
          definitionId: "pot-1",
          quantity: 3,
          version: 0,
          sourceNote: "x",
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "inventory_insufficient" })
    expect(dbMock.store.inventory[0].quantity).toBe(2)
    expect(dbMock.store.characters.get("chr-1")!.version).toBe(0)
    expect(dbMock.store.events).toHaveLength(0)
  })

  it("rejects adding an archived definition but permits removing owned archived stock", async () => {
    seedState()
    seedConsumable(
      "pot-1",
      { type: "permanent", amount: { strength: 1 } },
      { archived: true }
    )
    seedStock("pot-1", 2)
    await expect(
      adjustCharacterInventory(
        "chr-1",
        addBody({ definitionId: "pot-1" }),
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "catalog_archived" })
    const res = await adjustCharacterInventory(
      "chr-1",
      {
        operation: "remove",
        definitionId: "pot-1",
        quantity: 1,
        version: 0,
        sourceNote: "x",
      },
      user
    )
    expect(res.inventory).toHaveLength(1)
    expect(res.inventory[0].quantity).toBe(1)
  })

  it("rejects an archived character adjustment", async () => {
    seedState()
    dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      state: serializeState(createInitialState("integrated", null, null)),
      version: 0,
      archived: true,
    })
    seedEquipment("gear-1", { slot: "head" })
    await expect(
      adjustCharacterInventory("chr-1", addBody(), user)
    ).rejects.toMatchObject({ status: 400, code: "character_archived" })
  })

  it("rejects a stale version (409) and rolls back the inventory change and journal", async () => {
    seedState()
    seedEquipment("gear-1", { slot: "head" })
    seedStock("gear-1", 5)
    const first = await adjustCharacterInventory(
      "chr-1",
      addBody({ quantity: 2 }),
      user
    )
    expect(first.inventory[0].quantity).toBe(7)
    expect(dbMock.store.events).toHaveLength(1)
    await expect(
      adjustCharacterInventory(
        "chr-1",
        addBody({ quantity: 1, version: 0 }),
        user
      )
    ).rejects.toMatchObject({ status: 409, code: "version_conflict" })
    expect(dbMock.store.characters.get("chr-1")!.version).toBe(1)
    expect(dbMock.store.inventory).toHaveLength(1)
    expect(dbMock.store.inventory[0].quantity).toBe(7)
    expect(dbMock.store.events).toHaveLength(1)
  })

  it("journals an inventory_adjust event with prior/new quantity, definition and actor", async () => {
    seedState()
    seedEquipment("gear-1", { slot: "head" })
    seedStock("gear-1", 3)
    await adjustCharacterInventory("chr-1", addBody({ quantity: 2 }), user)
    const event = dbMock.store.events[0]
    expect(event.kind).toBe("inventory_adjust")
    expect(event.payload).toMatchObject({
      operation: "add",
      definitionId: "gear-1",
      quantity: 2,
      priorQuantity: 3,
      newQuantity: 5,
      sourceNote: "bookkeeping",
      actorId: user.id,
    })
    expect(
      (event.payload as { definition: { name: string } }).definition.name
    ).toBe("equipment gear-1")
  })

  it("requires owned stock for an equipment add (inventory_insufficient)", async () => {
    seedState()
    seedEquipment("gear-1", { slot: "head" })
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "equipment",
          definitionId: "gear-1",
          operation: "add",
          version: 0,
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "inventory_insufficient" })
    seedStock("gear-1", 1)
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "gear-1",
        operation: "add",
        version: 0,
      },
      user
    )
    expect(res.character.associations).toHaveLength(1)
    const assoc = dbMock.store.associations.find(
      (a) => a.definitionId === "gear-1"
    )
    expect(assoc!.legacyUnowned).toBe(false)
  })

  it("keeps a grandfathered EQUIPMENT link equipped and removable with zero stock", async () => {
    seedState()
    seedEquipment("gear-1", { slot: "head" })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "gear-1",
      kind: "EQUIPMENT",
      legacyUnowned: true,
    })
    const detail = await getCharacter("chr-1", user)
    expect(detail.associations).toHaveLength(1)
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "gear-1",
        operation: "remove",
        version: 0,
      },
      user
    )
    expect(res.character.associations).toHaveLength(0)
  })

  it("slot swap unlinks the old item but leaves its stock intact", async () => {
    seedState()
    seedEquipment("gear-1", { slot: "head", bonus: { strength: 10 } })
    seedEquipment("gear-2", { slot: "head", bonus: { strength: 20 } })
    seedStock("gear-1", 3)
    seedStock("gear-2", 1)
    await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "gear-1",
        operation: "add",
        version: 0,
      },
      user
    )
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "gear-2",
        operation: "add",
        version: 1,
      },
      user
    )
    expect(res.character.associations.map((a) => a.definitionId)).toEqual([
      "gear-2",
    ])
    expect(
      dbMock.store.inventory.find((i) => i.definitionId === "gear-1")!.quantity
    ).toBe(3)
    expect(
      dbMock.store.inventory.find((i) => i.definitionId === "gear-2")!.quantity
    ).toBe(1)
  })

  it("adjusting inventory quantity does not change live status or state", async () => {
    seedState()
    seedEquipment("gear-1", { slot: "head", bonus: { strength: 10 } })
    const before = await getCharacter("chr-1", user)
    seedStock("gear-1", 5)
    const res = await adjustCharacterInventory(
      "chr-1",
      addBody({ quantity: 3 }),
      user
    )
    expect(res.character.status?.attributes).toEqual(before.status?.attributes)
    expect(res.character.state).toEqual(before.state)
    expect(res.character.inventory).toHaveLength(1)
  })
})

describe("setCharacterProfession (set-once profession)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function seedIntegratedCharacter(
    overrides: Record<string, unknown> = {}
  ): unknown {
    const state = createInitialState("integrated", null, null)
    return dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      state: serializeState(state),
      version: 0,
      ...overrides,
    })
  }

  function seedBornCharacter(grade: Grade): unknown {
    const raceRow = {
      kind: "races",
      stableId: "human",
      name: "Human",
      config: { raceType: "enlightened", naturalGrade: grade },
    }
    const state = createInitialState("born", raceRow, null)
    return dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      state: serializeState(state),
      version: 0,
      origin: "born",
    })
  }

  function seedMonsterCharacter(): unknown {
    const raceRow = {
      kind: "races",
      stableId: "wyrm",
      name: "Wyrm",
      config: { raceType: "monster", naturalGrade: "F" },
    }
    const state = createInitialState("born", raceRow, null)
    return dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      state: serializeState(state),
      version: 0,
      origin: "born",
    })
  }

  function seedProfession(
    id: string,
    grade: Grade,
    opts: {
      name?: string
      archived?: boolean
      grades?: Record<string, unknown>
    } = {}
  ): unknown {
    return dbMock.store.addCatalog({
      id,
      kind: "professions",
      stableId: id,
      name: opts.name ?? `Prof ${id}`,
      grade,
      config: {
        grades: opts.grades ?? { [grade]: { fixed: { wisdom: 1 }, free: 0 } },
      },
      ...(opts.archived != null ? { archived: opts.archived } : {}),
    })
  }

  const otherUser = { id: "user-2", email: "other@example.com", isAdmin: false }
  const adminUser = { id: "user-3", email: "admin@example.com", isAdmin: true }

  it("sets the profession at the character's current grade (integrated G) with a profession_set event and no awards", async () => {
    seedIntegratedCharacter()
    seedProfession("prof-g", "G")
    const res = await setCharacterProfession(
      "chr-1",
      { professionId: "prof-g", version: 0 },
      user
    )
    expect(res.character.professionId).toBe("prof-g")
    expect(res.character.professionName).toBe("Prof prof-g")
    expect(res.character.version).toBe(1)
    const state = deserializeState(res.character.state)
    expect(state.tracks.profession).toEqual({
      level: 0,
      quarter: 0,
      grade: "G",
      definitionId: "prof-g:G",
    })
    // The class track and the race grade are untouched; no level award was invented.
    expect(state.tracks.class).toEqual(
      createInitialState("integrated", null, null).tracks.class
    )
    expect(state.race.grade).toBe("G")
    expect(state.historicalLevelAwards).toHaveLength(0)
    // Exactly one event, kind profession_set, with the stable identity and a
    // before/after snapshot, and no awards payload.
    expect(dbMock.store.events).toHaveLength(1)
    const ev = dbMock.store.events[0]
    expect(ev.kind).toBe("profession_set")
    const payload = ev.payload as Record<string, unknown>
    expect(payload).not.toHaveProperty("awards")
    expect(payload.professionId).toBe("prof-g")
    expect(payload.profession).toEqual({
      id: "prof-g",
      name: "Prof prof-g",
      stableId: "prof-g",
      grade: "G",
    })
    expect(payload.before).toEqual({ professionId: null, track: null })
    expect(payload.after).toMatchObject({
      professionId: "prof-g",
      track: { level: 0, quarter: 0, grade: "G", definitionId: "prof-g:G" },
    })
  })

  it("sets the profession at the current grade for a born B character", async () => {
    seedBornCharacter("B")
    seedProfession("prof-b", "B")
    const res = await setCharacterProfession(
      "chr-1",
      { professionId: "prof-b", version: 0 },
      user
    )
    expect(res.character.professionId).toBe("prof-b")
    const state = deserializeState(res.character.state)
    expect(state.tracks.profession).toEqual({
      level: 0,
      quarter: 0,
      grade: "B",
      definitionId: "prof-b:B",
    })
  })

  it("rejects a monster race (no class track) with profession_requires_class", async () => {
    seedMonsterCharacter()
    seedProfession("prof-f", "F")
    await expect(
      setCharacterProfession(
        "chr-1",
        { professionId: "prof-f", version: 0 },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "profession_requires_class" })
    expect(dbMock.store.events).toHaveLength(0)
  })

  it("rejects a classless imported character (no class track) with profession_requires_class", async () => {
    const state = createInitialState("integrated", null, null)
    state.tracks = {}
    dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      state: serializeState(state),
      version: 0,
    })
    seedProfession("prof-g", "G")
    await expect(
      setCharacterProfession(
        "chr-1",
        { professionId: "prof-g", version: 0 },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "profession_requires_class" })
    expect(dbMock.store.events).toHaveLength(0)
  })

  it("rejects an archived profession definition with catalog_archived", async () => {
    seedIntegratedCharacter()
    seedProfession("prof-g", "G", { archived: true })
    await expect(
      setCharacterProfession(
        "chr-1",
        { professionId: "prof-g", version: 0 },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "catalog_archived" })
    expect(dbMock.store.events).toHaveLength(0)
  })

  it("rejects a profession graded at a different grade than the character's current race grade", async () => {
    seedIntegratedCharacter()
    seedProfession("prof-f", "F")
    await expect(
      setCharacterProfession(
        "chr-1",
        { professionId: "prof-f", version: 0 },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "profession_grade_mismatch" })
    expect(dbMock.store.events).toHaveLength(0)
  })

  it("rejects a profession carrying no per-level config for the current grade (no grades.G)", async () => {
    seedIntegratedCharacter()
    seedProfession("prof-g", "G", {
      grades: { F: { fixed: { wisdom: 1 }, free: 0 } },
    })
    await expect(
      setCharacterProfession(
        "chr-1",
        { professionId: "prof-g", version: 0 },
        user
      )
    ).rejects.toMatchObject({
      status: 400,
      code: "profession_grade_config_missing",
    })
    expect(dbMock.store.events).toHaveLength(0)
  })

  it("rejects a second set when the character already carries a professionId (set once)", async () => {
    seedIntegratedCharacter({ professionId: "prof-other" })
    seedProfession("prof-g", "G")
    await expect(
      setCharacterProfession(
        "chr-1",
        { professionId: "prof-g", version: 0 },
        user
      )
    ).rejects.toMatchObject({ status: 409, code: "profession_already_set" })
    expect(dbMock.store.events).toHaveLength(0)
  })

  it("rejects a second set when the state already carries a profession track (set once)", async () => {
    const state = createInitialState("integrated", null, null)
    state.tracks.profession = { level: 0, quarter: 0, definitionId: "prof:F" }
    dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      state: serializeState(state),
      version: 0,
    })
    seedProfession("prof-g", "G")
    await expect(
      setCharacterProfession(
        "chr-1",
        { professionId: "prof-g", version: 0 },
        user
      )
    ).rejects.toMatchObject({ status: 409, code: "profession_already_set" })
    expect(dbMock.store.events).toHaveLength(0)
  })

  it("rejects a stale version (CAS) with version_conflict and writes no event", async () => {
    seedIntegratedCharacter()
    seedProfession("prof-g", "G")
    await expect(
      setCharacterProfession(
        "chr-1",
        { professionId: "prof-g", version: 99 },
        user
      )
    ).rejects.toMatchObject({ status: 409, code: "version_conflict" })
    const fresh = dbMock.store.characters.get("chr-1")!
    expect(fresh.version).toBe(0)
    expect(fresh.professionId).toBeNull()
    expect(dbMock.store.events).toHaveLength(0)
  })

  it("maps a serialization failure (P2034) to 409 catalog_serialization_conflict", async () => {
    seedIntegratedCharacter()
    seedProfession("prof-g", "G")
    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce({
      name: "PrismaClientKnownRequestError",
      code: "P2034",
    })
    try {
      await expect(
        setCharacterProfession(
          "chr-1",
          { professionId: "prof-g", version: 0 },
          user
        )
      ).rejects.toMatchObject({
        status: 409,
        code: "catalog_serialization_conflict",
      })
    } finally {
      spy.mockRestore()
    }
  })

  it("lets an admin set a profession on a character owned by another user", async () => {
    seedIntegratedCharacter()
    seedProfession("prof-g", "G")
    const res = await setCharacterProfession(
      "chr-1",
      { professionId: "prof-g", version: 0 },
      adminUser
    )
    expect(res.character.professionId).toBe("prof-g")
    expect(dbMock.store.events).toHaveLength(1)
  })

  it("rejects a non-owner non-admin caller with 403", async () => {
    seedIntegratedCharacter()
    seedProfession("prof-g", "G")
    await expect(
      setCharacterProfession(
        "chr-1",
        { professionId: "prof-g", version: 0 },
        otherUser
      )
    ).rejects.toMatchObject({ status: 403, code: "forbidden" })
    expect(dbMock.store.events).toHaveLength(0)
  })

  it("leaves the class/race tracks and the historical ledger untouched and grants no awards", async () => {
    const state = createInitialState("integrated", null, null)
    state.tracks.class = {
      level: 3,
      quarter: 2,
      definitionId: "archer:F",
      grade: "F",
    }
    state.race = { ...state.race, level: 7 }
    state.historicalLevelAwards = [
      {
        track: "class",
        level: 2,
        definitionId: "archer:F",
        fixed: allEqual(2),
        free: 1,
      },
    ]
    dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      state: serializeState(state),
      version: 0,
    })
    seedProfession("prof-g", "G")
    const res = await setCharacterProfession(
      "chr-1",
      { professionId: "prof-g", version: 0 },
      user
    )
    const after = deserializeState(res.character.state)
    expect(after.tracks.class).toEqual(state.tracks.class)
    expect(after.race.level).toBe(7)
    expect(after.race.grade).toBe("G")
    expect(after.historicalLevelAwards).toEqual(state.historicalLevelAwards)
    expect(after.tracks.profession).toEqual({
      level: 0,
      quarter: 0,
      grade: "G",
      definitionId: "prof-g:G",
    })
    // Exactly one event and it is the profession_set journal; no zero award.
    expect(dbMock.store.events).toHaveLength(1)
    expect(dbMock.store.events[0].kind).toBe("profession_set")
    expect(
      (dbMock.store.events[0].payload as Record<string, unknown>).after
    ).toMatchObject({
      track: { level: 0, quarter: 0, grade: "G", definitionId: "prof-g:G" },
    })
  })
})

describe("equipment requirements / rarity / soulbound metadata", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function seedCharacter(
    raceLevel: number,
    opts: { raceId?: string | null; raceMode?: "derived" | "independent" } = {}
  ): unknown {
    const state = createInitialState("integrated", null, null)
    state.race = { ...state.race, level: raceLevel }
    if (opts.raceMode) state.race = { ...state.race, mode: opts.raceMode }
    state.baseAttributes = { ...state.baseAttributes, strength: 1000 }
    return dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      state: serializeState(state),
      version: 0,
      raceId: opts.raceId ?? null,
    })
  }

  function seedRace(id: string, config: Record<string, unknown>): unknown {
    return dbMock.store.addCatalog({
      id,
      kind: "races",
      stableId: id,
      name: `Race ${id}`,
      config,
    })
  }

  function seedEquipment(id: string, config: Record<string, unknown>): unknown {
    return dbMock.store.addCatalog({
      id,
      kind: "equipment",
      stableId: id,
      name: `Gear ${id}`,
      config,
    })
  }

  function seedStock(definitionId: string, quantity = 10): unknown {
    return dbMock.store.addInventoryItem({
      characterId: "chr-1",
      definitionId,
      quantity,
    })
  }

  it("rejects equipping an item whose requirement is unmet (400) and leaves stock untouched", async () => {
    seedCharacter(1)
    seedEquipment("gear-1", {
      slot: "Weapon",
      rarity: "Common",
      bonus: { strength: 30 },
      minRaceLevel: 5,
    })
    seedStock("gear-1", 3)
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "equipment",
          definitionId: "gear-1",
          operation: "add",
          version: 0,
        },
        user
      )
    ).rejects.toMatchObject({
      status: 400,
      code: "equipment_requirements_unmet",
    })
    // No link was created and no stock was mutated.
    expect(dbMock.store.associations).toHaveLength(0)
    const inv = await getCharacterInventory("chr-1", user)
    expect(inv.inventory).toHaveLength(1)
    expect(inv.inventory[0].quantity).toBe(3)
  })

  it("keeps a linked item but does not synthesize its bonus when its requirement is unmet, then requalifies", async () => {
    seedCharacter(1)
    seedEquipment("sword", {
      slot: "Weapon",
      rarity: "Common",
      bonus: { strength: 30 },
    })
    seedStock("sword")
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "sword",
        operation: "add",
        version: 0,
      },
      user
    )
    // Initially eligible (no minRaceLevel) -> the bonus applies.
    expect(res.character.associations).toHaveLength(1)
    const items = res.character.status?.equipment.items ?? []
    expect(items).toHaveLength(1)
    expect(items[0].applied.strength).toBe(30)

    // Edit in a minimumLevel the character (level 1) does not currently meet.
    await updateCatalogItem("equipment", "sword", {
      config: {
        slot: "Weapon",
        rarity: "Common",
        bonus: { strength: 30 },
        minimumLevel: 5,
        requiredLevelType: "humanoidRace",
      },
    })

    const detail = await getCharacter("chr-1", user)
    // The link is preserved and the item is still shown.
    expect(
      detail.associations.filter((a) => a.kind === "equipment")
    ).toHaveLength(1)
    const inertItems = detail.status?.equipment.items ?? []
    expect(inertItems).toHaveLength(1)
    expect(inertItems[0].requested.strength).toBe(0)
    expect(inertItems[0].applied.strength).toBe(0)

    // Raise the character's race level past the requirement.
    const state = createInitialState("integrated", null, null)
    state.race = { ...state.race, level: 5 }
    state.baseAttributes = { ...state.baseAttributes, strength: 1000 }
    dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      state: serializeState(state),
      version: 1,
    })

    const detail2 = await getCharacter("chr-1", user)
    const requalifiedItems = detail2.status?.equipment.items ?? []
    expect(requalifiedItems).toHaveLength(1)
    expect(requalifiedItems[0].applied.strength).toBe(30)
  })

  it("a legacy alias slot collides with its canonical counterpart on a config edit", async () => {
    seedCharacter(1)
    seedEquipment("gear-1", {
      slot: "head",
      rarity: "Common",
      bonus: { strength: 10 },
    })
    seedEquipment("gear-2", {
      slot: "body",
      rarity: "Common",
      bonus: { strength: 20 },
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "gear-1",
      kind: "EQUIPMENT",
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "gear-2",
      kind: "EQUIPMENT",
    })
    // gear-1 uses the legacy alias `head`; editing gear-2 to the canonical `Head`
    // must collide (both normalize to Head).
    await expect(
      updateCatalogItem("equipment", "gear-2", {
        config: { slot: "Head", rarity: "Common", bonus: { strength: 20 } },
      })
    ).rejects.toMatchObject({ status: 409, code: "link_collision" })
    expect(
      (dbMock.store.catalog.get("gear-2")!.config as { slot: string }).slot
    ).toBe("body")
  })

  it("equipment add replaces a legacy-alias item with a canonical-slot item in the same slot", async () => {
    seedCharacter(1)
    seedEquipment("gear-1", {
      slot: "head",
      rarity: "Common",
      bonus: { strength: 10 },
    })
    seedEquipment("gear-2", {
      slot: "Head",
      rarity: "Common",
      bonus: { strength: 20 },
    })
    seedStock("gear-1")
    seedStock("gear-2")
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "gear-1",
      kind: "EQUIPMENT",
    })
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "gear-2",
        operation: "add",
        version: 0,
      },
      user
    )
    expect(res.character.associations.map((a) => a.definitionId)).toEqual([
      "gear-2",
    ])
  })

  it("distinguishes enlightened vs monster race-type requirements", async () => {
    seedRace("race-monster", {
      raceType: "monster",
      naturalGrade: "F",
      raceDefinitions: {
        F: { id: "race-monster:F", perLevel: allEqual(1), freePerLevel: 5 },
      },
    })
    seedCharacter(1, { raceId: "race-monster", raceMode: "independent" })
    seedEquipment("gear-m", {
      slot: "Weapon",
      rarity: "Common",
      bonus: { strength: 10 },
      requiredRaceType: "monster",
    })
    seedEquipment("gear-e", {
      slot: "Chest",
      rarity: "Common",
      bonus: { strength: 10 },
      requiredRaceType: "enlightened",
    })
    seedStock("gear-m")
    seedStock("gear-e")
    // A monster-required item is eligible for a monster-raced character.
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "gear-m",
        operation: "add",
        version: 0,
      },
      user
    )
    expect(res.character.associations.map((a) => a.definitionId)).toContain(
      "gear-m"
    )
    // An enlightened-required item is ineligible for the same monster character.
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "equipment",
          definitionId: "gear-e",
          operation: "add",
          version: 1,
        },
        user
      )
    ).rejects.toMatchObject({
      status: 400,
      code: "equipment_requirements_unmet",
    })
  })

  it("resolves equipment requirements from race mode for a legacy no-raceType race (eligibility only)", async () => {
    // A legacy race config with no `raceType` key. The character's race mode is
    // the only signal, and it is used for equipment eligibility ONLY - explicit
    // catalog raceType stays authoritative elsewhere.
    seedRace("race-legacy", {
      naturalGrade: "F",
      raceDefinitions: {
        F: { id: "race-legacy:F", perLevel: allEqual(1), freePerLevel: 5 },
      },
    })
    // Independent (monster) mode => monster eligibility.
    seedCharacter(10, { raceId: "race-legacy", raceMode: "independent" })
    seedEquipment("gear-m", {
      slot: "Weapon",
      rarity: "Common",
      bonus: { strength: 10 },
      requiredRaceType: "monster",
    })
    seedEquipment("gear-e", {
      slot: "Chest",
      rarity: "Common",
      bonus: { strength: 10 },
      requiredRaceType: "enlightened",
    })
    seedStock("gear-m")
    seedStock("gear-e")
    // The independent (monster) mode satisfies the monster requirement.
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "gear-m",
        operation: "add",
        version: 0,
      },
      user
    )
    expect(res.character.associations.map((a) => a.definitionId)).toContain(
      "gear-m"
    )
    // Live bonus is synthesized because the requirement is met.
    const items = res.character.status?.equipment.items ?? []
    expect(items).toHaveLength(1)
    expect(items[0].applied.strength).toBe(10)
    // An enlightened-required item is denied for the same independent monster.
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "equipment",
          definitionId: "gear-e",
          operation: "add",
          version: 1,
        },
        user
      )
    ).rejects.toMatchObject({
      status: 400,
      code: "equipment_requirements_unmet",
    })

    // Derived (enlightened) mode on the same legacy race resolves as
    // enlightened: the monster item is denied and the enlightened item allowed.
    seedCharacter(10, { raceId: "race-legacy" })
    const eRes = await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "gear-e",
        operation: "add",
        version: 0,
      },
      user
    )
    expect(eRes.character.associations.map((a) => a.definitionId)).toContain(
      "gear-e"
    )
  })

  it("createCatalogItem requires a canonical slot and a rarity for a new equipment entry", async () => {
    await expect(
      createCatalogItem("equipment", {
        name: "Helm",
        config: { slot: "Head" },
      })
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    await expect(
      createCatalogItem("equipment", {
        name: "Helm",
        config: { rarity: "Common" },
      })
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    await expect(
      createCatalogItem("equipment", {
        name: "Helm",
        config: { slot: "body", rarity: "Common" },
      })
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    const item = await createCatalogItem("equipment", {
      name: "Helm",
      config: { slot: "Head", rarity: "Common", bonus: { strength: 5 } },
    })
    expect(item.config).toMatchObject({
      slot: "Head",
      rarity: "Common",
      bonus: { strength: 5 },
    })
  })

  it("updateCatalogItem rejects a config change that drops the modern equipment shape", async () => {
    seedEquipment("gear-1", { slot: "Head", rarity: "Common" })
    await expect(
      updateCatalogItem("equipment", "gear-1", { config: { slot: "Head" } })
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    // The original config is preserved.
    expect(
      (dbMock.store.catalog.get("gear-1")!.config as { rarity: string }).rarity
    ).toBe("Common")
  })

  it("exposes rarity / soulbound / requirements / eligibility on the detail and inventory views", async () => {
    seedCharacter(1)
    seedEquipment("gear-1", {
      slot: "Weapon",
      rarity: "Ancient",
      soulbound: true,
      minRaceLevel: 5,
      requiredRaceType: "enlightened",
      bonus: { strength: 30 },
    })
    seedStock("gear-1", 4)
    // Link directly (bypassing the add gate) so the ineligible link can be read.
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "gear-1",
      kind: "EQUIPMENT",
    })
    const detail = await getCharacter("chr-1", user)
    const assoc = detail.associations.find((a) => a.kind === "equipment")
    expect(assoc).toMatchObject({ rarity: "Ancient", soulbound: true })
    expect(assoc?.requirements).toMatchObject({
      minRaceLevel: 5,
      requiredRaceType: "enlightened",
    })
    expect(assoc?.equipmentEligibility).toMatchObject({ eligible: false })
    expect(assoc?.equipmentEligibility?.reason).toContain("race level 5")

    const inv = await getCharacterInventory("chr-1", user)
    const item = inv.inventory.find((i) => i.definitionId === "gear-1")
    expect(item).toMatchObject({ rarity: "Ancient", soulbound: true })
    expect(item?.requirements).toMatchObject({
      minRaceLevel: 5,
      requiredRaceType: "enlightened",
    })
    expect(item?.equipmentEligibility).toMatchObject({ eligible: false })
  })

  function seedGod(id: string, archived = false): unknown {
    return dbMock.store.addCatalog({
      id,
      kind: "gods",
      stableId: id,
      name: `God ${id}`,
      config: { blessingEffects: {} },
      ...(archived ? { archived: true } : {}),
    })
  }

  function putCharacter(state: CharacterState, version = 0): void {
    dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      state: serializeState(state),
      version,
    })
  }

  it("rejects a new equipment config that still uses the legacy requirement keys", async () => {
    await expect(
      createCatalogItem("equipment", {
        name: "LegacyReq",
        config: { slot: "Head", rarity: "Common", minRaceLevel: 5 },
      })
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    await expect(
      createCatalogItem("equipment", {
        name: "LegacyReq2",
        config: {
          slot: "Head",
          rarity: "Common",
          requiredRaceType: "monster",
        },
      })
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    const item = await createCatalogItem("equipment", {
      name: "CanonReq",
      config: {
        slot: "Head",
        rarity: "Common",
        minimumLevel: 5,
        requiredLevelType: "humanoidRace",
      },
    })
    expect(item.config).toMatchObject({
      minimumLevel: 5,
      requiredLevelType: "humanoidRace",
    })
  })

  it("still reads and enforces a legacy minRaceLevel / requiredRaceType config", async () => {
    seedCharacter(1)
    seedEquipment("gear-legacy", {
      slot: "Weapon",
      rarity: "Common",
      bonus: { strength: 10 },
      minRaceLevel: 5,
      requiredRaceType: "enlightened",
    })
    seedStock("gear-legacy")
    // The add gate still rejects an unmet legacy requirement.
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "equipment",
          definitionId: "gear-legacy",
          operation: "add",
          version: 0,
        },
        user
      )
    ).rejects.toMatchObject({
      status: 400,
      code: "equipment_requirements_unmet",
      message: expect.stringContaining("race level 5"),
    })
    // Bypass the gate and confirm the read view still surfaces the legacy keys.
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "gear-legacy",
      kind: "EQUIPMENT",
    })
    const detail = await getCharacter("chr-1", user)
    const assoc = detail.associations.find((a) => a.kind === "equipment")
    expect(assoc?.requirements).toMatchObject({
      minRaceLevel: 5,
      requiredRaceType: "enlightened",
    })
    expect(assoc?.equipmentEligibility).toMatchObject({ eligible: false })
  })

  it("gates eligibility on the Class track level and on class-track existence", async () => {
    const state = createInitialState("integrated", null, null)
    state.tracks["class"] = { level: 3, quarter: 0, definitionId: "" }
    state.baseAttributes = { ...state.baseAttributes, strength: 1000 }
    putCharacter(state)
    seedEquipment("gear-class", {
      slot: "Weapon",
      rarity: "Common",
      bonus: { strength: 10 },
      minimumLevel: 5,
      requiredLevelType: "class",
    })
    seedStock("gear-class")
    // Class level 3 < 5 -> the add gate rejects with a precise reason.
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "equipment",
          definitionId: "gear-class",
          operation: "add",
          version: 0,
        },
        user
      )
    ).rejects.toMatchObject({
      status: 400,
      code: "equipment_requirements_unmet",
      message: expect.stringContaining("Class level 5"),
    })
    // Raise the class level past the requirement -> eligible.
    const state2 = createInitialState("integrated", null, null)
    state2.tracks["class"] = { level: 6, quarter: 0, definitionId: "" }
    state2.baseAttributes = { ...state2.baseAttributes, strength: 1000 }
    putCharacter(state2, 1)
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "gear-class",
        operation: "add",
        version: 1,
      },
      user
    )
    const items = res.character.status?.equipment.items ?? []
    expect(items).toHaveLength(1)
    expect(items[0].applied.strength).toBe(10)
  })

  it("rejects an item requiring a Class track when no class track exists", async () => {
    const state = createInitialState("integrated", null, null)
    delete state.tracks["class"]
    state.baseAttributes = { ...state.baseAttributes, strength: 1000 }
    putCharacter(state)
    seedEquipment("gear-no-class", {
      slot: "Weapon",
      rarity: "Common",
      bonus: { strength: 10 },
      requiredLevelType: "class",
    })
    seedStock("gear-no-class")
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "equipment",
          definitionId: "gear-no-class",
          operation: "add",
          version: 0,
        },
        user
      )
    ).rejects.toMatchObject({
      status: 400,
      code: "equipment_requirements_unmet",
      message: expect.stringContaining("Class track"),
    })
  })

  it("gates eligibility on the Profession track level and on profession-track existence", async () => {
    const state = createInitialState("integrated", null, null)
    state.tracks["profession"] = { level: 2, quarter: 0, definitionId: "" }
    state.baseAttributes = { ...state.baseAttributes, strength: 1000 }
    putCharacter(state)
    seedEquipment("gear-prof", {
      slot: "Weapon",
      rarity: "Common",
      bonus: { strength: 10 },
      minimumLevel: 4,
      requiredLevelType: "profession",
    })
    seedStock("gear-prof")
    // Profession level 2 < 4 -> reject with a precise reason.
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "equipment",
          definitionId: "gear-prof",
          operation: "add",
          version: 0,
        },
        user
      )
    ).rejects.toMatchObject({
      status: 400,
      code: "equipment_requirements_unmet",
      message: expect.stringContaining("Profession level 4"),
    })
    // A profession-requiring item with no profession track is also rejected.
    const noProf = createInitialState("integrated", null, null)
    noProf.baseAttributes = { ...noProf.baseAttributes, strength: 1000 }
    putCharacter(noProf)
    seedEquipment("gear-no-prof", {
      slot: "Chest",
      rarity: "Common",
      bonus: { strength: 10 },
      requiredLevelType: "profession",
    })
    seedStock("gear-no-prof")
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "equipment",
          definitionId: "gear-no-prof",
          operation: "add",
          version: 0,
        },
        user
      )
    ).rejects.toMatchObject({
      status: 400,
      code: "equipment_requirements_unmet",
      message: expect.stringContaining("Profession track"),
    })
  })

  it("gates humanoidRace eligibility on race type and race level", async () => {
    seedRace("race-monster", {
      raceType: "monster",
      naturalGrade: "F",
      raceDefinitions: {
        F: { id: "race-monster:F", perLevel: allEqual(1), freePerLevel: 5 },
      },
    })
    seedCharacter(1, { raceId: "race-monster", raceMode: "independent" })
    seedEquipment("gear-hu", {
      slot: "Weapon",
      rarity: "Common",
      bonus: { strength: 10 },
      minimumLevel: 5,
      requiredLevelType: "humanoidRace",
    })
    seedStock("gear-hu")
    // A monster-raced character does NOT satisfy the humanoid requirement.
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "equipment",
          definitionId: "gear-hu",
          operation: "add",
          version: 0,
        },
        user
      )
    ).rejects.toMatchObject({
      status: 400,
      code: "equipment_requirements_unmet",
      message: expect.stringContaining("humanoid"),
    })
    // A humanoid character at race level 1 (< 5) is type-eligible but level-ineligible.
    seedCharacter(1)
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "equipment",
          definitionId: "gear-hu",
          operation: "add",
          version: 0,
        },
        user
      )
    ).rejects.toMatchObject({
      status: 400,
      code: "equipment_requirements_unmet",
      message: expect.stringContaining("humanoid race level 5"),
    })
    // Raise the race level past the requirement -> eligible.
    seedCharacter(6)
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "gear-hu",
        operation: "add",
        version: 0,
      },
      user
    )
    expect(res.character.status?.equipment.items?.[0]?.applied.strength).toBe(
      10
    )
  })

  it("gates monstrousRace eligibility on race type and race level", async () => {
    // A humanoid character does NOT satisfy the monstrous requirement.
    seedCharacter(1)
    seedEquipment("gear-mst", {
      slot: "Weapon",
      rarity: "Common",
      bonus: { strength: 10 },
      minimumLevel: 3,
      requiredLevelType: "monstrousRace",
    })
    seedStock("gear-mst")
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "equipment",
          definitionId: "gear-mst",
          operation: "add",
          version: 0,
        },
        user
      )
    ).rejects.toMatchObject({
      status: 400,
      code: "equipment_requirements_unmet",
      message: expect.stringContaining("monstrous"),
    })
    // A monster at race level 4 (>= 3) satisfies the requirement.
    seedRace("race-monster", {
      raceType: "monster",
      naturalGrade: "F",
      raceDefinitions: {
        F: { id: "race-monster:F", perLevel: allEqual(1), freePerLevel: 5 },
      },
    })
    seedCharacter(4, { raceId: "race-monster", raceMode: "independent" })
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "gear-mst",
        operation: "add",
        version: 0,
      },
      user
    )
    expect(res.character.status?.equipment.items?.[0]?.applied.strength).toBe(
      10
    )
  })

  it("gates divine-patron eligibility on exact god stableId (other god fails)", async () => {
    seedCharacter(1)
    seedGod("god-a")
    seedGod("god-b")
    // The character has a Minor blessing from God A only.
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "god-a",
      kind: "BLESSING",
      blessingTier: "Minor",
    })
    seedEquipment("gear-god", {
      slot: "Weapon",
      rarity: "Common",
      bonus: { strength: 10 },
      requiredGodStableId: "god-a",
      minimumBlessingTier: "Minor",
    })
    seedEquipment("gear-god-other", {
      slot: "Chest",
      rarity: "Common",
      bonus: { strength: 10 },
      requiredGodStableId: "god-b",
      minimumBlessingTier: "Minor",
    })
    seedStock("gear-god")
    seedStock("gear-god-other")
    // Matching god + equal tier -> eligible.
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "gear-god",
        operation: "add",
        version: 0,
      },
      user
    )
    expect(res.character.status?.equipment.items?.[0]?.applied.strength).toBe(
      10
    )
    // A different god is required -> ineligible, reason names the god.
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "equipment",
          definitionId: "gear-god-other",
          operation: "add",
          version: 1,
        },
        user
      )
    ).rejects.toMatchObject({
      status: 400,
      code: "equipment_requirements_unmet",
      message: expect.stringContaining("god-b"),
    })
  })

  it("enforces the minimum blessing tier (below fails, equal/above pass)", async () => {
    seedCharacter(1)
    seedGod("god-c")
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "god-c",
      kind: "BLESSING",
      blessingTier: "Minor",
    })
    // Below the current tier -> rejected, reason states the required tier.
    seedEquipment("gear-tier-hi", {
      slot: "Weapon",
      rarity: "Common",
      bonus: { strength: 10 },
      requiredGodStableId: "god-c",
      minimumBlessingTier: "Greater",
    })
    seedStock("gear-tier-hi")
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "equipment",
          definitionId: "gear-tier-hi",
          operation: "add",
          version: 0,
        },
        user
      )
    ).rejects.toMatchObject({
      status: 400,
      code: "equipment_requirements_unmet",
      message: expect.stringContaining("Greater"),
    })
    // Equal tier -> eligible.
    seedEquipment("gear-tier-eq", {
      slot: "Chest",
      rarity: "Common",
      bonus: { strength: 10 },
      requiredGodStableId: "god-c",
      minimumBlessingTier: "Minor",
    })
    seedStock("gear-tier-eq")
    const res = await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "gear-tier-eq",
        operation: "add",
        version: 0,
      },
      user
    )
    expect(res.character.status?.equipment.items).toHaveLength(1)
    // A lower tier (Baptism) than the current (Minor) -> eligible.
    seedEquipment("gear-tier-lo", {
      slot: "Hands",
      rarity: "Common",
      bonus: { strength: 10 },
      requiredGodStableId: "god-c",
      minimumBlessingTier: "Baptism",
    })
    seedStock("gear-tier-lo")
    const res2 = await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "gear-tier-lo",
        operation: "add",
        version: 1,
      },
      user
    )
    expect(res2.character.status?.equipment.items).toHaveLength(2)
  })

  it("renders an item ineligible when the required patron is archived or not linked", async () => {
    seedCharacter(1)
    seedGod("god-arch", true)
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "god-arch",
      kind: "BLESSING",
      blessingTier: "Minor",
    })
    seedEquipment("gear-god-arch", {
      slot: "Weapon",
      rarity: "Common",
      bonus: { strength: 10 },
      requiredGodStableId: "god-arch",
    })
    seedStock("gear-god-arch")
    // An archived patron (even though linked) is ineligible.
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "equipment",
          definitionId: "gear-god-arch",
          operation: "add",
          version: 0,
        },
        user
      )
    ).rejects.toMatchObject({
      status: 400,
      code: "equipment_requirements_unmet",
      message: expect.stringContaining("archived"),
    })
    // No link at all to a required god is ineligible.
    seedGod("god-none")
    seedEquipment("gear-god-none", {
      slot: "Chest",
      rarity: "Common",
      bonus: { strength: 10 },
      requiredGodStableId: "god-none",
    })
    seedStock("gear-god-none")
    await expect(
      associateCharacter(
        "chr-1",
        {
          kind: "equipment",
          definitionId: "gear-god-none",
          operation: "add",
          version: 0,
        },
        user
      )
    ).rejects.toMatchObject({
      status: 400,
      code: "equipment_requirements_unmet",
      message: expect.stringContaining("god-none"),
    })
  })

  it("loses eligibility when a track level declines and suppresses the live bonus", async () => {
    const state = createInitialState("integrated", null, null)
    state.tracks["class"] = { level: 6, quarter: 0, definitionId: "" }
    state.baseAttributes = { ...state.baseAttributes, strength: 1000 }
    putCharacter(state)
    seedEquipment("gear-decline", {
      slot: "Weapon",
      rarity: "Common",
      bonus: { strength: 30 },
      minimumLevel: 5,
      requiredLevelType: "class",
    })
    seedStock("gear-decline")
    await associateCharacter(
      "chr-1",
      {
        kind: "equipment",
        definitionId: "gear-decline",
        operation: "add",
        version: 0,
      },
      user
    )
    const d1 = await getCharacter("chr-1", user)
    expect(d1.status?.equipment.items?.[0]?.applied.strength).toBe(30)
    // Decline the class track below the requirement.
    const lowered = createInitialState("integrated", null, null)
    lowered.tracks["class"] = { level: 2, quarter: 0, definitionId: "" }
    lowered.baseAttributes = { ...lowered.baseAttributes, strength: 1000 }
    putCharacter(lowered, 1)
    const d2 = await getCharacter("chr-1", user)
    const item = d2.status?.equipment.items?.[0]
    expect(item).toBeDefined()
    expect(item?.requested.strength).toBe(0)
    expect(item?.applied.strength).toBe(0)
  })

  it("suppresses both attribute and derived bonuses when eligibility is lost", async () => {
    const state = createInitialState("integrated", null, null)
    state.tracks["class"] = { level: 2, quarter: 0, definitionId: "" }
    state.baseAttributes = {
      ...state.baseAttributes,
      strength: 1000,
      vitality: 100,
      wisdom: 100,
    }
    putCharacter(state)
    seedEquipment("gear-derived-inel", {
      slot: "Weapon",
      rarity: "Common",
      bonus: { strength: 10 },
      derivedFlat: { hp: 50 },
      derivedPercentBasisPoints: { hp: 1000 },
      minimumLevel: 5,
      requiredLevelType: "class",
    })
    seedStock("gear-derived-inel")
    // Link directly (bypassing the add gate) so the ineligible link can be read.
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "gear-derived-inel",
      kind: "EQUIPMENT",
    })
    const detail = await getCharacter("chr-1", user)
    const items = detail.status?.equipment.items ?? []
    expect(items).toHaveLength(1)
    expect(items[0].requested.strength).toBe(0)
    expect(items[0].applied.strength).toBe(0)
    // The derived HP bonus is inert: HP stays at its vitality-derived base (1000).
    expect(detail.status?.derivedStats?.hp).toBe(1000)
  })

  it("rejects a new equipment entry referencing a missing or archived divine patron", async () => {
    await expect(
      createCatalogItem("equipment", {
        name: "GearMissing",
        config: {
          slot: "Head",
          rarity: "Common",
          requiredGodStableId: "no-such-god",
        },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
      message: expect.stringContaining("no-such-god"),
    })
    seedGod("god-arch", true)
    await expect(
      createCatalogItem("equipment", {
        name: "GearArch",
        config: {
          slot: "Head",
          rarity: "Common",
          requiredGodStableId: "god-arch",
        },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
      message: expect.stringContaining("god-arch"),
    })
    seedGod("god-ok")
    const item = await createCatalogItem("equipment", {
      name: "GearOK",
      config: {
        slot: "Head",
        rarity: "Common",
        requiredGodStableId: "god-ok",
        minimumBlessingTier: "Minor",
      },
    })
    expect(item.config).toMatchObject({
      requiredGodStableId: "god-ok",
      minimumBlessingTier: "Minor",
    })
  })

  it("blocks a god stableId rename while equipment references the old id", async () => {
    seedGod("god-r")
    seedEquipment("gear-ref", {
      slot: "Weapon",
      rarity: "Common",
      bonus: { strength: 10 },
      requiredGodStableId: "god-r",
    })
    await expect(
      updateCatalogItem("gods", "god-r", { stableId: "god-r2" })
    ).rejects.toMatchObject({ status: 409, code: "god_stable_id_in_use" })
  })

  it("allows a god stableId rename when no equipment references it", async () => {
    seedGod("god-free")
    const item = await updateCatalogItem("gods", "god-free", {
      stableId: "god-free-2",
    })
    expect(item.stableId).toBe("god-free-2")
  })

  it("runs an equipment create under SERIALIZABLE isolation (against a concurrent god/skill rename)", async () => {
    seedGod("god-serial")
    seedSkill("sk-serial", {
      track: "class",
      milestone: 4,
      rarity: "Common",
      effects: [{ phase: "flat", amount: { strength: 5 } }],
    })
    const spy = vi.spyOn(prisma, "$transaction")
    try {
      await createCatalogItem("equipment", {
        name: "GearSerial",
        config: {
          slot: "Head",
          rarity: "Common",
          requiredGodStableId: "god-serial",
          grantedSkillStableIds: ["sk-serial"],
        },
      })
      // The equipment create transaction MUST request SERIALIZABLE isolation so a
      // concurrent god/skill stableId rename cannot slip between the live-ref read
      // and the equipment write (which would leave a dangling reference).
      expect(spy.mock.calls[spy.mock.calls.length - 1][1]).toEqual(
        expect.objectContaining({ isolationLevel: "Serializable" })
      )
    } finally {
      spy.mockRestore()
    }
  })

  it("runs an equipment config-changing update under SERIALIZABLE isolation", async () => {
    seedEquipment("gear-upd", {
      slot: "Head",
      rarity: "Common",
      bonus: { strength: 1 },
    })
    const spy = vi.spyOn(prisma, "$transaction")
    try {
      await updateCatalogItem("equipment", "gear-upd", {
        config: {
          slot: "Head",
          rarity: "Common",
          bonus: { strength: 2 },
        },
      })
      // A config-changing equipment PATCH re-validates requiredGodStableId /
      // grantedSkillStableIds inside the transaction, so it must run SERIALIZABLE.
      expect(spy.mock.calls[spy.mock.calls.length - 1][1]).toEqual(
        expect.objectContaining({ isolationLevel: "Serializable" })
      )
    } finally {
      spy.mockRestore()
    }
  })

  it("maps a serialization failure (P2034) on equipment create to a 409, never a 500", async () => {
    seedGod("god-serial-map")
    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce({
      name: "PrismaClientKnownRequestError",
      code: "P2034",
    })
    try {
      await expect(
        createCatalogItem("equipment", {
          name: "GearMap",
          config: {
            slot: "Head",
            rarity: "Common",
            requiredGodStableId: "god-serial-map",
          },
        })
      ).rejects.toMatchObject({
        status: 409,
        code: "catalog_serialization_conflict",
      })
    } finally {
      spy.mockRestore()
    }
    // The rejected create left no equipment row behind (only the seeded god).
    expect(dbMock.store.catalog.size).toBe(1)
  })

  function seedSkill(id: string, config: Record<string, unknown>): unknown {
    return dbMock.store.addCatalog({
      id,
      kind: "skills",
      stableId: id,
      name: `Skill ${id}`,
      config,
    })
  }

  it("blocks a skill stableId rename while any equipment grants the old id", async () => {
    seedSkill("sk-r", {
      track: "class",
      milestone: 4,
      rarity: "Common",
      effects: [{ phase: "flat", amount: { strength: 5 } }],
    })
    seedEquipment("gear-ref", {
      slot: "Head",
      rarity: "Common",
      grantedSkillStableIds: ["sk-r"],
    })
    await expect(
      updateCatalogItem("skills", "sk-r", { stableId: "sk-r2" })
    ).rejects.toMatchObject({
      status: 409,
      code: "skill_stable_id_in_use",
      message: expect.stringContaining("sk-r"),
    })
  })

  it("blocks a skill stableId rename even when the referencing equipment is archived", async () => {
    seedSkill("sk-arch", {
      track: "class",
      milestone: 4,
      rarity: "Common",
      effects: [{ phase: "flat", amount: { strength: 5 } }],
    })
    dbMock.store.addCatalog({
      id: "gear-arch",
      kind: "equipment",
      stableId: "gear-arch",
      name: "Gear Arch",
      config: {
        slot: "Head",
        rarity: "Common",
        grantedSkillStableIds: ["sk-arch"],
      },
      archived: true,
    })
    await expect(
      updateCatalogItem("skills", "sk-arch", { stableId: "sk-arch2" })
    ).rejects.toMatchObject({
      status: 409,
      code: "skill_stable_id_in_use",
      message: expect.stringContaining("sk-arch"),
    })
  })

  it("allows a skill stableId rename when no equipment grants it", async () => {
    seedSkill("sk-free", {
      track: "class",
      milestone: 4,
      rarity: "Common",
      effects: [{ phase: "flat", amount: { strength: 5 } }],
    })
    const item = await updateCatalogItem("skills", "sk-free", {
      stableId: "sk-free-2",
    })
    expect(item.stableId).toBe("sk-free-2")
  })

  it("still allows metadata / effects edits on a granted skill (rename is the only blocked change)", async () => {
    seedSkill("sk-meta", {
      track: "class",
      milestone: 4,
      rarity: "Common",
      effects: [{ phase: "flat", amount: { strength: 5 } }],
    })
    seedEquipment("gear-meta", {
      slot: "Head",
      rarity: "Common",
      grantedSkillStableIds: ["sk-meta"],
    })
    const item = await updateCatalogItem("skills", "sk-meta", {
      name: "Renamed Skill",
      config: {
        track: "class",
        milestone: 4,
        rarity: "Common",
        effects: [{ phase: "flat", amount: { strength: 7 } }],
      },
    })
    expect(item.name).toBe("Renamed Skill")
    expect(item.config).toMatchObject({
      effects: [{ phase: "flat", amount: { strength: 7 } }],
    })
  })
})

describe("equipment-granted passive skills (live synthesis, dedup, inert states)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function seedCharacter(baseStrength = 100): void {
    const state = createInitialState("integrated", null, null)
    state.baseAttributes = {
      ...state.baseAttributes,
      strength: baseStrength,
    }
    dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      state: serializeState(state),
      version: 0,
    })
  }

  function seedSkill(
    id: string,
    config: Record<string, unknown>,
    extra: Partial<{ archived: boolean }> = {}
  ): unknown {
    return dbMock.store.addCatalog({
      id,
      kind: "skills",
      stableId: id,
      name: `Skill ${id}`,
      config,
      ...(extra.archived != null ? { archived: extra.archived } : {}),
    })
  }

  function seedEquipment(
    id: string,
    config: Record<string, unknown>,
    extra: Partial<{ name: string }> = {}
  ): unknown {
    return dbMock.store.addCatalog({
      id,
      kind: "equipment",
      stableId: id,
      name: extra.name ?? `Gear ${id}`,
      config,
    })
  }

  function equipWithoutGate(definitionId: string): void {
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId,
      kind: "EQUIPMENT",
    })
  }

  function strengthFlatDelta(status: unknown): number {
    const traces = (
      status as {
        traces: Array<{
          attribute: string
          phases: Array<{ phase: string; delta: number }>
        }>
      }
    ).traces
    const strength = traces.find((t) => t.attribute === "strength")
    if (!strength) return 0
    const flat = strength.phases.find((p) => p.phase === "flat")
    return flat?.delta ?? 0
  }

  it("synthesizes the granted skill's passive stat while the item is equipped and eligible", async () => {
    seedCharacter(100)
    seedSkill("sk-1", {
      track: "class",
      milestone: 4,
      rarity: "Common",
      effects: [{ phase: "flat", amount: { strength: 5 } }],
    })
    seedEquipment("gear-1", {
      slot: "Head",
      rarity: "Common",
      grantedSkillStableIds: ["sk-1"],
    })
    equipWithoutGate("gear-1")
    const detail = await getCharacter("chr-1", user)
    // The granted passive is synthesized live (flat +5 sourced to item+skill).
    expect(strengthFlatDelta(detail.status)).toBe(5)
    // It is never persisted as a SKILL association and never written into state.
    expect(detail.associations).toHaveLength(1)
    expect(detail.associations[0]).toMatchObject({ kind: "equipment" })
    expect(
      (detail.state as { activeEffects: unknown[] }).activeEffects
    ).toHaveLength(0)
  })

  it("keeps the granted passive inert while the item is ineligible", async () => {
    seedCharacter(100)
    seedSkill("sk-1", {
      track: "class",
      milestone: 4,
      rarity: "Common",
      effects: [{ phase: "flat", amount: { strength: 5 } }],
    })
    // Race level 0 is below minRaceLevel 5 => ineligible.
    seedEquipment("gear-1", {
      slot: "Head",
      rarity: "Common",
      grantedSkillStableIds: ["sk-1"],
      minRaceLevel: 5,
    })
    equipWithoutGate("gear-1")
    const detail = await getCharacter("chr-1", user)
    expect(strengthFlatDelta(detail.status)).toBe(0)
    // Requalifying (raising the race level) turns the grant back on.
    const state = deserializeState(
      (await dbMock.store.characters.get("chr-1")!).state
    )
    state.race = { ...state.race, level: 6 }
    dbMock.store.characters.get("chr-1")!.state = serializeState(state)
    const requalified = await getCharacter("chr-1", user)
    expect(strengthFlatDelta(requalified.status)).toBe(5)
  })

  it("treats an archived skill as inert even while the granting item is eligible", async () => {
    seedCharacter(100)
    seedSkill(
      "sk-1",
      {
        track: "class",
        milestone: 4,
        rarity: "Common",
        effects: [{ phase: "flat", amount: { strength: 5 } }],
      },
      { archived: true }
    )
    seedEquipment("gear-1", {
      slot: "Head",
      rarity: "Common",
      grantedSkillStableIds: ["sk-1"],
    })
    equipWithoutGate("gear-1")
    const detail = await getCharacter("chr-1", user)
    expect(strengthFlatDelta(detail.status)).toBe(0)
  })

  it("does not double count: a linked SKILL association wins, and duplicate equipment grants apply once", async () => {
    seedCharacter(100)
    seedSkill("sk-1", {
      track: "class",
      milestone: 4,
      rarity: "Common",
      effects: [{ phase: "flat", amount: { strength: 5 } }],
    })
    // Link the same skill as a SKILL association (the linked association wins).
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "sk-1",
      kind: "SKILL",
    })
    // Two equipment items both grant sk-1.
    seedEquipment("gear-1", {
      slot: "Head",
      rarity: "Common",
      grantedSkillStableIds: ["sk-1"],
    })
    seedEquipment("gear-2", {
      slot: "Chest",
      rarity: "Common",
      grantedSkillStableIds: ["sk-1"],
    })
    equipWithoutGate("gear-1")
    equipWithoutGate("gear-2")
    const detail = await getCharacter("chr-1", user)
    // Applied once (via the linked skill), never counted three times.
    expect(strengthFlatDelta(detail.status)).toBe(5)
  })

  it("applies a duplicate equipment grant only once (first equipped wins)", async () => {
    seedCharacter(100)
    seedSkill("sk-1", {
      track: "class",
      milestone: 4,
      rarity: "Common",
      effects: [{ phase: "flat", amount: { strength: 5 } }],
    })
    seedEquipment("gear-1", {
      slot: "Head",
      rarity: "Common",
      grantedSkillStableIds: ["sk-1"],
    })
    seedEquipment("gear-2", {
      slot: "Chest",
      rarity: "Common",
      grantedSkillStableIds: ["sk-1"],
    })
    equipWithoutGate("gear-1")
    equipWithoutGate("gear-2")
    const detail = await getCharacter("chr-1", user)
    expect(strengthFlatDelta(detail.status)).toBe(5)
  })

  it("rejects a new equipment config that grants a missing skill", async () => {
    await expect(
      createCatalogItem("equipment", {
        name: "GearMissing",
        config: {
          slot: "Head",
          rarity: "Common",
          grantedSkillStableIds: ["no-such-skill"],
        },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
      message: expect.stringContaining("no-such-skill"),
    })
  })

  it("rejects a new equipment config that grants an archived skill", async () => {
    seedSkill(
      "sk-arch",
      {
        track: "class",
        milestone: 4,
        rarity: "Common",
        effects: [{ phase: "flat", amount: { strength: 5 } }],
      },
      { archived: true }
    )
    await expect(
      createCatalogItem("equipment", {
        name: "GearArch",
        config: {
          slot: "Head",
          rarity: "Common",
          grantedSkillStableIds: ["sk-arch"],
        },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
      message: expect.stringContaining("sk-arch"),
    })
  })

  it("accepts a new equipment config that grants an existing unarchived skill", async () => {
    seedSkill("sk-ok", {
      track: "class",
      milestone: 4,
      rarity: "Common",
      effects: [{ phase: "flat", amount: { strength: 5 } }],
    })
    const item = await createCatalogItem("equipment", {
      name: "GearOK",
      config: {
        slot: "Head",
        rarity: "Common",
        grantedSkillStableIds: ["sk-ok"],
      },
    })
    expect(item.config).toMatchObject({ grantedSkillStableIds: ["sk-ok"] })
  })

  it("rejects a config-changing update that grants a missing / archived skill", async () => {
    seedSkill(
      "sk-arch",
      {
        track: "class",
        milestone: 4,
        rarity: "Common",
        effects: [{ phase: "flat", amount: { strength: 5 } }],
      },
      { archived: true }
    )
    seedEquipment("gear-1", { slot: "Head", rarity: "Common" })
    await expect(
      updateCatalogItem("equipment", "gear-1", {
        config: {
          slot: "Head",
          rarity: "Common",
          grantedSkillStableIds: ["missing-skill"],
        },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
      message: expect.stringContaining("missing-skill"),
    })
    await expect(
      updateCatalogItem("equipment", "gear-1", {
        config: {
          slot: "Head",
          rarity: "Common",
          grantedSkillStableIds: ["sk-arch"],
        },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
      message: expect.stringContaining("sk-arch"),
    })
    // The rejected update never applied; the row keeps its original config.
    expect(
      (dbMock.store.catalog.get("gear-1")!.config as Record<string, unknown>)
        .grantedSkillStableIds
    ).toBeUndefined()
  })
})

describe("equipment-granted skill lookup is transaction-scoped", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function seedCharacter(): void {
    const state = createInitialState("integrated", null, null)
    state.baseAttributes = { ...state.baseAttributes, strength: 100 }
    dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      state: serializeState(state),
      version: 0,
    })
  }

  function seedSkill(id: string, config: Record<string, unknown>): unknown {
    return dbMock.store.addCatalog({
      id,
      kind: "skills",
      stableId: id,
      name: `Skill ${id}`,
      config,
    })
  }

  function seedEquipment(id: string, config: Record<string, unknown>): unknown {
    return dbMock.store.addCatalog({
      id,
      kind: "equipment",
      stableId: id,
      name: `Gear ${id}`,
      config,
    })
  }

  function equip(definitionId: string): void {
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId,
      kind: "EQUIPMENT",
    })
  }

  function strengthFlatDelta(status: unknown): number {
    const traces = (
      status as {
        traces: Array<{
          attribute: string
          phases: Array<{ phase: string; delta: number }>
        }>
      }
    ).traces
    const strength = traces.find((t) => t.attribute === "strength")
    if (!strength) return 0
    const flat = strength.phases.find((p) => p.phase === "flat")
    return flat?.delta ?? 0
  }

  it("reads the equipment-granted skill through the transaction client, never the global client", async () => {
    seedCharacter()
    seedSkill("sk-1", {
      track: "class",
      milestone: 4,
      rarity: "Common",
      effects: [{ phase: "flat", amount: { strength: 5 } }],
    })
    seedEquipment("gear-1", {
      slot: "Head",
      rarity: "Common",
      grantedSkillStableIds: ["sk-1"],
    })
    equip("gear-1")
    // The GLOBAL client is primed to resolve no skills (an empty map), so if the
    // mutation fell back to a global skill lookup the granted passive would go inert.
    const spy = vi
      .spyOn(prisma.catalogDefinition, "findMany")
      .mockResolvedValue([])
    try {
      const detail = await updateCharacter("chr-1", { name: "Renamed" }, user)
      expect(strengthFlatDelta(detail.status)).toBe(5)
    } finally {
      spy.mockRestore()
    }
  })

  it("snapshots the recently edited skill config inside the transaction, not a stale global read", async () => {
    seedCharacter()
    seedSkill("sk-1", {
      track: "class",
      milestone: 4,
      rarity: "Common",
      effects: [{ phase: "flat", amount: { strength: 5 } }],
    })
    seedEquipment("gear-1", {
      slot: "Head",
      rarity: "Common",
      grantedSkillStableIds: ["sk-1"],
    })
    equip("gear-1")
    // A skill config edit lands in the transaction's view, but the GLOBAL client
    // still returns the OLD +5 config. A mutation that resolves the skill map
    // through global prisma would synthesize the stale +5; using the transaction
    // client it must see the edited +7 snapshot.
    const storedSkill = dbMock.store.catalog.get("sk-1")!
    ;(storedSkill.config as Record<string, unknown>).effects = [
      { phase: "flat", amount: { strength: 7 } },
    ]
    const spy = vi
      .spyOn(prisma.catalogDefinition, "findMany")
      .mockResolvedValue([
        {
          id: "sk-1",
          kind: "skills",
          stableId: "sk-1",
          name: "Skill sk-1",
          config: {
            track: "class",
            milestone: 4,
            rarity: "Common",
            effects: [{ phase: "flat", amount: { strength: 5 } }],
          },
          archived: false,
        } as never,
      ])
    try {
      const detail = await updateCharacter("chr-1", { name: "Renamed" }, user)
      expect(strengthFlatDelta(detail.status)).toBe(7)
    } finally {
      spy.mockRestore()
    }
  })
})

describe("catalog grade-specific descriptions (create/update/clear/preserve)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function validRaceConfig(): Record<string, unknown> {
    return {
      raceType: "enlightened",
      naturalGrade: "B",
      raceDefinitions: {
        B: { id: "r:B", perLevel: { strength: 1 }, freePerLevel: 1 },
      },
    }
  }

  function seedLegacyRace(): void {
    dbMock.store.addCatalog({
      id: "legacy-race",
      kind: "races",
      stableId: "legacy-race",
      name: "Legacy Race",
      config: {
        raceDefinitions: {
          F: { id: "r:F", perLevel: {}, freePerLevel: 1 },
        },
      },
    })
  }

  it("createCatalogItem persists authored gradeDescriptions and reads them back", async () => {
    const item = await createCatalogItem("races", {
      name: "Graded Race",
      stableId: "graded-race",
      grade: "B",
      sourceUrl: "https://example.com/graded-race",
      config: validRaceConfig(),
      gradeDescriptions: { G: "A G-grade blurb", S: "An S-grade blurb" },
    })
    expect(item.gradeDescriptions).toEqual({
      G: "A G-grade blurb",
      S: "An S-grade blurb",
    })
    const row = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "graded-race"
    )!
    expect(row.gradeDescriptions).toEqual({
      G: "A G-grade blurb",
      S: "An S-grade blurb",
    })
  })

  it("createCatalogItem without gradeDescriptions stores an empty map (reads back {})", async () => {
    const item = await createCatalogItem("races", {
      name: "Plain Race",
      stableId: "plain-race",
      grade: "B",
      sourceUrl: "https://example.com/plain-race",
      config: validRaceConfig(),
    })
    expect(item.gradeDescriptions).toEqual({})
    const row = [...dbMock.store.catalog.values()].find(
      (r) => r.stableId === "plain-race"
    )!
    expect(row.gradeDescriptions).toEqual({})
  })

  it("updateCatalogItem sets gradeDescriptions only when the PATCH includes it", async () => {
    const created = await createCatalogItem("races", {
      name: "Race",
      stableId: "race-x",
      grade: "B",
      sourceUrl: "https://example.com/race-x",
      config: validRaceConfig(),
    })
    const updated = await updateCatalogItem("races", created.id, {
      gradeDescriptions: { G: "hello" },
    })
    expect(updated.gradeDescriptions).toEqual({ G: "hello" })
  })

  it("updateCatalogItem preserves gradeDescriptions when the PATCH omits it", async () => {
    const created = await createCatalogItem("races", {
      name: "Race",
      stableId: "race-y",
      grade: "B",
      sourceUrl: "https://example.com/race-y",
      config: validRaceConfig(),
      gradeDescriptions: { G: "keep me" },
    })
    // A metadata-only PATCH (name change) must not touch gradeDescriptions.
    const updated = await updateCatalogItem("races", created.id, {
      name: "Renamed Race",
    })
    expect(updated.gradeDescriptions).toEqual({ G: "keep me" })
  })

  it("updateCatalogItem clears gradeDescriptions when the PATCH sends {}", async () => {
    const created = await createCatalogItem("races", {
      name: "Race",
      stableId: "race-z",
      grade: "B",
      sourceUrl: "https://example.com/race-z",
      config: validRaceConfig(),
      gradeDescriptions: { G: "clear me" },
    })
    const updated = await updateCatalogItem("races", created.id, {
      gradeDescriptions: {},
    })
    expect(updated.gradeDescriptions).toEqual({})
    const row = [...dbMock.store.catalog.values()].find(
      (r) => r.id === created.id
    )!
    expect(row.gradeDescriptions).toEqual({})
  })

  it("an old row without gradeDescriptions reads back an empty map", async () => {
    seedLegacyRace()
    const item = await getCatalogItem("races", "legacy-race")
    expect(item.gradeDescriptions).toEqual({})
  })

  it("a metadata-only PATCH on a legacy config does not revalidate the config", async () => {
    seedLegacyRace()
    const updated = await updateCatalogItem("races", "legacy-race", {
      gradeDescriptions: { G: "added without touching config" },
    })
    expect(updated.gradeDescriptions).toEqual({
      G: "added without touching config",
    })
    // The legacy config is untouched: no raceType was injected or required.
    const row = dbMock.store.catalog.get("legacy-race")!
    expect((row.config as Record<string, unknown>).raceType).toBeUndefined()
    expect((row.config as Record<string, unknown>).naturalGrade).toBeUndefined()
  })
})

describe("character detail grade-description exposure (owner-authorized detail)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  type SeededTrack = {
    level: number
    quarter: number
    definitionId: string
    grade?: Grade
  }

  function seedDefinition(
    id: string,
    kind: string,
    stableId: string,
    name: string,
    opts: {
      grade?: string | null
      description?: string | null
      archived?: boolean
      gradeDescriptions?: Record<string, string>
    } = {}
  ): void {
    dbMock.store.addCatalog({
      id,
      kind,
      stableId,
      name,
      description: opts.description ?? null,
      grade: opts.grade,
      archived: opts.archived ?? false,
      gradeDescriptions: opts.gradeDescriptions ?? {},
    })
  }

  function characterStateWith(opts: {
    raceGrade: Grade
    classGrade?: Grade
    professionGrade?: Grade
    classUngraded?: boolean
    professionUngraded?: boolean
  }): unknown {
    const tracks: Record<string, SeededTrack> = {}
    if (opts.classGrade != null || opts.classUngraded) {
      tracks.class = {
        level: 0,
        quarter: 0,
        definitionId: opts.classGrade ? `class:${opts.classGrade}` : "",
        ...(opts.classGrade != null ? { grade: opts.classGrade } : {}),
      }
    }
    if (opts.professionGrade != null || opts.professionUngraded) {
      tracks.profession = {
        level: 0,
        quarter: 0,
        definitionId: opts.professionGrade
          ? `prof:${opts.professionGrade}`
          : "",
        ...(opts.professionGrade != null
          ? { grade: opts.professionGrade }
          : {}),
      }
    }
    const state = createCharacterState({
      baseAttributes: makeVector({}),
      tracks,
      race: { level: 0, grade: opts.raceGrade, mode: "derived" },
    })
    return serializeState(state)
  }

  function seedCharacterWith(opts: {
    raceId?: string
    classId?: string
    professionId?: string
    raceGrade: Grade
    classGrade?: Grade
    professionGrade?: Grade
    classUngraded?: boolean
    professionUngraded?: boolean
  }): unknown {
    return dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      raceId: opts.raceId ?? null,
      classId: opts.classId ?? null,
      professionId: opts.professionId ?? null,
      state: characterStateWith(opts),
      version: 0,
    })
  }

  function seedAssociation(
    definitionId: string,
    kind: "SKILL" | "TITLE" | "EQUIPMENT" | "TRANSCENDENT"
  ): void {
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId,
      kind,
    })
  }

  it("surfaces authored grade prose for race/class/profession at the character's own grades", async () => {
    seedDefinition("race-h", "races", "human", "Human", {
      gradeDescriptions: { G: "Human G-grade prose", F: "Human F-grade prose" },
    })
    seedDefinition("cls-a", "classes", "archer", "Archer", {
      gradeDescriptions: {
        F: "Archer F-grade prose",
        E: "Archer E-grade prose",
      },
    })
    seedDefinition("prof-b", "professions", "alchemist", "Alchemist", {
      gradeDescriptions: {
        E: "Alchemist E-grade prose",
        D: "Alchemist D-grade prose",
      },
    })
    seedCharacterWith({
      raceId: "race-h",
      classId: "cls-a",
      professionId: "prof-b",
      raceGrade: "G",
      classGrade: "F",
      professionGrade: "E",
    })
    const detail = await getCharacter("chr-1", user)
    expect(detail.raceGradeDescription).toBe("Human G-grade prose")
    expect(detail.classGradeDescription).toBe("Archer F-grade prose")
    expect(detail.professionGradeDescription).toBe("Alchemist E-grade prose")
  })

  it("returns null for a legacy ungraded class/profession track, never inferring from the race grade", async () => {
    seedDefinition("race-h", "races", "human", "Human", {
      gradeDescriptions: { G: "Human G-grade prose" },
    })
    seedDefinition("cls-a", "classes", "archer", "Archer", {
      gradeDescriptions: {
        G: "Archer G-grade prose",
        F: "Archer F-grade prose",
      },
    })
    seedDefinition("prof-b", "professions", "alchemist", "Alchemist", {
      gradeDescriptions: {
        G: "Alchemist G-grade prose",
        E: "Alchemist E-grade prose",
      },
    })
    seedCharacterWith({
      raceId: "race-h",
      classId: "cls-a",
      professionId: "prof-b",
      raceGrade: "G",
      classUngraded: true,
      professionUngraded: true,
    })
    const detail = await getCharacter("chr-1", user)
    expect(detail.raceGradeDescription).toBe("Human G-grade prose")
    // No class/profession track grade -> null; the race-grade (G) prose the
    // definitions DO author is not used as an inference.
    expect(detail.classGradeDescription).toBeNull()
    expect(detail.professionGradeDescription).toBeNull()
  })

  it("resolves each track at ITS OWN grade, never the race grade", async () => {
    seedDefinition("race-h", "races", "human", "Human", {
      gradeDescriptions: { G: "Human G prose" },
    })
    seedDefinition("cls-a", "classes", "archer", "Archer", {
      gradeDescriptions: {
        G: "Archer-at-race-G",
        F: "Archer-class-F prose",
        E: "Archer E prose",
      },
    })
    seedDefinition("prof-b", "professions", "alchemist", "Alchemist", {
      gradeDescriptions: {
        G: "Alchemist-at-race-G",
        E: "Alchemist-prof-E prose",
      },
    })
    seedCharacterWith({
      raceId: "race-h",
      classId: "cls-a",
      professionId: "prof-b",
      raceGrade: "G",
      classGrade: "F",
      professionGrade: "E",
    })
    const detail = await getCharacter("chr-1", user)
    expect(detail.raceGradeDescription).toBe("Human G prose")
    expect(detail.classGradeDescription).toBe("Archer-class-F prose")
    expect(detail.professionGradeDescription).toBe("Alchemist-prof-E prose")
  })

  it("still exposes grade prose for archived race/class/profession definitions owned by the character", async () => {
    seedDefinition("race-h", "races", "human", "Human", {
      archived: true,
      gradeDescriptions: { G: "Archived Human G prose" },
    })
    seedDefinition("cls-a", "classes", "archer", "Archer", {
      archived: true,
      gradeDescriptions: { F: "Archived Archer F prose" },
    })
    seedDefinition("prof-b", "professions", "alchemist", "Alchemist", {
      archived: true,
      gradeDescriptions: { E: "Archived Alchemist E prose" },
    })
    seedCharacterWith({
      raceId: "race-h",
      classId: "cls-a",
      professionId: "prof-b",
      raceGrade: "G",
      classGrade: "F",
      professionGrade: "E",
    })
    const detail = await getCharacter("chr-1", user)
    expect(detail.raceGradeDescription).toBe("Archived Human G prose")
    expect(detail.classGradeDescription).toBe("Archived Archer F prose")
    expect(detail.professionGradeDescription).toBe("Archived Alchemist E prose")
  })

  it("returns null for an empty / non-matching map and never falls back to the legacy description", async () => {
    seedDefinition("race-h", "races", "human", "Human", {
      description: "Human general description",
      gradeDescriptions: {}, // old row reads back {}
    })
    seedDefinition("cls-a", "classes", "archer", "Archer", {
      description: "Archer general description",
      // Class track grade is F; only a G key exists -> no match.
      gradeDescriptions: { G: "Archer G prose" },
    })
    seedDefinition("prof-b", "professions", "alchemist", "Alchemist", {
      grade: "B",
      gradeDescriptions: { D: "Alchemist D prose" },
    })
    seedCharacterWith({
      raceId: "race-h",
      classId: "cls-a",
      professionId: "prof-b",
      raceGrade: "G",
      classGrade: "F",
      professionGrade: "E",
    })
    const detail = await getCharacter("chr-1", user)
    expect(detail.raceGradeDescription).toBeNull()
    expect(detail.classGradeDescription).toBeNull()
    expect(detail.professionGradeDescription).toBeNull()
  })

  it("surfaces gradeDescription on a graded linked association at the definition's own grade", async () => {
    seedDefinition("race-h", "races", "human", "Human", {
      gradeDescriptions: { C: "Human C prose" },
    })
    seedDefinition("sk-1", "skills", "fireball", "Fireball", {
      grade: "D",
      gradeDescriptions: { D: "Fireball D prose" },
    })
    seedDefinition("tt-1", "titles", "pioneer", "Pioneer", {
      grade: "B",
      gradeDescriptions: { B: "Pioneer B prose" },
    })
    seedCharacterWith({ raceId: "race-h", raceGrade: "C" })
    seedAssociation("sk-1", "SKILL")
    seedAssociation("tt-1", "TITLE")
    const detail = await getCharacter("chr-1", user)
    const skill = detail.associations.find((a) => a.definitionId === "sk-1")!
    const title = detail.associations.find((a) => a.definitionId === "tt-1")!
    expect(skill.gradeDescription).toBe("Fireball D prose")
    expect(title.gradeDescription).toBe("Pioneer B prose")
  })

  it("leaves gradeDescription absent for a linked definition with a null catalog grade", async () => {
    seedDefinition("race-h", "races", "human", "Human", {
      gradeDescriptions: { C: "Human C prose" },
    })
    seedDefinition("sk-2", "skills", "arrow", "Arrow", {
      grade: null,
      gradeDescriptions: { C: "Arrow C prose" },
    })
    seedCharacterWith({ raceId: "race-h", raceGrade: "C" })
    seedAssociation("sk-2", "SKILL")
    const detail = await getCharacter("chr-1", user)
    const skill = detail.associations.find((a) => a.definitionId === "sk-2")!
    expect(skill.gradeDescription).toBeUndefined()
    expect("gradeDescription" in skill).toBe(false)
  })

  it("resolves an association gradeDescription from the definition's own grade, not the character's race grade", async () => {
    seedDefinition("race-h", "races", "human", "Human", {
      gradeDescriptions: { C: "Human C prose" },
    })
    seedDefinition("sk-3", "skills", "beam", "Beam", {
      grade: "F",
      gradeDescriptions: { C: "Beam-at-race-C prose", F: "Beam-F prose" },
    })
    seedCharacterWith({ raceId: "race-h", raceGrade: "C" })
    seedAssociation("sk-3", "SKILL")
    const detail = await getCharacter("chr-1", user)
    const skill = detail.associations.find((a) => a.definitionId === "sk-3")!
    expect(skill.gradeDescription).toBe("Beam-F prose")
  })
})

describe("character list-item race grade / level / configured band", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function seedListCharacter(
    raceGrade: Grade,
    raceLevel: number,
    overrides: Record<string, unknown> = {}
  ): void {
    const state = createCharacterState({
      baseAttributes: makeVector({}),
      tracks: {},
      race: { level: raceLevel, grade: raceGrade, mode: "derived" },
    })
    dbMock.store.addCharacter({
      id: "chr-list",
      ownerId: user.id,
      name: "List Grade",
      state: serializeState(state),
      ...overrides,
    })
  }

  function charFixture(
    state: CharacterState
  ): Parameters<typeof toListItem>[0] {
    return {
      id: "chr-fixture",
      ownerId: user.id,
      name: "Fixture",
      description: null,
      nickname: null,
      pronouns: null,
      ageDescription: null,
      appearance: null,
      biography: null,
      notes: null,
      origin: "integrated",
      raceId: null,
      classId: null,
      professionId: null,
      state: serializeState(state),
      version: 0,
      archived: false,
      imported: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      race: null,
      class: null,
      profession: null,
      associations: [],
      inventory: [],
      skillOffers: [],
      assets: [],
    } as Parameters<typeof toListItem>[0]
  }

  it("uses the stored race grade for the G/F overlap, never gradeForLevel", async () => {
    // A G-origin integrated race whose stored grade is G but whose level (12) would
    // make `gradeForLevel` derive F (F entry level is 10). The authoritative grade
    // and its configured band must come from the stored state, not the level.
    seedListCharacter("G", 12)
    const items = await listCharacters(user)
    expect(items).toHaveLength(1)
    expect(items[0].raceGrade).toBe("G")
    expect(items[0].raceLevel).toBe(12)
    expect(items[0].raceGradeBand).toEqual({ min: 0, max: 9 })
  })

  it("exposes a born high-grade race at level 0 as-is, outside its band", async () => {
    seedListCharacter("B", 0)
    const items = await listCharacters(user)
    expect(items).toHaveLength(1)
    expect(items[0].raceGrade).toBe("B")
    expect(items[0].raceLevel).toBe(0)
    // B band is 350..499; a level-0 born B sits outside it, but the band is
    // exposed as-is (the starting grade is provenance driven, not level driven).
    expect(items[0].raceGradeBand).toEqual({ min: 350, max: 499 })
  })

  it("returns identical grade fields for archived / withStatus / noStatus reads", async () => {
    seedListCharacter("E", 30, { archived: true })
    const noStatus = await listCharacters(user, { includeArchived: true })
    expect(noStatus).toHaveLength(1)
    expect(noStatus[0].raceGrade).toBe("E")
    expect(noStatus[0].raceLevel).toBe(30)
    expect(noStatus[0].raceGradeBand).toEqual({ min: 25, max: 99 })

    const withStatus = await listCharacters(user, {
      withStatus: true,
      includeArchived: true,
    })
    expect(withStatus).toHaveLength(1)
    expect(withStatus[0].raceGrade).toBe("E")
    expect(withStatus[0].raceLevel).toBe(30)
    expect(withStatus[0].raceGradeBand).toEqual({ min: 25, max: 99 })
  })

  it("maps a custom configured grade-table band for the grade", async () => {
    const config = defaultRulesConfig()
    config.gradeTable = [
      { grade: "G", min: 0, max: 9, entryLevel: 0 },
      { grade: "F", min: 0, max: 24, entryLevel: 10 },
      { grade: "B", min: 300, max: 449, entryLevel: 300 },
    ]
    const state = createCharacterState({
      baseAttributes: makeVector({}),
      tracks: {},
      race: { level: 0, grade: "B", mode: "derived" },
    })
    const item = await toListItem(charFixture(state), false, config, 7, state)
    expect(item.raceGrade).toBe("B")
    expect(item.raceLevel).toBe(0)
    expect(item.raceGradeBand).toEqual({ min: 300, max: 449 })
  })

  it("reads a null grade band when the grade has no configured band", async () => {
    const config = defaultRulesConfig()
    config.gradeTable = [
      { grade: "G", min: 0, max: 9, entryLevel: 0 },
      { grade: "F", min: 0, max: 24, entryLevel: 10 },
    ]
    const state = createCharacterState({
      baseAttributes: makeVector({}),
      tracks: {},
      race: { level: 0, grade: "B", mode: "derived" },
    })
    const item = await toListItem(charFixture(state), false, config, 7, state)
    expect(item.raceGrade).toBe("B")
    expect(item.raceLevel).toBe(0)
    expect(item.raceGradeBand).toBeNull()
  })
})

describe("character list-item portrait (authenticated dashboard URL)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function baseState(): CharacterState {
    return createCharacterState({
      baseAttributes: makeVector({}),
      tracks: {},
      race: { level: 0, grade: "F", mode: "derived" },
    })
  }

  function seedState(overrides: Record<string, unknown> = {}): string {
    return dbMock.store.addCharacter({
      id: "chr-portrait",
      ownerId: user.id,
      name: "Portrait",
      description: null,
      state: serializeState(baseState()),
      version: 0,
      ...(overrides as Record<string, unknown>),
    }).id
  }

  function seedOtherOwnerState(): void {
    dbMock.store.addCharacter({
      id: "chr-other",
      ownerId: "user-2",
      name: "Other",
      description: null,
      state: serializeState(baseState()),
      version: 0,
    })
    dbMock.store.addAsset({
      id: "asset-other",
      characterId: "chr-other",
    })
  }

  it("exposes the canonical authenticated portrait URL for a character with a portrait", async () => {
    seedState()
    dbMock.store.addAsset({
      id: "asset-portrait",
      kind: "character-avatar",
      characterId: "chr-portrait",
      url: "/api/assets/asset-portrait",
      updatedAt: new Date("2026-01-02"),
    })
    const items = await listCharacters(user)
    expect(items).toHaveLength(1)
    expect(items[0].portrait).toEqual({
      assetId: "asset-portrait",
      url: "/api/assets/asset-portrait",
    })
  })

  it("returns a null portrait for a character without one", async () => {
    seedState()
    const items = await listCharacters(user)
    expect(items).toHaveLength(1)
    expect(items[0].portrait).toBeNull()
  })

  it("keeps a portrait on an archived character in the list", async () => {
    seedState({ archived: true })
    dbMock.store.addAsset({
      id: "asset-portrait",
      characterId: "chr-portrait",
    })
    const items = await listCharacters(user, { includeArchived: true })
    expect(items).toHaveLength(1)
    expect(items[0].archived).toBe(true)
    expect(items[0].portrait).toEqual({
      assetId: "asset-portrait",
      url: "/api/assets/asset-portrait",
    })
  })

  it("derives the URL from the asset id via the canonical route, never a stored path", async () => {
    seedState()
    // Even if the persisted `url` column were a filesystem path, the public DTO
    // must use the canonical authenticated `/api/assets/{id}` route.
    dbMock.store.addAsset({
      id: "asset-portrait",
      characterId: "chr-portrait",
      url: "/data/uploads/portrait.webp",
    })
    const items = await listCharacters(user)
    expect(items[0].portrait).toEqual({
      assetId: "asset-portrait",
      url: "/api/assets/asset-portrait",
    })
  })

  it("scopes the list (and its portrait) to the owning user for a non-admin", async () => {
    seedState()
    seedOtherOwnerState()
    const items = await listCharacters(user)
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe("chr-portrait")
    expect(items[0].portrait).toBeNull()
  })

  it("carries derivedStats in the typed status DTO when withStatus is set", async () => {
    seedState()
    const items = await listCharacters(user, { withStatus: true })
    expect(items).toHaveLength(1)
    const status = items[0].status!
    expect(status.derivedStats).toBeDefined()
    expect(typeof status.derivedStats.hp).toBe("number")
    expect(typeof status.derivedStats.mp).toBe("number")
    expect(typeof status.derivedStats.sp).toBe("number")
  })
})

describe("listCharacters shares the unarchived-skill map across items", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function seedCharWithGrant(id: string): void {
    const state = createInitialState("integrated", null, null)
    state.baseAttributes = { ...state.baseAttributes, strength: 100 }
    dbMock.store.addCharacter({
      id,
      ownerId: user.id,
      name: `Test ${id}`,
      state: serializeState(state),
      version: 0,
    })
    dbMock.store.addAssociation({
      characterId: id,
      definitionId: "gear-1",
      kind: "EQUIPMENT",
    })
  }

  function seedGrantSkill(): void {
    dbMock.store.addCatalog({
      id: "sk-1",
      kind: "skills",
      stableId: "sk-1",
      name: "Skill sk-1",
      config: {
        track: "class",
        milestone: 4,
        rarity: "Common",
        effects: [{ phase: "flat", amount: { strength: 5 } }],
      },
    })
  }

  function seedGrantGear(): void {
    dbMock.store.addCatalog({
      id: "gear-1",
      kind: "equipment",
      stableId: "gear-1",
      name: "Gear 1",
      config: {
        slot: "Head",
        rarity: "Common",
        grantedSkillStableIds: ["sk-1"],
      },
    })
  }

  function strengthFlatDelta(status: unknown): number {
    const traces = (
      status as {
        traces: Array<{
          attribute: string
          phases: Array<{ phase: string; delta: number }>
        }>
      }
    ).traces
    const strength = traces.find((t) => t.attribute === "strength")
    if (!strength) return 0
    const flat = strength.phases.find((p) => p.phase === "flat")
    return flat?.delta ?? 0
  }

  it("loads the unarchived-skill map ONCE for a withStatus list of 3 granted characters", async () => {
    seedGrantSkill()
    seedGrantGear()
    seedCharWithGrant("chr-1")
    seedCharWithGrant("chr-2")
    seedCharWithGrant("chr-3")
    const spy = vi.spyOn(prisma.catalogDefinition, "findMany")
    try {
      const items = await listCharacters(user, { withStatus: true })
      expect(items).toHaveLength(3)
      for (const item of items) {
        expect(strengthFlatDelta(item.status)).toBe(5)
      }
      // A single unarchived-skill query for the whole request, never one per item.
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { kind: "skills", archived: false },
        })
      )
    } finally {
      spy.mockRestore()
    }
  })

  it("does not load the unarchived-skill map for a status-less list", async () => {
    seedGrantSkill()
    seedGrantGear()
    seedCharWithGrant("chr-1")
    seedCharWithGrant("chr-2")
    seedCharWithGrant("chr-3")
    const spy = vi.spyOn(prisma.catalogDefinition, "findMany")
    try {
      const items = await listCharacters(user)
      expect(items).toHaveLength(3)
      for (const item of items) expect(item.status).toBeUndefined()
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})

describe("experienceCharacter (authoritative EXP percent)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function seedClassCatalog() {
    dbMock.store.addCatalog({
      id: "cls-1",
      kind: "classes",
      stableId: "archer",
      name: "Archer",
      grade: "F",
      config: { grades: { F: { fixed: { agility: 2 }, free: 1 } } },
    })
  }

  function seedHumanRace() {
    dbMock.store.addCatalog({
      id: "race-e",
      kind: "races",
      stableId: "human",
      name: "Human",
      config: {
        raceType: "enlightened",
        naturalGrade: "F",
        raceDefinitions: {
          G: { id: "human:G", perLevel: { strength: 1 }, freePerLevel: 1 },
          F: { id: "human:F", perLevel: { strength: 1 }, freePerLevel: 1 },
        },
      },
    })
  }

  function seedMonsterRace() {
    dbMock.store.addCatalog({
      id: "race-m",
      kind: "races",
      stableId: "wyrm",
      name: "Wyrm",
      config: {
        raceType: "monster",
        naturalGrade: "F",
        raceDefinitions: {
          F: { id: "wyrm:F", perLevel: { strength: 2 }, freePerLevel: 1 },
        },
      },
    })
  }

  function seedSkill(id: string, config: Record<string, unknown>) {
    dbMock.store.addCatalog({
      id,
      kind: "skills",
      stableId: id,
      name: `Skill ${id}`,
      config,
    })
  }

  // A derived (enlightened) human class state, legacy by default (no explicit
  // experiencePercent unless provided). The race level is kept consistent with the
  // class level under the floorHalfAvg derivation (class + profession, halved), so
  // the level-up undo's derived-race sanity check passes.
  function classState(
    level: number,
    quarter: number,
    percent: number | undefined,
    grade: Grade = "F",
    turn = 0
  ): unknown {
    const state = createInitialState("integrated", null, null)
    state.tracks.class = {
      level,
      quarter,
      definitionId: "archer:F",
      grade,
      ...(percent != null ? { experiencePercent: percent } : {}),
    }
    state.race.level = Math.floor(level / 2)
    state.turn = turn
    return serializeState(state)
  }

  function monsterState(
    level: number,
    quarter: number,
    percent: number | undefined
  ): unknown {
    const state = createInitialState("born", null, null)
    state.race = {
      level,
      quarter,
      grade: "F",
      mode: "independent",
      origin: "born",
      ...(percent != null ? { experiencePercent: percent } : {}),
    }
    state.tracks = {}
    return serializeState(state)
  }

  function seedCharacter(
    state: unknown,
    overrides: Partial<Record<string, unknown>> = {}
  ): unknown {
    return dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      classId: "cls-1",
      state,
      version: 0,
      ...(overrides as Record<string, unknown>),
    })
  }

  function experienceEvents(): Array<{ kind: string }> {
    return dbMock.store.events.filter((e) => e.kind !== "create")
  }

  function seedOffer(
    id: string,
    opts: {
      track?: string
      level?: number
      choiceGroup?: string
      canceledAt?: Date | null
      selectedDefinitionId?: string | null
      options: Array<{ definitionId: string }>
    }
  ): void {
    dbMock.store.skillOffers.push({
      id,
      characterId: "chr-1",
      track: opts.track ?? "class",
      level: opts.level ?? 4,
      choiceGroup: opts.choiceGroup ?? "standard",
      generation: 0,
      canceledAt: opts.canceledAt ?? null,
      selectedDefinitionId: opts.selectedDefinitionId ?? null,
      offeredAt: new Date(),
      selectedAt: opts.selectedDefinitionId ? new Date() : null,
    })
    for (const o of opts.options) {
      dbMock.store.skillOfferOptions.push({
        id: `opt-${id}-${o.definitionId}`,
        offerId: id,
        definitionId: o.definitionId,
        nameSnapshot: `Skill ${o.definitionId}`,
        configSnapshot: {},
      })
    }
  }

  it("advances the turn when a forward set crosses a quarter boundary (24->25)", async () => {
    seedHumanRace()
    seedClassCatalog()
    const created = await createCharacter(
      {
        name: "Kael",
        origin: "integrated",
        raceId: "race-e",
        classId: "cls-1",
      },
      user
    )
    // Settle 24% first (same quarter, no turn change).
    const a = await experienceCharacter(
      created.id,
      { operation: "set", track: "class", percent: 24, version: 0 },
      user
    )
    const aState = a.character.state as CharacterState
    expect(aState.tracks.class.experiencePercent).toBe(24)
    expect(aState.tracks.class.quarter).toBe(0)
    expect(aState.turn).toBe(0)
    expect((a.journal as { turnsAdvanced: number }).turnsAdvanced).toBe(0)

    // Cross the 24->25 quarter boundary: exactly one advance, one turn.
    const b = await experienceCharacter(
      created.id,
      {
        operation: "set",
        track: "class",
        percent: 25,
        version: a.character.version,
      },
      user
    )
    const bState = b.character.state as CharacterState
    expect(bState.tracks.class.experiencePercent).toBe(25)
    expect(bState.tracks.class.quarter).toBe(1)
    expect(bState.turn).toBe(1)
    expect((b.journal as { turnsAdvanced: number }).turnsAdvanced).toBe(1)

    const events = experienceEvents()
    expect(events).toHaveLength(2)
    expect(events[0].kind).toBe("experience_set")
    expect(events[1].kind).toBe("experience_set")
  })

  it("levels up on a 75->100 set, snapshots the award and generates offers once", async () => {
    seedHumanRace()
    seedClassCatalog()
    seedCharacter(classState(3, 3, 75), { raceId: "race-e" })
    seedSkill("sk-1", {
      track: "class",
      milestone: 4,
      effects: [{ phase: "flat", amount: { strength: 1 }, stacking: "stack" }],
    })
    const res = await experienceCharacter(
      "chr-1",
      { operation: "set", track: "class", percent: 100, version: 0 },
      user
    )
    const journal = res.journal as {
      leveledUp: boolean
      levelAfter: number
      award?: unknown
      characterVersionAfter?: number
    }
    expect(journal.leveledUp).toBe(true)
    expect(journal.levelAfter).toBe(4)
    expect(journal.award).toBeDefined()
    expect(journal.characterVersionAfter).toBe(1)
    expect(res.character.version).toBe(1)
    // Exactly one offer, at the new level.
    expect(dbMock.store.skillOffers).toHaveLength(1)
    expect(dbMock.store.skillOffers[0].level).toBe(4)
    expect(experienceEvents()).toHaveLength(1)
    expect(dbMock.store.events[0].kind).toBe("advance")
  })

  it("crosses three turns when leveling from 40", async () => {
    seedClassCatalog()
    seedCharacter(classState(0, 1, 40))
    const res = await experienceCharacter(
      "chr-1",
      { operation: "levelUp", track: "class", version: 0 },
      user
    )
    const journal = res.journal as {
      turnsAdvanced: number
      leveledUp: boolean
      levelAfter: number
    }
    expect(journal.turnsAdvanced).toBe(3)
    expect(journal.leveledUp).toBe(true)
    expect(journal.levelAfter).toBe(1)
    expect(experienceEvents()).toHaveLength(1)
    expect(dbMock.store.events[0].kind).toBe("advance")
  })

  it("does not rewind the turn on a backward set", async () => {
    seedClassCatalog()
    seedCharacter(classState(2, 3, 75, "F", 3))
    const res = await experienceCharacter(
      "chr-1",
      { operation: "set", track: "class", percent: 25, version: 0 },
      user
    )
    const state = res.character.state as CharacterState
    expect(state.turn).toBe(3)
    expect(state.tracks.class.experiencePercent).toBe(25)
    expect(state.tracks.class.quarter).toBe(1)
    // The level and its snapshotted awards are never revoked.
    expect(state.tracks.class.level).toBe(2)
    expect((res.journal as { turnsAdvanced: number }).turnsAdvanced).toBe(0)
    expect(experienceEvents()).toHaveLength(1)
    expect(dbMock.store.events[0].kind).toBe("experience_set")
  })

  it("settles an independent (monster) race on the race track", async () => {
    seedMonsterRace()
    seedCharacter(monsterState(0, 0, undefined), {
      classId: null,
      raceId: "race-m",
    })
    const res = await experienceCharacter(
      "chr-1",
      { operation: "set", track: "race", percent: 50, version: 0 },
      user
    )
    const state = res.character.state as CharacterState
    expect(state.race.experiencePercent).toBe(50)
    expect(state.race.quarter).toBe(2)
    expect(state.turn).toBe(2)
    expect((res.journal as { turnsAdvanced: number }).turnsAdvanced).toBe(2)
    expect(experienceEvents()).toHaveLength(1)
    expect(dbMock.store.events[0].kind).toBe("experience_set")
  })

  it("rejects class/profession tracks on a monster (race-only)", async () => {
    seedMonsterRace()
    seedCharacter(monsterState(0, 0, undefined), {
      classId: null,
      raceId: "race-m",
    })
    await expect(
      experienceCharacter(
        "chr-1",
        { operation: "set", track: "class", percent: 25, version: 0 },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "invalid_track" })
    await expect(
      experienceCharacter(
        "chr-1",
        { operation: "levelUp", track: "profession", version: 0 },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "invalid_track" })
    expect(dbMock.store.events).toHaveLength(0)
  })

  it("rejects the race track on a derived (enlightened) race", async () => {
    seedHumanRace()
    seedClassCatalog()
    seedCharacter(classState(0, 0, 0), { raceId: "race-e" })
    await expect(
      experienceCharacter(
        "chr-1",
        { operation: "set", track: "race", percent: 25, version: 0 },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "invalid_track" })
    expect(dbMock.store.events).toHaveLength(0)
  })

  it("rejects a no-op set with experience_unchanged and no event/version bump", async () => {
    seedClassCatalog()
    seedCharacter(classState(0, 1, 25))
    await expect(
      experienceCharacter(
        "chr-1",
        { operation: "set", track: "class", percent: 25, version: 0 },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "experience_unchanged" })
    expect(dbMock.store.characters.get("chr-1")!.version).toBe(0)
    expect(dbMock.store.events).toHaveLength(0)
  })

  it("rejects a stale version with 409 and writes no event (CAS)", async () => {
    seedClassCatalog()
    seedCharacter(classState(0, 0, 0))
    const results = await Promise.allSettled([
      experienceCharacter(
        "chr-1",
        { operation: "set", track: "class", percent: 25, version: 0 },
        user
      ),
      experienceCharacter(
        "chr-1",
        { operation: "set", track: "class", percent: 50, version: 0 },
        user
      ),
    ])
    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    const reason = (rejected[0] as PromiseRejectedResult).reason as {
      status?: number
      code?: string
    }
    expect(reason).toMatchObject({ status: 409, code: "version_conflict" })
    expect(dbMock.store.characters.get("chr-1")!.version).toBe(1)
    expect(dbMock.store.events).toHaveLength(1)
  })

  it("maps a serialization failure (P2034) on experience to 409 serialization_conflict and rolls back", async () => {
    seedClassCatalog()
    seedCharacter(classState(0, 0, 0))
    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce({
      name: "PrismaClientKnownRequestError",
      code: "P2034",
    })
    try {
      await expect(
        experienceCharacter(
          "chr-1",
          { operation: "set", track: "class", percent: 25, version: 0 },
          user
        )
      ).rejects.toMatchObject({ status: 409, code: "serialization_conflict" })
    } finally {
      spy.mockRestore()
    }
    expect(dbMock.store.characters.get("chr-1")!.version).toBe(0)
    expect(dbMock.store.events).toHaveLength(0)
  })

  it("rolls back state/turn/offers/event on a closed grade gate (400 grade_blocked)", async () => {
    seedHumanRace()
    seedClassCatalog()
    seedSkill("sk-1", {
      track: "class",
      milestone: 22,
      effects: [{ phase: "flat", amount: { strength: 1 }, stacking: "stack" }],
    })
    const state = createInitialState("integrated", null, null)
    state.tracks.class = {
      level: 21,
      quarter: 3,
      definitionId: "archer:F",
      grade: "F",
      experiencePercent: 75,
    }
    state.race.level = 10
    state.turn = 3
    seedCharacter(serializeState(state), { raceId: "race-e" })

    await expect(
      experienceCharacter(
        "chr-1",
        { operation: "set", track: "class", percent: 100, version: 0 },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "grade_blocked" })

    const fresh = dbMock.store.characters.get("chr-1")!
    expect(fresh.version).toBe(0)
    expect(dbMock.store.events).toHaveLength(0)
    expect(dbMock.store.skillOffers).toHaveLength(0)
    const st = deserializeState(fresh.state) as CharacterState
    expect(st.turn).toBe(3)
    expect(st.tracks.class.level).toBe(21)
    expect(st.tracks.class.quarter).toBe(3)
  })

  it("maps the class track grade gate to 400 grade_blocked (not a 500) and writes nothing", async () => {
    seedHumanRace()
    seedClassCatalog()
    // Class grade F levels 25 -> 26 on the 75 -> 100 set. F's next grade is E
    // (entryLevel 25), so 26 pushes PAST the threshold: the independent
    // class/profession TRACK gate (not the race gate) must reject as 400
    // grade_blocked, never leak as a 500.
    const state = createInitialState("integrated", null, null)
    state.tracks.class = {
      level: 25,
      quarter: 3,
      definitionId: "archer:F",
      grade: "F",
      experiencePercent: 75,
    }
    state.race.level = 10
    state.turn = 3
    seedCharacter(serializeState(state), { raceId: "race-e" })

    const err = await experienceCharacter(
      "chr-1",
      { operation: "set", track: "class", percent: 100, version: 0 },
      user
    ).catch((e) => e)
    expect(err).toMatchObject({ status: 400, code: "grade_blocked" })
    expect((err as Error).message).toContain(
      "without completed track evolution"
    )

    const fresh = dbMock.store.characters.get("chr-1")!
    expect(fresh.version).toBe(0)
    expect(dbMock.store.events).toHaveLength(0)
    expect(dbMock.store.skillOffers).toHaveLength(0)
    const st = deserializeState(fresh.state) as CharacterState
    expect(st.turn).toBe(3)
    expect(st.tracks.class.level).toBe(25)
    expect(st.tracks.class.quarter).toBe(3)
  })

  it("maps the profession track grade gate to 400 grade_blocked (not a 500) and writes nothing", async () => {
    seedHumanRace()
    dbMock.store.addCatalog({
      id: "prof-1",
      kind: "professions",
      stableId: "alchemist",
      name: "Alchemist",
      config: { grades: { F: { fixed: { intelligence: 1 }, free: 1 } } },
    })
    // Profession grade F levels 25 -> 26 on the 75 -> 100 set. F's next grade is
    // E (entryLevel 25), so 26 pushes PAST the threshold: the independent
    // profession TRACK gate must reject as 400 grade_blocked.
    const state = createInitialState("integrated", null, null)
    state.tracks.profession = {
      level: 25,
      quarter: 3,
      definitionId: "alchemist:F",
      grade: "F",
      experiencePercent: 75,
    }
    state.race.level = 10
    state.turn = 3
    seedCharacter(serializeState(state), {
      raceId: "race-e",
      classId: null,
      professionId: "prof-1",
    })

    const err = await experienceCharacter(
      "chr-1",
      { operation: "set", track: "profession", percent: 100, version: 0 },
      user
    ).catch((e) => e)
    expect(err).toMatchObject({ status: 400, code: "grade_blocked" })
    expect((err as Error).message).toContain(
      "without completed track evolution"
    )

    const fresh = dbMock.store.characters.get("chr-1")!
    expect(fresh.version).toBe(0)
    expect(dbMock.store.events).toHaveLength(0)
    expect(dbMock.store.skillOffers).toHaveLength(0)
    const st = deserializeState(fresh.state) as CharacterState
    expect(st.turn).toBe(3)
    expect(st.tracks.profession.level).toBe(25)
    expect(st.tracks.profession.quarter).toBe(3)
  })

  it("legacy /advance synchronizes experiencePercent to quarter*25 and records characterVersionAfter", async () => {
    seedHumanRace()
    seedClassCatalog()
    const created = await createCharacter(
      {
        name: "Kael",
        origin: "integrated",
        raceId: "race-e",
        classId: "cls-1",
      },
      user
    )
    const before = created.state as CharacterState
    // The legacy class track carries no explicit experiencePercent.
    expect(before.tracks.class.experiencePercent).toBeUndefined()

    const res = await advanceCharacter(
      created.id,
      { track: "class", version: 0 },
      user
    )
    const state = res.character.state as CharacterState
    expect(state.tracks.class.quarter).toBe(1)
    // The engine synchronizes the authoritative percent to the quarter boundary.
    expect(state.tracks.class.experiencePercent).toBe(25)
    expect(state.tracks.class.experiencePercent).toBe(
      state.tracks.class.quarter * 25
    )

    // The advance event payload carries the post-commit version for deterministic
    // undo. (events[0] is the create event; events[1] is the advance.)
    const advancePayload = dbMock.store.events[1].payload as {
      journal: { characterVersionAfter?: number }
    }
    expect(advancePayload.journal.characterVersionAfter).toBe(1)
  })

  // ------------------------------------------------------------------ //
  // Level-up undo (operation: "undo")
  // ------------------------------------------------------------------ //

  it("undoes the most recent class level-up (75->100) and restores the prior EXP", async () => {
    seedHumanRace()
    seedClassCatalog()
    seedCharacter(classState(3, 3, 75), { raceId: "race-e" })
    const leveled = await experienceCharacter(
      "chr-1",
      { operation: "set", track: "class", percent: 100, version: 0 },
      user
    )
    const leveledState = leveled.character.state as CharacterState
    expect(leveledState.tracks.class.level).toBe(4)
    expect(leveledState.tracks.class.quarter).toBe(0)
    expect(leveledState.tracks.class.experiencePercent).toBe(0)

    const undone = await experienceCharacter(
      "chr-1",
      { operation: "undo", track: "class", version: leveled.character.version },
      user
    )
    const state = undone.character.state as CharacterState
    expect(state.tracks.class.level).toBe(3)
    expect(state.tracks.class.quarter).toBe(3)
    expect(state.tracks.class.experiencePercent).toBe(75)
    // The derived race level is restored, not left elevated.
    expect(state.race.level).toBe(1)
    // The turn was advanced by the level-up and is never rewound by the undo.
    expect(state.turn).toBe(leveledState.turn)
    const journal = undone.journal as {
      leveledUp: boolean
      undone: boolean
      levelAfter: number
      percentAfter: number
      raceLevelAfter: number
    }
    expect(journal.leveledUp).toBe(false)
    expect(journal.undone).toBe(true)
    expect(journal.levelAfter).toBe(3)
    expect(journal.percentAfter).toBe(75)
    expect(journal.raceLevelAfter).toBe(1)
  })

  it("undoes the most recent race level-up on a monster and restores the prior quarter/percent", async () => {
    seedMonsterRace()
    seedCharacter(monsterState(0, 3, undefined), {
      classId: null,
      raceId: "race-m",
    })
    const leveled = await experienceCharacter(
      "chr-1",
      { operation: "levelUp", track: "race", version: 0 },
      user
    )
    const leveledState = leveled.character.state as CharacterState
    expect(leveledState.race.level).toBe(1)

    const undone = await experienceCharacter(
      "chr-1",
      { operation: "undo", track: "race", version: leveled.character.version },
      user
    )
    const state = undone.character.state as CharacterState
    expect(state.race.level).toBe(0)
    expect(state.race.quarter).toBe(3)
    expect(state.race.experiencePercent).toBe(75)
    expect(state.turn).toBe(leveledState.turn)
    const journal = undone.journal as { undone: boolean; levelAfter: number }
    expect(journal.undone).toBe(true)
    expect(journal.levelAfter).toBe(0)
  })

  it("restores the prior EXP (40%) when undoing a level-up that was submitted from 40", async () => {
    seedHumanRace()
    seedClassCatalog()
    seedCharacter(classState(0, 1, 40), { raceId: "race-e" })
    const leveled = await experienceCharacter(
      "chr-1",
      { operation: "levelUp", track: "class", version: 0 },
      user
    )
    expect((leveled.character.state as CharacterState).tracks.class.level).toBe(
      1
    )
    const undone = await experienceCharacter(
      "chr-1",
      { operation: "undo", track: "class", version: leveled.character.version },
      user
    )
    const state = undone.character.state as CharacterState
    expect(state.tracks.class.level).toBe(0)
    expect(state.tracks.class.quarter).toBe(1)
    expect(state.tracks.class.experiencePercent).toBe(40)
  })

  it("restores prior EXP from quarterBefore*25 (75) for a legacy /advance with no percentBefore", async () => {
    seedHumanRace()
    seedClassCatalog()
    seedCharacter(classState(0, 3, undefined), { raceId: "race-e" })
    const advanced = await advanceCharacter(
      "chr-1",
      { track: "class", version: 0 },
      user
    )
    const advancedState = advanced.character.state as CharacterState
    expect(advancedState.tracks.class.level).toBe(1)
    expect(advancedState.tracks.class.experiencePercent).toBe(0)
    const undone = await experienceCharacter(
      "chr-1",
      {
        operation: "undo",
        track: "class",
        version: advanced.character.version,
      },
      user
    )
    const state = undone.character.state as CharacterState
    expect(state.tracks.class.level).toBe(0)
    expect(state.tracks.class.quarter).toBe(3)
    expect(state.tracks.class.experiencePercent).toBe(75)
  })

  it("removes the derived race award (and the class award) when undoing a level-up with a race gain", async () => {
    seedHumanRace()
    seedClassCatalog()
    seedCharacter(classState(3, 3, 75), { raceId: "race-e" })
    const leveled = await experienceCharacter(
      "chr-1",
      { operation: "set", track: "class", percent: 100, version: 0 },
      user
    )
    const after = leveled.character.state as CharacterState
    expect(
      after.historicalLevelAwards.some(
        (a) => a.track === "class" && a.level === 4
      )
    ).toBe(true)
    expect(
      after.historicalLevelAwards.some(
        (a) => a.track === "race" && a.level === 2
      )
    ).toBe(true)
    const undone = await experienceCharacter(
      "chr-1",
      { operation: "undo", track: "class", version: leveled.character.version },
      user
    )
    const state = undone.character.state as CharacterState
    expect(
      state.historicalLevelAwards.some(
        (a) => a.track === "class" && a.level === 4
      )
    ).toBe(false)
    expect(
      state.historicalLevelAwards.some(
        (a) => a.track === "race" && a.level === 2
      )
    ).toBe(false)
  })

  it("blocks undo (level_undo_blocked) when the generated skill offer was selected", async () => {
    seedHumanRace()
    seedClassCatalog()
    seedSkill("sk-1", {
      track: "class",
      milestone: 4,
      effects: [{ phase: "flat", amount: { strength: 1 }, stacking: "stack" }],
    })
    seedCharacter(classState(3, 3, 75), { raceId: "race-e" })
    const leveled = await experienceCharacter(
      "chr-1",
      { operation: "set", track: "class", percent: 100, version: 0 },
      user
    )
    expect(dbMock.store.skillOffers).toHaveLength(1)
    // Simulate an answered offer (direct store mutation keeps the version/event
    // history untouched so the selected-offer guard is what rejects).
    dbMock.store.skillOffers[0].selectedDefinitionId = "sk-1"
    await expect(
      experienceCharacter(
        "chr-1",
        {
          operation: "undo",
          track: "class",
          version: leveled.character.version,
        },
        user
      )
    ).rejects.toMatchObject({ status: 409, code: "level_undo_blocked" })
  })

  it("blocks undo (level_undo_blocked) when the awarded free points were already spent", async () => {
    seedHumanRace()
    seedClassCatalog()
    seedCharacter(classState(3, 3, 75), { raceId: "race-e" })
    const leveled = await experienceCharacter(
      "chr-1",
      { operation: "set", track: "class", percent: 100, version: 0 },
      user
    )
    // Spend all the free points awarded by this level-up (1 class + 1 race) so the
    // undo would leave the character in a free-point deficit.
    const row = dbMock.store.characters.get("chr-1")!
    const st = deserializeState(row.state) as CharacterState
    st.allocations = [
      {
        id: "alloc-1",
        source: "test",
        at: 0,
        points: makeVector({ strength: 2 }),
      },
    ]
    row.state = serializeState(st)
    await expect(
      experienceCharacter(
        "chr-1",
        {
          operation: "undo",
          track: "class",
          version: leveled.character.version,
        },
        user
      )
    ).rejects.toMatchObject({ status: 409, code: "level_undo_blocked" })
  })

  it("blocks undo (level_undo_blocked) after the track definition changed (an evolution)", async () => {
    seedHumanRace()
    seedClassCatalog()
    seedCharacter(classState(3, 3, 75), { raceId: "race-e" })
    const leveled = await experienceCharacter(
      "chr-1",
      { operation: "set", track: "class", percent: 100, version: 0 },
      user
    )
    // Simulate a track evolution that changed the definition id without recording a
    // superseding event: the definition-drift guard must reject.
    const row = dbMock.store.characters.get("chr-1")!
    const st = deserializeState(row.state) as CharacterState
    st.tracks.class.definitionId = "archer:E"
    row.state = serializeState(st)
    await expect(
      experienceCharacter(
        "chr-1",
        {
          operation: "undo",
          track: "class",
          version: leveled.character.version,
        },
        user
      )
    ).rejects.toMatchObject({ status: 409, code: "level_undo_blocked" })
  })

  it("blocks undo (level_undo_blocked) after an in-level percent edit moved off the boundary", async () => {
    seedHumanRace()
    seedClassCatalog()
    seedCharacter(classState(3, 3, 75), { raceId: "race-e" })
    const leveled = await experienceCharacter(
      "chr-1",
      { operation: "set", track: "class", percent: 100, version: 0 },
      user
    )
    // Move off the level-up boundary (quarter 0 / 0%) without recording an event.
    const row = dbMock.store.characters.get("chr-1")!
    const st = deserializeState(row.state) as CharacterState
    st.tracks.class.quarter = 1
    st.tracks.class.experiencePercent = 25
    row.state = serializeState(st)
    await expect(
      experienceCharacter(
        "chr-1",
        {
          operation: "undo",
          track: "class",
          version: leveled.character.version,
        },
        user
      )
    ).rejects.toMatchObject({ status: 409, code: "level_undo_blocked" })
  })

  it("blocks undo (level_undo_blocked) when a later non-cosmetic event supersedes the level-up", async () => {
    seedHumanRace()
    seedClassCatalog()
    seedCharacter(classState(3, 3, 75), { raceId: "race-e" })
    const leveled = await experienceCharacter(
      "chr-1",
      { operation: "set", track: "class", percent: 100, version: 0 },
      user
    )
    dbMock.store.events.push({
      id: "evt-set-later",
      characterId: "chr-1",
      kind: "experience_set",
      payload: { percent: 50 },
      createdAt: new Date(Date.now() + 1000),
    })
    await expect(
      experienceCharacter(
        "chr-1",
        {
          operation: "undo",
          track: "class",
          version: leveled.character.version,
        },
        user
      )
    ).rejects.toMatchObject({ status: 409, code: "level_undo_blocked" })
  })

  it("cancels pending skill offers on undo and re-offers them as the next generation on re-level-up", async () => {
    seedHumanRace()
    seedClassCatalog()
    seedSkill("sk-1", {
      track: "class",
      milestone: 4,
      effects: [{ phase: "flat", amount: { strength: 1 }, stacking: "stack" }],
    })
    seedCharacter(classState(3, 3, 75), { raceId: "race-e" })
    const a = await experienceCharacter(
      "chr-1",
      { operation: "set", track: "class", percent: 100, version: 0 },
      user
    )
    expect(dbMock.store.skillOffers).toHaveLength(1)
    expect(dbMock.store.skillOffers[0].generation).toBe(0)

    const b = await experienceCharacter(
      "chr-1",
      { operation: "undo", track: "class", version: a.character.version },
      user
    )
    expect(dbMock.store.skillOffers[0].canceledAt).not.toBeNull()
    expect(
      (b.journal as { canceledOfferIds: string[] }).canceledOfferIds
    ).toContain(dbMock.store.skillOffers[0].id)

    const c = await experienceCharacter(
      "chr-1",
      {
        operation: "set",
        track: "class",
        percent: 100,
        version: b.character.version,
      },
      user
    )
    void c
    expect(dbMock.store.skillOffers).toHaveLength(2)
    const gens = dbMock.store.skillOffers
      .map((o) => o.generation)
      .sort((x, y) => x - y)
    expect(gens).toEqual([0, 1])
    expect(dbMock.store.skillOffers[1].canceledAt).toBeNull()
  })

  it("rejects a stale-version undo with 409 version_conflict and writes no level_undo event", async () => {
    seedHumanRace()
    seedClassCatalog()
    seedCharacter(classState(3, 3, 75), { raceId: "race-e" })
    const leveled = await experienceCharacter(
      "chr-1",
      { operation: "set", track: "class", percent: 100, version: 0 },
      user
    )
    const beforeEvents = dbMock.store.events.length
    await expect(
      experienceCharacter(
        "chr-1",
        { operation: "undo", track: "class", version: 0 },
        user
      )
    ).rejects.toMatchObject({ status: 409, code: "version_conflict" })
    expect(dbMock.store.events).toHaveLength(beforeEvents)
    expect(dbMock.store.characters.get("chr-1")!.version).toBe(
      leveled.character.version
    )
  })

  it("maps a serialization failure (P2034) on an undo to 409 serialization_conflict and rolls back", async () => {
    seedHumanRace()
    seedClassCatalog()
    seedCharacter(classState(3, 3, 75), { raceId: "race-e" })
    const leveled = await experienceCharacter(
      "chr-1",
      { operation: "set", track: "class", percent: 100, version: 0 },
      user
    )
    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce({
      name: "PrismaClientKnownRequestError",
      code: "P2034",
    })
    try {
      await expect(
        experienceCharacter(
          "chr-1",
          {
            operation: "undo",
            track: "class",
            version: leveled.character.version,
          },
          user
        )
      ).rejects.toMatchObject({ status: 409, code: "serialization_conflict" })
    } finally {
      spy.mockRestore()
    }
    expect(dbMock.store.characters.get("chr-1")!.version).toBe(
      leveled.character.version
    )
    expect(dbMock.store.skillOffers).toHaveLength(0)
    expect(dbMock.store.events).toHaveLength(1)
  })

  it("does not treat a later import_history event as authoritative (it neither supersedes nor blocks undo)", async () => {
    seedHumanRace()
    seedClassCatalog()
    seedCharacter(classState(0, 3, 75), { raceId: "race-e" })
    const leveled = await experienceCharacter(
      "chr-1",
      { operation: "set", track: "class", percent: 100, version: 0 },
      user
    )
    dbMock.store.events.push({
      id: "evt-import-later",
      characterId: "chr-1",
      kind: "import_history",
      payload: { journal: { leveledUp: true, levelAfter: 99 } },
      createdAt: new Date(Date.now() + 1000),
    })
    const undone = await experienceCharacter(
      "chr-1",
      { operation: "undo", track: "class", version: leveled.character.version },
      user
    )
    const state = undone.character.state as CharacterState
    expect(state.tracks.class.level).toBe(0)
    expect(state.tracks.class.quarter).toBe(3)
    expect(state.tracks.class.experiencePercent).toBe(75)
  })

  it("rejects an undo when only import_history (no live advance) exists", async () => {
    seedHumanRace()
    seedClassCatalog()
    seedCharacter(classState(1, 0, 0), { raceId: "race-e" })
    dbMock.store.events.push({
      id: "evt-import-only",
      characterId: "chr-1",
      kind: "import_history",
      payload: { journal: { leveledUp: true, levelBefore: 0, levelAfter: 1 } },
      createdAt: new Date(),
    })
    await expect(
      experienceCharacter(
        "chr-1",
        { operation: "undo", track: "class", version: 0 },
        user
      )
    ).rejects.toMatchObject({ status: 409, code: "level_undo_blocked" })
  })

  it("blocks undo (level_undo_blocked) when a progression event shares the level-up timestamp", async () => {
    seedHumanRace()
    seedClassCatalog()
    seedCharacter(classState(1, 0, 0), { raceId: "race-e" })
    const t = new Date()
    dbMock.store.events.push({
      id: "evt-adv",
      characterId: "chr-1",
      kind: "advance",
      payload: {
        track: "class",
        journal: {
          leveledUp: true,
          levelBefore: 0,
          levelAfter: 1,
          quarterBefore: 0,
          quarterAfter: 0,
          raceLevelBefore: 0,
          raceLevelAfter: 0,
          award: { definitionId: "archer:F", fixed: { agility: 2 }, free: 1 },
        },
      },
      createdAt: t,
    })
    dbMock.store.events.push({
      id: "evt-z",
      characterId: "chr-1",
      kind: "experience_set",
      payload: {},
      createdAt: t,
    })
    await expect(
      experienceCharacter(
        "chr-1",
        { operation: "undo", track: "class", version: 0 },
        user
      )
    ).rejects.toMatchObject({ status: 409, code: "level_undo_blocked" })
  })

  it("leaves the immutable advance event intact and appends a level_undo event", async () => {
    seedHumanRace()
    seedClassCatalog()
    seedCharacter(classState(3, 3, 75), { raceId: "race-e" })
    const leveled = await experienceCharacter(
      "chr-1",
      { operation: "set", track: "class", percent: 100, version: 0 },
      user
    )
    const advanceId = dbMock.store.events[0].id
    expect(dbMock.store.events[0].kind).toBe("advance")
    const undone = await experienceCharacter(
      "chr-1",
      { operation: "undo", track: "class", version: leveled.character.version },
      user
    )
    void undone
    // The original advance event is untouched.
    expect(dbMock.store.events.some((e) => e.kind === "advance")).toBe(true)
    expect(dbMock.store.events).toHaveLength(2)
    const undoEvt = dbMock.store.events[1]
    expect(undoEvt.kind).toBe("level_undo")
    expect(
      (undoEvt.payload as { originalEventId: string }).originalEventId
    ).toBe(advanceId)
    expect(
      (undoEvt.payload as { journal: { undone: boolean } }).journal.undone
    ).toBe(true)
  })

  it("records skillOfferIds as an empty list on a level-up that generates no offers", async () => {
    seedHumanRace()
    seedClassCatalog()
    seedCharacter(classState(3, 3, 75), { raceId: "race-e" })
    // No skills seeded: the level-up at level 4 generates zero offers.
    const res = await experienceCharacter(
      "chr-1",
      { operation: "set", track: "class", percent: 100, version: 0 },
      user
    )
    const journal = res.journal as {
      skillOfferIds?: string[]
      leveledUp: boolean
    }
    expect(journal.leveledUp).toBe(true)
    expect(journal.skillOfferIds).toEqual([])
    expect(dbMock.store.skillOffers).toHaveLength(0)
  })

  it("leaves a pre-existing unrelated pending offer unchanged on undo when the level-up recorded no offers", async () => {
    seedHumanRace()
    seedClassCatalog()
    // No skills seeded, so the level-up generates zero offers and records [].
    seedCharacter(classState(3, 3, 75), { raceId: "race-e" })
    // A pre-existing IMPORTED pending offer at the same track/level, unrelated to
    // any freshly generated offer, must never be canceled by the undo.
    seedOffer("off-pre", {
      level: 4,
      options: [{ definitionId: "sk-1" }],
    })
    const leveled = await experienceCharacter(
      "chr-1",
      { operation: "set", track: "class", percent: 100, version: 0 },
      user
    )
    expect(
      (leveled.journal as { skillOfferIds: string[] }).skillOfferIds
    ).toEqual([])
    await experienceCharacter(
      "chr-1",
      { operation: "undo", track: "class", version: leveled.character.version },
      user
    )
    // The unrelated pre-existing offer is untouched and still pending.
    const pre = dbMock.store.skillOffers.find((o) => o.id === "off-pre")!
    expect(pre.canceledAt).toBeNull()
  })

  it("cancels an own unselected offer on undo for a legacy no-list level-up event", async () => {
    seedHumanRace()
    seedClassCatalog()
    seedCharacter(classState(3, 3, 75), { raceId: "race-e" })
    seedOffer("off-own", {
      level: 4,
      options: [{ definitionId: "sk-1" }],
    })
    const leveled = await experienceCharacter(
      "chr-1",
      { operation: "set", track: "class", percent: 100, version: 0 },
      user
    )
    expect(dbMock.store.skillOffers).toHaveLength(1)
    // Simulate a legacy event that predates skillOfferIds (the field is absent).
    const advanceEvt = dbMock.store.events.find((e) => e.kind === "advance")!
    const advanceJournal = (
      advanceEvt.payload as { journal: Record<string, unknown> }
    ).journal
    delete advanceJournal.skillOfferIds
    const undone = await experienceCharacter(
      "chr-1",
      { operation: "undo", track: "class", version: leveled.character.version },
      user
    )
    void undone
    // The legacy fallback cancels the own active offer for the track/level.
    const own = dbMock.store.skillOffers.find((o) => o.id === "off-own")!
    expect(own.canceledAt).not.toBeNull()
  })

  it("cancels exactly the recorded skillOfferIds on undo without touching an unrelated offer", async () => {
    seedHumanRace()
    seedClassCatalog()
    seedSkill("sk-1", {
      track: "class",
      milestone: 4,
      effects: [{ phase: "flat", amount: { strength: 1 }, stacking: "stack" }],
    })
    seedCharacter(classState(3, 3, 75), { raceId: "race-e" })
    // An unrelated pending offer in a different choice group at the same level is
    // NOT one of the offers generated by this level-up, so it must stay.
    seedOffer("off-other", {
      level: 4,
      choiceGroup: "unrelated",
      options: [{ definitionId: "sk-other" }],
    })
    const leveled = await experienceCharacter(
      "chr-1",
      { operation: "set", track: "class", percent: 100, version: 0 },
      user
    )
    const ids = (leveled.journal as { skillOfferIds: string[] }).skillOfferIds
    expect(ids).toHaveLength(1)
    const generatedId = ids[0]
    expect(generatedId).not.toBe("off-other")
    await experienceCharacter(
      "chr-1",
      { operation: "undo", track: "class", version: leveled.character.version },
      user
    )
    // The generated offer (recorded in skillOfferIds) is canceled...
    const generated = dbMock.store.skillOffers.find(
      (o) => o.id === generatedId
    )!
    expect(generated.canceledAt).not.toBeNull()
    // ...but the unrelated offer is left pending.
    const other = dbMock.store.skillOffers.find((o) => o.id === "off-other")!
    expect(other.canceledAt).toBeNull()
  })

  it("blocks undo (level_undo_blocked) when a later updateCharacter mutated currentResources", async () => {
    seedHumanRace()
    seedClassCatalog()
    seedCharacter(classState(3, 3, 75), { raceId: "race-e" })
    const leveled = await experienceCharacter(
      "chr-1",
      { operation: "set", track: "class", percent: 100, version: 0 },
      user
    )
    // A later profile update that ALSO patches currentResources writes an update
    // event carrying the resource mutation. That is NOT cosmetic for undo: the
    // level-up may not be safely reversed while a resource edit has been applied.
    const updated = await updateCharacter(
      "chr-1",
      { currentResources: { mana: 50 }, version: leveled.character.version },
      user
    )
    expect(updated.version).toBe(leveled.character.version + 1)
    await expect(
      experienceCharacter(
        "chr-1",
        { operation: "undo", track: "class", version: updated.version },
        user
      )
    ).rejects.toMatchObject({ status: 409, code: "level_undo_blocked" })
    // The undo wrote nothing: the level-up state and the merged resources persist.
    const row = dbMock.store.characters.get("chr-1")!
    expect(row.version).toBe(updated.version)
    const st = deserializeState(row.state) as CharacterState
    expect(st.tracks.class.level).toBe(4)
    expect(st.currentResources).toEqual({ mana: 50 })
  })

  it("allows undo after a metadata-only (name) updateCharacter", async () => {
    seedHumanRace()
    seedClassCatalog()
    seedCharacter(classState(3, 3, 75), { raceId: "race-e" })
    const leveled = await experienceCharacter(
      "chr-1",
      { operation: "set", track: "class", percent: 100, version: 0 },
      user
    )
    // A name-only update records no `currentResources`, so it is provably
    // metadata-only and must NOT block the undo.
    const renamed = await updateCharacter(
      "chr-1",
      { name: "Renamed", version: leveled.character.version },
      user
    )
    const undone = await experienceCharacter(
      "chr-1",
      { operation: "undo", track: "class", version: renamed.version },
      user
    )
    const state = undone.character.state as CharacterState
    expect(state.tracks.class.level).toBe(3)
    expect(state.tracks.class.quarter).toBe(3)
    expect(state.tracks.class.experiencePercent).toBe(75)
    // The metadata rename is preserved by the undo (it never rewinds the name).
    expect(undone.character.name).toBe("Renamed")
  })

  it("blocks undo (level_undo_blocked) for an ambiguous update that cannot prove metadata-only", async () => {
    seedHumanRace()
    seedClassCatalog()
    seedCharacter(classState(3, 3, 75), { raceId: "race-e" })
    const leveled = await experienceCharacter(
      "chr-1",
      { operation: "set", track: "class", percent: 100, version: 0 },
      user
    )
    // A legacy/ambiguous update event whose payload carries `currentResources`
    // present-but-null cannot prove metadata-only, so the undo must reject rather
    // than guess that resources were untouched.
    dbMock.store.events.push({
      id: "evt-update-ambiguous",
      characterId: "chr-1",
      kind: "update",
      payload: { name: "Renamed", currentResources: null },
      createdAt: new Date(Date.now() + 1000),
    })
    await expect(
      experienceCharacter(
        "chr-1",
        {
          operation: "undo",
          track: "class",
          version: leveled.character.version,
        },
        user
      )
    ).rejects.toMatchObject({ status: 409, code: "level_undo_blocked" })
  })
})

describe("grade ceiling level-up blockers (service read)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function seedDerived(
    opts: {
      classLevel?: number
      professionLevel?: number
      raceGrade?: Grade
    } = {}
  ): unknown {
    const classLevel = opts.classLevel ?? 27
    const professionLevel = opts.professionLevel ?? 24
    const state = createCharacterState({
      baseAttributes: makeVector({}),
      tracks: {
        class: { level: classLevel, quarter: 0, definitionId: "class-def" },
        profession: {
          level: professionLevel,
          quarter: 0,
          definitionId: "prof-def",
        },
      },
      race: {
        level: Math.floor((classLevel + professionLevel) / 2),
        grade: opts.raceGrade ?? "F",
        mode: "derived",
        origin: "integrated",
      },
    })
    return dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "GradeGate",
      state: serializeState(state),
      version: 0,
    })
  }

  function seedMonster(level: number, grade: Grade): unknown {
    const state = createCharacterState({
      baseAttributes: makeVector({}),
      tracks: {},
      race: { level, grade, mode: "independent", quarter: 0 },
    })
    return dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Monster",
      state: serializeState(state),
      version: 0,
    })
  }

  it("exposes class/profession level-up blockers for a derived race at the grade ceiling", async () => {
    seedDerived()
    const detail = await getCharacter("chr-1", user)
    // The derived race level is the symmetric average of class + profession, so a
    // class and a profession level-up project the SAME race level and are both
    // blocked when that projection crosses the F->E ceiling.
    expect(detail.levelUpBlocked?.class).toContain("F->E")
    expect(detail.levelUpBlocked?.profession).toContain("F->E")
    expect(detail.levelUpBlocked?.race).toBeUndefined()
  })

  it("exposes a race level-up blocker for a monster (independent) race", async () => {
    seedMonster(25, "F")
    const detail = await getCharacter("chr-1", user)
    expect(detail.levelUpBlocked?.race).toContain("F->E")
    expect(detail.levelUpBlocked?.class).toBeUndefined()
    expect(detail.levelUpBlocked?.profession).toBeUndefined()
  })

  it("leaves levelUpBlocked empty when no track crosses the grade ceiling", async () => {
    seedDerived({ classLevel: 25, professionLevel: 24 })
    const detail = await getCharacter("chr-1", user)
    expect(detail.levelUpBlocked ?? {}).toEqual({})
  })
})

describe("grade-granted skills (per-grade automatic skill grants)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function seedSkillGrant(
    id: string,
    config: Record<string, unknown> = {}
  ): unknown {
    return dbMock.store.addCatalog({
      id,
      kind: "skills",
      stableId: id,
      name: `Skill ${id}`,
      config: { rarity: "Common", ...config },
    })
  }

  function seedRaceGrant(
    id: string,
    opts: {
      naturalGrade?: Grade
      grants?: Partial<Record<Grade, string[]>>
      defs?: Record<string, unknown>
    } = {}
  ): void {
    const naturalGrade = opts.naturalGrade ?? "F"
    const defs = opts.defs ?? {
      G: { id: `${id}:G`, perLevel: { strength: 1 }, freePerLevel: 1 },
      F: { id: `${id}:F`, perLevel: { strength: 1 }, freePerLevel: 1 },
    }
    dbMock.store.addCatalog({
      id,
      kind: "races",
      stableId: `race-${id}`,
      name: `Race ${id}`,
      config: {
        raceType: "enlightened",
        naturalGrade,
        raceDefinitions: defs,
        ...(opts.grants ? { gradeGrantedSkillStableIds: opts.grants } : {}),
      },
    })
  }

  function seedClassGrant(
    id: string,
    grade: Grade,
    grants?: Partial<Record<Grade, string[]>>
  ): void {
    dbMock.store.addCatalog({
      id,
      kind: "classes",
      stableId: `cls-${id}`,
      name: `Class ${id}`,
      grade,
      config: {
        grades: { [grade]: { fixed: { agility: 1 }, free: 0 } },
        ...(grants ? { gradeGrantedSkillStableIds: grants } : {}),
      },
    })
  }

  function seedProfGrant(
    id: string,
    grade: Grade,
    grants?: Partial<Record<Grade, string[]>>
  ): void {
    dbMock.store.addCatalog({
      id,
      kind: "professions",
      stableId: `prof-${id}`,
      name: `Profession ${id}`,
      grade,
      config: {
        grades: { [grade]: { fixed: { wisdom: 1 }, free: 0 } },
        ...(grants ? { gradeGrantedSkillStableIds: grants } : {}),
      },
    })
  }

  function skillIds(detail: {
    associations: Array<{ kind: string; definitionId: string }>
  }): string[] {
    return detail.associations
      .filter((a) => a.kind === "skill")
      .map((a) => a.definitionId)
      .sort()
  }

  function seedIntegratedCharacter(): unknown {
    const state = createInitialState("integrated", null, null)
    return dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      state: serializeState(state),
      version: 0,
    })
  }

  function seedProfWithGrants(
    id: string,
    grade: Grade,
    grants?: Partial<Record<Grade, string[]>>
  ): unknown {
    return dbMock.store.addCatalog({
      id,
      kind: "professions",
      stableId: id,
      name: `Prof ${id}`,
      grade,
      config: {
        grades: { [grade]: { fixed: { wisdom: 1 }, free: 0 } },
        ...(grants ? { gradeGrantedSkillStableIds: grants } : {}),
      },
    })
  }

  // ------------------------------------------------------------------ //
  // createCharacter
  // ------------------------------------------------------------------ //

  it("grants the race grade skill at G and class/profession grade skills at the track grade on an integrated create", async () => {
    seedSkillGrant("race-skill")
    seedSkillGrant("class-skill")
    seedSkillGrant("prof-skill")
    seedRaceGrant("race-gg", {
      naturalGrade: "F",
      grants: { G: ["race-skill"] },
    })
    seedClassGrant("cls-gg", "F", { F: ["class-skill"] })
    seedProfGrant("prof-gg", "F", { F: ["prof-skill"] })
    const detail = await createCharacter(
      {
        name: "Kael",
        origin: "integrated",
        raceId: "race-gg",
        classId: "cls-gg",
        professionId: "prof-gg",
      },
      user
    )
    expect(skillIds(detail)).toEqual([
      "class-skill",
      "prof-skill",
      "race-skill",
    ])
    const payload = dbMock.store.events[0].payload as {
      skillGrants: {
        granted: Array<{ stableId: string; grade: string; name: string }>
      }
    }
    const granted = payload.skillGrants.granted
      .map((g) => ({ stableId: g.stableId, grade: g.grade }))
      .sort((a, b) => a.stableId.localeCompare(b.stableId))
    expect(granted).toEqual([
      { stableId: "class-skill", grade: "F" },
      { stableId: "prof-skill", grade: "F" },
      { stableId: "race-skill", grade: "G" },
    ])
  })

  it("grants the race/class/profession grade skills at the natural grade on a born create", async () => {
    seedSkillGrant("race-skill")
    seedSkillGrant("class-skill")
    seedSkillGrant("prof-skill")
    seedRaceGrant("race-gg", {
      naturalGrade: "F",
      grants: { F: ["race-skill"] },
    })
    seedClassGrant("cls-gg", "F", { F: ["class-skill"] })
    seedProfGrant("prof-gg", "F", { F: ["prof-skill"] })
    const detail = await createCharacter(
      {
        name: "Bael",
        origin: "born",
        raceId: "race-gg",
        classId: "cls-gg",
        professionId: "prof-gg",
      },
      user
    )
    expect(skillIds(detail)).toEqual([
      "class-skill",
      "prof-skill",
      "race-skill",
    ])
    const payload = dbMock.store.events[0].payload as {
      skillGrants: { granted: Array<{ grade: string }> }
    }
    expect(payload.skillGrants.granted).toHaveLength(3)
    for (const g of payload.skillGrants.granted) expect(g.grade).toBe("F")
  })

  it("does not stack when the same skill is granted by race and class (noop on the duplicate)", async () => {
    seedSkillGrant("shared")
    seedRaceGrant("race-gg", { naturalGrade: "F", grants: { G: ["shared"] } })
    seedClassGrant("cls-gg", "F", { F: ["shared"] })
    const detail = await createCharacter(
      {
        name: "Kael",
        origin: "integrated",
        raceId: "race-gg",
        classId: "cls-gg",
      },
      user
    )
    expect(skillIds(detail)).toEqual(["shared"])
    const payload = dbMock.store.events[0].payload as {
      skillGrants: {
        granted: Array<{ stableId: string; grade: string }>
        noop: Array<{ stableId: string; grade: string }>
      }
    }
    expect(payload.skillGrants.granted).toHaveLength(1)
    expect(payload.skillGrants.granted[0]).toMatchObject({
      stableId: "shared",
      grade: "G",
    })
    expect(payload.skillGrants.noop).toHaveLength(1)
    expect(payload.skillGrants.noop[0]).toMatchObject({
      stableId: "shared",
      grade: "F",
    })
  })

  it("reconciles a multi-track create so a race/class duplicate that upgrades never claims the superseded Common skill is granted", async () => {
    seedSkillGrant("sk-a", { rarity: "Common", upgradeGroup: "grp" })
    seedSkillGrant("sk-b", { rarity: "Uncommon", upgradeGroup: "grp" })
    seedRaceGrant("race-gg", { naturalGrade: "F", grants: { G: ["sk-a"] } })
    seedClassGrant("cls-gg", "F", { F: ["sk-a"] })
    const detail = await createCharacter(
      {
        name: "Kael",
        origin: "integrated",
        raceId: "race-gg",
        classId: "cls-gg",
      },
      user
    )
    // Only the Uncommon tier persists; the Common link was planned then superseded.
    expect(skillIds(detail)).toEqual(["sk-b"])
    const payload = dbMock.store.events[0].payload as {
      skillGrants: {
        granted: Array<{ stableId: string; grade: string }>
        upgraded: Array<{
          fromStableId: string
          toStableId: string
          grade: string
        }>
        superseded: Array<{ stableId: string; grade: string }>
      }
    }
    // No pre-existing source was displaced, so the Uncommon tier is granted fresh
    // and the phantom race-grade Common intermediate is only reported as superseded.
    expect(payload.skillGrants.granted).toHaveLength(1)
    expect(payload.skillGrants.granted[0]).toMatchObject({
      stableId: "sk-b",
      grade: "F",
    })
    // Nothing was upgraded from a real persisted link - the Common tier was never
    // written, so there is no upgrade transition at all (no imaginary source).
    expect(payload.skillGrants.upgraded).toHaveLength(0)
    // The superseded Common skill is recorded with its originating race grade so
    // the trail explains how the planned grant was replaced by a later upgrade.
    expect(payload.skillGrants.superseded).toHaveLength(1)
    expect(payload.skillGrants.superseded[0]).toMatchObject({
      stableId: "sk-a",
      grade: "G",
    })
    // Only the Uncommon link is ever written to the association table.
    const stored = dbMock.store.associations.filter(
      (a) => a.characterId === detail.id && a.kind === "SKILL"
    )
    expect(stored.map((a) => a.definitionId)).toEqual(["sk-b"])
  })

  it("reconciles a multi-track create so a class/profession duplicate that upgrades reports only the persisted tier", async () => {
    seedSkillGrant("sk-a", { rarity: "Common", upgradeGroup: "grp" })
    seedSkillGrant("sk-b", { rarity: "Uncommon", upgradeGroup: "grp" })
    seedRaceGrant("race-gg", { naturalGrade: "F", grants: {} })
    seedClassGrant("cls-gg", "F", { F: ["sk-a"] })
    seedProfGrant("prof-gg", "F", { F: ["sk-a"] })
    const detail = await createCharacter(
      {
        name: "Kael",
        origin: "integrated",
        raceId: "race-gg",
        classId: "cls-gg",
        professionId: "prof-gg",
      },
      user
    )
    expect(skillIds(detail)).toEqual(["sk-b"])
    const payload = dbMock.store.events[0].payload as {
      skillGrants: {
        granted: Array<{ stableId: string; grade: string }>
        upgraded: Array<{
          fromStableId: string
          toStableId: string
          grade: string
        }>
        superseded: Array<{ stableId: string; grade: string }>
      }
    }
    expect(payload.skillGrants.granted).toHaveLength(1)
    expect(payload.skillGrants.granted[0]).toMatchObject({
      stableId: "sk-b",
      grade: "F",
    })
    expect(payload.skillGrants.upgraded).toHaveLength(0)
    expect(payload.skillGrants.superseded).toHaveLength(1)
    expect(payload.skillGrants.superseded[0]).toMatchObject({
      stableId: "sk-a",
      grade: "F",
    })
  })

  it("leaves a genuine same-skill no-op untouched (no superseded entry, persisted grant retained)", async () => {
    seedSkillGrant("shared", { rarity: "Common", upgradeGroup: "grp" })
    seedRaceGrant("race-gg", { naturalGrade: "F", grants: { G: ["shared"] } })
    seedClassGrant("cls-gg", "F", { F: ["shared"] })
    const detail = await createCharacter(
      {
        name: "Kael",
        origin: "integrated",
        raceId: "race-gg",
        classId: "cls-gg",
      },
      user
    )
    expect(skillIds(detail)).toEqual(["shared"])
    const payload = dbMock.store.events[0].payload as {
      skillGrants: {
        granted: Array<{ stableId: string; grade: string }>
        noop: Array<{ stableId: string; grade: string }>
        superseded?: Array<{ stableId: string; grade: string }>
      }
    }
    // The race-grade grant persists; the class duplicate is a no-op, not an upgrade.
    expect(payload.skillGrants.granted).toHaveLength(1)
    expect(payload.skillGrants.granted[0]).toMatchObject({
      stableId: "shared",
      grade: "G",
    })
    expect(payload.skillGrants.noop).toHaveLength(1)
    expect(payload.skillGrants.noop[0]).toMatchObject({
      stableId: "shared",
      grade: "F",
    })
    // Nothing was planned and then replaced: no superseded entries.
    expect(payload.skillGrants.superseded ?? []).toHaveLength(0)
  })

  it("truthfully journals a 3-stage race/class/profession chain with no pre-existing source (intermediates superseded, final granted)", async () => {
    seedSkillGrant("sk-a", { rarity: "Common", upgradeGroup: "grp" })
    seedSkillGrant("sk-b", { rarity: "Uncommon", upgradeGroup: "grp" })
    seedSkillGrant("sk-c", { rarity: "Rare", upgradeGroup: "grp" })
    seedRaceGrant("race-gg", { naturalGrade: "F", grants: { G: ["sk-a"] } })
    seedClassGrant("cls-gg", "F", { F: ["sk-b"] })
    seedProfGrant("prof-gg", "F", { F: ["sk-c"] })
    const detail = await createCharacter(
      {
        name: "Kael",
        origin: "integrated",
        raceId: "race-gg",
        classId: "cls-gg",
        professionId: "prof-gg",
      },
      user
    )
    // Only the Rare tier persists; the Common/Uncommon intermediates were planned
    // but never written.
    expect(skillIds(detail)).toEqual(["sk-c"])
    const payload = dbMock.store.events[0].payload as {
      skillGrants: {
        granted: Array<{ stableId: string; grade: string; name: string }>
        upgraded: Array<{
          fromStableId: string
          toStableId: string
          grade: string
        }>
        superseded: Array<{ stableId: string; grade: string; name: string }>
      }
    }
    // No pre-existing source was displaced -> C is granted, never upgraded from a
    // phantom intermediate B.
    expect(payload.skillGrants.upgraded).toHaveLength(0)
    expect(payload.skillGrants.granted).toHaveLength(1)
    expect(payload.skillGrants.granted[0]).toMatchObject({
      stableId: "sk-c",
      grade: "F",
    })
    // Every intermediate planned grant is reported once under superseded with its
    // original acquisition grade.
    const superseded = payload.skillGrants.superseded
      .map((s) => ({ stableId: s.stableId, grade: s.grade }))
      .sort((a, b) => a.stableId.localeCompare(b.stableId))
    expect(superseded).toEqual([
      { stableId: "sk-a", grade: "G" },
      { stableId: "sk-b", grade: "F" },
    ])
    // The persisted association matches the journal: only the Rare tier.
    const stored = dbMock.store.associations.filter(
      (a) => a.characterId === detail.id && a.kind === "SKILL"
    )
    expect(stored.map((a) => a.definitionId)).toEqual(["sk-c"])
  })

  it("journals a single X->A upgrade when a pre-existing source is upgraded directly (no intermediate)", async () => {
    seedSkillGrant("sk-x", { rarity: "Common", upgradeGroup: "grp" })
    seedSkillGrant("sk-a", { rarity: "Uncommon", upgradeGroup: "grp" })
    seedIntegratedCharacter()
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "sk-x",
      kind: "SKILL",
    })
    seedProfWithGrants("prof-g", "G", { G: ["sk-a"] })
    const res = await setCharacterProfession(
      "chr-1",
      { professionId: "prof-g", version: 0 },
      user
    )
    expect(skillIds(res.character)).toEqual(["sk-a"])
    const payload = dbMock.store.events[0].payload as {
      skillGrants: {
        granted: Array<{ stableId: string }>
        upgraded: Array<{ fromStableId: string; toStableId: string }>
        superseded: Array<{ stableId: string }>
      }
    }
    expect(payload.skillGrants.upgraded).toHaveLength(1)
    expect(payload.skillGrants.upgraded[0]).toMatchObject({
      fromStableId: "sk-x",
      toStableId: "sk-a",
    })
    expect(payload.skillGrants.granted).toHaveLength(0)
    expect(payload.skillGrants.superseded ?? []).toHaveLength(0)
    const stored = dbMock.store.associations.filter(
      (a) => a.characterId === "chr-1" && a.kind === "SKILL"
    )
    expect(stored.map((a) => a.definitionId)).toEqual(["sk-a"])
  })

  it("journals a single X->B upgrade (and A as superseded) when a pre-existing source is upgraded through an intermediate in the same acquisition", async () => {
    seedSkillGrant("sk-x", { rarity: "Common", upgradeGroup: "grp" })
    seedSkillGrant("sk-a", { rarity: "Uncommon", upgradeGroup: "grp" })
    seedSkillGrant("sk-b", { rarity: "Rare", upgradeGroup: "grp" })
    seedIntegratedCharacter()
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "sk-x",
      kind: "SKILL",
    })
    seedProfWithGrants("prof-g", "G", { G: ["sk-a", "sk-b"] })
    const res = await setCharacterProfession(
      "chr-1",
      { professionId: "prof-g", version: 0 },
      user
    )
    expect(skillIds(res.character)).toEqual(["sk-b"])
    const payload = dbMock.store.events[0].payload as {
      skillGrants: {
        granted: Array<{ stableId: string; grade: string }>
        upgraded: Array<{
          fromStableId: string
          toStableId: string
          grade: string
        }>
        superseded: Array<{ stableId: string; grade: string }>
      }
    }
    expect(dbMock.store.events[0].kind).toBe("profession_set")
    // The pre-existing source X is upgraded DIRECTLY to the final B - one real
    // pre/post transition, never X->A (A was never persisted).
    expect(payload.skillGrants.upgraded).toHaveLength(1)
    expect(payload.skillGrants.upgraded[0]).toMatchObject({
      fromStableId: "sk-x",
      toStableId: "sk-b",
      grade: "G",
    })
    // A was planned but never written; it is superseded with its original grade.
    expect(payload.skillGrants.superseded).toHaveLength(1)
    expect(payload.skillGrants.superseded[0]).toMatchObject({
      stableId: "sk-a",
      grade: "G",
    })
    // No claim the pre-existing X is still linked: granted is empty because the
    // final link was an upgrade.
    expect(payload.skillGrants.granted).toHaveLength(0)
    const stored = dbMock.store.associations.filter(
      (a) => a.characterId === "chr-1" && a.kind === "SKILL"
    )
    expect(stored.map((a) => a.definitionId)).toEqual(["sk-b"])
  })

  it("leaves a grant in a different upgrade group untouched (granted) when another group upgrades from a pre-existing source", async () => {
    seedSkillGrant("sk-x", { rarity: "Common", upgradeGroup: "grp1" })
    seedSkillGrant("sk-a", { rarity: "Uncommon", upgradeGroup: "grp1" })
    seedSkillGrant("g2-a", { rarity: "Common", upgradeGroup: "grp2" })
    seedIntegratedCharacter()
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "sk-x",
      kind: "SKILL",
    })
    seedProfWithGrants("prof-g", "G", { G: ["sk-a", "g2-a"] })
    const res = await setCharacterProfession(
      "chr-1",
      { professionId: "prof-g", version: 0 },
      user
    )
    expect(skillIds(res.character).sort()).toEqual(["g2-a", "sk-a"])
    const payload = dbMock.store.events[0].payload as {
      skillGrants: {
        granted: Array<{ stableId: string; grade: string }>
        upgraded: Array<{ fromStableId: string; toStableId: string }>
        superseded: Array<{ stableId: string }>
      }
    }
    // grp1: the pre-existing X is upgraded to sk-a.
    expect(payload.skillGrants.upgraded).toHaveLength(1)
    expect(payload.skillGrants.upgraded[0]).toMatchObject({
      fromStableId: "sk-x",
      toStableId: "sk-a",
    })
    // grp2: g2-a is a fresh grant, unaffected by the grp1 upgrade.
    expect(payload.skillGrants.granted).toHaveLength(1)
    expect(payload.skillGrants.granted[0]).toMatchObject({
      stableId: "g2-a",
      grade: "G",
    })
    expect(payload.skillGrants.superseded ?? []).toHaveLength(0)
  })

  it("skips an archived grade skill at create (journaled, never linked)", async () => {
    dbMock.store.addCatalog({
      id: "arch-skill",
      kind: "skills",
      stableId: "arch-skill",
      name: "Archived Skill",
      config: { rarity: "Common" },
      archived: true,
    })
    seedRaceGrant("race-gg", {
      naturalGrade: "F",
      grants: { G: ["arch-skill"] },
    })
    seedClassGrant("cls-gg", "F")
    const detail = await createCharacter(
      {
        name: "Kael",
        origin: "integrated",
        raceId: "race-gg",
        classId: "cls-gg",
      },
      user
    )
    expect(skillIds(detail)).toEqual([])
    const payload = dbMock.store.events[0].payload as {
      skillGrants: { skipped: Array<{ stableId: string; grade: string }> }
    }
    expect(payload.skillGrants.skipped).toEqual([
      { stableId: "arch-skill", grade: "G" },
    ])
  })

  it("rolls back the whole create when a serialization failure occurs after resolving grade grants", async () => {
    seedSkillGrant("race-skill")
    seedRaceGrant("race-gg", {
      naturalGrade: "F",
      grants: { G: ["race-skill"] },
    })
    seedClassGrant("cls-gg", "F")
    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce({
      name: "PrismaClientKnownRequestError",
      code: "P2034",
    })
    try {
      await expect(
        createCharacter(
          {
            name: "Kael",
            origin: "integrated",
            raceId: "race-gg",
            classId: "cls-gg",
          },
          user
        )
      ).rejects.toMatchObject({ status: 409, code: "serialization_conflict" })
    } finally {
      spy.mockRestore()
    }
    expect(dbMock.store.characters.size).toBe(0)
    expect(dbMock.store.events).toHaveLength(0)
    expect(dbMock.store.associations).toHaveLength(0)
  })

  // ------------------------------------------------------------------ //
  // setCharacterProfession
  // ------------------------------------------------------------------ //

  it("grants the newly assigned profession track grade skill and journals it", async () => {
    seedSkillGrant("prof-skill")
    seedIntegratedCharacter()
    seedProfWithGrants("prof-g", "G", { G: ["prof-skill"] })
    const res = await setCharacterProfession(
      "chr-1",
      { professionId: "prof-g", version: 0 },
      user
    )
    expect(skillIds(res.character)).toEqual(["prof-skill"])
    const payload = dbMock.store.events[0].payload as {
      skillGrants: { granted: Array<{ stableId: string; grade: string }> }
    }
    expect(dbMock.store.events[0].kind).toBe("profession_set")
    expect(payload.skillGrants.granted).toHaveLength(1)
    expect(payload.skillGrants.granted[0]).toMatchObject({
      stableId: "prof-skill",
      grade: "G",
    })
  })

  it("records a no-op when the granted skill is already owned (no stacking)", async () => {
    seedSkillGrant("prof-skill")
    seedIntegratedCharacter()
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "prof-skill",
      kind: "SKILL",
    })
    seedProfWithGrants("prof-g", "G", { G: ["prof-skill"] })
    const res = await setCharacterProfession(
      "chr-1",
      { professionId: "prof-g", version: 0 },
      user
    )
    expect(skillIds(res.character)).toEqual(["prof-skill"])
    const payload = dbMock.store.events[0].payload as {
      skillGrants: { noop: Array<{ stableId: string; grade: string }> }
    }
    expect(payload.skillGrants.noop).toHaveLength(1)
    expect(payload.skillGrants.noop[0]).toMatchObject({
      stableId: "prof-skill",
      grade: "G",
    })
  })

  it("upgrades to the next authored strictly-higher rarity in the group and removes the superseded link", async () => {
    seedSkillGrant("sk-common", { rarity: "Common", upgradeGroup: "grp" })
    seedSkillGrant("sk-rare", { rarity: "Rare", upgradeGroup: "grp" })
    seedSkillGrant("sk-req", { rarity: "Common", upgradeGroup: "grp" })
    seedIntegratedCharacter()
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "sk-common",
      kind: "SKILL",
    })
    seedProfWithGrants("prof-g", "G", { G: ["sk-req"] })
    const res = await setCharacterProfession(
      "chr-1",
      { professionId: "prof-g", version: 0 },
      user
    )
    expect(skillIds(res.character)).toEqual(["sk-rare"])
    const payload = dbMock.store.events[0].payload as {
      skillGrants: {
        upgraded: Array<{ fromStableId: string; toStableId: string }>
      }
    }
    expect(payload.skillGrants.upgraded).toHaveLength(1)
    expect(payload.skillGrants.upgraded[0]).toMatchObject({
      fromStableId: "sk-common",
      toStableId: "sk-rare",
    })
    // The superseded Common link is gone; only the Rare link persists.
    const stored = dbMock.store.associations.filter(
      (a) => a.characterId === "chr-1" && a.kind === "SKILL"
    )
    expect(stored.map((a) => a.definitionId)).toEqual(["sk-rare"])
  })

  it("tie-breaks equal-rarity candidates by stableId lexicographic order", async () => {
    seedSkillGrant("sk-a", { rarity: "Rare", upgradeGroup: "grp" })
    seedSkillGrant("sk-b", { rarity: "Rare", upgradeGroup: "grp" })
    seedSkillGrant("sk-common", { rarity: "Common", upgradeGroup: "grp" })
    seedSkillGrant("sk-req", { rarity: "Common", upgradeGroup: "grp" })
    seedIntegratedCharacter()
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "sk-common",
      kind: "SKILL",
    })
    seedProfWithGrants("prof-g", "G", { G: ["sk-req"] })
    const res = await setCharacterProfession(
      "chr-1",
      { professionId: "prof-g", version: 0 },
      user
    )
    expect(skillIds(res.character)).toEqual(["sk-a"])
  })

  it("retains the owned skill and journals a no-op when no strictly-higher authored rarity exists", async () => {
    seedSkillGrant("sk-common", { rarity: "Common", upgradeGroup: "grp" })
    seedSkillGrant("sk-req", { rarity: "Common", upgradeGroup: "grp" })
    seedIntegratedCharacter()
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "sk-common",
      kind: "SKILL",
    })
    seedProfWithGrants("prof-g", "G", { G: ["sk-req"] })
    const res = await setCharacterProfession(
      "chr-1",
      { professionId: "prof-g", version: 0 },
      user
    )
    expect(skillIds(res.character)).toEqual(["sk-common"])
    const payload = dbMock.store.events[0].payload as {
      skillGrants: { noop: Array<{ stableId: string }> }
    }
    expect(payload.skillGrants.noop.map((n) => n.stableId)).toContain("sk-req")
  })

  it("treats a Unique owned skill as incomparable (nothing is strictly higher, so no-op)", async () => {
    seedSkillGrant("sk-unique", { rarity: "Unique", upgradeGroup: "grp" })
    seedSkillGrant("sk-req", { rarity: "Common", upgradeGroup: "grp" })
    seedIntegratedCharacter()
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "sk-unique",
      kind: "SKILL",
    })
    seedProfWithGrants("prof-g", "G", { G: ["sk-req"] })
    const res = await setCharacterProfession(
      "chr-1",
      { professionId: "prof-g", version: 0 },
      user
    )
    expect(skillIds(res.character)).toEqual(["sk-unique"])
    const payload = dbMock.store.events[0].payload as {
      skillGrants: { noop: Array<{ stableId: string }> }
    }
    expect(payload.skillGrants.noop.map((n) => n.stableId)).toContain("sk-req")
  })

  it("retains a Unique owned skill alongside a Common one when a same-group upgrade collides (no data loss)", async () => {
    // A group holding BOTH an incomparable Unique skill and a comparable Common
    // skill must not have the Unique deleted when a same-group duplicate request
    // arrives: nothing authored is strictly higher than Unique, so the whole
    // acquisition is a no-op and both links are preserved.
    seedSkillGrant("sk-unique", { rarity: "Unique", upgradeGroup: "grp" })
    seedSkillGrant("sk-common", { rarity: "Common", upgradeGroup: "grp" })
    seedSkillGrant("sk-rare", { rarity: "Rare", upgradeGroup: "grp" })
    seedSkillGrant("sk-req", { rarity: "Common", upgradeGroup: "grp" })
    seedIntegratedCharacter()
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "sk-unique",
      kind: "SKILL",
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "sk-common",
      kind: "SKILL",
    })
    seedProfWithGrants("prof-g", "G", { G: ["sk-req"] })
    const res = await setCharacterProfession(
      "chr-1",
      { professionId: "prof-g", version: 0 },
      user
    )
    // No upgrade, no deletion: both the Unique and the Common skills persist.
    expect(skillIds(res.character)).toEqual(["sk-common", "sk-unique"])
    const stored = dbMock.store.associations
      .filter((a) => a.characterId === "chr-1" && a.kind === "SKILL")
      .map((a) => a.definitionId)
      .sort()
    expect(stored).toEqual(["sk-common", "sk-unique"])
    const payload = dbMock.store.events[0].payload as {
      skillGrants: {
        noop: Array<{ stableId: string; reason?: string }>
      }
    }
    const noopReq = payload.skillGrants.noop.find(
      (n) => n.stableId === "sk-req"
    )
    expect(noopReq).toBeTruthy()
    expect(noopReq?.reason).toMatch(/incomparable|missing rarity/i)
  })

  it("retains a missing-rarity owned skill alongside a Common one when a same-group upgrade collides (no data loss)", async () => {
    // A skill that omits `rarity` is incomparable exactly like Unique: a
    // same-group duplicate request must not delete it just because a Common
    // sibling is comparable. The whole acquisition is a no-op.
    seedSkillGrant("sk-norarity", { rarity: undefined, upgradeGroup: "grp" })
    seedSkillGrant("sk-common", { rarity: "Common", upgradeGroup: "grp" })
    seedSkillGrant("sk-req", { rarity: "Common", upgradeGroup: "grp" })
    seedIntegratedCharacter()
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "sk-norarity",
      kind: "SKILL",
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "sk-common",
      kind: "SKILL",
    })
    seedProfWithGrants("prof-g", "G", { G: ["sk-req"] })
    const res = await setCharacterProfession(
      "chr-1",
      { professionId: "prof-g", version: 0 },
      user
    )
    expect(skillIds(res.character)).toEqual(["sk-common", "sk-norarity"])
    const stored = dbMock.store.associations
      .filter((a) => a.characterId === "chr-1" && a.kind === "SKILL")
      .map((a) => a.definitionId)
      .sort()
    expect(stored).toEqual(["sk-common", "sk-norarity"])
    const payload = dbMock.store.events[0].payload as {
      skillGrants: {
        noop: Array<{ stableId: string; reason?: string }>
      }
    }
    const noopReq = payload.skillGrants.noop.find(
      (n) => n.stableId === "sk-req"
    )
    expect(noopReq).toBeTruthy()
    expect(noopReq?.reason).toMatch(/incomparable|missing rarity/i)
  })

  it("rejects a stale version with 409 and writes no event or association", async () => {
    seedSkillGrant("prof-skill")
    seedIntegratedCharacter()
    seedProfWithGrants("prof-g", "G", { G: ["prof-skill"] })
    await expect(
      setCharacterProfession(
        "chr-1",
        { professionId: "prof-g", version: 5 },
        user
      )
    ).rejects.toMatchObject({ status: 409, code: "version_conflict" })
    expect(dbMock.store.events).toHaveLength(0)
    expect(
      dbMock.store.associations.filter(
        (a) => a.characterId === "chr-1" && a.kind === "SKILL"
      )
    ).toHaveLength(0)
  })

  // ------------------------------------------------------------------ //
  // evolveCharacter
  // ------------------------------------------------------------------ //

  function seedGradedClassCharacter(opts: {
    classId: string
    classStableId: string
    grade: Grade
    level: number
  }): unknown {
    const classRow = {
      stableId: opts.classStableId,
    } as Parameters<typeof createInitialState>[3]
    const state = createInitialState("integrated", null, null, classRow)
    state.race = { level: 0, grade: "G", mode: "derived", origin: "integrated" }
    if (state.tracks.class) {
      state.tracks.class.level = opts.level
      state.tracks.class.grade = opts.grade
      state.tracks.class.definitionId = `${opts.classStableId}:${opts.grade}`
    }
    return dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      classId: opts.classId,
      state: serializeState(state),
      version: 0,
    })
  }

  function seedEvolveClass(
    id: string,
    stableId: string,
    grades: Record<string, unknown>,
    grants?: Partial<Record<Grade, string[]>>
  ): void {
    dbMock.store.addCatalog({
      id,
      kind: "classes",
      stableId,
      name: `Class ${stableId}`,
      config: {
        grades,
        ...(grants ? { gradeGrantedSkillStableIds: grants } : {}),
      },
    })
  }

  it("evolves a class to the target grade and grants the destination's grade skill, journaling the upgrade", async () => {
    seedSkillGrant("sk-d1", { rarity: "Common", upgradeGroup: "grp" })
    seedSkillGrant("sk-d2", { rarity: "Rare", upgradeGroup: "grp" })
    seedEvolveClass("cls-archer", "archer", {
      F: { fixed: { agility: 2 }, free: 1 },
      E: { fixed: { agility: 3 }, free: 1 },
    })
    seedEvolveClass("cls-ev", "archer", {
      F: { fixed: { agility: 2 }, free: 0 },
      E: { fixed: { agility: 3 }, free: 0 },
    })
    // The character holds the Common tier; the E destination grants the Rare tier.
    seedGradedClassCharacter({
      classId: "cls-archer",
      classStableId: "archer",
      grade: "F",
      level: 30,
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "sk-d1",
      kind: "SKILL",
    })
    // Upgrade the destination row to grant sk-d2 at E.
    await updateCatalogItem("classes", "cls-ev", {
      config: {
        grades: {
          F: { fixed: { agility: 2 }, free: 0 },
          E: { fixed: { agility: 3 }, free: 0 },
        },
        gradeGrantedSkillStableIds: { E: ["sk-d2"] },
      },
    })
    const res = await evolveCharacter(
      "chr-1",
      { track: "class", optionId: "cls-ev", version: 0 },
      user
    )
    expect(res.character.classId).toBe("cls-ev")
    expect(skillIds(res.character)).toEqual(["sk-d2"])
    expect(res.journal).toMatchObject({
      track: "class",
      from: "F",
      to: "E",
      source: "track",
    })
    const skillGrants = (res.journal as Record<string, unknown>)
      .skillGrants as {
      upgraded: Array<{ fromStableId: string; toStableId: string }>
    }
    expect(skillGrants.upgraded).toHaveLength(1)
    expect(skillGrants.upgraded[0]).toMatchObject({
      fromStableId: "sk-d1",
      toStableId: "sk-d2",
    })
    const stored = dbMock.store.associations.filter(
      (a) => a.characterId === "chr-1" && a.kind === "SKILL"
    )
    expect(stored.map((a) => a.definitionId)).toEqual(["sk-d2"])
  })

  it("skips an archived destination grade skill at evolve and still commits", async () => {
    dbMock.store.addCatalog({
      id: "arch-skill",
      kind: "skills",
      stableId: "arch-skill",
      name: "Archived Skill",
      config: { rarity: "Common" },
      archived: true,
    })
    seedEvolveClass("cls-archer", "archer", {
      F: { fixed: { agility: 2 }, free: 1 },
      E: { fixed: { agility: 4 }, free: 1 },
    })
    // The destination is seeded directly with an archived grade-grant reference, so
    // the catalog-ref integrity check never sees it (a live create/update would
    // reject an archived ref up front; the acquisition path simply skips it).
    dbMock.store.addCatalog({
      id: "cls-ev",
      kind: "classes",
      stableId: "archer",
      name: "Class archer",
      config: {
        grades: {
          F: { fixed: { agility: 2 }, free: 0 },
          E: { fixed: { agility: 4 }, free: 0 },
        },
        gradeGrantedSkillStableIds: { E: ["arch-skill"] },
      },
    })
    seedGradedClassCharacter({
      classId: "cls-archer",
      classStableId: "archer",
      grade: "F",
      level: 30,
    })
    const res = await evolveCharacter(
      "chr-1",
      { track: "class", optionId: "cls-ev", version: 0 },
      user
    )
    expect(skillIds(res.character)).toEqual([])
    const skillGrants = (res.journal as Record<string, unknown>)
      .skillGrants as { skipped: Array<{ stableId: string; grade: string }> }
    expect(skillGrants.skipped).toEqual([
      { stableId: "arch-skill", grade: "E" },
    ])
  })

  // ------------------------------------------------------------------ //
  // Catalog create / update reference validation
  // ------------------------------------------------------------------ //

  it("rejects a new race config that references a missing grade skill", async () => {
    await expect(
      createCatalogItem("races", {
        stableId: "race-ref",
        name: "Race Ref",
        config: {
          raceType: "enlightened",
          naturalGrade: "F",
          gradeGrantedSkillStableIds: { F: ["no-such-skill"] },
        },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
      message: expect.stringContaining("no-such-skill"),
    })
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("rejects a new race config that references an archived grade skill", async () => {
    seedSkillGrant("arch-skill")
    ;(
      dbMock.store.catalog.get("arch-skill") as { archived: boolean }
    ).archived = true
    await expect(
      createCatalogItem("races", {
        stableId: "race-ref",
        name: "Race Ref",
        config: {
          raceType: "enlightened",
          naturalGrade: "F",
          gradeGrantedSkillStableIds: { F: ["arch-skill"] },
        },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
      message: expect.stringContaining("arch-skill"),
    })
  })

  it("accepts a new race config that references an existing unarchived grade skill", async () => {
    seedSkillGrant("ok-skill")
    const item = await createCatalogItem("races", {
      stableId: "race-ref",
      name: "Race Ref",
      config: {
        raceType: "enlightened",
        naturalGrade: "F",
        gradeGrantedSkillStableIds: { F: ["ok-skill"] },
      },
    })
    expect(item.config).toMatchObject({
      gradeGrantedSkillStableIds: { F: ["ok-skill"] },
    })
  })

  it("rejects a config-changing class update that references a missing grade skill", async () => {
    dbMock.store.addCatalog({
      id: "cls-1",
      kind: "classes",
      stableId: "archer",
      name: "Archer",
      config: { grades: { F: { fixed: { agility: 2 }, free: 1 } } },
    })
    await expect(
      updateCatalogItem("classes", "cls-1", {
        config: {
          grades: { F: { fixed: { agility: 2 }, free: 1 } },
          gradeGrantedSkillStableIds: { F: ["missing-skill"] },
        },
      })
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_config",
      message: expect.stringContaining("missing-skill"),
    })
  })

  it("accepts a config-changing profession update that references a valid grade skill", async () => {
    seedSkillGrant("ok-skill")
    dbMock.store.addCatalog({
      id: "prof-1",
      kind: "professions",
      stableId: "alchemist",
      name: "Alchemist",
      grade: "F",
      config: { grades: { F: { fixed: { wisdom: 1 }, free: 0 } } },
    })
    const item = await updateCatalogItem("professions", "prof-1", {
      config: {
        grades: { F: { fixed: { wisdom: 1 }, free: 0 } },
        gradeGrantedSkillStableIds: { F: ["ok-skill"] },
      },
    })
    expect(item.config).toMatchObject({
      gradeGrantedSkillStableIds: { F: ["ok-skill"] },
    })
  })

  // ------------------------------------------------------------------ //
  // Skill stableId rename block (grade-grant references, incl. archived rows)
  // ------------------------------------------------------------------ //

  it("blocks a skill stableId rename while a race grade config references the old id", async () => {
    seedSkillGrant("sk-g", { rarity: "Common" })
    dbMock.store.addCatalog({
      id: "race-ref",
      kind: "races",
      stableId: "race-ref",
      name: "Race Ref",
      config: {
        raceType: "enlightened",
        naturalGrade: "F",
        gradeGrantedSkillStableIds: { F: ["sk-g"] },
      },
    })
    await expect(
      updateCatalogItem("skills", "sk-g", { stableId: "sk-g2" })
    ).rejects.toMatchObject({
      status: 409,
      code: "skill_stable_id_in_use",
      message: expect.stringContaining("races:race-ref"),
    })
  })

  it("blocks a skill stableId rename even when the referencing race/class row is archived", async () => {
    seedSkillGrant("sk-arch", { rarity: "Common" })
    dbMock.store.addCatalog({
      id: "race-arch",
      kind: "races",
      stableId: "race-arch",
      name: "Race Arch",
      archived: true,
      config: {
        raceType: "enlightened",
        naturalGrade: "F",
        gradeGrantedSkillStableIds: { F: ["sk-arch"] },
      },
    })
    await expect(
      updateCatalogItem("skills", "sk-arch", { stableId: "sk-arch2" })
    ).rejects.toMatchObject({
      status: 409,
      code: "skill_stable_id_in_use",
      message: expect.stringContaining("races:race-arch"),
    })
  })

  it("allows a skill stableId rename when no race/class/profession grade config references it", async () => {
    seedSkillGrant("sk-free", { rarity: "Common" })
    const item = await updateCatalogItem("skills", "sk-free", {
      stableId: "sk-free-2",
    })
    expect(item.stableId).toBe("sk-free-2")
  })
})
