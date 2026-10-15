# Admin bulk catalog upload (JSON / CSV)

This documents the admin-only **bulk catalog upload**: an authenticated admin
pastes a JSON or CSV file of catalog entries, previews it, then applies it. It is
the arbitrary-upload counterpart to the fixed
[docs/catalog/wiki-reviewed.md](wiki-reviewed.md) manifest, and it is **not** a
scraper and never runs automatically. The preview step and the admin confirmation
in the UI are UX policy, not a server gate: a programmatic admin can call apply
directly without ever calling preview.

The two endpoints are:

- `POST /api/admin/catalog-import/bulk/preview` - **preview**. Parses and validates
  the upload, then computes against the live database WITHOUT mutating anything
  which entries would be created and which would be skipped because a row with the
  same `(kind, stableId)` already exists.
- `POST /api/admin/catalog-import/bulk/apply` - **apply**. Re-validates the upload,
  then inserts every missing row in **one** `SERIALIZABLE` transaction. Existing
  rows are never overwritten; an identical repeated call skips every existing row.
  A conflicting concurrent import surfaces as a 409 with no partial write. Apply
  does not require a prior preview call, and preview is not a server-enforced
  prerequisite (see [Digest](#digest)).

## Request body

Both endpoints accept the same envelope:

```json
{
  "format": "json",
  "content": "..."
}
```

- `format`: `"json"` or `"csv"`.
- `content`: the raw text to parse. For CSV this is the literal file text (UTF-8,
  may include a BOM and CRLF line endings).

The **apply** endpoint accepts an optional `previewDigest` field:

```json
{
  "format": "json",
  "content": "...",
  "previewDigest": "<optional content-integrity digest>"
}
```

## Digest

`previewDigest` is the SHA256 of `format + '\0' + content` (hex encoded). It is not
a checksum of the database or of the parsed rows - it is a checksum of the exact
bytes the admin uploaded. It is also **not** proof that a preview step ran. When a
caller supplies one, the apply endpoint recomputes the digest from the uploaded
content and compares it BEFORE any write; a mismatch is a 400
`preview_digest_mismatch`. When no digest is supplied (a direct programmatic
apply), the endpoint simply skips the check. Because the digest covers the raw
text, changing even one whitespace character changes the digest.

The preview step exists so an admin can see what would be created before mutating
the catalog. It is UI policy, not a server-enforced prerequisite: a programmatic
admin can call apply directly, and preview is never required by the server.

Both endpoints are `POST`, so `requireAdmin` enforces a same-origin CSRF check.
Content is capped at 1 MiB (decoded UTF-8) after the JSON envelope is parsed, and
the raw request body is hard-capped at 4 MiB (which also rejects a bogus
`Content-Length`, falling back to the streamed cap) - either exceeding the cap is
rejected before reaching the parser. At most 250 entries are accepted per upload.

## Preview / apply response

The preview response is:

```json
{
  "source": "bulk",
  "previewDigest": "...",
  "entries": [
    {
      "row": 2,
      "kind": "skills",
      "stableId": "one-step-mile",
      "name": "One Step Mile",
      "sourceUrl": "https://example.com/one-step-mile",
      "status": "create"
    }
  ],
  "createCount": 1,
  "skipCount": 0
}
```

- `row` is the 1-based physical row (for JSON, the array index + 1; for CSV, the
  1-based physical starting line, so the admin can find the offending line).
- `status` is `create` or `skip_existing`.
- `existing` is present only when `status` is `skip_existing`, and carries the
  metadata of the ACTUAL existing catalog row (never the proposed upload values).
  The proposed `name` / `sourceUrl` stay on the entry so the admin can see what
  the upload WOULD have created.
- `createCount` / `skipCount` are actual counts.

The apply response is the same shape plus `createdIds`, the ids of the catalog rows
that were inserted in THIS apply (empty when everything was skipped). The
`previewDigest` in the apply response is the content-integrity hash of the applied
text (recomputed from the upload), not a token issued by the server. Note that the
database may have changed between preview and apply, so the counts reported by
apply reflect the transaction-time state, not the preview.

## Source rules

An upload is un-verified admin content. The old `verified` / `inferred` / `house`
catalog provenance taxonomy has been removed, so a bulk upload no longer
classifies entries by provenance. For backward compatibility the bulk importer
still accepts a `provenance` key (JSON) / header (CSV) and ignores it - even a
`verified` value - so an upload written against the old format keeps working. It
is never persisted or re-echoed.

`sourceUrl` is optional, but when supplied it MUST be an `https:` URL with a host
(a link to broken evidence must fail at import time).

## Patron-god rules (blessings)

A would-be-CREATED blessing whose `config.patronGodStableId` names a god must
resolve to either:

1. a valid, UNARCHIVED existing god in the catalog, OR
2. a god that would be created by the SAME upload (regardless of row order).

A god stableId that exists but is archived, and is NOT recreated by the upload,
rejects the referencing blessing. A skip-existing blessing (a blessing whose
`(kind, stableId)` already exists) needs no patron revalidation.

Gods are created first inside the apply transaction, then every other kind, so a
blessing may safely name a god that appears later in the file; a missing or
archived patron fails the whole transaction and rolls back every insert.

## JSON format

`content` must be an array of strict objects. Each object:

- Required: `kind`, `stableId`, `name`, `config` (a JSON object).
- Optional: `description` (string or null), `grade` (one of G/F/E/D/C/B/A/S or
  null), `gradeDescriptions` (an object mapping G/F/E/D/C/B/A/S grade keys to
  strings; see [docs/rules/grade-descriptions.md](../rules/grade-descriptions.md)),
  `provenance` (accepted for backward compatibility and ignored),
  `sourceUrl` (https string or null).

The accepted keys on an entry are a CLOSED set - only `kind`, `stableId`,
`name`, `description`, `grade`, `gradeDescriptions`, `provenance`,
`sourceUrl`, and `config`. Any
other own key is rejected with a 400 `validation` error reading
`Bulk row N: unknown field "<key>"`. This is what prevents a typo (e.g.
`descripton`) or an unsupported field (e.g. `archived`) from being silently
dropped: a misspelled or unrecognized key fails the whole import rather than
being ignored. The keys of the `config` object are NOT part of this closed set -
the per-kind config parser owns those, so unknown config properties are left to
it and are not rejected here. Bulk imports never accept an `archived` key and
never create an archived row: every row a bulk import inserts is stored
unarchived, matching the CSV importer.

There is no implicit coercion: a missing required field, an empty required string,
an unknown `kind`, an invalid `grade`, a non-object `config`, a duplicate
`(kind, stableId)` pair, or any key outside the closed set above is a 400 with
the row number.

```json
[
  {
    "kind": "bloodlines",
    "stableId": "bloodline-primal-hunter",
    "name": "Bloodline of the Primal Hunter",
    "description": "A bloodline.",
    "grade": "F",
    "gradeDescriptions": { "F": "A humble beginning." },
    "provenance": "inferred",
    "sourceUrl": "https://the-primal-hunter.fandom.com/wiki/Bloodline_of_the_Primal_Hunter",
    "config": { "effects": [], "gradeEffects": {} }
  },
  {
    "kind": "gods",
    "stableId": "the-primal-hunter",
    "name": "The Primal Hunter",
    "provenance": "house",
    "config": { "pantheon": "Native", "divineRank": "Primordial" }
  }
]
```

A legacy/partial `config` that the service layer would reject on a create (a
blessing missing `tier`/`effects`, a consumable missing `type`, a skill with only
one of `track`/`milestone`, a bloodline missing `effects`, or a transcendent missing
`passiveEffects`) is rejected with an `invalid_config` error, because
the importer never copies an untrusted config into the database unvalidated.

`gradeDescriptions`, when present, is a strict object whose keys must be from the
closed grade set G/F/E/D/C/B/A/S and whose values must be non-blank strings of at
most 8000 characters (leading/trailing whitespace is trimmed). An unknown grade
key, an empty value, or an oversized value rejects the row with a 400 `validation`
error. An empty object `{}` is valid and stores nothing (it is equivalent to the
row being left without the field). It is optional and independent: it never
populates or is populated from `description`, and never revalidates a legacy
config. Old rows simply read back an empty `{}`.

## CSV format

CSV must be RFC 4180, UTF-8 (a BOM is tolerated and stripped), with CRLF (or LF)
line endings. Quoted fields must use doubled quotes (`""`) for a literal quote, and
may contain embedded commas and newlines. The `config` cell is a JSON object (not
an array, not a bare string).

Exact required headers (in any order): `kind`, `stableId`, `name`, `config`.

Optional headers: `description`, `grade`, `gradeDescriptions`, `provenance`,
`sourceUrl`.

Parsing is strict RFC 4180. A duplicate header, an unknown header, a missing
required header, or a data row whose field count does not match the header is a
400 with the row number. Malformed quoting is also rejected with a row-numbered
400: an unterminated quoted field, any non-delimiter character (including
whitespace) immediately after a closing quote, and an unescaped quote in an
unquoted field. The `row` reported for a data row is its 1-based physical starting
line, so a quoted field containing a newline does not corrupt the reported line.

```csv
kind,stableId,name,config,description,grade,gradeDescriptions,provenance,sourceUrl
skills,one-step-mile,"One Step Mile","{""effects"":[],""rarity"":""Common""}",A descriptive skill,,,"{""D"":""A humble beginning.""}",inferred,https://the-primal-hunter.fandom.com/wiki/One_Step_Mile
titles,legendary-prodigy,"Legendary Prodigy","{""flat"":{""strength"":10},""percentBasisPoints"":{""strength"":1000}}","A title",C,"{""C"":""A coming-of-age tale.""}",house,
```

A new or config-changing `skill`/`equipment` config requires a `rarity`; an
`equipment` config must also declare a canonical `slot` (see
[docs/rules/equipment.md](../rules/equipment.md) for the slot name list).

## What is safe about it

- **Never overwrites.** A row occupying a `(kind, stableId)` key is left untouched
  (its config / slug are preserved); the import reports it as
  `skip_existing`.
- **Never implicit.** The catalog is only mutated when an admin calls apply. It is
  never run by `db:seed` or app startup.
- **No auto-granting.** A created catalog row is never granted to a character and
  never enforces acquisition; it only makes the row available for later reference.
- **No partial writes.** Validation and patron checks happen before any write, and
  the apply is a single Serializable transaction, so a failure rolls back
  everything.
- **Closed key set.** A JSON entry may only carry `kind`, `stableId`, `name`,
  `description`, `grade`, `gradeDescriptions`, `provenance`, `sourceUrl`, and
  `config`; any other key -
  a typo such as `descripton`, or an unsupported `archived` - is rejected with a
  400 rather than being silently dropped. Bulk imports never create archived rows.
- **Trusting only validated input.** Each row is run through `catalogCreateSchema`,
  the per-kind config schema, and the same modern-shape guards the service layer
  applies on a create.

## Relationship to the reviewed manifest

The fixed, version-controlled `prisma/catalog/wiki-reviewed.ts` manifest remains a
separate path (`GET` / `POST /api/admin/catalog-import`). It is unchanged: it
always requires an https `sourceUrl`, and its six curated entries are not subject
to the bulk source rules. A bulk upload is a distinct, ad-hoc way to add rows
without editing code.
