# Contract Enforcement Core — Spec 1

Status: frozen pending implementation plan
Date: 2026-08-31 (amended 2026-09-01)
Scope: MalaClaw (execution kernel) + MrMaLiang (scholarly application)
Follow-on: [Spec 2 — Scholarly Synthesis and Artifact Quality](2026-09-01-scholarly-synthesis-quality-design.md),
[Spec 3 — Cross-Topic Reliability and Release Qualification](2026-09-01-cross-topic-reliability-design.md)

## 1. Problem

Flagship runs fail in a repeating shape:

1. A gate fails.
2. A finding is represented too broadly to identify its owner.
3. The router selects a stage that cannot modify the responsible artifact.
4. The stage executes successfully.
5. The gate remains failed.
6. The next round repeats the same strategy.

This is not a model-capability problem. A stronger model cannot recover
ownership information, acceptance measurements, or evidence that the pipeline
discarded upstream.

MrMaLiang already *represents* contracts — `AgenticActionPlan`, 22
`ACCEPTANCE_METRICS`, a gate/tool routing table, six durable phases,
stagnation posture, before/after baselines. It does not *execute* them as
contracts. This spec closes that gap without adding a parallel architecture.

## 2. The unifying finding

Deterministic gates already compute every value the system later tries to
reconstruct, then flatten it into prose and discard it.

`packages/longwrite/src/lib/validation/research.ts:28`

```ts
export type ValidationCheck = { id: string; pass: boolean; findings: string[] };
```

`packages/longwrite/src/lib/validation/figures.ts:248` holds `item.id` and the
owning file path, and emits:

```
`figure_references: ${item.id} is not labeled in ${rel}`
```

`packages/longwrite/src/lib/research/corpus-gates.ts:78` holds
`coreSourceCount` and `gates.min_core_sources`, and emits:

```
detail: `${coreSourceCount} A/B-depth core sources; required ${gates.min_core_sources}`
```

Two kinds of loss, from the same line of code:

- **Routing data** — the artifact, its kind, and the required effect are known
  at the gate and destroyed. An LLM is later asked to reconstruct them from the
  string, and the reconstruction is untrusted.
- **Observations** — the numeric value and its target are known at the gate and
  destroyed. Acceptance criteria naming that metric therefore cannot be
  evaluated.

Measured against `reports/metrics.json`, only **3 of 22** acceptance metrics
have any observation today, and one of those is under a different name
(`claim_support` vs the written key `claim_support_rate`). The acceptance
vocabulary and the observation vocabulary are unrelated namespaces.

Everything else in this spec follows from fixing that at the source.

## 3. Non-goals

- MalaClaw learning any scholarly concept. It sees named numeric observations,
  declared file effects, and typed outcomes. It never learns what a citation,
  landmark, chapter, or figure is.
- Backward compatibility with existing POC manifests. IR v2 is a breaking
  revision; old workspaces are preserved as fixtures, not resumed.
- Transactional rollback. A regressed repair keeps its writes; the workspace is
  marked and blocked. (Decided; see B7.)
- Retrieval quality and prompt tuning. Out of scope.
- Concrete provider and model names, pricing, and availability. These are
  runtime-profile configuration (`configs/runtime-profiles/*.yaml`), not spec
  content. **Logical tier assignment is in scope** (§A9); the mapping from a
  logical tier to a named model is not.

## 4. Architecture

Three layers, with the boundary stated as a rule rather than a convention:

| Layer | Owns | Never owns |
| --- | --- | --- |
| **LLM workers** | Literature judgment, synthesis, drafting, review, repair *content* | Routing, acceptance, its own grade |
| **MrMaLiang** | Metric evaluators, finding normalization, routing registries, repair packets, target propagation, workflow compilation | Execution, retries, state |
| **MalaClaw** | Effects, acceptance, invariants, outcomes, stagnation, escalation, checkpoints | Any domain semantics |

Two registries are the source of truth, and prompts are **rendered from** them
rather than restating them:

- **Metric registry** — identity, direction, evaluator, cost tier,
  dependencies, invalidation, provenance.
- **Finding registry** — gate, artifact kind, required effect, compatible
  capability, default acceptance metric.

This replaces `packages/longwrite/src/workflow/composition.ts:936`, a
~1,800-character instruction string that restates routing policy already
encoded in `repair-routing.ts`, and which `tests/action-plan-metric-sync.test.ts`
exists solely to keep in sync.

## 5. Part A — MrMaLiang

### A1. Structured observations replace prose details

`ValidationCheck` becomes:

```ts
export type Observation = {
  metric: MetricId;            // branded; never a GateId
  value: number;
  target?: number;
  operator?: "at_least" | "at_most" | "equals";
  evaluator: string;           // implementation identity
  evaluator_digest: string;    // implementation + configuration version
  input_digest: string;        // reads set + registry config + prompt/model config
  sequence: number;            // monotonic engine sequence; resolves freshness
  measured_at: string;         // provenance only — never used for ordering (§B11)
};

export type ValidationCheck = {
  id: string;
  pass: boolean;
  observations: Observation[];
  findings: Finding[];         // was string[]
  diagnostic?: string;         // human prose, never parsed
};
```

Prose survives as `diagnostic`. It is for operators, never for routing.

### A2. Metric registry

Every acceptance metric gets exactly one **declared measurement pipeline**
with a **deterministic reducer** — not necessarily a deterministic evaluator;
see `measurement_kind` below — plus the
metadata MalaClaw needs to schedule and reuse measurements:

```yaml
metric: rendered_visual_review
direction: maximize
target_type: boolean
measurement_tier: release
evaluator: rendered_visual_review
requires: [build/manuscript.pdf]
invalidated_by: [chapters/**, figures/**, paper/**]
estimated_cost: { model_calls: 1, render_required: true }
```

