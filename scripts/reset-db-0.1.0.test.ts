/**
 * Tests for the one-time destructive 0.1.0 PostgreSQL reset command
 * (`scripts/reset-db-0.1.0.mjs`).
 *
 * These are pure unit tests: they exercise the exported helpers, the preflight
 * classification logic, and the orchestration in `main()` with an injected mock DB,
 * a mock process runner, and a mock archive-check runner. No real Postgres is
 * touched, no `migrate reset` is spawned, and the default database is never
 * reset. The proof points are:
 *
 *   - every unsafe input fails BEFORE any child process is spawned
 *     (mismatched host/db, non-public schema, unknown query param, weak admin,
 *     missing/bad backup, forged archive, backup that lacks app objects,
 *     foreign object of any kind - function, view, index, schema - or an
 *     already-connected app), and
 *   - the success path spawns `migrate reset --force --skip-seed` BEFORE
 *     `db seed`, a nonzero exit from `migrate reset` stops before seeding, and
 *     every error AFTER the reset has started tells the operator to keep the app
 *     offline and restore the backup (never labelled "setup").
 *
 * An optional, explicitly-opted-in real-Postgres block (guarded by
 * `resolveDbIntegration`) runs only when `RUN_DB_INTEGRATION_TESTS=1`. It creates
 * a UNIQUE throwaway database on the target server, proves the backup with a real
 * `pg_restore --list`, and runs the ACTUAL CLI (`prisma migrate reset` +
 * `prisma db seed`) against that isolated database. It NEVER runs the reset on a
 * pre-existing `_test` database - it drops only the database it created.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PrismaClient } from "@prisma/client"
import {
  APP_CONSTRAINTS,
  APP_ENUMS,
  APP_INDEXES,
  APP_TABLES,
  APP_TRIGGERS,
  ARCHIVE_REQUIRED_DATA_OBJECTS,
  ARCHIVE_REQUIRED_OBJECTS,
  BASELINE_MIGRATION_NAME,
  PGDMP_HEADER,
  archiveHeaderDbname,
  assertArchiveContainsObjects,
  assertArchiveDbname,
  assertConfirm,
  assertTargetMatches,
  classifyForeignSchemas,
  classifyPublicObjects,
  confirmPhrase,
  main,
  parseDatabaseUrl,
  parseTargetHost,
  validateAdminEnv,
  validateBackupArchive,
  validateBackupFile,
  verifyTargetIdentity,
} from "./reset-db-0.1.0.mjs"
import { resolveDbIntegration } from "@/lib/test/db-integration"

// The real-Postgres block below runs only on explicit opt-in and against a
// disposable database that THIS test creates. Resolving the gate at module top is
// safe outside an opt-in run: it returns `{ run: false }` without touching the DB.
const dbIntegrationGate = await resolveDbIntegration()

// ------------------------------------------------------------------ //
// Test fixtures
// ------------------------------------------------------------------ //

/** A valid DATABASE_URL that matches the default target flags. */
const VALID_URL =
  "postgresql://postgres:postgres@localhost:5432/primal_creator?schema=public"

const TARGET_HOST = "localhost:5432"
const TARGET_DB = "primal_creator"

let tempDirs: string[] = []

beforeEach(() => {
  tempDirs = []
})

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "reset-db-0.1.0-"))
  tempDirs.push(dir)
  return dir
}

function makeBackupFile(size = 2048): string {
  const dir = tempDir()
  const path = join(dir, "backup.dump")
  const buffer = Buffer.alloc(size)
  // Custom-format pg_dump files begin with the literal "PGDMP" marker.
  buffer.write(PGDMP_HEADER, 0, "latin1")
  writeFileSync(path, buffer)
  return path
}

// ------------------------------------------------------------------ //
// Mock Prisma client + process runner
// ------------------------------------------------------------------ //

interface MockDbOptions {
  tables?: string[]
  catalogCount?: number
  adminCount?: number
  migrationRows?: Array<{ name: string; finished_at: Date | null }>
  houseActive?: boolean
  foreignObjects?: Array<{
    kind: string
    name: string
    relkind?: string
    table?: string | null
  }>
  functions?: Array<{ kind: string; name: string }>
  triggers?: Array<{ kind: string; name: string; table?: string | null }>
  indexes?: Array<{ kind: string; name: string; table?: string | null }>
  constraints?: Array<{ kind: string; name: string; table?: string | null }>
  extensions?: Array<{ extname: string }>
  schemas?: string[]
  sessions?: number
  canCreate?: boolean
  dbName?: string
  serverAddr?: string | null
  serverPort?: number | null
}

/**
 * A minimal stand-in for the Prisma client used by the script. It dispatches on
 * substrings of the raw SQL the script issues and never touches a real database.
 */
function mockDb(options: MockDbOptions = {}) {
  const {
    tables = [...APP_TABLES],
    catalogCount = 41,
    adminCount = 1,
    migrationRows = [
      { name: BASELINE_MIGRATION_NAME, finished_at: new Date() },
    ],
    houseActive = true,
    foreignObjects = [],
    functions = [],
    triggers = [],
    indexes = [],
    constraints = [],
    extensions = [],
    schemas = ["public", "pg_catalog", "information_schema", "pg_toast"],
    sessions = 0,
    canCreate = true,
    dbName = TARGET_DB,
    serverAddr = "127.0.0.1",
    serverPort = 5432,
  } = options
  const sqlLog: string[] = []
  return {
    sqlLog,
    async $queryRawUnsafe(sql: string): Promise<unknown[]> {
      sqlLog.push(sql)
      if (sql.includes("current_database() AS db"))
        return [{ db: dbName, addr: serverAddr, port: serverPort }]
      if (sql.includes("has_schema_privilege"))
        return [{ can_create: canCreate }]
      if (sql.includes("pg_catalog.pg_proc")) return functions
      if (sql.includes("pg_catalog.pg_trigger")) return triggers
      if (sql.includes("pg_catalog.pg_index")) return indexes
      if (sql.includes("pg_catalog.pg_constraint")) return constraints
      if (sql.includes("pg_catalog.pg_extension")) return extensions
      if (sql.includes("nspname AS name"))
        return schemas.map((name) => ({ name }))
      if (sql.includes("'relation' AS kind")) return foreignObjects
      if (sql.includes("pg_stat_activity")) return [{ n: sessions }]
      if (sql.includes("information_schema.tables"))
        return tables.map((name) => ({ table_name: name }))
      if (sql.includes('FROM "house_rules"'))
        return [{ n: houseActive ? 1 : 0 }]
      if (sql.includes('FROM "_prisma_migrations"')) return migrationRows
      if (sql.includes('FROM "catalog_definitions"'))
        return [{ n: catalogCount }]
      if (sql.includes('"users" WHERE "isAdmin"')) return [{ n: adminCount }]
      if (sql.includes("SELECT 1")) return [{}]
      throw new Error(`Unhandled SQL: ${sql}`)
    },
    async $disconnect(): Promise<undefined> {
      return undefined
    },
  }
}

