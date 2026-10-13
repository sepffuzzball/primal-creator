# Calculation Engine (Conceptual Contract)

This document describes the **intended domain model and contract** for the
`primal-creator` calculation engine. It is conceptual: it does not prescribe a
specific implementation, API, or data file, and no source code or config is
changed here. It exists to make the engine's contract explicit so that
implementation work can be delegated consistently.

## Scope

The engine computes a participant's character numbers (attributes, race/class/
profession levels, grade, resources, and related quantities) from source material
and from configured project assumptions. It is NOT responsible for inventing game
rules: it uses only documented base values and explicitly chosen assumptions.

## Three non-negotiable principles

1. **Historical level awards snapshot.** Stat awards come from per-grade base
   values that are captured as a snapshot (a per-grade table of "bonus per level").
   The engine does not derive these from a single closed-form XP formula. If a
   grade's base values exist in the source, they are used verbatim; if not, they
   are configurable assumptions.

2. **Deterministic phase pipeline.** The engine processes a participant through an
   ordered set of phases in a fixed order. Given the same input snapshot and the
   same configuration, output is identical. No randomness, no time-dependence, no
   hidden state.

3. **No invented formulas.** Where the source does not provide a number, the engine
   must not invent one. It uses a configured value and records it as an assumption
   (see `docs/rules/assumptions.md`).

## Deterministic phase pipeline (proposed order)

The phases are ordered so that earlier phases set up values used by later phases.
The exact set may evolve, but the ordering principle (dependencies before
dependents) must hold.

1. **Identity & grade resolution** - Determine the starting grade from provenance
   (newly integrated vs. born into system) and the resolved race/class/profession.
2. **Level resolution** - Resolve each track's level (race, class, profession).
3. **Track awards** - For each track, apply the per-level stat awards from the
   historical snapshot for the relevant grade.
4. **Race-level derivation** - Compute the displayed race level from class and
   profession levels (average, per the sourced rule and the configured
   rounding/missing-track assumptions).
5. **Cap enforcement** - Apply the grade cap for class and profession, distributing
   per the configured distribution rule.
6. **Grade transitions / evolution gating** - Check grade boundaries; if an
   evolution is pending, apply the "no further XP until complete" block and defer
   any track being postponed.
7. **Skill / title / blessing / bloodline application** - Apply sourced modifiers
   (rarity tiers, blessing hierarchy, bloodline gradients, title effects) as
   configured.
8. **Derived resources** - Compute HP/mana/stamina and similar pools. These are
   currently **unresolved placeholders**.
9. **Output snapshot** - Emit the deterministic result plus provenance, so every
   number can be traced to a source or an assumption.

## Data / version architecture

To support source-aware behavior, the engine should be backed by **versioned
source data** plus **configuration overrides**.

- **Versioned source data** - A set of records, each carrying:
  - an identity (e.g. `grade.E.attr`, `race.human.levels`),
  - the value(s),
  - a `source` URL (Fandom/The Primal Hunter Wiki),
  - a `status` field: `verified` | `uncertain` | `assumption`,
  - a `version` and a snapshot date (research date 2026-10-12).
- **Configuration overrides** - The assumption keys from
  `docs/rules/assumptions.md`, layered on top of the source data, so a value can be
  overridden without editing source data.
- **Assumptions must not be merged into "verified" silently.** A number that is an
  assumption stays tagged as an assumption in the output provenance.

Suggested separation (not a mandate):

- `data/` (or equivalent) holds the versioned source snapshots (grade bands,
  per-grade stat bonuses, class/profession caps, blessing hierarchy, bloodline
  gradient, consumable rates, equipment rates).
- `config` holds the assumption defaults and any user overrides.

## Formula examples

### 1. Race-level average with floor rounding (rounding + missing-track)

Source rule: race level = average of class and profession level.
Assumptions: floor rounding; missing track treated as 0.

- Class level 90, profession level 100, race only situational: average = (90+100)/2
  = 95.0 -> floor -> 95. No rounding loss here.
- Class level 91, profession level 100: (91+100)/2 = 95.5 -> floor -> 95. The
  engine rounds **down**, so a participant who is "almost 96" is shown as 95.
- Missing profession: class level 80, no profession -> (80+0)/2 = 40.0 -> 40.

Implication: floor + zero-missing-track makes a single-track race show a much
lower race level than a dual-track race at similar class level. This is a direct
consequence of the house choice, not of the source.

### 2. Cumulative cap enforcement (proportional distribution)

Concept: a grade imposes a maximum total of stat bonus per level (sourced for some
grades: E-grade class 28 without restrictions / 34 with severe restrictions;
D-grade 100 / ~84; profession E-grade 22 / 27, D-grade 80 / ~66, C-grade 240).

If the summed per-level bonus from all attributes would exceed the cap, the engine
distributes the cap **proportionally** to the source values:

- Suppose a class would grant raw bonuses summing to 40 at a grade where the cap is 34. Each attribute's bonus is scaled by 34/40 = 0.85.
- Implication: the engine never silently exceeds the cap; it scales the whole line
  down, which changes attribute ratios. This is a project choice (proportional
  distribution), not a source rule.

### 3. Grade-level band membership (bands are data, not formula)

The grade bands are sourced as ranges (see `docs/rules/grades.md`). The engine
treats them as a lookup table, not as a continuous function. Example mapping for a
fixed level:

- level 8 -> G-grade (if newly integrated) or F-grade (if born-into-system).
- level 10 -> F-grade (auto-advance boundary, source-verified).
- level 150 -> D-grade.
- level 300 -> C-grade.

Implication: the G/F overlap (G 0-9 vs F 0-24) is resolved by **provenance**, not
by a formula. The engine must record whether the participant was newly integrated
or born into the system and choose the appropriate band. This is a data decision,
not a math one.

### 4. Equipment / consumable assumption implications

The equipment (20% individual / 15% combined) and consumable (F3 / E5 / D15 / C45)
rates are **assumptions**; changing them changes roll outcomes but never changes a
sourced value. The engine must treat them as configuration, and the output
provenance must tag them as assumptions so they are never mistaken for canon.

The consumable grade rates are **per-level** rates on **permanent external stat
gains** acquired from consumables, not a cap on temporary potions. A character's
permanent consumable capacity for an attribute is the cumulative sum of the
per-level rate across every race level attained through the grade bands (including
the born-F vs integrated-G handling of the overlapping G/F bands). This capacity is
enforced at application time, and a recorded gain is never re-capped by later
config changes - historical facts are immutable. Temporary potion effects are
bounded only by their effect duration.

These rates are NOT hard-coded. They live in a single server-wide `house_rules` row
(`id = 'active'`, migration `0007_house_rules`) that an admin edits from the
Settings page via `GET`/`PATCH /api/admin/rules`. The engine receives the current
validated config ONCE per request and passes it down through the service layer;
helpers never issue their own hidden DB lookup. Because live status is re-derived
from the current config on every read or mutation, an admin edit is effective
immediately, while the persisted `Character.state`, the append-only journal and
every historical level award stay untouched. A lowered equipment cap clamps only the
currently-synthesized bonus (the surplus becomes `suppressed`), and a recorded
permanent-consumable gain is never re-capped (`remaining = max(0, newer cap - used)`).
The current house-rules version is surfaced as `rulesetVersion` on character details
and list items when the row exists.

## Verification status of inputs

- **Verified:** grade/level bands; race-level = average of class/profession;
  evolution blocks XP until completed; free-point pools per grade for Human;
  skill rarity tiers; blessing 7-level hierarchy; Bloodline of the Primal Hunter
  per-grade gradient; class/profession per-level stat caps (partial grade set).
- **Wiki-uncertain:** exact XP curve; sub-stage boundaries for non-E grades;
  rounding and single-track handling; blessing magnitudes; most bloodline numeric
  effects; derived resource multipliers.
- **House assumptions:** as listed in `docs/rules/assumptions.md`.

## Character-creation drafts (contract)

A **draft** is a resumable snapshot of the character-creation questionnaire. It is
deliberately **not** authoritative character state. The contract is:

- **Scope.** At most one draft per authenticated user (a unique `userId`
  constraint), keyed by that user. Drafts are never public; the API rejects
  unauthenticated reads/writes.
- **What it stores.** Only consumer-authored draft `data` validated against a
  whitelist (`step`, `name`, `description`, `origin`, `raceId`, `classId`,
  `professionId`, `special`, `equipment`, plus optional `nickname`, `pronouns`,
  `ageDescription`, `appearance`, `biography`, `notes`). Each string is bounded and
  the whole payload is capped at 20KB. It never stores uploaded binaries and never
  stores stat vectors, awards or effects - those belong to the engine, not the
  draft. It does not derive any numbers.
- **Concurrency.** The draft row carries an optimistic-concurrency `version`.
  Mutating an **existing** draft requires the exact current `version`; a mismatched
  `version` is a 409 conflict, and omitting `version` on an existing draft is a
  409 `version_required` (the server never guesses/auto-captures the latest
  version, so a client editing from a stale snapshot cannot silently overwrite
  newer work). `version` is only omitted to **create** a draft, and creation is
  attempted only when the user has no draft - a concurrent create that wins the
  unique per-user constraint makes the losing create 409 (it never silently
  overwrites). Deleting an existing draft also requires the exact `version`
  (omitted is 409 `version_required`); deleting with a stale version 409s;
  deleting a non-existent draft with no version is an idempotent no-op.