`measurement_tier` is `unit` (cheap, after every action), `round` (once per
improvement round), or `release` (expensive; multimodal or independent review).

The registry also covers boolean gate observations (`citation_verification`,
`latex_build`), which become observations valued 0 or 1. It canonicalizes
**metric names**: `claim_support` is the registry name and the written key
`claim_support_rate` is retired.

It does **not** merge the gate and metric namespaces. `GateId`, `MetricId`,
`CapabilityId`, `ArtifactKind`, and `RequiredEffect` stay separate branded
types with explicit declared mappings between them. The live
`rendered_visual_review` collision (§A3b) happened precisely because a
metric-shaped string was accepted where a `GateId` was expected; one flat
namespace would make that class of error unrepresentable in the type system
only by accident, whereas separate types make it a compile error.

**Not every measurement is deterministic, and the registry must say so.**
`rendered_visual_review`, `review_score`, and `claim_support` all require model
judgment. Each metric declares a measurement pipeline:

```yaml
metric: review_score
measurement_kind: model          # script | model | external
producer: persona_review         # what acquires the raw judgment
validator: scorecard_schema      # what the raw judgment must satisfy
reducer: deterministic_review_score   # how it becomes one number
```

An observation is trusted because its **acquisition, schema validation, and
deterministic reduction are recorded** — not because the whole measurement was
deterministic. A `model` measurement whose producer output fails its validator
yields no observation at all, rather than an unvalidated number.

**Model measurements carry uncertainty.** A `measurement_kind: model`
observation additionally records structured reasons, the evaluator's confidence,
the rubric version, evidence references, and whether a second evaluator
disagreed. Multiple graders are used only for `release`-tier metrics, where the
cost is justified. The disagreement policy is fixed:

| Condition | Resolution |
| --- | --- |
| Agreement within the rubric's tolerance | Deterministic reducer |
| Material disagreement | Independent `high`-tier adjudicator |
| Schema-invalid judgment | No observation; `contract: measurement_failed` |
| Persistent ambiguity after adjudication | `operator_required` |

No worker ever receives a single model score as unquestionable ground truth.

**Inventory.** Current state of the 22 `ACCEPTANCE_METRICS`:

| Metric | Tier | Observation exists today |
| --- | --- | --- |
| `cited_sources` | unit | no — logic private inside `evidenceCapacity` |
| `cited_within_one_year_ratio` | unit | no |
| `accepted_cited_ratio` | unit | no — `isAcceptedSource` private in `action-plan.ts` |
| `cited_arxiv_only_ratio` | unit | no |
| `citations_per_page` | round | no — needs page count from a build |
| `citation_depth_per_section` | unit | no |
| `taxonomy_cell_ab_sources` | unit | no — computed in `corpus-gates.ts`, discarded to `detail` |
| `core_sources` | unit | no — `coreSourceCount` discarded to `detail` |
| `comparative_tables` | unit | no |
| `verified_metadata_plots` | unit | no |
| `figures` | unit | no |
| `tables` | unit | no |
| `rendered_visual_review` | **release** | no — only `visual_reviewable_pages` |
| `empirical_trials` | unit | no |
| `outline_readiness` | unit | **yes** |
| `review_score` | **release** | **yes** |
| `claim_support` | **release** | **yes**, as `claim_support_rate` (name mismatch) |
| `landmark_coverage_ratio` | unit | no |
| `landmark_citation_coverage_ratio` | unit | no |
| `claim_contradictions` | round | no |
| `prose_redundancy` | unit | no |
| `diagram_connectivity` | unit | no |

Three of 22 measurable; three expensive. The three expensive ones are why
measurement scheduling (§B4) is part of IR v2 rather than a later refinement:
`must_preserve: claim_support` on every action would mean an LLM double-review
after every repair.

**Observation store.** `reports/metrics.json` is today a shared mutable object
that at least five units read-modify-write with no per-key provenance, so a
later writer silently overwrites an earlier one. It is replaced by an
append-only observation log with `evaluator` and `input_digest` per record, and
a derived current-values view. MalaClaw reads the view; it does not know the
format's meaning.

### A3. Structured findings and the finding registry

```ts
export type Finding = {
  id: string;
  gate_id: string;
  artifact: { kind: ArtifactKind; path: string; artifact_id?: string };
  location?: string;
  required_effect: RequiredEffect;
  severity: "minor" | "major" | "critical";
  diagnostic: string;
};
```

`ArtifactKind` and `RequiredEffect` are closed enums owned by the finding
registry. Routing resolves the triple:

```
(gate_id, artifact.kind, required_effect) -> capability
```

This is what `gate_id` alone cannot do. One gate legitimately emits findings
with different owners:

| Gate | Artifact kind | Required effect | Capability |
| --- | --- | --- | --- |
| `rendered_visual_review` | `chapter_prose` | `add_explicit_artifact_reference` | `revise_sections` |
| `rendered_visual_review` | `figure_spec` | `repair_figure_content` | `revise_visual_plan` |
| `rendered_visual_review` | `latex_layout` | `repair_page_layout` | `revise_visual_plan` |
| `review_target` | `outline` | `replace_organizing_claim` | `reopen_outline` |

**Trust rule.** A deterministic gate supplies the triple directly and it is
trusted. Only genuinely subjective review findings are LLM-authored; those are
normalized and then validated against the registry — artifact path must exist,
kind must match the path's registered kind, effect must be legal for the gate.
An invalid triple is a failure, never a fallback.

### A3a. The two enums

`ArtifactKind` — what kind of thing a finding is about. The path alone is not
enough: `paper/sections/03.tex` is generated from `chapters/section-03.md`, and
only one of them is editable by a repair.

