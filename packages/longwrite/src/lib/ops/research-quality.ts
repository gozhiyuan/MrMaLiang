import fs from "node:fs/promises";
import path from "node:path";
import { parseJsonl } from "../research/jsonl.js";
import { citationMarkers } from "../research/citation-markers.js";
import type { CitationPlanEntry, ClassifiedSource } from "../research/types.js";
import { bibtexKey, bibtexKeys } from "../research/bibtex.js";

export type LiteratureQualityDimension = {
  id: string;
  score: number;
  rationale: string;
};

export type LiteratureQualityReport = {
  score: number;
  dimensions: LiteratureQualityDimension[];
  sourceCount: number;
  providerCount: number;
  coreSourceCount: number;
  upgradeCandidates: Array<{ sourceId: string; title: string; reason: string }>;
};

export type CitationVerificationReport = {
  pass: boolean;
  markerCount: number;
  citedSourceCount: number;
  plannedSourceCount: number;
  findings: string[];
};

export type ResearchAssessment = {
  literatureQuality: LiteratureQualityReport;
  citationVerification: CitationVerificationReport;
};

const REPORT_JSON = "reports/research-assessment.json";
const REPORT_MD = "reports/research-assessment.md";
const UPGRADE_JSONL = "sources/source_upgrade_plan.jsonl";

async function readIfExists(absPath: string): Promise<string | null> {
  try {
    return await fs.readFile(absPath, "utf-8");
  } catch {
    return null;
  }
}

async function readJsonl<T>(workspaceDir: string, rel: string): Promise<T[]> {
  const content = await readIfExists(path.join(workspaceDir, rel));
  if (content === null || content.trim().length === 0) return [];
  return parseJsonl<T>(content);
}

async function chapterFiles(workspaceDir: string): Promise<Array<{ rel: string; content: string }>> {
  const dir = path.join(workspaceDir, "chapters");
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const files: Array<{ rel: string; content: string }> = [];
  for (const entry of entries.filter((e) => e.endsWith(".md")).sort()) {
    const rel = path.join("chapters", entry);
    const content = await readIfExists(path.join(workspaceDir, rel));
    if (content !== null) files.push({ rel, content });
  }
  return files;
}

