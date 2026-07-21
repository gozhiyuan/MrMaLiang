import fs from "node:fs/promises";
import path from "node:path";
import { loadProjectConfig } from "../project-config.js";
import { parseJsonl } from "./jsonl.js";
import { loadSearchPlan, matchingTaxonomyCell } from "./search-plan.js";
import type { ClassifiedSource, RawSource } from "./types.js";

export type CorpusGateFinding = {
  id: string;
  pass: boolean;
  detail: string;
};

export type CorpusGateReport = {
  version: 1;
  pass: boolean;
  source_count: number;
  recent_ratio: number;
  source_type_count: number;
  core_source_count: number;
  taxonomy: Array<{ cell: string; source_count: number; pass: boolean; coverage_method: "planned_query_provenance" | "literal_text" }>;
  findings: CorpusGateFinding[];
};

async function readJsonl<T>(workspaceDir: string, rel: string): Promise<T[]> {
  const raw = await fs.readFile(path.join(workspaceDir, rel), "utf-8");
  return parseJsonl<T>(raw);
}

function sourceText(source: RawSource): string {
  return `${source.title} ${source.abstract} ${source.topics.join(" ")}`.toLowerCase();
}

function isCore(source: ClassifiedSource): boolean {
  return source.citation_depth === "A" || source.citation_depth === "B";
}

export async function evaluateCorpusGates(workspaceDir: string): Promise<CorpusGateReport> {
  const config = await loadProjectConfig(workspaceDir);
  const gates = config.research.corpus_gates;
  const sources = await readJsonl<ClassifiedSource>(workspaceDir, "sources/classified_sources.jsonl");
  const currentYear = new Date().getFullYear();
  const recent = sources.filter((source) => source.year >= currentYear - 2).length;
  const recentRatio = recent / Math.max(1, sources.length);
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
  const planLoad = await loadSearchPlan(workspaceDir);
  const plan = planLoad.present && planLoad.ok ? planLoad.plan : undefined;
  const taxonomy = config.research.taxonomy.map((cell) => {
    const plannedCell = plan ? matchingTaxonomyCell(cell, plan) : undefined;
    const plannedQueries = new Set(plannedCell?.query_variants ?? []);
    const provenanceCount = plannedQueries.size > 0
      ? sources.filter((source) => source.provenance && plannedQueries.has(source.provenance.query)).length
      : 0;
    // Workspaces without an LLM search plan retain literal-text coverage. A
    // recorded planned query group is stronger evidence of intended coverage
    // than requiring the human taxonomy label to appear verbatim in a paper.
    const literalCount = sources.filter((source) => sourceText(source).includes(cell.toLowerCase())).length;
    const coverageMethod = provenanceCount > 0 ? "planned_query_provenance" as const : "literal_text" as const;
    const count = provenanceCount > 0 ? provenanceCount : literalCount;
    return { cell, source_count: count, pass: count >= gates.min_sources_per_taxonomy_cell, coverage_method: coverageMethod };
  });

  const findings: CorpusGateFinding[] = [
    {
      id: "total_candidates",
      pass: sources.length >= gates.min_candidates,
      detail: `${sources.length} classified sources; required ${gates.min_candidates}`,
    },
    {
      id: "core_sources",
      pass: coreSourceCount >= gates.min_core_sources,
      detail: `${coreSourceCount} A/B-depth core sources; required ${gates.min_core_sources}`,
    },
    {
      id: "freshness",
      pass: recentRatio >= gates.min_recent_ratio,
      detail: `${recentRatio.toFixed(3)} recent ratio; required ${gates.min_recent_ratio.toFixed(3)}`,
    },
    {
      id: "source_type_diversity",
      pass: sourceTypeCount >= gates.min_source_type_diversity,
      detail: `${sourceTypeCount} provider/identifier types; required ${gates.min_source_type_diversity}`,
    },
    ...taxonomy.map((row) => ({
      id: `taxonomy:${row.cell}`,
      pass: row.pass,
      detail: `${row.source_count} sources for taxonomy cell "${row.cell}" via ${row.coverage_method.replaceAll("_", " ")}; required ${gates.min_sources_per_taxonomy_cell}`,
    })),
  ];
  return {
    version: 1,
    pass: findings.every((finding) => finding.pass),
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
