import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  advanceCharacter,
  allocateCharacter,
  applyAdvance,
  applyAllocate,
  applyEvolve,
  associateCharacter,
  buildRulesConfig,
  createCharacter,
  createInitialState,
  deserializeState,
  evolveCharacter,
  exportCharacter,
  resolveTrackDefinition,
  serializeState,
  updateCatalogItem,
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
