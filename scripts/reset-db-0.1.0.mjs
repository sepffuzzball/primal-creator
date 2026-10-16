/**
 * One-time destructive 0.1.0 PostgreSQL reset.
 *
 * The 0.1.0 release collapses the 0001..0023 Prisma migration chain into a single
 * from-scratch baseline (`prisma/migrations/20261016000000_initial_0_1_0`). That
 * baseline's leading DO guard only runs against an EMPTY database: it refuses to
 * re-create when `_prisma_migrations` already records an applied migration or when
 * the public schema already holds any non-migration object. Because the guard
 * never drops anything, a database that was migrated with the old chain cannot be
 * upgraded by `prisma migrate deploy` - it must first be wiped and rebuilt.
 *
 * This command does exactly that, but ONLY as an explicit, opt-in, fail-closed
 * operation. It is never run automatically. It:
 *
 *   1. Parses the four required CLI flags (no defaults).
 *   2. Validates that DATABASE_URL points at exactly the requested target
 *      (host[:port], dbname) and at the `public` schema. It rejects every
 *      duplicate, unknown or routing query parameter (a `host` override
 *      especially), while still permitting the Prisma knobs `schema=public` /
 *      `connection_limit` and the common non-routing TLS options `sslmode`
 *      (validated against the libpq enum), `sslcert` and `sslrootcert`.
 *   3. Validates ADMIN_EMAIL / ADMIN_PASSWORD (production-strength, >= 12 chars,
 *      not a placeholder) BEFORE any deletion, regardless of NODE_ENV.
 *   4. Validates the operator-supplied pg_dump custom-format backup file BEFORE
 *      any destructive spawn: it must be a readable file AND `pg_restore --list`
 *      must exit 0 AND the listing must contain the app schema objects
 *      (`users`, `catalog_definitions`, `_prisma_migrations`) AND the TABLE DATA
 *      entries for `users` / `catalog_definitions` (a schema-only dump fails
 *      here) AND, when the archive header names a database, that name must be
 *      exactly `--target-db`. `pg_restore --data-only --file /dev/null` then
 *      forces a full read/decompression of every data entry, catching a
 *      truncated or corrupt archive before any mutation. A fake file carrying
 *      only the PGDMP header is not proof.
 *   5. Runs a read-only preflight against the target DB: connectivity, actual
 *      target identity (`current_database()`; the server address/port is NOT
 *      compared, so NAT/tunnel setups are fine), CREATE privilege on `public`,
 *      no foreign objects of ANY kind - and indexes/constraints/triggers are
 *      whitelisted by EXACT name on the known app tables, so any extra
 *      index/constraint or user trigger attached to a known table is rejected -
 *      plus no extensions in `public`, no extra non-system schemas, and no other
 *      client backends (the app must be stopped first). Preflight NEVER mutates.
 *   6. ONLY after every check passes, spawns the local Prisma CLI
 *      `migrate reset --force --skip-seed` and then `db seed`.
 *   7. Verifies the result (11 tables, active house_rules, one baseline
 *      migration, >= 41 catalog entries, one seeded admin). Every error AFTER
 *      the reset has started instructs the operator to keep the app offline and
 *      to restore the backup; nothing after that stage is ever labelled "setup".
 *
 * CLI (note the `--` separator so pnpm passes the flags through):
 *
 *   pnpm db:reset:0.1.0 -- \
 *     --target-host <host[:port]> \
 *     --target-db <dbname> \
 *     --confirm 'DELETE <dbname> FOR 0.1.0' \
 *     --backup-file <path/to/readable.dump>
 *
 * No password, URL or port flag appears in argv: the connection string is taken
 * from the inherited env (DATABASE_URL). Credentials and the URL are never logged;
 * error messages refer to the DB and placeholder password, never to the values.
 */

import {
  accessSync,
  closeSync,
  constants,
  openSync,
  readSync,
  statSync,
} from "node:fs"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { PrismaClient } from "@prisma/client"

// ------------------------------------------------------------------ //
// Constants
// ------------------------------------------------------------------ //

/** The single 0.1.0 from-scratch baseline migration. */
export const BASELINE_MIGRATION_NAME = "20261016000000_initial_0_1_0"

/** The 11 application tables the final schema creates (excluding _prisma_migrations). */
export const APP_TABLES = [
  "assets",
  "catalog_definitions",
  "character_associations",
  "character_drafts",
  "character_inventory_items",
  "characters",
  "house_rules",
  "progression_events",
  "skill_offer_options",
  "skill_offers",
  "users",
]

/** Prisma-managed enum types the app owns in the public schema. */
export const APP_ENUMS = [
  "Origin",
  "CatalogKind",
  "AssociationKind",
  "BlessingTier",
]

/** The app owns no sequences in the public schema. */
export const APP_SEQUENCES = []

/** The app ships no stored functions; any public function is foreign. */
export const APP_FUNCTIONS = []

/**
 * EXACT index names per app table, derived by inspecting the PG catalogs of a
 * real disposable database built from BOTH the archived 0001..0023 migration
 * chain and the 0.1.0 baseline. Both produced the identical index set (the
 * baseline only adds `_prisma_migrations_pkey`, which Prisma itself creates when
 * it makes the tracking table). Any index attached to a known table whose name
 * is not listed here is a foreign object that must fail the preflight.
 */
