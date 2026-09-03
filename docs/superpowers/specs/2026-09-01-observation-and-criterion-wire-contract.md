# Observation and Criterion Wire Contract

Status: proposed
Date: 2026-09-01
Scope: the MalaClaw/MrMaLiang boundary
Companion to: [Spec 1 — Contract Enforcement Core](2026-08-31-contract-enforcement-core-design.md)

## 1. Why this exists

Spec 1 says the two repositories "meet at a file that already exists." That was
too vague to implement against, and the three implementation plans proved it:
Plan 1 and Plan 2 each specified a durable observation store, with different
directory keys, different filename schemes, and different freshness rules, while
asserting they were mirrors of one another. They were not wire-compatible.

Three further defects have the same root cause — no frozen boundary contract:

- **Scope is lost.** Criteria carry `scope` (a section, a taxonomy cell), but
  observations are keyed by metric alone, so `citation_depth_per_section` for
  section 3 and section 6 collapse into one number and a repair in one appears
  to satisfy the other.
- **Acceptance arithmetic is implemented twice**, and the two implementations
  disagree on `equals`, on tolerance, and on operator/direction validation.
- **Repair acceptance cannot be compiled statically.** A catalog action is
  generic; the gate, scope, and acceptance criterion are only known when a
  concrete finding is dispatched.

This document freezes the boundary. Every plan references it rather than
restating it.

## 2. Ownership

| Concern | Owner |
| --- | --- |
| Metric semantics, evaluators, thresholds, tolerance, direction | **MrMaLiang** |
| Producing a measurement result | **MrMaLiang** |
| Validating, sequencing, storing, and reading observations | **MalaClaw** |
| Acceptance and progress arithmetic | **MalaClaw** |
| Compiling criteria (with tolerance and direction baked in) | **MrMaLiang** |
| Materializing a concrete action instance from a capability template | **MalaClaw dispatcher, from MrMaLiang's finding** |

**MrMaLiang never writes the observation store.** Plan 1's independent durable
store is deleted; its evaluators produce envelopes and stop there. One owner
means one format, one sequence allocator, and no possibility of drift.

## 3. Measurement envelope

A measurement unit's declared output is a single JSON document. The kernel
ingests it after the unit completes.

```json
{
  "version": 1,
  "as_of_date": "2026-09-01T00:00:00.000Z",
  "measurements": [
    {
      "metric": "citation_depth_per_section",
      "scope_key": "section-03",
      "status": "measured",
      "value": 2,
      "target": 3,
      "operator": "at_least",
      "tolerance": 0,
      "direction": "maximize",
      "evaluator": "citation_depth_per_section",
      "evaluator_digest": "<64 hex>",
      "input_digest": "<64 hex>",
      "measurement_kind": "script"
    }
  ]
}
```

`status` is one of:

| status | Meaning | Kernel behavior |
| --- | --- | --- |
| `measured` | A value was produced | Validate, sequence, append |
| `unavailable` | A required input was missing, or the evaluator threw | `contract: measurement_failed` |
| `deferred` | Produced by a later-tier measurement unit | `contract: pending_verification` |

`unavailable` and `deferred` are distinct and must never be conflated: a missing
corpus is a failure, an expensive metric awaiting its own unit is not. An
`unavailable` entry carries `reason`; neither carries `value`.

**`as_of_date` is included in `input_digest` only for metrics the registry marks
`time_dependent: true`.** Folding a timestamp into every digest would invalidate
every static measurement daily and destroy reuse.

**A `measurement_kind: "model"` entry MUST carry `judgment`:**

```json
"judgment": {
  "reasons": ["comparative synthesis is thin in section 4"],
  "confidence": 0.62,
  "rubric_version": "2",
  "evidence_refs": ["reviews/scorecard.json#persona/theorist"],
  "adjudicated": false,
  "disagreement": "none"
}
```

The kernel rejects a `model` entry without `judgment`, and rejects `judgment` on
a `script` entry. This is enforced by `measurement_kind`, not by convention.

## 4. Observation identity and storage

Identity is the four-tuple:

```
(metric, scope_key, input_digest, evaluator_digest)
```

`scope_key` is a canonical string; the empty string means workspace-global. It
appears in identity, in the storage path, in lookup, and in snapshots.
A scoped metric emits **one entry per scope**, never an aggregate: the previous
`taxonomy_cell_ab_sources` design emitted the minimum across all cells, which
cannot tell a repair which cell to fix.

Storage is engine-owned and opaque to MrMaLiang. The kernel writes immutable,
content-addressed records under a manifest-declared `observation_store`, and
allocates every `sequence` atomically. No other process writes there.

**Freshness resolves in this order, and never by wall clock:**

1. `metric` and `scope_key` match.
2. `input_digest` matches the current dependency digest.
3. `evaluator_digest` matches the current evaluator implementation and config.
4. Among survivors, highest `sequence` wins.