interface RecordingRun {
  calls: Array<{ cmd: string; args: string[] }>
  run: (cmd: string, args: string[]) => Promise<{ code: number }>
}

/**
 * A mock child-process runner. It records every invocation and returns the
 * configured exit codes in order (default 0). Because `runPrisma` prepends the
 * resolved prisma bin path, the real CLI arguments are `args.slice(1)`.
 */
function recordingRun(codes: number[] = []): RecordingRun {
  const calls: Array<{ cmd: string; args: string[] }> = []
  const run = (cmd: string, args: string[]) => {
    calls.push({ cmd, args })
    const code = codes[calls.length - 1] ?? 0
    return Promise.resolve({ code })
  }
  return { calls, run }
}

// ------------------------------------------------------------------ //
// Archive-check fixtures (pg_restore --list)
// ------------------------------------------------------------------ //

/**
 * A realistic `pg_restore --list` listing. It carries the header metadata comment
 * naming the source database (`dbname: primal_creator`, matching VALID_URL),
 * the TABLE definitions for the three required app objects, and the TABLE DATA
 * entries. A real pg_restore output uses this exact shape.
 */
const VALID_ARCHIVE_LIST =
  [
    "; Archive created at 2026-01-01 00:00:00 UTC",
    ";     dbname: primal_creator",
    ";     TOC Entries: 12",
    ";     Compression: gzip",
    ";     Dump Version: 1.15-0",
    ";     Format: CUSTOM",
    ";",
    "; Selected TOC Entries:",
    ";",
    "217; 1259 41096 TABLE public _prisma_migrations postgres",
    "216; 1259 41089 TABLE public catalog_definitions postgres",
    "215; 1259 41082 TABLE public users postgres",
    "3460; 0 41096 TABLE DATA public _prisma_migrations postgres",
    "3459; 0 41089 TABLE DATA public catalog_definitions postgres",
    "3458; 0 41082 TABLE DATA public users postgres",
  ].join("\n") + "\n"

/** The listing above without the TABLE DATA entries (a schema-only dump). */
const SCHEMA_ONLY_ARCHIVE_LIST =
  [
    "; Archive created at 2026-01-01 00:00:00 UTC",
    ";     dbname: primal_creator",
    ";",
    "; Selected TOC Entries:",
    ";",
    "217; 1259 41096 TABLE public _prisma_migrations postgres",
    "216; 1259 41089 TABLE public catalog_definitions postgres",
    "215; 1259 41082 TABLE public users postgres",
  ].join("\n") + "\n"

/**
 * Build a pg_restore runner that dispatches on the subcommand so a single fake
 * can serve the `--list` pass, the `--data-only` pass, or both. This is the
 * "safe injectable runner" the validation needs: the unit tests never spawn a
 * real pg_restore, and the mocks return `{ code, stdout, stderr }`.
 */
function archiveRunner(
  listResult: { code: number; stdout: string; stderr: string },
  dataResult: { code: number; stdout: string; stderr: string }
) {
  const oops = (args: string[]) =>
    new Error(`unexpected pg_restore args: ${args.join(" ")}`)
  return (
    cmd: string,
    args: string[]
  ): Promise<{
    code: number
    stdout: string
    stderr: string
  }> => {
    if (args.includes("--list")) return Promise.resolve(listResult)
    if (args.includes("--data-only")) return Promise.resolve(dataResult)
    return Promise.reject(oops(args))
  }
}

/** A fake archive-check runner that reports a valid, usable archive. */
function validArchiveRunner() {
  return archiveRunner(
    { code: 0, stdout: VALID_ARCHIVE_LIST, stderr: "" },
    { code: 0, stdout: "", stderr: "" }
  )
}

/** A fake archive-check runner that mimics a corrupt/forged archive. */
function forgedArchiveRunner() {
  return archiveRunner(
    { code: 1, stdout: "", stderr: "corrupt" },
    { code: 1, stdout: "", stderr: "corrupt" }
  )
}

/** A fake archive-check runner that reads an archive missing app objects. */
function incompleteArchiveRunner() {
  return archiveRunner(
    { code: 0, stdout: "TABLE public users postgres\n", stderr: "" },
    { code: 0, stdout: "", stderr: "" }
  )
}

/** A fake runner for a schema-only dump (TABLE defs, no TABLE DATA). */
function schemaOnlyArchiveRunner() {
  return archiveRunner(
    { code: 0, stdout: SCHEMA_ONLY_ARCHIVE_LIST, stderr: "" },
    { code: 0, stdout: "", stderr: "" }
  )
}

/** A fake runner where the TOC lists fine but the data read is truncated. */
function truncatedDataArchiveRunner() {
  return archiveRunner(
    { code: 0, stdout: VALID_ARCHIVE_LIST, stderr: "" },
    { code: 1, stdout: "", stderr: "unexpected EOF in archive" }
  )
}

/** A fake runner for an archive created from a DIFFERENT database. */
function wrongDbnameArchiveRunner() {
  const list = VALID_ARCHIVE_LIST.replace(
    /dbname: primal_creator/,
    "dbname: another_db"
  )
  return archiveRunner(
    { code: 0, stdout: list, stderr: "" },
    {
      code: 0,
      stdout: "",
      stderr: "",
    }
  )
}

function silentLog(): (msg: string) => void {
  return () => {}
}

/** Build a valid env that passes every pre-deletion check by default. */
function baseEnv(
  overrides: Record<string, string | undefined> = {}
): Record<string, string> {
  return {
    DATABASE_URL: VALID_URL,
    NODE_ENV: "test",
    ADMIN_EMAIL: "admin@primal.local",
    ADMIN_PASSWORD: "not-a-weak-password",
    ...overrides,
  } as Record<string, string>
}

