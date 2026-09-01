# Scholarly Synthesis and Artifact Quality — Spec 2

Status: frozen pending implementation plan
Date: 2026-09-01
Scope: MrMaLiang only. Adds no MalaClaw primitives.
Depends on: [Spec 1 — Contract Enforcement Core](2026-08-31-contract-enforcement-core-design.md)
Follow-on: Spec 3 — Cross-Topic Reliability and Release Qualification

## 1. Problem

Spec 1 makes the improvement loop truthful. It does not make the manuscript
good. A run can now be guaranteed to route a finding to the capability that
owns it, prove the repair moved the metric, and block on regression — and still
produce a paper that is a competent list of summarized sources.

The short-paper flagship demonstrated exactly that failure profile: prose that
was source-by-source rather than argued, tables dominated by "not specified,"
figures that were decorative, and an argument the reader could not restate after
finishing.

The existing [Scholarly Quality v3 plan](../plans/2026-08-29-scholarly-quality-v3-core.md)
adds five useful gates — prose redundancy, diagram connectivity, system-card
evidence fields, cross-section contradiction, landmark coverage. Every one of
them **detects a defect after drafting**. None of them causes a strong paper to
be written in the first place.

Spec 2 is the production-side specification. Its rule:

> Spec 1 enforces contracts. Spec 2 defines the objectives and the artifact
> producers whose contracts are enforced.

## 2. Non-goals

- Any new MalaClaw primitive. Everything here compiles to Spec 1 contracts.
- Prompt wording. Prompts are rendered from registries (Spec 1 §A7); this spec
  defines *what must exist*, not how to ask for it.
- Detection gates already delivered by Scholarly Quality v3. They stay; this
  spec adds the producers they were measuring the absence of.
- Guaranteeing a review score. A weak research premise cannot be rescued by
  process, and §9 makes that an explicit outcome rather than a silent failure.

## 3. Root cause: composition without a thesis

The current pipeline goes taxonomy → outline → per-section drafting → review.
Nothing between "taxonomy" and "drafting" ever states **what the paper argues**.
Section writers therefore optimize the only thing they can see — coverage of
their assigned sources — and coverage of sources is precisely what produces
source-by-source prose.

Three artifacts are missing, and they are missing in a specific order:

1. A **contribution thesis** — what this paper claims that no single cited work
   claims.
2. A **claim graph** — the evidence organized as assertions with support,
   conflict, and dependency relations, rather than as per-source summaries.
3. An **argument map** — what each section must establish, and why the paper is
   incomplete without it.

Without (1), section contracts cannot be non-overlapping, because there is no
criterion for what belongs where. Without (2), synthesis is impossible, because
comparison requires claims on a shared axis. Without (3), a manuscript-wide
editor has nothing to check coherence *against*.

## 4. The synthesis chain

Each artifact is produced by a unit whose Spec 1 contract makes it measurable.
Each gates the next; none may be skipped.

```
research question + scope
  -> provisional thesis           (S1)   direction, not yet accepted
  -> evidence matrix              (S2)   builds the shared dimensions
  -> validated thesis             (S2b)  accepted against those dimensions
  -> claim graph                  (S3)
  -> argument map                 (S4)
  -> section contracts            (S5)
  -> global outline review        (S6)  [approval gate]
  -> section drafting             (S7)
  -> manuscript coherence edit    (S8)  [exclusive manuscript lease]
  -> redundancy-aware revision    (S9)
  -> final scholarly edit         (S10) [once, near release]
```

### S1. Provisional thesis

Before any drafting. States the research question, the scope boundary, and
**one to three candidate contribution claims** that no single cited work makes —
a synthesis, a reframing, a comparison nobody has drawn, an identified gap.

This stage is deliberately *provisional*. Accepting a thesis requires shared
comparison dimensions, and those are constructed by S2 — so accepting here
would be circular. A provisional thesis instead gives S2 a direction to build
toward, which is what stops the evidence matrix from being an undirected
cross-product of every source against every dimension.

