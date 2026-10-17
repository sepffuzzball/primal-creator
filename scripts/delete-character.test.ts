/**
 * Tests for the explicit per-character PostgreSQL hard-delete utility
 * (`scripts/delete-character.mjs`).
 *
 * These are pure unit tests. They exercise the exported CLI parser, the
 * DATABASE_URL validator, the preview formatting, and the orchestration in
 * `main()` with an injected mock Prisma client. No real Postgres is touched and
 * no database is reset. The proof points are:
 *
 *   - every unsafe/ambiguous input fails BEFORE any deletion: unknown flag,
 *     duplicate flag, stray positional, stray `--`, missing `--id`, empty
 *     `--id`, `--execute` without `--confirm`, `--confirm` without `--execute`,
 *     a DATABASE_URL that is missing/invalid/non-Postgres, and a `--confirm`
 *     value that does not equal the exact character id;
 *   - the default (no `--execute`) path is a read-only PREVIEW: it prints the
 *     target id/name/ownerId/archived flag and the dependent counts, and never
 *     calls delete or cascades anything;
 *   - an unknown id in either mode reports "not-found" and deletes nothing;
 *   - the success path re-reads the exact id inside a transaction, deletes
 *     `{ id }` ONLY (never a broad WHERE or a whole-DB reset), cascades the
 *     character's dependents, and leaves every other character and its
 *     dependents intact.
 *
 * An optional, explicitly-opted-in real-Postgres block (guarded by
 * `resolveDbIntegration`) runs only when `RUN_DB_INTEGRATION_TESTS=1` and the
 * effective DATABASE_URL is a test-named database. It seeds a user + a catalog
 * definition + two characters on the migrated integration-test database,
 * previews and then hard-deletes exactly one of them, and asserts that only the
 * target (plus its dense dependent set) is gone while the sibling character stays.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import {
  deleteCharacter,
  formatCharacterPreview,
  formatDeleted,
  GENERIC_FAILURE_MESSAGE,
  main,
  parseArgs,
  previewCharacter,
  validateDatabaseUrl,
} from "./delete-character.mjs"
import { resolveDbIntegration } from "@/lib/test/db-integration"

const dbIntegrationGate = await resolveDbIntegration()

// ------------------------------------------------------------------ //
// Test fixtures
// ------------------------------------------------------------------ //

/** A valid DATABASE_URL for the unit tests (never actually connected). */
const VALID_URL =
  "postgresql://postgres:postgres@localhost:5432/primal_creator?schema=public"

/** A long-lived, migrated, reachable URL for the opt-in integration block. */
const integrationUrl = process.env.DATABASE_URL

// ------------------------------------------------------------------ //
// Mock Prisma client (records calls; never touches a real database)
// ------------------------------------------------------------------ //

interface CharRow {
  id: string
  ownerId: string
  name: string
  archived: boolean
}

interface DepCountOption {
  assets?: number
  events?: number
  associations?: number
  inventory?: number
  currencyBalances?: number
  skillOffers?: number
  skillOfferOptions?: number
}

interface MockOptions {
  characters?: Record<string, CharRow>
  dependents?: Record<string, DepCountOption>
}

type DependentKind =
  | "assets"
  | "events"
  | "associations"
  | "inventory"
  | "currencyBalances"
  | "skillOffers"
  | "skillOfferOptions"

/** The filter shape the script passes to a `count()` call. */
interface CountWhere {
  characterId?: string
  offer?: { characterId?: string }
}

interface CallRecord {
  model: string
  where: unknown
}

/** The same single-character transaction surface the script uses. */
interface MockTx {
  character: {
    findUnique: (args: { where: { id: string } }) => Promise<CharRow | null>
    delete: (args: { where: { id: string } }) => Promise<CharRow>
  }
}

/** The mock Prisma client surface the script consumes (no `any`). */
interface MockDb {
  calls: {
    findUnique: CallRecord[]
    delete: CallRecord[]
    counts: CallRecord[]
    transaction: number
  }
  _state: {
    hasCharacter: (id: string) => boolean
    countBy: (kind: DependentKind, charId: string) => number
    characterRow: (id: string) => CharRow | undefined
  }
  $transaction: (cb: (tx: MockTx) => Promise<unknown>) => Promise<unknown>
  $disconnect: () => Promise<undefined>
  character: {
    findUnique: (args: { where: { id: string } }) => Promise<CharRow | null>
  }
  asset: { count: (args: { where: CountWhere }) => Promise<number> }
  progressionEvent: {
    count: (args: { where: CountWhere }) => Promise<number>
  }
  characterAssociation: {
    count: (args: { where: CountWhere }) => Promise<number>
  }
  characterInventoryItem: {
    count: (args: { where: CountWhere }) => Promise<number>
  }
  characterCurrencyBalance: {
    count: (args: { where: CountWhere }) => Promise<number>
  }
  skillOffer: { count: (args: { where: CountWhere }) => Promise<number> }
  skillOfferOption: { count: (args: { where: CountWhere }) => Promise<number> }
}

