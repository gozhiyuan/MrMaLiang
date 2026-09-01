# Cross-Topic Reliability and Release Qualification — Spec 3

Status: frozen pending implementation plan
Date: 2026-09-01
Scope: MrMaLiang test harness + MalaClaw fault injection hooks
Depends on: [Spec 1 — Contract Enforcement Core](2026-08-31-contract-enforcement-core-design.md),
[Spec 2 — Scholarly Synthesis and Artifact Quality](2026-09-01-scholarly-synthesis-quality-design.md)
Deferred follow-on: Spec 4 — Multi-Tenant Production Operations

## 1. Problem

Spec 1 makes the loop truthful; Spec 2 makes the manuscript scholarly. Neither
demonstrates that either holds on a topic nobody designed them against.

The current evidence base is one flagship run and 83 unit tests. A workflow is
not robust because one flagship eventually succeeded — it is robust when dozens
of deliberately varied and fault-injected runs recover predictably. Today the
only way we discover an orchestration bug is by spending a long flagship run on
it, which is both the slowest and the most expensive detector available.

Spec 3 replaces that with a harness. Its purpose is **qualification**: deciding
whether a candidate workflow version may run an expensive flagship, and later,
whether it may be distributed.

Deployment and multi-tenancy are explicitly *not* in scope. Evaluation and
operations are different concerns, and the earlier "cross-topic evaluation and
distribution" framing conflated them.

## 2. Three test modes

| Mode | Cost | Question |
| --- | --- | --- |
| **Trace replay** | Near zero | Does the new runtime handle a recorded historical failure correctly? |
| **Shadow execution** | Model calls, no committed effects | Does the candidate choose different actions than the incumbent? |
| **Canary run** | A short real paper | Does it release without manual repair? |

Trace replay is the workhorse. Curated traces from the flagship failures (Spec 1
§8) are replayed against every compiler and runtime change, so orchestration
regressions are caught in seconds rather than in a multi-hour run.

**Shadow execution runs in an isolated copy-on-write clone**, not against the
real workspace with effects held at `prepared`. Holding every effect at
`prepared` means no artifact ever changes, so the second stage has nothing new
to read and nothing new to measure — that arrangement can compare a single
action selection, not a multi-stage run.

Instead, the candidate gets a copy-on-write clone of the workspace at a pinned
`snapshot_id`. Effects are applied and measured **normally** inside the clone;
the clone is simply never merged back. External side effects that cost money or
are visible outside the workspace — provider retrieval, paid image generation,
publishing — are served from a recorded fixture or stubbed, keyed by
`idempotency_key` so a shadow run cannot re-bill a real call.

The clone is discarded on completion, and its observation store is retained as a
trace for comparison against the incumbent.

## 3. Topic matrix

Nine profiles, chosen because each stresses a different failure surface:

| Profile | Stresses |
| --- | --- |
| Mature CS survey, abundant literature | Corpus gates, redundancy, taxonomy overlap |
| Emerging topic, sparse literature | Reachability, `target_infeasible`, landmark exclusion reasons |
| Interdisciplinary | Taxonomy coherence, terminology consistency (Spec 2 S8) |
| GitHub-grounded systems paper | Codebase locators, repository revision pinning |
| Empirical profile | Experiment manifest handoff, trial accounting |
| Theoretical profile | Formalization policy (Spec 2 §5.3) |
| Landmark full text unavailable | `fulltext_unavailable` vs "dropped" (Spec 1 §A5) |
| Conflicting evidence | `contradicts` edges, adjudication (Spec 1 §A2) |
| Ambiguous terminology | Identity reconciliation, duplicate canonical targets |

Each runs in short and long profile variants, since profile presets scale
targets and the two exercise different reachability outcomes.

## 4. Fault injection

Faults are injected at the kernel boundary, not simulated in prompts.

**Provider and infrastructure**
- Provider timeout mid-retrieval
- Quota exhaustion mid-round → must resume from checkpoint as an *execution*
  outcome, never counted as a failed repair strategy
- Rate limiting with backoff
- Missing external tool (no LaTeX compiler, no matplotlib, no image backend)
- Dead URLs and missing metadata

**Model output**
- Malformed structured output (non-JSON, array where object expected, fenced)
- Schema-valid but referentially invalid plan (unknown finding ids)
- An evaluator producing invalid output → `measurement_failed`
- Two evaluators materially disagreeing → adjudication path

**Execution and recovery**
- Crash after a write, before completion is recorded → the Spec 1 §B13 reconciliation
  path, verifying no duplicated effect
- Crash mid-fan-out → partial `fanout_progress` resume
- Crash during measurement → observation not committed, re-measured
- Crash during packaging → no double release
- Worker lease expiry with unreconciled effects → `requires_reconciliation`
- Resume under changed prompts or registries → explicit migration failure (Spec 1 §B17)

**Contract violations**
- A repair improving its target while damaging a protected metric →
  `partially_improved_with_regression`, workspace blocked, `repair-block` clears
- A worker writing outside its `owns` envelope → `undeclared_write`
- A worker reading outside its declared `reads` → `undeclared_read`
- Two units with overlapping envelopes scheduled together → must serialize

**Adversarial**
- Prompt injection embedded in a retrieved paper, web page, README, or issue
  comment → must remain data, never reach the instruction region (Spec 1 §B18)
- Secret-shaped strings in retrieved content → redaction from packets and logs

## 5. Measurements

Per run:

