import fs from "node:fs/promises";
import path from "node:path";
import { loadProjectConfig } from "../project-config.js";
import { parseJsonl } from "./jsonl.js";
import { loadSearchPlan, matchingTaxonomyCell } from "./search-plan.js";
import { sourceMatchesTaxonomy } from "./taxonomy.js";
import type { ClassifiedSource } from "./types.js";
import { gateId, taxonomyGateId, type GateId } from "../registry/ids.js";
import { FindingSchema, type Finding, type MeasurementEntry, type StructuredCheck } from "../registry/records.js";
import { GLOBAL_SCOPE, scopeKey } from "../registry/scope.js";
import { metricDefinition } from "../registry/metrics.js";
import { metricId } from "../registry/ids.js";
import { computeInputDigest, evaluatorDigest } from "../registry/digests.js";
import { EVALUATOR_VERSION } from "../registry/evaluators/index.js";

export type CorpusGateFinding = {
  id: string;
  pass: boolean;
  detail: string;
};

export type CorpusGateReport = {
  version: 1;
  pass: boolean;
  /** The routable output. `findings` below is an operator summary DERIVED from
   * this; reusing that name for the legacy `{ id, pass, detail }` shape while
   * calling it structured is how a retrieval failure could look routed and not
   * be. */
  checks: StructuredCheck[];
  measurements: MeasurementEntry[];
  source_count: number;
  recent_ratio: number;
  source_type_count: number;
  core_source_count: number;
  taxonomy: Array<{ cell: string; source_count: number; pass: boolean; coverage_method: "planned_query_provenance" | "meaningful_label_terms" }>;
  findings: CorpusGateFinding[];
};

async function readJsonl<T>(workspaceDir: string, rel: string): Promise<T[]> {
  const raw = await fs.readFile(path.join(workspaceDir, rel), "utf-8");
  return parseJsonl<T>(raw);
}

function isCore(source: ClassifiedSource): boolean {
  return source.citation_depth === "A" || source.citation_depth === "B";
}

/** The recency window this product means by "recent". Exported so the
 * recent_source_ratio evaluator and this gate share one definition: the gate
 * previously used a two-year window while the metric would have used one, and
 * a gate that disagrees with its own observation cannot be repaired against. */
export function isRecentSource(source: ClassifiedSource, asOfDate: string): boolean {
  return source.year >= new Date(asOfDate).getUTCFullYear() - 2;
}

export type TaxonomyCellCount = {
  cell: string;
  source_count: number;
  pass: boolean;
  coverage_method: "planned_query_provenance" | "meaningful_label_terms";
};

/** Counts A/B-depth sources covering each configured cell.
 *
 * A recorded planned query group is the strongest evidence of intended
 * coverage. Without one, the same meaningful-term matcher used for evidence
 * allocation applies; a full prose label is not a realistic literal phrase to
 * expect in a title or abstract.
 *
 * The A/B filter matches the metric this feeds, taxonomy_cell_ab_sources. A
 * cell "covered" by a C-depth skim is not covered in any sense a release gate
 * should accept, and counting it here while the metric excluded it would put
 * the gate and its own observation in disagreement. */
export async function taxonomyCellCounts(
  workspaceDir: string, sources: ClassifiedSource[], taxonomy: string[], minPerCell: number,
): Promise<TaxonomyCellCount[]> {
  const planLoad = await loadSearchPlan(workspaceDir);
  const plan = planLoad.present && planLoad.ok ? planLoad.plan : undefined;
  const evidence = sources.filter(isCore);
  return taxonomy.map((cell) => {
    const plannedCell = plan ? matchingTaxonomyCell(cell, plan) : undefined;
    const plannedQueries = new Set(plannedCell?.query_variants ?? []);
    const provenanceCount = plannedQueries.size > 0
      ? evidence.filter((source) => source.provenance && plannedQueries.has(source.provenance.query)).length
      : 0;
    const labelTermCount = evidence.filter((source) => sourceMatchesTaxonomy(source, cell)).length;
    const coverageMethod = provenanceCount > 0 ? "planned_query_provenance" as const : "meaningful_label_terms" as const;
    const count = provenanceCount > 0 ? provenanceCount : labelTermCount;
    return { cell, source_count: count, pass: count >= minPerCell, coverage_method: coverageMethod };
  });
}

/** One evaluation, read twice: the gate decision and the observation come from
 * the same numbers, so a gate cannot fail while its own measurement says it
 * should have passed. */
