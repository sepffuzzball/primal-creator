import { describe, expect, it } from "vitest"
import {
  skillUpgradeComponents,
  skillUpgradeTargets,
  validateSkillUpgradeBatch,
  validateSkillUpgradeGraph,
  type SkillUpgradeNode,
} from "@/lib/skills/upgrade-graph"

const node = (
  stableId: string,
  config: unknown,
  archived = false
): SkillUpgradeNode => ({ stableId, config, archived })

describe("skillUpgradeTargets (defensive extraction)", () => {
  it("returns undefined when the config has no own upgradeToStableIds field", () => {
    expect(skillUpgradeTargets({})).toBeUndefined()
    expect(skillUpgradeTargets({ track: "class" })).toBeUndefined()
  })

  it("returns undefined for a null or non-object config", () => {
    expect(skillUpgradeTargets(null)).toBeUndefined()
    expect(skillUpgradeTargets(undefined)).toBeUndefined()
    expect(skillUpgradeTargets("not-a-config")).toBeUndefined()
  })

  it("returns [] for an OWN empty list (explicitly terminal)", () => {
    expect(skillUpgradeTargets({ upgradeToStableIds: [] })).toEqual([])
  })

  it("returns the nonempty-string targets for an explicit list", () => {
    expect(
      skillUpgradeTargets({ upgradeToStableIds: ["skill-a", "skill-b"] })
    ).toEqual(["skill-a", "skill-b"])
  })

  it("defensively drops non-string and empty-string entries", () => {
    expect(
      skillUpgradeTargets({
        upgradeToStableIds: ["skill-a", "", 42, "skill-b", null],
      })
    ).toEqual(["skill-a", "skill-b"])
  })

  it("treats a present-but-malformed field as []", () => {
    expect(skillUpgradeTargets({ upgradeToStableIds: "skill-a" })).toEqual([])
    expect(skillUpgradeTargets({ upgradeToStableIds: 42 })).toEqual([])
  })

  it("does not read a field inherited from a prototype (own-property only)", () => {
    const legacy = Object.create({ upgradeToStableIds: ["inherited"] })
    expect(skillUpgradeTargets(legacy)).toBeUndefined()
  })
})

describe("validateSkillUpgradeGraph (pure graph validator)", () => {
  it("accepts a branching explicit graph", () => {
    const nodes = [
      node("A", { upgradeToStableIds: ["B", "C"] }),
      node("B", {}),
      node("C", { upgradeToStableIds: ["D"] }),
      node("D", {}),
    ]
    expect(validateSkillUpgradeGraph(nodes)).toBeNull()
  })

  it("accepts a multilevel chain", () => {
    const nodes = [
      node("A", { upgradeToStableIds: ["B"] }),
      node("B", { upgradeToStableIds: ["C"] }),
      node("C", { upgradeToStableIds: ["D"] }),
      node("D", {}),
    ]
    expect(validateSkillUpgradeGraph(nodes)).toBeNull()
  })

  it("accepts a terminal ([]) skill as a target", () => {
    const nodes = [
      node("A", { upgradeToStableIds: ["B"] }),
      node("B", { upgradeToStableIds: [] }),
    ]
    expect(validateSkillUpgradeGraph(nodes)).toBeNull()
  })

  it("accepts an absent-field (legacy fallback) skill as a target", () => {
    const nodes = [node("A", { upgradeToStableIds: ["B"] }), node("B", {})]
    expect(validateSkillUpgradeGraph(nodes)).toBeNull()
  })

  it("keeps edges to an archived node and through archived nodes", () => {
    const nodes = [
      node("A", { upgradeToStableIds: ["B"] }, false),
      node("B", { upgradeToStableIds: ["C"] }, true),
      node("C", {}, true),
    ]
    expect(validateSkillUpgradeGraph(nodes)).toBeNull()
  })

  it("ignores rarity/track entirely (same, lower, Unique, cross-track)", () => {
    const nodes = [
      node("s-unique", {
        rarity: "Unique",
        track: "class",
        upgradeToStableIds: ["s-common"],
      }),
      node("s-common", { rarity: "Common", track: "profession" }),
      node("c-class", {
        rarity: "Rare",
        track: "class",
        upgradeToStableIds: ["p-prof"],
      }),
      node("p-prof", { rarity: "Epic", track: "profession" }),
      node("t-uni", { rarity: "Unique", upgradeToStableIds: ["t-uni2"] }),
      node("t-uni2", { rarity: "Unique" }),
    ]
    expect(validateSkillUpgradeGraph(nodes)).toBeNull()
  })

  it("detects a duplicate stableId", () => {
    const nodes = [node("A", {}), node("A", {})]
    const err = validateSkillUpgradeGraph(nodes)
    expect(err).toContain('duplicate stableId "A"')
  })

  it("detects a self-link", () => {
    const nodes = [node("A", { upgradeToStableIds: ["A"] })]
    const err = validateSkillUpgradeGraph(nodes)
    expect(err).toContain('skill "A" lists itself in upgradeToStableIds')
  })

  it("detects a missing target stableId", () => {
    const nodes = [node("A", { upgradeToStableIds: ["ghost"] })]
    const err = validateSkillUpgradeGraph(nodes)
    expect(err).toContain('skill "A" upgrades to missing stableId "ghost"')
  })

  it("detects a cycle that passes through an existing node", () => {
    const nodes = [
      node("A", { upgradeToStableIds: ["B"] }),
      node("B", { upgradeToStableIds: ["C"] }),
      node("C", { upgradeToStableIds: ["A"] }),
    ]
    const err = validateSkillUpgradeGraph(nodes)
    expect(err).toContain("cycle detected: A -> B -> C -> A")
  })

  it("detects a cycle even when every node is archived", () => {
    const nodes = [
      node("X", { upgradeToStableIds: ["Y"] }, true),
      node("Y", { upgradeToStableIds: ["Z"] }, true),
      node("Z", { upgradeToStableIds: ["X"] }, true),
    ]
    const err = validateSkillUpgradeGraph(nodes)
    expect(err).toContain("cycle detected")
  })

  it("does not mutate the input nodes", () => {
    const nodes = [node("A", { upgradeToStableIds: ["B"] }), node("B", {})]
    const snapshot = JSON.stringify(nodes)
    validateSkillUpgradeGraph(nodes)
    skillUpgradeComponents(nodes)
    expect(JSON.stringify(nodes)).toBe(snapshot)
  })
})