| Kind | Canonical paths | Editable by |
| --- | --- | --- |
| `chapter_prose` | `chapters/*.md` | `revise_sections` |
| `abstract` | `paper/abstract.md` | `revise_sections` |
| `outline` | `outline.md`, `outline.json` | `reopen_outline` |
| `figure_spec` | `figures/placement-plan.json` entries | `revise_visual_plan` |
| `table_spec` | `figures/placement-plan.json` entries | `revise_visual_plan` |
| `latex_layout` | `paper/main.tex`, `paper/sections/*.tex` | build, via `figure_spec` |
| `bibliography` | `sources/bibliography.bib` | deterministic script |
| `source_record` | `sources/classified_sources.jsonl` | `targeted_research_expansion` |
| `evidence_packet` | `evidence/*.json` | `targeted_research_expansion` |
| `corpus` | the source set as a whole | `targeted_research_expansion` |
| `experiment_manifest` | `experiments/results.json` | none — `operator_required` |

Generated artifacts are never directly editable: a finding against one
resolves to the artifact that *produces* it. But `latex_layout` has **several**
producers, so a single "generated TeX → figure_spec" rule is wrong. The
registry declares a producer map, and the finding's `required_effect` selects
among them:

| `latex_layout` defect | Producing surface | Capability |
| --- | --- | --- |
| Missing/incorrect prose around a float | `chapter_prose` | `revise_sections` |
| Wrong embed, label, or placement | `figure_spec` / `table_spec` | `revise_visual_plan` |
| Unresolved or malformed citation | `bibliography` | `repair_bibliography` |
| Section order, front matter, page limits | publication template | `operator_required` |
| Compiler or package failure | build toolchain | `environment` gate → operator |

This is why the `figure_references` findings at `figures.ts:248` are correctly
repaired by `revise_visual_plan` while a prose-reference finding on the same
gate is not.

`RequiredEffect` — what must change. Deliberately small; a new value is a
registry change with a test, not a prompt edit.

| Effect | Meaning |
| --- | --- |
| `add_explicit_artifact_reference` | Name a figure/table in the prose that precedes it |
| `add_supporting_citation` | Weave an existing packet-backed source into a claim |
| `remove_unsupported_claim` | Delete or narrow a claim no evidence supports |
| `repair_citation_marker` | Fix or replace a marker that does not resolve |
| `replace_organizing_claim` | Change the argument a section is built on |
| `resolve_contradiction` | Reconcile two chapters that affirm and deny |
| `remove_redundant_prose` | Delete repeated phrasing or n-grams |
| `repair_artifact_content` | Fix a figure or table's own content |
| `repair_artifact_placement` | Fix where or how an artifact is placed |
| `acquire_additional_evidence` | Retrieve sources the corpus lacks |
| `upgrade_source_quality` | Replace a source with an accepted-venue equivalent |
| `repair_source_metadata` | Fix identity, venue, or a dead URL |
| `repair_bibliography_consistency` | Reconcile the bib file with cited markers |

### A3b. Routing coverage

Writing the table out in full changed the picture, and an incomplete first
pass produced wrong numbers — a warning that this inventory must be **generated
and CI-enforced, not maintained as prose**. Across all nine gate producers
(`validation/{research,figures,latex,longform}.ts`, `research/corpus-gates.ts`,
`research/survey-contract.ts`, `ops/visual-review.ts`, `publication.ts`,
`commands/preflight.ts`):

- **71** distinct gate ids are emitted.
- **27** have an explicit route in `repair-routing.ts`.
- **45** fall through to `DEFAULT_ROUTE = revise_sections`.

Only `full_corpus_gates` is routed without a producer. `rendered_visual_review`
*is* emitted, at `ops/visual-review.ts:68` and `:73`.

**Gate classes.** The 45 are not one problem. Gates divide into three classes,
and only one is repairable:

| Class | Count unrouted | Meaning | Resolution |
| --- | --- | --- | --- |
| `manuscript` | 34 | A defect in the artifact under construction | Routes to a capability |
| `environment` | 11 | A precondition of the run, not a defect in it | `operator_required`; never routed to a repair |
| `measurement` | — | A thing to re-run, not to repair | Re-measure; never routed |

All eleven `environment` gates come from `commands/preflight.ts` —
`worker_runtime`, `pdf_compiler`, `token_guardrail`, `draft_concurrency`,
`public_release_urls`, `article_front_matter`, `direct_llm_drafting`,
`review_topology`, `rendered_visual_review_tools`,
`rendered_visual_review_topology`, `publication_figure_renderer`. Routing them
to a repair capability is a category error; today they route to
`revise_sections` by default, meaning a missing LaTeX compiler is nominally
repaired by editing prose.

Of the 34 unrouted `manuscript` gates, four are retrieval gates —
`core_sources`, `freshness`, `total_candidates`, `source_type_diversity` —
routed to a prose editor that cannot acquire a single source. Eight more come
from `survey-contract.ts` (`multi_axis_taxonomy`, `related_work_matrix`,
`method_family_chapters`, `section_evidence_requirements`, …) and are
structural defects needing `reopen_outline`, not prose revision. That is the
"stage cannot modify the responsible artifact" failure sitting in the code
today, with no model involved.

**CI enforcement.** `tests/routing-coverage.test.ts` regenerates this inventory
from the producers and fails when any emitted `GateId` lacks a class, or when
any `manuscript`-class gate lacks a route. Prose bookkeeping is what made the
first pass wrong; the test is the fix.

Completing the table also surfaces work the current capability set cannot do:

| Gate | Needs |
| --- | --- |
| `bibliography_consistent` | `repair_bibliography` + effect `repair_bibliography_consistency` |
| `citation_url_liveness` | `repair_source_metadata` on `source_record` — no capability owns this |
| `empirical_experiment` | Out of LongWrite's reach → `operator_required` |
| `full_claim_double_review` | Class `measurement` — re-run, do not route |
| `review_no_regressions` | Deleted; subsumed by `must_preserve` (§B3) |

So Spec 1 adds two capabilities (`repair_source_metadata`, `repair_bibliography`),
introduces gate classes, reclassifies the preflight family as `environment`,
and deletes one gate.