export async function evaluateCorpusGates(
  workspaceDir: string,
  options: { asOfDate?: string } = {},
): Promise<CorpusGateReport> {
  const asOfDate = options.asOfDate ?? new Date().toISOString();
  const config = await loadProjectConfig(workspaceDir);
  const gates = config.research.corpus_gates;
  const sources = await readJsonl<ClassifiedSource>(workspaceDir, "sources/classified_sources.jsonl");
  const recentRatio = sources.filter((source) => isRecentSource(source, asOfDate)).length / Math.max(1, sources.length);
  const providerTypes = new Set(sources.map((source) => source.source));
  const identifierTypes = new Set(sources.flatMap((source) => [
    source.identifiers?.doi ? "doi" : undefined,
    source.identifiers?.arxiv_id ? "arxiv" : undefined,
    source.identifiers?.semantic_scholar_id ? "semantic_scholar" : undefined,
    source.identifiers?.dblp_key ? "dblp" : undefined,
    source.identifiers?.openalex_id ? "openalex" : undefined,
    source.identifiers?.openreview_id ? "openreview" : undefined,
  ].filter((value): value is string => Boolean(value))));
  const sourceTypeCount = new Set([...providerTypes, ...identifierTypes]).size;
  const coreSourceCount = sources.filter(isCore).length;
  const taxonomy = await taxonomyCellCounts(workspaceDir, sources, config.research.taxonomy, gates.min_sources_per_taxonomy_cell);

  const measurements: MeasurementEntry[] = [];
  const checks: StructuredCheck[] = [];

  /** Records one gate as both a routable check and an observation. A failing
   * gate names the corpus as the artifact and asks for more evidence — that is
   * the whole repair vocabulary retrieval has, and without it every retrieval
   * failure reached the kernel with no artifact, effect or capability. */
  const record = async (args: {
    gate: GateId; metric: string; scopeKey: string; value: number;
    target: number; operator: "at_least" | "at_most"; pass: boolean;
    detail: string; effect?: "acquire_additional_evidence" | "upgrade_source_quality";
  }): Promise<void> => {
    const definition = metricDefinition(metricId(args.metric));
    measurements.push({
      metric: definition.metric, scope_key: args.scopeKey, status: "measured", value: args.value,
      target: args.target, operator: args.operator, tolerance: definition.tolerance,
      direction: definition.direction, evaluator: definition.evaluator,
      evaluator_digest: evaluatorDigest(definition.evaluator, EVALUATOR_VERSION),
      input_digest: await computeInputDigest(workspaceDir, definition, { asOfDate }),
      measurement_kind: definition.measurement_kind,
    });
    const findings: Finding[] = args.pass ? [] : [FindingSchema.parse({
      id: `${args.gate}-${args.scopeKey || "global"}`.replace(/[^A-Za-z0-9._-]+/g, "-"),
      gate_id: args.gate,
      artifact: { kind: "corpus", path: "sources/" },
      objective_scope_key: args.scopeKey,
      required_effect: args.effect ?? "acquire_additional_evidence",
      severity: "major",
      diagnostic: args.detail,
    })];
    checks.push({ id: args.gate, pass: args.pass, findings, measurements: [], requires_diagnosis: false, diagnostic: args.detail });
  };

  await record({
    gate: gateId("total_candidates"), metric: "candidate_count", scopeKey: GLOBAL_SCOPE,
    value: sources.length, target: gates.min_candidates, operator: "at_least",
    pass: sources.length >= gates.min_candidates,
    detail: `${sources.length} classified sources; required ${gates.min_candidates}`,
  });
  await record({
    gate: gateId("core_sources"), metric: "core_sources", scopeKey: GLOBAL_SCOPE,
    value: coreSourceCount, target: gates.min_core_sources, operator: "at_least",
    pass: coreSourceCount >= gates.min_core_sources,
    // A corpus short on A/B depth needs better sources, not merely more.
    effect: "upgrade_source_quality",
    detail: `${coreSourceCount} A/B-depth core sources; required ${gates.min_core_sources}`,
  });
  await record({
    gate: gateId("freshness"), metric: "recent_source_ratio", scopeKey: GLOBAL_SCOPE,
    value: recentRatio, target: gates.min_recent_ratio, operator: "at_least",
    pass: recentRatio >= gates.min_recent_ratio,
    detail: `${recentRatio.toFixed(3)} recent ratio; required ${gates.min_recent_ratio.toFixed(3)}`,
  });
  await record({
    gate: gateId("source_type_diversity"), metric: "source_type_diversity_count", scopeKey: GLOBAL_SCOPE,
    value: sourceTypeCount, target: gates.min_source_type_diversity, operator: "at_least",
    pass: sourceTypeCount >= gates.min_source_type_diversity,
    detail: `${sourceTypeCount} provider/identifier types; required ${gates.min_source_type_diversity}`,
  });
  for (const row of taxonomy) {
    // The gate id and the observation scope are built from one slugify, so a
    // cell cannot be named one way by the gate and another by its scope.
    await record({
      gate: taxonomyGateId(row.cell), metric: "taxonomy_cell_ab_sources",
      scopeKey: scopeKey("taxonomy_cell", row.cell),
      value: row.source_count, target: gates.min_sources_per_taxonomy_cell, operator: "at_least",
      pass: row.pass,
      detail: `${row.source_count} sources for taxonomy cell "${row.cell}" via ${row.coverage_method.replaceAll("_", " ")}; required ${gates.min_sources_per_taxonomy_cell}`,
    });
  }

  // Operator prose, derived from the routable checks rather than computed
  // beside them as a second source of truth.
  const findings: CorpusGateFinding[] = checks.map((check) => ({
    id: String(check.id), pass: check.pass, detail: check.diagnostic ?? "",
  }));

  return {
    version: 1,
    pass: checks.every((check) => check.pass),
    checks,
    measurements,
    source_count: sources.length,
    recent_ratio: recentRatio,
    source_type_count: sourceTypeCount,
    core_source_count: coreSourceCount,
    taxonomy,
    findings,
  };
}

