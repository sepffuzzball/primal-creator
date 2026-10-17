/**
 * Explicit per-character PostgreSQL hard-delete utility.
 *
 * This deletes ONE character row - and, through the schema's `ON DELETE CASCADE`
 * foreign keys, everything that belongs exclusively to that character: its
 * assets (portrait/upload metadata), progression events, character
 * associations, inventory items, currency balances, skill offers, and the
 * options belonging to those offers. It never touches another character, never
 * runs a migration, never resets the database, and is never run automatically.
 * It is the "recreate a character" path: delete the single row, then re-run the
 * create flow so the regenerated character is a fresh, correct one.
 *
 * Two modes:
 *   - default (preview): read-only. Prints the target id, name, ownerId,
 *     archived flag and the dependent counts, then stops. Nothing is deleted.
 *   - --execute --confirm <id>: delete. `--confirm` must equal the EXACT
 *     character id being deleted, so an operator cannot accidentally delete a
 *     different character. No backup is required - the character is simply gone
 *     and can be recreated.
 *
 * CLI (note the `--` separator so pnpm passes the flags through):
 *
 *   pnpm db:delete-character -- --id <character-id>                     # preview
 *   pnpm db:delete-character -- --id <character-id> \
 *     --execute --confirm <character-id>                               # delete
 *
 * DATABASE_URL is read from the inherited env. It is never printed: error
 * messages refer to it generically, and neither credentials nor the URL are
 * logged.
 *
 * The utility does NOT touch the portrait/upload filesystem. Deleting a
 * character cascades away its `assets` METADATA rows, but the image bytes on
 * disk (the uploads volume / UPLOAD_DIR) are left in place and may become
 * orphaned. See `docs/deployment.md` for the cleanup note.
 */

import { PrismaClient } from "@prisma/client"
import { pathToFileURL } from "node:url"

// ------------------------------------------------------------------ //
// Constants
// ------------------------------------------------------------------ //

/** The dependent models counted by the preview, keyed by output label. */
export const DEPENDENT_COUNT_LABELS = {
  assets: "assets",
  events: "progression events",
  associations: "associations",
  inventory: "inventory items",
  currencyBalances: "currency balances",
  skillOffers: "skill offers",
  skillOfferOptions: "skill offer options",
}

/**
 * Generic, secret-free failure message for any database, connection or
 * unexpected runtime error. The DB driver's `.message` (which frequently
 * embeds the DATABASE_URL including the password) is never leaked to stdout,
 * stderr or the returned `error`; this single literal is used instead.
 */
export const GENERIC_FAILURE_MESSAGE =
  "failed (check DATABASE_URL and database connectivity)"

// ------------------------------------------------------------------ //
// Pure CLI parsing (no child process, no DB)
// ------------------------------------------------------------------ //

/** The only flags the command accepts. */
const ALLOWED_FLAGS = new Set(["--id", "--execute", "--confirm"])
/** Boolean flags take no value; everything else requires one. */
const BOOLEAN_FLAGS = new Set(["execute"])

/**
 * Parse the command-line arguments. Rejects ANY unknown flag, duplicate flag,
 * stray positional or extra `--` separator, and enforces the cross-flag
 * invariants: `--id` is always required, `--confirm` is required with
 * `--execute`, and `--confirm` is only valid together with `--execute`.
 */
