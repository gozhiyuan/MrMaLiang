import { metricId, type MetricId } from "./ids.js";

export type MetricDefinition = {
  metric: MetricId;
  /** Emits one entry per scope. A `section` or `taxonomy_cell` metric must
   * never report an aggregate: the previous taxonomy_cell_ab_sources reported
   * the minimum across cells, which cannot tell a repair which cell to fix. */
  scope_kind: "global" | "section" | "taxonomy_cell";
  direction: "maximize" | "minimize";
  target_type: "ratio" | "count" | "boolean" | "score";
  tolerance: number;
  /** Only a metric that genuinely depends on the current date. */
  time_dependent: boolean;
  measurement_tier: "unit" | "round" | "release";
  measurement_kind: "script" | "model" | "external";
  evaluator: string;
  producer?: string;
  validator?: string;
  reducer: string;
  /** Inputs whose change invalidates the measurement. Never a producer's own
   * output: that would make the measurement's identity depend on its result. */
  dependencies: string[];
  raw_output: string[];
  estimated_cost: { model_calls: number; render_required: boolean };
};

const CHEAP = { model_calls: 0, render_required: false };

/** What a citation metric actually reads: the prose that does the citing and
 * the classified records it cites. Deliberately not the bibliography — no
 * evaluator opens it, and an over-declared dependency invalidates a
 * measurement on a change that could not have altered it. */
const CITED = ["chapters/", "sources/classified_sources.jsonl"];

type Draft = Omit<MetricDefinition, "metric"> & { metric: string };

function define(drafts: Draft[]): Map<MetricId, MetricDefinition> {
  const table = new Map<MetricId, MetricDefinition>();
  for (const draft of drafts) {
    const id = metricId(draft.metric);
    if (table.has(id)) throw new Error(`metric ${draft.metric} is registered twice`);
    // A dependency that is also an output would make the measurement's identity
    // depend on its own result: the digest would change the moment it was
    // written, so nothing could ever be reused.
    for (const output of draft.raw_output) {
      if (draft.dependencies.includes(output)) {
        throw new Error(`metric ${draft.metric} lists its own output ${output} as a dependency`);
      }
    }
    table.set(id, { ...draft, metric: id });
  }
  return table;
}

/** The 22 metrics an action plan may name as acceptance criteria. Deliberately
 * narrower than the registry: a corpus observation such as candidate_count is
 * measurable and useful for diagnosis, but is not a thing a plan may promise. */
