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

1. **Identity & grade resolution** - Determine the starting grade from origin
   (newly integrated vs. born into system) and the resolved race/class/profession.
   A born participant starts at the selected race's `naturalGrade` (legacy
   fallback `F`); a newly integrated participant starts at `G`.
2. **Level resolution** - Resolve each track's level (race, class, profession).
3. **Track awards** - For each track, apply the per-level stat awards from the
   historical snapshot for the relevant grade.
4. **Race-level derivation** - Compute the displayed race level from class and
   profession levels (average, per the sourced rule and the configured
   rounding/missing-track assumptions). A **monster** race is race-only (no class or
   profession); its race level is its own race-track level in independent mode, so
   this averaging phase is skipped and the race level is taken directly from the
   race track.
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
fixed level, for a race whose natural grade is F (e.g. Human):

- level 8 -> G-grade (if newly integrated) or F-grade (if born-into-system).
- level 10 -> F-grade (auto-advance boundary, source-verified).
- level 150 -> D-grade.
- level 300 -> C-grade.

Implication: the G/F overlap (G 0-9 vs F 0-24) is resolved by **origin**, not
by a formula. The engine must record whether the participant was newly integrated
or born into the system and choose the appropriate band. That born band is NOT
universal: a born participant starts at the selected race's `naturalGrade`
(legacy fallback `F`), so a race that does not start at F resolves the overlap
differently - this example is for a Human-like race with natural grade F. This is
a data decision, not a math one.

### 4. Equipment / consumable assumption implications

The equipment (20% individual / 15% combined) and consumable (F3 / E5 / D15 / C45)
rates are **assumptions**; changing them changes roll outcomes but never changes a
sourced value. The engine must treat them as configuration, and the output
provenance must tag them as assumptions so they are never mistaken for canon.

The consumable grade rates are **per-level** rates on **permanent external stat
gains** acquired from consumables, not a cap on temporary potions. A character's
permanent consumable capacity for an attribute is the cumulative sum of the
per-level rate across every race level attained through the grade bands (including
the born-natural-grade vs integrated-G handling of the overlapping G/F bands for a
race whose natural grade is F). This capacity is
enforced at application time, and a recorded gain is never re-capped by later
config changes - historical facts are immutable. Temporary potion effects are
bounded only by their effect duration.

These rates are NOT hard-coded. They live in a single server-wide `house_rules` row
(`id = 'active'`, created by migration `0007_house_rules` - archived `0001..0023`
chain, now part of the 0.1.0 baseline) that an admin edits from the
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

### 5. Equipment flat + percentage bonus ordering (phase contract)

An equipment entry may declare two live multipliers: a flat `bonus` vector and an
optional `percentBasisPoints` vector (nonnegative integer basis points,
10000 = 100%). Both are synthesized live from the current catalog config and never
persisted. The engine applies them in a fixed order within the status trace so the
outcome is deterministic and never depends on iteration order:

1. The **flat equipment** bonus is computed and capped against the per-attribute
   individual cap and the overall combined cap, using the value immediately before
   any equipment application as the reference.
2. The **percentage equipment** bonus is computed only for attributes that declared
   a percent request: `floor((preEquipment[attr] + appliedFlat[attr]) * bp / 10000)`
   (clamped to 0 for a negative base). It never compounds onto another item's
   percent and deliberately uses the **capped** flat bonus as its base, so it is
   bounded by the same budgets as the flat bonus.
3. Percent requests share the **same** individual and combined equipment budgets as
   flats. The remaining individual budget per attribute is
   `max(0, floor(preEquipment[attr] * individualCapPercent / 100) - flatApplied[attr])`
   and the remaining overall budget is
   `max(0, floor(sum(preEquipment) * combinedCapPercent / 100) - sum(flatApplied))`.
   Across multiple items, percent requests are capped with the same deterministic
   largest-remainder tie ordering as flats.