### A4. Fail-closed routing

`DEFAULT_ROUTE` in `repair-routing.ts:44` is removed, and with it the silent
mis-routing of the 34 `manuscript`-class gates counted in §A3b. An unresolved triple escalates to
the diagnosis unit (§A8). A gate added later cannot silently land on
`revise_sections`; an unrouted gate is a failing test, not a fallback.

### A5. Target reservation and selector accounting

Status and reservation are separate mechanisms. Status observes; reservation
prevents. The current run needed both: eleven landmarks were retrieved, stayed
at C/D depth, and never reached full-text extraction — a *selector* defect no
repair packet can reach.

**Status** (durable, per target):
`retrieval_pending`, `retrieved`, `identity_verified`, `fulltext_ingested`,
`fulltext_unavailable`, `evidence_validated`, `evidence_insufficient`,
`allocated`, `cited`.

**Reservation** (invariant on every target-aware selector):

```
reserved targets in == selected reserved targets + explicitly excluded reserved targets
```

An exclusion carries a typed reason: `identity_conflict`, `source_unavailable`,
`fulltext_unavailable`, `insufficient_claim_bearing_evidence`,
`duplicate_canonical_target`, `outside_revised_scope`, `policy_rejection`,
`capacity_infeasible`. A target may never vanish because generic ranking filled
the queue. Violating the accounting identity fails the selector.

Applies to: semantic screening, full-text selection, evidence extraction,
section allocation.

### A6. Per-finding repair packets

Action `inputs` are fixed at compile time in `composition.ts`, so every
`revise_sections` invocation receives the same file list regardless of what it
is repairing. Generalize the existing `writeCitationRepairPacket` into a packet
built per action:

- the findings assigned to this action, with validated triples
- the owning artifacts and the exact fragments at issue
- evidence packets for the claims in question
- currently-passing gates this action must preserve
- the acceptance test, stated numerically
- prior strategies attempted against these objectives, and their outcomes

This is deterministic context selection. Semantic retrieval is used for one
job only: locating where else in the manuscript a claim is discussed
(contradiction and redundancy).

### A7. Registry-rendered prompts

Planner instructions are generated from the two registries. Deleting
`composition.ts:936` as hand-maintained policy also retires
`tests/action-plan-metric-sync.test.ts`, whose existence is the evidence that
policy currently lives in two places.

### A8. The diagnosis unit

Referenced by `unmet: diagnose` and by fail-closed routing, and specified here
rather than left implicit.

- **Reads:** the unresolved finding, every strategy already attempted against
  its objective with outcomes, the observation history for the objective's
  metric, the reachability report, and the repair packet the failed action
  received.
- **Writes:** `reviews/diagnosis.json` — one of `retry_with_different_effect`
  (naming a different `RequiredEffect`), `escalate_capability` (naming a
  different capability), `insufficient_evidence` (routes to acquisition),
  `target_infeasible` (triggers reachability confirmation), or
  `operator_required` with the exact question.
- **May not:** modify any manuscript artifact, lower a target, or select the
  strategy that already failed. Its output is a *decision*, validated against
  the same registries.

It is the only unit that sees the full attempt history for an objective. This
is deliberate: it is the one place where "what have we already tried" is the
input, and it is why repeated-strategy rejection can be strict elsewhere.

### A9. Model tier assignment

Typed outcomes are what make selective escalation mechanical rather than
guessed. MalaClaw already supports `model_tiers`, `runtime_policy`, per-unit
`model` and `model_reasoning_effort`; this fixes the policy.

Tiers are **logical task classes**. A profile maps each class to a concrete
runtime; the class assignment is spec, the mapping is configuration.

| Class | Units |
| --- | --- |
| **high** | Landmark and scope planning; synthesis and outline; manuscript-wide review; **the diagnosis unit (A8)**; final coherence edit (once, near release) |
| **quality_drafting** | Initial section drafting; synthesis-heavy revision |
| **medium** | Metadata screening; bounded evidence extraction; citation weaving; local mechanical repairs |
| **script** | Every schema, provenance, locator, count, threshold, ownership, build, and gate evaluation |

`quality_drafting` exists because forcing all initial drafting onto the lighter
tier is the likeliest explanation for the short paper's weak prose, and because
the right answer differs by profile: flagship maps it to **high**, economy maps
it to **medium**. Collapsing it into `medium` bakes an economy decision into
the spec.

**Escalation rule.** A `medium` repair returning `contract: unmet` is not
retried with the same prompt. The objective escalates to the diagnosis unit at
`high`, which must return a different effect, a different capability, or an
operator question. This is enforceable only because `unmet` is now a measured
outcome rather than a model's self-assessment.

Cost impact is bounded: the diagnosis unit runs only after a measured `unmet`,
so a healthy round adds no `high` calls, and the final coherence edit runs once
near release rather than after every repair.

## 6. Part B — MalaClaw Contract IR v2

Domain-neutral throughout. Every example below could as easily be a code-repair
or data-pipeline workflow.

### B1. Execution roles

Units declare a role. This replaces any path-specific rule about a metrics
file — other domains use other observation stores, and legitimate measurement
units must be able to write observations.

```yaml
kind: mutation
writes: [chapters/**]
evaluate_with: [measure_release_metrics]   # measurement unit(s) that grade this one
```

```yaml
kind: measurement
reads: [chapters/**, build/**]
writes_observations: [review_score, citation_density]
```

Rules, enforced by the kernel:

- A mutation unit cannot write observations used to grade itself.
- A measurement unit cannot modify the artifacts it measures.
- Every observation records which evaluator produced it.
- Acceptance consumes only observations from measurement units.

### B2. Effects

Four declarations, with distinct and non-overlapping meanings. Leaving these
implicit is how implementations come to disagree about whether an
owned-but-unchanged file, or a changed-but-unlisted output, is legal.