const ACCEPTANCE: Draft[] = [
  { metric: "cited_sources", scope_kind: "global", direction: "maximize", target_type: "count",
    tolerance: 0, time_dependent: false, measurement_tier: "round", measurement_kind: "script",
    evaluator: "cited_sources", reducer: "identity", dependencies: CITED,
    raw_output: ["reports/metrics/cited-sources.json"], estimated_cost: CHEAP },
  { metric: "cited_within_one_year_ratio", scope_kind: "global", direction: "maximize", target_type: "ratio",
    tolerance: 0.02, time_dependent: true, measurement_tier: "round", measurement_kind: "script",
    evaluator: "cited_within_one_year_ratio", reducer: "identity", dependencies: CITED,
    raw_output: ["reports/metrics/cited-recency.json"], estimated_cost: CHEAP },
  { metric: "accepted_cited_ratio", scope_kind: "global", direction: "maximize", target_type: "ratio",
    tolerance: 0.02, time_dependent: false, measurement_tier: "round", measurement_kind: "script",
    evaluator: "accepted_cited_ratio", reducer: "identity", dependencies: CITED,
    raw_output: ["reports/metrics/accepted-cited.json"], estimated_cost: CHEAP },
  { metric: "cited_arxiv_only_ratio", scope_kind: "global", direction: "minimize", target_type: "ratio",
    tolerance: 0.02, time_dependent: false, measurement_tier: "round", measurement_kind: "script",
    evaluator: "cited_arxiv_only_ratio", reducer: "identity", dependencies: CITED,
    raw_output: ["reports/metrics/cited-venues.json"], estimated_cost: CHEAP },
  { metric: "citations_per_page", scope_kind: "global", direction: "maximize", target_type: "ratio",
    tolerance: 0.5, time_dependent: false, measurement_tier: "round", measurement_kind: "script",
    evaluator: "citations_per_page", reducer: "identity",
    // The rendered PDF is a genuine input: page count is what the ratio divides by.
    dependencies: [...CITED, "build/manuscript.pdf"],
    raw_output: ["reports/metrics/citation-density.json"], estimated_cost: CHEAP },
  { metric: "citation_depth_per_section", scope_kind: "section", direction: "maximize", target_type: "count",
    tolerance: 0, time_dependent: false, measurement_tier: "round", measurement_kind: "script",
    evaluator: "citation_depth_per_section", reducer: "per_scope", dependencies: ["chapters/"],
    raw_output: ["reports/metrics/citation-depth.json"], estimated_cost: CHEAP },
  { metric: "taxonomy_cell_ab_sources", scope_kind: "taxonomy_cell", direction: "maximize", target_type: "count",
    tolerance: 0, time_dependent: false, measurement_tier: "round", measurement_kind: "script",
    evaluator: "taxonomy_cell_ab_sources", reducer: "per_scope",
    dependencies: ["sources/classified_sources.jsonl", "longwrite.yaml"],
    raw_output: ["reports/metrics/taxonomy-coverage.json"], estimated_cost: CHEAP },
  { metric: "core_sources", scope_kind: "global", direction: "maximize", target_type: "count",
    tolerance: 0, time_dependent: false, measurement_tier: "round", measurement_kind: "script",
    evaluator: "core_sources", reducer: "identity",
    dependencies: ["sources/classified_sources.jsonl"],
    raw_output: ["reports/metrics/core-sources.json"], estimated_cost: CHEAP },
  { metric: "comparative_tables", scope_kind: "global", direction: "maximize", target_type: "count",
    tolerance: 0, time_dependent: false, measurement_tier: "round", measurement_kind: "script",
    evaluator: "comparative_tables", reducer: "identity",
    dependencies: ["figures/manifest.json", "paper/tables/"],
    raw_output: ["reports/metrics/tables.json"], estimated_cost: CHEAP },
  { metric: "verified_metadata_plots", scope_kind: "global", direction: "maximize", target_type: "count",
    tolerance: 0, time_dependent: false, measurement_tier: "round", measurement_kind: "script",
    evaluator: "verified_metadata_plots", reducer: "identity",
    dependencies: ["figures/manifest.json"],
    raw_output: ["reports/metrics/plots.json"], estimated_cost: CHEAP },
  { metric: "figures", scope_kind: "global", direction: "maximize", target_type: "count",
    tolerance: 0, time_dependent: false, measurement_tier: "round", measurement_kind: "script",
    evaluator: "figures", reducer: "identity", dependencies: ["figures/manifest.json"],
    raw_output: ["reports/metrics/figures.json"], estimated_cost: CHEAP },
  { metric: "tables", scope_kind: "global", direction: "maximize", target_type: "count",
    tolerance: 0, time_dependent: false, measurement_tier: "round", measurement_kind: "script",
    evaluator: "tables", reducer: "identity", dependencies: ["figures/manifest.json"],
    raw_output: ["reports/metrics/table-count.json"], estimated_cost: CHEAP },
  { metric: "rendered_visual_review", scope_kind: "global", direction: "maximize", target_type: "boolean",
    tolerance: 0, time_dependent: false, measurement_tier: "release", measurement_kind: "model",
    evaluator: "rendered_visual_review", producer: "render_and_describe_pdf",
    validator: "visual_review_schema", reducer: "adjudicated_consensus",
    // What the reviewer actually looks at: the rendered PDF and the manifest
    // of pages taken from it. Omitting those meant a rebuilt manuscript kept
    // the previous visual judgment, which is the reuse this digest prevents.
    dependencies: ["paper/main.tex", "paper/sections/", "figures/placement-plan.json",
      "build/manuscript.pdf", "reports/visual-render-manifest.json"],
    raw_output: ["reviews/visual-qa.json"], estimated_cost: { model_calls: 3, render_required: true } },
  { metric: "empirical_trials", scope_kind: "global", direction: "maximize", target_type: "count",
    tolerance: 0, time_dependent: false, measurement_tier: "round", measurement_kind: "script",
    evaluator: "empirical_trials", reducer: "identity",
    dependencies: ["evidence/experiment-packets.json"],
    raw_output: ["reports/metrics/trials.json"], estimated_cost: CHEAP },
  { metric: "outline_readiness", scope_kind: "global", direction: "maximize", target_type: "boolean",
    tolerance: 0, time_dependent: false, measurement_tier: "round", measurement_kind: "script",
    evaluator: "outline_readiness", reducer: "identity",
    dependencies: ["outline.md", "outline.json", "reviews/outline-review.json"],
    raw_output: ["reports/outline-readiness.md"], estimated_cost: CHEAP },
  { metric: "review_score", scope_kind: "global", direction: "maximize", target_type: "score",
    tolerance: 0.25, time_dependent: false, measurement_tier: "release", measurement_kind: "model",
    evaluator: "review_score", producer: "persona_review", validator: "scorecard_schema",
    reducer: "adjudicated_consensus",
    dependencies: ["chapters/", "paper/main.tex"],
    raw_output: ["reviews/scorecard.json"], estimated_cost: { model_calls: 4, render_required: false } },
  { metric: "claim_support", scope_kind: "global", direction: "maximize", target_type: "ratio",
    tolerance: 0.02, time_dependent: false, measurement_tier: "release", measurement_kind: "model",
    evaluator: "claim_support", producer: "claim_judgment", validator: "claim_judgment_schema",
    reducer: "adjudicated_consensus",
    dependencies: ["chapters/", "evidence/active-validated-source-evidence.json", "evidence/citation-ledger.jsonl"],
    raw_output: ["reviews/claim-judgments.jsonl"], estimated_cost: { model_calls: 6, render_required: false } },
  { metric: "landmark_coverage_ratio", scope_kind: "global", direction: "maximize", target_type: "ratio",
    tolerance: 0.05, time_dependent: false, measurement_tier: "round", measurement_kind: "script",
    evaluator: "landmark_coverage_ratio", reducer: "identity",
    dependencies: ["sources/classified_sources.jsonl", "research/landmark-candidates.json",
      "evidence/active-validated-source-evidence.json"],
    raw_output: ["reports/metrics/landmarks.json"], estimated_cost: CHEAP },
  { metric: "landmark_citation_coverage_ratio", scope_kind: "global", direction: "maximize", target_type: "ratio",
    tolerance: 0.05, time_dependent: false, measurement_tier: "round", measurement_kind: "script",
    evaluator: "landmark_citation_coverage_ratio", reducer: "identity",
    dependencies: [...CITED, "research/landmark-candidates.json",
      "evidence/active-validated-source-evidence.json"],
    raw_output: ["reports/metrics/landmark-citations.json"], estimated_cost: CHEAP },
  { metric: "claim_contradictions", scope_kind: "global", direction: "minimize", target_type: "count",
    tolerance: 0, time_dependent: false, measurement_tier: "round", measurement_kind: "script",
    evaluator: "claim_contradictions", reducer: "identity",
    dependencies: ["chapters/", "reviews/claim-judgments.jsonl"],
    raw_output: ["reports/metrics/contradictions.json"], estimated_cost: CHEAP },
  { metric: "prose_redundancy", scope_kind: "global", direction: "minimize", target_type: "ratio",
    tolerance: 0.02, time_dependent: false, measurement_tier: "round", measurement_kind: "script",
    evaluator: "prose_redundancy", reducer: "identity", dependencies: ["chapters/"],
    raw_output: ["reports/metrics/redundancy.json"], estimated_cost: CHEAP },
  { metric: "diagram_connectivity", scope_kind: "global", direction: "maximize", target_type: "ratio",
    tolerance: 0.02, time_dependent: false, measurement_tier: "round", measurement_kind: "script",
    evaluator: "diagram_connectivity", reducer: "identity",
    dependencies: ["figures/concept-map.mmd", "figures/workflow.mmd"],
    raw_output: ["reports/metrics/diagram-connectivity.json"], estimated_cost: CHEAP },
];