export const APP_INDEXES = {
  users: ["users_email_key", "users_pkey"],
  assets: ["assets_kind_idx", "assets_pkey"],
  characters: [
    "characters_archived_idx",
    "characters_ownerId_archived_idx",
    "characters_ownerId_idx",
    "characters_pkey",
  ],
  character_drafts: ["character_drafts_pkey", "character_drafts_userId_key"],
  character_inventory_items: [
    "character_inventory_items_characterId_definitionId_key",
    "character_inventory_items_characterId_idx",
    "character_inventory_items_pkey",
  ],
  character_associations: [
    "character_associations_characterId_blessing_key",
    "character_associations_characterId_bloodline_key",
    "character_associations_characterId_definitionId_key",
    "character_associations_characterId_idx",
    "character_associations_kind_idx",
    "character_associations_pkey",
  ],
  catalog_definitions: [
    "catalog_definitions_kind_archived_idx",
    "catalog_definitions_kind_idx",
    "catalog_definitions_kind_stableId_key",
    "catalog_definitions_pkey",
  ],
  house_rules: ["house_rules_pkey"],
  progression_events: [
    "progression_events_characterId_createdAt_idx",
    "progression_events_pkey",
  ],
  skill_offers: [
    "skill_offers_characterId_idx",
    "skill_offers_characterId_track_level_choiceGroup_generation_key",
    "skill_offers_pkey",
    "skill_offers_track_level_idx",
  ],
  skill_offer_options: [
    "skill_offer_options_definitionId_idx",
    "skill_offer_options_offerId_definitionId_key",
    "skill_offer_options_offerId_idx",
    "skill_offer_options_pkey",
  ],
  _prisma_migrations: ["_prisma_migrations_pkey"],
}

/**
 * EXACT constraint names per app table, again sourced from the real PG catalogs
 * of both the old 0001..0023 chain and the 0.1.0 baseline (identical). Any
 * constraint on a known table whose name is not listed here is foreign.
 */
export const APP_CONSTRAINTS = {
  users: ["users_pkey"],
  assets: ["assets_characterId_fkey", "assets_pkey"],
  characters: [
    "characters_classId_fkey",
    "characters_ownerId_fkey",
    "characters_pkey",
    "characters_professionId_fkey",
    "characters_raceId_fkey",
  ],
  character_drafts: ["character_drafts_pkey", "character_drafts_userId_fkey"],
  character_inventory_items: [
    "character_inventory_items_characterId_fkey",
    "character_inventory_items_definitionId_fkey",
    "character_inventory_items_pkey",
    "character_inventory_items_quantity_check",
  ],
  character_associations: [
    "character_associations_blessing_tier_check",
    "character_associations_characterId_fkey",
    "character_associations_definitionId_fkey",
    "character_associations_pkey",
  ],
  catalog_definitions: ["catalog_definitions_pkey"],
  house_rules: ["house_rules_pkey"],
  progression_events: [
    "progression_events_characterId_fkey",
    "progression_events_pkey",
  ],
  skill_offers: [
    "skill_offers_characterId_fkey",
    "skill_offers_pkey",
    "skill_offers_selectedDefinitionId_fkey",
  ],
  skill_offer_options: [
    "skill_offer_options_definitionId_fkey",
    "skill_offer_options_offerId_fkey",
    "skill_offer_options_pkey",
  ],
  _prisma_migrations: ["_prisma_migrations_pkey"],
}

/**
 * EXACT user-trigger names per app table. The application ships no user
 * triggers; only FK/constraint triggers, which are internal, exist. So any
 * non-internal trigger attached to a known table is foreign.
 */
export const APP_TRIGGERS = {}

/**
 * Objects that MUST exist in the pg_dump archive for the backup to be a usable
 * snapshot of this application's database (via `pg_restore --list`).
 */
export const ARCHIVE_REQUIRED_OBJECTS = [
  "users",
  "catalog_definitions",
  "_prisma_migrations",
]

/**
 * Objects that MUST carry DATA in the pg_dump archive. `pg_restore --list`
 * reports these as `TABLE DATA` TOC entries. Requiring data (not just the schema
 * definition) rejects a `pg_dump --schema-only` snapshot that would restore the
 * tables but none of the content the application depends on.
 */
export const ARCHIVE_REQUIRED_DATA_OBJECTS = ["users", "catalog_definitions"]

/** The custom-format pg_dump header. */
export const PGDMP_HEADER = "PGDMP"

/** Minimum backup size (>= 1 KiB) before we trust the header. */
export const MIN_BACKUP_BYTES = 1024

/** Weak/placeholder admin passwords that must never bootstrap a production admin. */
const WEAK_ADMIN_PASSWORDS = new Set([
  "admin",
  "password",
  "changeme",
  "example",
  "placeholder",
  "letmein",
])

const PRISMA_BIN = createRequire(import.meta.url).resolve(
  "prisma/build/index.js"
)

/** Project root (parent of scripts/); the Prisma CLI is spawned from here. */
export const PROJECT_ROOT = new URL("..", import.meta.url).pathname

// ------------------------------------------------------------------ //
// Pure helpers (exported for tests; no child process is spawned here)
// ------------------------------------------------------------------ //

/** Escape a string so it can be embedded verbatim in a RegExp literal. */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Human label for a pg_class relkind, used in foreign-object errors. */
function relationKindLabel(relkind) {
  switch (relkind) {
    case "v":
      return "view"
    case "m":
      return "materialized view"
    case "f":
      return "foreign table"
    case "p":
      return "partitioned table"
    default:
      return `relation (${relkind})`
  }
}

/**
 * Split a `--target-host <host[:port]>` argument into hostname + optional port.
 * IPv6 bracket form (`[::1]:5432`) is supported.
 */
export function parseTargetHost(arg) {
  if (typeof arg !== "string" || arg.trim() === "") {
    throw new Error("--target-host must be a nonempty host[:port] value")
  }
  const s = arg.trim()
  let hostname
  let port = ""
  let hasPort = false
  if (s.startsWith("[")) {
    const close = s.indexOf("]")
    if (close < 0) {
      throw new Error(`--target-host "${arg}" is missing a closing "]"`)
    }
    hostname = s.slice(1, close)
    const rest = s.slice(close + 1)
    if (rest !== "") {
      if (!rest.startsWith(":")) {
        throw new Error(`--target-host "${arg}" has junk after the ipv6 host`)
      }
      port = rest.slice(1)
      hasPort = true
    }
  } else {
    const idx = s.lastIndexOf(":")
    if (idx >= 0) {
      hostname = s.slice(0, idx)
      port = s.slice(idx + 1)
      hasPort = true
    } else {
      hostname = s
    }
  }
  if (hostname === "") {
    throw new Error(`--target-host "${arg}" is malformed`)
  }
  if (hasPort && port === "") {
    throw new Error(`--target-host "${arg}" has an empty port`)
  }
  return { hostname: hostname.toLowerCase(), port }
}

