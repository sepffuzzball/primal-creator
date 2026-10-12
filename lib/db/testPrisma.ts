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
  kind: "TITLE" | "EQUIPMENT" | "SKILL"
  createdAt: Date
  // Relation, only set on the object returned by findUnique/create.
  definition?: TestCatalogRow | null
}

export interface TestSkillOfferOptionRow {
  id: string
  offerId: string
  definitionId: string
  nameSnapshot: string
  configSnapshot: unknown
  // Relation, only set on the object returned by findUnique/findMany.
  definition?: TestCatalogRow | null
}

export interface TestSkillOfferRow {
  id: string
  characterId: string
  track: string
  level: number
  choiceGroup: string
  selectedDefinitionId: string | null
  selectedDefinition?: TestCatalogRow | null
  offeredAt: Date
  selectedAt: Date | null
  // Relational options, only set on the object returned by findUnique/findMany.
  options?: TestSkillOfferOptionRow[]
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
  skillOffers?: TestSkillOfferRow[]
}

export interface TestEventRow {
  id: string
  characterId: string
  kind: string
  payload: unknown
  createdAt: Date
}

export interface TestDraftRow {
  id: string
  userId: string
  data: unknown
  version: number
  createdAt: Date
  updatedAt: Date
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
      findMany: (args: {
        where?: { kind?: string; archived?: boolean }
      }) => Promise<TestCatalogRow[]>
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
    characterDraft: {
      findUnique: (args: {
        where: { userId: string }
      }) => Promise<TestDraftRow | null>
      findUniqueOrThrow: (args: {
        where: { userId: string }
      }) => Promise<TestDraftRow>
      create: (args: { data: Record<string, unknown> }) => Promise<TestDraftRow>
      updateMany: (args: {
        where: { userId: string; version?: number }
        data: Record<string, unknown>
      }) => Promise<{ count: number }>
      deleteMany: (args: {
        where: { userId: string; version?: number }
      }) => Promise<{ count: number }>
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
    skillOffer: {
      create: (args: {
        data: Record<string, unknown>
        include?: unknown
      }) => Promise<TestSkillOfferRow>
      findUnique: (args: {
        where:
          | { id: string }
          | {
              characterId_track_level_choiceGroup: {
                characterId: string
                track: string
                level: number
                choiceGroup: string
              }
            }
        include?: unknown
      }) => Promise<TestSkillOfferRow | null>
      findMany: (args: {
        where?: { characterId?: string }
        include?: unknown
      }) => Promise<TestSkillOfferRow[]>
      update: (args: {
        where: { id: string }
        data: Record<string, unknown>
      }) => Promise<TestSkillOfferRow>
    }
  }
  store: {
    characters: Map<string, TestCharacterRow>
    catalog: Map<string, TestCatalogRow>
    associations: TestAssociationRow[]
    events: TestEventRow[]
    skillOffers: TestSkillOfferRow[]
    skillOfferOptions: TestSkillOfferOptionRow[]
    drafts: Map<string, TestDraftRow>
    addCatalog(row: Partial<TestCatalogRow> & { id: string }): TestCatalogRow
    addCharacter(
      row: Partial<TestCharacterRow> & { id: string }
    ): TestCharacterRow
    addDraft(row: Partial<TestDraftRow> & { userId: string }): TestDraftRow
    addAssociation(
      row: Partial<TestAssociationRow> & {
        characterId: string
        definitionId: string
        kind: "TITLE" | "EQUIPMENT" | "SKILL"
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
  characterDraft: {
    findUnique: (args: {
      where: { userId: string }
    }) => Promise<TestDraftRow | null>
    findUniqueOrThrow: (args: {
      where: { userId: string }
    }) => Promise<TestDraftRow>
    create: (args: { data: Record<string, unknown> }) => Promise<TestDraftRow>
    updateMany: (args: {
      where: { userId: string; version?: number }
      data: Record<string, unknown>
    }) => Promise<{ count: number }>
    deleteMany: (args: {
      where: { userId: string; version?: number }
    }) => Promise<{ count: number }>
  }
  catalogDefinition: {
    findUnique: (args: {
      where: { id: string }
    }) => Promise<TestCatalogRow | null>
    findMany: (args: {
      where?: { kind?: string; archived?: boolean }
    }) => Promise<TestCatalogRow[]>
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
        kind?: "TITLE" | "EQUIPMENT" | "SKILL"
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
  skillOffer: {
    create: (args: {
      data: Record<string, unknown>
      include?: unknown
    }) => Promise<TestSkillOfferRow>
    findUnique: (args: {
      where:
        | { id: string }
        | {
            characterId_track_level_choiceGroup: {
              characterId: string
              track: string
              level: number
              choiceGroup: string
            }
          }
      include?: unknown
    }) => Promise<TestSkillOfferRow | null>
    findMany: (args: {
      where?: { characterId?: string }
      include?: unknown
    }) => Promise<TestSkillOfferRow[]>
    update: (args: {
      where: { id: string }
      data: Record<string, unknown>
    }) => Promise<TestSkillOfferRow>
  }
}

export function createTestPrisma(): TestPrismaInstance {
  const characters = new Map<string, TestCharacterRow>()
  const catalog = new Map<string, TestCatalogRow>()
  const associations: TestAssociationRow[] = []
  const events: TestEventRow[] = []
  const skillOffers: TestSkillOfferRow[] = []
  const skillOfferOptions: TestSkillOfferOptionRow[] = []
  const drafts = new Map<string, TestDraftRow>()
  let idCounter = 0
  let eventCounter = 0
  let associationCounter = 0
  let offerCounter = 0
  let optionCounter = 0
  let draftCounter = 0

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

  function attachSkillOffers(char: TestCharacterRow): TestSkillOfferRow[] {
    return skillOffers
      .filter((o) => o.characterId === char.id)
      .map((o) => ({
        ...o,
        selectedDefinition: o.selectedDefinitionId
          ? (catalog.get(o.selectedDefinitionId) ?? null)
          : null,
        options: skillOfferOptions
          .filter((opt) => opt.offerId === o.id)
          .map((opt) => ({
            ...opt,
            definition: opt.definitionId
              ? (catalog.get(opt.definitionId) ?? null)
              : null,
          })),
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
      skillOffers: attachSkillOffers(char),
    }
  }

  function findChar(id: string): TestCharacterRow | null {
    const c = characters.get(id)
    return c ? attachRelations(c) : null
  }

  function findOfferByKey(where: {
    id?: string
    characterId_track_level_choiceGroup?: {
      characterId: string
      track: string
      level: number
      choiceGroup: string
    }
  }): TestSkillOfferRow | undefined {
    const key = where.characterId_track_level_choiceGroup
    if (key) {
      return skillOffers.find(
        (o) =>
          o.characterId === key.characterId &&
          o.track === key.track &&
          o.level === key.level &&
          o.choiceGroup === key.choiceGroup
      )
    }
    return skillOffers.find((o) => o.id === where.id)
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
    characterDraft: {
      findUnique: async ({ where }: { where: { userId: string } }) => {
        for (const d of drafts.values()) {
          if (d.userId === where.userId) return { ...d }
        }
        return null
      },
      findUniqueOrThrow: async ({ where }: { where: { userId: string } }) => {
        for (const d of drafts.values()) {
          if (d.userId === where.userId) return { ...d }
        }
        throw { name: "PrismaClientKnownRequestError", code: "P2025" }
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        // Enforce the unique per-user constraint exactly as PostgreSQL would.
        for (const d of drafts.values()) {
          if (d.userId === (data.userId as string)) {
            throw {
              name: "PrismaClientKnownRequestError",
              code: "P2002",
              meta: { target: ["userId"] },
            }
          }
        }
        const id = (data.id as string) ?? `drf-${++draftCounter}`
        const now = new Date()
        const row: TestDraftRow = {
          id,
          userId: data.userId as string,
          data: data.data,
          version: (data.version as number) ?? 0,
          createdAt: now,
          updatedAt: now,
        }
        drafts.set(id, row)
        return { ...row }
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { userId: string; version?: number }
        data: Record<string, unknown>
      }) => {
        for (const [, d] of drafts) {
          if (d.userId !== where.userId) continue
          if (where.version != null && d.version !== where.version) continue
          if (data.data !== undefined) d.data = data.data
          const versionOp = data.version as { increment?: number } | undefined
          if (versionOp && typeof versionOp.increment === "number") {
            d.version += versionOp.increment
          }
          d.updatedAt = new Date()
          return { count: 1 }
        }
        return { count: 0 }
      },
      deleteMany: async ({
        where,
      }: {
        where: { userId: string; version?: number }
      }) => {
        for (const [id, d] of drafts) {
          if (d.userId !== where.userId) continue
          if (where.version != null && d.version !== where.version) continue
          drafts.delete(id)
          return { count: 1 }
        }
        return { count: 0 }
      },
    },
    catalogDefinition: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        catalog.get(where.id) ?? null,
      findMany: async ({
        where,
      }: {
        where?: { kind?: string; archived?: boolean }
      }) => {
        let results = [...catalog.values()]
        if (where?.kind != null)
          results = results.filter((r) => r.kind === where.kind)
        if (where?.archived != null)
          results = results.filter((r) => r.archived === where.archived)
        return results
      },
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
          kind: data.kind as "TITLE" | "EQUIPMENT" | "SKILL",
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
        if (where?.kind != null)
          results = results.filter((a) => a.kind === where.kind)
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
    skillOffer: {
      create: async ({ data }) => {
        const id = (data.id as string) ?? `off-${++offerCounter}`
        const now = new Date()
        const offer: TestSkillOfferRow = {
          id,
          characterId: data.characterId as string,
          track: data.track as string,
          level: data.level as number,
          choiceGroup: data.choiceGroup as string,
          selectedDefinitionId: null,
          offeredAt: now,
          selectedAt: null,
        }
        skillOffers.push(offer)
        const nestedOptions = (
          data.options as { create?: Array<Record<string, unknown>> }
        )?.create
        if (nestedOptions && nestedOptions.length > 0) {
          for (const opt of nestedOptions) {
            const optionId = (opt.id as string) ?? `opt-${++optionCounter}`
            skillOfferOptions.push({
              id: optionId,
              offerId: id,
              definitionId: opt.definitionId as string,
              nameSnapshot: opt.nameSnapshot as string,
              configSnapshot: opt.configSnapshot,
              definition: catalog.get(opt.definitionId as string) ?? null,
            })
          }
        }
        return attachOffer(offer)
      },
      findUnique: async ({ where, include }) => {
        const offer = findOfferByKey(where)
        if (!offer) return null
        return include ? attachOffer(offer) : { ...offer }
      },
      findMany: async ({ where }) => {
        let results = skillOffers
        if (where?.characterId != null)
          results = results.filter((o) => o.characterId === where.characterId)
        return results.map((o) => attachOffer(o))
      },
      update: async ({ where, data }) => {
        const offer = skillOffers.find((o) => o.id === where.id)
        if (!offer) throw new Error(`SkillOffer ${where.id} not found`)
        if (data.selectedDefinitionId != null) {
          offer.selectedDefinitionId = data.selectedDefinitionId as string
        }
        if (data.selectedAt != null) {
          offer.selectedAt = data.selectedAt as Date
        }
        return attachOffer(offer)
      },
    },
  }

  function attachOffer(o: TestSkillOfferRow): TestSkillOfferRow {
    return {
      ...o,
      selectedDefinition: o.selectedDefinitionId
        ? (catalog.get(o.selectedDefinitionId) ?? null)
        : null,
      options: skillOfferOptions
        .filter((opt) => opt.offerId === o.id)
        .map((opt) => ({
          ...opt,
          definition: opt.definitionId
            ? (catalog.get(opt.definitionId) ?? null)
            : null,
        })),
    }
  }

  // The mock runs transactions strictly serially so that each callback observes
  // a consistent world and any concurrent CAS race is modelled faithfully. A
  // transaction mutates the shared stores in place (as the tx client does in the
  // real service), so on a thrown error we roll back exactly the writes this
  // transaction made: the association table, the append-only journal, and any
  // character fields changed by `updateMany`.
  let transactionChain: Promise<unknown> = Promise.resolve()

  function snapshot() {
    const assocSnapshot = associations.map((a) => ({ ...a }))
    const eventSnapshot = [...events]
    const offerSnapshot = skillOffers.map((o) => ({ ...o }))
    const optionSnapshot = skillOfferOptions.map((o) => ({ ...o }))
    const charSnapshot = new Map([...characters].map(([k, v]) => [k, { ...v }]))
    const draftSnapshot = new Map([...drafts].map(([k, v]) => [k, { ...v }]))
    return {
      assocSnapshot,
      eventSnapshot,
      offerSnapshot,
      optionSnapshot,
      charSnapshot,
      draftSnapshot,
    }
  }

  function restore(snap: ReturnType<typeof snapshot>) {
    associations.splice(0, associations.length, ...snap.assocSnapshot)
    events.splice(0, events.length, ...snap.eventSnapshot)
    skillOffers.splice(0, skillOffers.length, ...snap.offerSnapshot)
    skillOfferOptions.splice(
      0,
      skillOfferOptions.length,
      ...snap.optionSnapshot
    )
    characters.clear()
    for (const [k, v] of snap.charSnapshot) characters.set(k, v)
    drafts.clear()
    for (const [k, v] of snap.draftSnapshot) drafts.set(k, v)
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
      findMany: tx.catalogDefinition.findMany,
      update: tx.catalogDefinition.update,
    },
    character: tx.character,
    characterDraft: tx.characterDraft,
    characterAssociation: tx.characterAssociation,
    progressionEvent: tx.progressionEvent,
    skillOffer: tx.skillOffer,
  }

  return {
    prisma,
    store: {
      characters,
      catalog,
      associations,
      events,
      skillOffers,
      skillOfferOptions,
      drafts,
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
      addDraft(row) {
        const id = row.id ?? `drf-${++draftCounter}`
        const full: TestDraftRow = {
          id,
          userId: row.userId,
          data: row.data ?? {},
          version: row.version ?? 0,
          createdAt: row.createdAt ?? new Date(),
          updatedAt: row.updatedAt ?? new Date(),
        }
        drafts.set(id, full)
        return { ...full }
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
        skillOffers.splice(0, skillOffers.length)
        skillOfferOptions.splice(0, skillOfferOptions.length)
        drafts.clear()
        idCounter = 0
        eventCounter = 0
        associationCounter = 0
        offerCounter = 0
        optionCounter = 0
        draftCounter = 0
      },
    },
  }
}