- Tier: `high`. Owns: `synthesis/thesis.json` (`status: provisional`).
- Acceptance: claims are well-formed, in scope, and not restatable as a single
  cited source's abstract — checks that need no dimension vocabulary.

### S2b. Validated thesis

After the evidence matrix exists, the provisional thesis is accepted, revised,
or rejected against it.

- Tier: `high`. Owns: `synthesis/thesis.json` (`status: validated`).
- Acceptance: every surviving contribution claim resolves to ≥2 supporting
  sources on a shared dimension from S2, and no claim is restatable as a single
  source's abstract.
- Rejection is a legitimate outcome: a premise the corpus cannot support
  terminates as `operator_required` (§9) rather than being drafted around.

### S2. Evidence matrix

Sources × {claims, comparison dimensions, limitations, disagreements}. Built
deterministically from validated evidence packets; the model supplies dimension
labels, reusing `evidence/comparison-dimensions.json` where one fits.

- Acceptance: every A/B-depth source appears on ≥1 shared dimension. A source on
  no shared dimension is reported as unintegrated, not silently cited.

### S3. Claim graph

Nodes are claims; edges are `supports`, `contradicts`, `refines`, `depends_on`.
This replaces per-source summarization as the drafting substrate.

- Acceptance: every claim carries ≥1 packet-backed locator; every `contradicts`
  edge is either resolved in prose or declared an open disagreement.
- Reuses the contradiction detection from Scholarly Quality v3 Task 4, moved
  *before* drafting instead of after it.

### S4. Argument map

For each section: what it establishes, which claim-graph nodes it discharges,
what the paper would lose without it, and its dependencies on earlier sections.

- Acceptance: every contribution claim from S1 is discharged by ≥1 section, and
  every section discharges ≥1 node. A section that discharges nothing is cut.

### S5. Section contracts

Purpose, discharged claims, owned comparison dimensions, and **declared
overlap** with named sibling sections.

Absolute disjointness would reject legitimate structure: introductions,
conclusions, and cross-cutting concerns such as safety or evaluation
legitimately revisit dimensions owned elsewhere. The contract is therefore
*primary ownership with declared references*:

- Every comparison dimension has exactly **one `primary_owner`** section.
- Any number of sections may declare a **`reference`** to a dimension they do
  not own, with a stated role: `recap`, `extension`, `contrast`, or
  `application`.
- An undeclared second treatment of an owned dimension is the violation — not
  the mention itself.

- Acceptance: `section_dimension_overlap` counts only *undeclared* overlaps;
  every section's purpose is distinguishable from its siblings by an
  independent reader.
- This is the structural fix for redundancy. Scholarly Quality v3 detects
  repeated n-grams after the fact; primary ownership prevents two writers from
  being *asked* to cover the same ground unknowingly.

### S6. Global outline review

One `high`-tier review of the whole structure before any prose exists. Existing
`outline_readiness` machinery; the addition is that it now reviews S1–S5
together rather than an outline alone.

**Approval is profile-driven**, because a hard human gate here would make the
zero-intervention canary requirement in Spec 3 §6 unsatisfiable by
construction:

| `outline_approval` | Behavior |
| --- | --- |
| `manual` | Explicit human approval required (flagship default) |
| `automatic` | Proceeds when the outline contract passes (canary default) |
| `sampled` | Automatic, with human review on selected qualification runs |

A configured approval is an *intended* pause, not a manual intervention. Spec 3
counts `unexpected_intervention_count` and excludes approvals in this table.

### S7. Section drafting

Tier `quality_drafting` (Spec 1 §A9). Each writer receives its section contract,
its discharged claim-graph nodes, the evidence for those nodes, and its
non-overlap constraints — not the whole corpus.

**Synthesis requirements** are contract conditions, not prompt encouragement.
Each section must compare, contrast, explain mechanism, characterize evidence
strength, and derive an implication.