| Field | Meaning | Violation |
| --- | --- | --- |
| `reads` | Declared context and dependency set. Contributes to `input_digest`. | Undeclared read → `contract: undeclared_read` for any unit participating in acceptance |
| `outputs` | Artifacts required to **exist and validate** after the unit | Missing or schema-invalid → `execution: failed` |
| `writes` | Exact paths **expected to change** | Unchanged without `allow_unchanged` → `execution: failed` |
| `owns` | The **allowed mutation envelope** (glob). A superset of `writes`. | Change outside it → `contract: undeclared_write` |
| — | Engine-owned paths (`.malaclaw/**`) | Exempt; never attributed to a unit |

An owned-but-unchanged path is legal — `owns` is permission, not obligation. A
changed path outside `owns` is `undeclared_write`, which fails the action,
preserves the files, and reports a diff.

**Reads fail closed for units that participate in acceptance.** `input_digest`
is derived from the declared `reads` set, so an undeclared read is a hidden
input that can change without invalidating a measurement — silently making a
reused observation wrong. For `mutation` and `measurement` units, the kernel
therefore either fails an undeclared read, or (preferred) gives the worker
**no ambient filesystem access at all**: it receives an engine-constructed task
packet (§A6) and can reach nothing else. Units outside the acceptance path keep
the warning-only behavior.

This makes enforceable what is today prompt text at `composition.ts:939`
("Output ownership is strict: revise_sections may change only chapters/*.md…").

### B3. Acceptance, improvement, preservation

```yaml
acceptance:
  all:
    - metric: landmark_coverage_ratio
      operator: at_least
      target: 0.75

must_improve:
  - metric: landmark_coverage_ratio
    progress:
      min_absolute_delta: 0.01
      min_gap_fraction: 0.20
      max_attempts: 2

must_preserve:
  - { metric: citation_verification, operator: equals, value: 1 }
  - { metric: claim_support, operator: at_least, value: 0.9 }
```

**Progress is gap-relative, normalized by operator.** For `at_least`:

```
remaining_gap  = target - before
closed_fraction = (after - before) / remaining_gap
```

For `at_most`, invert. For `equals`, use distance or binary satisfaction.

Both thresholds are supported because discrete metrics behave badly near the
target: with 12 landmarks, one additional landmark moves coverage by ~0.083, so
a fraction test alone is unstable while an absolute test alone permits a
25-round crawl. `max_attempts` is per objective, independent of the round cap.

### B4. Measurement scheduling and invalidation

The kernel measures only what the unit's writes invalidated, and reuses a prior
observation when no dependency changed — compared by `input_digest`, not by
timestamp.

A metric whose tier defers past this unit yields outcome `pending_verification`
rather than `accepted`. The enclosing round performs the deferred measurement
once and accepts or rejects the batch.

The observation store's location is **declared in the manifest**. Today
`src/lib/workflow/stop-condition.ts:41` hardcodes `reports/metrics.json`, which
is a domain assumption living in the kernel; IR v2 removes it.

### B5. Typed outcomes

`succeeded because declared outputs changed` is removed, and outcomes split
onto **two independent axes**. Not every unit is a repair with a quality
objective: recall, builds, packaging, and measurement units still need an
execution result, and a unit may execute perfectly while its contract is unmet.
That distinction is the central lesson of the failed flagship, and collapsing
it into one enum reintroduces the confusion this spec exists to remove.

```yaml
execution: completed | failed | timeout | quota_exhausted | cancelled
contract:  not_applicable | accepted | improved | pending_verification
         | unmet | stalled | regressed | partially_improved_with_regression
         | strategy_exhausted | unreachable | operator_required
         | repeated_strategy | undeclared_write | undeclared_read
         | measurement_failed | requires_reconciliation
```

`contract: not_applicable` is the normal result for a unit with no quality
objective. Quota and provider interruptions are **execution** outcomes: they
resume from checkpoint and never count as a failed repair strategy.

| Contract outcome | Meaning |
| --- | --- |
| `accepted` | Acceptance met and all invariants preserved |
| `improved` | Progress thresholds met, target not yet reached |
| `pending_verification` | Deferred expensive measurement outstanding |
| `unmet` | No adequate progress toward the objective |
| `partially_improved_with_regression` | Objective advanced, a protected metric fell |
| `regressed` | A protected metric fell |
| `stalled` | Current strategy produced no useful delta |
| `strategy_exhausted` | Allowed strategies or attempts are used up |
| `unreachable` | Reachability analysis proves the target unattainable with available capacity |
| `operator_required` | A policy or scope decision is needed |
| `undeclared_write` | Mutation outside the `owns` envelope |
| `repeated_strategy` | Fingerprint already attempted against an unchanged objective |
| `undeclared_read` | Acceptance-path unit read outside its declared `reads` |
| `measurement_failed` | A required measurement produced no valid observation |
| `requires_reconciliation` | Effects from an interrupted attempt cannot be proven either way |

`strategy_exhausted` and `unreachable` are distinct. Round exhaustion is not
proof of infeasibility, and conflating them turns a fixable run into a false
dead end.

### B6. Strategy fingerprints and per-objective stagnation

```yaml
strategy:
  key: [action, target_ids, acceptance]
```

**Objective identity includes scope.** An objective is *not* identified by its
metric alone. Keying on `citation_depth_per_section` would let an improvement in
section 3 reset the stagnation counter for section 6 — a slow crawl wearing the
appearance of progress. The objective key is:

```
metric + operator + target + scope + finding_ids + artifact_ids
```

and the strategy fingerprint is that key plus the selected capability and
required effect.

The kernel records a fingerprint per attempt and rejects an identical
fingerprint against an unchanged objective. Stagnation is tracked **per
objective**, not aggregated:

