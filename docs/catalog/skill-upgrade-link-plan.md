# Skill upgrade link plan (MCP)

Status: **reviewable plan - NOT published yet.** This document and the companion
machine-readable plan
([skill-upgrade-link-plan.json](skill-upgrade-link-plan.json)) record the DIRECT
rarity-adjacent upgrade edges to express as an explicit
`config.upgradeToStableIds` on LIVE deployed `skills` catalog entries. No
publish has been performed (the user chose to wait until the new validating
app/migration is manually deployed). The guarded publisher script
(`scripts/mcp/publish-skill-links.mjs`) exists to replay this plan against the
live catalog and is read-only by default (see section 14); it has not been run
against production.

## 1. What this plan is

The runtime has two ways to resolve a skill's successor:

- **Legacy fallback**: when a skill's `config` carries no
  `upgradeToStableIds`, the runtime orders the skill's `upgradeGroup` by `rarity`
  and derives the next strictly-higher rarity in that group.
- **Explicit edge**: a skill `config` that declares an own
  `upgradeToStableIds` array uses those DIRECT target stableIds and ignores rarity
  / track / upgrade group for the successor resolution. An explicit `[]` is
  terminal.

A skill config may also declare `upgradeGroup` and `rarity`. The plan below
derives which skills should carry an explicit `upgradeToStableIds` so the
adjacency is deterministic and reviewable, replacing the legacy fallback for
those specific edges. It deliberately does NOT rewrite every skill - only the
ones that have a directly adjacent higher rarity member.

## 2. Data source

The plan is built from a read-only snapshot of the deployed app's catalog taken
via the MCP client (authenticated GET only; no token is logged):

- `GET /api/mcp/catalog?kind=skills` (list) -> `skills_list.json` (summaries:
  `kind`, `stableId`, `name`, `grade`, `sourceUrl`, `archived`). Used ONLY to
  verify the archived count.
- `GET /api/mcp/catalog/entry?kind=skills&stableId=<id>` per skill - the full
  published skill records snapshot at `skills_records.json` carrying `sid`,
  `name`, `grade`, `rarity`, `track`, `upgradeGroup`.

The two files were cross-matched: every `stableId` in the list exists in the
records snapshot and vice versa (empty symmetric difference).

## 3. Observed counts

| Field                   | Value               | Source                                         |
| ----------------------- | ------------------- | ---------------------------------------------- |
| `snapshotCount`         | 332                 | records snapshot                               |
| `archivedCount`         | 0                   | GET list: all 332 items have `archived: false` |
| Distinct stableIds      | 332 (no duplicates) | records snapshot                               |
| `upgradeGroup` non-null | 7                   | records snapshot                               |

The live deployed set is therefore 332 active `skills` rows; zero are archived.

## 4. Edge criteria (deterministic)

1. Group every deployed skill record by EXACT `name` AND the same `track`
   (`race` / `class` / `profession`). A group with more than one member is a
   "same-name same-track family". Exactly **22** such families exist.
2. Order each family's members by the canonical rarity ladder index (section 5),
   ascending by commonness.
3. Emit a DIRECT edge ONLY between two members whose ladder indexes differ by
   exactly **1** (adjacent rarity). No skip-tier edge.
4. A family whose present rarities are separated by a gap produces **no**
   adjacent edge (it is excluded from the plan and keeps the legacy fallback).
5. Cross-name edges are allowed for exactly two legacy `upgradeGroup` pairs that
   are adjacent in rarity (section 8); no other cross-name edge is inferred.

## 5. Adjacency rarity ladder

The canonical comparable ladder, ascending by commonness:

    Inferior < Common < Uncommon < Rare < Epic < Ancient < Legendary
            < Mythical < Sacred < Divine

The `Unique` rarity is **incomparable** (no tier is above or below it), so it is
never the source or target of an adjacent edge. `rarityOrderIndex` returns
`undefined` for `Unique` and for an unrecognized/missing value.