/** The standard argv set that targets the default test database. */
function standardArgv(overrides: Record<string, string> = {}): string[] {
  return [
    "--target-host",
    overrides["--target-host"] ?? TARGET_HOST,
    "--target-db",
    overrides["--target-db"] ?? TARGET_DB,
    "--confirm",
    overrides["--confirm"] ?? confirmPhrase(TARGET_DB),
    "--backup-file",
    overrides["--backup-file"] ?? makeBackupFile(),
  ]
}

// ------------------------------------------------------------------ //
// Pure helper tests
// ------------------------------------------------------------------ //

describe("parseDatabaseUrl / parseTargetHost / assertTargetMatches", () => {
  it("parses a valid postgres URL and matches the explicit target", () => {
    const info = parseDatabaseUrl(VALID_URL)
    expect(info.hostname).toBe("localhost")
    expect(info.port).toBe("5432")
    expect(info.dbname).toBe(TARGET_DB)
    expect(info.schema).toBe("public")
    expect(() =>
      assertTargetMatches(info, TARGET_HOST, TARGET_DB)
    ).not.toThrow()
  })

  it("rejects a non-PostgreSQL scheme", () => {
    expect(() => parseDatabaseUrl("mysql://user:pass@host/db")).toThrow(
      /must be a PostgreSQL URL/
    )
  })

  it("rejects a non-public schema", () => {
    expect(() =>
      parseDatabaseUrl("postgresql://u:p@h:5432/db?schema=other")
    ).toThrow(/schema must be "public"/)
  })

  it("rejects a multi-segment pathname", () => {
    expect(() =>
      parseDatabaseUrl("postgresql://u:p@h:5432/db/something")
    ).toThrow(/exactly one database/)
  })

  it("rejects a missing / empty database name", () => {
    expect(() => parseDatabaseUrl("postgresql://u:p@h:5432/")).toThrow(
      /exactly one database/
    )
  })

  it("rejects a malformed URL", () => {
    expect(() => parseDatabaseUrl("not a url")).toThrow(/valid URL/)
  })

  it("rejects a missing DATABASE_URL", () => {
    expect(() => parseDatabaseUrl("")).toThrow(/DATABASE_URL must be set/)
  })

  it("rejects unknown/routing query parameters", () => {
    expect(() =>
      parseDatabaseUrl("postgresql://u:p@h:5432/db?host=/var/run/postgresql")
    ).toThrow(/unsupported query parameter/)
    expect(() =>
      parseDatabaseUrl("postgresql://u:p@h:5432/db?application_name=x")
    ).toThrow(/unsupported query parameter/)
  })

  it("accepts schema=public, connection_limit and the TLS options", () => {
    const info = parseDatabaseUrl(
      "postgresql://u:p@h:5432/db?schema=public&connection_limit=1&sslmode=require&sslcert=/certs/client.pem&sslrootcert=/certs/root.pem"
    )
    expect(info.schema).toBe("public")
    expect(info.hostname).toBe("h")
    expect(info.port).toBe("5432")
  })

  it("accepts every valid sslmode value", () => {
    for (const mode of [
      "disable",
      "require",
      "prefer",
      "verify-ca",
      "verify-full",
    ]) {
      expect(() =>
        parseDatabaseUrl(`postgresql://u:p@h:5432/db?sslmode=${mode}`)
      ).not.toThrow()
    }
  })

  it("rejects an invalid sslmode value", () => {
    expect(() =>
      parseDatabaseUrl("postgresql://u:p@h:5432/db?sslmode=verify_ca")
    ).toThrow(/sslmode must be one of/)
    expect(() =>
      parseDatabaseUrl("postgresql://u:p@h:5432/db?sslmode=bogus")
    ).toThrow(/sslmode must be one of/)
  })

  it("rejects a duplicate query parameter", () => {
    expect(() =>
      parseDatabaseUrl("postgresql://u:p@h:5432/db?schema=public&schema=public")
    ).toThrow(/more than once/)
    expect(() =>
      parseDatabaseUrl(
        "postgresql://u:p@h:5432/db?connection_limit=1&connection_limit=2"
      )
    ).toThrow(/more than once/)
  })

  it("parses target host and flags a host/port/db mismatch", () => {
    expect(parseTargetHost("db.internal:5544")).toEqual({
      hostname: "db.internal",
      port: "5544",
    })
    expect(parseTargetHost("localhost")).toEqual({
      hostname: "localhost",
      port: "",
    })
    expect(parseTargetHost("[::1]:5432")).toEqual({
      hostname: "::1",
      port: "5432",
    })

    const info = parseDatabaseUrl(VALID_URL)
    expect(() =>
      assertTargetMatches(info, "otherhost:5432", TARGET_DB)
    ).toThrow(/does not match DATABASE_URL host/)
    expect(() => assertTargetMatches(info, "localhost", TARGET_DB)).toThrow(
      /does not match DATABASE_URL host|uses port/
    )
    expect(() => assertTargetMatches(info, TARGET_HOST, "other_db")).toThrow(
      /does not match the database/
    )
  })
})

describe("confirm phrase", () => {
  it("builds the exact phrase and enforces it", () => {
    expect(confirmPhrase(TARGET_DB)).toBe(`DELETE ${TARGET_DB} FOR 0.1.0`)
    expect(() =>
      assertConfirm(`DELETE ${TARGET_DB} FOR 0.1.0`, TARGET_DB)
    ).not.toThrow()
    expect(() => assertConfirm("nope", TARGET_DB)).toThrow(/--confirm/)
  })
})