/**
 * URL query parameters the reset script accepts. The `schema` and
 * `connection_limit` Prisma knobs plus the common non-routing TLS options
 * (`sslmode`, `sslcert`, `sslrootcert`) are allowed. Anything else - a `host`
 * override, `connect_timeout`, `application_name`, socket paths, ... - is a
 * routing or unknown parameter that must be rejected so we never wipe the wrong
 * endpoint.
 */
const ALLOWED_URL_PARAMS = new Set([
  "schema",
  "connection_limit",
  "sslmode",
  "sslcert",
  "sslrootcert",
])

/** The PostgreSQL wire `sslmode` values libpq/Prisma understand. */
const ALLOWED_SSLMODE = new Set([
  "disable",
  "require",
  "prefer",
  "verify-ca",
  "verify-full",
])

/**
 * Parse a PostgreSQL DATABASE_URL into its target components. Requires the
 * `public` schema (allow the schema param to be absent, which Prisma defaults to
 * public) and a single-segment pathname database name. Rejects any duplicate
 * query parameter, every parameter outside the allow-list, and any `sslmode`
 * value outside the supported enum - a `host` override is expressly rejected so
 * we never wipe the wrong endpoint.
 */
export function parseDatabaseUrl(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("DATABASE_URL must be set")
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error("DATABASE_URL is not a valid URL")
  }
  const scheme = url.protocol.replace(":", "")
  if (scheme !== "postgresql" && scheme !== "postgres") {
    throw new Error(`DATABASE_URL must be a PostgreSQL URL (got "${scheme}:")`)
  }

  const seenParams = new Set()
  for (const key of url.searchParams.keys()) {
    if (seenParams.has(key)) {
      throw new Error(
        `DATABASE_URL provides the query parameter "${key}" more than once`
      )
    }
    seenParams.add(key)
    if (!ALLOWED_URL_PARAMS.has(key)) {
      throw new Error(
        `DATABASE_URL has an unsupported query parameter "${key}". ` +
          `Only "schema=public", an optional "connection_limit", and the TLS ` +
          `options "sslmode", "sslcert", "sslrootcert" are allowed ` +
          `(a "host" override or other routing params are rejected).`
      )
    }
  }

  const sslmode = url.searchParams.get("sslmode")
  if (sslmode != null && !ALLOWED_SSLMODE.has(sslmode)) {
    throw new Error(
      `DATABASE_URL sslmode must be one of ${[...ALLOWED_SSLMODE]
        .map((v) => `"${v}"`)
        .join(", ")} (got "${sslmode}")`
    )
  }

  const path = url.pathname
  const seg = path.replace(/^\/+/, "").replace(/\/+$/, "")
  if (seg === "" || seg.includes("/")) {
    throw new Error(
      `DATABASE_URL pathname must name exactly one database (got "${path}")`
    )
  }
  let dbname
  try {
    dbname = decodeURIComponent(seg)
  } catch {
    throw new Error(
      `DATABASE_URL database name "${seg}" is not valid percent-encoding`
    )
  }

  const schema = url.searchParams.get("schema")
  if (schema != null && schema !== "public") {
    throw new Error(
      `DATABASE_URL schema must be "public" (got "${schema}") - this reset only ever moves the public schema`
    )
  }

  return {
    scheme,
    hostname: url.hostname.toLowerCase(),
    port: url.port,
    dbname,
    schema: schema ?? "public",
  }
}

/**
 * Assert the parsed URL hostname(+port) and database name match the explicit
 * `--target-host` / `--target-db` flags exactly. This is the guard that stops the
 * operator from wiping the wrong database.
 */
export function assertTargetMatches(urlInfo, targetHostArg, targetDbArg) {
  const { hostname, port } = parseTargetHost(targetHostArg)
  if (urlInfo.hostname !== hostname) {
    throw new Error(
      `--target-host "${targetHostArg}" (host "${hostname}") does not match DATABASE_URL host "${urlInfo.hostname}"`
    )
  }
  const urlPort = urlInfo.port || ""
  const argPort = port || ""
  if (urlPort !== argPort) {
    throw new Error(
      `--target-host "${targetHostArg}" uses port "${argPort || "(default)"}" but DATABASE_URL uses port "${urlPort || "(default)"}"`
    )
  }
  if (urlInfo.dbname !== targetDbArg) {
    throw new Error(
      `--target-db "${targetDbArg}" does not match the database in DATABASE_URL ("${urlInfo.dbname}")`
    )
  }
}

/** The exact confirmation phrase the operator must pass for the given database. */
export function confirmPhrase(dbname) {
  return `DELETE ${dbname} FOR 0.1.0`
}

/** Require the `--confirm` value to be exactly the phrase for this database. */
export function assertConfirm(actual, dbname) {
  const expected = confirmPhrase(dbname)
  if (actual !== expected) {
    throw new Error(`--confirm must be exactly "${expected}" (got "${actual}")`)
  }
}

/**
 * Validate ADMIN_EMAIL / ADMIN_PASSWORD. The email must be nonempty and the
 * password must be set; production-strength checks (>= 12 chars, not a known weak
 * placeholder) apply when `forceProduction` is true. This runs BEFORE any
 * deletion. Never interpolates the password value into an error.
 *
 * `main()` ALWAYS passes `forceProduction: true` regardless of NODE_ENV; the
 * `forceProduction: false` override is only for isolated tests.
 */