/**
 * A minimal stand-in for the Prisma client used by the script. It stores a
 * characters map and per-character dependent rows, supports the exact count,
 * findUnique and transaction shapes the script issues, and models the FK
 * cascade of `character.delete({ where: { id } })`. It records every findUnique,
 * delete and count call so tests can assert that ONLY the target id was deleted.
 */
function mockDb(cfg: MockOptions = {}): MockDb {
  const characters = new Map<string, CharRow>()
  const assets: Array<{ id: string; characterId: string }> = []
  const events: Array<{ id: string; characterId: string }> = []
  const associations: Array<{ id: string; characterId: string }> = []
  const inventory: Array<{ id: string; characterId: string }> = []
  const currencyBalances: Array<{ id: string; characterId: string }> = []
  const offers: Array<{ id: string; characterId: string }> = []
  const offerOptions: Array<{ id: string; offerId: string }> = []

  const calls: MockDb["calls"] = {
    findUnique: [],
    delete: [],
    counts: [],
    transaction: 0,
  }

  for (const [id, c] of Object.entries(cfg.characters ?? {})) {
    characters.set(id, c)
  }
  for (const [charId, d] of Object.entries(cfg.dependents ?? {})) {
    for (let i = 0; i < (d.assets ?? 0); i++)
      assets.push({ id: `${charId}-asset-${i}`, characterId: charId })
    for (let i = 0; i < (d.events ?? 0); i++)
      events.push({ id: `${charId}-event-${i}`, characterId: charId })
    for (let i = 0; i < (d.associations ?? 0); i++)
      associations.push({ id: `${charId}-assoc-${i}`, characterId: charId })
    for (let i = 0; i < (d.inventory ?? 0); i++)
      inventory.push({ id: `${charId}-inv-${i}`, characterId: charId })
    for (let i = 0; i < (d.currencyBalances ?? 0); i++)
      currencyBalances.push({ id: `${charId}-cur-${i}`, characterId: charId })
    const offerCount = d.skillOffers ?? 0
    for (let i = 0; i < offerCount; i++)
      offers.push({ id: `${charId}-offer-${i}`, characterId: charId })
    const myOfferIds = offers
      .filter((o) => o.characterId === charId)
      .map((o) => o.id)
    const optCount = d.skillOfferOptions ?? 0
    for (let i = 0; i < optCount; i++) {
      const offerId = myOfferIds[i % Math.max(1, myOfferIds.length)]
      offerOptions.push({ id: `${charId}-opt-${i}`, offerId })
    }
  }

  function removeWhere<T>(arr: T[], pred: (row: T) => boolean): void {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (pred(arr[i])) arr.splice(i, 1)
    }
  }

  function countDependents(kind: DependentKind, charId: string): number {
    switch (kind) {
      case "assets":
        return assets.filter((r) => r.characterId === charId).length
      case "events":
        return events.filter((r) => r.characterId === charId).length
      case "associations":
        return associations.filter((r) => r.characterId === charId).length
      case "inventory":
        return inventory.filter((r) => r.characterId === charId).length
      case "currencyBalances":
        return currencyBalances.filter((r) => r.characterId === charId).length
      case "skillOffers":
        return offers.filter((r) => r.characterId === charId).length
      case "skillOfferOptions": {
        const offerIds = new Set(
          offers.filter((o) => o.characterId === charId).map((o) => o.id)
        )
        return offerOptions.filter((r) => offerIds.has(r.offerId)).length
      }
    }
  }

  function countWhere(model: string, where: CountWhere): number {
    calls.counts.push({ model, where })
    if (where && typeof where === "object" && "characterId" in where) {
      const mapped: Record<string, DependentKind> = {
        asset: "assets",
        progressionEvent: "events",
        characterAssociation: "associations",
        characterInventoryItem: "inventory",
        characterCurrencyBalance: "currencyBalances",
        skillOffer: "skillOffers",
      }
      if (mapped[model]) {
        return countDependents(mapped[model], where.characterId ?? "")
      }
    }
    if (model === "skillOfferOption") {
      return countDependents(
        "skillOfferOptions",
        where.offer?.characterId ?? ""
      )
    }
    throw new Error(`Unhandled count model: ${model}`)
  }

  async function findCharacter(args: {
    where: { id: string }
  }): Promise<CharRow | null> {
    calls.findUnique.push({ model: "character", where: args.where })
    return characters.get(args.where.id) ?? null
  }

  const db: MockDb = {
    calls,
    _state: {
      hasCharacter: (id) => characters.has(id),
      countBy: (kind, charId) => countDependents(kind, charId),
      characterRow: (id) => characters.get(id),
    },
    $transaction: async (cb) => {
      calls.transaction++
      const tx: MockTx = {
        character: {
          findUnique: findCharacter,
          delete: async ({ where }) => {
            calls.delete.push({ model: "character", where })
            const row = characters.get(where.id)
            if (!row) {
              throw { name: "PrismaClientKnownRequestError", code: "P2025" }
            }
            characters.delete(where.id)
            // FK cascade, mirroring the schema's `ON DELETE CASCADE`.
            removeWhere(assets, (r) => r.characterId === where.id)
            removeWhere(events, (r) => r.characterId === where.id)
            removeWhere(associations, (r) => r.characterId === where.id)
            removeWhere(inventory, (r) => r.characterId === where.id)
            removeWhere(currencyBalances, (r) => r.characterId === where.id)
            const offerIds = offers
              .filter((o) => o.characterId === where.id)
              .map((o) => o.id)
            removeWhere(offers, (r) => r.characterId === where.id)
            removeWhere(offerOptions, (r) => offerIds.includes(r.offerId))
            return row
          },
        },
      }
      return cb(tx)
    },
    $disconnect: async () => undefined,
    character: { findUnique: findCharacter },
    asset: {
      count: async (args) => countWhere("asset", args.where),
    },
    progressionEvent: {
      count: async (args) => countWhere("progressionEvent", args.where),
    },
    characterAssociation: {
      count: async (args) => countWhere("characterAssociation", args.where),
    },
    characterInventoryItem: {
      count: async (args) => countWhere("characterInventoryItem", args.where),
    },
    characterCurrencyBalance: {
      count: async (args) => countWhere("characterCurrencyBalance", args.where),
    },
    skillOffer: {
      count: async (args) => countWhere("skillOffer", args.where),
    },
    skillOfferOption: {
      count: async (args) => countWhere("skillOfferOption", args.where),
    },
  }
  return db
}