- **Atomic draft consume on final create (wizard).** Saving a draft and creating
  the final `Character` (and its engine `CharacterState`) remain separate
  operations, but the wizard's final `POST /api/characters` step can make them
  atomic. The request accepts an optional nonnegative `draftVersion`. When
  supplied, the matching draft (`userId` + `version`) is deleted **inside the
  same transaction** as the character row and the `create` progression event; if
  the delete does not match exactly one row, the whole create is rejected with a
  409 `draft_conflict` and **rolled back** - no character row, no event, and no
  second best-effort DELETE afterward. This guarantees the draft is consumed only
  on a successful, confirmed creation, never leaked as a later cleanup step.
  When `draftVersion` is present, the draft is the only source of the create
  payload (no unvalidated state is read from it); the create fields are still
  validated by `characterCreateSchema`. When `draftVersion` is omitted (a
  non-wizard API client, or create-from-scratch), the draft is left untouched and
  the create proceeds as before.

## Trusted-backup character export / import (contract)

A saved character can be exported as a **trusted backup** JSON document (schema
`primal-character/4`) and re-imported into any instance of the app. The document
is a backup, **not** authoritative server-verified state: the contract is. The
older `primal-character/3` document is still ACCEPTED on import (so existing
backups keep working) but is never generated; a v3 backup carries no inventory and
no grandfathering marker, so importing it restores zero stock and marks every
equipment link as grandfathered.

- **Stable identifiers, not internal ids.** The document carries `identity`
  (name, description, origin, race/class/profession) and every association /
  skill-offer option reference by catalog `kind` + `stableId` (never the
  runtime-internal definition id). The raw engine `state` is exported verbatim
  (it keeps its engine-internal `definitionId` values), and on import those
  current track/race definition ids are remapped to the local catalog forms
  (via the same `resolveTrackDefinition` fallback the advancement flow uses - the
  id for the character's grade if defined, otherwise the lowest defined grade -
  for tracks, and the local per-grade `raceDefinitions[grade].id` for the race).
  Historical level awards are preserved verbatim as source snapshots.
- **No catalog is auto-created and no overwrite.** Every identity / association /
  offer-option reference must resolve to an EXISTING catalog definition; a
  missing, wrong-kind, or (for required race/class/profession) archived definition
  rejects the whole import with an actionable 400. Archived associations or offer
  options may be preserved as inert links only when the definition exists. Import
  always creates a NEW character (owned by the current user) - it never mutates an
  existing row.
- **History is provenance, not live ids.** Imported progression events are stored
  as `kind: 'import_history'` events with a `sourceKind` / `sourceCreatedAt` /
  `sourcePayload` provenance, so the source ids are clearly not valid live ids. A
  current-time `kind: 'import'` event is appended.
- **State is self-consistent or rejected.** The `state` is validated against the
  engine `CharacterState` schema, then semantically checked: identity origin must
  agree with any `state.race.origin`, allocations must be nonnegative integers,
  `allocatedPoints` must not exceed `totalFreePoints`, and a derived race level
  must be consistent with the class/profession track levels (per the server-held
  rules config). `liveState` / `status` in the document are advisory and are
  ignored - the server recomputes status from the imported state.
- **Marked as imported.** The created character carries `imported = true`, shown
  in the UI as "Imported - unverified backup", distinguishing untrusted
  user-supplied history from server-verified progression.
- **v4 inventory + grandfathered markers (v4 only).** The current document adds an
  `inventory` array (each entry a `definition` reference by `kind` +
  `stableId`, only `equipment` / `consumables`, with a `quantity` bounded
  1..999999) and a `legacyUnowned` boolean on equipment associations. On import
  the inventory array is bounded at 500 distinct definitions, must resolve to
  EXISTING catalog definitions (archived stock is imported inert), must be unique
  per definition, and is validated before any DB write. An equipment association
  that is NOT grandfathered (`legacyUnowned: false`) requires the backup to import
  at least one owned unit of the matching definition; a grandfathered link
  (`legacyUnowned: true`) may import with zero stock, so an exported grandfathered
  character ALWAYS round-trips. `legacyUnowned: true` on a non-equipment link is
  rejected. The owned-stock rows, association markers, and events are written in
  the SAME transaction as the character, so any resolution/validation failure
  rolls the whole import back; the returned detail exposes the imported inventory
  rows. The `import` marker records `backupSchema` (v3 or v4) and
  `inventoryCount`. A v3 backup imports no stock and grandfathers every equipment
  link (preserving the old backup behavior). Distinct inventory definitions are
  capped at 500 by the inventory adjustment route (a 409), so an exported character
  is always self-roundtrippable.
- **No auto-created catalog content.** No identity, association, inventory, or
  offer-option definition is ever created on import; every reference must already
  exist.

## Decisions still needed (escalate if blocking)

- Whether the engine should expose a single entry point that takes a full input
  snapshot, or fine-grained resolvers per phase. (Contract detail; recommended:
  single entry point returning a snapshot plus provenance.)
- Whether derived resource multipliers should default to a placeholder (we rejected
  inventing a value) - recommend leaving them unset as `null`/`undefined`.

## References

- `docs/lore/README.md` - index, conventions, source table.
- `docs/rules/*.md` - the individual rules and their source/status.
- `docs/rules/assumptions.md` - the consolidated configurable assumption keys.