Steps 2 and 3 are not optimizations. A workspace that changes and reverts
(A → B → A) leaves a valid A observation with a *lower* sequence than the stale
B one; selecting by sequence alone returns the stale value.

## 5. Compiled criterion

MrMaLiang compiles criteria with tolerance and direction already resolved, so
the kernel needs no metric registry and no domain knowledge:

A criterion is one of two kinds, discriminated on `kind`.

**Metric criterion** — an objective with a number behind it:

```json
{
  "kind": "metric",
  "metric": "landmark_coverage_ratio",
  "scope_key": "",
  "operator": "at_least",
  "target": 0.75,
  "tolerance": 0.000001,
  "direction": "maximize"
}
```

**Verification criterion** — an objective with no registered metric, satisfied
when a named check re-runs clean over the same inputs:

```json
{
  "kind": "verification",
  "verification_id": "figure_references",
  "scope_key": "",
  "expect_pass": true
}
```

A verification criterion carries **no digest**. It is compiled before the
repair runs, and the bytes it must be checked against do not exist yet.
Freshness is bound after the effects are applied: the kernel issues a
verification request, the domain layer answers with the `input_digest` and
`verifier_digest` it observed at that moment, and only a result bound to that
request satisfies the criterion.

Selecting a stored result resolves by `verification_id`, then `scope_key`, then
results matching the CURRENT `input_digest`, then those matching the current
`verifier_digest`, then the highest sequence. The digest steps are filters, not
tie-breakers: inputs move A → B → A, and "the latest result" would return the
stale B one while a currently valid A result sits behind it.

Not every real defect has a number. A missing figure reference, a layout fault,
a page limit and an under-length manuscript are all repairable and none is
tracked by a registered metric; roughly twenty declared routes carry
`acceptance_metric: null` for exactly this reason, several of them reachable in
a flagship run. Forcing them into a metric criterion would mean inventing a
metric, and dropping them would mean materializing an action with no acceptance
at all.

`verification_id` is **opaque to the kernel**. It identifies whatever the
domain layer will re-run; the kernel compares the recorded outcome to
`expect_pass` and knows nothing about what a paper "gate" is. `input_digest`
pins what the verification ran against, so a pass recorded before the artifacts
changed cannot satisfy it afterwards — the same freshness rule §4 gives
observations.

`kind` is **always explicit**. A discriminated union reads the discriminant
before applying any member's defaults, so a criterion omitting `kind` matches
no arm and is rejected; the compiler emits it on every criterion it produces.

`must_preserve` and `must_improve` carry metric criteria only. Preservation is
measured as a value that must not regress and improvement as a fraction of a
closed gap; neither has meaning for a check that passes or does not. A
verification that must keep passing is expressed as an acceptance criterion on
the unit that could break it.

Arithmetic — gap closure, progress, tolerance — applies to metric criteria
only. A verification criterion is satisfied or it is not; asking how much of it
closed is meaningless, and a consumer must narrow on `kind` before computing.

Compilation **rejects** an operator that fights the metric's direction:
`at_least` on a minimized defect count, or `at_most` on a maximized coverage
ratio, is a contract error caught before dispatch.

`ProgressPolicy` accompanies a criterion:

```json
{ "min_absolute_delta": 0.01, "min_gap_fraction": 0.2, "max_attempts": 2 }
```

## 6. Arithmetic — one implementation

The kernel owns it. Both thresholds apply, because a discrete metric moves in
lumps near its target while a fine-grained one can inch forever.

**Satisfaction**

- `at_least`: `value >= target - tolerance`
- `at_most`: `value <= target + tolerance`
- `equals`: `abs(value - target) <= tolerance`

Exact float equality is never used.

**Progress** — `equals` is two-sided and measured as closed *distance*.
Treating it as `at_least` reports movement in the wrong direction whenever the
value starts above the target.

```
at_least:  gap = target - before;  moved = after - before
at_most:   gap = before - target;  moved = before - after
equals:    gap = |target - before|; moved = gap - |target - after|

closed_gap_fraction = gap <= 0 ? 1 : moved / gap
```

**Outcome**

```
satisfied(after)                        -> accepted
moved < min_absolute_delta              -> unmet
closed_gap_fraction < min_gap_fraction  -> unmet
otherwise                               -> improved
```

**Protected invariants.** A `must_preserve` criterion whose observation is
**absent** is `measurement_failed`, never a pass. A protected metric that cannot
be measured has not been preserved; it is unknown.

**Objective identity** shares scope semantics with observation identity:

```
metric + scope_key + operator + target + finding_ids + artifact_ids
```

## 7. Conformance fixtures

A shared corpus both repositories execute — against **one** implementation, not
two. MrMaLiang must never reimplement the arithmetic in order to satisfy these
fixtures; the point is to prove its *outputs* are what the kernel's actual
schemas and arithmetic accept.