These apply **at section level, not per claim**. Requiring all five of every
individual claim would manufacture exactly the templated, repetitive prose this
spec exists to remove. A section may mark a requirement `not_applicable` with a
typed reason — `single_approach_in_scope`, `mechanism_not_reported`,
`no_competing_evidence` — which is recorded and reviewable rather than silently
skipped. A section that only reports what sources say, with no typed
exemptions, fails its contract.

### S8. Manuscript coherence edit

One `high`-tier unit over the assembled manuscript, holding an **exclusive
manuscript lease** (Spec 1 §B16). Owns argument progression, terminology
consistency, cross-section transitions, and the narrative through-line.

Independent section writers cannot produce global coherence through repeated
local edits. This is the unit that exists so they are not asked to.

### S9. Redundancy-aware revision

Removes duplicated *ideas*, not duplicated *phrasings*. Operating on the claim
graph, a repeated idea appears as two sections discharging the same node — the
fix is to delete one and cross-reference, never to paraphrase.

- Acceptance: `prose_redundancy` at 0 **and** every claim-graph node has
  exactly one `primary_discharge` section. Recap or extension treatments
  elsewhere are legal when declared with a role (§S5); an undeclared second
  discharge is the defect.
- Paraphrasing to satisfy an n-gram gate is an anti-pattern this makes
  unreachable.

### S10. Final scholarly edit

One `high`-tier pass over the complete manuscript near release, followed by
**fresh independent measurement** — never accepted on the editor's own report.
Runs once, not after every repair.

## 5. Artifact quality contracts

### 5.1 Table usefulness

A table is an argument, not an inventory. Contract:

- Every column is a comparison dimension from the evidence matrix (S2).
- Cell fill rate ≥ a profile threshold; a table dominated by "not specified" is
  rejected rather than shipped with gaps.
- ≥2 rows differ on ≥1 dimension — a table where every row is identical
  compares nothing.
- No column is bibliographic metadata unless the comparison is *about*
  provenance.
- Every table is referenced from prose that states what it shows.

Rejection routes to `revise_visual_plan` with effect `repair_artifact_content`.

### 5.2 Figure design pipeline

Figures currently jump from intent to renderer. The missing stage is design.

```
communicative purpose  ->  information architecture  ->  figure specification
                       ->  renderer  ->  rendered-page review
```

| Stage | Tier | Produces |
| --- | --- | --- |
| Communicative purpose | `high` | The one claim this figure makes |
| Information architecture | `high` | Entities, relations, ordering, emphasis |
| Figure specification | `medium` | Structural spec incl. explicit `layout` |
| Renderer | see below | Mermaid, TikZ, matplotlib, SVG (script) or Nano Banana (external model) |
| Rendered-page review | `release` | Multimodal review of the actual PDF page |

**Nano Banana is a renderer, not a planner.** It may execute a specification; it
may never decide what a figure communicates, and its output is never evidence.
This is the existing rule in `AGENTS.md` made structural.

One renderer capability, two declared kinds — they differ in every operational
property Spec 1 cares about:

```yaml
renderer_kind: script | external_model
```

| | `script` (Mermaid, TikZ, matplotlib, SVG) | `external_model` (Nano Banana) |
| --- | --- | --- |
| Determinism | Same spec → same output | Nondeterministic |
| Cost | Free | Paid per call |
| Idempotency | Re-runnable freely | Needs `idempotency_key` (Spec 1 §B13) |
| Checkpointing | Not needed | Uncertain-effect reconciliation applies |
| Provenance | Spec digest suffices | Model, prompt, and seed recorded |
| `input_digest` | Spec + renderer version | Also prompt and model configuration |

Classifying Nano Banana as a script renderer would let a paid, nondeterministic
call be silently re-executed on resume.

Review operates on the rendered page **at normal reader scale** and returns
structured defects with `artifact.kind` and `required_effect` (Spec 1 §A3), not
"make the figure better."

### 5.3 Formalization policy

Equations and formal models are used when they clarify a mechanism the prose
cannot state precisely. Contract: every formalization names the mechanism it
clarifies and defines every symbol within the same section. A formalization that
clarifies nothing is decorative and is rejected — the failure mode is adding
notation to appear technical.