/** A standard seeded DB: one target character, one sibling, dense dependents. */
function seededDb(): MockDb {
  return mockDb({
    characters: {
      cA: { id: "cA", ownerId: "u1", name: "A", archived: false },
      cB: { id: "cB", ownerId: "u1", name: "B", archived: true },
    },
    dependents: {
      cA: {
        assets: 2,
        events: 3,
        associations: 1,
        inventory: 1,
        currencyBalances: 1,
        skillOffers: 1,
        skillOfferOptions: 4,
      },
      cB: { assets: 1 },
    },
  })
}

function runMain(opts: {
  argv: string[]
  db?: MockDb
  env?: Record<string, string>
  log?: (m: string) => void
  errLog?: (m: string) => void
}) {
  const logs: string[] = []
  const errLogs: string[] = []
  return main({
    env: opts.env ?? { DATABASE_URL: VALID_URL },
    argv: opts.argv,
    createDb: () => opts.db ?? mockDb(),
    log: opts.log ?? ((m: string) => logs.push(m)),
    errLog: opts.errLog ?? ((m: string) => errLogs.push(m)),
  }).then((result) => ({ result, logs, errLogs }))
}

// ------------------------------------------------------------------ //
// CLI parsing
// ------------------------------------------------------------------ //

describe("parseArgs", () => {
  it("parses a read-only preview invocation", () => {
    expect(parseArgs(["--id", "cA"])).toEqual({ id: "cA" })
  })

  it("parses an execute invocation with a matching confirm", () => {
    expect(parseArgs(["--id", "cA", "--execute", "--confirm", "cA"])).toEqual({
      id: "cA",
      execute: true,
      confirm: "cA",
    })
  })

  it("accepts a single leading -- separator", () => {
    expect(parseArgs(["--", "--id", "cA"])).toEqual({ id: "cA" })
  })

  it("rejects a stray -- separator", () => {
    expect(() => parseArgs(["--id", "cA", "--"])).toThrow(
      /Unexpected separator/
    )
  })

  it("rejects an unknown flag", () => {
    expect(() => parseArgs(["--id", "cA", "--bogus", "x"])).toThrow(
      /Unknown flag/
    )
  })

  it("rejects a duplicate flag", () => {
    expect(() => parseArgs(["--id", "cA", "--id", "cB"])).toThrow(
      /Duplicate flag/
    )
  })

  it("rejects a positional argument", () => {
    expect(() => parseArgs(["--id", "cA", "stray"])).toThrow(
      /Unexpected positional argument/
    )
  })

  it("rejects a missing --id", () => {
    expect(() => parseArgs([])).toThrow(/--id is required/)
  })

  it("rejects an empty --id", () => {
    expect(() => parseArgs(["--id", ""])).toThrow(/nonempty character id/)
  })

  it("rejects a missing value for --id", () => {
    expect(() => parseArgs(["--id"])).toThrow(/Missing value for --id/)
  })

  it("rejects --execute without --confirm", () => {
    expect(() => parseArgs(["--id", "cA", "--execute"])).toThrow(
      /--confirm is required when --execute is set/
    )
  })

  it("rejects --confirm without --execute", () => {
    expect(() => parseArgs(["--id", "cA", "--confirm", "cA"])).toThrow(
      /--confirm is only valid together with --execute/
    )
  })
})