describe("skillUpgradeComponents (diagnostic grouping)", () => {
  it("groups explicitly connected nodes into one component", () => {
    const nodes = [
      node("A", { upgradeToStableIds: ["B", "C"] }),
      node("B", {}),
      node("C", {}),
    ]
    const components = skillUpgradeComponents(nodes)
    expect(components).toHaveLength(1)
    expect(components[0].sort()).toEqual(["A", "B", "C"])
  })

  it("keeps disconnected nodes as own singleton components", () => {
    const nodes = [node("A", {}), node("B", {})]
    const components = skillUpgradeComponents(nodes)
    expect(components).toHaveLength(2)
    expect(components.flat().sort()).toEqual(["A", "B"])
  })
})

describe("validateSkillUpgradeBatch (pure atomic-batch validator)", () => {
  it("accepts a batch that creates a new source toward a new target", () => {
    const existing: SkillUpgradeNode[] = []
    const proposed: SkillUpgradeNode[] = [
      node("new-src", { upgradeToStableIds: ["new-tgt"] }),
      node("new-tgt", {}),
    ]
    expect(validateSkillUpgradeBatch(existing, proposed)).toBeNull()
  })

  it("accepts a reverse-edge edit because the FINAL graph is acyclic", () => {
    // Persisted: A -> B. Batch flips it to B -> A (and A -> terminal). Applying
    // the rows in any interim order would hit A <-> B, but the final graph is
    // acyclic, so the batch is valid.
    const existing: SkillUpgradeNode[] = [
      node("A", { upgradeToStableIds: ["B"] }),
      node("B", {}),
    ]
    const proposed: SkillUpgradeNode[] = [
      node("A", { upgradeToStableIds: [] }),
      node("B", { upgradeToStableIds: ["A"] }),
    ]
    expect(validateSkillUpgradeBatch(existing, proposed)).toBeNull()
  })

  it("rejects a cycle that passes through an existing node", () => {
    const existing: SkillUpgradeNode[] = [
      node("A", { upgradeToStableIds: ["B"] }),
      node("B", { upgradeToStableIds: ["C"] }),
      node("C", {}),
    ]
    const proposed: SkillUpgradeNode[] = [
      node("C", { upgradeToStableIds: ["A"] }),
    ]
    const err = validateSkillUpgradeBatch(existing, proposed)
    expect(err).toContain("cycle detected: A -> B -> C -> A")
  })

  it("rejects a NEW edge to a target absent from the batch (missing / wrong kind)", () => {
    // A stableId that resolves to no skill node in the final graph is treated as
    // missing here. A non-skill catalog row (a wrong-kind stableId) is not in
    // either node set either, so the pure module reports it the same way and the
    // service layer resolves the kind.
    const existing: SkillUpgradeNode[] = [node("A", {})]
    const proposed: SkillUpgradeNode[] = [
      node("A", { upgradeToStableIds: ["ghost"] }),
    ]
    const err = validateSkillUpgradeBatch(existing, proposed)
    expect(err).toContain('skill "A" upgrades to missing stableId "ghost"')
  })

  it("rejects a missing target carried by an UNCHANGED existing node", () => {
    // The full final graph is validated, including persisted rows the batch does
    // not touch - an existing node must still resolve every edge.
    const existing: SkillUpgradeNode[] = [
      node("A", { upgradeToStableIds: ["ghost"] }),
    ]
    const proposed: SkillUpgradeNode[] = [node("B", {})]
    const err = validateSkillUpgradeBatch(existing, proposed)
    expect(err).toContain('skill "A" upgrades to missing stableId "ghost"')
  })

  it("accepts an unchanged reference to a target the batch archives", () => {
    // Archive-service path: only B is proposed (archived, config omitted so the
    // persisted config is kept). A and C are untouched and keep their reference.
    const existing: SkillUpgradeNode[] = [
      node("A", { upgradeToStableIds: ["B"] }),
      node("B", {}),
      node("C", { upgradeToStableIds: ["B"] }),
    ]
    const proposed: SkillUpgradeNode[] = [node("B", {}, true)]
    expect(validateSkillUpgradeBatch(existing, proposed)).toBeNull()
  })

  it("accepts an unchanged reference from a PROPOSED node to an archived target", () => {
    // A is proposed but its edge to B is unchanged, so the new-edge policy does
    // not fire even though B is archived by the same batch.
    const existing: SkillUpgradeNode[] = [
      node("A", { upgradeToStableIds: ["B"] }),
      node("B", {}),
    ]
    const proposed: SkillUpgradeNode[] = [
      node("A", { upgradeToStableIds: ["B"] }),
      node("B", {}, true),
    ]
    expect(validateSkillUpgradeBatch(existing, proposed)).toBeNull()
  })

  it("rejects a NEW edge to an archived target", () => {
    const existing: SkillUpgradeNode[] = [node("A", {}), node("B", {}, true)]
    const proposed: SkillUpgradeNode[] = [
      node("A", { upgradeToStableIds: ["B"] }),
    ]
    const err = validateSkillUpgradeBatch(existing, proposed)
    expect(err).toContain('skill "A" upgrades to archived skill "B"')
  })

  it("rejects a NEW edge to a target archived by the same batch", () => {
    const existing: SkillUpgradeNode[] = [node("A", {}), node("B", {})]
    const proposed: SkillUpgradeNode[] = [
      node("A", { upgradeToStableIds: ["B"] }),
      node("B", {}, true),
    ]
    const err = validateSkillUpgradeBatch(existing, proposed)
    expect(err).toContain('skill "A" upgrades to archived skill "B"')
  })

  it("rejects duplicate proposed stableIds", () => {
    const existing: SkillUpgradeNode[] = []
    const proposed: SkillUpgradeNode[] = [node("A", {}), node("A", {})]
    const err = validateSkillUpgradeBatch(existing, proposed)
    expect(err).toContain('duplicate proposed stableId "A"')
  })

  it("rejects a self-link proposed by the batch", () => {
    const existing: SkillUpgradeNode[] = []
    const proposed: SkillUpgradeNode[] = [
      node("A", { upgradeToStableIds: ["A"] }),
    ]
    const err = validateSkillUpgradeBatch(existing, proposed)
    expect(err).toContain('skill "A" lists itself in upgradeToStableIds')
  })

  it("does not mutate existing or proposed nodes", () => {
    const existing: SkillUpgradeNode[] = [
      node("A", { upgradeToStableIds: ["B"] }),
      node("B", {}),
    ]
    const proposed: SkillUpgradeNode[] = [
      node("A", { upgradeToStableIds: [] }),
      node("B", { upgradeToStableIds: ["A"] }),
    ]
    const existingSnapshot = JSON.stringify(existing)
    const proposedSnapshot = JSON.stringify(proposed)
    expect(validateSkillUpgradeBatch(existing, proposed)).toBeNull()
    expect(JSON.stringify(existing)).toBe(existingSnapshot)
    expect(JSON.stringify(proposed)).toBe(proposedSnapshot)
  })
})