/** Observable but not promisable. A plan cannot set candidate_count as an
 * acceptance criterion — it is an input to diagnosis, not a claim about the
 * manuscript — but every one of these must still be measurable, or a gate that
 * fails on it has no observation to explain itself with. */
const OBSERVATIONS: Draft[] = [
  { metric: "candidate_count", scope_kind: "global", direction: "maximize", target_type: "count",
    tolerance: 0, time_dependent: false, measurement_tier: "unit", measurement_kind: "script",
    evaluator: "candidate_count", reducer: "identity",
    dependencies: ["sources/classified_sources.jsonl"],
    raw_output: ["reports/corpus-gates.json"], estimated_cost: CHEAP },
  { metric: "recent_source_ratio", scope_kind: "global", direction: "maximize", target_type: "ratio",
    tolerance: 0.02, time_dependent: true, measurement_tier: "unit", measurement_kind: "script",
    evaluator: "recent_source_ratio", reducer: "identity",
    dependencies: ["sources/classified_sources.jsonl"],
    raw_output: ["reports/metrics/recency.json"], estimated_cost: CHEAP },
  { metric: "source_type_diversity_count", scope_kind: "global", direction: "maximize", target_type: "count",
    tolerance: 0, time_dependent: false, measurement_tier: "unit", measurement_kind: "script",
    evaluator: "source_type_diversity_count", reducer: "identity",
    dependencies: ["sources/classified_sources.jsonl"],
    raw_output: ["reports/metrics/diversity.json"], estimated_cost: CHEAP },
  // A gate a capability may protect needs a metric under its own name, so the
  // kernel can ask "is it satisfied now" without re-running the whole gate.
  { metric: "citation_verification_status", scope_kind: "global", direction: "maximize", target_type: "boolean",
    tolerance: 0, time_dependent: false, measurement_tier: "round", measurement_kind: "script",
    evaluator: "citation_verification_status", reducer: "identity",
    dependencies: ["chapters/", "sources/classified_sources.jsonl"],
    raw_output: ["reports/source-verification.md"], estimated_cost: CHEAP },
  // External, not script: its value comes from running a LaTeX toolchain this
  // product does not own, so the latex producer emits the observation rather
  // than a script evaluator computing one.
  { metric: "latex_build_status", scope_kind: "global", direction: "maximize", target_type: "boolean",
    tolerance: 0, time_dependent: false, measurement_tier: "round", measurement_kind: "external",
    evaluator: "latex_build_status", reducer: "identity",
    dependencies: ["paper/main.tex", "paper/sections/", "paper/template/", "paper/references.bib"],
    raw_output: ["reports/latex-build.md"], estimated_cost: { model_calls: 0, render_required: true } },
];

export const METRIC_REGISTRY: ReadonlyMap<MetricId, MetricDefinition> =
  define([...ACCEPTANCE, ...OBSERVATIONS]);

export const PLANNER_SELECTABLE: ReadonlySet<MetricId> =
  new Set(ACCEPTANCE.map((draft) => metricId(draft.metric)));

/** No default. An unregistered metric is a typo or an unmigrated caller, and
 * either way the honest answer is to stop rather than measure nothing. */
export function metricDefinition(id: MetricId): MetricDefinition {
  const found = METRIC_REGISTRY.get(id);
  if (!found) throw new Error(`unknown metric: ${id}. Register it in metrics.ts.`);
  return found;
}

export function metricsOfTier(tier: MetricDefinition["measurement_tier"]): MetricId[] {
  return [...METRIC_REGISTRY.values()]
    .filter((definition) => definition.measurement_tier === tier)
    .map((definition) => definition.metric);
}
