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
  consumeCharacter,
  createCatalogItem,
  createCharacter,
  createInitialState,
  deserializeState,
  evolveCharacter,
  exportCharacter,
  getCatalogItem,
  getCharacter,
  getCharacterInventory,
  getEvolutionOptions,
  importCharacter,
  listCatalog,
  raceGradeBandBlockers,
  resolveTrackDefinition,
  serializeState,
  skillCharacter,
  updateCatalogItem,
  updateCharacter,
} from "@/lib/db/service"
import {
  IMPORT_SCHEMA_V3,
  IMPORT_SCHEMA_V4,
  IMPORT_RULESET_VERSION,
  type CharacterImportDocument,
} from "@/lib/server/import-schema"
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
    const state = createInitialState("integrated", null, null)
    state.tracks.class = { level: 20, quarter: 0, definitionId: "archer:F" }
    seedCharacter({ state: serializeState(state), version: 1 })

    // A concurrent, unrelated mutation already bumped the version to 2 (grade
    // untouched). The evolution to F is otherwise valid (grade G, race level 10),
    // so it must 409 on the stale version rather than write an event or grade.
    await updateCharacter("chr-1", { name: "Renamed", version: 1 }, user)
    await expect(
      evolveCharacter("chr-1", { grade: "F", version: 1 }, user)
    ).rejects.toMatchObject({ status: 409, code: "version_conflict" })

    const fresh = dbMock.store.characters.get("chr-1")!
    expect(fresh.version).toBe(2)
    // No evolve event, no grade change - only the update event remains.
    expect(dbMock.store.events).toHaveLength(1)
    expect(dbMock.store.events[0].kind).toBe("update")
  })

  it("evolveCharacter handles two concurrent same-version requests with one winner", async () => {
    const state = createInitialState("integrated", null, null)
    state.tracks.class = { level: 20, quarter: 0, definitionId: "archer:F" }
    seedCharacter({ state: serializeState(state), version: 2 })
    const results = await Promise.allSettled([
      evolveCharacter("chr-1", { grade: "F", version: 2 }, user),
      evolveCharacter("chr-1", { grade: "F", version: 2 }, user),
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
    return dbMock.store.addCatalog({
      id,
      kind: "blessings",
      stableId: id,
      name: `Blessing ${id}`,
      config,
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
          blessingId: "bless-1",
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
      provenance: "house",
    })
    expect(payload.specialAbilities.bloodlines[0]).toMatchObject({
      id: "blood-1",
      provenance: "house",
    })
    expect(payload.specialAbilities.transcendentSkills[0]).toMatchObject({
      id: "trans-1",
      provenance: "house",
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
          specialAbilities: { blessingId: "missing-bless" },
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
          specialAbilities: { blessingId: "blood-1" },
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
          specialAbilities: { blessingId: "bless-1" },
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
          specialAbilities: { blessingId: "bless-1" },
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
    return dbMock.store.addCatalog({
      id,
      kind: "blessings",
      stableId: id,
      name: extra.name ?? `Blessing ${id}`,
      config,
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
      kind: "blessings",
      stableId: "bless-1",
      tier: "Minor",
    })
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
      },
      user
    )
    dbMock.store.addCatalog({
      id: "bless-1",
      kind: "blessings",
      stableId: "bless-1",
      name: "Blessing bless-1",
      config: { tier: "Minor", effects: [] },
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
      },
      user
    )
    const before = await getCharacter("chr-1", user)
    expect(flatDelta(before.status, "strength")).toBe(5)
    const beforeVersion = before.version
    const beforeState = before.state
    // Edit the blessing's effect magnitude in the catalog.
    await updateCatalogItem("blessings", "bless-live", {
      config: {
        tier: "Lesser",
        effects: [{ phase: "flat", amount: { strength: 10 } }],
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
      provenance: "house",
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
    return dbMock.store.addCatalog({
      id,
      kind: "blessings",
      stableId: id,
      name: extra.name ?? `Blessing ${id}`,
      config,
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
        config: { slot: "head", bonus: { strength: 20 } },
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
      config: { slot: "feet", bonus: { strength: 20 } },
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
      config: { slot: "head", bonus: { strength: 20 } },
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

  it("allows a skill config edit that does not collide", async () => {
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
    // Editing sk-1 to a distinct upgrade group does not collide.
    const item = await updateCatalogItem("skills", "sk-1", {
      config: {
        upgradeGroup: "other-tier",
        effects: [{ phase: "flat", amount: { strength: 5 } }],
      },
    })
    expect((item.config as { upgradeGroup: string }).upgradeGroup).toBe(
      "other-tier"
    )
  })

  it("rejects a blessing unarchive that would leave a character with two active blessings (409)", async () => {
    seedState()
    seedBlessing("bless-1", {
      tier: "Minor",
      effects: [{ phase: "flat", amount: { strength: 5 } }],
    })
    // bless-2 is currently archived, so the character legitimately has only one
    // active blessing link. Unarchiving it would produce a second active one.
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
    await expect(
      updateCatalogItem("blessings", "bless-2", { archived: false })
    ).rejects.toMatchObject({ status: 409, code: "link_collision" })
    // The unarchive never applied - bless-2 stays archived.
    expect(dbMock.store.catalog.get("bless-2")!.archived).toBe(true)
  })

  it("rejects a blessing config edit that would leave a character with two active blessings (409)", async () => {
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
    // Editing the archived link's config while unarchiving it collides too.
    await expect(
      updateCatalogItem("blessings", "bless-2", {
        archived: false,
        config: {
          tier: "Greater",
          effects: [{ phase: "flat", amount: { strength: 9 } }],
        },
      })
    ).rejects.toMatchObject({ status: 409, code: "link_collision" })
    expect(dbMock.store.catalog.get("bless-2")!.archived).toBe(true)
  })

  it("allows unarchiving a blessing when the character has no other active blessing", async () => {
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
    const item = await updateCatalogItem("blessings", "bless-1", {
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
    expect(portable.schema).toBe("primal-character/4")
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
        provenance: string
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
      provenance: "house",
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
        provenance: string
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
      provenance: "house",
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

describe("race evolution path choices", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  const validPathConfig = {
    track: "race",
    fromRaceStableId: "human",
    toRaceStableId: "elf",
    fromGrade: "G",
    toGrade: "F",
  }

  function seedHumanRace() {
    dbMock.store.addCatalog({
      id: "race-human",
      kind: "races",
      stableId: "human",
      name: "Human",
      config: {
        raceDefinitions: {
          G: { id: "human:G", perLevel: { strength: 1 }, freePerLevel: 1 },
        },
      },
    })
  }

  function seedElfRace() {
    dbMock.store.addCatalog({
      id: "race-elf",
      kind: "races",
      stableId: "elf",
      name: "Elf",
      config: {
        raceDefinitions: {
          F: { id: "elf:F", perLevel: { agility: 2 }, freePerLevel: 2 },
        },
      },
    })
  }

  function seedEvolution(
    id: string,
    name: string,
    config: Record<string, unknown>,
    extra: Partial<{ archived: boolean }> = {}
  ) {
    dbMock.store.addCatalog({
      id,
      kind: "evolutions",
      stableId: id,
      name,
      config,
      ...extra,
    })
  }

  function seedTitle(id: string, stableId: string) {
    dbMock.store.addCatalog({
      id,
      kind: "titles",
      stableId,
      name: `Title ${id}`,
      config: { flat: { strength: 1 } },
    })
  }

  function seedSkill(id: string, stableId: string) {
    dbMock.store.addCatalog({
      id,
      kind: "skills",
      stableId,
      name: `Skill ${id}`,
      config: { effects: [{ phase: "flat", amount: { strength: 1 } }] },
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

  it("builds options from a valid unarchived race path matching current race/grade and the next grade", async () => {
    seedHumanRace()
    seedElfRace()
    seedEvolution("evo-1", "Human to Elf", validPathConfig)
    seedCharacter()

    const res = await getEvolutionOptions("chr-1", user)
    expect(res.options).toHaveLength(1)
    expect(res.options[0]).toMatchObject({
      id: "evo-1",
      name: "Human to Elf",
      fromGrade: "G",
      toGrade: "F",
      toTrackName: "Elf",
      track: "race",
      provenance: "house",
      sourceUrl: null,
      eligible: true,
      blockers: [],
      manualReview: false,
    })
    expect(res.legacyAvailable).toBe(false)
  })

  it("marks an option blocked by minRaceLevel and required title/skill, then clears once met", async () => {
    seedHumanRace()
    seedElfRace()
    seedTitle("title-1", "hero")
    seedSkill("skill-1", "arcane")
    seedEvolution("evo-1", "Ascension", {
      ...validPathConfig,
      minRaceLevel: 12,
      requiredTitleStableIds: ["hero"],
      requiredSkillStableIds: ["arcane"],
    })
    seedCharacter()

    let res = await getEvolutionOptions("chr-1", user)
    expect(res.options).toHaveLength(1)
    expect(res.options[0].eligible).toBe(false)
    expect(res.options[0].blockers).toEqual(
      expect.arrayContaining([
        expect.stringContaining("race level 12"),
        expect.stringContaining('title "hero"'),
        expect.stringContaining('skill "arcane"'),
      ])
    )

    // Meet every requirement: link the title/skill and raise the race level.
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "title-1",
      kind: "TITLE",
    })
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "skill-1",
      kind: "SKILL",
    })
    const stored = dbMock.store.characters.get("chr-1")!
    const state = deserializeState(stored.state)
    stored.state = serializeState({
      ...state,
      race: { ...state.race, level: 12 },
    })

    res = await getEvolutionOptions("chr-1", user)
    expect(res.options[0].eligible).toBe(true)
    expect(res.options[0].blockers).toEqual([])
  })

  it("ignores malformed, archived, wrong-race/grade and missing-destination paths for fallback", async () => {
    seedHumanRace()
    seedElfRace()
    seedEvolution("evo-malformed", "Malformed", {
      track: "race",
      fromRaceStableId: "human",
      toRaceStableId: "elf",
      fromGrade: "G",
    })
    seedEvolution("evo-archived", "Archived", validPathConfig, {
      archived: true,
    })
    seedEvolution("evo-wrong-grade", "WrongGrade", {
      ...validPathConfig,
      fromGrade: "E",
    })
    seedEvolution("evo-wrong-race", "WrongRace", {
      ...validPathConfig,
      fromRaceStableId: "orc",
    })
    seedEvolution("evo-bad-dest", "BadDest", {
      ...validPathConfig,
      toRaceStableId: "dragon",
    })
    seedEvolution("evo-non-next", "NonNext", {
      ...validPathConfig,
      toGrade: "E",
    })
    seedCharacter()

    const res = await getEvolutionOptions("chr-1", user)
    expect(res.options).toHaveLength(0)
    expect(res.legacyAvailable).toBe(true)
  })

  it("rejects a legacy grade-only POST with evolution_choice_required even when the path is blocked", async () => {
    seedHumanRace()
    seedElfRace()
    seedEvolution("evo-1", "Ascension", {
      ...validPathConfig,
      minRaceLevel: 50, // character race level (10) is below this, so blocked
    })
    seedCharacter()

    await expect(
      evolveCharacter("chr-1", { grade: "F", version: 0 }, user)
    ).rejects.toMatchObject({ status: 409, code: "evolution_choice_required" })

    // No evolve event was written; the character is untouched.
    expect(dbMock.store.events).toHaveLength(0)
    expect(dbMock.store.characters.get("chr-1")!.version).toBe(0)
  })

  it("evolves along a chosen catalog path to the destination race and grade", async () => {
    seedHumanRace()
    seedElfRace()
    seedEvolution("evo-1", "Human to Elf", validPathConfig)

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
      { optionId: "evo-1", version: 0 },
      user
    )
    expect(res.character.version).toBe(1)
    expect(res.character.raceId).toBe("race-elf")
    expect(res.character.raceName).toBe("Elf")
    const state = deserializeState(res.character.state)
    expect(state.race.grade).toBe("F")
    expect(state.race.definitionId).toBe("elf:F")
    // Class track, historical awards and allocations are preserved unchanged.
    expect(state.tracks.class.level).toBe(20)
    expect(state.historicalLevelAwards).toHaveLength(1)
    expect(state.historicalLevelAwards[0]).toMatchObject({ track: "class" })
    expect(state.allocations).toHaveLength(1)
    expect(res.journal).toMatchObject({
      from: "G",
      to: "F",
      optionId: "evo-1",
      source: "catalog",
    })
  })

  it("uses the destination race definitions for future race awards", async () => {
    seedHumanRace()
    seedElfRace()
    seedEvolution("evo-1", "Human to Elf", validPathConfig)
    dbMock.store.addCatalog({
      id: "cls-1",
      kind: "classes",
      stableId: "archer",
      name: "Archer",
      config: { grades: { F: { fixed: { agility: 2 }, free: 1 } } },
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
      { optionId: "evo-1", version: 0 },
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

  it("does not let a reason bypass a required title/skill", async () => {
    seedHumanRace()
    seedElfRace()
    seedTitle("title-1", "hero")
    seedEvolution("evo-1", "Ascension", {
      ...validPathConfig,
      requiredTitleStableIds: ["hero"],
    })
    seedCharacter()

    await expect(
      evolveCharacter(
        "chr-1",
        { optionId: "evo-1", version: 0, reason: "story" },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "evolution_prerequisites" })
  })

  it("bypasses manualRequirementsText only for a nonempty admin reason", async () => {
    seedHumanRace()
    seedElfRace()
    seedEvolution("evo-1", "Ascension", {
      ...validPathConfig,
      manualRequirementsText: "Requires the blessing of the moon",
    })
    seedCharacter()
    const admin = { ...user, isAdmin: true }

    // Owner reason does not bypass the narrative gate.
    await expect(
      evolveCharacter(
        "chr-1",
        { optionId: "evo-1", version: 0, reason: "narrative" },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "evolution_manual_required" })

    // Admin with no reason does not bypass either.
    await expect(
      evolveCharacter("chr-1", { optionId: "evo-1", version: 0 }, admin)
    ).rejects.toMatchObject({ status: 400, code: "evolution_manual_required" })

    // Admin with a nonempty reason bypasses.
    const res = await evolveCharacter(
      "chr-1",
      { optionId: "evo-1", version: 0, reason: "approved by council" },
      admin
    )
    expect(res.character.raceId).toBe("race-elf")
    expect(res.journal).toMatchObject({ reason: "approved by council" })
  })

  it("rolls back a path evolution on a stale version with no event", async () => {
    seedHumanRace()
    seedElfRace()
    seedEvolution("evo-1", "Ascension", validPathConfig)
    seedCharacter({ version: 2 })

    // An unrelated mutation bumps the version to 3.
    await updateCharacter("chr-1", { name: "Renamed", version: 2 }, user)

    await expect(
      evolveCharacter("chr-1", { optionId: "evo-1", version: 2 }, user)
    ).rejects.toMatchObject({ status: 409, code: "version_conflict" })

    const fresh = dbMock.store.characters.get("chr-1")!
    expect(fresh.raceId).toBe("race-human")
    expect(fresh.version).toBe(3)
    // Only the update event was written; the path evolve never committed.
    expect(dbMock.store.events).toHaveLength(1)
    expect(dbMock.store.events[0].kind).toBe("update")
  })

  it("rejects a legacy grade-only evolution to a skip grade even when the race level falls in a higher grade band", async () => {
    seedHumanRace()
    // G grade at level 25, which falls in E's published band (entry 25). The only
    // legitimate target is the NEXT grade (F), so grade-only E must be rejected up
    // front - the character must never jump a grade.
    const state = createInitialState("integrated", null, null)
    state.race = {
      level: 25,
      grade: "G",
      mode: "derived",
      origin: "integrated",
    }
    seedCharacter({ state: serializeState(state) })

    await expect(
      evolveCharacter("chr-1", { grade: "E", version: 0 }, user)
    ).rejects.toMatchObject({ status: 400, code: "invalid_evolution_grade" })

    // No evolve event was written; the character is untouched.
    expect(dbMock.store.events).toHaveLength(0)
    expect(dbMock.store.characters.get("chr-1")!.version).toBe(0)
  })

  it("rejects a catalog path that skips the next grade even when the race level falls in a higher grade band", async () => {
    seedHumanRace()
    seedElfRace()
    seedEvolution("evo-skip", "Human to Elf (skip E)", {
      ...validPathConfig,
      toGrade: "E",
    })
    const state = createInitialState("integrated", null, null)
    state.race = {
      level: 25,
      grade: "G",
      mode: "derived",
      origin: "integrated",
    }
    seedCharacter({ state: serializeState(state) })

    await expect(
      evolveCharacter("chr-1", { optionId: "evo-skip", version: 0 }, user)
    ).rejects.toMatchObject({ status: 400, code: "invalid_evolution_grade" })

    // No evolve event was written; the character is untouched.
    expect(dbMock.store.events).toHaveLength(0)
    expect(dbMock.store.characters.get("chr-1")!.version).toBe(0)
  })

  it("still evolves along a path to the NEXT grade when the race level falls in a higher grade band", async () => {
    seedHumanRace()
    seedElfRace()
    seedEvolution("evo-1", "Human to Elf", validPathConfig)
    // Level 20 keeps the target (F) within its grade band (entry 10, max 24), so
    // the next-grade path must not be rejected by the new skip-grade guard.
    const state = createInitialState("integrated", null, null)
    state.race = {
      level: 20,
      grade: "G",
      mode: "derived",
      origin: "integrated",
    }
    state.tracks.class = { level: 20, quarter: 0, definitionId: "" }
    seedCharacter({ state: serializeState(state) })

    const res = await evolveCharacter(
      "chr-1",
      { optionId: "evo-1", version: 0 },
      user
    )
    expect(res.character.raceId).toBe("race-elf")
    expect(deserializeState(res.character.state).race.grade).toBe("F")
  })

  it("blocks a G race at level 0 from a G->F path by the F grade band, yet still surfaces the option", async () => {
    seedHumanRace()
    seedElfRace()
    seedEvolution("evo-1", "Human to Elf", validPathConfig)
    // Derived race level 0: no class level, no profession track.
    const state = createInitialState("integrated", null, null)
    state.race = { level: 0, grade: "G", mode: "derived", origin: "integrated" }
    state.tracks.class = { level: 0, quarter: 0, definitionId: "" }
    seedCharacter({ state: serializeState(state) })

    const res = await getEvolutionOptions("chr-1", user)
    expect(res.options).toHaveLength(1)
    expect(res.options[0].toGrade).toBe("F")
    // Level 0 is below F's entry level (10), so GET must not report it eligible.
    expect(res.options[0].eligible).toBe(false)
    expect(res.options[0].blockers).toContain(
      "race level 0 does not qualify for F (needs 10-24)"
    )
    // A valid catalog path still exists, so the grade-only fallback is NOT offered.
    expect(res.legacyAvailable).toBe(false)
  })

  it("marks a G race at level 10 eligible for a G->F path", async () => {
    seedHumanRace()
    seedElfRace()
    seedEvolution("evo-1", "Human to Elf", validPathConfig)
    // Derived race level 10 (class 20 / no profession), F's entry level.
    const state = createInitialState("integrated", null, null)
    state.race = {
      level: 10,
      grade: "G",
      mode: "derived",
      origin: "integrated",
    }
    state.tracks.class = { level: 20, quarter: 0, definitionId: "" }
    seedCharacter({ state: serializeState(state) })

    const res = await getEvolutionOptions("chr-1", user)
    expect(res.options).toHaveLength(1)
    expect(res.options[0].toGrade).toBe("F")
    expect(res.options[0].eligible).toBe(true)
    expect(res.options[0].blockers).toEqual([])
    expect(res.legacyAvailable).toBe(false)
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

describe("class/profession track evolution paths", () => {
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

  function seedTrackEvolution(
    id: string,
    name: string,
    config: Record<string, unknown>,
    extra: Partial<{ archived: boolean }> = {}
  ) {
    dbMock.store.addCatalog({
      id,
      kind: "evolutions",
      stableId: id,
      name,
      config,
      ...extra,
    })
  }

  function seedTitle(id: string, stableId: string) {
    dbMock.store.addCatalog({
      id,
      kind: "titles",
      stableId,
      name: `Title ${id}`,
      config: { flat: { strength: 1 } },
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
    // The race grade stays provenance-driven; the class grade is independent.
    expect(state.race.grade).toBe("G")
  })

  it("returns contextual next-grade class options and never a legacy fallback", async () => {
    seedClass("cls-archer", "archer", "Archer", {
      F: { fixed: { agility: 2 }, free: 1 },
      E: { fixed: { agility: 3 }, free: 1 },
    })
    seedTrackEvolution("evo-class-1", "Archer F -> E", {
      track: "class",
      fromDefinitionStableId: "archer",
      toDefinitionStableId: "archer",
      fromGrade: "F",
      toGrade: "E",
    })
    seedGradedCharacter({
      classId: "cls-archer",
      classStableId: "archer",
      classGrade: "F",
    })

    const res = await getEvolutionOptions("chr-1", user, "class")
    expect(res.legacyAvailable).toBe(false)
    expect(res.options).toHaveLength(1)
    // The character has no explicit class level (defaults to 0), which is below
    // the target E grade band's entry level (25). GET must agree with the pure
    // evolveTrackGrade engine and report the choice as blocked, never eligible.
    expect(res.options[0]).toMatchObject({
      id: "evo-class-1",
      name: "Archer F -> E",
      fromGrade: "F",
      toGrade: "E",
      toTrackName: "Archer",
      track: "class",
      eligible: false,
      manualReview: false,
    })
    expect(res.options[0].blockers).toEqual([
      expect.stringContaining("class level 0 does not qualify for E"),
    ])
  })

  it("gates class evolution by the class grade, independent of the race grade", async () => {
    seedClass("cls-archer", "archer", "Archer", {
      F: { fixed: { agility: 2 }, free: 1 },
      E: { fixed: { agility: 3 }, free: 1 },
    })
    dbMock.store.addCatalog({
      id: "race-human",
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
    seedTrackEvolution("evo-class-1", "Archer F -> E", {
      track: "class",
      fromDefinitionStableId: "archer",
      toDefinitionStableId: "archer",
      fromGrade: "F",
      toGrade: "E",
    })
    // Race grade G, class grade F: the two progression gates are independent.
    seedGradedCharacter({
      classId: "cls-archer",
      classStableId: "archer",
      classGrade: "F",
      raceGrade: "G",
    })

    // track=class targets the class's next grade (E), not the race's next grade (F).
    const clsRes = await getEvolutionOptions("chr-1", user, "class")
    expect(clsRes.options).toHaveLength(1)
    expect(clsRes.options[0].toGrade).toBe("E")
    expect(clsRes.legacyAvailable).toBe(false)

    // track=race targets the race's next grade (F), unaffected by the class grade.
    const raceRes = await getEvolutionOptions("chr-1", user, "race")
    expect(raceRes.options).toHaveLength(0)
    expect(raceRes.legacyAvailable).toBe(true)
  })

  it("marks a track option blocked below the target band and agrees with the POST rejection", async () => {
    seedClass("cls-archer", "archer", "Archer", {
      F: { fixed: { agility: 2 }, free: 1 },
      E: { fixed: { agility: 3 }, free: 1 },
    })
    seedTrackEvolution("evo-class-1", "Archer F -> E", {
      track: "class",
      fromDefinitionStableId: "archer",
      toDefinitionStableId: "archer",
      fromGrade: "F",
      toGrade: "E",
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
        { track: "class", optionId: "evo-class-1", version: 0 },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "evolution" })
  })

  it("filters track options by grade/requirement, marks manual review, and evolves on a qualifying choice", async () => {
    seedClass("cls-archer", "archer", "Archer", {
      F: { fixed: { agility: 2 }, free: 1 },
      E: { fixed: { agility: 3 }, free: 1 },
    })
    seedClass("cls-ranger", "ranger", "Ranger", {
      F: { fixed: { agility: 2 }, free: 1 },
      E: { fixed: { agility: 4 }, free: 1 },
    })
    seedTitle("title-1", "hero")
    seedTrackEvolution("evo-class-1", "Archer -> Ranger (manual)", {
      track: "class",
      fromDefinitionStableId: "archer",
      toDefinitionStableId: "ranger",
      fromGrade: "F",
      toGrade: "E",
      requiredTitleStableIds: ["hero"],
      manualRequirementsText: "Requires a hero's blessing",
    })
    seedTrackEvolution("evo-class-2", "Archer -> Ranger (clean)", {
      track: "class",
      fromDefinitionStableId: "archer",
      toDefinitionStableId: "ranger",
      fromGrade: "F",
      toGrade: "E",
    })
    seedGradedCharacter({
      classId: "cls-archer",
      classStableId: "archer",
      classGrade: "F",
      classLevel: 30,
    })

    const res = await getEvolutionOptions("chr-1", user, "class")
    expect(res.options).toHaveLength(2)
    const manual = res.options.find((o) => o.id === "evo-class-1")!
    const clean = res.options.find((o) => o.id === "evo-class-2")!
    expect(manual.manualReview).toBe(true)
    // Missing the required title blocks the manual path.
    expect(manual.eligible).toBe(false)
    expect(clean.eligible).toBe(true)

    // An owner reason cannot bypass mechanical requirements.
    await expect(
      evolveCharacter(
        "chr-1",
        {
          track: "class",
          optionId: "evo-class-1",
          version: 0,
          reason: "story",
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "evolution_prerequisites" })

    // Add the required title: the path becomes mechanically eligible but the
    // narrative manual gate still blocks a non-admin.
    dbMock.store.addAssociation({
      characterId: "chr-1",
      definitionId: "title-1",
      kind: "TITLE",
    })
    await expect(
      evolveCharacter(
        "chr-1",
        {
          track: "class",
          optionId: "evo-class-1",
          version: 0,
          reason: "story",
        },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "evolution_manual_required" })

    // An admin with a nonempty reason bypasses the narrative gate.
    const admin = { ...user, isAdmin: true }
    const res2 = await evolveCharacter(
      "chr-1",
      {
        track: "class",
        optionId: "evo-class-1",
        version: 0,
        reason: "approved",
      },
      admin
    )
    expect(res2.character.classId).toBe("cls-ranger")
    const state2 = deserializeState(res2.character.state)
    expect(state2.tracks.class.grade).toBe("E")
    expect(state2.tracks.class.definitionId).toBe("ranger:E")
    // Race grade and historical awards are untouched.
    expect(state2.race.grade).toBe("G")
    expect(state2.historicalLevelAwards).toHaveLength(0)
    expect(res2.journal).toMatchObject({
      track: "class",
      from: "F",
      to: "E",
      source: "track",
      optionId: "evo-class-1",
      reason: "approved",
    })
  })

  it("rolls back a class path evolution on a stale version with no event", async () => {
    seedClass("cls-archer", "archer", "Archer", {
      F: { fixed: { agility: 2 }, free: 1 },
      E: { fixed: { agility: 3 }, free: 1 },
    })
    seedTrackEvolution("evo-class-1", "Archer F -> E", {
      track: "class",
      fromDefinitionStableId: "archer",
      toDefinitionStableId: "archer",
      fromGrade: "F",
      toGrade: "E",
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
        { track: "class", optionId: "evo-class-1", version: 2 },
        user
      )
    ).rejects.toMatchObject({ status: 409, code: "version_conflict" })

    const fresh = dbMock.store.characters.get("chr-1")!
    expect(fresh.classId).toBe("cls-archer")
    expect(fresh.version).toBe(3)
    // Only the update event was written; the path evolve never committed.
    expect(dbMock.store.events).toHaveLength(1)
    expect(dbMock.store.events[0].kind).toBe("update")
  })

  it("filters milestone skill offers by the graded track's own grade, not the race grade", async () => {
    seedClass("cls-archer", "archer", "Archer", {
      F: { fixed: { agility: 2 }, free: 1 },
      E: { fixed: { agility: 3 }, free: 1 },
    })
    // A race row is required because a derived race level gain needs a race
    // definition for the current grade when advancing.
    dbMock.store.addCatalog({
      id: "race-human",
      kind: "races",
      stableId: "human",
      name: "Human",
      config: {
        raceDefinitions: {
          G: { id: "human:G", perLevel: { strength: 1 }, freePerLevel: 1 },
          F: { id: "human:F", perLevel: { strength: 1 }, freePerLevel: 1 },
          E: { id: "human:E", perLevel: { strength: 1 }, freePerLevel: 1 },
        },
      },
    })
    // Graded class at F, race grade G.
    seedGradedCharacter({
      classId: "cls-archer",
      classStableId: "archer",
      classGrade: "F",
      raceGrade: "G",
      raceLevel: 10,
      raceId: "race-human",
      classLevel: 3,
    })
    const stored = dbMock.store.characters.get("chr-1")!
    const storedState = deserializeState(stored.state)
    storedState.tracks.class.quarter = 3
    stored.state = serializeState(storedState)

    dbMock.store.addCatalog({
      id: "sk-f",
      kind: "skills",
      stableId: "sk-f",
      name: "F skill",
      grade: "F",
      config: {
        track: "class",
        milestone: 4,
        effects: [{ phase: "flat", amount: { strength: 1 } }],
      },
    })
    dbMock.store.addCatalog({
      id: "sk-g",
      kind: "skills",
      stableId: "sk-g",
      name: "G skill",
      grade: "G",
      config: {
        track: "class",
        milestone: 4,
        effects: [{ phase: "flat", amount: { strength: 1 } }],
      },
    })
    dbMock.store.addCatalog({
      id: "sk-u",
      kind: "skills",
      stableId: "sk-u",
      name: "No grade skill",
      config: {
        track: "class",
        milestone: 4,
        effects: [{ phase: "flat", amount: { strength: 1 } }],
      },
    })

    const res = await advanceCharacter(
      "chr-1",
      { track: "class", version: 0 },
      user
    )
    const offered = res.character.skillOffers.flatMap((o) =>
      o.options.map((x) => x.definitionId)
    )
    // The graded class at grade F offers the F-graded and ungraded skills; the
    // G-graded skill (matching the race grade) must NOT be offered.
    expect(offered).toContain("sk-f")
    expect(offered).toContain("sk-u")
    expect(offered).not.toContain("sk-g")
  })

  it("returns no class options and no fallback, and rejects track evolve, on a legacy ungraded track", async () => {
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

    seedTrackEvolution("evo-class-1", "Archer F -> E", {
      track: "class",
      fromDefinitionStableId: "archer",
      toDefinitionStableId: "archer",
      fromGrade: "F",
      toGrade: "E",
    })
    await expect(
      evolveCharacter(
        "chr-1",
        { track: "class", optionId: "evo-class-1", version: 0 },
        user
      )
    ).rejects.toMatchObject({ status: 400, code: "track_grade_unknown" })
  })

  it("preserves a graded class/profession track across export/import state roundtrip", async () => {
    seedClass("cls-archer", "archer", "Archer", {
      F: { fixed: { agility: 2 }, free: 1 },
    })
    dbMock.store.addCatalog({
      id: "race-human",
      kind: "races",
      stableId: "human",
      name: "Human",
      config: {
        raceDefinitions: {
          G: { id: "human:G", perLevel: { strength: 1 }, freePerLevel: 1 },
        },
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
      { pantheon: "Test Pantheon", divineRank: "God" },
      { name: "God One" }
    )
    addImportCatalog(
      "blessings",
      "bless-1",
      { tier: "Minor", effects: [], patronGodStableId: "god-1" },
      { name: "Bless One" }
    )
    addImportCatalog(
      "bloodlines",
      "blood-1",
      { effects: [] },
      { name: "Blood One" }
    )
    const doc = importDoc({
      associations: [
        {
          kind: "blessing",
          definition: { kind: "blessings", stableId: "bless-1" },
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
      "blessings",
      "bless-1",
      { tier: "Minor", effects: [] },
      { name: "Bless One" }
    )
    addImportCatalog(
      "blessings",
      "bless-2",
      { tier: "Minor", effects: [] },
      { name: "Bless Two" }
    )
    const doc = importDoc({
      associations: [
        {
          kind: "blessing",
          definition: { kind: "blessings", stableId: "bless-1" },
        },
        {
          kind: "blessing",
          definition: { kind: "blessings", stableId: "bless-2" },
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
      "blessings",
      "bless-1",
      { tier: "Minor", effects: [] },
      { name: "Bless One" }
    )
    const doc = importDoc({
      associations: [
        {
          kind: "blessing",
          definition: { kind: "blessings", stableId: "bless-1" },
        },
        {
          kind: "blessing",
          definition: { kind: "blessings", stableId: "bless-1" },
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
      "blessings",
      "bless-1",
      { tier: "Minor", effects: [] },
      { name: "Bless One" }
    )
    addImportCatalog(
      "blessings",
      "bless-2",
      { tier: "Minor", effects: [] },
      { name: "Bless Two", archived: true }
    )
    const doc = importDoc({
      associations: [
        {
          kind: "blessing",
          definition: { kind: "blessings", stableId: "bless-1" },
        },
        {
          kind: "blessing",
          definition: { kind: "blessings", stableId: "bless-2" },
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
      "blessings",
      "bless-1",
      { tier: "Minor", effects: [] },
      { name: "Bless One" }
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
    const doc = importDoc({
      associations: [
        {
          kind: "blessing",
          definition: { kind: "blessings", stableId: "bless-1" },
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
      "blessings",
      "bless-1",
      { tier: "Minor", effects: [] },
      { name: "Bless One" }
    )
    addImportCatalog(
      "blessings",
      "bless-arch",
      { tier: "Minor", effects: [] },
      { name: "Bless Arch", archived: true }
    )
    const doc = importDoc({
      associations: [
        {
          kind: "blessing",
          definition: { kind: "blessings", stableId: "bless-1" },
        },
        {
          kind: "blessing",
          definition: { kind: "blessings", stableId: "bless-arch" },
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
      "blessings",
      "bless-1",
      { tier: "Minor", effects: [] },
      { name: "Bless One" }
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
        definitionId: "bless-1",
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
      { upgradeGroup: "core" },
      { name: "Skill One" }
    )
    addImportCatalog(
      "skills",
      "skill-2",
      { upgradeGroup: "core" },
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
        "consumables",
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
            definition: { kind: "consumables", stableId: "consum-1" },
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
      // Full rollback: no character row, no provenance events.
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

    it("round-trips a v4 backup: equipped stock and consumables survive export and re-import", async () => {
      seedRaceClass()
      addImportCatalog(
        "equipment",
        "gear-1",
        { slot: "head" },
        { name: "Helm" }
      )
      addImportCatalog(
        "consumables",
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
      expect(portable.schema).toBe("primal-character/4")
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
  })
})

describe("consumeCharacter (consumables)", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  function bornFState(raceLevel: number, grade: string = "F"): unknown {
    const state = createInitialState("born", null, null)
    state.race = { ...state.race, level: raceLevel, grade: grade as Grade }
    return serializeState(state)
  }

  function seedConsumable(
    id: string,
    config: Record<string, unknown>,
    extra: Partial<{ name: string; archived: boolean }> = {}
  ): unknown {
    const row = dbMock.store.addCatalog({
      id,
      kind: "consumables",
      stableId: id,
      name: extra.name ?? `Consumable ${id}`,
      config,
      ...(extra.archived != null ? { archived: extra.archived } : {}),
    })
    // Manual bookkeeping: acquiring stock to consume requires an owned quantity.
    dbMock.store.addInventoryItem({
      characterId: "chr-1",
      definitionId: id,
      quantity: 5,
    })
    return row
  }

  function seedChar(
    state: unknown,
    version = 0,
    archived = false,
    origin: "integrated" | "born" = "integrated"
  ): unknown {
    return dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      state,
      version,
      archived,
      origin,
    })
  }

  function stripOrigin(state: unknown): unknown {
    delete (state as { race: { origin?: string } }).race.origin
    return state
  }

  it("applies a permanent gain and logs a consume event with a definition snapshot", async () => {
    seedChar(bornFState(10), 0, false, "born")
    seedConsumable("perm-1", { type: "permanent", amount: { strength: 3 } })
    const res = await consumeCharacter(
      "chr-1",
      { definitionId: "perm-1", version: 0 },
      user
    )
    expect(res.character.version).toBe(1)
    // Applied as a verbatim permanent gain (baseAttributes 0 + gain 3).
    expect(res.status.attributes.strength).toBe(3)
    // Authoritative server fields: remaining capacity is now 27 of 30.
    expect(res.character.permanentConsumableCap).toMatchObject({ strength: 30 })
    expect(res.character.permanentConsumableRemaining).toMatchObject({
      strength: 27,
      agility: 30,
    })
    const gains = (
      res.character.state as {
        permanentGains: Array<{ kind: string; vector: Record<string, number> }>
      }
    ).permanentGains
    expect(gains).toHaveLength(1)
    expect(gains[0]).toMatchObject({
      kind: "consumable",
      vector: { strength: 3 },
    })

    expect(dbMock.store.events).toHaveLength(1)
    const event = dbMock.store.events[0]
    expect(event.kind).toBe("consume")
    expect(event.payload).toMatchObject({
      definitionId: "perm-1",
      type: "permanent",
      applied: { strength: 3 },
      requested: { strength: 3 },
      capRemainingAfter: { strength: 27 },
    })
    const payload = event.payload as {
      definition: { name: string }
      appliedAt: string
    }
    expect(payload.definition.name).toBe("Consumable perm-1")
    expect(typeof payload.appliedAt).toBe("string")
  })

  it("rejects a permanent gain above the cumulative cap (400) and writes no event", async () => {
    seedChar(bornFState(10), 0, false, "born")
    seedConsumable("perm-1", { type: "permanent", amount: { strength: 31 } })
    await expect(
      consumeCharacter("chr-1", { definitionId: "perm-1", version: 0 }, user)
    ).rejects.toMatchObject({ status: 400, code: "consumable_cap_exceeded" })
    // No mutation, no event, ledger untouched.
    expect(dbMock.store.characters.get("chr-1")!.version).toBe(0)
    expect(dbMock.store.events).toHaveLength(0)
  })

  it("adds a unique temporary active effect that expires by duration quarters", async () => {
    seedChar(bornFState(5), 0, false, "born")
    seedConsumable("temp-1", {
      type: "temporary",
      amount: { strength: 4 },
      durationQuarters: 3,
    })
    const res = await consumeCharacter(
      "chr-1",
      { definitionId: "temp-1", version: 0 },
      user
    )
    expect(res.character.version).toBe(1)
    const effects = (
      res.character.state as {
        activeEffects: Array<{
          id: string
          phase: string
          source: string
          expiresAt?: number
          amount: Record<string, number>
        }>
      }
    ).activeEffects
    expect(effects).toHaveLength(1)
    const effect = effects[0]
    expect(effect.phase).toBe("temporary")
    expect(effect.source).toBe("consumable")
    expect(effect.amount.strength).toBe(4)
    // state.turn is 0, so the effect expires 3 quarters later.
    expect(effect.expiresAt).toBe(3)
    // Temporary effects are uncapped: requested === applied, no capUsage.
    expect(res.status.consumables.applied.strength).toBe(4)
    expect(res.status.attributes.strength).toBe(4)
    expect(res.status.consumables.capUsage).toEqual([])
    // Unique per-application effect id is deterministic but distinct per consumption.
    expect(effect.id).toContain("temp-1:cons-0-")

    const event = dbMock.store.events[0]
    expect(event.kind).toBe("consume")
    expect(event.payload).toMatchObject({
      definitionId: "temp-1",
      type: "temporary",
      applied: { strength: 4 },
      durationQuarters: 3,
      expiresAt: 3,
      capRemainingAfter: {},
    })
  })

  it("records the acting user id on a permanent consume event while preserving the snapshot and stock fields", async () => {
    seedChar(bornFState(10), 0, false, "born")
    seedConsumable("perm-audit", { type: "permanent", amount: { strength: 3 } })
    const res = await consumeCharacter(
      "chr-1",
      { definitionId: "perm-audit", version: 0 },
      user
    )
    expect(res.character.version).toBe(1)
    expect(res.status.attributes.strength).toBe(3)
    expect(dbMock.store.events).toHaveLength(1)
    const event = dbMock.store.events[0]
    expect(event.kind).toBe("consume")
    // The acting user is recorded on the consume event.
    expect(event.payload).toMatchObject({
      actorId: user.id,
      definitionId: "perm-audit",
      type: "permanent",
      applied: { strength: 3 },
      requested: { strength: 3 },
      capRemainingAfter: { strength: 27 },
      stockPrior: 5,
      stockAfter: 4,
    })
    // History is unchanged: the definition snapshot and timestamp are intact.
    const payload = event.payload as {
      definition: {
        name: string
        stableId: string
        kind: string
        grade: string | null
      }
      appliedAt: string
    }
    expect(payload.definition.name).toBe("Consumable perm-audit")
    expect(payload.definition.stableId).toBe("perm-audit")
    expect(payload.definition.kind).toBe("consumables")
    expect(typeof payload.appliedAt).toBe("string")
  })

  it("records the acting user id on a temporary consume event", async () => {
    seedChar(bornFState(5), 0, false, "born")
    seedConsumable("temp-audit", {
      type: "temporary",
      amount: { strength: 4 },
      durationQuarters: 3,
    })
    const res = await consumeCharacter(
      "chr-1",
      { definitionId: "temp-audit", version: 0 },
      user
    )
    expect(res.character.version).toBe(1)
    expect(dbMock.store.events).toHaveLength(1)
    const event = dbMock.store.events[0]
    expect(event.kind).toBe("consume")
    expect(event.payload).toMatchObject({
      actorId: user.id,
      definitionId: "temp-audit",
      type: "temporary",
      applied: { strength: 4 },
      requested: { strength: 4 },
      durationQuarters: 3,
      expiresAt: 3,
      capRemainingAfter: {},
      stockPrior: 5,
      stockAfter: 4,
    })
  })

  it("records the acting admin id when an admin consumes on another owner's character", async () => {
    const otherOwnerState = bornFState(10)
    dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: "owner-other",
      name: "Another's character",
      state: otherOwnerState,
      version: 0,
      origin: "born",
    })
    seedConsumable("perm-admin", { type: "permanent", amount: { strength: 3 } })
    const admin = { id: "admin-1", email: "a@example.com", isAdmin: true }
    const res = await consumeCharacter(
      "chr-1",
      { definitionId: "perm-admin", version: 0 },
      admin
    )
    expect(res.character.version).toBe(1)
    expect(res.status.attributes.strength).toBe(3)
    expect(dbMock.store.events).toHaveLength(1)
    const event = dbMock.store.events[0]
    expect(event.kind).toBe("consume")
    // The admin's id, not the owner's, is the actor on this consume.
    const payload = event.payload as { actorId: string; definitionId: string }
    expect(payload.actorId).toBe(admin.id)
    expect(payload.definitionId).toBe("perm-admin")
  })

  it("supports repeated permanent applications", async () => {
    seedChar(bornFState(10), 0, false, "born")
    seedConsumable("perm-1", { type: "permanent", amount: { strength: 3 } })
    const first = await consumeCharacter(
      "chr-1",
      { definitionId: "perm-1", version: 0 },
      user
    )
    const second = await consumeCharacter(
      "chr-1",
      { definitionId: "perm-1", version: 1 },
      user
    )
    expect(first.character.version).toBe(1)
    expect(second.character.version).toBe(2)
    const gains = (
      second.character.state as {
        permanentGains: Array<{ kind: string }>
      }
    ).permanentGains
    expect(gains).toHaveLength(2)
    expect(second.status.attributes.strength).toBe(6)
    expect(dbMock.store.events).toHaveLength(2)
  })

  it("rejects a wrong-kind, an archived definition, and an archived character", async () => {
    seedChar(bornFState(1), 0, false, "born")
    // Wrong kind: an equipment entry requested as a consumable.
    dbMock.store.addCatalog({
      id: "gear-1",
      kind: "equipment",
      stableId: "gear-1",
      name: "Gear",
      config: { slot: "head", bonus: { strength: 5 } },
    })
    // Archived consumable.
    seedConsumable(
      "perm-arch",
      { type: "permanent", amount: { strength: 1 } },
      {
        archived: true,
      }
    )
    await expect(
      consumeCharacter("chr-1", { definitionId: "gear-1", version: 0 }, user)
    ).rejects.toMatchObject({ status: 400, code: "wrong_kind" })
    await expect(
      consumeCharacter("chr-1", { definitionId: "perm-arch", version: 0 }, user)
    ).rejects.toMatchObject({ status: 400, code: "catalog_archived" })
    // A missing definition 404s.
    await expect(
      consumeCharacter("chr-1", { definitionId: "missing", version: 0 }, user)
    ).rejects.toMatchObject({ status: 404 })

    // An archived character is inert.
    seedChar(bornFState(1), 0, true, "born")
    seedConsumable("perm-ok", { type: "permanent", amount: { strength: 1 } })
    await expect(
      consumeCharacter("chr-1", { definitionId: "perm-ok", version: 0 }, user)
    ).rejects.toMatchObject({ status: 400, code: "character_archived" })
    expect(dbMock.store.events).toHaveLength(0)
  })

  it("rejects a stale version (409) and never writes a stale event", async () => {
    seedChar(bornFState(10), 0, false, "born")
    seedConsumable("perm-1", { type: "permanent", amount: { strength: 3 } })
    const first = await consumeCharacter(
      "chr-1",
      { definitionId: "perm-1", version: 0 },
      user
    )
    expect(first.character.version).toBe(1)
    expect(dbMock.store.events).toHaveLength(1)

    await expect(
      consumeCharacter("chr-1", { definitionId: "perm-1", version: 0 }, user)
    ).rejects.toMatchObject({ status: 409, code: "version_conflict" })

    const fresh = dbMock.store.characters.get("chr-1")!
    expect(fresh.version).toBe(1)
    expect(dbMock.store.events).toHaveLength(1)
  })

  it("rejects a positive permanent gain when the grade has zero capacity", async () => {
    // An integrated G-origin character in the G band (levels 1..9) has a 0 rate by
    // default (G is an unknown/unconfigured grade). The cumulative capacity is 0,
    // so any positive permanent gain is rejected.
    const state = createInitialState("integrated", null, null)
    state.race = { ...state.race, level: 5, grade: "G" }
    seedChar(serializeState(state))
    seedConsumable("perm-g", { type: "permanent", amount: { strength: 1 } })
    await expect(
      consumeCharacter("chr-1", { definitionId: "perm-g", version: 0 }, user)
    ).rejects.toMatchObject({ status: 400, code: "consumable_cap_exceeded" })
    expect(dbMock.store.events).toHaveLength(0)
  })

  it("reconstructs a missing state origin from Character.origin (born) and persists it", async () => {
    // A legacy state predating origin tracking: race.origin absent, but the
    // authoritative Character.origin column says "born".
    seedChar(stripOrigin(bornFState(10)), 0, false, "born")
    seedConsumable("perm-born", { type: "permanent", amount: { strength: 4 } })
    const res = await consumeCharacter(
      "chr-1",
      { definitionId: "perm-born", version: 0 },
      user
    )
    // born F level 10 capacity is 30, so the +4 applies in full, not capped to 3.
    expect(res.status.attributes.strength).toBe(4)
    expect(res.character.permanentConsumableCap).toMatchObject({ strength: 30 })
    // The mutation wrote the reconstructed origin into the persisted state.
    const persisted = res.character.state as { race: { origin?: string } }
    expect(persisted.race.origin).toBe("born")
  })

  it("treats a legacy integrated state as conservative integrated (no over-cap grant)", async () => {
    // Legacy state without race.origin, integrated row, F level 10. The engine
    // must NOT infer born from the non-G grade: conservative integrated capacity
    // is 3, so a +4 permanent gain is rejected rather than silently accepted.
    const state = createInitialState("integrated", null, null)
    state.race = { ...state.race, level: 10, grade: "F" as Grade }
    seedChar(serializeState(state))
    seedConsumable("perm-int", { type: "permanent", amount: { strength: 4 } })
    await expect(
      consumeCharacter("chr-1", { definitionId: "perm-int", version: 0 }, user)
    ).rejects.toMatchObject({ status: 400, code: "consumable_cap_exceeded" })
    expect(dbMock.store.events).toHaveLength(0)
    expect(dbMock.store.characters.get("chr-1")!.version).toBe(0)
  })

  it("derives detail capacity from Character.origin, not grade inference (integrated 3 vs born 30)", async () => {
    // Integrated row, legacy state without origin: F level 10 -> cap 3.
    let state = createInitialState("integrated", null, null)
    state.race = { ...state.race, level: 10, grade: "F" as Grade }
    seedChar(serializeState(state))
    const detail = await getCharacter("chr-1", user)
    expect(detail.permanentConsumableCap).toMatchObject({ strength: 3 })

    dbMock.store.reset()
    // Born row, legacy state without origin: F level 10 -> cap 30.
    state = createInitialState("born", null, null)
    state.race = { ...state.race, level: 10, grade: "F" as Grade }
    seedChar(serializeState(state), 0, false, "born")
    const bornDetail = await getCharacter("chr-1", user)
    expect(bornDetail.permanentConsumableCap).toMatchObject({ strength: 30 })
  })

  it("rejects a legacy consumable config with an actionable 400, not a 500", async () => {
    seedChar(bornFState(10), 0, false, "born")
    // A legacy config lacking type/amount must remain visible and reject on
    // consume with an explicit code, never crash as a 500 or fake a default.
    seedConsumable("legacy-1", { grade: "F" })
    await expect(
      consumeCharacter("chr-1", { definitionId: "legacy-1", version: 0 }, user)
    ).rejects.toMatchObject({ status: 400, code: "legacy_consumable_config" })
    expect(dbMock.store.events).toHaveLength(0)
    expect(dbMock.store.characters.get("chr-1")!.version).toBe(0)
  })
})

describe("catalog consumable config legacy handling", () => {
  beforeEach(() => {
    dbMock.store.reset()
  })

  it("allows a metadata-only PATCH on a legacy consumable entry (config unchanged)", async () => {
    dbMock.store.addCatalog({
      id: "legacy-c",
      kind: "consumables",
      stableId: "legacy-c",
      name: "Old Potion",
      config: { grade: "F" },
    })
    const item = await updateCatalogItem("consumables", "legacy-c", {
      name: "Renamed Potion",
    })
    expect(item.name).toBe("Renamed Potion")
    // The legacy config is preserved untouched, and no default amount is invented.
    expect((item.config as Record<string, unknown>).grade).toBe("F")
    expect((item.config as Record<string, unknown>).amount).toBeUndefined()
  })

  it("requires the modern full shape when a consumable config is changed", async () => {
    dbMock.store.addCatalog({
      id: "legacy-c",
      kind: "consumables",
      stableId: "legacy-c",
      name: "Old Potion",
      config: { grade: "F" },
    })
    await expect(
      updateCatalogItem("consumables", "legacy-c", { config: { grade: "F" } })
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    // The update never applied - the catalog row is unchanged.
    expect(
      (dbMock.store.catalog.get("legacy-c")!.config as Record<string, unknown>)
        .grade
    ).toBe("F")
  })

  it("requires the modern full shape when creating a consumable", async () => {
    await expect(
      createCatalogItem("consumables", {
        name: "New Potion",
        config: { grade: "F" },
      })
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    expect(dbMock.store.catalog.size).toBe(0)
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

  function blessingRow(id: string): {
    config: Record<string, unknown>
    patronId: string | null | undefined
  } {
    const row = dbMock.store.catalog.get(id)!
    return { config: row.config, patronId: row.patronId }
  }

  it("creates a modern blessing and resolves its patron god FK", async () => {
    seedGod("god-1", "malefic-viper")
    const item = await createCatalogItem("blessings", {
      stableId: "bless-1",
      name: "Malefic Blessing",
      config: {
        tier: "Major",
        effects: [{ phase: "flat", amount: { strength: 5 } }],
        patronGodStableId: "malefic-viper",
      },
    })
    expect(item.config).toMatchObject({ tier: "Major" })
    expect(blessingRow(item.id).patronId).toBe("god-1")
  })

  it("creates a modern blessing with no patron (and no FK)", async () => {
    const item = await createCatalogItem("blessings", {
      stableId: "bless-2",
      name: "Unbound Blessing",
      config: {
        tier: "Lesser",
        effects: [],
      },
    })
    expect(item.config).toMatchObject({ tier: "Lesser" })
    expect(blessingRow(item.id).patronId).toBeNull()
  })

  it("maps a serialization failure (P2034) on blessing create to a 409, never a 500", async () => {
    seedGod("god-serial", "serial-god")
    const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce({
      name: "PrismaClientKnownRequestError",
      code: "P2034",
    })
    try {
      await expect(
        createCatalogItem("blessings", {
          stableId: "serial-bless",
          name: "Serializable Blessing",
          config: {
            tier: "Minor",
            effects: [],
            patronGodStableId: "serial-god",
          },
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

  it("rejects a blessing with a missing patron god", async () => {
    await expect(
      createCatalogItem("blessings", {
        name: "Ghost Blessing",
        config: { tier: "True", effects: [], patronGodStableId: "no-such-god" },
      })
    ).rejects.toMatchObject({ status: 400, code: "patron_god_not_found" })
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("rejects a blessing whose patron god is archived", async () => {
    seedGod("god-2", "sleeping-god", { archived: true })
    await expect(
      createCatalogItem("blessings", {
        name: "Dormant Blessing",
        config: {
          tier: "Divine",
          effects: [],
          patronGodStableId: "sleeping-god",
        },
      })
    ).rejects.toMatchObject({ status: 400, code: "patron_god_archived" })
    expect(dbMock.store.catalog.size).toBe(1)
  })

  it("rejects a legacy blessing (no tier/effects) on create", async () => {
    await expect(
      createCatalogItem("blessings", {
        name: "Old Blessing",
        config: { grade: "F", effect: { strength: 3 } },
      })
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    expect(dbMock.store.catalog.size).toBe(0)
  })

  it("rejects a blessing effect vector that is not a finite integer", async () => {
    await expect(
      createCatalogItem("blessings", {
        name: "Fractional Blessing",
        config: {
          tier: "Minor",
          effects: [{ phase: "flat", amount: { strength: 1.5 } }],
        },
      })
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    expect(dbMock.store.catalog.size).toBe(0)
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
    expect(blessingRow(item.id).patronId).toBeNull()
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

  it("allows a metadata-only PATCH on a legacy blessing (config unchanged)", async () => {
    dbMock.store.addCatalog({
      id: "legacy-b",
      kind: "blessings",
      stableId: "legacy-b",
      name: "Old Blessing",
      config: { grade: "F", effect: { strength: 3 } },
    })
    const item = await updateCatalogItem("blessings", "legacy-b", {
      name: "Renamed Blessing",
    })
    expect(item.name).toBe("Renamed Blessing")
    expect((item.config as Record<string, unknown>).effect).toMatchObject({
      strength: 3,
    })
  })

  it("requires the modern shape when a blessing config is changed", async () => {
    dbMock.store.addCatalog({
      id: "legacy-b",
      kind: "blessings",
      stableId: "legacy-b",
      name: "Old Blessing",
      config: { grade: "F", effect: { strength: 3 } },
    })
    await expect(
      updateCatalogItem("blessings", "legacy-b", {
        config: { grade: "F", effect: { strength: 3 } },
      })
    ).rejects.toMatchObject({ status: 400, code: "invalid_config" })
    // The update never applied.
    expect(
      (dbMock.store.catalog.get("legacy-b")!.config as Record<string, unknown>)
        .effect
    ).toMatchObject({ strength: 3 })
  })

  it("repopulates the blessing FK when its patron god changes in the same transaction", async () => {
    seedGod("god-1", "first-god")
    seedGod("god-2", "second-god")
    dbMock.store.addCatalog({
      id: "bless-1",
      kind: "blessings",
      stableId: "bless-1",
      name: "Switching Blessing",
      config: {
        tier: "Greater",
        effects: [],
        patronGodStableId: "first-god",
      },
      patronId: "god-1",
    })
    const item = await updateCatalogItem("blessings", "bless-1", {
      config: {
        tier: "Greater",
        effects: [],
        patronGodStableId: "second-god",
      },
    })
    expect(item.config).toMatchObject({ patronGodStableId: "second-god" })
    expect(blessingRow("bless-1").patronId).toBe("god-2")
  })

  it("clears the blessing FK when the patron god is removed from the config", async () => {
    seedGod("god-1", "first-god")
    dbMock.store.addCatalog({
      id: "bless-1",
      kind: "blessings",
      stableId: "bless-1",
      name: "Removing Blessing",
      config: {
        tier: "Greater",
        effects: [],
        patronGodStableId: "first-god",
      },
      patronId: "god-1",
    })
    const item = await updateCatalogItem("blessings", "bless-1", {
      config: { tier: "Greater", effects: [] },
    })
    expect(item.config).toMatchObject({ effects: [] })
    expect(blessingRow("bless-1").patronId).toBeNull()
  })

  it("409s a god stableId change while a blessing still references it", async () => {
    seedGod("god-1", "stable-god")
    dbMock.store.addCatalog({
      id: "bless-1",
      kind: "blessings",
      stableId: "bless-1",
      name: "Referencing Blessing",
      config: {
        tier: "Minor",
        effects: [],
        patronGodStableId: "stable-god",
      },
      patronId: "god-1",
    })
    await expect(
      updateCatalogItem("gods", "god-1", { stableId: "renamed-god" })
    ).rejects.toMatchObject({ status: 409, code: "patron_stable_id_in_use" })
    // The rejected change never applied.
    expect(dbMock.store.catalog.get("god-1")!.stableId).toBe("stable-god")
  })

  it("allows a god stableId change when no blessing references it", async () => {
    seedGod("god-1", "stable-god")
    const item = await updateCatalogItem("gods", "god-1", {
      stableId: "renamed-god",
    })
    expect(item.stableId).toBe("renamed-god")
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
      provenance: string
    }> = {}
  ): unknown {
    return dbMock.store.addCatalog({
      id,
      kind: "skills",
      stableId: id,
      name: extra.name ?? `Skill ${id}`,
      config,
      ...(extra.grade ? { grade: extra.grade } : {}),
      ...(extra.provenance ? { provenance: extra.provenance } : {}),
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
      effects: [],
    })
    seedSkill("sk-high", {
      track: "class",
      milestone: 4,
      upgradeGroup: "tier",
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

    // Editing the skill's effects recalculates the live status.
    await updateCatalogItem("skills", "sk-1", {
      config: {
        track: "class",
        milestone: 4,
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
      config: { track: "class", milestone: 4 },
    })
    const ok = await updateCatalogItem("skills", "sk-ok", {
      config: { track: "profession", milestone: 4 },
    })
    expect((ok.config as { track: string }).track).toBe("profession")
    await expect(
      updateCatalogItem("skills", "sk-ok", {
        config: { track: "Profession", milestone: 4 },
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
    return seedCatalog(id, "consumables", config, extra)
  }

  function seedStock(definitionId: string, quantity: number) {
    return dbMock.store.addInventoryItem({
      characterId: "chr-1",
      definitionId,
      quantity,
    })
  }

  function setStock(definitionId: string, quantity: number) {
    const idx = dbMock.store.inventory.findIndex(
      (i) => i.characterId === "chr-1" && i.definitionId === definitionId
    )
    if (idx >= 0) dbMock.store.inventory.splice(idx, 1)
    return seedStock(definitionId, quantity)
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
      kind: "consumables",
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

  it("consuming a consumable decrements stock by one and a failed cap/version rolls back stock, state and journal", async () => {
    const state = createInitialState("born", null, null)
    state.race = { ...state.race, level: 10, grade: "F" as Grade }
    dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      state: serializeState(state),
      version: 0,
      origin: "born",
    })
    seedConsumable("perm-1", { type: "permanent", amount: { strength: 3 } })
    seedStock("perm-1", 4)
    const res = await consumeCharacter(
      "chr-1",
      { definitionId: "perm-1", version: 0 },
      user
    )
    expect(res.status.attributes.strength).toBe(3)
    expect(
      dbMock.store.inventory.find((i) => i.definitionId === "perm-1")!.quantity
    ).toBe(3)
    const ev = dbMock.store.events[0]
    expect(ev.payload).toMatchObject({ stockPrior: 4, stockAfter: 3 })

    // A permanent gain above the cumulative cap rejects and rolls back.
    const capState = createInitialState("born", null, null)
    capState.race = { ...capState.race, level: 10, grade: "F" as Grade }
    dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      state: serializeState(capState),
      version: 0,
      origin: "born",
    })
    seedConsumable("perm-31", { type: "permanent", amount: { strength: 31 } })
    seedStock("perm-31", 4)
    const eventsBefore = dbMock.store.events.length
    await expect(
      consumeCharacter("chr-1", { definitionId: "perm-31", version: 0 }, user)
    ).rejects.toMatchObject({ status: 400, code: "consumable_cap_exceeded" })
    expect(
      dbMock.store.inventory.find((i) => i.definitionId === "perm-31")!.quantity
    ).toBe(4)
    expect(dbMock.store.events).toHaveLength(eventsBefore)
    expect(dbMock.store.characters.get("chr-1")!.version).toBe(0)
  })

  it("rejects consuming a consumable the character owns none of", async () => {
    const state = createInitialState("born", null, null)
    state.race = { ...state.race, level: 1, grade: "F" as Grade }
    dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      state: serializeState(state),
      version: 0,
      origin: "born",
    })
    seedConsumable("pot-1", { type: "permanent", amount: { strength: 1 } })
    // No owned stock -> insufficient.
    await expect(
      consumeCharacter("chr-1", { definitionId: "pot-1", version: 0 }, user)
    ).rejects.toMatchObject({ status: 400, code: "inventory_insufficient" })
    expect(dbMock.store.events).toHaveLength(0)
    expect(dbMock.store.characters.get("chr-1")!.version).toBe(0)
  })

  it("concurrent consumes of the final stock unit let exactly one succeed", async () => {
    const state = createInitialState("born", null, null)
    state.race = { ...state.race, level: 1, grade: "F" as Grade }
    dbMock.store.addCharacter({
      id: "chr-1",
      ownerId: user.id,
      name: "Test",
      state: serializeState(state),
      version: 0,
      origin: "born",
    })
    seedConsumable("temp-1", {
      type: "temporary",
      amount: { strength: 4 },
      durationQuarters: 3,
    })
    setStock("temp-1", 1)
    const results = await Promise.allSettled([
      consumeCharacter("chr-1", { definitionId: "temp-1", version: 0 }, user),
      consumeCharacter("chr-1", { definitionId: "temp-1", version: 0 }, user),
    ])
    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    const reason = (rejected[0] as PromiseRejectedResult).reason as {
      status: number
    }
    expect(reason.status).toBeGreaterThanOrEqual(400)
    expect(dbMock.store.inventory).toHaveLength(0)
    expect(dbMock.store.characters.get("chr-1")!.version).toBe(1)
  })
})