| Measurement | Why |
| --- | --- |
| Terminal outcome | The Spec 1 §11 guarantee is the headline result |
| `unexpected_intervention_count` | The number that decides distributability; excludes configured approvals and correct typed blockers |
| Repeated-strategy count | Must be 0; nonzero means fingerprinting failed |
| Recovery success rate | Fraction of injected faults resuming correctly |
| Release-gate pass rate | Per gate, to find gates that never pass anywhere |
| Cost and duration | Per phase and per tier, to catch escalation blowup |
| Unsupported-claim rate | Independent of the run's own claim gate |
| Redundancy | Idea-level (Spec 2 S9), not n-gram |
| Landmark coverage | With exclusion reasons, not just the ratio |
| Table and figure usefulness | Per Spec 2 §5.1–5.2 — usefulness, not existence |
| Human scholarly-quality review | Blind, on a sample; the only unfakeable signal |

Two rules keep these honest, and both were stated too broadly in the first
draft.

**Independent evaluator, fixed shared rubric.** Qualification uses an evaluator
independent of the workflow under test — otherwise the harness inherits the
system's blind spots. But the *rubric* must be **separately versioned and held
constant across incumbent and candidate**. Varying the rubric alongside the
evaluator makes score distributions incomparable, which defeats the comparison
the gate depends on. Rubric version is pinned per qualification campaign and
recorded in every bundle.

**Zero variance is uninformative only for discriminative metrics.** For quality
measures — synthesis depth, table usefulness, human review — a metric that never
moves across nine profiles is telling us nothing and is reported as
uninformative. For **invariants** — duplicated effects, repeated strategies,
undeclared writes, unexpected interventions — zero variance at zero is exactly
the intended result and is reported as a pass.

## 6. Promotion gate

A candidate workflow version earns the right to an expensive flagship:

1. **Replay** all curated historical traces — no regression.
2. **Shadow** against the incumbent in a clone — outcome and cost distributions
   compared; any newly divergent action explained.
3. **Canary** on short papers across ≥3 topic profiles.
4. **Promote** on the quantitative rules below.

"Release rate improves" is not a usable rule: once the incumbent reaches 100%,
it can never promote a cheaper or higher-quality candidate, and a single
stochastic run per profile cannot compare distributions at all. The gate is
therefore **non-inferiority with explicit bounds**:

| Rule | Threshold |
| --- | --- |
| Release rate | Non-inferior within `margin_release` of incumbent |
| Independent quality score | Non-inferior within `margin_quality` |
| Cost per released paper | ≤ incumbent × `max_cost_regression` |
| Wall-clock duration | ≤ incumbent × `max_latency_regression` |
| `unexpected_intervention_count` | **0**, no margin |
| Duplicated effects, repeated strategies | **0**, no margin |
| Trials | ≥ `min_trials_per_profile`, or a sequential stopping rule reaching significance earlier |

Profiles are also split by their **expected terminal outcome**. Not every
profile should release:

| Profile class | Must end |
| --- | --- |
| Abundant literature, mature survey, GitHub-grounded, empirical, theoretical | `released` |
| Sparse literature, landmark full text unavailable, unreachable citation target | Correctly `unreachable` or `operator_required` with the right reason |
| Conflicting evidence, ambiguous terminology | `released` with contradictions declared, or `operator_required` |

A profile that releases when it should have terminated on a typed blocker is a
**failure**, not a bonus — it means the system papered over an infeasible
premise.

**`unexpected_intervention_count`** counts only unplanned human action. A
configured `outline_approval: manual` pause (Spec 2 §S6) and a correctly
diagnosed `operator_required` on an infeasible profile are *intended* outcomes
and are excluded. Canaries run with `outline_approval: automatic` so the
zero-intervention requirement is satisfiable by construction.

A long flagship runs only after short canaries release without manual repair.
This is the rule that stops orchestration bugs being discovered at flagship
cost.

## 7. Reproducibility bundle

Every qualifying run emits a bundle: the pinned run definition (Spec 1 §B17),
model and tier assignments, evidence provenance, the full action and outcome
history, observation records with digests, injected faults, and gate results.
A bundle is sufficient to replay the run as a trace, which is what makes today's
canary tomorrow's regression test.

## 8. Deliberately deferred to Spec 4

Durable distributed queues; per-user isolation; secret storage; provider
credential and quota management; fair scheduling; backpressure; worker version
rollout; tenant cancellation and retention; SLOs and alerting. These become
MalaClaw infrastructure — most likely a Temporal-backed execution mode behind
the same domain-neutral contract API — and none of them is on the path to a
reliable single-user pipeline.

Also deferred: additional worker adapters (Pi, Hermes, OpenHands). Spec 1 §B15
defines the event protocol so that adding one is configuration, not
architecture. Building them before the contract core is proven would multiply
the surface under test.

## 9. Success criteria

- Every historical flagship failure is a replayable trace in CI.
- No orchestration regression is first discovered by a flagship run.
- Every injected fault produces its specified typed outcome, not a crash.
- No injected crash produces a duplicated effect.
- Every topic profile terminates released, cancelled, or paused on exactly one
  typed blocker.
- `unexpected_intervention_count` is 0 across the canary set before any
  flagship; configured approvals and correct typed blockers are excluded.
- Independent quality review uses an evaluator independent of the run under
  test, and a fixed qualification rubric shared by incumbent and candidate.
- Every qualifying run emits a bundle sufficient to replay it.
