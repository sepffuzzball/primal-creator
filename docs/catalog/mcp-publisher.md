# MCP catalog publisher

This documents the **local stdio MCP client** that publishes curated catalog
entries to the deployed app's managed catalog. It is the counterpart to the
admin bulk upload ([docs/catalog/bulk-import.md](bulk-import.md)) and the
reviewed manifest ([docs/catalog/wiki-reviewed.md](wiki-reviewed.md)), but it is
**not** an admin-UI path and it is **not** a scraper: it is a tool an agent (via
OpenCode) calls to manage catalog rows through the fixed publisher routes.

The client is a local MCP server (`scripts/mcp/catalog-server.ts`) launched
under `tsx`. It reads **only** environment variables (no database credentials),
talks to a fixed HTTPS origin, and exposes four tools:

| Tool              | Purpose                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `catalog_list`    | List catalog entry **summaries** for a **required** `kind`, or with `includeArchived`.               |
| `catalog_get`     | Read ONE **full** entry by required `kind` + `stableId` (description, config, gradeDescriptions).    |
| `catalog_preview` | Validate and preview a batch without applying it (per-field `before -> after`).                      |
| `catalog_publish` | Preview internally, then **apply automatically**, reporting the same field values plus apply status. |

There is no arbitrary HTTP fetch and no direct DB access: the target origin and
the bearer token are the only inputs and they come from the environment, never
from a tool argument.

## Deployment prerequisites

The publisher talks only to the deployed app's fixed HTTP routes - it never
touches the database. For those routes to work the deployment must already hold:

- **Release 0.1.0 of the app**, which carries the single from-scratch Prisma
  baseline (`20261016000000_initial_0_1_0`) and the publisher routes. A database
  migrated with the old `0001..0023` chain is not compatible - it must first be
  reset through the one-time guarded reset (see `docs/deployment.md` section
  1.4). A fresh/empty database just runs `pnpm db:migrate` then `pnpm db:seed`.
- **Seeded data.** `pnpm db:seed` (never automatic) bootstraps the admin and the
  curated catalog (>= 41 entries). The publisher only adds/updates rows through
  the MCP routes; nothing auto-creates catalog content at startup.
- **Auth configuration.** `AUTH_SECRET` (>= 32 chars, for preview-ticket signing)
  and `MCP_CATALOG_TOKEN_SHA256` (the SHA256 of the raw publisher token) must be
  set on the server and the app restarted; on the client only the raw
  `PRIMAL_CATALOG_TOKEN` must be set locally, since `PRIMAL_CATALOG_URL` is pinned
  in `opencode.json` (see below).

## Endpoints

The client talks to exactly four fixed routes under the configured origin:

- `GET  /api/mcp/catalog?kind=<kind>&includeArchived=1` - list entries. `kind` is
  **required**: a request without a canonical kind is rejected, so there is no
  "all kinds" listing. The `items` are **lightweight summaries**
  (`kind`/`stableId`/`name`/`grade`/`sourceUrl`/`archived`) that deliberately
  omit the heavy `config`, `description` and `gradeDescriptions` payload; read
  those via the entry route below.
- `GET  /api/mcp/catalog/entry?kind=<kind>&stableId=<id>` - read ONE **full**
  entry. Both `kind` and `stableId` are **required** (`stableId` nonempty, at
  most 128 chars). Returns the complete authored content **untruncated**:
  `name`, `description`, `grade`, `sourceUrl`, `archived`, `config`,
  `gradeDescriptions` (generated ids/timestamps are omitted by the client). The
  `config` and `gradeDescriptions` are JSON-stringified (escaping preserved) and
  the `description` is returned verbatim (whitespace preserved) - none of them
  are collapsed or truncated, so the value you read is the exact value you can
  replace. **Use this before updating an existing entry** so you can retain its
  other `config` fields when you replace `config`, rather than fabricating them.
- `POST /api/mcp/catalog/preview` - body `{ "entries": [...] }` -> changes +
  `previewTicket`.
- `POST /api/mcp/catalog/apply` - body `{ "entries": [...], "previewTicket": "..." }`
  -> changes.

Every request sends `Authorization: Bearer <token>`, uses `redirect: "error"`
(no cross-origin redirects), and times out in 15-30s. Responses are bounded and
JSON is parsed with safe error messages that never echo a secret.

## Environment setup