export function validateAdminEnv(env, options = {}) {
  const email = (env.ADMIN_EMAIL || "").trim()
  if (email === "") {
    throw new Error("ADMIN_EMAIL must be set and nonempty")
  }
  const password = env.ADMIN_PASSWORD || ""
  if (password === "") {
    throw new Error("ADMIN_PASSWORD must be set and nonempty")
  }
  const forceProduction =
    options.forceProduction ?? env.NODE_ENV === "production"
  if (forceProduction) {
    const trimmed = password.trim()
    if (WEAK_ADMIN_PASSWORDS.has(trimmed.toLowerCase())) {
      throw new Error(
        `ADMIN_PASSWORD is a weak/placeholder value. Set a strong password (>= 12 chars) in production.`
      )
    }
    if (trimmed.length < 12) {
      throw new Error(
        `ADMIN_PASSWORD must be at least 12 characters in production (got ${trimmed.length}).`
      )
    }
  }
  return { email }
}

/**
 * Basic file-level backup checks: exists, regular file, >= 1 KiB, readable, and
 * the pg_dump custom-format PGDMP header. This is a cheap pre-filter only - the
 * authoritative proof that the archive is real and usable is `validateBackupArchive`.
 */
export function validateBackupFile(path) {
  if (typeof path !== "string" || path === "") {
    throw new Error("--backup-file must be a nonempty path")
  }
  let st
  try {
    st = statSync(path)
  } catch {
    throw new Error(`Backup file "${path}" does not exist`)
  }
  if (!st.isFile()) {
    throw new Error(`Backup file "${path}" is not a regular file`)
  }
  if (st.size < MIN_BACKUP_BYTES) {
    throw new Error(
      `Backup file "${path}" is smaller than ${MIN_BACKUP_BYTES} bytes (${st.size} bytes); a pg_dump custom-format dump is larger`
    )
  }
  try {
    accessSync(path, constants.R_OK)
  } catch {
    throw new Error(`Backup file "${path}" is not readable`)
  }
  const fd = openSync(path, "r")
  try {
    const buf = Buffer.alloc(PGDMP_HEADER.length)
    const bytes = readSync(fd, buf, 0, PGDMP_HEADER.length, 0)
    if (
      bytes < PGDMP_HEADER.length ||
      buf.toString("latin1") !== PGDMP_HEADER
    ) {
      throw new Error(
        `Backup file "${path}" does not start with the pg_dump custom-format header (PGDMP)`
      )
    }
  } finally {
    closeSync(fd)
  }
}

/**
 * Extract the `dbname` the pg_dump archive records in its header, or null when
 * the header carries none. Present in `pg_restore --list` output as the
 * metadata comment `;     dbname: <name>`.
 */
export function archiveHeaderDbname(listText) {
  const m = /^\s*;\s*dbname:\s*(\S+)/m.exec(listText || "")
  return m ? m[1] : null
}

/**
 * Assert that the `pg_restore --list` listing text contains the application's
 * schema objects, including the DATA (`TABLE DATA`) entries for the tables the
 * application cannot be restored without. A schema-only dump carries the TABLE
 * definitions but no TABLE DATA entries, so it is rejected here. A PGDMP header
 * alone is not proof of a usable backup; a forged or truncated archive is
 * rejected in `validateBackupArchive`.
 */
export function assertArchiveContainsObjects(listText) {
  if (typeof listText !== "string" || listText.trim() === "") {
    throw new Error(
      "pg_restore --list produced no object listing to verify the backup"
    )
  }
  // pg_restore --list prefixes metadata/comment lines with ";"; object entries
  // (e.g. "217; 1259 41096 TABLE public users postgres") are not prefixed. A
  // listing with zero object lines is not proof of a usable app backup.
  const objectLines = listText
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trim().startsWith(";"))
  if (objectLines.length === 0) {
    throw new Error(
      "pg_restore --list produced no object listing to verify the backup"
    )
  }
  const objectText = objectLines.join("\n")

  // Schema definition entries must exist (e.g. "TABLE public users postgres").
  const missingDefs = ARCHIVE_REQUIRED_OBJECTS.filter((name) => {
    const re = new RegExp(`(?:TABLE|SEQUENCE) public ${escapeRegExp(name)}\\s`)
    return !re.test(objectText)
  })
  if (missingDefs.length > 0) {
    throw new Error(
      `Backup archive does not contain app schema object(s): ${missingDefs.join(
        ", "
      )}. It is not a restoreable backup of this application's database.`
    )
  }

  // Data entries must exist for the tables that must carry content (e.g.
  // "TABLE DATA public users postgres"). A schema-only archive fails here.
  const missingData = ARCHIVE_REQUIRED_DATA_OBJECTS.filter((name) => {
    const re = new RegExp(`TABLE DATA public ${escapeRegExp(name)}\\s`)
    return !re.test(objectText)
  })
  if (missingData.length > 0) {
    throw new Error(
      `Backup archive does not contain data (TABLE DATA) for app object(s): ${missingData.join(
        ", "
      )}. A schema-only dump is not a usable backup of this application's data; it cannot restore the application's content.`
    )
  }
}

/**
 * Assert that the archive's recorded `dbname` matches the exact target database,
 * but ONLY when the archive header records one. Older or host-agnostic archives
 * may omit the dbname; those are accepted. When the header DOES name a database
 * and it differs from `--target-db`, the dump is from the wrong database and is
 * rejected. `expectedDbname` of null/empty skips the check.
 */
export function assertArchiveDbname(listText, expectedDbname) {
  if (expectedDbname == null || expectedDbname === "") return
  const archiveDb = archiveHeaderDbname(listText)
  if (archiveDb == null) return
  if (archiveDb !== expectedDbname) {
    throw new Error(
      `Backup archive was created from database "${archiveDb}" but --target-db is "${expectedDbname}". ` +
        `Restore that dump only after you have confirmed it is the right database.`
    )
  }
}