export function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    // Allow at most one leading `--` separator (the `pnpm ... --` pass-through).
    // Any non-leading `--` is a stray separator and must be rejected.
    if (raw === "--") {
      if (i !== 0) {
        throw new Error(
          `Unexpected separator "--" (only a single leading one is allowed)`
        )
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
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true
      continue
    }
    const value = argv[i + 1]
    if (value == null || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`)
    }
    flags[key] = value
    i++
  }

  // ---- Cross-flag invariants (fail closed before any DB work) ----
  if (!Object.prototype.hasOwnProperty.call(flags, "id")) {
    throw new Error("--id is required (the character id to preview/delete)")
  }
  if (flags.id === "") {
    throw new Error("--id must be a nonempty character id")
  }
  if (Object.prototype.hasOwnProperty.call(flags, "execute")) {
    if (!Object.prototype.hasOwnProperty.call(flags, "confirm")) {
      throw new Error("--confirm is required when --execute is set")
    }
    if (flags.confirm === "") {
      throw new Error("--confirm must be a nonempty character id")
    }
  } else if (Object.prototype.hasOwnProperty.call(flags, "confirm")) {
    throw new Error("--confirm is only valid together with --execute")
  }
  return flags
}

// ------------------------------------------------------------------ //
// DATABASE_URL validation (never prints the value)
// ------------------------------------------------------------------ //

/**
 * Validate the inherited DATABASE_URL. Requires a nonempty, parseable
 * PostgreSQL URL whose pathname names exactly one database. The URL is never
 * interpolated into an error; messages refer to "DATABASE_URL".
 */
export function validateDatabaseUrl(raw) {
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
    throw new Error("DATABASE_URL must be a PostgreSQL URL")
  }
  const seg = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "")
  if (seg === "" || seg.includes("/")) {
    throw new Error("DATABASE_URL pathname must name exactly one database")
  }
  return { scheme, dbname: seg }
}

// ------------------------------------------------------------------ //
// Queries (never mutating for preview, single-row delete for execute)
// ------------------------------------------------------------------ //

/**
 * Read-only preview for a character. Returns null when no character has that
 * id; otherwise a preview object carrying the target id, name, ownerId,
 * archived flag and the count of every dependent kind. Nothing is deleted.
 */
export async function previewCharacter(db, id) {
  const character = await db.character.findUnique({ where: { id } })
  if (!character) return null
  const counts = await Promise.all([
    db.asset.count({ where: { characterId: id } }),
    db.progressionEvent.count({ where: { characterId: id } }),
    db.characterAssociation.count({ where: { characterId: id } }),
    db.characterInventoryItem.count({ where: { characterId: id } }),
    db.characterCurrencyBalance.count({ where: { characterId: id } }),
    db.skillOffer.count({ where: { characterId: id } }),
    db.skillOfferOption.count({ where: { offer: { characterId: id } } }),
  ])
  return {
    id: character.id,
    name: character.name,
    ownerId: character.ownerId,
    archived: character.archived,
    counts: {
      assets: counts[0],
      events: counts[1],
      associations: counts[2],
      inventory: counts[3],
      currencyBalances: counts[4],
      skillOffers: counts[5],
      skillOfferOptions: counts[6],
    },
  }
}

/**
 * Delete the single character with the exact id inside a transaction. Re-reads
 * the exact id (authoritative) and deletes `{ id }` only; the database's FK
 * cascades remove the character's assets, events, associations, inventory,
 * currency balances, skill offers and offer options. Never a broad WHERE and
 * never a whole-DB reset. Returns `{ deleted: true, character }` on success or
 * `{ deleted: false }` when no such id exists.
 */
export async function deleteCharacter(db, id) {
  return db.$transaction(async (tx) => {
    // Re-read the exact id before deleting, so we can report the name and avoid
    // a silent P2025 on an already-gone character.
    const character = await tx.character.findUnique({ where: { id } })
    if (!character) return { deleted: false }
    await tx.character.delete({ where: { id } })
    return { deleted: true, character }
  })
}

// ------------------------------------------------------------------ //
// Output formatting (pure)
// ------------------------------------------------------------------ //

/** Human-readable preview block. */
export function formatCharacterPreview(preview) {
  const c = preview.counts
  return [
    "delete-character: preview (read-only; nothing deleted)",
    `  id:                    ${preview.id}`,
    `  name:                  ${preview.name}`,
    `  ownerId:               ${preview.ownerId}`,
    `  archived:              ${preview.archived}`,
    "  dependents (cascade on delete):",
    `    assets:              ${c.assets}`,
    `    progression events:  ${c.events}`,
    `    associations:        ${c.associations}`,
    `    inventory items:     ${c.inventory}`,
    `    currency balances:   ${c.currencyBalances}`,
    `    skill offers:        ${c.skillOffers}`,
    `    skill offer options: ${c.skillOfferOptions}`,
  ].join("\n")
}

/** Human-readable deletion result. */
export function formatDeleted(character) {
  return [
    `delete-character: deleted character "${character.id}" (name: ${character.name})`,
    "  cascade removed its assets, progression events, associations, inventory,",
    "  currency balances, skill offers and their options.",
    "  Note: portrait/upload METADATA rows were removed, but the image bytes on",
    "  disk (uploads volume / UPLOAD_DIR) were not touched and may be orphaned -",
    "  see docs/deployment.md for the cleanup note.",
  ].join("\n")
}

// ------------------------------------------------------------------ //
// Process orchestration
// ------------------------------------------------------------------ //

function defaultCreateDb({ url }) {
  return new PrismaClient({
    datasources: {
      db: { url },
    },
  })
}

/**
 * Run the command. Never mutates until every argument/config check passes. On
 * a configuration problem it fails closed (no DB connection needed); on an
 * unknown id it reports "not-found" without failing the whole run.
 */
export async function main(options = {}) {
  const env = options.env ?? process.env
  const argv = options.argv ?? process.argv.slice(2)
  const log = options.log ?? ((msg) => console.log(msg))
  const errLog = options.errLog ?? ((msg) => console.error(msg))
  const createDb = options.createDb ?? defaultCreateDb

  // ---- Phase 1: argument/config validation. The errors here originate from
  // our own pure functions (arg parsing, DATABASE_URL validation, the confirm
  // match) and carry only flag names and the user-supplied id - never
  // DB-driver text - so their messages are safe to print verbatim.
  let flags
  try {
    flags = parseArgs(argv)
    validateDatabaseUrl(env.DATABASE_URL)

    // --confirm must equal the EXACT id being deleted. This is the operator's
    // fail-safe: it stops an accidental delete of a different character.
    if (flags.execute && flags.confirm !== flags.id) {
      throw new Error(
        `--confirm must be exactly "${flags.id}" (got "${flags.confirm}")`
      )
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    errLog(`delete-character: ${message}`)
    return { status: "failed", error: message }
  }

  // ---- Phase 2: database work. Any error here (Prisma client init, a
  // connection failure, a query/transaction error, or any unexpected throw)
  // may embed the DATABASE_URL or a driver message, so we log and return a
  // single generic, secret-free message instead of the driver's `.message`.
  let result
  try {
    const db = createDb({ url: env.DATABASE_URL })
    try {
      if (flags.execute) {
        const outcome = await deleteCharacter(db, flags.id)
        if (outcome.deleted) {
          log(formatDeleted(outcome.character))
          result = { status: "ok", deletedId: flags.id }
        } else {
          log(
            `delete-character: character "${flags.id}" not found; nothing to delete.`
          )
          result = { status: "not-found", id: flags.id }
        }
      } else {
        const preview = await previewCharacter(db, flags.id)
        if (!preview) {
          log(
            `delete-character: character "${flags.id}" not found; nothing to delete (preview).`
          )
          result = { status: "not-found", id: flags.id }
        } else {
          log(formatCharacterPreview(preview))
          result = { status: "ok", preview }
        }
      }
    } finally {
      await db.$disconnect()
    }
    return result
  } catch {
    errLog(`delete-character: ${GENERIC_FAILURE_MESSAGE}`)
    return { status: "failed", error: GENERIC_FAILURE_MESSAGE }
  }
}

// ------------------------------------------------------------------ //
// Entry point (guarded so tests can import this module without executing it)
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
    .catch(() => {
      // Safety net: `main` catches everything, but if it ever rejects, print
      // the same generic, secret-free message rather than a driver `.message`.
      console.error(`delete-character: ${GENERIC_FAILURE_MESSAGE}`)
      process.exitCode = 1
    })
}
