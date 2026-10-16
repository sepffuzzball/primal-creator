---
name: catalog-publisher
description: Publish curated catalog entries to the deployed app's managed catalog using the local MCP tools (catalog_list, catalog_get, catalog_preview, catalog_publish). Use when adding or updating catalog entries from wiki/notes evidence, when a deployment of the catalog publisher already exists, and when no per-entry confirmation is wanted - apply is automatic after preview.
---

# Catalog publisher

You publish catalog entries (races, classes, professions, titles, equipment,
skills, bloodlines, items, gods, transcendent_skills) to the deployed app's
managed catalog. This is a **local stdio MCP client**: the tools talk to a fixed
HTTPS origin configured by the operator (`PRIMAL_CATALOG_URL` + bearer token).
There is no arbitrary HTTP fetch and no direct database access - the target
origin and token are fixed, never a tool argument.

## Tool workflow

The MCP server exposes exactly four tools:

- `catalog_list` - list existing entries for a **required kind** (`kind`,
  `includeArchived`). Read-only. The GET route requires a canonical kind, so you
  must name one; there is **no "all kinds" listing** - call it once per kind.
  The summaries deliberately **omit** `config`, `description` and
  `gradeDescriptions` (heavy content) - read those via `catalog_get` for a single
  entry.
- `catalog_get` - read ONE full entry by required `kind` and `stableId`
  (`stableId` 1-128 chars). Read-only. Returns the full authored content
  (`name`, `description`, `grade`, `sourceUrl`, `archived`, `config`,
  `gradeDescriptions`) **untruncated**: `config` and `gradeDescriptions` are
  JSON-stringified (escaping preserved) and `description` is returned verbatim
  (whitespace preserved); generated ids/timestamps are omitted. This is the ONLY
  faithful source for a stored `config`/`description`. **Call this before
  updating an existing entry** so you retain its other `config` fields when you
  replace `config` - never fabricate the existing config.
- `catalog_preview` - validate and preview a batch WITHOUT applying it. The
  result shows each changed substantive field as `before -> after` (name,
  description, grade, sourceUrl, config, gradeDescriptions), with generated ids
  and timestamps omitted. The values are **bounded**: whitespace is collapsed and
  a value that was cut carries an explicit `[truncated]` marker (never a bare
  ellipsis). Do NOT treat a preview's `config`/`description` as the exact stored
  value - use `catalog_get` for that.
- `catalog_publish` - validate, preview, then APPLY automatically. It reports the
  same field-level `before -> after` values plus the apply status and field
  changes, so automatic edits are observable without asking for confirmation.

`catalog_publish` internally runs a fresh preview to obtain a content-bound
preview ticket and then applies with it. **Never ask the user to confirm each
entry**: once the preview/validation passes, publish applies the whole batch in
one atomic transaction. The only thing that blocks an apply is a 409 (the
catalog changed concurrently, a ticket expired, or an entry is archived) - in
that case surface the 409 and tell the caller to re-preview and retry.

## Required workflow

1. **Inspect the existing catalog first.** Call `catalog_list` **once per kind**
   you intend to touch (and `includeArchived` when you must see archived rows).
   Each call requires a specific `kind` - there is no "all kinds" listing, and the
   summaries deliberately omit `config`/`description`/`gradeDescriptions`. Record
   the existing `(kind, stableId)` keys so you never create a duplicate and never
   rename a stable ID. Before you update an existing entry, call `catalog_get`
   for that `(kind, stableId)` to get its current **full, untruncated** content
   (especially `config`) - the exact value you will replace, unlike a bounded
   `catalog_preview`. Retain the existing config fields you intend to keep, and
   NEVER fabricate fields you did not read: if you cannot read the full details of
   a row you are about to update, decline that update rather than inventing its
   config.
2. **Preserve stable IDs.** A managed batch is authoritative by
   `(kind, stableId)`: an absent key is created, a present key is UPDATED in
   place, and a no-op is reported `unchanged`. There is no delete and no archive
   toggle. Do not invent a new stableId for an entry that already exists.
3. **Draft structured entries.** Each entry uses the closed schema:
   required `kind`, `stableId`, `name`; optional `description`, `grade`,
   `sourceUrl`, `config`, `gradeDescriptions`. `sourceUrl` is optional but must
   be a valid HTTPS URL with a host when present. `config` is free-form per kind;
   `grade` comes from G/F/E/D/C/B/A/S. Rejecting an `archived` key is expected
   (the schema is strict). At most 50 entries per batch.