```json
{
  "landmark_coverage": {
    "before": 0.083,
    "after": 0.083,
    "consecutive_unmet": 3,
    "strategies_attempted": ["targeted_research_expansion:landmarks-a"]
  }
}
```

Today `stall.ts:50` reads only `reviewScore`, and the aggregate
`repair_stalled_rounds` resets when any goal passes — which is how prose
redundancy passing masked both landmark gates sitting at 1/12 for three rounds.

### B7. Outcome transitions

```yaml
on_contract_outcome:
  not_applicable: continue
  accepted: continue
  improved: retry                    # bounded by progress.max_attempts
  pending_verification: defer_to_round
  unmet: diagnose
  stalled: change_strategy
  strategy_exhausted: pause
  regressed: block
  partially_improved_with_regression: block
  unreachable: pause
  repeated_strategy: reject
  undeclared_write: block
  undeclared_read: block
  measurement_failed: retry_measurement_then_block
  requires_reconciliation: block

on_execution_outcome:
  completed: evaluate_contract
  failed: retry_unit               # bounded by retry.max_attempts, then pause
  timeout: reconcile_then_retry    # lease expiry, not elapsed time (§B15)
  quota_exhausted: pause_and_resume_from_checkpoint
  cancelled: pause
```

`pause` halts the run pending an operator decision; `block` additionally marks
the workspace, so no downstream unit may run until the block is cleared through
`repair-block` (§B10). Every outcome in both enums has exactly one policy —
an outcome without one is a compile error, not a runtime default.

**Regressed state blocks the workspace.** Writes are preserved, but the
workspace is marked as containing an unresolved regressed repair, with its
before/after snapshot and changed-file list. Downstream work does not proceed
until a corrective action or an explicit operator decision clears it.

### B8. Removed in IR v2

- Success inferred from changed declared outputs.
- Default repair routing.
- Global single-metric stagnation as the only progress signal.
- Advisory-only progress assessment.
- The hardcoded `reports/metrics.json` observation path.

### B9. Reachability

`unreachable` is only claimable from analysis, never from round exhaustion.
MrMaLiang supplies the analysis (`research/gate-reachability.ts` already
computes it and deliberately never fails); IR v2 consumes it.

The kernel evaluates reachability **before dispatching a repair round**, not
after exhausting it, so no round is spent on an unattainable objective. An
objective that becomes unreachable mid-run pauses immediately with the capacity
shortfall named.

### B10. Blocked-workspace protocol

`regressed`, `partially_improved_with_regression`, `undeclared_write`,
`undeclared_read`, `requires_reconciliation`, and `operator_required` all block.
`measurement_failed` blocks only after its bounded measurement retry is
exhausted. Blocking is durable state, not a log line:

- `.malaclaw/flow/state.json` records the blocking outcome, the objective, the
  before/after observations, and the changed-file list.
- The dashboard surfaces the block as the flow's headline status with the diff.
- `malaclaw flow continue` and `flow run` refuse while a block stands, naming it.
- A block is cleared only through `malaclaw flow repair-block <block-id>
  --action <capability>`, which dispatches **only** the designated corrective
  subflow. Ordinary execution stays prohibited for the duration, so the
  corrective action cannot be used as a way to resume the blocked round.
- Alternatively, an operator decision recorded as an approval artifact clears
  it, or the protected observation is restored.

Without this, "fail the action, keep the writes" degrades into the advisory
telemetry it replaces.

### B11. Concurrent observations

The observation store is **engine-owned**, not a workspace file that units
append to. Records are immutable and content-addressed, written to a temporary
path and atomically renamed:

```
.malaclaw/observations/<metric>/<input-digest>/<evaluator>/<sequence>.json
```

The engine derives the current-values view; no unit writes it. Freshness
resolves through, in order: matching dependency digest → matching evaluator
implementation and configuration digest → monotonic engine sequence → recorded
measurement provenance. **Never by wall-clock timestamp** — under `foreach`,
clock order and causal order diverge, and a slow evaluator can otherwise
overwrite a newer result.

`input_digest` covers the declared `reads` set, the evaluator's implementation
version, the registry configuration, and — for `measurement_kind: model` — the
prompt and model configuration. A prompt or model change therefore invalidates
prior observations, which is required: the same manuscript re-reviewed by a
different model is a different measurement.

### B12. Cost accounting

`estimated_cost` is consumed, not decorative. The kernel accumulates projected
measurement cost per round and applies the existing `run_limits` /
`budget_usd` pause. A round whose deferred `release`-tier measurements would
exceed the remaining budget pauses before dispatching, rather than after
spending.

### B13. Attempt lifecycle and idempotency

Checkpointing state is not enough: a process can crash after writing an
artifact but before recording completion, and the resumed run would redo work
whose side effects already landed — duplicate provider calls, duplicate
citations, repeated paid image generation, a release packaged twice.

Every attempt moves through an explicit lifecycle, journaled before the fact:

```
prepared -> dispatched -> applied -> measured -> committed
                 |            |
                 +-> interrupted / failed / cancelled
                 +-> uncertain -> reconciled -> (applied | prepared)
```

`applied` names one state in both the lifecycle and `effect_status`; the two
must not drift into `effects_applied` versus `applied`.

```yaml
invocation_id: 01J...            # unique per attempt
idempotency_key: hash(unit + objective + strategy + input_digest)
attempt_state:  prepared | dispatched | applied | measured | committed
              | interrupted | failed | cancelled | uncertain | reconciled
```

`interrupted`, `failed`, and `cancelled` are reached from `dispatched` and map
to the execution outcomes in §B5. `uncertain` is reached when an attempt ends
with effects that can be neither confirmed nor excluded; it advances only
through explicit reconciliation.

The kernel records **intended** effects before execution and reconciles them
after restart. The guarantee is **at-least-once execution with idempotent
effects** — not exactly-once, which is not achievable across an external
provider boundary and should not be claimed.