// ------------------------------------------------------------------ //
// DATABASE_URL validation
// ------------------------------------------------------------------ //

describe("validateDatabaseUrl", () => {
  it("accepts a valid PostgreSQL URL", () => {
    expect(validateDatabaseUrl(VALID_URL).dbname).toBe("primal_creator")
  })

  it("rejects a missing / empty DATABASE_URL", () => {
    expect(() => validateDatabaseUrl("")).toThrow(/DATABASE_URL must be set/)
    expect(() => validateDatabaseUrl(undefined as unknown as string)).toThrow(
      /DATABASE_URL must be set/
    )
  })

  it("rejects an unparseable URL", () => {
    expect(() => validateDatabaseUrl("not a url")).toThrow(/not a valid URL/)
  })

  it("rejects a non-PostgreSQL scheme", () => {
    expect(() => validateDatabaseUrl("mysql://u:p@h/db")).toThrow(
      /must be a PostgreSQL URL/
    )
  })

  it("rejects a multi-segment or missing database name", () => {
    expect(() =>
      validateDatabaseUrl("postgresql://u:p@h:5432/db/something")
    ).toThrow(/exactly one database/)
    expect(() => validateDatabaseUrl("postgresql://u:p@h:5432/")).toThrow(
      /exactly one database/
    )
  })

  it("accepts a URL without credentials and with query knobs", () => {
    expect(() =>
      validateDatabaseUrl(
        "postgresql://h:5432/db?schema=public&connection_limit=1"
      )
    ).not.toThrow()
  })

  it("never leaks credentials, host, or db pathname into its error", () => {
    const secretUser = "svc_user"
    const secretPass = "hunter2Pass!"
    const secretHost = "db.internal"
    const secretDb = "fluffy_prod"
    const errors: string[] = []
    const capture = (fn: () => unknown) => {
      try {
        fn()
      } catch (e) {
        errors.push((e as Error).message)
      }
    }
    // Non-Postgres scheme: error must not mention any URL component.
    capture(() =>
      validateDatabaseUrl(
        `mysql://${secretUser}:${secretPass}@${secretHost}:5432/${secretDb}?schema=public`
      )
    )
    // Multi-segment pathname: error must not mention the db name either.
    capture(() =>
      validateDatabaseUrl(
        `postgresql://${secretUser}:${secretPass}@${secretHost}:5432/${secretDb}/extra?schema=public`
      )
    )
    expect(errors.length).toBe(2)
    for (const message of errors) {
      expect(message).not.toContain(secretUser)
      expect(message).not.toContain(secretPass)
      expect(message).not.toContain(secretHost)
      expect(message).not.toContain(secretDb)
    }
  })

  it("accepts a URL with a password and a sensitive db name", () => {
    const secretPass = "hunter2Pass!"
    const secretDb = "fluffy_prod"
    const url = `postgresql://svc_user:${secretPass}@db.internal:5432/${secretDb}?schema=public&connection_limit=1`
    expect(validateDatabaseUrl(url).dbname).toBe(secretDb)
  })
})

// ------------------------------------------------------------------ //
// Read-only preview
// ------------------------------------------------------------------ //