/**
 * Authoritative backup verification. Runs three pg_restore inspections, all via
 * the injectable `run` runner (unit tests pass a fake; production uses
 * `defaultPGRestore`):
 *
 *   1. `pg_restore --list <file>` must exit 0 (a forged PGDMP header fails here).
 *   2. The listing must contain the app schema objects AND TABLE DATA for the
 *      tables that must carry content, and the archive's recorded dbname (when
 *      present) must equal `expectedDbname`.
 *   3. `pg_restore --data-only --file /dev/null <file>` must exit 0 - this forces
 *      a full read/decompression of every data entry BEFORE any mutation, so a
 *      truncated or corrupt archive is caught up front.
 *
 * `run` receives `(cmd, args)` and must resolve `{ code, stdout, stderr }`.
 */
export async function validateBackupArchive({
  path,
  run,
  expectedDbname = "",
}) {
  if (typeof path !== "string" || path === "") {
    throw new Error("--backup-file must be a nonempty path")
  }
  if (typeof run !== "function") {
    throw new Error(
      "No pg_restore runner was provided to verify the backup archive"
    )
  }
  let res
  try {
    res = await run("pg_restore", ["--list", path])
  } catch (err) {
    throw new Error(
      `pg_restore could not be run to verify the backup (${err instanceof Error ? err.message : String(err)}). ` +
        `Install a PostgreSQL client (pg_restore) on the machine running the reset.`
    )
  }
  if (!res || res.code !== 0) {
    throw new Error(
      `Backup verification failed: pg_restore --list exited with code ${res ? res.code : "?"}. ` +
        `"${path}" is not a readable pg_dump custom-format archive.`
    )
  }
  const listText = res.stdout || ""
  assertArchiveContainsObjects(listText)
  assertArchiveDbname(listText, expectedDbname)

  // Force a full read/decompression of the archive's data before any mutation,
  // so truncation or corruption cannot surface mid-reset.
  let dataRes
  try {
    dataRes = await run("pg_restore", [
      "--data-only",
      "--file",
      "/dev/null",
      path,
    ])
  } catch (err) {
    throw new Error(
      `pg_restore could not read the backup's data (${err instanceof Error ? err.message : String(err)}). ` +
        `Install a PostgreSQL client (pg_restore) on the machine running the reset.`
    )
  }
  if (!dataRes || dataRes.code !== 0) {
    throw new Error(
      `Backup data check failed: pg_restore --data-only exited with code ${dataRes ? dataRes.code : "?"}. ` +
        `"${path}" is a truncated or corrupt pg_dump archive; refusing to reset on it.`
    )
  }
}

// ------------------------------------------------------------------ //
// Preflight / verification SQL and classifiers (pure, testable)
// ------------------------------------------------------------------ //

/** Public-schema relations (tables/views/matviews/foreign/partitioned), sequences and non-array types. */
export function publicObjectsSql() {
  return `
SELECT 'relation' AS kind, c.relname AS name, c.relkind::text AS relkind, NULL::text AS "table"
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'v', 'm', 'f', 'p')
UNION ALL
SELECT 'sequence' AS kind, c.relname AS name, c.relkind::text AS relkind, NULL::text AS "table"
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'S'
UNION ALL
SELECT 'type' AS kind, t.typname AS name, NULL::text AS relkind, NULL::text AS "table"
FROM pg_catalog.pg_type t
JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public'
  AND t.typtype IN ('e', 'c', 'd', 'b', 'r', 'm')
  AND t.typcategory <> 'A'
`
}

/** Stored functions or procedures defined in the public schema. */
export function publicFunctionsSql() {
  return `
SELECT 'function' AS kind, p.proname AS name, NULL::text AS relkind, NULL::text AS "table"
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
`
}

/** Non-internal triggers attached to relations in the public schema. */
export function publicTriggersSql() {
  return `
SELECT 'trigger' AS kind, tr.tgname AS name, NULL::text AS relkind, tbl.relname AS "table"
FROM pg_catalog.pg_trigger tr
JOIN pg_catalog.pg_class tbl ON tbl.oid = tr.tgrelid
JOIN pg_catalog.pg_namespace n ON n.oid = tbl.relnamespace
WHERE n.nspname = 'public'
  AND NOT tr.tgisinternal
`
}

/** Indexes attached to relations in the public schema. */
export function publicIndexesSql() {
  return `
SELECT 'index' AS kind, idx.relname AS name, NULL::text AS relkind, tbl.relname AS "table"
FROM pg_catalog.pg_index i
JOIN pg_catalog.pg_class idx ON idx.oid = i.indexrelid
JOIN pg_catalog.pg_class tbl ON tbl.oid = i.indrelid
JOIN pg_catalog.pg_namespace n ON n.oid = tbl.relnamespace
WHERE n.nspname = 'public'
`
}

/** Table constraints (PK/FK/unique/check) in the public schema. */
export function publicConstraintsSql() {
  return `
SELECT 'constraint' AS kind, con.conname AS name, NULL::text AS relkind, tbl.relname AS "table"
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class tbl ON tbl.oid = con.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = tbl.relnamespace
WHERE n.nspname = 'public'
  AND con.conrelid <> 0
`
}

/** Extensions installed directly into the public schema. */
export function publicExtensionsSql() {
  return `
SELECT e.extname
FROM pg_catalog.pg_extension e
JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
WHERE n.nspname = 'public'
`
}

/** Every schema in the database (system + user). */
export function listSchemasSql() {
  return `SELECT nspname AS name FROM pg_catalog.pg_namespace`
}

/** The live identity of the connected database, server address and port. */
export function targetIdentitySql() {
  return `
SELECT
  current_database() AS db,
  inet_server_addr() AS addr,
  inet_server_port()::int AS port
`
}

/** Other client backends already connected to the target database (excluding us). */
export function connectedSessionsSql() {
  return `
SELECT count(*)::int AS n
FROM pg_catalog.pg_stat_activity
WHERE datname = current_database()
  AND pid <> pg_backend_pid()
`
}

