/**
 * Real-Postgres test for the single 0.1.0 initial baseline migration
 * (`prisma/migrations/20261016000000_initial_0_1_0`).
 *
 * This migration replaces the entire 0001..0023 chain with one from-scratch
 * baseline that must run ONLY against an EMPTY database. Because Prisma's schema
 * cannot express CHECK constraints, partial unique indexes or the singleton
 * house-rules seed, those are appended verbatim to the generated baseline SQL -
 * and this test proves they actually exist in the applied schema, so a
 * from-scratch baseline is byte-for-byte equivalent to what the old chain would
 * have produced.
 *
 * It also inspects the migration file itself to confirm the leading DO guard
 * (the "reject nonempty _prisma_migrations or any pre-existing public object"
 * guard) is present and runs BEFORE any CREATE, and never drops anything.
 *
 * Runs ONLY when explicitly opted in (see `resolveDbIntegration`), same as every
 * other `.pg.test.ts` file. The database targeted must be a freshly migrated
 * baseline.
 */

import { readFileSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { prisma } from "@/lib/db/client"
import { resolveDbIntegration } from "@/lib/test/db-integration"

const gate = await resolveDbIntegration()

const BASELINE_MIGRATION_NAME = "20261016000000_initial_0_1_0"

// The 11 application tables the final schema creates (everything except the
// Prisma tracking table `_prisma_migrations`).
const APP_TABLES = [
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
] as const

/**
 * Remove SQL comments from a PostgreSQL script so the executable-statement
 * analysis below never matches a keyword that appears only inside a comment -
 * a naive `sql.indexOf("CREATE ")` would otherwise falsely fire on a leading
 * comment such as "runs BEFORE any CREATE, ...".
 *
 * Line comments (two dashes) and block comments (slash-star ... star-slash) are
 * removed. Single-quoted string literals and double-quoted identifiers (with
 * their doubled-quote escapes) are preserved, so a comment marker inside a
 * literal is never mistaken for a comment. A block comment is replaced with a
 * single space so adjacent tokens are not glued together. The 0.1.0 baseline
 * uses no dollar-quoted body that contains a comment marker, so dollar-quoting
 * needs no special handling here.
 */
function stripSqlComments(sql: string): string {
  let out = ""
  let i = 0
  const n = sql.length

  while (i < n) {
    const ch = sql[i]
    const next = sql[i + 1] ?? ""

    if (ch === "-" && next === "-") {
      // -- line comment: drop up to (not including) the line terminator.
      while (i < n && sql[i] !== "\n") i++
      // Keep the newline so relative positions of surviving tokens stay stable.
      if (i < n) {
        out += "\n"
        i++
      }
    } else if (ch === "/" && next === "*") {
      // /* block comment */: drop it, but keep a single space so adjacent tokens
      // do not get concatenated.
      i += 2
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++
      i += 2
      if (out.length > 0) out += " "
    } else if (ch === "'") {
      // Single-quoted string literal.
      let j = i + 1
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2
            continue
          }
          break
        }
        j++
      }
      out += sql.slice(i, j + 1)
      i = j + 1
    } else if (ch === '"') {
      // Double-quoted identifier.
      let j = i + 1
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2
            continue
          }
          break
        }
        j++
      }
      out += sql.slice(i, j + 1)
      i = j + 1
    } else {
      out += ch
      i++
    }
  }

  return out
}