describe("preview (default, no --execute)", () => {
  it("reports the target and its dependent counts and deletes nothing", async () => {
    const db = seededDb()
    const { result, logs } = await runMain({ argv: ["--id", "cA"], db })
    expect(result.status).toBe("ok")
    expect(db.calls.delete.length).toBe(0)
    expect(db.calls.transaction).toBe(0)
    expect(db._state.hasCharacter("cA")).toBe(true)

    const out = logs.join("\n")
    expect(out).toMatch(/id:\s+cA/)
    expect(out).toMatch(/name:\s+A/)
    expect(out).toMatch(/ownerId:\s+u1/)
    expect(out).toMatch(/archived:\s+false/)
    expect(out).toMatch(/assets:\s+2/)
    expect(out).toMatch(/progression events:\s+3/)
    expect(out).toMatch(/associations:\s+1/)
    expect(out).toMatch(/inventory items:\s+1/)
    expect(out).toMatch(/currency balances:\s+1/)
    expect(out).toMatch(/skill offers:\s+1/)
    expect(out).toMatch(/skill offer options:\s+4/)
  })

  it("returns the structured preview and never touches the DB mutatively", async () => {
    const db = seededDb()
    const { result } = await runMain({ argv: ["--id", "cA"], db })
    expect(result.status).toBe("ok")
    expect(result.preview).toEqual({
      id: "cA",
      name: "A",
      ownerId: "u1",
      archived: false,
      counts: {
        assets: 2,
        events: 3,
        associations: 1,
        inventory: 1,
        currencyBalances: 1,
        skillOffers: 1,
        skillOfferOptions: 4,
      },
    })
    expect(db.calls.findUnique.some((c) => c.model === "character")).toBe(true)
    expect(db.calls.delete.length).toBe(0)
  })

  it("reports not-found and deletes nothing for an unknown id", async () => {
    const db = seededDb()
    const { result, logs } = await runMain({ argv: ["--id", "ghost"], db })
    expect(result.status).toBe("not-found")
    expect(logs.join("\n")).toMatch(/not found/)
    expect(db.calls.delete.length).toBe(0)
    expect(db.calls.transaction).toBe(0)
  })
})

// ------------------------------------------------------------------ //
// Confirm safety / no deletion before the confirm is satisfied
// ------------------------------------------------------------------ //

describe("execute confirm safety", () => {
  it("fails and deletes nothing when --confirm mismatches the id", async () => {
    const db = seededDb()
    const { result, errLogs } = await runMain({
      argv: ["--id", "cA", "--execute", "--confirm", "cB"],
      db,
    })
    expect(result.status).toBe("failed")
    expect(result.error).toMatch(/--confirm must be exactly "cA"/)
    expect(errLogs.join("\n")).toMatch(/--confirm must be exactly "cA"/)
    expect(db.calls.transaction).toBe(0)
    expect(db.calls.delete.length).toBe(0)
    expect(db._state.hasCharacter("cA")).toBe(true)
  })

  it("fails before any DB work when --execute has no --confirm", async () => {
    const db = seededDb()
    const { result } = await runMain({
      argv: ["--id", "cA", "--execute"],
      db,
    })
    expect(result.status).toBe("failed")
    expect(result.error).toMatch(/--confirm is required/)
    expect(db.calls.transaction).toBe(0)
    expect(db.calls.delete.length).toBe(0)
  })

  it("fails before any DB work on a missing DATABASE_URL", async () => {
    const db = seededDb()
    const { result } = await runMain({
      argv: ["--id", "cA"],
      db,
      env: {},
    })
    expect(result.status).toBe("failed")
    expect(result.error).toMatch(/DATABASE_URL must be set/)
    expect(db.calls.transaction).toBe(0)
  })

  it("fails before any DB work on an invalid DATABASE_URL", async () => {
    const db = seededDb()
    const { result } = await runMain({
      argv: ["--id", "cA"],
      db,
      env: { DATABASE_URL: "mysql://u:p@h/db" },
    })
    expect(result.status).toBe("failed")
    expect(result.error).toMatch(/must be a PostgreSQL URL/)
    expect(db.calls.transaction).toBe(0)
  })
})

// ------------------------------------------------------------------ //
// Execute: only the target plus its dependents is deleted
// ------------------------------------------------------------------ //

