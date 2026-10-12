import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  advanceCharacter,
  allocateCharacter,
  applyAdvance,
  applyAllocate,
  applyEvolve,
  buildRulesConfig,
  createCharacter,
  createInitialState,
  deserializeState,
  evolveCharacter,
  resolveTrackDefinition,
  serializeState,
  updateCharacter,
} from "@/lib/db/service"
import {
  createCharacterState,
  defaultRulesConfig,
  makeVector,
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

function allEqual(n: number) {
  const out: Record<string, number> = {}
  for (const a of [
    "strength",
    "agility",
    "endurance",
    "vitality",
    "toughness",
    "wisdom",
    "intelligence",
    "perception",
    "willpower",
  ]) {
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
    const def = resolveTrackDefinition(archerClass, state)
    expect(def?.id).toBe("archer:F")
  })

  it("falls back to the lowest defined grade when the character grade has none", () => {
    const state = createCharacterState({
      baseAttributes: makeVector({}),
      tracks: { class: { level: 0, quarter: 0, definitionId: "" } },
      race: { level: 0, grade: "G", mode: "derived" },
    })
    const def = resolveTrackDefinition(archerClass, state)
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
      state
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