The client needs a bearer token and a target origin. The **only** variable you
must set **locally** is the raw token. The origin is not a local requirement:
`opencode.json` (under `mcp.servers.primal-catalog`) pins `PRIMAL_CATALOG_URL` to
the configured deployed HTTPS origin (e.g. `https://primalcreator.fuzzball.enterprises`)
and forwards it to the MCP process, while it forwards `PRIMAL_CATALOG_TOKEN` from
the local `{env:PRIMAL_CATALOG_TOKEN}` placeholder - the only env placeholder in
the config. Set `PRIMAL_CATALOG_TOKEN` in your local shell/agent config so that
placeholder resolves; the raw token lives only in that local environment, never in
the committed config:

| Variable               | Requirement                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `PRIMAL_CATALOG_TOKEN` | The raw bearer secret, base64url, **43-256 chars**. Required locally.                                |

`PRIMAL_CATALOG_URL` is optional to set locally - it defaults to the configured
deployed HTTPS origin pinned in `opencode.json` (HTTPS only, origin only: no path,
query, fragment or userinfo). If you need a different origin (a staging deployment,
a local tunnel) change that literal in `opencode.json`; or, if you prefer not to
hardcode it there, replace it with `{env:PRIMAL_CATALOG_URL}` and set that variable
locally instead. Never hardcode a raw token in the config: the token is always the
`{env:PRIMAL_CATALOG_TOKEN}` secret placeholder.

The client validates these and **fails closed**: an invalid/missing value causes
every tool call to return an error result and a diagnostic on STDERR (never on
stdout, which is the MCP protocol channel). The raw token is only ever used in
the `Authorization` header and never appears in a chat, log, or tool result.

### Server-side configuration

The deployed app must be configured with the **SHA256** of the exact raw token:

- `MCP_CATALOG_TOKEN_SHA256` - exactly 64 lowercase hex chars, the SHA256 of the
  raw `PRIMAL_CATALOG_TOKEN` value.
- `AUTH_SECRET` - >= 32 chars, used to sign preview tickets (NOT the MCP bearer).

The token hash is paired with the raw token: the server hashes the bearer it
receives and compares in constant time, so the raw value must be
byte-for-byte what the hash was derived from.

### Generate a token securely

```bash
# A random, high-entropy base64url secret (>= 43 chars, base64url charset).
# Convert the random value to base64url FIRST: strip '+', '/', '=' padding and
# the trailing newline so the client's base64url validator accepts it.
PRIMAL_CATALOG_TOKEN="$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')"

# The value to deploy to the server's MCP_CATALOG_TOKEN_SHA256 env.
# Hash the SAME base64url value the client actually sends.
printf '%s' "$PRIMAL_CATALOG_TOKEN" | sha256sum | cut -d' ' -f1
```

Deploy that hash to the server env (and set `AUTH_SECRET` to a value of at
least 32 chars), **restart the app**, then set the client-side raw
`PRIMAL_CATALOG_TOKEN` in your shell/agent config (the `PRIMAL_CATALOG_URL` origin
is already pinned in `opencode.json`). Never commit a production secret or a real
production token as an example.

> `openssl rand -base64 48` emits standard base64, which can include `+`, `/` and
> `=` padding, but the client only accepts the base64url charset (`-`/`_`, no
> padding). The commands above convert the random value to base64url BEFORE you
> hash it, so the raw `PRIMAL_CATALOG_TOKEN` value is exactly what the client
> sends and what the server hashes - never hash a pre-translation (standard
> base64) form and then translate.

## Verify it works

```bash
# 1. The server starts and reports the bound origin on STDERR.
PRIMAL_CATALOG_URL="https://app.example.com" \
PRIMAL_CATALOG_TOKEN="<your 43+ char base64url token>" \
  pnpm mcp:catalog
# -> [primal-catalog] serving stdio against https://app.example.com

# 2. Exercise it through the MCP Inspector without a host.
PRIMAL_CATALOG_URL="https://app.example.com" \
PRIMAL_CATALOG_TOKEN="<token>" \
  npx @modelcontextprotocol/inspector -- pnpm mcp:catalog
```

In the Inspector, connect and call `catalog_list`. A successful list means the
origin and token are valid and the server is reachable. If any tool returns an
error, check the STDERR output first: it will describe the configuration problem
without leaking the token.

## Catalog semantics

- **Authoritative by key.** An entry is addressed by `(kind, stableId)`: an
  absent key is **created** (`archived: false`), a present key is **updated in
  place**, and a no-op is reported `unchanged`. There is **no delete** and **no
  archive toggle** - a managed batch never unarchives an archived row.
- **Edits are updates, not skips.** Unlike the bulk/CSV upload (which only ever
  creates and skips an existing key), a managed publish **overwrites** an
  existing entry with the values you submit. Never assume a publish only creates
  new rows.
