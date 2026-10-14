/**
 * Real-Postgres integration tests for monster (race-only) creation/advance and
 * manual Dungeon Pioneer rank claims.
 *
 * Exercises the service layer against a live database:
 *   - A born monster race-only character: create at the race's natural grade with
 *     an independent race mode, empty class/profession tracks and no class.
 *   - Four quarter advances under CAS versioning (track "race"); the first three
 *     level nothing, the fourth levels the race to 1 and snapshots a historical
 *     race award carrying the exact E-grade per-level stats.
 *   - Manual ranked-title claims: a rank 2 appears before rank 1 and is rejected
 *     with no write; rank 1 with a self-report reason succeeds; rank 2 with a
 *     reason succeeds and REPLACES rank 1, and the live status flat bonus is +6,
 *     never the +3 + +6 = +9 a stack would produce.
 *   - An integrated monster variant (uses the optional G grade definition) and an
 *     archived prior rank that still counts for rank progression.
 *
 * Runs ONLY when explicitly opted in (see `resolveDbIntegration`): an ordinary
 * `pnpm test` skips this file, and an opted-in run performs no broad delete by
 * stableId. Every catalog stableId, the title improvement seriesId and the user
 * email are run-suffixed with a fresh `randomUUID`, so nothing that pre-exists in
 * the database is touched or overwritten. `afterAll` deletes exactly the rows this
 * run created (characters first, then catalog definitions, then the user), never a
 * `deleteMany` on a fixed (kind, stableId) pair or email pattern.
 */

import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { prisma } from "@/lib/db/client"
import {
  advanceCharacter,
  associateCharacter,
  createCharacter,
  deserializeState,
} from "@/lib/db/service"
import { resolveDbIntegration } from "@/lib/test/db-integration"

const gate = await resolveDbIntegration()