describe("execute deletion", () => {
  it("deletes only the exact id inside a transaction and cascades its dependents", async () => {
    const db = seededDb()
    const { result, logs } = await runMain({
      argv: ["--id", "cA", "--execute", "--confirm", "cA"],
      db,
    })

    expect(result.status).toBe("ok")
    expect(result.deletedId).toBe("cA")

    // The delete was scoped to the exact id - never a broad WHERE.
    expect(db.calls.delete).toEqual([
      { model: "character", where: { id: "cA" } },
    ])
    // The exact id was re-read inside the transaction.
    expect(
      db.calls.findUnique.some(
        (c) =>
          c.model === "character" && (c.where as { id: string }).id === "cA"
      )
    ).toBe(true)
    expect(db.calls.transaction).toBe(1)

    // Target is gone, and every dependent row is gone.
    expect(db._state.hasCharacter("cA")).toBe(false)
    expect(db._state.countBy("assets", "cA")).toBe(0)
    expect(db._state.countBy("events", "cA")).toBe(0)
    expect(db._state.countBy("associations", "cA")).toBe(0)
    expect(db._state.countBy("inventory", "cA")).toBe(0)
    expect(db._state.countBy("currencyBalances", "cA")).toBe(0)
    expect(db._state.countBy("skillOffers", "cA")).toBe(0)
    expect(db._state.countBy("skillOfferOptions", "cA")).toBe(0)

    // The sibling character and its own dependents are untouched.
    expect(db._state.hasCharacter("cB")).toBe(true)
    expect(db._state.countBy("assets", "cB")).toBe(1)

    expect(logs.join("\n")).toMatch(/deleted character "cA"/)
  })

  it("reports the deleted id and never performs a whole-table operation", async () => {
    const db = seededDb()
    const { result } = await runMain({
      argv: ["--id", "cB", "--execute", "--confirm", "cB"],
      db,
    })
    expect(result.status).toBe("ok")
    expect(result.deletedId).toBe("cB")
    expect(db.calls.delete).toEqual([
      { model: "character", where: { id: "cB" } },
    ])
    // Only the one character delete was issued - no deleteMany / reset.
    expect(db.calls.delete.length).toBe(1)
  })

  it("reports not-found when the execute target id does not exist", async () => {
    const db = seededDb()
    const { result, logs } = await runMain({
      argv: ["--id", "ghost", "--execute", "--confirm", "ghost"],
      db,
    })
    expect(result.status).toBe("not-found")
    expect(logs.join("\n")).toMatch(/not found/)
    expect(db.calls.delete.length).toBe(0)
    // The sibling is untouched.
    expect(db._state.hasCharacter("cA")).toBe(true)
    expect(db._state.hasCharacter("cB")).toBe(true)
  })
})

// ------------------------------------------------------------------ //
// Exported helpers (pure)
// ------------------------------------------------------------------ //

describe("previewCharacter / deleteCharacter / formatting helpers", () => {
  it("previewCharacter returns null for an unknown id and counts dependents otherwise", async () => {
    const db = seededDb()
    const preview = await previewCharacter(db, "cA")
    expect(preview).not.toBeNull()
    expect(preview!.counts).toEqual({
      assets: 2,
      events: 3,
      associations: 1,
      inventory: 1,
      currencyBalances: 1,
      skillOffers: 1,
      skillOfferOptions: 4,
    })
    expect(await previewCharacter(db, "ghost")).toBeNull()
  })

  it("deleteCharacter returns deleted:false for an unknown id without deleting", async () => {
    const db = seededDb()
    const outcome = await deleteCharacter(db, "ghost")
    expect(outcome).toEqual({ deleted: false })
    expect(db.calls.delete.length).toBe(0)
  })

  it("formats the preview and deletion output for human consumption", async () => {
    const db = seededDb()
    const preview = (await previewCharacter(db, "cA"))!
    const previewText = formatCharacterPreview(preview)
    expect(previewText).toContain("preview (read-only; nothing deleted)")
    expect(previewText).toContain("cA")
    expect(previewText).toContain("A")
    expect(previewText).toContain("u1")
    expect(previewText).toContain("assets:              2")

    const deletedText = formatDeleted(previewableCharacter(db))
    expect(deletedText).toContain('deleted character "cA"')
    expect(deletedText).toContain("uploads volume / UPLOAD_DIR")
    expect(deletedText).toContain("orphaned")
  })
})

/** Small helper: build a fake deleted character row for formatting only. */
function previewableCharacter(db: MockDb) {
  return db._state.characterRow("cA")
}

// ------------------------------------------------------------------ //
// Generic, secret-free DB failure
// ------------------------------------------------------------------ //