describe("validateAdminEnv", () => {
  it("requires a nonempty admin email", () => {
    expect(() =>
      validateAdminEnv({ NODE_ENV: "test", ADMIN_PASSWORD: "x" })
    ).toThrow(/ADMIN_EMAIL must be set/)
  })

  it("requires a nonempty admin password", () => {
    expect(() =>
      validateAdminEnv({ NODE_ENV: "test", ADMIN_EMAIL: "a@b.test" })
    ).toThrow(/ADMIN_PASSWORD must be set/)
  })

  it("never interpolates the admin password into an error", () => {
    expect.assertions(2)
    let msg = ""
    try {
      validateAdminEnv({
        NODE_ENV: "production",
        ADMIN_EMAIL: "a@b.test",
        ADMIN_PASSWORD: "admin",
      })
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err)
    }
    expect(msg).toMatch(/weak\/placeholder/)
    expect(msg).not.toContain("admin")
  })

  it("allows a short dev password outside production", () => {
    expect(() =>
      validateAdminEnv({
        NODE_ENV: "test",
        ADMIN_EMAIL: "a@b.test",
        ADMIN_PASSWORD: "admin",
      })
    ).not.toThrow()
  })

  it("rejects a weak password in production even when long enough", () => {
    expect(() =>
      validateAdminEnv({
        NODE_ENV: "production",
        ADMIN_EMAIL: "a@b.test",
        ADMIN_PASSWORD: "admin",
      })
    ).toThrow(/weak\/placeholder/)
  })

  it("rejects a short password in production", () => {
    expect(() =>
      validateAdminEnv({
        NODE_ENV: "production",
        ADMIN_EMAIL: "a@b.test",
        ADMIN_PASSWORD: "short",
      })
    ).toThrow(/at least 12 characters/)
  })

  it("accepts a strong password in production", () => {
    expect(() =>
      validateAdminEnv({
        NODE_ENV: "production",
        ADMIN_EMAIL: "a@b.test",
        ADMIN_PASSWORD: "correct-horse-battery-123",
      })
    ).not.toThrow()
  })

  it("honors an explicit non-production override for isolated tests", () => {
    expect(() =>
      validateAdminEnv(
        {
          NODE_ENV: "production",
          ADMIN_EMAIL: "a@b.test",
          ADMIN_PASSWORD: "admin",
        },
        { forceProduction: false }
      )
    ).not.toThrow()
  })
})

describe("validateBackupFile", () => {
  it("accepts a regular nonempty file with the PGDMP header", () => {
    const file = makeBackupFile()
    expect(() => validateBackupFile(file)).not.toThrow()
  })

  it("rejects a missing file", () => {
    expect(() => validateBackupFile("/no/such/backup.dump")).toThrow(
      /does not exist/
    )
  })

  it("rejects a file without the custom-format header", () => {
    const dir = tempDir()
    const path = join(dir, "plain.sql")
    writeFileSync(path, Buffer.alloc(2048, 0x20)) // spaces, not PGDMP
    expect(() => validateBackupFile(path)).toThrow(/PGDMP/)
  })

  it("rejects an undersized file", () => {
    const dir = tempDir()
    const path = join(dir, "tiny.dump")
    const buf = Buffer.alloc(32)
    buf.write(PGDMP_HEADER, 0, "latin1")
    writeFileSync(path, buf)
    expect(() => validateBackupFile(path)).toThrow(/smaller than/)
  })

  it("rejects a directory (not a regular file)", () => {
    const dir = tempDir()
    expect(() => validateBackupFile(dir)).toThrow(/not a regular file/)
  })
})

describe("assertArchiveContainsObjects", () => {
  it("accepts a listing that contains every required app object AND data", () => {
    expect(() => assertArchiveContainsObjects(VALID_ARCHIVE_LIST)).not.toThrow()
  })

  it("rejects a schema-only listing (TABLE defs but no TABLE DATA)", () => {
    expect(() =>
      assertArchiveContainsObjects(SCHEMA_ONLY_ARCHIVE_LIST)
    ).toThrow(/TABLE DATA/)
  })

  it("rejects a listing missing a required app object", () => {
    const list =
      "TABLE public users postgres\nTABLE public catalog_definitions postgres\n"
    expect(() => assertArchiveContainsObjects(list)).toThrow(
      /_prisma_migrations/
    )
    expect(ARCHIVE_REQUIRED_OBJECTS).toContain("_prisma_migrations")
  })

  it("rejects an empty listing", () => {
    expect(() => assertArchiveContainsObjects("; ;")).toThrow(
      /no object listing/
    )
  })

  it("requires the data objects to be exactly the content tables", () => {
    expect(ARCHIVE_REQUIRED_DATA_OBJECTS).toContain("users")
    expect(ARCHIVE_REQUIRED_DATA_OBJECTS).toContain("catalog_definitions")
  })
})

describe("archiveHeaderDbname / assertArchiveDbname", () => {
  it("extracts the recorded dbname from the pg_restore header", () => {
    expect(archiveHeaderDbname(VALID_ARCHIVE_LIST)).toBe("primal_creator")
    expect(archiveHeaderDbname(SCHEMA_ONLY_ARCHIVE_LIST)).toBe("primal_creator")
  })

  it("returns null when the archive header carries no dbname", () => {
    expect(archiveHeaderDbname("TABLE public users postgres\n")).toBeNull()
  })

  it("accepts a matching dbname and skips when the header has none", () => {
    expect(() =>
      assertArchiveDbname(VALID_ARCHIVE_LIST, "primal_creator")
    ).not.toThrow()
    expect(() =>
      assertArchiveDbname("TABLE public users postgres\n", "primal_creator")
    ).not.toThrow()
  })

  it("rejects an archive recorded from a different database", () => {
    expect(() => assertArchiveDbname(VALID_ARCHIVE_LIST, "another_db")).toThrow(
      /created from database "primal_creator"/
    )
  })
})

describe("validateBackupArchive", () => {
  it("passes verification when both --list and --data-only exit 0", async () => {
    const run = validArchiveRunner()
    await expect(
      validateBackupArchive({
        path: "/x.dump",
        run,
        expectedDbname: "primal_creator",
      })
    ).resolves.toBeUndefined()
  })

  it("skips the dbname check when expectedDbname is omitted", async () => {
    const run = validArchiveRunner()
    await expect(
      validateBackupArchive({ path: "/x.dump", run })
    ).resolves.toBeUndefined()
  })

  it("fails when pg_restore --list exits nonzero", async () => {
    const run = forgedArchiveRunner()
    await expect(
      validateBackupArchive({ path: "/x.dump", run })
    ).rejects.toThrow(/not a readable pg_dump/)
  })

  it("fails when pg_restore is unavailable", async () => {
    const run = async () => {
      throw new Error("spawn pg_restore ENOENT")
    }
    await expect(
      validateBackupArchive({ path: "/x.dump", run })
    ).rejects.toThrow(/pg_restore could not be run/)
  })

  it("fails when the archive lacks the app schema objects", async () => {
    const run = incompleteArchiveRunner()
    await expect(
      validateBackupArchive({ path: "/x.dump", run })
    ).rejects.toThrow(/does not contain app schema object/)
  })

  it("rejects a schema-only archive (no TABLE DATA) even though the TOC reads fine", async () => {
    const run = schemaOnlyArchiveRunner()
    await expect(
      validateBackupArchive({ path: "/x.dump", run })
    ).rejects.toThrow(/TABLE DATA/)
  })

  it("rejects a truncated archive when --data-only cannot read all data", async () => {
    const run = truncatedDataArchiveRunner()
    await expect(
      validateBackupArchive({ path: "/x.dump", run })
    ).rejects.toThrow(/truncated or corrupt/)
  })

  it("rejects an archive recorded from a different database", async () => {
    const run = wrongDbnameArchiveRunner()
    await expect(
      validateBackupArchive({
        path: "/x.dump",
        run,
        expectedDbname: "primal_creator",
      })
    ).rejects.toThrow(/created from database/)
  })
})

