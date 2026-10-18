/**
 * Real-Postgres integration tests for `createSkillUpgradeVariant` atomic
 * behavior (the admin skill variant clone path in `lib/db/service.ts`).
 *
 * The unit/mock suite (`service.test.ts`) exercises this function against an
 * in-memory catalog store. Those tests cannot see the actual SERIALIZABLE
 * transaction boundary, the catalog_definitions row durability, the JSON
 * round-trip of a deeply nested `config` (including unknown nested metadata
 * inside an `effect` and an `effect.condition`, which Zod strips on parse but
 * the clone must persist verbatim), or the DB-level unique constraint on
 * `(kind, stableId)`. This suite drives the REAL Prisma client against a live
 * Postgres database to pin those atomic guarantees:
 *
 *   - Inferior -> Common then Common -> Uncommon clones persist exactly one
 *     chain, each clone terminal (`upgradeToStableIds: []`), linking its
 *     immediate predecessor and copying the source's full RAW config (effects,
 *     conditions, unknown nested metadata) verbatim.
 *   - A duplicate derived slug (name + rarity) is a 409
 *     `catalog_stable_id_conflict` and leaves the pre-existing row count and
 *     the source link untouched (the whole transaction rolls back).
 *   - An archived source is a 400 `skill_archived` and writes nothing.
 *
 * Runs ONLY when explicitly opted in (see `resolveDbIntegration`): a normal
 * `pnpm test` skips this file. Cleanup is strictly scoped to the exact row ids
 * this run creates (never by fixed (kind, stableId) pairs or a hardcoded
 * prefix), so a pre-existing row is never touched and a concurrent suite never
 * collides. Every stableId and the source name are suffixed with a per-run
 * token, so a second run against a shared database never collides either.
 */

import { afterAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import type { CatalogDefinition } from "@prisma/client"
import { prisma } from "@/lib/db/client"
import { createSkillUpgradeVariant } from "@/lib/db/service"
import { resolveDbIntegration } from "@/lib/test/db-integration"

const gate = await resolveDbIntegration()

describe.skipIf(!gate.run)("createSkillUpgradeVariant (real PG)", () => {
  // Per-run token so no stableId is ever assumed unique across runs.
  const runSuffix = randomUUID().slice(0, 8)

  const className = `Stealth Test Class ${runSuffix}`
  const classStable = `stealth-class-${runSuffix}`
  const name = `Basic Stealth ${runSuffix}`
  const sourceStable = `basic-stealth-${runSuffix}-inferior`
  const commonStable = `basic-stealth-${runSuffix}-common`
  const uncommonStable = `basic-stealth-${runSuffix}-uncommon`
  const rareStable = `basic-stealth-${runSuffix}-rare`
  // Every skill this run owns shares this stableId prefix.
  const skillPrefix = `basic-stealth-${runSuffix}-`
  // A stableId that must belong to NO skill so an archive/duplicate path never
  // 409-collides before it can raise the intended 400.
  const unrelatedStable = `stealth-unrelated-${runSuffix}`

  // Row ids created by THIS suite only. afterAll deletes exactly these; any row
  // that pre-existed (or a row owned by another task) is never touched.
  const createdIds: string[] = []

  let sourceId = ""

  afterAll(async () => {
    if (createdIds.length === 0) return
    await prisma.catalogDefinition.deleteMany({
      where: { id: { in: [...createdIds] } },
    })
  })

  async function seedActiveClass(): Promise<string> {
    const row = await prisma.catalogDefinition.create({
      data: {
        kind: "classes",
        stableId: classStable,
        name: className,
        config: {},
        description: null,
        sourceUrl: null,
        archived: false,
      },
    })
    createdIds.push(row.id)
    return row.id
  }

  async function countOwnSkills(): Promise<number> {
    return prisma.catalogDefinition.count({
      where: { kind: "skills", stableId: { startsWith: skillPrefix } },
    })
  }

  async function readSkill(
    stableId: string
  ): Promise<CatalogDefinition | null> {
    return prisma.catalogDefinition.findUnique({
      where: { kind_stableId: { kind: "skills", stableId } },
    })
  }

  it("clones an active Inferior class-track skill to Common then Uncommon, linking a terminal chain and copying full raw config", async () => {
    await seedActiveClass()

    // A valid class-track skill config. The effects declare custom metadata at
    // the root, inside an effect, and inside an effect's condition - all shapes
    // that Zod's `skillConfigSchema` STRIPS when it parses, but which the clone
    // must persist verbatim from the RAW source config.
    const effects = [
      {
        phase: "flat",
        condition: {
          kind: "levelAtLeast",
          track: "class",
          level: 5,
          customConditionMeta: { note: "after-5", flags: ["a", "b"] },
        },
        amount: { agility: 3 },
        stacking: "stack",
        customEffectMeta: { flavor: "sneak", tags: ["stealth", "flat"] },
      },
      {
        phase: "percent",
        condition: { kind: "always" },
        basisPoints: { agility: 500 },
        stacking: "replace",
        group: "g1",
        customEffectMeta: { flavor: "evasive", note: "pct" },
      },
    ]
    const sourceConfig = {
      track: "class",
      rarity: "Inferior",
      classStableId: classStable,
      effects,
      unknownMetadata: { hide: true },
      customRoot: { deep: { value: 42 } },
    }

    const source = await prisma.catalogDefinition.create({
      data: {
        kind: "skills",
        stableId: sourceStable,
        name,
        description: "Sneak silently",
        sourceUrl: `https://example.com/basic-stealth-${runSuffix}`,
        grade: null,
        gradeDescriptions: {},
        config: sourceConfig,
        archived: false,
      },
    })
    sourceId = source.id
    createdIds.push(source.id)

    // Inferior -> Common.
    const first = await createSkillUpgradeVariant(sourceId, {
      rarity: "Common",
    })
    const cloneId = first.item.id
    createdIds.push(cloneId)

    const persistedCommon = await readSkill(commonStable)
    expect(persistedCommon).not.toBeNull()
    const common = persistedCommon!
    // Identity copied from the source.
    expect(common.name).toBe(name)
    expect(common.description).toBe("Sneak silently")
    expect(common.sourceUrl).toBe(
      `https://example.com/basic-stealth-${runSuffix}`
    )
    // A skills entry carries no catalog grade band.
    expect(common.grade).toBeNull()
    expect(common.gradeDescriptions).toEqual({})
    // The clone requests the target rarity and is terminal.
    expect((common.config as Record<string, unknown>).rarity).toBe("Common")
    expect(
      (common.config as Record<string, unknown>).upgradeToStableIds
    ).toEqual([])
    // The clone persists the DEEP RAW source config, so every unknown nested
    // key that Zod strips on parse survives exactly.
    const commonConfig = common.config as Record<string, unknown>
    expect(commonConfig.effects).toEqual(effects)
    expect(commonConfig.track).toBe("class")
    expect(commonConfig.classStableId).toBe(classStable)
    expect(commonConfig.unknownMetadata).toEqual({ hide: true })
    expect(commonConfig.customRoot).toEqual({ deep: { value: 42 } })
    // The effects array is a distinct deep clone, never the source's identity.
    expect(commonConfig.effects).not.toBe(effects)

    // The source is now linked to the clone as its DIRECT successor.
    const persistedSource = await readSkill(sourceStable)
    expect(persistedSource).not.toBeNull()
    const sourceRow = persistedSource!
    expect(
      (sourceRow.config as Record<string, unknown>).upgradeToStableIds
    ).toEqual([commonStable])
    expect((sourceRow.config as Record<string, unknown>).rarity).toBe(
      "Inferior"
    )

    // Common -> Uncommon. The Common clone is explicitly terminal
    // (`upgradeToStableIds: []`), so cloning it appends to that empty explicit
    // list; the source row itself is never touched again.
    const second = await createSkillUpgradeVariant(cloneId, {
      rarity: "Uncommon",
    })
    const uncommonCloneId = second.item.id
    createdIds.push(uncommonCloneId)

    const persistedUncommon = await readSkill(uncommonStable)
    expect(persistedUncommon).not.toBeNull()
    const uncommon = persistedUncommon!
    expect(uncommon.name).toBe(name)
    expect(uncommon.grade).toBeNull()
    expect((uncommon.config as Record<string, unknown>).rarity).toBe("Uncommon")
    expect(
      (uncommon.config as Record<string, unknown>).upgradeToStableIds
    ).toEqual([])
    // The deep-copied nested metadata survives a second chained clone.
    expect((uncommon.config as Record<string, unknown>).effects).toEqual(
      effects
    )
    expect(
      (uncommon.config as Record<string, unknown>).unknownMetadata
    ).toEqual({ hide: true })
    expect((uncommon.config as Record<string, unknown>).customRoot).toEqual({
      deep: { value: 42 },
    })

    // The Common clone (now terminal) was relinked to the Uncommon clone, and
    // only the direct predecessor gains an outgoing edge.
    const persistedCommonAfter = await readSkill(commonStable)
    expect(persistedCommonAfter).not.toBeNull()
    expect(
      (persistedCommonAfter!.config as Record<string, unknown>)
        .upgradeToStableIds
    ).toEqual([uncommonStable])
    // The original Inferior source still points only at Common.
    const sourceAfter = await readSkill(sourceStable)
    expect(
      (sourceAfter!.config as Record<string, unknown>).upgradeToStableIds
    ).toEqual([commonStable])

    expect(await countOwnSkills()).toBe(3)
  })

  it("returns 409 on a duplicate name+rarity slug and rolls back (no new row, source link unchanged)", async () => {
    // `basic-stealth-<suffix>-common` already exists from the first test.
    await expect(
      createSkillUpgradeVariant(sourceId, { rarity: "Common" })
    ).rejects.toMatchObject({
      status: 409,
      code: "catalog_stable_id_conflict",
    })

    // The transaction rolled back: no new skill row, and the source's outgoing
    // edge still points only at the already-existing Common clone.
    expect(await countOwnSkills()).toBe(3)
    const source = await readSkill(sourceStable)
    expect(source).not.toBeNull()
    expect(
      (source!.config as Record<string, unknown>).upgradeToStableIds
    ).toEqual([commonStable])
  })

  it("rejects an archived source with 400 skill_archived and writes nothing", async () => {
    // Archive the Inferior source.
    await prisma.catalogDefinition.update({
      where: { id: sourceId },
      data: { archived: true },
    })

    // The derived slug (`basic-stealth-<suffix>-rare`) is free, so the
    // duplicate guard passes; the archived-source guard must still reject.
    expect(await readSkill(rareStable)).toBeNull()

    await expect(
      createSkillUpgradeVariant(sourceId, { rarity: "Rare" })
    ).rejects.toMatchObject({ status: 400, code: "skill_archived" })

    // Nothing was written: still three skills, and no `-rare` row appeared.
    expect(await countOwnSkills()).toBe(3)
    expect(await readSkill(rareStable)).toBeNull()
    // The unrelated slug the clone never used remains absent too.
    expect(await readSkill(unrelatedStable)).toBeNull()
  })
})