/** Whether the current user may CREATE in the public schema. */
export function permissionsSql() {
  return `
SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS can_create
FROM pg_catalog.pg_namespace
WHERE nspname = 'public'
`
}

/**
 * Classify rows from the public-object SQL queries into unknown vs. known.
 *
 * Tables are whitelisted by EXACT name (plain tables only - a view, matview,
 * foreign or partitioned table is never whitelisted by name alone), and their
 * composite row types plus the known app enum names are allowed as types.
 * Indexes, constraints and triggers are whitelisted by EXACT NAME on a known
 * table; any such object attached to a known table whose name is not in the
 * whitelist, or attached to an unknown table, is "foreign" and fails closed.
 * Any object kind outside the known set is rejected outright. The app owns no
 * sequences or stored functions, so a public sequence/function is foreign.
 */
export function classifyPublicObjects(rows, options = {}) {
  const knownTables = options.knownTables ?? APP_TABLES
  const knownEnums = options.knownEnums ?? APP_ENUMS
  const knownSequences = options.knownSequences ?? APP_SEQUENCES
  const knownFunctions = options.knownFunctions ?? APP_FUNCTIONS
  const knownIndexes = options.knownIndexes ?? APP_INDEXES
  const knownConstraints = options.knownConstraints ?? APP_CONSTRAINTS
  const knownTriggers = options.knownTriggers ?? APP_TRIGGERS

  const tableSet = new Set([...knownTables, "_prisma_migrations"])
  const allowedRelations = tableSet
  const allowedSequences = new Set(knownSequences)
  const allowedTypes = new Set([
    ...knownEnums,
    ...knownTables,
    "_prisma_migrations",
  ])
  const allowedFunctions = new Set(knownFunctions)
  const allowedIndexes = new Map(
    Object.entries(knownIndexes).map(([t, names]) => [t, new Set(names)])
  )
  const allowedConstraints = new Map(
    Object.entries(knownConstraints).map(([t, names]) => [t, new Set(names)])
  )
  const allowedTriggers = new Map(
    Object.entries(knownTriggers).map(([t, names]) => [t, new Set(names)])
  )

  const allowedFor = (map, table) => map.get(table ?? "") ?? new Set()

  const unknown = []
  for (const row of rows) {
    const name = row?.name
    const table = row?.table
    switch (row.kind) {
      case "relation":
        if (row.relkind === "r") {
          if (!allowedRelations.has(name)) {
            unknown.push(`${name} (table)`)
          }
        } else {
          unknown.push(`${name} (${relationKindLabel(row.relkind)})`)
        }
        break
      case "sequence":
        if (!allowedSequences.has(name)) {
          unknown.push(`${name} (sequence)`)
        }
        break
      case "type":
        if (!allowedTypes.has(name)) {
          unknown.push(`${name} (type)`)
        }
        break
      case "function":
        if (!allowedFunctions.has(name)) {
          unknown.push(`${name} (function)`)
        }
        break
      case "trigger":
        if (!allowedFor(allowedTriggers, table).has(name)) {
          unknown.push(`${name} (trigger on ${table ?? "(unnamed table)"})`)
        }
        break
      case "index":
        if (!allowedFor(allowedIndexes, table).has(name)) {
          unknown.push(`${name} (index on ${table ?? "(unnamed table)"})`)
        }
        break
      case "constraint":
        if (!allowedFor(allowedConstraints, table).has(name)) {
          unknown.push(`${name} (constraint on ${table ?? "(unnamed table)"})`)
        }
        break
      default:
        unknown.push(`${name ?? "(unnamed)"} (${row.kind ?? "unknown"})`)
        break
    }
  }
  return unknown
}

/**
 * Classify schema names: anything that is not the target `public`, a standard
 * system schema, or a temp/toast schema is a foreign schema that the reset would
 * otherwise silently drop.
 */
export function classifyForeignSchemas(names) {
  const allowed = new Set([
    "public",
    "pg_catalog",
    "information_schema",
    "pg_toast",
  ])
  const systemRe = /^pg_(toast_)?temp_\d+$/
  const foreign = []
  for (const n of names || []) {
    if (allowed.has(n)) continue
    if (systemRe.test(n)) continue
    foreign.push(n)
  }
  return foreign
}

/**
 * Verify the live target identity returned by `targetIdentitySql()` against the
 * explicit target. ONLY `current_database()` must match exactly. The server
 * address/port reported by `inet_server_addr()/inet_server_port()` are NOT
 * compared to the URL: those can legitimately differ behind a NAT, a reverse
 * tunnel, a proxy, or a renamed host, and they never route the reset. The
 * authoritative host+port/db match is the static `assertTargetMatches` check
 * against the parsed URL and the explicit `--target-host`/`--target-db` flags.
 */
export function verifyTargetIdentity(row, expected = {}) {
  const db = row?.db
  if (row == null || db == null) {
    throw new Error(
      "Could not read the target database identity (current_database()); aborting before reset"
    )
  }
  if (db !== expected.dbname) {
    throw new Error(
      `DATABASE_URL connected to database "${db}" but --target-db is "${expected.dbname}"; refusing to reset`
    )
  }
}

/**
 * Read-only preflight against the target DB. NEVER mutates. Throws on any
 * condition that should stop the reset.
 */
