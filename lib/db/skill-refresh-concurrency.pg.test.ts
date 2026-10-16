/**
 * Real-Postgres concurrency tests for the skill-offer refresh vs selection race.
 *
 * Both `refreshPendingSkillOffers` (SERIALIZABLE) and `skillCharacter` (selection,
 * READ COMMITTED) now acquire a `SELECT ... FOR UPDATE` row lock on the offer
 * BEFORE reading/validating it and hold it through the append / selected-state
 * update. This serializes the two transactions on the offer row, so a refresh can
 * never append options to an offer that is concurrently selected, and a
 * selection can never run while a refresh is mid-append to the same offer.
 *
 * Dangerous interleavings:
 *  - If the refresh wins the lock first it appends the newly eligible skill and
 *    commits BEFORE the selection runs; the appended option is part of the
 *    immutable snapshot at selection time, so the selected offer's options are
 *    stable.
 *  - If the selection wins first it selects and commits; when the refresh then
 *    acquires the lock its SERIALIZABLE snapshot is stale (it read the offer as
 *    pending before the selection committed), so it is aborted with P2034 - which
 *    the service maps to a retryable 409, never a raw 500, with the transaction
 *    already rolled back (no stray option row). On retry the offer is filtered out
 *    (selected), so options are never appended after a selection.
 *
 * This file forces each deterministic ordering (selected-first and refresh-first)
 * by holding the offer row lock myself, starting ONLY the service that must go
 * first, waiting until it is provably blocked on the lock (via pg_locks), then
 * starting the second and waiting until it is blocked too, then releasing:
 * Postgres grants row locks to already-waiting transactions FIFO, so the service
 * queued first is served the lock first - no timing sleeps. It also runs the real
 * services concurrently to assert the "selection always wins / never append after
 * selection / never a 500" invariant under a natural race.
 *
 * Runs ONLY when explicitly opted in (see `resolveDbIntegration`): a normal
 * `pnpm test` skips this file. Cleanup is strictly scoped to the exact row ids
 * this run creates (never by fixed pairs), so a pre-existing row is never touched
 * and a concurrent suite never collides.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { prisma } from "@/lib/db/client"
import {
  createInitialState,
  refreshPendingSkillOffers,
  serializeState,
  skillCharacter,
} from "@/lib/db/service"
import { resolveDbIntegration } from "@/lib/test/db-integration"

const gate = await resolveDbIntegration()

describe.skipIf(!gate.run)("skill offer refresh vs selection (real PG)", () => {
  const runSuffix = randomUUID()

  const ownerUser = {
    id: `sg-owner-${runSuffix}`,
    email: `sg-owner-${runSuffix}@test.local`,
    isAdmin: false,
  }

  const createdCharacterIds: string[] = []
  const createdCatalogIds: string[] = []
  const createdUserIds: string[] = []

  /**
   * Reset ALL state this suite has created so far. The concurrency tests rely on
   * catalog isolation: under the modern rules a scheduled credit matches ANY skill
   * with the advancing track and earned grade (`milestone`, `choiceGroup` and
   * `eligibleDefinitionStableIds` are ignored), so a skill authored by an earlier
   * test would otherwise leak into every later offer and inflate its option count.
   * Deleting the suite's characters first (which cascades their offers -> options)
   * releases the catalog-definition references, then the suite's own catalog rows
   * are removed. The shared `ownerUser` is created in `beforeAll` and is left
   * untouched - only suite-created characters and catalog entries are removed.
   */
  async function resetSuiteState(): Promise<void> {
    for (const id of createdCharacterIds) {
      await prisma.character.deleteMany({ where: { id } })
    }
    createdCharacterIds.length = 0
    if (createdCatalogIds.length > 0) {
      await prisma.catalogDefinition.deleteMany({
        where: { id: { in: [...createdCatalogIds] } },
      })
    }
    createdCatalogIds.length = 0
  }

  beforeAll(async () => {
    // Idempotent: a crashed prior run may have left the user behind.
    await prisma.user.upsert({
      where: { email: ownerUser.email },
      update: { id: ownerUser.id, isAdmin: false, disabled: false },
      create: {
        id: ownerUser.id,
        email: ownerUser.email,
        password: "x",
        isAdmin: false,
        disabled: false,
      },
    })
    createdUserIds.push(ownerUser.id)
  })

  beforeEach(async () => {
    // Isolation: each test (and each racing iteration) must start with only its own
    // skills/characters in the catalog, so the offer's option count is deterministic.
    await resetSuiteState()
  })

  afterAll(async () => {
    // FK-safe: delete characters first (cascades skillOffers -> options, freeing
    // the catalog-def reference), then catalog definitions, then the user.
    for (const id of createdCharacterIds) {
      await prisma.character.deleteMany({ where: { id } })
    }
    if (createdCatalogIds.length > 0) {
      await prisma.catalogDefinition.deleteMany({
        where: { id: { in: [...createdCatalogIds] } },
      })
    }
    for (const id of createdUserIds) {
      await prisma.user.deleteMany({ where: { id } })
    }
  })

  async function seedSkill(
    id: string,
    stableId: string,
    config: Record<string, unknown>
  ): Promise<void> {
    await prisma.catalogDefinition.create({
      data: {
        id,
        kind: "skills",
        stableId,
        name: `Skill ${stableId}`,
        config: config as never,
      },
    })
    createdCatalogIds.push(id)
  }

  async function seedBaseFixture(
    label: string
  ): Promise<{ characterId: string; offerId: string }> {
    const characterId = `sg-char-${label}-${runSuffix}`
    const offerId = `sg-offer-${label}-${runSuffix}`
    const state = serializeState(createInitialState("integrated", null, null))
    await prisma.character.create({
      data: {
        id: characterId,
        ownerId: ownerUser.id,
        name: "Refresh Rd",
        state: state as never,
        version: 0,
      },
    })
    createdCharacterIds.push(characterId)
    await prisma.skillOffer.create({
      data: {
        id: offerId,
        characterId,
        track: "class",
        level: 4,
        choiceGroup: "standard",
        generation: 0,
        canceledAt: null,
        selectedDefinitionId: null,
        offeredAt: new Date(),
        selectedAt: null,
        earnedGrade: "F",
        trackDefinitionStableId: "archer",
      },
    })
    return { characterId, offerId }
  }

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void
    const promise = new Promise<void>((r) => (resolve = r))
    return { promise, resolve }
  }

  // Helpers to force a deterministic ordering of the two service transactions.
  // Both `skillCharacter` (selection) and `refreshPendingSkillOffers` now take a
  // `SELECT ... FOR UPDATE` row lock on the offer BEFORE reading/validating it, so
  // the two transactions serialize on the offer row. To force a deterministic
  // ordering I hold that lock myself, start ONLY the service that must go FIRST,
  // wait until it is provably blocked on the lock (via pg_locks), then start the
  // second and wait until it is blocked too. Postgres grants a released row lock
  // FIFO to already-waiting transactions, so the first one to block is served the
  // lock first - no timing guess, no sleep.
  //
  // A transaction blocked on a row-level lock surfaces in `pg_locks` differently
  // by isolation level and is therefore counted by DISTINCT pid across the two
  // shapes: a READ COMMITTED `FOR UPDATE` waits with an un-granted `ShareLock` on
  // the owning transaction's `transactionid`, while a SERIALIZABLE `FOR UPDATE`
  // (the refresh) waits with an un-granted `tuple` lock directly on the offer row.
  // I count those (scoped to nothing, since this file is the only DB activity) to
  // know exactly how many service transactions are blocked before I release the
  // holder.
  function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }

  async function blockedLockWaiters(): Promise<number> {
    const rows = await prisma.$queryRaw<Array<{ waiting: number }>>`
      SELECT count(DISTINCT pid)::int AS waiting
      FROM pg_locks
      WHERE NOT granted
        AND locktype IN ('transactionid', 'tuple')`
    return rows[0]?.waiting ?? 0
  }

  async function waitForBlockedWaiters(
    target: number,
    timeoutMs = 5000
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const current = await blockedLockWaiters()
      if (current >= target) return
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for ${target} blocked ` +
            `FOR UPDATE waiter(s); saw ${current}`
        )
      }
      await sleep(10)
    }
  }

  function acquireOfferLock(offerId: string): {
    held: Promise<void>
    release: () => Promise<void>
  } {
    let markHeld!: () => void
    const held = new Promise<void>((r) => (markHeld = r))
    const gate = deferred()
    // Long timeouts: the holder sits idle-in-transaction holding the row lock while
    // the test queues the two services behind it and releases. The default 5s
    // interactive-transaction timeout is not enough for a slow CI machine.
    const txPromise = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM skill_offers WHERE id=${offerId} FOR UPDATE`
        markHeld()
        await gate.promise
      },
      { maxWait: 10000, timeout: 30000 }
    )
    return {
      held,
      release: async () => {
        gate.resolve()
        await txPromise
      },
    }
  }

  it("selected-first: a selection that commits before the refresh acquires the offer lock never gains an option", async () => {
    const { characterId, offerId } = await seedBaseFixture("sel-first")
    const trackStable = `stable-sel-first-${runSuffix}`
    const existingSkillId = `sg-skill-existing-sel-first-${runSuffix}`
    const newSkillId = `sg-skill-new-sel-first-${runSuffix}`
    await seedSkill(existingSkillId, `existing-sel-first-${runSuffix}`, {
      track: "class",
      milestone: 4,
      eligibleDefinitionStableIds: [trackStable],
      effects: [],
    })
    await seedSkill(newSkillId, `new-sel-first-${runSuffix}`, {
      track: "class",
      milestone: 4,
      eligibleDefinitionStableIds: [trackStable],
      effects: [],
    })
    await prisma.skillOffer.update({
      where: { id: offerId },
      data: { trackDefinitionStableId: trackStable },
    })
    await prisma.skillOfferOption.create({
      data: {
        id: `sg-opt-existing-sel-first-${runSuffix}`,
        offerId,
        definitionId: existingSkillId,
        nameSnapshot: "Existing",
        configSnapshot: {},
      },
    })

    // Hold the offer row lock so BOTH service transactions queue behind it. The
    // selection is started first, and we WAIT until it is provably blocked on the
    // lock (pg_locks) before starting the refresh, so FIFO serves the lock to the
    // selection when we release: the selection commits while the refresh is still
    // blocked trying to lock the offer. By the time the refresh acquires the lock,
    // the offer is already selected: the refresh must either be aborted by a stale
    // SERIALIZABLE snapshot (P2034 -> 409) or skip the now-selected offer, and it
    // must NEVER append an option.
    const holder = acquireOfferLock(offerId)
    await holder.held
    const selectPromise = skillCharacter(
      characterId,
      {
        operation: "select",
        offerId,
        definitionId: existingSkillId,
        version: 0,
      },
      ownerUser
    )
    await waitForBlockedWaiters(1)
    const refreshPromise = refreshPendingSkillOffers(characterId, ownerUser)
    await waitForBlockedWaiters(2)

    await holder.release()

    const selected = await selectPromise
    expect(selected.character.version).toBe(1)

    // The refresh either rejected with the retryable serialization_conflict (it
    // read the offer before the selection committed and its stale SERIALIZABLE
    // snapshot cannot serialize) or resolved having skipped the selected offer.
    // Either way it never appended an option.
    await refreshPromise.catch((err: unknown) => {
      expect((err as { status?: number }).status).toBe(409)
      expect((err as { code?: string }).code).toBe("serialization_conflict")
    })

    const offer = await prisma.skillOffer.findUnique({ where: { id: offerId } })
    expect(offer?.selectedDefinitionId).toBe(existingSkillId)
    expect(offer?.selectedAt).not.toBeNull()
    const optionCount = await prisma.skillOfferOption.count({
      where: { offerId },
    })
    // The selected offer's options are unchanged: no post-selection append.
    expect(optionCount).toBe(1)
  })

  it("refresh-first: a refresh that commits its append before the selection keeps the selected offer's options immutable", async () => {
    const { characterId, offerId } = await seedBaseFixture("ref-first")
    const trackStable = `stable-ref-first-${runSuffix}`
    const existingSkillId = `sg-skill-existing-ref-first-${runSuffix}`
    const newSkillId = `sg-skill-new-ref-first-${runSuffix}`
    await seedSkill(existingSkillId, `existing-ref-first-${runSuffix}`, {
      track: "class",
      milestone: 4,
      eligibleDefinitionStableIds: [trackStable],
      effects: [],
    })
    await seedSkill(newSkillId, `new-ref-first-${runSuffix}`, {
      track: "class",
      milestone: 4,
      eligibleDefinitionStableIds: [trackStable],
      effects: [],
    })
    await prisma.skillOffer.update({
      where: { id: offerId },
      data: { trackDefinitionStableId: trackStable },
    })
    await prisma.skillOfferOption.create({
      data: {
        id: `sg-opt-existing-ref-first-${runSuffix}`,
        offerId,
        definitionId: existingSkillId,
        nameSnapshot: "Existing",
        configSnapshot: {},
      },
    })

    // Same lock-holder technique, but the refresh is started first and we wait
    // until it is provably blocked before starting the selection, so FIFO serves
    // the offer row lock to the refresh when we release: it commits its append
    // BEFORE the selection runs. The appended option is part of the immutable
    // snapshot at selection time, so the selected offer settles at exactly the
    // pre-selection count (2) - no option is ever added AFTER the selection.
    const holder = acquireOfferLock(offerId)
    await holder.held
    const refreshPromise = refreshPendingSkillOffers(characterId, ownerUser)
    await waitForBlockedWaiters(1)
    const selectPromise = skillCharacter(
      characterId,
      {
        operation: "select",
        offerId,
        definitionId: existingSkillId,
        version: 0,
      },
      ownerUser
    )
    await waitForBlockedWaiters(2)

    await holder.release()

    // The refresh won the lock first, so its snapshot is fresh and it resolves
    // without a serialization conflict.
    await refreshPromise
    const selected = await selectPromise
    expect(selected.character.version).toBe(1)

    const offer = await prisma.skillOffer.findUnique({ where: { id: offerId } })
    expect(offer?.selectedDefinitionId).toBe(existingSkillId)
    const optionCount = await prisma.skillOfferOption.count({
      where: { offerId },
    })
    expect(optionCount).toBe(2)
  })

  it("racing refresh vs selection: never a 500, never a duplicate, never an append after selection", async () => {
    // Run several independent races. Each iteration uses its own character/offer/
    // skill stableIds so the iterations never interfere and a skill from one
    // iteration can never match another iteration's offer. The invariant in EVERY
    // iteration: the refresh must either commit (appending the single new eligible
    // skill because it won the lock before the selection) or be rejected with the
    // retryable 409 `serialization_conflict` (it lost the lock race to the
    // selection) - never a raw 500. The offer's option count is either 1 (refresh
    // lost / skipped the selected offer) or 2 (refresh committed before the
    // selection), and the offer is always selected.
    for (let i = 0; i < 8; i++) {
      // Isolate the catalog for this iteration so its offer only matches THIS
      // iteration's skills (the modern rule matches every same-track/grade skill).
      await resetSuiteState()
      const { characterId, offerId } = await seedBaseFixture(`race-${i}`)
      const trackStable = `stable-race-${i}-${runSuffix}`
      const existingSkillId = `sg-skill-existing-race-${i}-${runSuffix}`
      const newSkillId = `sg-skill-new-race-${i}-${runSuffix}`
      await seedSkill(existingSkillId, `existing-race-${i}-${runSuffix}`, {
        track: "class",
        milestone: 4,
        eligibleDefinitionStableIds: [trackStable],
        effects: [],
      })
      await seedSkill(newSkillId, `new-race-${i}-${runSuffix}`, {
        track: "class",
        milestone: 4,
        eligibleDefinitionStableIds: [trackStable],
        effects: [],
      })
      await prisma.skillOffer.update({
        where: { id: offerId },
        data: { trackDefinitionStableId: trackStable },
      })
      await prisma.skillOfferOption.create({
        data: {
          id: `sg-opt-existing-race-${i}-${runSuffix}`,
          offerId,
          definitionId: existingSkillId,
          nameSnapshot: "Existing",
          configSnapshot: {},
        },
      })

      const results = await Promise.allSettled([
        refreshPendingSkillOffers(characterId, ownerUser),
        skillCharacter(
          characterId,
          {
            operation: "select",
            offerId,
            definitionId: existingSkillId,
            version: 0,
          },
          ownerUser
        ),
      ])

      const refresh = results[0]
      if (refresh.status === "rejected") {
        const reason = refresh.reason as { status?: number; code?: string }
        // The refresh may lose the race to the selection; then it is the retryable
        // 409 `serialization_conflict` (the service maps P2034). It must never be a
        // raw 500.
        expect(
          reason.status,
          `refresh rejected with ${reason.code} (got status ${reason.status})`
        ).toBe(409)
      }

      // The selection always wins: the offer is selected, the character version is
      // bumped, and no duplicate option row was ever written for this offer.
      const offer = await prisma.skillOffer.findUnique({
        where: { id: offerId },
      })
      expect(offer?.selectedDefinitionId).toBe(existingSkillId)
      const optionCount = await prisma.skillOfferOption.count({
        where: { offerId },
      })
      expect([1, 2]).toContain(optionCount)
    }
  })
})