describe("classifyPublicObjects", () => {
  /** Every object a real baseline (or an old 0001..0023 chain) database holds. */
  const baselineRows = [
    ...APP_TABLES.map((name) => ({
      kind: "relation",
      name,
      relkind: "r",
      table: null,
    })),
    {
      kind: "relation",
      name: "_prisma_migrations",
      relkind: "r",
      table: null,
    },
    ...APP_ENUMS.map((name) => ({
      kind: "type",
      name,
      relkind: null,
      table: null,
    })),
    ...APP_TABLES.map((name) => ({
      kind: "type",
      name,
      relkind: null,
      table: null,
    })),
    { kind: "type", name: "_prisma_migrations", relkind: null, table: null },
  ]
  const indexRows = Object.entries(APP_INDEXES).flatMap(([table, names]) =>
    names.map((name) => ({ kind: "index", name, relkind: null, table }))
  )
  const constraintRows = Object.entries(APP_CONSTRAINTS).flatMap(
    ([table, names]) =>
      names.map((name) => ({ kind: "constraint", name, relkind: null, table }))
  )

  it("passes the complete real baseline object set (tables, enums, indexes, constraints)", () => {
    expect(
      classifyPublicObjects([...baselineRows, ...indexRows, ...constraintRows])
    ).toEqual([])
  })

  it("passes the archived 0001..0023 chain object set (superset allows it)", () => {
    // The old chain is a SUBSET of the baseline: it omits the
    // `_prisma_migrations_pkey` index/constraint Prisma adds when it creates the
    // tracking table. The preflight must accept it as well.
    const oldIndexRows = indexRows.filter(
      (r) => r.name !== "_prisma_migrations_pkey"
    )
    const oldConstraintRows = constraintRows.filter(
      (r) => r.name !== "_prisma_migrations_pkey"
    )
    expect(
      classifyPublicObjects([
        ...baselineRows,
        ...oldIndexRows,
        ...oldConstraintRows,
      ])
    ).toEqual([])
  })

  it("flags unknown relations, sequences and types", () => {
    const unknown = classifyPublicObjects([
      {
        kind: "relation",
        name: "someone_elses_table",
        relkind: "r",
        table: null,
      },
      { kind: "sequence", name: "somesequence", relkind: "S", table: null },
      { kind: "type", name: "some_type", relkind: null, table: null },
      { kind: "relation", name: "users", relkind: "r", table: null }, // known
    ])
    expect(unknown).toContain("someone_elses_table (table)")
    expect(unknown).toContain("somesequence (sequence)")
    expect(unknown).toContain("some_type (type)")
    expect(unknown).not.toContain("users (table)")
  })

  it("never whitelists a view by name alone", () => {
    const unknown = classifyPublicObjects([
      { kind: "relation", name: "users", relkind: "v", table: null },
    ])
    expect(unknown).toContain("users (view)")
  })

  it("flags public functions as foreign", () => {
    const unknown = classifyPublicObjects([
      { kind: "function", name: "myfn", relkind: null, table: null },
    ])
    expect(unknown).toContain("myfn (function)")
  })

  it("rejects an extra index attached to a known table", () => {
    const unknown = classifyPublicObjects([
      { kind: "index", name: "users_extra_idx", relkind: null, table: "users" },
    ])
    expect(unknown).toContain("users_extra_idx (index on users)")
  })

  it("rejects an extra constraint attached to a known table", () => {
    const unknown = classifyPublicObjects([
      {
        kind: "constraint",
        name: "users_extra_fk",
        relkind: null,
        table: "users",
      },
    ])
    expect(unknown).toContain("users_extra_fk (constraint on users)")
  })

  it("rejects a user trigger attached to a known table", () => {
    // The application ships no user triggers, so the whitelist is empty and any
    // non-internal trigger is foreign.
    expect(APP_TRIGGERS).toEqual({})
    const unknown = classifyPublicObjects([
      { kind: "trigger", name: "updated_at", relkind: null, table: "users" },
    ])
    expect(unknown).toContain("updated_at (trigger on users)")
  })

  it("rejects indexes/constraints/triggers attached to an unknown table", () => {
    const unknown = classifyPublicObjects([
      { kind: "index", name: "ghost_idx", relkind: null, table: "ghost" },
      { kind: "constraint", name: "ghost_fk", relkind: null, table: "ghost" },
      { kind: "trigger", name: "ghost_trg", relkind: null, table: "ghost" },
    ])
    expect(unknown).toContain("ghost_idx (index on ghost)")
    expect(unknown).toContain("ghost_fk (constraint on ghost)")
    expect(unknown).toContain("ghost_trg (trigger on ghost)")
  })

  it("rejects an unknown object kind", () => {
    const unknown = classifyPublicObjects([
      { kind: "policy", name: "row_policy", relkind: null, table: null },
    ])
    expect(unknown).toContain("row_policy (policy)")
  })
})

describe("classifyForeignSchemas", () => {
  it("treats system/temp schemas as allowed and other schemas as foreign", () => {
    expect(
      classifyForeignSchemas([
        "public",
        "pg_catalog",
        "information_schema",
        "pg_toast",
        "pg_temp_3",
        "pg_toast_temp_3",
        "app",
      ])
    ).toEqual(["app"])
  })
})

describe("verifyTargetIdentity", () => {
  it("accepts a matching database name regardless of reported address/port", () => {
    // The server may report an address/port that differs from the URL behind a
    // NAT, tunnel or proxy; only current_database() is authoritative.
    expect(() =>
      verifyTargetIdentity(
        { db: "primal_creator", addr: "10.0.0.5", port: 6432 },
        { dbname: "primal_creator", hostname: "localhost", port: "5432" }
      )
    ).not.toThrow()
  })

  it("rejects a database-name mismatch", () => {
    expect(() =>
      verifyTargetIdentity(
        { db: "other", addr: "127.0.0.1", port: 5432 },
        { dbname: "primal_creator" }
      )
    ).toThrow(/connected to database/)
  })

  it("ignores a mismatched port and address (NAT/tunnel setups)", () => {
    expect(() =>
      verifyTargetIdentity(
        { db: "primal_creator", addr: "127.0.0.1", port: 5432 },
        { dbname: "primal_creator", hostname: "localhost", port: "5555" }
      )
    ).not.toThrow()
  })

  it("accepts socket connections (null address/port)", () => {
    expect(() =>
      verifyTargetIdentity(
        { db: "primal_creator", addr: null, port: null },
        { dbname: "primal_creator", hostname: "localhost", port: "" }
      )
    ).not.toThrow()
  })

  it("rejects a missing identity row", () => {
    expect(() =>
      verifyTargetIdentity(null, { dbname: "primal_creator" })
    ).toThrow(/Could not read the target database identity/)
  })
})