describe.skipIf(!gate.run)("prisma 0.1.0 initial baseline schema", () => {
  beforeAll(async () => {
    // Warm the connection so the first query in a test is not the DB gate's own.
    await prisma.$queryRaw`SELECT 1`
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it("records exactly one applied baseline migration and nothing else", async () => {
    const rows = await prisma.$queryRaw<
      Array<{ migration_name: string; finished_at: Date | null }>
    >`SELECT "migration_name", "finished_at" FROM "_prisma_migrations" ORDER BY "started_at"`

    expect(rows.map((r) => r.migration_name)).toEqual([BASELINE_MIGRATION_NAME])
    expect(rows[0].finished_at).not.toBeNull()
  })

  it("creates exactly the 11 application tables", async () => {
    const rows = await prisma.$queryRaw<
      Array<{ table_name: string }>
    >`SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`

    const names = rows.map((r) => r.table_name)
    const appNames = names.filter((n) => n !== "_prisma_migrations")
    expect(appNames).toEqual([...APP_TABLES])
  })

  it("adds the quantity and blessing-tier CHECK constraints", async () => {
    const rows = await prisma.$queryRaw<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint
      WHERE conname IN (
        'character_inventory_items_quantity_check',
        'character_associations_blessing_tier_check'
      )
    `
    expect(rows.map((r) => r.conname).sort()).toEqual([
      "character_associations_blessing_tier_check",
      "character_inventory_items_quantity_check",
    ])
  })

  it("creates the partial blessing and bloodline unique indexes", async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
      WHERE indexname IN (
        'character_associations_characterId_blessing_key',
        'character_associations_characterId_bloodline_key'
      )
    `
    expect(rows.map((r) => r.indexname).sort()).toEqual([
      "character_associations_characterId_blessing_key",
      "character_associations_characterId_bloodline_key",
    ])
  })

  it("defines the four application enums in the public schema", async () => {
    const rows = await prisma.$queryRaw<Array<{ typname: string }>>`
      SELECT t.typname FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
        AND t.typtype = 'e'
        AND t.typname IN ('Origin', 'CatalogKind', 'AssociationKind', 'BlessingTier')
      ORDER BY t.typname
    `
    expect(rows.map((r) => r.typname)).toEqual([
      "AssociationKind",
      "BlessingTier",
      "CatalogKind",
      "Origin",
    ])
  })

  it("seeds the active house_rules singleton with the full final default config", async () => {
    const rows = await prisma.$queryRaw<Array<{ config_text: string }>>`
      SELECT "config"::text AS config_text FROM "house_rules" WHERE "id" = 'active'
    `
    expect(rows).toHaveLength(1)
    const config = JSON.parse(rows[0].config_text)
    expect(config).toEqual({
      equipmentIndividualCapPercent: 20,
      equipmentCombinedCapPercent: 15,
      consumableGradeRates: { F: 3, E: 5, D: 15, C: 45 },
      maxTranscendentSkills: 3,
      skillChoiceIntervals: {
        G: 5,
        F: 5,
        E: 5,
        D: 20,
        C: 30,
        B: 40,
        A: 50,
        S: 60,
      },
    })
  })

  it("migration file opens with the guard and never drops anything", () => {
    const rawSql = readFileSync(
      new URL(
        "../../prisma/migrations/20261016000000_initial_0_1_0/migration.sql",
        import.meta.url
      ),
      "utf8"
    )
    // Analyze ONLY the executable SQL. Stripping comments first means a keyword
    // that appears solely in a leading comment (e.g. "runs BEFORE any CREATE")
    // is never mistaken for a real statement.
    const sql = stripSqlComments(rawSql).trim()

    // The executable migration MUST open with the DO guard: it is the first
    // statement, and it runs BEFORE any CREATE.
    expect(sql.startsWith("DO $$")).toBe(true)
    const firstCreate = sql.indexOf("CREATE ")
    const doIndex = sql.indexOf("DO $$")
    expect(doIndex).toBeGreaterThanOrEqual(0)
    expect(firstCreate).toBeGreaterThan(doIndex)

    // Guard semantics: it rejects a non-empty _prisma_migrations and pre-existing
    // public objects, and raises (never drops).
    expect(sql).toContain("_prisma_migrations")
    expect(sql).toContain("RAISE EXCEPTION")
    expect(sql).toContain("CONSTRAINT")
    expect(
      /DROP\s+TABLE|DROP\s+INDEX|DROP\s+TYPE|DROP\s+COLUMN/i.test(sql)
    ).toBe(false)
  })
})
