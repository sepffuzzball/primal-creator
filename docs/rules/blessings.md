# Blessings

## Source & status

- Source: `https://the-primal-hunter.fandom.com/wiki/Blessings`,
  `https://the-primal-hunter.fandom.com/wiki/Titles`.
- The **blessing hierarchy** and **benefits** are verified. The **numeric
  magnitude** of each blessing level is **wiki-uncertain** (no per-level table).

## Verified

- Blessings are an investment of **records** by a god into a mortal. They raise the
  mortal's potential toward godhood and tie their Path to that god's. Upon issuing
  a blessing, the issuing god becomes the mortal's **patron**.
- There are **seven levels** in the blessing hierarchy, from lowest to highest:
  **Minor, Lesser, Intermediate, Major, Greater, Divine, True**.
- Some gods require **baptisms** for followers, marking them as adherents.
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

Model blessings as a seven-level hierarchy that confers stat bonuses, a skill of
rarity tied to the blessing level, and possibly class/profession unlock
(clerical). Levels and values should be **configurable data**, since no source
table pins the magnitudes. No invented formula should be used to derive them.

## Catalog config (modern shape)

A `blessings` catalog entry must declare the modern shape on create or any
config-changing update:

```ts
{
  // Required: the seven-level blessing hierarchy (Minor..True).
  tier: "Minor" | "Lesser" | "Intermediate" | "Major" | "Greater" | "Divine" | "True",
  // Optional: the stableId of the unarchived `gods` entry that is this blessing's
  // patron. When present the server resolves it to the FK `patronId`. A
  // `gods` entry with no blessing may have no `patronId` (it is not a patron).
  patronGodStableId?: string,
  // Required: the typed flat/percent declarative effects. Every vector value must
  // be a finite integer (never a float, NaN or Infinity). A purely narrative
  // blessing (no numeric effect) uses [].
  effects: SkillEffect[],
  // Optional: stableIds of blessings this one is compatible with (no numeric
  // application yet - phase 2).
  compatibleBlessingStableIds?: string[],
  // Optional: forwarded as-is (used only to remove superseded linked benefits).
  upgradeGroup?: string,
}
```

`SkillEffect` is the shared flat/percent discriminated union used by skills,
blessings and bloodlines: `{ phase: "flat", amount }` or
`{ phase: "percent", basisPoints }`, each optionally carrying `condition`,
`stacking`, and `group`. The server validates that every effect vector is a
finite integer so the stored config is a plain JSON-safe data object.

Legacy entries carrying the old `{ grade, effect }` shape remain readable and
metadata-only-PATCHable; a create or config-changing update is rejected unless
both `tier` and `effects` are present. A blessing that names an archived or
missing god is rejected with `patron_god_not_found` / `patron_god_archived`; a
`gods` entry's `stableId` cannot change while any blessing still references it
as patron (409 `patron_stable_id_in_use`), so the JSON `patronGodStableId` and
the stored FK `patronId` never diverge.

## Character associations (wired)

Blessings can be attached to a character as an association. The server
synthesizes the declared `effects` into the character's live `status` without
rewriting the stored state, so catalog edits recalculate live effects and never
mutate historical awards. The `tier` is forwarded as metadata on the event
snapshot. Archived blessings are inert: a linked but archived definition
contributes no effect.

A character holds **at most one blessing link** - archived or active - at any
time. Adding a blessing atomically replaces every existing BLESSING link on that
character, including archived ones; an archived blessing, though inert, still
occupies the single blessing slot until it is replaced (by adding a new blessing)
or removed. The invariant is enforced at the database layer by a partial unique
index (one BLESSING row per character); `associateCharacter` runs the add/remove
under SERIALIZABLE with CAS and maps a concurrent singleton-race `P2002` to a 409
`blessing_singleton_conflict`, while an `updateCatalogItem`/import that would
leave a character with more than one blessing link is rejected with 409
`link_collision`. Upgrades are explicit: choose the newer catalog blessing - the
old link is displaced and journaled in the `removed` array of the `associate`
event. `compatibleBlessingStableIds` is stored as metadata but does not yet gate
coexistence (phase 2). An import backup that carries more than one total blessing
link (active + archived) is rejected with 400 `import_link_collision` before any
write.