The status trace therefore exposes the phases in this order: ... `flat`, `percent`,
`equipment`, `equipment-percent`, `temporary`. The `equipment-percent` phase is
emitted **only** for an attribute whose percent request is nonzero, so equipment
with no percent bonus (or an ineligible/archived percent) yields status output
identical to the legacy zero-percent form - no `equipment-percent` phase at all.
The combined `requested` / `applied` / `suppressed` figures in the equipment
status include both flat and percent; an `equipment-percent` cap is reported
through distinct `capUsage` names (`equipment-percent-individual` /
`equipment-percent-overall`) while the flat cap reason strings are preserved
verbatim. Ineligible or archived items contribute neither a flat nor a percent
request, so nothing is reserved from the shared budgets.

## Experience percentage (quarter cadence replaced)

The engine no longer treats the quarter index as the primary progression input for
new or modernized state. A track (class/profession) or an independent (monster)
race carries an optional authoritative `experiencePercent` (integer 0..99):

- `TrackState.experiencePercent` is the source of truth for the class/profession
  EXP percentage within the current level; `RaceState.experiencePercent` exists only
  on independent (monster) races. A derived (enlightened) race never carries its own
  percent.
- When `experiencePercent` is present, the corresponding `quarter` MUST equal
  `floor(experiencePercent / 25)` (enforced by the Zod schemas at the API boundary).
  The `quarter` field is retained as the legacy 25% turn-boundary marker and is what
  the quarter engine still advances.
- A **legacy state** that predates explicit EXP tracking simply omits
  `experiencePercent`. It is never rewritten by a read:
  `experiencePercentFor(state, track)` returns the explicit percent when present,
  otherwise `quarter * 25` (a missing race quarter defaults to 0). A legacy state is
  given an explicit percent only when it is advanced (`advanceQuarter` /
  `advanceRaceQuarter` always set `experiencePercent = quarterAfter * 25` on the
  state they mutate).

The quarter engine (`advanceQuarter` / `advanceRaceQuarter`) is reused unchanged for
the 25% turn boundaries and for level awards. The new pure gate is
`setExperiencePercent(state, track, target, definition, config)`:

- `target` is an integer 0..100. 100 requests a level-up; 0..99 sets the
  percentage within the current level.
- The `race` track requires `state.race.mode === "independent"`; a class/profession
  track must already exist.
- **Backward** (`target < current`): sets `experiencePercent = target` and
  `quarter = floor(target / 25)`, never decrements `state.turn`, never revokes
  awards, journal `turnsAdvanced: 0`.
- **No-op** (`target === current`): returns the input state unchanged (no turn
  change).
- **Forward** (`target > current`): for each crossed 25/50/75/100 boundary calls
  `advanceQuarter` / `advanceRaceQuarter` exactly once (each increments `state.turn`
  and applies its own grade gate, race-gain, evolution offer and effect-expiry
  logic). The final call at 100 levels up, or fails atomically on a grade gate. A
  target below 100 ends with `experiencePercent = target` and
  `quarter = floor(target / 25)`.

`levelUpFromExperience(state, track, definition, config)` is a thin wrapper over
`setExperiencePercent(..., 100)`: it may level from ANY percentage (including 0),
resets the percent to 0 after the level-up, and never synthesizes skill offers (the
service adds those only on an actual level-up). No percent-only effect or stat gain
is ever applied - only the level boundary grants stats, exactly as the quarter
engine already did. The displayed percentage for a derived race is a read-only
average of the available class/profession EXP percentages computed by the UI; it
does not change the configurable race-level strategy (`deriveRaceLevel`).

## Verification status of inputs