function clamp10(value: number): number {
  return Number(Math.max(0, Math.min(10, value)).toFixed(1));
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function markerIds(content: string): string[] {
  return citationMarkers(content).map((marker) => marker.sourceId);
}

function sectionIdFromChapter(rel: string): string {
  return path.basename(rel, ".md");
}

function hasVenueSignal(source: ClassifiedSource): boolean {
  return !/^(arxiv|crossref|dblp|semantic scholar|seed)$/i.test(source.venue.trim());
}

function providerLabel(source: ClassifiedSource): string {
  return source.source;
}

export function computeLiteratureQuality(sources: ClassifiedSource[]): LiteratureQualityReport {
  const providers = new Set(sources.map(providerLabel));
  const coreSources = sources.filter((source) => source.citation_depth === "A");
  const identifierCoverage = sources.filter((source) =>
    Boolean(source.identifiers?.doi || source.identifiers?.arxiv_id || source.identifiers?.semantic_scholar_id),
  ).length / Math.max(1, sources.length);
  const venueCoverage = sources.filter(hasVenueSignal).length / Math.max(1, sources.length);
  const citationMetricCoverage = sources.filter((source) => source.metrics?.citation_count !== undefined).length / Math.max(1, sources.length);
  const currentYear = new Date().getFullYear();
  const recency = sources.filter((source) => source.year >= currentYear - 5).length / Math.max(1, sources.length);
  const qualityMean = average(sources.map((source) => source.quality_score * 10));
  const depthScore = clamp10(
    (coreSources.length / Math.max(1, sources.length)) * 7 +
    (sources.filter((source) => source.citation_depth === "B").length / Math.max(1, sources.length)) * 3,
  );

  const dimensions: LiteratureQualityDimension[] = [
    {
      id: "source_count",
      score: clamp10((sources.length / 12) * 10),
      rationale: `${sources.length} classified sources; 12+ is the default strong-survey target.`,
    },
    {
      id: "provider_diversity",
      score: clamp10((providers.size / 3) * 10),
      rationale: `${providers.size} provider(s): ${[...providers].sort().join(", ") || "none"}.`,
    },
    {
      id: "identifier_coverage",
      score: clamp10(identifierCoverage * 10),
      rationale: `${Math.round(identifierCoverage * 100)}% of sources include DOI, arXiv, or Semantic Scholar ids.`,
    },
    {
      id: "venue_upgrade",
      score: clamp10((venueCoverage * 0.7 + citationMetricCoverage * 0.3) * 10),
      rationale: `${Math.round(venueCoverage * 100)}% have venue signal; ${Math.round(citationMetricCoverage * 100)}% have citation metrics.`,
    },
    {
      id: "recency",
      score: clamp10(recency * 10),
      rationale: `${Math.round(recency * 100)}% of sources are from the last five years.`,
    },
    {
      id: "citation_depth",
      score: depthScore,
      rationale: `${coreSources.length} core A-depth source(s), ${sources.filter((s) => s.citation_depth === "B").length} B-depth source(s).`,
    },
    {
      id: "retrieval_score",
      score: clamp10(qualityMean),
      rationale: `Mean deterministic retrieval quality score is ${qualityMean.toFixed(1)}/10.`,
    },
  ];

  const upgradeCandidates = sources
    .filter((source) => !source.identifiers?.doi || !hasVenueSignal(source) || source.metrics?.citation_count === undefined)
    .slice(0, 10)
    .map((source) => {
      const missing = [
        !source.identifiers?.doi ? "DOI" : null,
        !hasVenueSignal(source) ? "venue" : null,
        source.metrics?.citation_count === undefined ? "citation metrics" : null,
      ].filter(Boolean).join(", ");
      return { sourceId: source.id, title: source.title, reason: `Upgrade missing ${missing}.` };
    });

  return {
    score: clamp10(average(dimensions.map((dimension) => dimension.score))),
    dimensions,
    sourceCount: sources.length,
    providerCount: providers.size,
    coreSourceCount: coreSources.length,
    upgradeCandidates,
  };
}

export function computeCitationVerification(
  sources: ClassifiedSource[],
  citationPlan: CitationPlanEntry[],
  chapters: Array<{ rel: string; content: string }>,
  bibliography: string | null,
): CitationVerificationReport {
  const sourceIds = new Set(sources.map((source) => source.id));
  const plannedIds = new Set(citationPlan.flatMap((entry) => entry.source_ids));
  const citedIds = new Set<string>();
  const findings: string[] = [];
  let markerCount = 0;

  if (chapters.length === 0) findings.push("No chapter Markdown files found in chapters/.");

  for (const chapter of chapters) {
    const ids = markerIds(chapter.content);
    markerCount += ids.length;
    if (ids.length === 0) findings.push(`${chapter.rel} has no [source:<id>] markers.`);
    for (const id of ids) {
      citedIds.add(id);
      if (!sourceIds.has(id)) findings.push(`${chapter.rel} cites unknown source id "${id}".`);
    }
    const planned = citationPlan.find((entry) => entry.section_id === sectionIdFromChapter(chapter.rel));
    if (planned && !planned.source_ids.some((id) => ids.includes(id))) {
      findings.push(`${chapter.rel} cites none of its planned sources (${planned.source_ids.join(", ")}).`);
    }
  }

  for (const id of plannedIds) {
    if (!sourceIds.has(id)) findings.push(`Citation plan references unknown source id "${id}".`);
  }
  for (const id of plannedIds) {
    if (!citedIds.has(id)) findings.push(`Planned source "${id}" is not cited in any chapter.`);
  }
  if (bibliography === null || bibliography.trim().length === 0) {
    findings.push("sources/bibliography.bib is missing or empty.");
  } else {
    const keys = bibtexKeys(bibliography);
    for (const source of sources) {
      if (!keys.has(bibtexKey(source))) findings.push(`Bibliography is missing source id "${source.id}".`);
    }
  }

  return {
    pass: findings.length === 0,
    markerCount,
    citedSourceCount: citedIds.size,
    plannedSourceCount: plannedIds.size,
    findings,
  };
}

export async function assessResearchWorkspace(workspaceDir: string): Promise<ResearchAssessment> {
  const sources = await readJsonl<ClassifiedSource>(workspaceDir, "sources/classified_sources.jsonl");
  const citationPlan = await readJsonl<CitationPlanEntry>(workspaceDir, "sources/citation_plan.jsonl");
  const chapters = await chapterFiles(workspaceDir);
  const bibliography = await readIfExists(path.join(workspaceDir, "sources/bibliography.bib"));
  // Once outline-specific evidence packets exist, they replace the legacy
  // generic section-1/section-2 citation plan for coverage accounting. The
  // final validator still checks packet/ledger provenance separately.
  const evidenceCoverage = await readIfExists(path.join(workspaceDir, "evidence", "coverage.json"));
  return {
    literatureQuality: computeLiteratureQuality(sources),
    citationVerification: computeCitationVerification(sources, evidenceCoverage ? [] : citationPlan, chapters, bibliography),
  };
}

export function researchAssessmentToMarkdown(assessment: ResearchAssessment): string {
  const lines = [
    "# LongWrite Research Assessment",
    "",
    `Literature quality score: ${assessment.literatureQuality.score}/10`,
    `Citation verification: ${assessment.citationVerification.pass ? "pass" : "fail"}`,
    "",
    "## Literature Quality",
    "",
  ];
  for (const dimension of assessment.literatureQuality.dimensions) {
    lines.push(`- ${dimension.id}: ${dimension.score}/10 — ${dimension.rationale}`);
  }
  lines.push("", "## Citation Verification", "");
  if (assessment.citationVerification.findings.length === 0) {
    lines.push("- No findings.");
  } else {
    for (const finding of assessment.citationVerification.findings) lines.push(`- ${finding}`);
  }
  lines.push("", "## Source Upgrade Candidates", "");
  if (assessment.literatureQuality.upgradeCandidates.length === 0) {
    lines.push("- No upgrade candidates.");
  } else {
    for (const candidate of assessment.literatureQuality.upgradeCandidates) {
      lines.push(`- ${candidate.sourceId}: ${candidate.reason} ${candidate.title}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function writeResearchAssessment(workspaceDir: string, assessment: ResearchAssessment): Promise<string[]> {
  await fs.mkdir(path.join(workspaceDir, "reports"), { recursive: true });
  await fs.mkdir(path.join(workspaceDir, "sources"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, REPORT_JSON), `${JSON.stringify(assessment, null, 2)}\n`, "utf-8");
  await fs.writeFile(path.join(workspaceDir, REPORT_MD), researchAssessmentToMarkdown(assessment), "utf-8");
  await fs.writeFile(
    path.join(workspaceDir, UPGRADE_JSONL),
    assessment.literatureQuality.upgradeCandidates.map((entry) => JSON.stringify(entry)).join("\n") +
      (assessment.literatureQuality.upgradeCandidates.length > 0 ? "\n" : ""),
    "utf-8",
  );
  return [REPORT_JSON, REPORT_MD, UPGRADE_JSONL];
}