Recovery from an uncertain crash is conservative, following the same principle
as §A5's exclusion reasons: an attempt found in `dispatched` with unreconciled
effects is marked `uncertain` and requires reconciliation, never automatic
replay of a possibly-completed external side effect.

### B14. Checkpoint and resume contract

A checkpoint is a named, durable record with defined contents:

| Field | Contents |
| --- | --- |
| `unit_key`, `invocation_id` | What this checkpoint belongs to |
| `input_digest` | Invalidates the checkpoint when declared inputs change |
| `pin_digest` | The run definition it was taken under (§B17) |
| `worker_state` | Opaque worker continuation blob |
| `provider_continuation` | Provider-side conversation/job handle, if any |
| `fanout_progress` | Per-item completion for `foreach`, by item key |
| `effect_journal` | Effects prepared and applied so far (§B13) |
| `sequence` | Monotonic engine sequence |

Commit points are explicit: after `effects_applied`, after `measured`, and at
each `foreach` item boundary — never mid-write.

**Resume versus restart** is decided by the kernel, not the worker:

- `input_digest` unchanged and `pin_digest` matches → **resume** from
  `worker_state` and `provider_continuation`.
- `input_digest` changed → **restart** the unit; prior observations for its
  objectives are invalidated.
- `pin_digest` differs → the run is paused with an explicit migration
  requirement (§B17). Never a silent resume under a changed definition.

Partial fan-out resumes only the incomplete items.

### B15. Leases, heartbeats, and orphan recovery

A wall-clock timeout is a poor definition of failure: a legitimate long
retrieval and a dead worker look identical to it. Attempts hold a renewable
lease and emit progress:

```yaml
lease_owner: worker-17
lease_expires_at: ...
last_progress_sequence: 42
checkpoint: source_18_of_30
```

An attempt is terminated when its **lease expires**, not because a command ran
for thirty minutes. The timeout becomes a watchdog rather than the primary
failure definition. The kernel distinguishes six states, and only some are
safely resumable:

| State | Meaning | Action |
| --- | --- | --- |
| `running_progressing` | Lease renewed, progress advancing | Wait |
| `running_stalled` | N consecutive lease renewals with no change in `last_progress_sequence`, or elapsed time since the last progress event exceeds the profile threshold | Warn, then diagnose. **Never terminates the attempt** — only lease expiry does |
| `worker_lost` | Lease expired, no unreconciled effects | Safe resume |
| `provider_uncertain` | Lease expired, an external call may have landed | Reconcile (§B13) |
| `resumable` | Reconciled, checkpoint valid | Resume |
| `requires_reconciliation` | Effects cannot be proven either way | Durable blocker |

Workers report progress through a uniform event stream, which is also what lets
different harnesses run the same typed unit:

```ts
type WorkerEvent =
  | { type: "started" }
  | { type: "progress"; completed: number; total?: number; checkpoint?: unknown }
  | { type: "tool_call"; tool: string; idempotencyKey: string }
  | { type: "artifact_changed"; path: string; digest: string }
  | { type: "checkpoint"; state: unknown }
  | { type: "completed"; structuredOutput: unknown }
  | { type: "interrupted"; reason: "quota" | "provider" | "operator" }
  | { type: "failed"; error: TypedExecutionError };
```

Adapters for additional harnesses are explicitly **out of scope for Spec 1**;
the event protocol exists so that adding one later is configuration rather than
an architectural change.

### B16. Concurrency: conflict graph, snapshots, and joins

§B11 makes concurrent *observations* sound. Concurrent *mutations* need
prevention, not post-hoc detection: hashing afterward proves two workers raced
on the same chapter but does not stop them.

The kernel derives a **write-conflict graph** from every runnable unit's
`reads`, `writes`, and `owns`, and serializes units whose envelopes overlap.

- Section writers with disjoint `owns` run in parallel.
- Two units that both write `sources/bibliography.bib` are serialized by an
  **exclusive lease** on that artifact.
- A manuscript-wide coherence edit (Spec 2 §S8) takes an exclusive manuscript
  lease; nothing else mutates while it holds one.
- Measurements read an **immutable snapshot** and may run concurrently.

Every task is issued a `snapshot_id`. A join reducer receives a declared
snapshot, never "whatever files happen to exist when it starts," and parallel
section outputs are combined by a **declared merge reducer** rather than
last-writer-wins. If the snapshot changed between a unit's dispatch and its
commit, its measurements are re-taken before acceptance is evaluated.

### B17. Run pinning

A run pins its definition at start:

```yaml
pin_digest: <hash of everything below>
  ir_version, manifest_digest
  metric_registry_version, finding_registry_version
  prompt_versions
  model_profile            # logical tiers -> runtime mapping
  evaluator_configuration
  tool_and_provider_versions
```

A paused run resumes **against its pinned definition, or fails with an explicit
migration requirement**. It never silently resumes under changed prompts,
registries, or model mappings — that would make prior observations
incomparable with new ones, which is the same class of error as resolving
freshness by wall clock (§B11). During the POC this is deliberately a hard
failure rather than an automatic migration.

### B18. Untrusted content and least privilege

Retrieved papers, web pages, repositories, README files, and issue comments are
**data, never instructions**. This is a contract concern because it is enforced
by the same mechanism as everything else in Part B: what a unit may reach.

- Externally derived content enters a task packet under a content role that is
  explicitly labeled untrusted, and is never concatenated into the instruction
  region.
- Tool grants are least-privilege per unit; a prose repair holds no network or
  provider tool.
- Secrets are redacted from task packets, event streams, logs, and serialized
  run state.
- Publishing, external writes, destructive operations, and paid calls above a
  configured threshold require an approval artifact.
- Every externally derived assertion carries provenance.

Adversarial cases — injection embedded in a retrieved page or repository — are
exercised by the fault matrix in Spec 3.

## 7. Worked example