// ------------------------------------------------------------------ //
// Orchestration: every unsafe input fails before any spawn
// ------------------------------------------------------------------ //

const BASELINE_ARGS = ["migrate", "reset", "--force", "--skip-seed"]
const SEED_ARGS = ["db", "seed"]

describe("main() pre-deletion safety", () => {
  function expectNoSpawn(result: { status: string }, runner: RecordingRun) {
    expect(result.status).toBe("failed")
    expect(runner.calls.length).toBe(0)
  }

  async function runMain(opts: {
    env?: Record<string, string>
    argv?: string[]
    run?: RecordingRun["run"]
    runArchive?: (cmd: string, args: string[]) => Promise<unknown>
    createDb?: () => unknown
    errLog?: (msg: string) => void
  }) {
    return main({
      env: opts.env ?? baseEnv(),
      argv: opts.argv ?? standardArgv(),
      run: opts.run ?? recordingRun().run,
      runArchive: opts.runArchive ?? validArchiveRunner(),
      createDb: opts.createDb ?? (() => mockDb()),
      log: silentLog(),
      errLog: opts.errLog ?? silentLog(),
    })
  }

  it("fails on a mismatched host before any spawn", async () => {
    const runner = recordingRun()
    const result = await runMain({
      env: baseEnv(),
      argv: standardArgv({ "--target-host": "wronghost:5432" }),
      run: runner.run,
    })
    expectNoSpawn(result, runner)
  })

  it("fails on a mismatched database before any spawn", async () => {
    const runner = recordingRun()
    const result = await runMain({
      env: baseEnv(),
      argv: standardArgv({
        "--target-db": "other_db",
        "--confirm": confirmPhrase("other_db"),
      }),
      run: runner.run,
    })
    expectNoSpawn(result, runner)
  })

  it("fails on a non-public schema before any spawn", async () => {
    const runner = recordingRun()
    const result = await runMain({
      env: baseEnv({
        DATABASE_URL:
          "postgresql://postgres:postgres@localhost:5432/primal_creator?schema=archive",
      }),
      run: runner.run,
    })
    expectNoSpawn(result, runner)
  })

  it("fails on an unknown query parameter before any spawn", async () => {
    const runner = recordingRun()
    const result = await runMain({
      env: baseEnv({
        DATABASE_URL:
          "postgresql://postgres:postgres@localhost:5432/primal_creator?schema=public&application_name=app",
      }),
      run: runner.run,
    })
    expectNoSpawn(result, runner)
  })

  it("passes a URL carrying a TLS sslmode option before any spawn", async () => {
    const runner = recordingRun([0, 0])
    const result = await runMain({
      env: baseEnv({
        DATABASE_URL:
          "postgresql://postgres:postgres@localhost:5432/primal_creator?schema=public&sslmode=require",
      }),
      run: runner.run,
    })
    expect(result.status).toBe("ok")
    expect(runner.calls.length).toBe(2)
  })

  it("fails on a weak production admin password before any spawn, even in NODE_ENV=test", async () => {
    const runner = recordingRun()
    const result = await runMain({
      env: baseEnv({ NODE_ENV: "test", ADMIN_PASSWORD: "admin" }),
      run: runner.run,
    })
    expectNoSpawn(result, runner)
  })

  it("fails on a missing admin email before any spawn", async () => {
    const runner = recordingRun()
    const result = await runMain({
      env: baseEnv({ ADMIN_EMAIL: "" }),
      run: runner.run,
    })
    expectNoSpawn(result, runner)
  })

  it("fails on a wrong --confirm phrase before any spawn", async () => {
    const runner = recordingRun()
    const result = await runMain({
      argv: standardArgv({ "--confirm": "DELETE wrong FOR 0.1.0" }),
      run: runner.run,
    })
    expectNoSpawn(result, runner)
  })

  it("fails on a missing backup file before any spawn", async () => {
    const runner = recordingRun()
    const result = await runMain({
      argv: standardArgv({ "--backup-file": "/no/such/backup.dump" }),
      run: runner.run,
    })
    expectNoSpawn(result, runner)
  })

  it("fails on a backup with a bad header before any spawn", async () => {
    const runner = recordingRun()
    const dir = tempDir()
    const path = join(dir, "bad.dump")
    writeFileSync(path, Buffer.alloc(2048, 0x20))
    const result = await runMain({
      argv: standardArgv({ "--backup-file": path }),
      run: runner.run,
    })
    expectNoSpawn(result, runner)
  })

  it("fails on a forged archive (PGDMP header, pg_restore --list nonzero) before any spawn", async () => {
    const runner = recordingRun()
    const result = await runMain({
      run: runner.run,
      runArchive: forgedArchiveRunner(),
    })
    expectNoSpawn(result, runner)
  })

  it("fails when the backup archive is missing app objects before any spawn", async () => {
    const runner = recordingRun()
    const result = await runMain({
      run: runner.run,
      runArchive: incompleteArchiveRunner(),
    })
    expectNoSpawn(result, runner)
  })

  it("fails before any spawn when a bad backup is supplied to a no-op reset", async () => {
    const runner = recordingRun()
    const result = await runMain({
      run: runner.run,
      runArchive: async () => ({ code: 1, stdout: "", stderr: "bad" }),
    })
    expectNoSpawn(result, runner)
  })

  it("fails on a foreign public-schema object before any spawn", async () => {
    const runner = recordingRun()
    const result = await runMain({
      run: runner.run,
      createDb: () =>
        mockDb({
          foreignObjects: [
            { kind: "relation", name: "geo_table", relkind: "r", table: null },
          ],
        }),
    })
    expectNoSpawn(result, runner)
  })

  it("fails on a foreign view before any spawn", async () => {
    const runner = recordingRun()
    const result = await runMain({
      run: runner.run,
      createDb: () =>
        mockDb({
          foreignObjects: [
            { kind: "relation", name: "users", relkind: "v", table: null },
          ],
        }),
    })
    expectNoSpawn(result, runner)
  })

  it("fails on a foreign public function before any spawn", async () => {
    const runner = recordingRun()
    const result = await runMain({
      run: runner.run,
      createDb: () =>
        mockDb({ functions: [{ kind: "function", name: "myfn" }] }),
    })
    expectNoSpawn(result, runner)
  })

  it("fails on a foreign index attached to an unknown table before any spawn", async () => {
    const runner = recordingRun()
    const result = await runMain({
      run: runner.run,
      createDb: () =>
        mockDb({
          indexes: [{ kind: "index", name: "ghost_idx", table: "ghost" }],
        }),
    })
    expectNoSpawn(result, runner)
  })

  it("fails on a foreign constraint attached to an unknown table before any spawn", async () => {
    const runner = recordingRun()
    const result = await runMain({
      run: runner.run,
      createDb: () =>
        mockDb({
          constraints: [
            { kind: "constraint", name: "ghost_fk", table: "ghost" },
          ],
        }),
    })
    expectNoSpawn(result, runner)
  })

  it("fails on a foreign non-system schema before any spawn", async () => {
    const runner = recordingRun()
    const result = await runMain({
      run: runner.run,
      createDb: () =>
        mockDb({
          schemas: [
            "public",
            "pg_catalog",
            "information_schema",
            "pg_toast",
            "app",
          ],
        }),
    })
    expectNoSpawn(result, runner)
  })

  it("fails when another app session is already connected before any spawn", async () => {
    const runner = recordingRun()
    const result = await runMain({
      run: runner.run,
      createDb: () => mockDb({ sessions: 1 }),
    })
    expectNoSpawn(result, runner)
  })

  it("fails when the user cannot CREATE in public before any spawn", async () => {
    const runner = recordingRun()
    const result = await runMain({
      run: runner.run,
      createDb: () => mockDb({ canCreate: false }),
    })
    expectNoSpawn(result, runner)
  })

  it("fails when the live database identity does not match before any spawn", async () => {
    const runner = recordingRun()
    const result = await runMain({
      run: runner.run,
      createDb: () => mockDb({ dbName: "wrong_db" }),
    })
    expectNoSpawn(result, runner)
  })

  it("requires the four flags and rejects a missing one", async () => {
    const runner = recordingRun()
    const result = await runMain({
      argv: ["--target-host", TARGET_HOST, "--target-db", TARGET_DB],
      run: runner.run,
    })
    expectNoSpawn(result, runner)
  })

  it("rejects an unknown flag before any spawn", async () => {
    const runner = recordingRun()
    const result = await runMain({
      argv: [...standardArgv(), "--bogus", "x"],
      run: runner.run,
    })
    expectNoSpawn(result, runner)
  })

  it("rejects a duplicate flag before any spawn", async () => {
    const runner = recordingRun()
    const result = await runMain({
      argv: [...standardArgv(), "--target-db", TARGET_DB],
      run: runner.run,
    })
    expectNoSpawn(result, runner)
  })

  it("rejects a positional argument before any spawn", async () => {
    const runner = recordingRun()
    const result = await runMain({
      argv: [...standardArgv(), "stray"],
      run: runner.run,
    })
    expectNoSpawn(result, runner)
  })

  it("rejects a stray -- separator before any spawn", async () => {
    const runner = recordingRun()
    const result = await runMain({
      argv: [...standardArgv(), "--"],
      run: runner.run,
    })
    expectNoSpawn(result, runner)
  })

  it("accepts a single leading -- separator", async () => {
    const runner = recordingRun([0, 0])
    const result = await runMain({
      argv: ["--", ...standardArgv()],
      run: runner.run,
    })
    expect(result.status).toBe("ok")
    expect(runner.calls.length).toBe(2)
  })
})

