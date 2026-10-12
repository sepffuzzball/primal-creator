import { beforeEach, describe, expect, it, vi } from "vitest"
import {
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
  getCharacter,
  resolveTrackDefinition,
  serializeState,
  skillCharacter,
  updateCatalogItem,
  updateCharacter,
} from "@/lib/db/service"
import {
  createCharacterState,
  defaultRulesConfig,
  makeVector,
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

  it("exports associations with a definition snapshot and the synthesized liveState", async () => {
    seedCharacterWithBase()
    seedTitle("title-1", { flat: { strength: 5 }, upgradeGroup: "hero" })
    seedEquipment("gear-1", { slot: "head", bonus: { strength: 10 } })
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
    expect(portable.schema).toBe("primal-character/2")
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
    return dbMock.store.addCatalog({
      id,
      kind: "consumables",
      stableId: id,
      name: extra.name ?? `Consumable ${id}`,
      config,
      ...(extra.archived != null ? { archived: extra.archived } : {}),
    })
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