describe.skipIf(!gate.run)(
  "monster race-only creation/advance and Dungeon Pioneer rank claims (real PG)",
  () => {
    // Run-specific suffix. Reusing a fixed stableId / seriesId / email would
    // collide with (or overwrite) pre-existing catalog rows or a prior run's
    // leftover; a fresh random suffix guarantees collision-free keys so the run
    // only ever touches what it created.
    const runSuffix = randomUUID()

    const raceStableId = `pg-monster-race__${runSuffix}`
    const raceDefEId = `${raceStableId}:E`
    const raceDefGId = `${raceStableId}:G`

    // Dungeon Pioneer ranks 1/2 share one improvement series (same upgradeGroup).
    const dpSeriesId = `pg-dungeon-pioneer__${runSuffix}`
    const dp1StableId = `${dpSeriesId}__rank1`
    const dp2StableId = `${dpSeriesId}__rank2`

    // A separate series for the "archived prior rank" test so it never mutates
    // the shared rank1/rank2 rows the main flow uses.
    const archSeriesId = `pg-dungeon-pioneer-arch__${runSuffix}`
    const arch1StableId = `${archSeriesId}__rank1`
    const arch2StableId = `${archSeriesId}__rank2`

    // Every id THIS run creates; afterAll deletes exactly these rows in FK-safe
    // order (characters cascade to links/events, then catalog, then user).
    const createdCharacterIds: string[] = []
    const createdCatalogIds: string[] = []
    const createdUserIds: string[] = []

    let user: { id: string; email: string; isAdmin: boolean }
    let raceId: string
    let dp1Id: string
    let dp2Id: string
    let arch1Id: string
    let arch2Id: string

    /** A full attribute vector with every attribute set to the same value. */
    function allEqual(n: number): Record<string, number> {
      const out: Record<string, number> = {}
      const keys = [
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
      for (const k of keys) out[k] = n
      return out
    }

    /** The "flat" phase delta for an attribute from a status trace. */
    function flatDelta(status: unknown, attribute: string): number | undefined {
      const phases = (
        status as {
          traces?: Array<{
            attribute: string
            phases: Array<{ phase: string; delta: number }>
          }>
        }
      ).traces?.find((t) => t.attribute === attribute)?.phases
      return phases?.find((p) => p.phase === "flat")?.delta
    }

    beforeAll(async () => {
      // Test-created NON-admin user. The email is unique per run.
      const userId = randomUUID()
      const email = `monster-title-${runSuffix}@test.local`
      const createdUser = await prisma.user.create({
        data: {
          id: userId,
          email,
          password: "x",
          isAdmin: false,
          disabled: false,
          sessionVersion: 0,
        },
      })
      createdUserIds.push(userId)
      user = { id: createdUser.id, email, isAdmin: false }

      // Monster race catalog row: raceType monster, natural grade E, an E-grade
      // per-level definition with nonzero fixed/free, plus an optional G-grade
      // definition for the integrated-origin variant.
      const race = await prisma.catalogDefinition.create({
        data: {
          kind: "races",
          stableId: raceStableId,
          name: "Cave Crawler",
          grade: "E",

          config: {
            raceType: "monster",
            naturalGrade: "E",
            raceDefinitions: {
              E: { id: raceDefEId, perLevel: allEqual(2), freePerLevel: 5 },
              G: { id: raceDefGId, perLevel: allEqual(1), freePerLevel: 3 },
            },
          },
        },
      })
      createdCatalogIds.push(race.id)
      raceId = race.id

      // Dungeon Pioneer rank 1 and rank 2 titles. Both occupy the SAME upgrade
      // group (== improvement.seriesId, required by the ranked-title superRefine),
      // grade E, and flat all-attrs +3 / +6. minRaceGrade E matches the born
      // monster's E grade so the rank gate never blocks on grade.
      const dp1 = await prisma.catalogDefinition.create({
        data: {
          kind: "titles",
          stableId: dp1StableId,
          name: "Dungeon Pioneer I",
          grade: "E",

          config: {
            grade: "E",
            flat: allEqual(3),
            upgradeGroup: dpSeriesId,
            improvement: { seriesId: dpSeriesId, rank: 1, minRaceGrade: "E" },
          },
        },
      })
      createdCatalogIds.push(dp1.id)
      dp1Id = dp1.id

      const dp2 = await prisma.catalogDefinition.create({
        data: {
          kind: "titles",
          stableId: dp2StableId,
          name: "Dungeon Pioneer II",
          grade: "E",

          config: {
            grade: "E",
            flat: allEqual(6),
            upgradeGroup: dpSeriesId,
            improvement: { seriesId: dpSeriesId, rank: 2, minRaceGrade: "E" },
          },
        },
      })
      createdCatalogIds.push(dp2.id)
      dp2Id = dp2.id

      // A second rank 1/rank 2 pair for the archived-prior test (isolated series).
      const arch1 = await prisma.catalogDefinition.create({
        data: {
          kind: "titles",
          stableId: arch1StableId,
          name: "Dungeon Pioneer Arch I",
          grade: "E",

          config: {
            grade: "E",
            flat: allEqual(3),
            upgradeGroup: archSeriesId,
            improvement: {
              seriesId: archSeriesId,
              rank: 1,
              minRaceGrade: "E",
            },
          },
        },
      })
      createdCatalogIds.push(arch1.id)
      arch1Id = arch1.id

      const arch2 = await prisma.catalogDefinition.create({
        data: {
          kind: "titles",
          stableId: arch2StableId,
          name: "Dungeon Pioneer Arch II",
          grade: "E",

          config: {
            grade: "E",
            flat: allEqual(6),
            upgradeGroup: archSeriesId,
            improvement: {
              seriesId: archSeriesId,
              rank: 2,
              minRaceGrade: "E",
            },
          },
        },
      })
      createdCatalogIds.push(arch2.id)
      arch2Id = arch2.id
    })

    afterAll(async () => {
      // Characters first: deleting a character cascades to its associations
      // (links), progression events, inventory and skill offers, so no catalog
      // definition is still referenced (the association / inventory / offer FKs
      // are RESTRICT) when the catalog rows are deleted next.
      if (createdCharacterIds.length > 0) {
        await prisma.character.deleteMany({
          where: { id: { in: createdCharacterIds } },
        })
      }
      // Catalog definitions: delete exactly the rows this run created. The
      // `patron`-style Restrict FKs do not apply here (no gods/blessings), but the
      // automatic SetNull character FK is moot because characters are already gone.
      if (createdCatalogIds.length > 0) {
        await prisma.catalogDefinition.deleteMany({
          where: { id: { in: createdCatalogIds } },
        })
      }
      // The test user last; nothing references it once characters are gone.
      if (createdUserIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
      }
    })

    it("creates a born monster race-only character, advances to race level 1 via four CAS advances, then claims Dungeon Pioneer ranks 1 and 2", async () => {
      const created = await createCharacter(
        {
          name: "Born Crawler",
          origin: "born",
          raceId,
          classId: null,
          professionId: null,
        },
        user
      )
      createdCharacterIds.push(created.id)

      const createdState = deserializeState(created.state)
      // Monster race mode is independent (race-only), no class/profession tracks.
      expect(createdState.race.mode).toBe("independent")
      expect(createdState.race.grade).toBe("E")
      expect(createdState.race.level).toBe(0)
      expect(createdState.race.quarter).toBe(0)
      expect(createdState.tracks).toEqual({})
      expect(created.classId).toBeNull()
      expect(created.professionId).toBeNull()

      // Four POST-equivalent service advance calls under CAS: each must present
      // the current version and bump it exactly once.
      let version = created.version // 0 after create
      for (let i = 1; i <= 3; i++) {
        const res = await advanceCharacter(
          created.id,
          { track: "race", version },
          user
        )
        version = res.character.version
        expect(version).toBe(i) // 1, 2, 3
        const journal = res.journal as { leveledUp?: boolean }
        expect(journal.leveledUp).toBe(false)
        const st = deserializeState(res.character.state)
        expect(st.race.level).toBe(0)
        expect(st.race.quarter).toBe(i)
        // Quarter advances never award anything.
        expect(st.historicalLevelAwards).toEqual([])
      }

      // The fourth quarter levels the race to 1 and snapshots the E-grade award.
      const levelUp = await advanceCharacter(
        created.id,
        { track: "race", version },
        user
      )
      version = levelUp.character.version
      expect(version).toBe(4)
      const levelUpJournal = levelUp.journal as {
        leveledUp?: boolean
        award?: { definitionId: string; free: number }
      }
      expect(levelUpJournal.leveledUp).toBe(true)
      expect(levelUpJournal.award).toMatchObject({
        definitionId: raceDefEId,
        free: 5,
      })
      const st4 = deserializeState(levelUp.character.state)
      expect(st4.race.level).toBe(1)
      expect(st4.race.quarter).toBe(0)
      expect(st4.race.grade).toBe("E")
      expect(st4.historicalLevelAwards).toHaveLength(1)
      const award = st4.historicalLevelAwards[0]
      expect(award.track).toBe("race")
      expect(award.level).toBe(1)
      expect(award.definitionId).toBe(raceDefEId)
      expect(award.fixed).toEqual(allEqual(2))
      expect(award.free).toBe(5)

      // Rank 2 before rank 1: rejected with no write (no link, version unchanged).
      await expect(
        associateCharacter(
          created.id,
          {
            kind: "title",
            definitionId: dp2Id,
            operation: "add",
            version,
            reason: "cleared rank 2",
          },
          user
        )
      ).rejects.toMatchObject({ status: 400, code: "title_rank_conflict" })
      const afterReject = await prisma.character.findUnique({
        where: { id: created.id },
        include: { associations: true },
      })
      expect(afterReject!.version).toBe(version)
      expect(afterReject!.associations).toHaveLength(0)

      // Rank 1 with a self-report reason succeeds.
      const r1 = await associateCharacter(
        created.id,
        {
          kind: "title",
          definitionId: dp1Id,
          operation: "add",
          version,
          reason: "cleared rank 1",
        },
        user
      )
      version = r1.character.version
      expect(version).toBe(5)
      expect(r1.character.associations.map((a) => a.definitionId)).toEqual([
        dp1Id,
      ])
      expect(flatDelta(r1.character.status, "strength")).toBe(3)

      // Rank 2 with a reason succeeds and REPLACES rank 1, so only rank 2 remains
      // linked and the live flat bonus is +6, never the stacked +3 + +6 = +9.
      const r2 = await associateCharacter(
        created.id,
        {
          kind: "title",
          definitionId: dp2Id,
          operation: "add",
          version,
          reason: "cleared rank 2",
        },
        user
      )
      expect(r2.character.version).toBe(6)
      expect(r2.character.associations).toHaveLength(1)
      expect(r2.character.associations.map((a) => a.definitionId)).toEqual([
        dp2Id,
      ])
      expect(flatDelta(r2.character.status, "strength")).toBe(6)
      // Explicitly guard against a stacking bug: +6, not +9.
      expect(flatDelta(r2.character.status, "agility")).toBe(6)
      expect(flatDelta(r2.character.status, "willpower")).toBe(6)
    })

    it("creates an integrated monster at race grade G on the independent race-only track", async () => {
      const created = await createCharacter(
        {
          name: "Integrated Crawler",
          origin: "integrated",
          raceId,
          classId: null,
          professionId: null,
        },
        user
      )
      createdCharacterIds.push(created.id)

      const st = deserializeState(created.state)
      // Integrated origin enters at G (the optional G definition), still race-only.
      expect(st.race.mode).toBe("independent")
      expect(st.race.grade).toBe("G")
      expect(st.race.level).toBe(0)
      expect(st.tracks).toEqual({})
    })

    it("counts an archived prior rank link for rank progression (rank 2 allowed after rank 1 is archived)", async () => {
      const created = await createCharacter(
        {
          name: "Archived Prior Crawler",
          origin: "born",
          raceId,
          classId: null,
          professionId: null,
        },
        user
      )
      createdCharacterIds.push(created.id)

      let version = created.version
      await associateCharacter(
        created.id,
        {
          kind: "title",
          definitionId: arch1Id,
          operation: "add",
          version,
          reason: "cleared arch rank 1",
        },
        user
      )
      version += 1

      // Archive the rank-1 catalog row; the character link stays, and it must
      // still count as the required prior for rank 2.
      await prisma.catalogDefinition.update({
        where: { id: arch1Id },
        data: { archived: true },
      })

      const r2 = await associateCharacter(
        created.id,
        {
          kind: "title",
          definitionId: arch2Id,
          operation: "add",
          version,
          reason: "cleared arch rank 2",
        },
        user
      )
      expect(r2.character.version).toBe(version + 1)
      expect(r2.character.associations.map((a) => a.definitionId)).toEqual([
        arch2Id,
      ])
    })
  }
)
