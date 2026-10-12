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

- Suppose a class would grant raw bonuses summing to 40 at a grade where the cap is
  34. Each attribute's bonus is scaled by 34/40 = 0.85.
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

## Verification status of inputs

- **Verified:** grade/level bands; race-level = average of class/profession;
  evolution blocks XP until completed; free-point pools per grade for Human;
  skill rarity tiers; blessing 7-level hierarchy; Bloodline of the Primal Hunter
  per-grade gradient; class/profession per-level stat caps (partial grade set).
- **Wiki-uncertain:** exact XP curve; sub-stage boundaries for non-E grades;
  rounding and single-track handling; blessing magnitudes; most bloodline numeric
  effects; derived resource multipliers.
- **House assumptions:** as listed in `docs/rules/assumptions.md`.

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