## 6. Same-name families: breakdown

22 families share an exact name and track. Every family's members carry a
comparable ladder rarity (none is `Unique` or missing). The adjacency column is
the number of adjacent (index-diff-1) edges; families with zero adjacency are
excluded.

| track      | family                        | members | adjacent edges | status         |
| ---------- | ----------------------------- | ------: | -------------: | -------------- |
| class      | Arcane Powershot              |       2 |              1 | in plan        |
| class      | Fangs of Man                  |       3 |              2 | in plan        |
| class      | Identify                      |       3 |              1 | in plan        |
| class      | Moment of the Primal Hunter   |       2 |              1 | in plan        |
| profession | Alchemical Flame              |       2 |              1 | in plan        |
| profession | Blood of the Malefic Viper    |       3 |              2 | in plan        |
| profession | Brew Potion                   |       2 |              1 | in plan        |
| profession | Concoct Poison                |       4 |              3 | in plan        |
| profession | Craft Elixir                  |       2 |              1 | in plan        |
| profession | Distill Powder                |       2 |              1 | in plan        |
| profession | Fangs of the Malefic Viper    |       2 |              1 | in plan        |
| profession | Herbology                     |       2 |              1 | in plan        |
| profession | Malefic Viper's Poison        |       3 |              2 | in plan        |
| profession | Palate of the Malefic Viper   |       3 |              1 | in plan        |
| profession | Pride of the Malefic Viper    |       2 |              1 | in plan        |
| profession | Sagacity of the Malefic Viper |       3 |              2 | in plan        |
| profession | Scales of the Malefic Viper   |       2 |              1 | in plan        |
| profession | Sense of the Malefic Viper    |       4 |              3 | in plan        |
| profession | Touch of the Malefic Viper    |       4 |              3 | in plan        |
| profession | Wings of the Malefic Viper    |       2 |              1 | in plan        |
| profession | Toxicology                    |       2 |              0 | EXCLUDED (gap) |
| profession | Transmute                     |       2 |              0 | EXCLUDED (gap) |

Sum of in-plan adjacent edges: **30**. The two excluded families contribute 0.

## 7. Excluded ambiguous samples

- **Toxicology** (`profession`): members are `Inferior` (index 0) and `Uncommon`
  (index 2). The intermediate `Common` (index 1) is missing, so the only possible
  edge (`Inferior -> Uncommon`) would be a skip-tier. Excluded; 0 edges; keeps
  the legacy `upgradeGroup` + `rarity` fallback.
- **Transmute** (`profession`): members are `Inferior` (index 0) and `Rare`
  (index 3). `Common`/`Uncommon` are missing, so `Inferior -> Rare` is a
  skip-tier. Excluded; 0 edges; keeps the legacy fallback.

The plan's `upgradeLinks` therefore contains no source from either family.

## 8. Cross-name legacy `upgradeGroup` pairs

Two pairs do NOT share a name but DO share the SAME legacy `upgradeGroup`, and
their rarities are adjacent, so the legacy fallback would (or already does) order
them one step apart. These are the only cross-name edges inferred:

| source                              | rarity | target                                            | rarity   | upgradeGroup      |
| ----------------------------------- | ------ | ------------------------------------------------- | -------- | ----------------- |
| `archers-eye` (Archer's Eye)        | Common | `hunters-sight` (Hunter's Sight)                  | Uncommon | `archers-eye`     |
| `big-game-hunter` (Big Game Hunter) | Rare   | `big-game-arcane-hunter` (Big Game Arcane Hunter) | Epic     | `big-game-hunter` |

No other cross-name edge is inferred. Beyond the 4 records in the two pairs
above, the remaining 3 records that carry a non-null `upgradeGroup` are the
`malefic-vipers-poison-*` trio, which is same-name and already handled by
section 6.

## 9. Total plan

- 20 same-name families contribute **30** edges.
- 2 cross-name pairs contribute **2** edges.
- **32 edges total**; the plan JSON lists **32** source entries, one per edge.

