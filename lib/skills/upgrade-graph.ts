/**
 * Pure, dependency-free helpers for the skill upgrade graph.
 *
 * A skill's catalog config may carry an optional `upgradeToStableIds` array: the
 * DIRECT outgoing target skill stableIds that the skill upgrades into. This is
 * distinct from the legacy `upgradeGroup` + `rarity` fallback:
 *
 *   - `upgradeToStableIds` ABSENT  -> legacy fallback (the runtime orders the
 *     skill's `upgradeGroup` by rarity to derive a successor).
 *   - `upgradeToStableIds: []`      -> explicitly terminal (no successor at all,
 *     no fallback).
 *   - `upgradeToStableIds: [id..]`  -> explicit successor targets (a skill may
 *     branch to several).
 *
 * These helpers validate only the local shape plus the cross-node graph. They
 * never read a database, never mutate the input nodes, and deliberately ignore
 * rarity/track: an edge to a same-rarity, lower-rarity, `Unique` or cross-track
 * target is allowed. The service layer invokes them later; this module does not
 * change runtime behavior. See also `lib/server/schemas.ts` (`skillConfigSchema`)
 * for the local-shape validation of a single config.
 */

export interface SkillUpgradeNode {
  stableId: string
  archived: boolean
  /**
   * Optional. A caller that omits `config` (leaves it `undefined`) on a proposed
   * node in a batch must already rely on the persisted config; the batch
   * validator falls back to the matching existing node's config in that case.
   */
  config?: unknown
}

/**
 * Extract a skill config's explicit outgoing successor stableIds.
 *
 * Returns `undefined` when the config has NO own `upgradeToStableIds` field
 * (the legacy `upgradeGroup` + `rarity` fallback applies; no explicit edges).
 * Returns `[]` when the config OWNS the field (even an empty one), so an
 * explicitly-terminal skill is distinguishable from an absent fallback.
 *
 * Defensive: a malformed (non-array) or non-string / empty-string entry is never
 * surfaced; nonempty strings only are returned. Never reads the database.
 */
export function skillUpgradeTargets(config: unknown): string[] | undefined {
  if (config == null || typeof config !== "object") return undefined
  const record = config as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(record, "upgradeToStableIds"))
    return undefined
  const value = record["upgradeToStableIds"]
  if (!Array.isArray(value)) return []
  return value.filter(
    (id): id is string => typeof id === "string" && id.length > 0
  )
}

/**
 * Validate the skill upgrade graph across EVERY node, including archived ones.
 *
 * Detects, in order: duplicate stableIds, a self-link, a target that does not
 * resolve to any node, and a cycle through the explicit-edge graph. Rarity and
 * track never matter here. Returns a human-readable error message (with the
 * offending stableIds, never descriptions) or `null` when the graph is valid.
 *
 * Never mutates the input nodes.
 */
export function validateSkillUpgradeGraph(
  nodes: SkillUpgradeNode[]
): string | null {
  const byId = new Map<string, SkillUpgradeNode>()
  for (const node of nodes) {
    if (byId.has(node.stableId)) {
      return `duplicate stableId "${node.stableId}"`
    }
    byId.set(node.stableId, node)
  }

  const edges = new Map<string, string[]>()
  for (const node of nodes) {
    const targets = skillUpgradeTargets(node.config)
    if (targets == null) continue
    edges.set(node.stableId, targets)
  }

  for (const node of nodes) {
    const targets = edges.get(node.stableId) ?? []
    for (const target of targets) {
      if (target === node.stableId) {
        return `skill "${node.stableId}" lists itself in upgradeToStableIds`
      }
      if (!byId.has(target)) {
        return `skill "${node.stableId}" upgrades to missing stableId "${target}"`
      }
    }
  }

  // Cycle detection over explicit edges (including archived nodes). WHITE =
  // unvisited, GRAY = on the current recursion path, BLACK = fully explored.
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  const stack: string[] = []

  const dfs = (u: string): string | null => {
    color.set(u, GRAY)
    stack.push(u)
    for (const v of edges.get(u) ?? []) {
      if (!byId.has(v)) continue
      const c = color.get(v) ?? WHITE
      if (c === WHITE) {
        const result = dfs(v)
        if (result != null) return result
      } else if (c === GRAY) {
        const idx = stack.indexOf(v)
        const cycle = [...stack.slice(idx), v]
        return `cycle detected: ${cycle.join(" -> ")}`
      }
    }
    stack.pop()
    color.set(u, BLACK)
    return null
  }

  for (const node of nodes) {
    if ((color.get(node.stableId) ?? WHITE) === WHITE) {
      const result = dfs(node.stableId)
      if (result != null) return result
    }
  }

  return null
}

