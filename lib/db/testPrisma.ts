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
    progressionEvent: {
      create: (args: { data: Record<string, unknown> }) => Promise<TestEventRow>
    }
  }
  store: {
    characters: Map<string, TestCharacterRow>
    catalog: Map<string, TestCatalogRow>
    events: TestEventRow[]
    addCatalog(row: Partial<TestCatalogRow> & { id: string }): TestCatalogRow
    addCharacter(
      row: Partial<TestCharacterRow> & { id: string }
    ): TestCharacterRow
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
  progressionEvent: {
    create: (args: { data: Record<string, unknown> }) => Promise<TestEventRow>
  }
}

export function createTestPrisma(): TestPrismaInstance {
  const characters = new Map<string, TestCharacterRow>()
  const catalog = new Map<string, TestCatalogRow>()
  const events: TestEventRow[] = []
  let idCounter = 0
  let eventCounter = 0

  function attachRelations(char: TestCharacterRow): TestCharacterRow {
    return {
      ...char,
      race: char.raceId ? (catalog.get(char.raceId) ?? null) : null,
      class: char.classId ? (catalog.get(char.classId) ?? null) : null,
      profession: char.professionId
        ? (catalog.get(char.professionId) ?? null)
        : null,
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
    },
  }

  const prisma = {
    $transaction: async (cb: (t: Transaction) => Promise<unknown>) => cb(tx),
    catalogDefinition: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        catalog.get(where.id) ?? null,
    },
    character: tx.character,
    progressionEvent: tx.progressionEvent,
  }

  return {
    prisma,
    store: {
      characters,
      catalog,
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
      reset() {
        characters.clear()
        catalog.clear()
        events.splice(0, events.length)
        idCounter = 0
        eventCounter = 0
      },
    },
  }
}
