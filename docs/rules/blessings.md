# Blessings

## Source & status

- Source: `https://the-primal-hunter.fandom.com/wiki/Blessings`,
  `https://the-primal-hunter.fandom.com/wiki/Titles`.
- The **blessing hierarchy** and **benefits** are verified. The **numeric
  magnitude** of each blessing level is **wiki-uncertain** (no per-level table).

## Verified

- Blessings are an investment of **records** by a god into a mortal. They raise the
  mortal's potential toward godhood and tie their Path to that god's. (The legacy
  "patron" model was retired: a god's identity now lives on the character
  association, not on a catalog `patronId` FK.)
- There are **eight** levels in the blessing hierarchy, from lowest to highest:
  **Baptism, Minor, Lesser, Intermediate, Major, Greater, Divine, True**.
  **Baptism** is the lowest entry tier - a ritual marking a follower as an
  adherent of a god (below the seven substantive blessing levels). Some gods
  require baptisms for followers, marking them as adherents.
- A blessed individual is expected to worship the patron god. Individuals who
  revoke a blessing but still access its records are called **Heretics**.
- Benefits of receiving a blessing (verified list excerpt):
  - Raising the stats of the recipient, **both directly** and **from the title
    acquired with it**.
  - Granting a **skill** chosen by the patron god, with a rarity that **depends on
    the level of blessing** given.
  - Allowing prayer without an external connection.
  - Conferring **records**, especially related to the patron god.
  - Unlocking new options for class and profession upgrades, particularly
    **clerical Professions**, which require the patron god's blessing to function.
- **Notable exception:** Void Gods' blessings appear to work differently; the
  Malefic Viper states they do not have levels like the standard hierarchy.

## Verified titles

The Titles page lists **Blessing Titles**: "Holy Spirit", "Holder of a Godqueen's
Divine Blessing", "Holder of a Primordial's Greater Blessing", "Holder of a
Primordial's Divine Blessing", "Holder of a Primordial's True Blessing".

## Wiki-uncertain

- The exact **stat/bonus magnitude** per blessing level and per title.
- The precise skill-rarity mapping to blessing level.

## Engine note

Model blessings as an eight-level hierarchy (Baptism as the low entry tier, plus
the seven substantive levels Minor..True) that confers stat bonuses, a skill of
rarity tied to the blessing level, and possibly class/profession unlock
(clerical). Levels and values should be **configurable data**, since no source
table pins the magnitudes. No invented formula should be used to derive them.

## Model (god + tier on a character association)

A blessing is **not** a catalog kind. The legacy `blessings` catalog kind was
retired: a blessing is a `BLESSING` `CharacterAssociation` whose `definitionId`
points to a **`gods`** catalog entry, with the exact blessing **tier** stored on
the association link itself (`blessingTier`). Each link carries a nullable
`blessingTier` (`Baptism` | `Minor` | `Lesser` | `Intermediate` | `Major` |
`Greater` | `Divine` | `True`); null means no tier was persisted and the link
synthesizes no effect.

A `gods` catalog entry may optionally declare a `blessingEffects` map in its
config:

```ts
{
  pantheon?: string,
  divineRank?: string,
  // Optional partial record: tier -> declarative effect list. A missing tier (or a
  // god with no entry for that tier) contributes NO effects - the link is still
  // valid and shown, just without a synthesized numeric bonus (no invented value).
  blessingEffects?: {
    Baptism?: SkillEffect[],
    Minor?: SkillEffect[],
    Lesser?: SkillEffect[],
    Intermediate?: SkillEffect[],
    Major?: SkillEffect[],
    Greater?: SkillEffect[],
    Divine?: SkillEffect[],
    True?: SkillEffect[],
  },
}
```

`SkillEffect` is the shared flat/percent discriminated union used by skills,
blessings and bloodlines: `{ phase: "flat", amount }` or
`{ phase: "percent", basisPoints }`, each optionally carrying `condition`,
`stacking`, and `group`. The server validates that every effect vector is a finite
integer so the stored config is a plain JSON-safe data object. `blessingEffects`
keys are STRICT: only the eight blessing tiers are accepted, so a typo (e.g.
`minor`) is rejected rather than silently dropped, while the rest of the config
reads permissively (passthrough) so a future shape cannot break a read.