export function corpusGateReportToMarkdown(report: CorpusGateReport): string {
  return [
    "# Corpus Gate Report",
    "",
    `Status: ${report.pass ? "pass" : "fail"}`,
    "",
    `Sources: ${report.source_count}`,
    `Core sources: ${report.core_source_count}`,
    `Recent ratio: ${report.recent_ratio.toFixed(3)}`,
    `Source-type diversity: ${report.source_type_count}`,
    "",
    "## Findings",
    "",
    ...report.findings.map((finding) => `- [${finding.pass ? "pass" : "fail"}] ${finding.id}: ${finding.detail}`),
    "",
  ].join("\n");
}

export async function writeCorpusGateReport(workspaceDir: string, report: CorpusGateReport): Promise<string[]> {
  await fs.mkdir(path.join(workspaceDir, "reports"), { recursive: true });
  const jsonRel = "reports/corpus-gates.json";
  const mdRel = "reports/corpus-gates.md";
  await Promise.all([
    fs.writeFile(path.join(workspaceDir, jsonRel), `${JSON.stringify(report, null, 2)}\n`, "utf-8"),
    fs.writeFile(path.join(workspaceDir, mdRel), corpusGateReportToMarkdown(report), "utf-8"),
  ]);
  return [jsonRel, mdRel];
}

import { defineProducer } from "../registry/producer-types.js";

/** Gate declarations, kept beside the checks that emit them so a reviewer
 * sees a gate's repair semantics and its code together. The class table,
 * legal triples and routes are all generated from this. */
export const PRODUCER = defineProducer({
  module: "corpus-gates",
  gates: [
    { id: "total_candidates", class: "manuscript", observes: ["candidate_count"], findings: [
      { kind: "corpus", effect: "acquire_additional_evidence", capability: "targeted_research_expansion" },
    ] },
    { id: "core_sources", class: "manuscript", observes: ["core_sources"], findings: [
      { kind: "corpus", effect: "acquire_additional_evidence", capability: "targeted_research_expansion" },
      // A corpus short on A/B depth needs better sources, not merely more of
      // them; the research validator already routes this effect the same way.
      { kind: "corpus", effect: "upgrade_source_quality", capability: "targeted_research_expansion" },
    ] },
    { id: "freshness", class: "manuscript", observes: ["recent_source_ratio"], findings: [
      { kind: "corpus", effect: "acquire_additional_evidence", capability: "targeted_research_expansion" },
    ] },
    { id: "source_type_diversity", class: "manuscript", observes: ["source_type_diversity_count"], findings: [
      { kind: "corpus", effect: "acquire_additional_evidence", capability: "targeted_research_expansion" },
    ] },
    { id: "taxonomy", class: "manuscript", observes: ["taxonomy_cell_ab_sources"], findings: [
      { kind: "corpus", effect: "acquire_additional_evidence", capability: "targeted_research_expansion" },
    ] },
  ],
});