export async function runPreflight(options) {
  const db = options.db
  const targetDb = options.targetDb
  const targetHost = options.targetHost ?? {}

  // Connectivity: if this throws the DB is unreachable.
  await db.$queryRawUnsafe("SELECT 1")

  // Live target identity (database name, server address/port).
  const identityRows = await db.$queryRawUnsafe(targetIdentitySql())
  verifyTargetIdentity(identityRows?.[0], {
    dbname: targetDb,
    hostname: targetHost.hostname,
    port: targetHost.port,
  })

  // Permissions needed for reset/recreation.
  const permRows = await db.$queryRawUnsafe(permissionsSql())
  if (!permRows?.[0]?.can_create) {
    throw new Error(
      "The DATABASE_URL user cannot CREATE in the public schema; prisma migrate reset would fail"
    )
  }

  // Foreign objects of every kind in the public schema.
  const objRows = await db.$queryRawUnsafe(publicObjectsSql())
  const fnRows = await db.$queryRawUnsafe(publicFunctionsSql())
  const trigRows = await db.$queryRawUnsafe(publicTriggersSql())
  const idxRows = await db.$queryRawUnsafe(publicIndexesSql())
  const conRows = await db.$queryRawUnsafe(publicConstraintsSql())
  const allRows = [
    ...(objRows || []),
    ...(fnRows || []),
    ...(trigRows || []),
    ...(idxRows || []),
    ...(conRows || []),
  ]
  const unknown = classifyPublicObjects(allRows)
  if (unknown.length > 0) {
    throw new Error(
      `public schema holds foreign object(s) not owned by this app: ${unknown.join(
        ", "
      )}. Refusing to reset.`
    )
  }

  // Extensions installed in public.
  const extRows = await db.$queryRawUnsafe(publicExtensionsSql())
  if (extRows.length > 0) {
    throw new Error(
      `Postgres extension(s) are installed in the public schema: ${extRows
        .map((r) => r.extname)
        .join(", ")}. Refusing to reset.`
    )
  }

  // Non-system schemas that the reset would silently drop.
  const schemaRows = await db.$queryRawUnsafe(listSchemasSql())
  const foreignSchemas = classifyForeignSchemas(
    (schemaRows || []).map((r) => r.name)
  )
  if (foreignSchemas.length > 0) {
    throw new Error(
      `Database holds non-system schema(s): ${foreignSchemas.join(
        ", "
      )}. Refusing to reset (the reset would drop them).`
    )
  }

  // Other app sessions / writers.
  const sessRows = await db.$queryRawUnsafe(connectedSessionsSql())
  if ((sessRows?.[0]?.n ?? 0) > 0) {
    throw new Error(
      `Another application session is connected to "${targetDb}" (${sessRows[0].n} backend${sessRows[0].n === 1 ? "" : "s"}). Stop all app instances before the reset.`
    )
  }
}

/** Build a connection URL with connection_limit=1 (we only ever need one backend). */
export function withConnectionLimit(rawUrl) {
  if (!rawUrl) return rawUrl
  try {
    const u = new URL(rawUrl)
    u.searchParams.set("connection_limit", "1")
    return u.toString()
  } catch {
    return rawUrl
  }
}

/** Verify the post-reset database is exactly the fresh 0.1.0 baseline. */
export async function verifyReset(options) {
  const db = options.db
  const expectedTables = [...(options.expectedTables ?? APP_TABLES)].sort()
  const baseline = options.baseline ?? BASELINE_MIGRATION_NAME
  const minCatalog = options.minCatalog ?? 41

  const tableRows = await db.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
  )
  const appTables = (tableRows || [])
    .map((r) => r.table_name)
    .filter((n) => n !== "_prisma_migrations")
    .sort()
  if (JSON.stringify(appTables) !== JSON.stringify(expectedTables)) {
    return {
      ok: false,
      reason: `expected app tables [${expectedTables.join(", ")}] but found [${appTables.join(", ")}]`,
    }
  }

  const houseRows = await db.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "house_rules" WHERE "id" = 'active'`
  )
  if ((houseRows?.[0]?.n ?? 0) < 1) {
    return {
      ok: false,
      reason: "house_rules singleton (id='active') is missing",
    }
  }

  const migRows = await db.$queryRawUnsafe(
    `SELECT "migration_name" AS name, "finished_at" FROM "_prisma_migrations" ORDER BY "started_at"`
  )
  const applied = (migRows || []).filter((r) => r.finished_at != null)
  if (applied.length !== 1 || applied[0].name !== baseline) {
    return {
      ok: false,
      reason: `expected exactly one applied baseline migration (${baseline}), found [${applied
        .map((r) => r.name)
        .join(", ")}]`,
    }
  }

  const catalogRows = await db.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "catalog_definitions"`
  )
  if ((catalogRows?.[0]?.n ?? 0) < minCatalog) {
    return {
      ok: false,
      reason: `expected >= ${minCatalog} catalog entries after seed, found ${catalogRows?.[0]?.n ?? 0}`,
    }
  }

  const adminRows = await db.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "users" WHERE "isAdmin" = true`
  )
  if ((adminRows?.[0]?.n ?? 0) < 1) {
    return { ok: false, reason: "no seeded admin user found" }
  }

  return { ok: true }
}

// ------------------------------------------------------------------ //
// Process orchestration
// ------------------------------------------------------------------ //

/** The four CLI flags the reset accepts (no others, each only once). */
const ALLOWED_FLAGS = new Set([
  "--target-host",
  "--target-db",
  "--confirm",
  "--backup-file",
])

function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    // Allow at most one leading `--` separator (the `pnpm ... --` pass-through).
    // Any non-leading `--` is a stray separator and must be rejected.
    if (raw === "--") {
      if (i !== 0) {
        throw new Error(`Unexpected separator "--" (only a single leading one is allowed)`)
      }
      continue
    }
    if (!raw.startsWith("--")) {
      throw new Error(`Unexpected positional argument "${raw}"`)
    }
    if (!ALLOWED_FLAGS.has(raw)) {
      throw new Error(`Unknown flag "${raw}"`)
    }
    const key = raw.slice(2)
    if (Object.prototype.hasOwnProperty.call(flags, key)) {
      throw new Error(`Duplicate flag "${raw}"`)
    }
    const value = argv[i + 1]
    if (value == null || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`)
    }
    flags[key] = value
    i++
  }
  return flags
}

function defaultRun(cmd, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: options.env,
      cwd: options.cwd,
      stdio: "inherit",
    })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code: code ?? -1 }))
  })
}

/**
 * The production archive-check runner: capture `pg_restore --list` stdout/stderr
 * and return them so the archive content can be validated. Resolves the promise
 * with `{ code, stdout, stderr }` when the process exits.
 */