- **Verified:** grade/level bands; race-level = average of class/profession;
  evolution blocks XP until completed; free-point pools per grade for Human;
  skill rarity tiers; blessing 8-level hierarchy; Bloodline of the Primal Hunter
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
  `professionId`, `special`, `specialAbilities`, `equipment`, plus optional
  `nickname`, `pronouns`, `ageDescription`, `appearance`, `biography`, `notes`).
  Each string is bounded and the whole payload is capped at 256KiB. It never stores
  uploaded binaries and never stores stat vectors, awards or effects - those
  belong to the engine, not the draft. It does not derive any numbers.
  `specialAbilities` carries the explicit blessing selection - a single optional
  `{ godId, tier }` object under `blessing` - and the
  `bloodlineIds`/`transcendentSkillIds` arrays (`bloodlineIds` at most 1 unique
  nonempty id, `transcendentSkillIds` at most 8 unique nonempty ids - the
  transport/request bound, not the effective cap; the per-character limit is the
  admin-configurable `maxTranscendentSkills` - no id overlap) as resumable state
  only; the legacy `special` boolean stays
  readable but has no award semantics - a `special: true` draft never grants a
  power unless an explicit `specialAbilities` selection is submitted at create.
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
- **Explicit special-ability selections are part of atomic create.** `POST
/api/characters` (and the resumable draft `data`) accept an optional
  `specialAbilities` object (`blessing` as `{ godId, tier }`, `bloodlineIds`,
  `transcendentSkillIds`). When supplied, `createCharacter` resolves each id by
  its corresponding catalog kind (`gods` / `bloodlines` /
  `transcendent_skills`), requires the definition to be unarchived, enforces the
  invariants (at most one blessing; at most one bloodline; at most
  `maxTranscendentSkills` transcendent skills - the admin-configurable HouseRules
  cap, default 3; no duplicate/overlapping ids), and inserts the `BLESSING` /
  `BLOODLINE` / `TRANSCENDENT` CharacterAssociations atomically inside the SAME
  transaction as the character row, the `create` event, and the draft delete. A
  wrong-kind, archived, missing, duplicate, upgrade-group-collision or over-cap
  selection rejects the whole create with a 400 and a stale `draftVersion`
  rejects with a 409 - either way no character, event, link or draft deletion is
  committed. The `create` journal records a snapshot and `provenance` of each
  selected definition. No ability is ever auto-selected and no numeric bonus is
  fabricated: a link only synthesizes effects declared in the catalog, and the
  legacy `special` boolean never grants a power on its own.
- **Profile metadata is persisted, not just drafted.** The optional
  `nickname`, `pronouns`, `ageDescription`, `appearance`, `biography`, `notes`
  fields are stored as nullable columns on the final `Character` (each bounded
  by Zod at the API boundary, matching the draft bounds). The `create` journal
  records only _which_ of them were supplied; the `update` journal records only
  the _changed field names_ plus the acting user id, never the long prose - so a
  detailed biography/private note is not duplicated into the journal.
- **One blessing link per character, enforced at the database layer.** A
  character may hold AT MOST ONE `BLESSING` association (active or archived). A
  partial unique index backstops this at the DB level; `associateCharacter`
  runs the add under SERIALIZABLE + CAS and maps a concurrent singleton-race
  `P2002` to a 409 `blessing_singleton_conflict`. An archived blessing is inert
  but still occupies the single slot until replaced (add a new blessing) or
  removed, and an import backup carrying more than one total blessing link is
  rejected with 400 `import_link_collision` before any write.
- **At most one bloodline link per character, enforced at the database layer.**
  A character may hold AT MOST ONE `BLOODLINE` association (active or archived),
  the same singleton backstop migration 0011 built for blessings. The partial
  unique index at migration 0012 enforces it (migrations 0011/0012 are in the
  archived `0001..0023` chain, reproduced in the 0.1.0 baseline);
  `associateCharacter` runs the add
  under SERIALIZABLE + CAS and maps a concurrent singleton-race `P2002` to a 409
  `bloodline_singleton_conflict`. A bloodline add atomically replaces EVERY
  existing bloodline link (active or archived); an import backup carrying more
  than one total bloodline link is rejected with 400 `import_link_collision`.
  Migration 0012 also reconciles pre-existing duplicate bloodline links
  deterministically (unarchived before archived, newest `createdAt`, then highest
  link id) and appends a `bloodline_singleton_reconcile` progression event per
  removed link.
- **Configurable transcendent-skill cap.** A character may carry at most
  `maxTranscendentSkills` `TRANSCENDENT` associations (admin-configurable
  HouseRules field, default 3, bounded 0..8). `associateCharacter` rejects an add
  with 400 `link_limit` once the count reaches the cap (the count includes
  archived links, so an over-cap grandfathered character can still remove but not
  add); a create or import that exceeds the cap is rejected with
  `link_collision` / `import_link_collision` before any write. Removal is always
  allowed. Import enforces the CURRENT configured cap rather than a fixed bound:
  a backup `associations` array may carry up to 8 transcendent refs (the same
  transport bound as the create/draft payload, and the cap itself is bounded
  0..8), but the importer rejects any document carrying more transcendent links
  than the present cap. A backup exported under an older, larger cap (or before
  the cap was lowered) is still exportable - export never drops a link - but the
  import rejects with `import_link_collision` until the cap is raised or the
  surplus links are removed.