A god is never auto-linked solely because it exists in the catalog; a character
receives a blessing only when an explicit `{ godId, tier }` selection is linked.
No catalog create/import grants or resolves a blessing and no `patronId` row,
column or index is written (the FK, index and column were dropped). Blessings are
created only through the association flows below.

## Character associations (wired)

A blessing is linked as an association: `associateCharacter` (or create) accepts a
`blessing` selection of `{ godId, tier }`. The god definition must be an
unarchived `gods` entry; the tier is persisted verbatim on the link (never
inferred from the god config), and the `associate` event journal snapshot records
the god's identity (`{ id, name, stableId }`) plus the exact `tier`.

At read time the server synthesizes the declared effects from the god's **current**
catalog config `blessingEffects[tier]` into the character's live `status` without
rewriting the stored state, so catalog edits recalculate live effects and never
mutate historical awards. A link without a tier (or a god with no `blessingEffects`
entry for that tier) contributes no effect; an archived god link is inert. The
`tier` is forwarded as metadata on the event snapshot and exposed on the read view
as `{ kind: "blessing", definition: { kind: "gods", ... }, tier }`.

A character holds **at most one blessing link** - archived or active - at any
time. Adding a blessing atomically replaces every existing BLESSING link on that
character; an archived blessing, though inert, still occupies the single slot until
replaced or removed. The invariant is enforced at the database layer by a partial
unique index (one BLESSING row per character); `associateCharacter` runs the
add/remove under SERIALIZABLE with CAS and maps a concurrent singleton-race
`P2002` to a 409 `blessing_singleton_conflict`.

## Import / export (backup schema v7)

`exportCharacter` emits `primal-character/7`. A v7 `blessing` association
references a `gods` definition (`definition.kind: "gods"`) and carries a REQUIRED
`tier`; the importer persists that tier verbatim on the association link. A
non-gods definition (e.g. a stale `blessings` kind) is rejected at the schema
boundary. A v7 inventory `definition.kind` is `equipment` or `items` only (the
legacy `consumables` alias is rejected, not normalized).

Legacy `primal-character/3` through `/6` documents still parse, but the service
rejects any carrying a `blessing` association with an actionable 400 migration
notice - even when it would otherwise resolve - because the `blessings` catalog
rows no longer exist. The notice does not recommend a post-migration re-export
(re-exporting cannot recover a link whose catalog row and tier live only in the
pre-migration database); it tells the caller to **take a PostgreSQL backup BEFORE
applying migration 0019** and recreate the god + tier links manually afterward,
and to remove the links from the old file only if that is intentional. A legacy
v4/v5/v6 inventory `consumables` kind is normalized to `items`. An import backup
carrying more than one total blessing link (active + archived) is rejected with
400 `import_link_collision` before any write.

## Migration (0019)

Migration `0019_god_blessing_tiers` is **destructive** and **irreversible**: it
deletes every existing `BLESSING` association, preflights and deletes all
`catalog_definitions WHERE kind='blessings'`, adds the nullable `blessingTier`
column, and drops the `patronId` FK/index/column. The deleted blessing links are
**not** recoverable from the post-migration database (the `blessings` catalog rows
are gone), so **take a full PostgreSQL backup BEFORE applying migrations
0017-0019** (the whole destructive chain) and recreate god + tier links manually
afterward if the backup's blessing links must be preserved. The
`CatalogKind.blessings` enum value is left dormant (no new write uses it).

The migration also adds a database CHECK constraint
(`character_associations_blessing_tier_check`) on `character_associations`: a
`BLESSING` link must carry a non-null `blessingTier` and every other kind must
carry a null `blessingTier`. The check is added AFTER the legacy BLESSING links
are deleted, so a pre-existing null-tier row can never violate it; from here on
the application (schema + service) and the database agree that a blessing link is
never created with a null tier.