A `rendered_visual_review` failure whose real defect is prose.

1. The visual-review gate renders the PDF and finds Figure 1 unnamed in the
   paragraph preceding its placement. It emits an observation
   (`rendered_visual_review = 0`, target 1, tier `release`) and a finding with
   `artifact.kind = chapter_prose`, `path = chapters/section-03.md`,
   `required_effect = add_explicit_artifact_reference`.
2. Routing resolves the triple to `revise_sections`. Today the gate-keyed route
   sends this to `revise_visual_plan`, which may write only
   `figures/placement-plan.json` and cannot fix it.
3. A repair packet carries the finding, the chapter fragment, the figure
   caption, the passing gates to preserve, and the acceptance test.
4. The action declares `owns: [chapters/**]`. A write to
   `figures/placement-plan.json` would be an undeclared write.
5. `rendered_visual_review` is tier `release`, so the action returns
   `pending_verification`. The round rebuilds once and re-measures.
6. Outcome: `accepted`, or `regressed` if `claim_support` fell — in which
   case the workspace blocks rather than starting another round.

## 8. Testing

**MalaClaw kernel — domain-neutral fixtures only.** No paper vocabulary:

- a code repair improves test coverage → `accepted`
- a document repair improves a score without reaching target → `improved`
- a data transformation regresses row validity → `regressed`, workspace blocked
- a repeated strategy produces no delta → `repeated_strategy: reject`
- a unit modifies an undeclared file → `undeclared_write`
- a deferred expensive metric → `pending_verification`, batch-resolved
- a provider quota pause resumes from checkpoint

**MrMaLiang — regression fixtures from the current flagship.** Freeze the
workspace *before* any reinitialization; items 1 and 3 depend on intermediate
state a rebuild will not reproduce:

1. Landmarks dropped between identity verification and evidence extraction →
   reservation-accounting test.
2. Misrouted `rendered_visual_review` findings → routing-triple test.
3. Prose redundancy improving while citation density, visual review, and review
   score regressed → `partially_improved_with_regression`.
4. Aggregate stagnation resetting because one goal passed → per-objective
   stagnation.
5. Quota pause and resume → checkpoint recovery.
6. Max-round exhaustion without diagnosis → `strategy_exhausted` (not
   `unreachable`, unless reachability analysis proves the landmark target
   infeasible).

## 9. Migration

No backward compatibility. IR v2 is a breaking revision:

- `ir_version: 2`; the engine rejects v1 manifests with a specific message.
- Test and POC workspaces are reinitialized, not migrated.
- Old flagship workspaces are retained read-only as fixtures.
- MrMaLiang's compiler emits v2 only.

The `.optional()`-over-`.default([])` hash-stability technique is deliberately
not used. It exists to protect in-flight runs, and there are none worth
protecting.

## 10. Sequence

Parallelize once the interfaces are frozen; serializing the two repositories
behind each other is unnecessary after step 3.

1. **Curate** minimal regression fixtures from the current workspace. Curate,
   do not copy: no downloaded PDFs, no credentials, no 1,500-source corpus in
   Git. Each fixture is the smallest state that reproduces its failure.
2. **Define registry schemas** — metric, finding, artifact kind, required
   effect, capability, gate class — with the generated coverage test (§A3b).
3. **Generate the complete inventory and freeze the IR boundary.** This is the
   join point; everything after it can proceed independently.
4. **Two parallel workstreams:**
   - *MrMaLiang* — metric evaluators and measurement pipelines; structured
     gates; **target reservation and selector accounting**; repair packets.
   - *MalaClaw* — Contract IR v2; effect enforcement; observation store; typed
     outcomes; blockers and `repair-block`.
5. **Join** through the MrMaLiang compiler.
6. Run the six current-workspace regressions (§8).
7. Run the cross-topic fault-injection matrix (Spec 3).
8. Start the next flagship.

Target reservation moves into step 4 rather than waiting for compiler
integration: it is an independently confirmed defect with its own tests, and it
does not depend on IR v2.

## 11. Success criteria

**Terminal guarantee.** A run ends *released*, *cancelled by its operator*, or
*paused with exactly one active typed blocker*. A blocker may represent
operator input, strategy exhaustion, proven unreachability, regression,
undeclared writes, or exhausted budget. "Retried three rounds, still failing,
no diagnosis" is not a reachable state.

Invariants:

- No repair executes without a validated artifact triple.
- **No repair contract becomes `accepted` or `improved` without a fresh,
  trusted measurement.** Units with no quality contract may complete once their
  output and effect contracts validate (`contract: not_applicable`).
- No repair becomes `accepted` while any required measurement is
  `pending_verification`.
- No mutation unit publishes observations that grade itself.
- No observation is reused when dependencies, evaluator code, configuration,
  prompt, or model changed.
- No protected metric falls without blocking the workspace.
- No undeclared write permits downstream execution.
- No identical strategy is dispatched twice against an unchanged objective.
- No reserved research target is dropped without a typed exclusion reason.
- No `manuscript`-class routing decision falls through to a default.
- No expensive deferred measurement is dispatched beyond the remaining budget.
- Every `strategy_exhausted` objective receives a diagnosis.
- Quota and provider interruptions remain **execution** outcomes, resume from
  checkpoint, and never count as failed repair strategies.
- Every gate, metric, capability, artifact kind, and required effect has
  generated coverage validation.
- No uncertain external effect is automatically redispatched; internally
  idempotent effects converge to exactly one committed result. Every attempt is
  journaled before dispatch and reconciled after restart. Exactly-once across a
  provider boundary is not claimed and is not achievable.
- No attempt is terminated for elapsed time alone; only an expired lease
  terminates one.
- No two units with overlapping write envelopes execute concurrently.
- No run resumes under a changed definition without an explicit migration.
- No objective's stagnation is reset by progress at a different scope.
- No externally retrieved content is placed in a unit's instruction region.