/**
 * Validate an atomic batch of skill writes against the persisted catalog by
 * checking ONLY the FINAL superimposed skill-upgrade graph, not any interim
 * state. This is the pure validation primitive shared by importer / MCP writes;
 * it never reads a database and never mutates either input array.
 *
 * `existingNodes` is the persisted skill set (archived included). `proposedNodes`
 * is the batch: each proposed row is keyed by stableId and OVERLAYS its persisted
 * namesake. A proposed row whose `config` is omitted (`undefined`) keeps the
 * persisted config; a batch that touches nothing but `archived` is therefore a
 * no-op on edges. Rejects, in deterministic order:
 *
 *   1. a duplicate proposed stableId;
 *   2. any structural defect of the FULL final graph (duplicate persisted
 *      stableId, self-link, missing or wrong-kind target, cycle) - archived and
 *      existing nodes included, checked with `validateSkillUpgradeGraph`;
 *   3. a NEW or changed outgoing edge of a proposed node that targets an ARCHIVED
 *      final node.
 *
 * For step 3 the "new/changed" set is the difference between the proposed node's
 * final outgoing target list and the persisted node's OWN prior outgoing list
 * (every target for a brand-new row). An unchanged reference to an archived
 * target stays allowed - including when the batch itself archives that target
 * (the archive-service path) - and archived rows may stay in the graph to provide
 * historical references. Only a newly added edge to an archived target is
 * rejected. Rarity and track never matter (same, lower, `Unique`, cross-track
 * are all allowed). Error strings carry the offending stableIds, never config
 * bodies. Returns `null` when the batch is valid.
 */
export function validateSkillUpgradeBatch(
  existingNodes: SkillUpgradeNode[],
  proposedNodes: SkillUpgradeNode[]
): string | null {
  const proposedById = new Map<string, SkillUpgradeNode>()
  for (const node of proposedNodes) {
    if (proposedById.has(node.stableId)) {
      return `duplicate proposed stableId "${node.stableId}"`
    }
    proposedById.set(node.stableId, node)
  }

  const existingById = new Map<string, SkillUpgradeNode>()
  for (const node of existingNodes) {
    if (existingById.has(node.stableId)) {
      return `duplicate stableId "${node.stableId}"`
    }
    existingById.set(node.stableId, node)
  }

  // Build the FULL final node set: every persisted node, with any proposed row
  // replacing its namesake (config falls back to the persisted config when the
  // caller omits it), plus every proposed row that creates a brand-new node.
  const finalNodes: SkillUpgradeNode[] = []
  for (const node of existingNodes) {
    const proposed = proposedById.get(node.stableId)
    if (proposed) {
      finalNodes.push({
        stableId: proposed.stableId,
        archived: proposed.archived,
        config: proposed.config !== undefined ? proposed.config : node.config,
      })
    } else {
      finalNodes.push(node)
    }
  }
  for (const proposed of proposedNodes) {
    if (existingById.has(proposed.stableId)) continue
    finalNodes.push({
      stableId: proposed.stableId,
      archived: proposed.archived,
      config: proposed.config,
    })
  }

  const finalById = new Map<string, SkillUpgradeNode>()
  for (const node of finalNodes) finalById.set(node.stableId, node)

  const graphError = validateSkillUpgradeGraph(finalNodes)
  if (graphError != null) return graphError

  for (const proposed of proposedNodes) {
    const persisted = existingById.get(proposed.stableId)
    const finalNode = finalById.get(proposed.stableId)
    if (!finalNode) continue
    const currentTargets = skillUpgradeTargets(finalNode.config) ?? []
    const previousTargets = persisted
      ? (skillUpgradeTargets(persisted.config) ?? [])
      : []
    const newTargets = currentTargets.filter(
      (target) => !previousTargets.includes(target)
    )
    for (const target of newTargets) {
      const targetNode = finalById.get(target)
      if (targetNode && targetNode.archived) {
        return `skill "${proposed.stableId}" upgrades to archived skill "${target}"`
      }
    }
  }

  return null
}

/**
 * Group every node into a weakly connected component of the explicit-edge graph.
 *
 * Each component is an array of stableIds (no ordering is imposed - this is a
 * diagnostic helper, not a UI/display decision). Nodes with no explicit edges
 * become singleton components. Archived and active nodes are treated equally.
 * Returns components in first-encountered node order.
 */
export function skillUpgradeComponents(nodes: SkillUpgradeNode[]): string[][] {
  const byId = new Map<string, true>()
  for (const node of nodes) byId.set(node.stableId, true)

  const undirected = new Map<string, Set<string>>()
  for (const node of nodes) undirected.set(node.stableId, new Set<string>())
  for (const node of nodes) {
    const targets = skillUpgradeTargets(node.config) ?? []
    for (const target of targets) {
      if (!byId.has(target)) continue
      undirected.get(node.stableId)!.add(target)
      undirected.get(target)!.add(node.stableId)
    }
  }

  const visited = new Set<string>()
  const components: string[][] = []
  for (const node of nodes) {
    if (visited.has(node.stableId)) continue
    const component: string[] = []
    const queue: string[] = [node.stableId]
    visited.add(node.stableId)
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i]
      component.push(current)
      for (const neighbor of undirected.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor)
          queue.push(neighbor)
        }
      }
    }
    components.push(component)
  }
  return components
}