Each source entry has exactly one target (adjacency is always a single next
tier). The `upgradeLinks` array is sorted by source `stableId`; each `targets`
array is sorted by target `stableId`.

### Plan file shape

`docs/catalog/skill-upgrade-link-plan.json`:

```
{
  "kind": "skills",
  "snapshotCount": 332,
  "archivedCount": 0,
  "edgeCount": 32,
  "upgradeLinks": [
    { "source": { "stableId", "name", "rarity" },
      "targets": [ { "stableId", "name", "rarity" } ] },
    ...
  ]
}
```

The plan contains no token, no effects body, no descriptions and no PII - only
`stableId` / `name` / `rarity`.

## 10. Verification

Every entry was cross-checked programmatically against the deployed records
snapshot:

- Each `source.stableId` and each `target.stableId` resolves to a record in the
  snapshot carrying the exact matching `name`, `rarity` and `track`.
- Every edge is rarity-adjacent (canonical index diff == 1) and same-track.
- The 32-edge set reproduces EXACTLY when recomputed from the snapshot using the
  criteria in section 4 (same-name adjacent + the two named cross-name pairs).
- No self-link, no missing target, no skip-tier edge, no duplicate source.
- The two cross-name pairs are the only cross-name edges.
- Toxicology and Transmute appear nowhere in the plan.
- `snapshotCount` and `archivedCount` are the observed values from the GET list
  (332 items, all `archived: false`).

## 11. Manual deployment - exact confirmation

Publishing is NOT automatic here:

- A GH `main` push runs `.github/workflows/docker.yml`, which **builds and
  publishes the image** to GHCR (`main`, `latest`, short SHA, and the bare
  semver tag). That push only produces an image; it does **not** migrate the
  database.
- Migrations are **explicit**: `docker compose run --rm app pnpm db:migrate`
  (which is `prisma migrate deploy`). The app image never auto-migrates on
  startup.
- The additive migration relevant to skills is
  `20261017200000_skill_grade_removed`. It:
  1. archives any authored legacy skill `grade` / `gradeDescriptions` into the
     immutable migration-only audit table `legacy_skill_grade_metadata`;
  2. sets every live `skills` row's `grade` to NULL and `gradeDescriptions` to
     `'{}'`;
  3. adds a CHECK constraint so a `skills` row can never hold a grade again.

So the "confirm the new validating app/migration is manually deployed" step is
exactly: after the GH push builds the image, run `pnpm db:migrate` explicitly,
then verify the app serves and the skill-grade-removal migration is recorded in
`_prisma_migrations`. Only then is it safe to publish this plan to the live
catalog.

## 12. Publish workflow (AFTER the migration is manually confirmed)

1. No publish yet - this is the plan.
2. Later, once the migration is confirmed:
   - For each source skill, call `catalog_get { kind: "skills", stableId }` to
     read the FULL current entry (`config`, `description`, `sourceUrl`,
     `gradeDescriptions`). The `catalog_preview`/`catalog_publish` reports are
     **bounded** (they collapse whitespace and truncate long values); only
     `catalog_get` returns the exact, untruncated `config`.
   - Because a supplied `config` is a **FULL REPLACEMENT** (never a merge), carry
     every field you intend to keep (`track`, `rarity`, `upgradeGroup`,
     `effects`, `classStableId`, `milestone`, `choiceGroup`, ...) into the
     replacement config and set `upgradeToStableIds` to the plan's targets for
     that source. Skills NOT in the plan keep the legacy fallback (leave
     `upgradeToStableIds` absent).
   - After the skill-grade-removal migration, a `skills` entry MUST carry
     `grade` as `null` and `gradeDescriptions` empty/omitted. The publisher
     rejects a non-null skill grade (400 `invalid_grade`) and a non-empty skill
     `gradeDescriptions` (400 `invalid_grade_descriptions`).
   - Submit the batch (at most 50 entries; 32 sources is within the limit) to
     `catalog_preview` to validate and inspect the bounded `before -> after`
     diff, then `catalog_publish` applies automatically after an internal preview
     (no manual approval step). A 409 means re-preview and retry.
   - The publisher validates the FINAL skill upgrade graph before any write
     (`validateSkillUpgradeBatch`): a duplicate, self-link, missing/wrong-kind
     target or cycle is 400; a NEW edge to an ARCHIVED target is 400. Rarity/track
     never matter to the graph check.
   - Config JSON limit is 64 KiB, nesting <= 12 levels; a skill's config is far
     under that.