## Trusted-backup character export / import (contract)

A saved character can be exported as a **trusted backup** JSON document (schema
`primal-character/6`) and re-imported into any instance of the app. The document
is a backup, **not** authoritative server-verified state: the contract is. The
older `primal-character/3` through `primal-character/5` documents are still
ACCEPTED on import (so existing backups keep working) but are never generated; a
v3 backup carries no inventory and no grandfathering marker, so importing it
restores zero stock and marks every equipment link as grandfathered. The current
v6 backup carries everything v5 did - owned inventory, the `legacyUnowned`
marker, and a per-link ring `equipmentPosition` for `Ring`-slot equipment
associations so a character's two ring positions round-trip - plus the append-only
skill-offer generation and cancellation state: every exported offer records a
non-negative `generation` and a nullable `canceledAt`, so a restore preserves the
full historical offer identity and cancellation state. The v5 backup carried those
inventory / ownership / position features but no skill-offer generation or
cancellation fields; a legacy v3/v4/v5 backup omits both, and on import the
importer defaults them to `0`/`null`.

- **Stable identifiers, not internal ids.** The document carries `identity`
  (name, description, the nullable profile-metadata fields `nickname`,
  `pronouns`, `ageDescription`, `appearance`, `biography`, `notes`, origin,
  race/class/profession) and every association /
  skill-offer option reference by catalog `kind` + `stableId` (never the
  runtime-internal definition id). The raw engine `state` is exported verbatim
  (it keeps its engine-internal `definitionId` values), and on import those
  current track/race definition ids are remapped to the local catalog forms
  (via the same `resolveTrackDefinition` fallback the advancement flow uses - the
  id for the character's grade if defined, otherwise the lowest defined grade -
  for tracks, and the local per-grade `raceDefinitions[grade].id` for the race).
  Historical level awards are preserved verbatim as source snapshots. Profile
  metadata exported in `identity` is imported verbatim (nullable); an omitted or
  null field in a backup is imported as NULL, so archives made before these
  fields existed still import.
- **No catalog is auto-created and no overwrite.** Every identity / association /
  offer-option reference must resolve to an EXISTING catalog definition; a
  missing, wrong-kind, or (for required race/class/profession) archived definition
  rejects the whole import with an actionable 400. Archived associations or offer
  options may be preserved as inert links only when the definition exists. Import
  always creates a NEW character (owned by the current user) - it never mutates an
  existing row. A backup carrying more than one total `blessing` link (e.g. one
  active + one archived blessing) is rejected with 400 `import_link_collision`
  before any write - the single-blessing invariant counts archived links too.
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
  `stableId`, only `equipment` / `items`, with a `quantity` bounded
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
  rows. The `import` marker records `backupSchema` (v3, v4, v5 or v6) and
  `inventoryCount`. A v3 backup imports no stock and grandfathers every equipment
  link (preserving the old backup behavior). Distinct inventory definitions are
  capped at 500 by the inventory adjustment route (a 409), so an exported character
  is always self-roundtrippable.
- **Ring position on legacy v3/v4 imports.** A v3/v4 backup carries no per-link
  `equipmentPosition`; the importer derives it from the CURRENT catalog's legacy
  `Ring 1`/`Ring 2` slot. When the current catalog slot has been migrated to the
  generic `Ring` (so the catalog row provides no position), the importer recovers it
  from the backup's own `definition.config.slot` snapshot (a pre-migration catalog
  still named `Ring 1`/`Ring 2`), never from the advisory `liveState`/`status`. If
  neither the current row nor the snapshot yields a position (or the snapshot names
  a non-ring slot), the import fails with `400 import_ring_position_required`. A v5
  backup always carries the explicit position and never trusts the snapshot. The
  `definition.config` snapshot is preserved on import solely for this recovery and
  is never used as live catalog mechanics.
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