## 6. What Spec 1 enforces for us

Nothing here needs a new primitive:

| Spec 2 artifact | Spec 1 mechanism |
| --- | --- |
| Every chain artifact | `outputs` + `schema_ref`, typed contract outcomes |
| Synthesis requirements | `acceptance` criteria on measurable observations |
| Non-overlap between sections | `must_preserve` on dimension ownership |
| Manuscript coherence edit | Exclusive manuscript lease (Spec 1 §B16) |
| Table and figure contracts | Structured findings + artifact/effect routing (Spec 1 §A3) |
| Rendered-page review | `measurement_kind: model`, tier `release`, adjudication (Spec 1 §A2) |
| Final edit measured independently | Mutation units cannot grade themselves (Spec 1 §B1) |

## 6b. Registry extensions

Spec 1's registries are closed enums, and `outputs` + `schema_ref` can only
prove that a chain artifact *exists* — it cannot route a finding *about* one.
A defect in the argument map would today have no `ArtifactKind`, no
`RequiredEffect`, and no owning capability, and would therefore fail closed at
the router (Spec 1 §A4) rather than being repaired.

Spec 2 therefore extends MrMaLiang's domain registries. This adds **no MalaClaw
primitive**; every entry below is data in a registry the kernel already reads.

### New `ArtifactKind` values

| Kind | Path | Editable by |
| --- | --- | --- |
| `thesis` | `synthesis/thesis.json` | `revise_thesis` |
| `evidence_matrix` | `synthesis/evidence-matrix.json` | `revise_evidence_matrix` |
| `claim_graph` | `synthesis/claim-graph.json` | `revise_claim_graph` |
| `argument_map` | `synthesis/argument-map.json` | `revise_argument_map` |
| `section_contract` | `synthesis/section-contracts.json` | `revise_argument_map` |

### New `RequiredEffect` values

| Effect | Meaning |
| --- | --- |
| `narrow_scope` | Reduce a thesis claim to what evidence supports |
| `strengthen_contribution` | Replace a claim restatable as one source's abstract |
| `add_comparison_dimension` | Introduce a shared axis two sources both address |
| `integrate_orphan_source` | Place a source currently on no shared dimension |
| `resolve_claim_conflict` | Discharge a `contradicts` edge, or declare it open |
| `reassign_claim_discharge` | Move a claim's `primary_discharge` between sections |
| `declare_dimension_reference` | Legalize an undeclared overlap with a role |
| `cut_unnecessary_section` | Remove a section discharging no claim |
| `repair_bibliography_consistency` | *(from Spec 1 §A3a)* |

### New capabilities

| Capability | Owns | Tier |
| --- | --- | --- |
| `revise_thesis` | `synthesis/thesis.json` | `high` |
| `revise_evidence_matrix` | `synthesis/evidence-matrix.json` | `medium` |
| `revise_claim_graph` | `synthesis/claim-graph.json` | `high` |
| `revise_argument_map` | `synthesis/argument-map.json`, `synthesis/section-contracts.json` | `high` |

All four are structural: they are eligible under `posture: structural` (Spec 1
§B6), which is precisely the frame-changing tier the stall policy withholds
tactical tools in favor of.

### Routes

| Gate | Artifact kind | Effect | Capability |
| --- | --- | --- | --- |
| `thesis_contribution_support` | `thesis` | `strengthen_contribution` / `narrow_scope` | `revise_thesis` |
| `evidence_matrix_integration` | `evidence_matrix` | `add_comparison_dimension` / `integrate_orphan_source` | `revise_evidence_matrix` |
| `claim_graph_locator_coverage` | `claim_graph` | `add_supporting_citation` | `revise_claim_graph` |
| `unresolved_contradiction_edges` | `claim_graph` | `resolve_claim_conflict` | `revise_claim_graph` |
| `orphaned_claim_nodes` | `argument_map` | `reassign_claim_discharge` / `cut_unnecessary_section` | `revise_argument_map` |
| `section_dimension_overlap` | `section_contract` | `declare_dimension_reference` / `reassign_claim_discharge` | `revise_argument_map` |
| `synthesis_depth_per_section` | `chapter_prose` | *(existing effects)* | `revise_sections` |
| `table_usefulness` | `table_spec` | `repair_artifact_content` | `revise_visual_plan` |
| `figure_communicative_purpose` | `figure_spec` | `repair_artifact_content` | `revise_visual_plan` |

