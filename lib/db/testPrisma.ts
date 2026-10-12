/**
 * A realistic in-memory mock of the Prisma client, built for the service-unit
 * tests that exercise compare-and-swap (CAS) optimistic concurrency without a
 * running Postgres.
 *
 * It faithfully models the semantics the service relies on:
 *   - `character.updateMany({ where: { id, version }, data })` matches 0 rows
 *     when the stored version does not equal `where.version`, and 1 row (and
 *     increments the version) otherwise. This is the only place a **stale** write
 *     can be rejected.
 *   - A `$transaction` callback receives a shared transaction client; throwing
 *     inside it rejects the transaction (the service throws a 409 *before* the
 *     event insert, so a failed CAS never writes an event).
 *   - `character.findUnique({ include })` attaches the `race` / `class` /
 *     `profession` catalog relations, matching `characterInclude` in
 *     `lib/db/service.ts`.
 *
 * It is deliberately NOT a full Prisma simulator - only the query shapes the
 * service uses are implemented. Use `store` to seed catalog entries and
 * characters, and to assert on the resulting rows/events.
 */

export interface TestCatalogRow {
  id: string
  kind: string
  stableId: string
  name: string
  config: Record<string, unknown>
  description?: string | null
  grade?: string | null
  provenance?: string
  sourceUrl?: string | null
  archived?: boolean
  createdAt: Date
  updatedAt: Date
}

export interface TestAssociationRow {
  id: string
  characterId: string
  definitionId: string
  kind: "TITLE" | "EQUIPMENT"
  createdAt: Date
  // Relation, only set on the object returned by findUnique/create.
  definition?: TestCatalogRow | null
}

export interface TestCharacterRow {
  id: string
  ownerId: string
  name: string
  description: string | null
  origin: string
  raceId: string | null
  classId: string | null
  professionId: string | null
  state: unknown
  version: number
  archived: boolean
  createdAt: Date
  updatedAt: Date
  // Relations, only set on the object returned by findUnique/create.
  race?: TestCatalogRow | null
  class?: TestCatalogRow | null
  profession?: TestCatalogRow | null
  associations?: TestAssociationRow[]
}

export interface TestEventRow {
  id: string
  characterId: string
  kind: string
  payload: unknown
  createdAt: Date
}

export interface TestPrismaInstance {
  prisma: {
    $transaction: (
      cb: (tx: Transaction) => Promise<unknown>
    ) => Promise<unknown>
    catalogDefinition: {
      findUnique: (args: {
        where: { id: string }
      }) => Promise<TestCatalogRow | null>
      update: (args: {
        where: { id: string }
        data: Record<string, unknown>
      }) => Promise<TestCatalogRow>
    }
    character: {
      findUnique: (args: {
        where: { id: string }
        include?: unknown
      }) => Promise<TestCharacterRow | null>
      create: (args: {
        data: Record<string, unknown>
        include?: unknown
      }) => Promise<TestCharacterRow>
    }
    characterAssociation: {
      create: (args: {
        data: Record<string, unknown>
      }) => Promise<TestAssociationRow>
      deleteMany: (args: {
        where: { characterId: string; definitionId: string }
      }) => Promise<{ count: number }>
      findMany: (args: {
        where?: {
          definitionId?: string
          characterId?: string
        }
        include?: unknown
      }) => Promise<
        Array<TestAssociationRow & { character?: TestCharacterRow }>
      >
    }
    progressionEvent: {
      create: (args: { data: Record<string, unknown> }) => Promise<TestEventRow>
      findMany: (args: {
        where?: { characterId?: string }
        orderBy?: unknown
      }) => Promise<TestEventRow[]>
    }
  }
  store: {
    characters: Map<string, TestCharacterRow>
    catalog: Map<string, TestCatalogRow>
    associations: TestAssociationRow[]
    events: TestEventRow[]
    addCatalog(row: Partial<TestCatalogRow> & { id: string }): TestCatalogRow
    addCharacter(
      row: Partial<TestCharacterRow> & { id: string }
    ): TestCharacterRow
    addAssociation(
      row: Partial<TestAssociationRow> & {
        characterId: string
        definitionId: string
        kind: "TITLE" | "EQUIPMENT"
      }
    ): TestAssociationRow
    reset(): void
  }
}