describe("generic, secret-free DB failure", () => {
  it("logs a generic message and never leaks a Prisma URL/password", async () => {
    const logs: string[] = []
    const errLogs: string[] = []
    const secretUser = "svc_user"
    const secretPass = "hunter2Pass!"
    const secretHost = "db.internal"
    const secretDb = "fluffy_prod"
    const secretUrl = `postgresql://${secretUser}:${secretPass}@${secretHost}:5432/${secretDb}?schema=public`

    const dbError = new Error(
      `PrismaClientInitializationError: can't reach ${secretUrl}`
    )
    dbError.name = "PrismaClientInitializationError"

    const result = await main({
      env: { DATABASE_URL: secretUrl },
      argv: ["--id", "cA"],
      createDb: () => {
        const db = mockDb()
        db.character.findUnique = async () => {
          throw dbError
        }
        return db
      },
      log: (m: string) => logs.push(m),
      errLog: (m: string) => errLogs.push(m),
    })

    expect(result.status).toBe("failed")
    expect(result.error).toBe(GENERIC_FAILURE_MESSAGE)
    expect(result.error).not.toContain(secretUser)
    expect(result.error).not.toContain(secretPass)
    expect(result.error).not.toContain(secretHost)
    expect(result.error).not.toContain(secretDb)

    const errText = errLogs.join("\n")
    expect(errText).toContain("delete-character:")
    expect(errText).not.toContain(secretUser)
    expect(errText).not.toContain(secretPass)
    expect(errText).not.toContain(secretHost)
    expect(errText).not.toContain(secretDb)
    expect(errText).not.toContain("PrismaClientInitializationError")
    // No exception stack frames are surfaced.
    expect(errText).not.toMatch(/\n\s+at /)

    // Nothing secret-embedded ever reaches stdout either.
    expect(logs.join("\n")).not.toContain(secretPass)
    expect(logs.join("\n")).not.toContain(secretDb)
  })

  it("fails with a generic message when the DB client itself throws", async () => {
    const errLogs: string[] = []
    const connectionError = new Error(
      "could not connect to postgresql://svc_user:hunter2Pass!@db.internal:5432/fluffy_prod"
    )
    const result = await main({
      env: {
        DATABASE_URL:
          "postgresql://svc_user:hunter2Pass!@db.internal:5432/fluffy_prod",
      },
      argv: ["--id", "cA", "--execute", "--confirm", "cA"],
      createDb: () => {
        throw connectionError
      },
      log: () => {},
      errLog: (m: string) => errLogs.push(m),
    })

    expect(result.status).toBe("failed")
    expect(result.error).toBe(GENERIC_FAILURE_MESSAGE)
    expect(result.error).not.toContain("hunter2Pass!")
    expect(result.error).not.toContain("fluffy_prod")
    const errText = errLogs.join("\n")
    expect(errText).not.toContain("hunter2Pass!")
    expect(errText).not.toContain("fluffy_prod")
  })
})

// ------------------------------------------------------------------ //
// Optional real-Postgres integration (guarded; never runs by default)
// ------------------------------------------------------------------ //