// ------------------------------------------------------------------ //
// Orchestration: success command order and nonzero fail-stop
// ------------------------------------------------------------------ //

describe("main() command sequencing", () => {
  it("runs migrate reset before db seed and reports success", async () => {
    const runner = recordingRun([0, 0])
    const result = await main({
      env: baseEnv(),
      argv: standardArgv(),
      run: runner.run,
      runArchive: validArchiveRunner(),
      createDb: () => mockDb(),
      log: silentLog(),
      errLog: silentLog(),
    })
    expect(result.status).toBe("ok")
    expect(runner.calls.length).toBe(2)
    expect(runner.calls[0].args.slice(1)).toEqual(BASELINE_ARGS)
    expect(runner.calls[1].args.slice(1)).toEqual(SEED_ARGS)
  })

  it("returns a failed status and does not seed when migrate reset exits nonzero", async () => {
    const runner = recordingRun([1])
    const result = await main({
      env: baseEnv(),
      argv: standardArgv(),
      run: runner.run,
      runArchive: validArchiveRunner(),
      createDb: () => mockDb(),
      log: silentLog(),
      errLog: silentLog(),
    })
    expect(result.status).toBe("failed")
    expect(result.step).toBe("migrate-reset")
    expect(runner.calls.length).toBe(1)
    expect(runner.calls[0].args.slice(1)).toEqual(BASELINE_ARGS)
  })

  it("returns a failed status when db seed exits nonzero", async () => {
    const runner = recordingRun([0, 2])
    const result = await main({
      env: baseEnv(),
      argv: standardArgv(),
      run: runner.run,
      runArchive: validArchiveRunner(),
      createDb: () => mockDb(),
      log: silentLog(),
      errLog: silentLog(),
    })
    expect(result.status).toBe("failed")
    expect(result.step).toBe("seed")
    expect(runner.calls.length).toBe(2)
    expect(runner.calls[0].args.slice(1)).toEqual(BASELINE_ARGS)
    expect(runner.calls[1].args.slice(1)).toEqual(SEED_ARGS)
  })

  it("fails verification and keeps the app offline when the catalog did not seed", async () => {
    const runner = recordingRun([0, 0])
    const logs: string[] = []
    const result = await main({
      env: baseEnv(),
      argv: standardArgv(),
      run: runner.run,
      runArchive: validArchiveRunner(),
      createDb: () => mockDb({ catalogCount: 5 }),
      log: silentLog(),
      errLog: (m: string) => logs.push(m),
    })
    expect(result.status).toBe("failed")
    expect(result.step).toBe("verify")
    expect(runner.calls.length).toBe(2)
    expect(logs.join("\n")).toMatch(/Keep the app offline/)
    expect(logs.join("\n")).toMatch(/pg_restore --clean/)
  })

  it("labels a post-reset thrown error as 'post-reset' with an offline + restore hint", async () => {
    const runner = recordingRun([0, 0])
    const logs: string[] = []
    let createCalls = 0
    const createDb = () => {
      createCalls++
      if (createCalls === 1) return mockDb()
      return {
        async $queryRawUnsafe() {
          throw new Error("boom during verify")
        },
        async $disconnect() {
          return undefined
        },
      }
    }
    const result = await main({
      env: baseEnv(),
      argv: standardArgv(),
      run: runner.run,
      runArchive: validArchiveRunner(),
      createDb,
      log: silentLog(),
      errLog: (m: string) => logs.push(m),
    })
    expect(result.status).toBe("failed")
    expect(result.step).toBe("post-reset")
    expect(logs.join("\n")).toMatch(/Keep the app offline/)
    expect(logs.join("\n")).toMatch(/pg_restore --clean/)
  })

  it("labels a pre-reset configuration error 'setup' (without an offline hint)", async () => {
    const runner = recordingRun()
    const logs: string[] = []
    const result = await main({
      env: baseEnv({ ADMIN_EMAIL: "" }),
      argv: standardArgv(),
      run: runner.run,
      runArchive: validArchiveRunner(),
      createDb: () => mockDb(),
      log: silentLog(),
      errLog: (m: string) => logs.push(m),
    })
    expect(result.status).toBe("failed")
    expect(result.step).toBe("setup")
    expect(logs.join("\n")).not.toMatch(/Keep the app offline/)
  })
})

