/**
 * Real-Postgres concurrency tests for the equipment catalog create/update vs
 * god/skill stableId rename race.
 *
 * An equipment config declares `requiredGodStableId` (a divine patron) and/or
 * `grantedSkillStableIds` (equipment-granted passive skills). Those references
 * are validated against the LIVE catalog inside the create/update transaction.
 * A concurrent god/skill stableId rename must not be able to commit in the gap
 * between that ref read and the equipment write, otherwise the created item
 * dangles (an ineligible item or a silently-lost passive).
 *
 * The fix is SERIALIZABLE isolation on BOTH sides:
 *   - equipment create/update (`createCatalogItem` / `updateCatalogItem`) runs
 *     SERIALIZABLE when it validates those refs, and
 *   - the god/skill rename (`updateCatalogItem` for `gods`/`skills`) already runs
 *     SERIALIZABLE.
 * Under SSI the dangerous read-then-write dependency is detected at commit and
 * the loser aborts with P2034, which the service maps to a 409 (never a raw 500)
 * with no partial write. The tests below force that exact interleaving and assert
 * that committed equipment always resolves both refs.
 *
 * Runs ONLY when explicitly opted in (see `resolveDbIntegration`): a normal
 * `pnpm test` skips this file. Cleanup is strictly scoped to the exact row ids
 * this run creates (never by fixed (kind, stableId) pairs, so a pre-existing row
 * is never touched and a concurrent suite never collides).
 */

import { afterAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/db/client"
import { createCatalogItem, updateCatalogItem } from "@/lib/db/service"
import { resolveDbIntegration } from "@/lib/test/db-integration"

const gate = await resolveDbIntegration()

describe.skipIf(!gate.run)("catalog reference concurrency (real PG)", () => {
  const runSuffix = randomUUID()

  // Row ids created by THIS suite only. afterAll deletes exactly these; any row
  // that pre-existed (or a row owned by another task) is never touched.
  const createdIds: string[] = []

  afterAll(async () => {
    if (createdIds.length === 0) return
    await prisma.catalogDefinition.deleteMany({
      where: { id: { in: [...createdIds] } },
    })
  })

  async function seedGod(stableId: string): Promise<string> {
    const row = await prisma.catalogDefinition.create({
      data: { kind: "gods", stableId, name: `God ${stableId}`, config: {} },
    })
    createdIds.push(row.id)
    return row.id
  }

  async function seedSkill(stableId: string): Promise<string> {
    const row = await prisma.catalogDefinition.create({
      data: {
        kind: "skills",
        stableId,
        name: `Skill ${stableId}`,
        config: {
          track: "class",
          milestone: 4,
          rarity: "Common",
          effects: [],
        },
      },
    })
    createdIds.push(row.id)
    return row.id
  }

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void
    const promise = new Promise<void>((r) => (resolve = r))
    return { promise, resolve }
  }

  it("SERIALIZABLE aborts an equipment create that read a god the rename then changed (deterministic interleaving)", async () => {
    const godStable = `god-${runSuffix}-forced`
    const equipStable = `equip-${runSuffix}-forced`
    const godId = await seedGod(godStable)

    // The equipment-create critical section, held open behind a barrier so we
    // fully control the interleaving. It reads the live god ref, then BLOCKS
    // while the rename commits, then attempts its own write. If SERIALIZABLE is
    // not in force on the equipment side, this write would commit a dangling
    // reference; with it, SSI must abort the transaction (P2034).
    const readDone = deferred()
    const proceed = deferred()

    const equipTx = prisma.$transaction(
      async (tx) => {
        // Replicates createCatalogItem's live-ref read (assertEquipmentGodRef).
        const god = await tx.catalogDefinition.findUnique({
          where: { kind_stableId: { kind: "gods", stableId: godStable } },
        })
        readDone.resolve()
        await proceed.promise
        expect(god).not.toBeNull()
        return tx.catalogDefinition.create({
          data: {
            kind: "equipment",
            stableId: equipStable,
            name: "Forced God Gear",
            config: {
              slot: "Head",
              rarity: "Common",
              requiredGodStableId: godStable,
            },
          },
        })
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )

    // Wait until the equipment tx has actually read the god (old stableId).
    await readDone.promise

    // Commit the rename via the real service (also SERIALIZABLE). The god now
    // carries a DIFFERENT stableId.
    const rename = await updateCatalogItem("gods", godId, {
      stableId: `${godStable}-renamed`,
    })
    expect(rename.stableId).toBe(`${godStable}-renamed`)

    // Release the barrier: the equipment tx attempts its insert against a god it
    // read BEFORE the rename. SERIALIZABLE must abort it (P2034), never persist a
    // dangling reference.
    proceed.resolve()

    const outcome = await equipTx.then(
      () => "committed",
      (err: unknown) => {
        expect((err as { code?: string }).code).toBe("P2034")
        return "aborted"
      }
    )
    expect(outcome).toBe("aborted")

    // No dangling equipment row: the reference no longer resolves, so nothing was
    // committed. The god kept its renamed stableId.
    const equip = await prisma.catalogDefinition.findUnique({
      where: { kind_stableId: { kind: "equipment", stableId: equipStable } },
    })
    expect(equip).toBeNull()
    const god = await prisma.catalogDefinition.findUnique({
      where: { id: godId },
    })
    expect(god?.stableId).toBe(`${godStable}-renamed`)
  })

  it("SERIALIZABLE aborts an equipment create that read a skill the rename then changed (deterministic interleaving)", async () => {
    const skillStable = `skill-${runSuffix}-forced`
    const equipStable = `equip-${runSuffix}-skill-forced`
    const skillId = await seedSkill(skillStable)

    const readDone = deferred()
    const proceed = deferred()

    const equipTx = prisma.$transaction(
      async (tx) => {
        // Replicates createCatalogItem's granted-skill validation
        // (assertEquipmentGrantedSkillsRefs): it loads every skill row, which reads
        // the skill being renamed.
        const skill = await tx.catalogDefinition.findUnique({
          where: { kind_stableId: { kind: "skills", stableId: skillStable } },
        })
        readDone.resolve()
        await proceed.promise
        expect(skill).not.toBeNull()
        return tx.catalogDefinition.create({
          data: {
            kind: "equipment",
            stableId: equipStable,
            name: "Forced Skill Gear",
            config: {
              slot: "Head",
              rarity: "Common",
              grantedSkillStableIds: [skillStable],
            },
          },
        })
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    )

    await readDone.promise
    const rename = await updateCatalogItem("skills", skillId, {
      stableId: `${skillStable}-renamed`,
    })
    expect(rename.stableId).toBe(`${skillStable}-renamed`)

    proceed.resolve()
    const outcome = await equipTx.then(
      () => "committed",
      (err: unknown) => {
        expect((err as { code?: string }).code).toBe("P2034")
        return "aborted"
      }
    )
    expect(outcome).toBe("aborted")

    const equip = await prisma.catalogDefinition.findUnique({
      where: { kind_stableId: { kind: "equipment", stableId: equipStable } },
    })
    expect(equip).toBeNull()
    const skill = await prisma.catalogDefinition.findUnique({
      where: { id: skillId },
    })
    expect(skill?.stableId).toBe(`${skillStable}-renamed`)
  })

  it("racing equipment create vs god/skill rename: at most one winner and never a dangling reference", async () => {
    // Run several independent races. Each iteration uses its own god/skill/
    // equipment stableIds so the iterations never interfere. In EVERY iteration,
    // if the equipment create commits, its god and skill refs must still resolve;
    // if it is rejected, the rejection is a 400/409, never a raw 500. This is the
    // invariant that SERIALIZABLE isolation must hold across the race.
    for (let i = 0; i < 25; i++) {
      const godStable = `god-${runSuffix}-race-${i}`
      const skillStable = `skill-${runSuffix}-race-${i}`
      const equipStable = `equip-${runSuffix}-race-${i}`
      const godId = await seedGod(godStable)
      const skillId = await seedSkill(skillStable)

      const results = await Promise.allSettled([
        createCatalogItem("equipment", {
          stableId: equipStable,
          name: `Race Gear ${i}`,
          config: {
            slot: "Head",
            rarity: "Common",
            requiredGodStableId: godStable,
            grantedSkillStableIds: [skillStable],
          },
        }),
        updateCatalogItem("gods", godId, { stableId: `${godStable}-renamed` }),
        updateCatalogItem("skills", skillId, {
          stableId: `${skillStable}-renamed`,
        }),
      ])

      const equipResult = results[0]
      if (equipResult.status === "fulfilled") {
        // The equipment create committed: its refs must still resolve, so neither
        // the god nor the skill rename can have committed alongside it (SSI aborts
        // one side of the race). A committed item that references a renamed-away
        // god/skill is a dangling reference and fails this assertion.
        const god = await prisma.catalogDefinition.findUnique({
          where: { kind_stableId: { kind: "gods", stableId: godStable } },
        })
        const skill = await prisma.catalogDefinition.findUnique({
          where: { kind_stableId: { kind: "skills", stableId: skillStable } },
        })
        expect(god, `god ref must not dangle for ${equipStable}`).not.toBeNull()
        expect(
          skill,
          `skill ref must not dangle for ${equipStable}`
        ).not.toBeNull()
        createdIds.push(equipResult.value.id)
      } else {
        const reason = equipResult.reason as { status?: number; code?: string }
        // The equipment create may be rejected because (a) the god or skill was
        // renamed away before its ref read (400 invalid_config), (b) SSI aborted it
        // because the rename committed between its read and write (409
        // catalog_serialization_conflict), or (c) the stableId collided (409
        // catalog_stable_id_conflict). It must never surface as a raw 500.
        expect(
          reason.status,
          `equipment create rejected with ${reason.code} (got status ${reason.status})`
        ).not.toBe(500)
        expect([400, 409]).toContain(reason.status)
      }
    }
  })
})