interface Transaction {
  character: {
    findUnique: (args: {
      where: { id: string }
      include?: unknown
    }) => Promise<TestCharacterRow | null>
    create: (args: {
      data: Record<string, unknown>
      include?: unknown
    }) => Promise<TestCharacterRow>
    updateMany: (args: {
      where: { id: string; version?: number }
      data: Record<string, unknown>
    }) => Promise<{ count: number }>
  }
  catalogDefinition: {
    findUnique: (args: {
      where: { id: string }
    }) => Promise<TestCatalogRow | null>
    update: (args: {
      where: { id: string }
      data: Record<string, unknown>
    }) => Promise<TestCatalogRow>
  }
  characterAssociation: {
    create: (args: {
      data: Record<string, unknown>
    }) => Promise<TestAssociationRow>
    deleteMany: (args: {
      where: { characterId: string; definitionId: string }
    }) => Promise<{ count: number }>
    findMany: (args: {
      where?: {
        definitionId?: string
        characterId?: string
      }
      include?: unknown
    }) => Promise<Array<TestAssociationRow & { character?: TestCharacterRow }>>
  }
  progressionEvent: {
    create: (args: { data: Record<string, unknown> }) => Promise<TestEventRow>
    findMany: (args: {
      where?: { characterId?: string }
      orderBy?: unknown
    }) => Promise<TestEventRow[]>
  }
}