### Measurement pipelines

| Metric | `measurement_kind` | Producer / reducer |
| --- | --- | --- |
| `thesis_contribution_support` | script | Matrix join; deterministic count |
| `evidence_matrix_integration` | script | Set difference over dimensions |
| `claim_graph_locator_coverage` | script | Locator resolution against packets |
| `unresolved_contradiction_edges` | script | Graph traversal |
| `section_dimension_overlap` | script | Ownership/reference diff |
| `orphaned_claim_nodes` | script | Graph traversal |
| `thesis_validation_status` | script | S2b acceptance replay |
| `synthesis_depth_per_section` | **model** | Per-requirement judgment; deterministic reduction over five requirements and typed exemptions |
| `table_usefulness` | script | Fill rate, dimension provenance, row divergence |
| `figure_communicative_purpose` | script | Spec completeness; the *rendered* review stays `rendered_visual_review` |

Only `synthesis_depth_per_section` needs model judgment, and it therefore
carries the uncertainty and adjudication requirements of Spec 1 §A2.

### Reachability

Each new metric declares whether it is reachable from the current corpus, so an
infeasible premise fails at S2b rather than after three repair rounds:

- `thesis_contribution_support` is unreachable when no candidate claim has ≥2
  sources on any shared dimension → `target_infeasible` → `operator_required`.
- `evidence_matrix_integration` is unreachable when the corpus contains fewer
  distinct dimensions than the profile's minimum.
- `synthesis_depth_per_section` is never declared unreachable; a low score is a
  repairable defect, not a capacity limit.

## 7. New metrics

Added to the Spec 1 metric registry with tier and dependencies:

| Metric | Tier | Measures |
| --- | --- | --- |
| `thesis_contribution_support` | unit | Contribution claims with ≥2 sources on a shared dimension |
| `evidence_matrix_integration` | unit | A/B sources on ≥1 shared dimension |
| `claim_graph_locator_coverage` | unit | Claims with a packet-backed locator |
| `unresolved_contradiction_edges` | unit | `contradicts` edges neither resolved nor declared |
| `section_dimension_overlap` | unit | Dimensions with an **undeclared** second treatment |
| `synthesis_depth_per_section` | round | Sections meeting all five synthesis requirements |
| `table_usefulness` | unit | Tables passing §5.1 |
| `figure_communicative_purpose` | unit | Figures with a stated claim and architecture |
| `orphaned_claim_nodes` | unit | Claim nodes with no `primary_discharge` |
| `thesis_validation_status` | unit | Contribution claims surviving S2b validation |

## 8. Migration

The synthesis chain is inserted between the existing taxonomy and outline
stages. Existing gates are unaffected; Scholarly Quality v3's contradiction
detection moves earlier (S3) and keeps its post-draft check as a regression
guard. The current flagship workspace cannot be migrated forward — it has no
thesis, claim graph, or argument map — which is a further reason to retain it as
a fixture rather than a release candidate.

## 9. Success criteria

- No section is drafted before a thesis, claim graph, argument map, and section
  contract exist.
- No contribution claim is restatable as a single cited source's abstract.
- No two sections own the same comparison dimension.
- No table ships dominated by "not specified."
- No figure is rendered before its communicative purpose is stated.
- No formalization ships without a named mechanism and defined symbols.
- Manuscript-wide coherence is produced by a unit that sees the whole
  manuscript, never by accumulated local edits.
- The final scholarly edit is measured independently of the editor.
- A paper whose premise cannot support a contribution claim terminates as
  `operator_required` with that reason named — not as an exhausted repair loop.