4. **Call `catalog_preview`** to validate and see the per-entry
   create/update/unchanged status before any write. For every changed substantive
   field (name, description, grade, sourceUrl, config, gradeDescriptions) it
   reports the bounded `before -> after` actual values; a create has no `before`
   (shown as absent). Generated ids/timestamps are omitted - they are not an
   exact preview you can rely on.
5. **Call `catalog_publish`** to apply. It previews again internally, so the
   events you saw in step 4 are for your understanding, not a prerequisite. The
   result reports the same field-level `before -> after` values PLUS the apply
   status and field changes, so the automatic edit is fully observable - never
   assume a publish silently creates rows and never ask the user to confirm each
   entry. After publishing, report the per-entry status, the target URL and the
   HTTP result. If the publish returns a 409, do NOT fabricate success - say the
   catalog changed and recommend retrying after re-previewing.
6. **Warn about edits.** Existing entries get UPDATED (their config is replaced,
   see below) - never silently assume a publish only creates rows. If you do not
   intend to change an existing entry, leave it out of the batch. Before changing
   an existing entry's `config`, read it first with `catalog_get` so you retain
   the fields you are not changing.

## Evidence and honesty

- Sources are wiki URLs / plain notes the assistant can read with its own web
  tools. Do not claim you fetched the app's catalog from a wiki page.
- Best-effort inference is allowed, but the distinction between FACT and
  INFERENCE must be explicit in the entry/`config` you write, not silently
  blurred. Where the number is an inference, record it in `config` so a human
  can correct it against the source.
- **Never fabricate that the deployment of the app exists** or that a publish
  happened. `catalog_publish` is the only thing that applies; if you only
  previewed, say so.

## Config semantics (important)

- `config` is a **full replacement**, not a merge. On an update, an omitted
  field is preserved and an explicit `null` clears a nullable field, but a
  supplied `config` replaces the whole config object. Never assume a partial
  `config` merges into the stored one.
- **Read before you replace a config - via `catalog_get`, not a preview.** Before
  updating an existing entry, call `catalog_get` for its `(kind, stableId)` to
  read the current **full and untruncated** content (especially its `config`) and
  carry every field you intend to keep into the replacement `config`. The
  `catalog_preview`/`catalog_publish` reports are bounded (truncated values are
  marked `[truncated]`), so they are NOT a faithful copy of a stored `config` -
  only `catalog_get` returns the exact JSON-stringified `config`,
  `gradeDescriptions` and complete `description`. If you cannot read the full
  details of a row you are about to update, **decline that update** rather than
  fabricating its existing config from memory or from a truncated preview.
- A `races` config must explicitly declare BOTH `raceType` and `naturalGrade`;
  otherwise the update silently retains omitted identity. Declare them.
- A `skills` config needs a `track` (`race`|`class`|`profession`),
  a `rarity`, and only one of `track`/`milestone` patterns. A NEW skill config
  requires `rarity`. See the project docs (`docs/rules/`) for per-kind config.
- A new `equipment` config requires a valid `slot` and `rarity`.
- At most 50 entries per batch and config JSON is capped at 64 KiB per entry.

## Secrets

Never put the bearer token or the target URL in a chat message, a log line or a
committed doc as a real secret value. The token is only used in the
`Authorization: Bearer <token>` header; diagnostics never echo it. Refer to the
environment variables by name, not by value.

## Operator setup (someone must configure this once)

The client reads only environment variables:

- `PRIMAL_CATALOG_URL` - the deployed production origin, HTTPS only, origin only
  (no path/query/fragment/userinfo). Example: `https://app.example.com`.
- `PRIMAL_CATALOG_TOKEN` - the raw bearer secret (base64url, 43-256 chars). The
  server must be configured with the SHA256 of this exact raw value as
  `MCP_CATALOG_TOKEN_SHA256` (and `AUTH_SECRET` >= 32 chars for preview
  tickets). Do not put production secrets in examples.

Generate a strong base64url token: convert the random value to base64url BEFORE
hashing (e.g. `openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n'`). The raw
value must be the base64url string itself (no `+`, `/` or `=` padding), since the
client validates against the base64url charset and the server hashes this exact
value. Compute the SHA256 of that converted value, deploy the hash to the server
env, restart the app, and set the two client env vars in your shell/agent config.
Do not commit the real token.