**Location and shipping.** The corpus lives in MalaClaw at
`fixtures/wire-contract/v1/`, is listed in the package `files`, and is reachable
as `malaclaw/fixtures/wire-contract/v1/*`. MrMaLiang already resolves the
runtime at `.dependencies/MalaClaw` and imports from `malaclaw/sdk`, so pinning
a runtime version pins the contract corpus with it — a workspace on MalaClaw
3.0 tests against 3.0's fixtures, with no vendored copy to drift.

**Two families.**

`arithmetic.json` — cases of `{ name, criterion, before, after, expect }`:

- `equals` starting above, below and at target; moving closer, moving away, and
  reaching within tolerance.
- Float-tolerance satisfaction for a ratio.
- `at_least` and `at_most` progress, and an already-satisfied criterion.
- Operator/direction rejection in both directions.

`envelope.json` — cases of `{ name, envelope, expect: "accepted" | "rejected", reason? }`:

- A scoped metric emitting one entry per scope.
- A `model` entry missing `judgment` (rejected).
- A `script` entry carrying `judgment` (rejected).
- A `measured` entry with no value, and an `unavailable` entry with no reason
  (both rejected).
- `unavailable` versus `deferred` producing different contract outcomes.
- A `must_preserve` metric with no observation producing `measurement_failed`.
- An unrecognized envelope version (rejected).

**Who runs what.**

| Repository | Executes against |
| --- | --- |
| **MalaClaw** | Its own `evaluateContract`, `satisfies`, and `ingestEnvelope` |
| **MrMaLiang** | The `Criterion` and `MeasurementEnvelope` schemas and the arithmetic **imported from the pinned runtime**, applied to the criteria its compiler emits and the envelopes its evaluators produce |

MrMaLiang's side is the one that catches real divergence: it asserts that a
criterion compiled from its metric registry — its `tolerance`, its `direction`,
its `operator` — produces the outcome the shared corpus expects when fed to the
kernel's arithmetic, and that every envelope its evaluators emit validates
against the kernel's schema.

**Versioning.** A change to this document requires a fixture change; a fixture
change requires a directory version bump and a matching
`runtime-compatibility.json` update in the same commit. The kernel rejects an
unrecognized envelope version rather than attempting migration.

## 8. Action instantiation

A capability in the tool catalog is a **template**, not a contract instance. The
gate, artifact, scope, and acceptance criterion are known only when a concrete
finding is dispatched, so acceptance cannot be baked into a generic catalog
entry at compile time.

**Template** (compiled by MrMaLiang, static):

```yaml
id: revise_sections
kind: mutation
owns: ["chapters/**", "paper/abstract.md", "reviews/revision-report.md"]
evaluate_with: [measure_manuscript_metrics]
handles:
  - { kind: chapter_prose, effect: add_supporting_citation }
  - { kind: chapter_prose, effect: remove_unsupported_claim }
must_preserve_template: [claim_support, citation_verification_status]
```

**Instance** (materialized by the dispatcher, per dispatch):

```yaml
from_template: revise_sections
findings: [figure-1-missing-reference]
scope_key: section-03
reads: [repair/<action-id>/packet.json, chapters/section-03.md, evidence/section-03.json]
owns: ["chapters/section-03.md"]
acceptance:
  - { metric: rendered_visual_review, scope_key: "", operator: equals, target: 1, tolerance: 0, direction: maximize }
must_preserve:
  - { metric: claim_support, scope_key: "", operator: at_least, target: 0.9, tolerance: 0.000001, direction: maximize }
strategy_key: [template, finding_ids, scope_key, acceptance]
```

The instance narrows `owns` to the artifacts its findings actually name. A
template's envelope is the maximum a capability may ever touch; an instance's is
the minimum this dispatch needs.

Every `must_preserve` metric in a template must be registered. A gate id is not
a metric id: `citation_verification` is a gate, and its corresponding metric
must be registered under its own name.

## 9. What this changes in the plans

| Plan | Change |
| --- | --- |
| **1** | Delete the durable observation store, `reserveSequence`, and the store-path helpers. Evaluators return envelope entries. Add `scope_key` to every evaluator's output and emit one entry per scope. Add `time_dependent` to the metric registry and include `as_of_date` in the digest only when set. Keep the digest helpers — the kernel calls them through the envelope. |
| **2** | Own the store, sequencing, ingestion, and all arithmetic per §6. Delete the second acceptance implementation. Add `scope_key` throughout. Add `writes` to the work-unit schema. Require `ir_version: 2` explicitly rather than defaulting. |
| **3** | Compile capability templates, not contracts. Materialize instances at dispatch per §8. Register a metric for every `must_preserve` entry. |

## 10. Versioning

`version: 1` on the envelope. A breaking change bumps it, updates the fixtures,
and updates `runtime-compatibility.json` in the same commit. During the POC the
kernel rejects an unrecognized version rather than attempting migration.