export function createTestPrisma(): TestPrismaInstance {
  const characters = new Map<string, TestCharacterRow>()
  const catalog = new Map<string, TestCatalogRow>()
  const associations: TestAssociationRow[] = []
  const events: TestEventRow[] = []
  let idCounter = 0
  let eventCounter = 0
  let associationCounter = 0

  function attachAssociations(char: TestCharacterRow): TestAssociationRow[] {
    return associations
      .filter((a) => a.characterId === char.id)
      .map((a) => ({
        ...a,
        definition: a.definitionId
          ? (catalog.get(a.definitionId) ?? null)
          : null,
      }))
  }

  function attachRelations(char: TestCharacterRow): TestCharacterRow {
    return {
      ...char,
      race: char.raceId ? (catalog.get(char.raceId) ?? null) : null,
      class: char.classId ? (catalog.get(char.classId) ?? null) : null,
      profession: char.professionId
        ? (catalog.get(char.professionId) ?? null)
        : null,
      associations: attachAssociations(char),
    }
  }

  function findChar(id: string): TestCharacterRow | null {
    const c = characters.get(id)
    return c ? attachRelations(c) : null
  }

  const tx: Transaction = {
    character: {
      findUnique: async ({ where }) => findChar(where.id),
      create: async ({ data }) => {
        const id = (data.id as string) ?? `chr-${++idCounter}`
        const now = new Date()
        const char: TestCharacterRow = {
          id,
          ownerId: data.ownerId as string,
          name: data.name as string,
          description: (data.description as string | null) ?? null,
          origin: data.origin as string,
          raceId: (data.raceId as string | null) ?? null,
          classId: (data.classId as string | null) ?? null,
          professionId: (data.professionId as string | null) ?? null,
          state: data.state,
          version: (data.version as number) ?? 0,
          archived: (data.archived as boolean) ?? false,
          createdAt: now,
          updatedAt: now,
        }
        characters.set(id, char)
        return attachRelations(char)
      },
      updateMany: async ({ where, data }) => {
        const c = characters.get(where.id)
        if (!c) return { count: 0 }
        if (where.version != null && c.version !== where.version) {
          return { count: 0 }
        }
        const versionOp = data.version as { increment?: number } | undefined
        if (versionOp && typeof versionOp.increment === "number") {
          c.version += versionOp.increment
        }
        if (data.name != null) c.name = data.name as string
        if (data.description !== undefined) {
          c.description = data.description as string | null
        }
        if (data.archived != null) c.archived = data.archived as boolean
        if (data.state !== undefined) c.state = data.state
        c.updatedAt = new Date()
        return { count: 1 }
      },
    },
    catalogDefinition: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        catalog.get(where.id) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string }
        data: Record<string, unknown>
      }) => {
        const row = catalog.get(where.id)
        if (!row) throw new Error(`CatalogDefinition ${where.id} not found`)
        const updated = { ...row }
        if (data.stableId != null) updated.stableId = data.stableId as string
        if (data.name != null) updated.name = data.name as string
        if (data.description !== undefined)
          updated.description = data.description as string | null
        if (data.grade != null) updated.grade = data.grade as string | null
        if (data.provenance != null)
          updated.provenance = data.provenance as string
        if (data.sourceUrl != null)
          updated.sourceUrl = data.sourceUrl as string | null
        if (data.archived != null) updated.archived = data.archived as boolean
        if (data.config !== undefined)
          updated.config = data.config as Record<string, unknown>
        updated.updatedAt = new Date()
        catalog.set(where.id, updated)
        return updated
      },
    },
    characterAssociation: {
      create: async ({ data }) => {
        const id = (data.id as string) ?? `asc-${++associationCounter}`
        const row: TestAssociationRow = {
          id,
          characterId: data.characterId as string,
          definitionId: data.definitionId as string,
          kind: data.kind as "TITLE" | "EQUIPMENT",
          createdAt: new Date(),
          definition: catalog.get(data.definitionId as string) ?? null,
        }
        associations.push(row)
        return row
      },
      deleteMany: async ({ where }) => {
        let removed = 0
        for (let i = associations.length - 1; i >= 0; i--) {
          const a = associations[i]
          if (
            a.characterId === where.characterId &&
            a.definitionId === where.definitionId
          ) {
            associations.splice(i, 1)
            removed++
          }
        }
        return { count: removed }
      },
      findMany: async ({ where, include }) => {
        let results = associations
        if (where?.definitionId)
          results = results.filter((a) => a.definitionId === where.definitionId)
        if (where?.characterId)
          results = results.filter((a) => a.characterId === where.characterId)
        return results.map((a) => {
          const char = include ? findChar(a.characterId) : null
          const out: TestAssociationRow & { character?: TestCharacterRow } = {
            ...a,
            definition: catalog.get(a.definitionId) ?? null,
          }
          if (char) out.character = char
          return out
        })
      },
    },
    progressionEvent: {
      create: async ({ data }) => {
        const id = (data.id as string) ?? `evt-${++eventCounter}`
        const ev: TestEventRow = {
          id,
          characterId: data.characterId as string,
          kind: data.kind as string,
          payload: data.payload,
          createdAt: new Date(),
        }
        events.push(ev)
        return ev
      },
      findMany: async ({ where }) => {
        let results = events
        if (where?.characterId)
          results = results.filter((e) => e.characterId === where.characterId)
        return results.sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
        )
      },
    },
  }

  // The mock runs transactions strictly serially so that each callback observes
  // a consistent world and any concurrent CAS race is modelled faithfully. A
  // transaction mutates the shared stores in place (as the tx client does in the
  // real service), so on a thrown error we roll back exactly the writes this
  // transaction made: the association table, the append-only journal, and any
  // character fields changed by `updateMany`.
  let transactionChain: Promise<unknown> = Promise.resolve()

  function snapshot() {
    const assocSnapshot = [...associations]
    const eventSnapshot = [...events]
    const charSnapshot = new Map([...characters].map(([k, v]) => [k, { ...v }]))
    return { assocSnapshot, eventSnapshot, charSnapshot }
  }

  function restore(snap: ReturnType<typeof snapshot>) {
    associations.splice(0, associations.length, ...snap.assocSnapshot)
    events.splice(0, events.length, ...snap.eventSnapshot)
    characters.clear()
    for (const [k, v] of snap.charSnapshot) characters.set(k, v)
  }

  const prisma = {
    $transaction: (cb: (t: Transaction) => Promise<unknown>) => {
      const run = transactionChain.then(async () => {
        const snap = snapshot()
        try {
          return await cb(tx)
        } catch (err) {
          restore(snap)
          throw err
        }
      })
      // Keep the chain alive even when a transaction rejects.
      transactionChain = run.then(
        () => undefined,
        () => undefined
      )
      return run
    },
    catalogDefinition: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        catalog.get(where.id) ?? null,
      update: tx.catalogDefinition.update,
    },
    character: tx.character,
    characterAssociation: tx.characterAssociation,
    progressionEvent: tx.progressionEvent,
  }

  return {
    prisma,
    store: {
      characters,
      catalog,
      associations,
      events,
      addCatalog(row) {
        const full: TestCatalogRow = {
          id: row.id,
          kind: row.kind ?? "",
          stableId: row.stableId ?? "",
          name: row.name ?? "",
          config: row.config ?? {},
          description: row.description ?? null,
          grade: row.grade ?? null,
          provenance: row.provenance ?? "house",
          sourceUrl: row.sourceUrl ?? null,
          archived: row.archived ?? false,
          createdAt: new Date(),
          updatedAt: new Date(),
        }
        catalog.set(full.id, full)
        return full
      },
      addCharacter(row) {
        const full: TestCharacterRow = {
          id: row.id,
          ownerId: row.ownerId ?? "",
          name: row.name ?? "",
          description: row.description ?? null,
          origin: row.origin ?? "integrated",
          raceId: row.raceId ?? null,
          classId: row.classId ?? null,
          professionId: row.professionId ?? null,
          state: row.state ?? {},
          version: row.version ?? 0,
          archived: row.archived ?? false,
          createdAt: row.createdAt ?? new Date(),
          updatedAt: row.updatedAt ?? new Date(),
        }
        characters.set(full.id, full)
        return full
      },
      addAssociation(row) {
        const id = row.id ?? `asc-${++associationCounter}`
        const full: TestAssociationRow = {
          id,
          characterId: row.characterId,
          definitionId: row.definitionId,
          kind: row.kind,
          createdAt: row.createdAt ?? new Date(),
          definition: catalog.get(row.definitionId) ?? null,
        }
        associations.push(full)
        return full
      },
      reset() {
        characters.clear()
        catalog.clear()
        associations.splice(0, associations.length)
        events.splice(0, events.length)
        idCounter = 0
        eventCounter = 0
        associationCounter = 0
      },
    },
  }
}