function defaultPGRestore(cmd, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: options?.env,
      cwd: options?.cwd,
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("error", reject)
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

async function runPrisma(args, options) {
  const run = options.run
  return run(process.execPath, [PRISMA_BIN, ...args], {
    env: options.env,
    cwd: options.cwd,
  })
}

function defaultCreateDb(env) {
  return new PrismaClient({
    datasources: {
      db: {
        url: withConnectionLimit(env?.DATABASE_URL ?? process.env.DATABASE_URL),
      },
    },
  })
}

const RESTORE_HINT = (backupFile) =>
  `Restore your backup now: pg_restore --clean --if-exists --no-owner -d "<DATABASE_URL>" ${backupFile}`

/** Instruction for any failure once the reset has already started. */
const OFFLINE_HINT = (backupFile) =>
  `Keep the app offline. ${RESTORE_HINT(backupFile)}`

/**
 * Run the full reset. Never mutates or spawns until every pre-deletion check
 * passes. On a config/preflight problem it returns `{ status: "failed", step }`
 * after logging the reason; on a spawned-command or post-reset failure it stops
 * immediately (does not run seed after a failed reset) and returns a failure that
 * tells the operator to keep the app offline and restore the backup.
 */
export async function main(options = {}) {
  const env = options.env ?? process.env
  const argv = options.argv ?? process.argv.slice(2)
  const log = options.log ?? ((msg) => console.log(msg))
  const errLog = options.errLog ?? ((msg) => console.error(msg))
  const run = options.run ?? defaultRun
  const runArchive = options.runArchive ?? defaultPGRestore
  const cwd = options.cwd ?? PROJECT_ROOT
  const createDb = options.createDb ?? ((env) => defaultCreateDb(env))
  // Always enforce production-strength admin password for an actual reset,
  // regardless of NODE_ENV. Only isolated tests opt out.
  const enforceAdmin = options.enforceAdmin ?? true
  let resetStarted = false
  let backupFile

  try {
    const flags = parseArgs(argv)
    const targetHost = flags["target-host"]
    const targetDb = flags["target-db"]
    const confirm = flags["confirm"]
    backupFile = flags["backup-file"]
    if (!targetHost) throw new Error("--target-host is required")
    if (!targetDb) throw new Error("--target-db is required")
    if (!confirm) throw new Error("--confirm is required")
    if (!backupFile) throw new Error("--backup-file is required")

    // ---- Pre-deletion checks (never mutate, never spawn) ----
    const urlInfo = parseDatabaseUrl(env.DATABASE_URL)
    assertTargetMatches(urlInfo, targetHost, targetDb)
    validateAdminEnv(env, { forceProduction: enforceAdmin })
    assertConfirm(confirm, targetDb)
    validateBackupFile(backupFile)
    await validateBackupArchive({
      path: backupFile,
      run: runArchive,
      expectedDbname: targetDb,
    })
    log(
      `Backup file "${backupFile}" validated (pg_restore --list reads a pg_dump custom-format archive with the app schema objects and data, ` +
        `and pg_restore --data-only confirms the whole archive is readable). ` +
        `Restoring it remains YOUR responsibility if the reset fails.`
    )

    const db = createDb(env)
    try {
      const { hostname, port } = parseTargetHost(targetHost)
      await runPreflight({ db, targetDb, targetHost: { hostname, port } })
    } finally {
      await db.$disconnect()
    }
    log(
      `Preflight passed for ${targetHost}/${targetDb}. Running "prisma migrate reset --force --skip-seed".`
    )

    resetStarted = true
    const reset = await runPrisma(
      ["migrate", "reset", "--force", "--skip-seed"],
      { env, cwd, run }
    )
    if (reset.code !== 0) {
      errLog(
        `prisma migrate reset exited with code ${reset.code}. ${OFFLINE_HINT(backupFile)}`
      )
      return { status: "failed", step: "migrate-reset", code: reset.code }
    }

    log(`Migration reset succeeded. Running "prisma db seed".`)
    const seed = await runPrisma(["db", "seed"], { env, cwd, run })
    if (seed.code !== 0) {
      errLog(
        `prisma db seed exited with code ${seed.code}. ${OFFLINE_HINT(backupFile)}`
      )
      return { status: "failed", step: "seed", code: seed.code }
    }

    const verifyDb = createDb(env)
    try {
      const verdict = await verifyReset({ db: verifyDb })
      if (!verdict.ok) {
        errLog(
          `Reset verification failed: ${verdict.reason}. ${OFFLINE_HINT(backupFile)}`
        )
        return { status: "failed", step: "verify", reason: verdict.reason }
      }
    } finally {
      await verifyDb.$disconnect()
    }

    log(
      `0.1.0 reset complete: baseline ${BASELINE_MIGRATION_NAME} applied, 11 tables present, ` +
        `house_rules active, >= 41 catalog entries, admin seeded. ` +
        `If you need to roll back, restore the backup: pg_restore --clean --if-exists --no-owner -d "<DATABASE_URL>" ${backupFile}`
    )
    return { status: "ok" }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (resetStarted) {
      errLog(
        `reset-db-0.1.0: ${message} ${OFFLINE_HINT(backupFile ?? "(backup)")}`
      )
      return { status: "failed", step: "post-reset", error: message }
    }
    errLog(`reset-db-0.1.0: ${message}`)
    return { status: "failed", step: "setup", error: message }
  }
}

// ------------------------------------------------------------------ //
// Entry point
// ------------------------------------------------------------------ //

function isRunningAsMain() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(entry).href
  } catch {
    return false
  }
}

if (isRunningAsMain()) {
  main()
    .then((result) => {
      if (result.status !== "ok") process.exitCode = 1
    })
    .catch((err) => {
      console.error(
        `reset-db-0.1.0: ${err instanceof Error ? err.message : String(err)}`
      )
      process.exitCode = 1
    })
}