## 13. Terminal tops (not in the plan)

The plan lists only sources that need an explicit outgoing edge. The highest
rarity member of each family (for example `concoct-poison-rare`,
`fangs-of-man-legendary`, `sense-of-the-malefic-viper-legendary`) has no adjacent
higher member, so it is terminal and is NOT listed; it needs no config write.
Middle-rarity members appear as BOTH a target (of the tier below) and a source
(to the tier above), and are listed as a source entry just like any other.

## 14. Guarded publisher script

`scripts/mcp/publish-skill-links.mjs` replays this plan through the SAME
authenticated MCP catalog HTTP preview/apply endpoints used by the local MCP
server (`/api/mcp/catalog`, `/api/mcp/catalog/entry`, `/api/mcp/catalog/preview`,
`/api/mcp/catalog/apply`). It reads the plan from
`docs/catalog/skill-upgrade-link-plan.json` (committed, no secrets) and reads its
configuration from the environment only:

- `PRIMAL_CATALOG_URL` - the deployed HTTPS origin (optional; defaults to the
  documented deployment origin). Must be an origin only; standard bearer
  validation applies and the value is never echoed with credentials.
- `PRIMAL_CATALOG_TOKEN` - the raw base64url bearer token (43-256 chars). Never
  logged; diagnostics never echo it.

It is **read-only by default**. Running it validates and previews and prints a
summary, but does not apply:

```bash
pnpm mcp:publish-skill-links --
```

To apply (after the manual deployment of the skill-grade-removal migration is
confirmed, section 11), run it with `--execute` and the exact confirmation
phrase:

```bash
pnpm mcp:publish-skill-links -- --execute --confirm 'PUBLISH 32 SKILL LINKS'
```

Behavior and guardrails:

- GET the `skills` list (active count is reported; the 332 figure is not enforced
  so new skills may have been added), then GET the FULL record for EACH source
  and EACH target.
- Validate every plan name/rarity/stableId against the live records; reject a
  source or target that is archived; require every edge to be rarity-adjacent
  (comparable ladder index diff exactly 1) and same-track.
- Grade gate: every listed skill's `grade` must be `null` and its
  `gradeDescriptions` empty (`{}`). A non-null grade or non-empty
  gradeDescriptions means the skill-grade-removal migration is not yet deployed
  and the run FAILS CLOSED (never silently writes).
- Config preservation: a source's `config` is a full replacement, so the script
  carries every existing config field (track, rarity, effects, upgradeGroup,
  ...) and changes ONLY `upgradeToStableIds` to the planned targets. A source
  that already declares an explicit `upgradeToStableIds` differing from the plan
  fails rather than being overwritten.
- POST the batch (`{ entries }`, at most 50; 32 sources is within the limit) to
  the preview route and print a summary/diff (status + changed fields only - no
  full config bodies, no secrets). The default dry run stops there.
- With `--execute --confirm '...'`, the SAME validation and preview run first,
  then apply is POSTed with the 5-minute content-bound preview ticket, then each
  source is re-GET to verify the edge was written. Applying never archives, never
  updates grades, and never overwrites config from a partial list.
- A 409 (concurrent catalog change, expired/stale ticket, archived conflict) is
  surfaced and requires a manual re-preview and retry - there is no automatic
  retry and no fabricated success.

Run `pnpm mcp:publish-skill-links -- --help` for the usage banner.