// ------------------------------------------------------------------ //
// Optional real-Postgres integration (guarded; never runs by default)
// ------------------------------------------------------------------ //

interface SpawnResult {
  code: number
  stdout: string
  stderr: string
}

function spawnCapture(
  cmd: string,
  args: string[],
  opts: { env?: Record<string, string> } = {}
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("error", reject)
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

/** Connection string pointing at the `postgres` maintenance database. */
function maintenanceUrl(base: URL): string {
  const u = new URL(base.toString())
  u.pathname = "/postgres"
  return u.toString()
}

/**
 * A libpq-safe URI for pg_dump: it cannot parse Prisma-specific query params
 * (`schema`, `connection_limit`), so those are stripped.
 */
function pgDumpSafeUrl(base: URL): string {
  const u = new URL(base.toString())
  u.searchParams.delete("schema")
  u.searchParams.delete("connection_limit")
  return u.toString()
}

/**
 * Create and drop a UNIQUE throwaway database that only this test owns. The reset
 * is never run against a pre-existing `_test` database.
 */
function uniqueDbName(): string {
  return `reset_e2e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

describe.skipIf(!dbIntegrationGate.run)("real-Postgres reset (opt-in)", () => {
  it("resets an isolated unique database end-to-end with a real backup and the actual CLI", async () => {
    const { prisma } = await import("@/lib/db/client")
    // The lab Prisma singleton holds a live connection to the target DB; if it is
    // left open the script would mistake it for a still-running app session.
    await prisma.$disconnect()

    const baseUrl = new URL(process.env.DATABASE_URL!)
    const dbName = uniqueDbName()
    const uniqueUrl = new URL(baseUrl.toString())
    uniqueUrl.pathname = `/${dbName}`
    const uniqueUrlStr = uniqueUrl.toString()

    const admin = new PrismaClient({
      datasources: { db: { url: maintenanceUrl(baseUrl) } },
    })

    try {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`)
    } finally {
      await admin.$disconnect()
    }

    const backupFile = join(tempDir(), `backup-${dbName}.dump`)

    try {
      // Materialize the app schema objects so the pg_dump archive is a usable
      // backup (users, catalog_definitions, _prisma_migrations).
      const db = new PrismaClient({
        datasources: { db: { url: uniqueUrlStr } },
      })
      await db.$executeRawUnsafe(
        `CREATE TABLE public.users (id text PRIMARY KEY)`
      )
      await db.$executeRawUnsafe(
        `CREATE TABLE public.catalog_definitions (id text PRIMARY KEY)`
      )
      await db.$executeRawUnsafe(
        `CREATE TABLE public."_prisma_migrations" (id text)`
      )
      await db.$disconnect()

      // Prove the backup with the real pg_dump, then validate it the same way the
      // reset script does.
      const dump = await spawnCapture("pg_dump", [
        "-d",
        pgDumpSafeUrl(new URL(uniqueUrlStr)),
        "-Fc",
        "-f",
        backupFile,
      ])
      expect(dump.code, `pg_dump failed: ${dump.stderr}`).toBe(0)
      const restoreList = await spawnCapture("pg_restore", [
        "--list",
        backupFile,
      ])
      expect(restoreList.code, `pg_restore failed: ${restoreList.stderr}`).toBe(
        0
      )
      expect(restoreList.stdout).toMatch(/TABLE public users /)
      expect(restoreList.stdout).toMatch(/TABLE public catalog_definitions /)
      expect(restoreList.stdout).toMatch(/TABLE public _prisma_migrations /)

      const parsed = new URL(uniqueUrlStr)
      const targetHost = parsed.port
        ? `${parsed.hostname}:${parsed.port}`
        : parsed.hostname

      const env = {
        ...(process.env as Record<string, string>),
        DATABASE_URL: uniqueUrlStr,
        ADMIN_EMAIL: "admin@primal.local",
        ADMIN_PASSWORD: "reset-e2e-admin-password-123",
      }

      // Run the ACTUAL reset CLI against the unique database. No runner/archive
      // runner is injected, so `prisma migrate reset` + `prisma db seed` and the
      // real `pg_restore --list` backup check all run for real.
      const result = await main({
        env,
        argv: [
          "--target-host",
          targetHost,
          "--target-db",
          dbName,
          "--confirm",
          confirmPhrase(dbName),
          "--backup-file",
          backupFile,
        ],
        log: silentLog(),
        errLog: silentLog(),
      })

      expect(
        result.status,
        `reset failed: ${result.error ?? result.reason ?? "unknown"}`
      ).toBe("ok")
    } finally {
      const admin2 = new PrismaClient({
        datasources: { db: { url: maintenanceUrl(baseUrl) } },
      })
      try {
        await admin2.$executeRawUnsafe(
          `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`
        )
      } finally {
        await admin2.$disconnect()
      }
    }
  })
})