describe.skipIf(!dbIntegrationGate.run)(
  "real-Postgres delete-character (opt-in)",
  () => {
    let admin: PrismaClient
    let baseUrl: URL

    const USER_ID = "dc-user"
    const CATALOG_ID = "dc-cat"
    const CB_ID = "00000000-0000-0000-0000-0000000000a0"
    const CA_ID = "dc-char-a"
    const CB = "dc-char-b"

    beforeAll(() => {
      baseUrl = new URL(integrationUrl!)
      admin = new PrismaClient({
        datasources: { db: { url: maintenanceUrl(baseUrl) } },
      })
    })

    afterAll(async () => {
      await admin.$disconnect()
    })

    it(
      "previews then hard-deletes exactly one character and cascades its dependents",
      { timeout: 60_000 },
      async () => {
        const db = new PrismaClient({
          datasources: { db: { url: integrationUrl! } },
        })
        try {
          // Idempotent setup: clear any rows a crashed prior run left behind.
          await db.character.deleteMany({
            where: { id: { in: [CA_ID, CB] } },
          })
          await db.characterCurrencyBalance.deleteMany({
            where: { id: CB_ID },
          })
          await db.catalogDefinition.deleteMany({ where: { id: CATALOG_ID } })
          await db.user.deleteMany({ where: { id: USER_ID } })

          await db.user.create({
            data: { id: USER_ID, email: "dc@primal.local", password: "x" },
          })
          await db.catalogDefinition.create({
            data: {
              id: CATALOG_ID,
              kind: "items",
              stableId: "dc-item",
              name: "dc-item",
              config: {},
            },
          })
          await db.character.create({
            data: {
              id: CA_ID,
              ownerId: USER_ID,
              name: "DeleteMe",
              state: {},
            },
          })
          await db.character.create({
            data: { id: CB, ownerId: USER_ID, name: "KeepMe", state: {} },
          })
          // Dense dependent set on the target.
          await db.asset.create({
            data: {
              id: `${CA_ID}-asset`,
              kind: "character-avatar",
              url: "/dc.png",
              characterId: CA_ID,
            },
          })
          await db.progressionEvent.create({
            data: {
              id: `${CA_ID}-event`,
              characterId: CA_ID,
              kind: "create",
              payload: {},
            },
          })
          await db.characterAssociation.create({
            data: {
              id: `${CA_ID}-assoc`,
              characterId: CA_ID,
              definitionId: CATALOG_ID,
              kind: "TITLE",
            },
          })
          await db.characterInventoryItem.create({
            data: {
              id: `${CA_ID}-inv`,
              characterId: CA_ID,
              definitionId: CATALOG_ID,
              quantity: 1,
            },
          })
          await db.characterCurrencyBalance.create({
            data: {
              id: CB_ID,
              characterId: CA_ID,
              definitionId: CATALOG_ID,
              amount: 5,
            },
          })
          const offer = await db.skillOffer.create({
            data: {
              id: `${CA_ID}-offer`,
              characterId: CA_ID,
              track: "class",
              level: 1,
              choiceGroup: "standard",
            },
          })
          await db.skillOfferOption.create({
            data: {
              id: `${CA_ID}-opt`,
              offerId: offer.id,
              definitionId: CATALOG_ID,
              nameSnapshot: "dc-option",
              configSnapshot: {},
            },
          })
          // A portrait asset for the sibling to prove it survives.
          await db.asset.create({
            data: {
              id: `${CB}-asset`,
              kind: "character-avatar",
              url: "/keep.png",
              characterId: CB,
            },
          })
        } finally {
          await db.$disconnect()
        }

        const env = {
          ...(process.env as Record<string, string>),
          DATABASE_URL: integrationUrl!,
        }

        // Preview: no deletion, counts the full dependent set.
        const previewLogs: string[] = []
        const preview = await main({
          env,
          argv: ["--id", CA_ID],
          log: (m: string) => previewLogs.push(m),
          errLog: () => {},
        })
        expect(preview.status, `preview failed: ${preview.error ?? "?"}`).toBe(
          "ok"
        )
        expect(preview.preview?.counts).toEqual({
          assets: 1,
          events: 1,
          associations: 1,
          inventory: 1,
          currencyBalances: 1,
          skillOffers: 1,
          skillOfferOptions: 1,
        })
        expect(previewLogs.join("\n")).toMatch(/name:\s+DeleteMe/)

        // Execute: hard-delete exactly this character.
        const delLogs: string[] = []
        const del = await main({
          env,
          argv: ["--id", CA_ID, "--execute", "--confirm", CA_ID],
          log: (m: string) => delLogs.push(m),
          errLog: () => {},
        })
        expect(del.status, `delete failed: ${del.error ?? "?"}`).toBe("ok")
        expect(del.deletedId).toBe(CA_ID)
        expect(delLogs.join("\n")).toMatch(/deleted character "dc-char-a"/)

        // Verify: the target and every dependent row are gone; the sibling is not.
        const verify = new PrismaClient({
          datasources: { db: { url: integrationUrl! } },
        })
        try {
          expect(
            await verify.character.findUnique({ where: { id: CA_ID } })
          ).toBeNull()
          expect(
            await verify.character.findUnique({ where: { id: CB } })
          ).not.toBeNull()
          expect(
            await verify.asset.findUnique({ where: { id: `${CA_ID}-asset` } })
          ).toBeNull()
          expect(
            await verify.asset.findUnique({ where: { id: `${CB}-asset` } })
          ).not.toBeNull()
          expect(
            await verify.progressionEvent.findUnique({
              where: { id: `${CA_ID}-event` },
            })
          ).toBeNull()
          expect(
            await verify.characterAssociation.findUnique({
              where: { id: `${CA_ID}-assoc` },
            })
          ).toBeNull()
          expect(
            await verify.characterInventoryItem.findUnique({
              where: { id: `${CA_ID}-inv` },
            })
          ).toBeNull()
          expect(
            await verify.characterCurrencyBalance.findUnique({
              where: { id: CB_ID },
            })
          ).toBeNull()
          expect(
            await verify.skillOffer.findUnique({
              where: { id: `${CA_ID}-offer` },
            })
          ).toBeNull()
          expect(
            await verify.skillOfferOption.findUnique({
              where: { id: `${CA_ID}-opt` },
            })
          ).toBeNull()
        } finally {
          await verify.$disconnect()
        }

        // Cleanup: remove only what this run created (FK-safe order).
        const clean = new PrismaClient({
          datasources: { db: { url: integrationUrl! } },
        })
        try {
          await clean.character.deleteMany({ where: { id: CB } })
          await clean.catalogDefinition.deleteMany({
            where: { id: CATALOG_ID },
          })
          await clean.user.deleteMany({ where: { id: USER_ID } })
        } finally {
          await clean.$disconnect()
        }
      }
    )
  }
)

/** Maintenance connection (same server/creds, `postgres` database). */
function maintenanceUrl(base: URL): string {
  const u = new URL(base.toString())
  u.pathname = "/postgres"
  return u.toString()
}