- **Strict entry schema.** Only `kind`, `stableId`, `name`, `description`,
  `grade`, `sourceUrl`, `config`, `gradeDescriptions` are accepted. An `archived`
  flag or a typo is rejected (strict), and a `sourceUrl` must be a valid HTTPS
  URL with a host when supplied. `kind` uses the canonical catalog kinds
  (`races`, `classes`, `professions`, `titles`, `equipment`, `skills`,
  `bloodlines`, `items`, `gods`, `transcendent_skills`, `currencies`) - the
  legacy `consumables` alias is not accepted here.

## Limits

- At most **50 entries** per batch (a larger batch is rejected before any write).
- Per field: `stableId` <= 128, `name` <= 256, `description` <= 8000,
  `sourceUrl` <= 2048, `config` JSON <= 64 KiB and nesting <= 12 levels.
- The client bounds each response body (fail closed on an oversized response)
  rather than buffering unbounded input.

## Partial updates vs config full replacement

- **Scalar fields**: on an update, an **omitted** field is preserved and an
  explicit `null` clears a nullable field. `stableId` and `name` are always
  required on both create and update (an update must re-declare its name).
- **`config` is a FULL REPLACEMENT**, not a merge. When you supply `config`, it
  replaces the stored config wholesale. Do not assume a partial `config` merges
  with the existing value; include the whole object you want stored.
- **Read before you replace config - from `catalog_get`, not from a preview.**
  Because a supplied `config` replaces the stored one wholesale, before updating
  an existing entry call `catalog_get` for its `(kind, stableId)` to read the
  current **full and untruncated** content and carry every field you intend to
  keep into the replacement `config`. The `catalog_preview`/`catalog_publish`
  reports are **bounded**: they collapse whitespace and cut a long value with an
  explicit `[truncated]` marker, so they are NOT a faithful copy of a stored
  `config`. Only `catalog_get` returns the exact JSON-stringified `config`,
  `gradeDescriptions` and complete `description`. If you cannot read the full
  details of a row you are about to update, **decline that update** rather than
  fabricating its existing `config` from memory or from a truncated preview.
- **Race identity is required.** A `races` config must explicitly declare BOTH
  `raceType` and `naturalGrade`, otherwise a config-changing update silently
  retains omitted identity. Always declare them for a race.
- A `skills` config needs `track` (`race`|`class`|`profession`), a valid
  `rarity` (a NEW skill requires one), and cannot mix `track`/`milestone`
  incorrectly. A new `equipment` config requires a valid `slot` and `rarity`.
  See `docs/rules/` for the per-kind details.

## Conflicts and retries

The apply is a single `SERIALIZABLE` transaction - all or nothing. It fails with
**409** in these cases, with no partial write:

- **Preview ticket expired or not bound.** Tickets are content-bound and last
  **5 minutes**. If you preview, then wait too long (or the payload/state
  changed), the apply rejects the ticket.
- **Any concurrent catalog change.** The `stateDigest` hashes **every** catalog
  row (id, kind, stableId, archived, every field, config, `gradeDescriptions`,
  timestamps), so an unrelated edit - even a brand-new key that is not part of
  your batch - invalidates the preview.
- **An archived conflict.** A managed publish requires an active entry; a row
  that is archived cannot be unarchived by the batch.

When you get a 409, **re-preview and retry**. The client surfaces the 409 and
tells you to do exactly that; it never fabricates a successful publish.

## Automatic apply, no manual approval

There is **no manual approval step** for the agent: `catalog_publish` runs the
preview (to obtain the ticket), then applies automatically. The preview is
transparency (so a human can see create/update/unchanged before it happens), not
a gate. The preview and the publish both report each changed **substantive**
field (name, description, grade, sourceUrl, config, gradeDescriptions) as
**bounded** `before -> after` values; a value that was cut carries an explicit
`[truncated]` marker (never a bare ellipsis), so a preview is NOT a faithful copy
of a long `config` or `description` - use `catalog_get` for that. A create has no
`before` (shown as absent), and generated ids/timestamps are deliberately omitted
because they are not an exact persisted preview. `catalog_publish` reports the
same field-level values PLUS the apply status and field changes, so the automatic
edit is fully observable. The only thing that prevents an apply is a 409, which
the caller resolves by re-previewing and retrying.

## Token rotation

To rotate the publisher token:

1. Generate a new raw token (see above).
2. Deploy its SHA256 to `MCP_CATALOG_TOKEN_SHA256` and restart the app.
3. Update `PRIMAL_CATALOG_TOKEN` on the client side to the new raw value.
4. Verify with `catalog_list`; a 401/503 means the client and server no longer
   agree.

The old token stops working immediately on restart; no other coordination is
required. Never share the raw token in a doc or log - only its hash is safe to
write down.
