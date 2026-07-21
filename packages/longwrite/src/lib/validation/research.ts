import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { parseJsonl } from "../research/jsonl.js";
import type { CitationPlanEntry, ClassifiedSource } from "../research/types.js";
import { computeCitationVerification, computeLiteratureQuality } from "../ops/research-quality.js";
import { validateEvidenceLedger } from "../research/evidence.js";
import { citationMarkers } from "../research/citation-markers.js";
import { sourceMatchesTaxonomy } from "../research/evidence.js";
import { loadProjectConfig } from "../project-config.js";
import { paperProfile } from "../paper-profiles.js";
import { validateImportedExperiment } from "../research/experiment.js";
import { validateLatexWorkspace } from "./latex.js";
import { validateFigureWorkspace } from "./figures.js";
import { countWords } from "../ops/word-metrics.js";
import { codebaseMarkerIds, loadCodebaseManifest } from "../research/codebase-contract.js";
import { CodebaseComparisonPacket, validateCodebaseComparison } from "../research/codebase-comparison.js";

const execFile = promisify(execFileCallback);

export type ValidationCheck = {
  id: string;
  pass: boolean;
  findings: string[];
};

export type ValidationReport = {
  pass: boolean;
  checks: ValidationCheck[];
};

function isFullResearchMode(mode: string | undefined): boolean {
  return mode === "auto_research_agentic";
}

async function readIfExists(absPath: string): Promise<string | null> {
  try {
    return await fs.readFile(absPath, "utf-8");
  } catch {
    return null;
  }
}

async function statIfExists(absPath: string): Promise<{ size: number } | null> {
  try {
    return await fs.stat(absPath);
  } catch {
    return null;
  }
}

async function jsonIfExists(absPath: string): Promise<Record<string, unknown> | null> {
  const content = await readIfExists(absPath);
  if (content === null) return null;
  try {
    const parsed = JSON.parse(content);
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function readJsonlFile<T>(workspaceDir: string, rel: string): Promise<{ rows: T[]; error?: string }> {
  const content = await readIfExists(path.join(workspaceDir, rel));
  if (content === null) return { rows: [], error: `${rel} is missing` };
  try {
    return { rows: parseJsonl<T>(content) };
  } catch (err) {
    return { rows: [], error: `${rel} is not parseable JSONL: ${err instanceof Error ? err.message : String(err)}` };
  }
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

function markers(content: string): string[] {
  return citationMarkers(content).map((marker) => marker.sourceId);
}

function citedSourceIds(chapters: Array<{ rel: string; content: string }>): Set<string> {
  return new Set(chapters.flatMap((chapter) => markers(chapter.content)));
}

/** Codebases are separately pinned software artifacts. They are deliberately
 * not mixed into source/LQS/cited-literature calculations. */
async function checkCodebaseEvidence(
  workspaceDir: string,
  chapters: Array<{ rel: string; content: string }>,
): Promise<ValidationCheck> {
  const config = await loadProjectConfig(workspaceDir).catch(() => null);
  if (!config) return { id: "codebase_evidence", pass: true, findings: ["project configuration is unavailable"] };
  const requiresCodebase = config.research.codebases.length > 0 || config.research.codebase_discovery.enabled;
  if (!requiresCodebase) return { id: "codebase_evidence", pass: true, findings: ["no codebase inputs are configured"] };
  let manifest;
  try {
    manifest = await loadCodebaseManifest(workspaceDir);
  } catch (error) {
    return { id: "codebase_evidence", pass: false, findings: [error instanceof Error ? error.message : "codebases/manifest.json is not valid pinned codebase metadata"] };
  }
  if (!manifest) return { id: "codebase_evidence", pass: false, findings: ["configured or discovered codebases require codebases/manifest.json; run longwrite research codebases ."] };
  const ids = new Set(manifest.codebases.map((record) => record.id));
  const citedCodebases = new Set(chapters.flatMap((chapter) => codebaseMarkerIds(chapter.content)));
  const findings: string[] = [];
  if (paperProfile(config.research.paper_profile).requiresCodebase && ids.size === 0) findings.push(`${config.research.paper_profile} requires at least one resolved pinned codebase snapshot`);
  for (const configured of config.research.codebases) if (!ids.has(configured.id)) findings.push(`configured codebase "${configured.id}" has no resolved pinned snapshot`);
  for (const record of manifest.codebases.filter((item) => item.role === "primary_artifact")) {
    if (!citedCodebases.has(record.id)) findings.push(`primary codebase "${record.id}" is not woven into chapter prose with a [codebase:${record.id}] locator`);
  }
  for (const chapter of chapters) for (const id of codebaseMarkerIds(chapter.content)) {
    if (!ids.has(id)) findings.push(`${chapter.rel} references unknown codebase id "${id}"`);
  }
  try {
    const packet = CodebaseComparisonPacket.parse(JSON.parse(await fs.readFile(path.join(workspaceDir, "evidence", "codebase-comparison.json"), "utf8")));
    await validateCodebaseComparison(workspaceDir, packet);
  } catch (error) {
    findings.push(`evidence/codebase-comparison.json is missing or invalid: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
  const unusedSupplementary = manifest.codebases.filter((item) => item.role === "supplementary_artifact" && !citedCodebases.has(item.id)).map((item) => item.id);
  const summary = `${ids.size} pinned codebase snapshot(s); primary=${manifest.codebases.filter((item) => item.role === "primary_artifact").length}; cited=${citedCodebases.size}; unused supplementary=${unusedSupplementary.join(", ") || "none"}; codebase citations are excluded from scholarly gates`;
  return { id: "codebase_evidence", pass: findings.length === 0, findings: findings.length ? [summary, ...findings] : [summary] };
}

/** Acceptance must be recoverable from provider metadata. A DOI alone is not
 * sufficient because it may identify a preprint or non-archival record. */
function isAcceptedSource(source: ClassifiedSource): boolean {
  const status = source.identity?.publication_status?.toLowerCase() ?? "";
  if (/(accepted|published|inproceedings|journal|proceedings)/.test(status)) return true;
  return Boolean(source.identifiers?.doi) && !/(arxiv|preprint|unknown)/i.test(source.venue);
}

function isArxivOnlySource(source: ClassifiedSource): boolean {
  return !source.identifiers?.doi && Boolean(source.identifiers?.arxiv_id);
}

function isWithinOneCalendarYear(source: ClassifiedSource): boolean {
  const age = new Date().getUTCFullYear() - source.year;
  return age >= 0 && age <= 1;
}

async function pdfPageCount(workspaceDir: string): Promise<number | null> {
  try {
    const { stdout } = await execFile("pdfinfo", [path.join(workspaceDir, "build", "manuscript.pdf")], { timeout: 10_000 });
    const match = stdout.match(/^Pages:\s+(\d+)\s*$/m);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** These gates deliberately inspect only sources actually cited in chapter
 * prose. Retrieval breadth remains covered by corpus_gates; a large unused
 * corpus cannot satisfy a paper's bibliography-quality contract. */
async function checkCitedLiteratureReleaseGates(
  workspaceDir: string,
  chapters: Array<{ rel: string; content: string }>,
  sources: ClassifiedSource[],
): Promise<ValidationCheck> {
  const config = await loadProjectConfig(workspaceDir).catch(() => null);
  if (!config || !isFullResearchMode(config.project.mode)) {
    return { id: "cited_literature_release_gates", pass: true, findings: ["not a full research release mode; cited-literature gates are informational"] };
  }
  const gates = config.research.release_gates;
  const enabled = gates.min_cited_sources > 0 || gates.min_citations_per_page > 0 || gates.min_cited_within_one_year_ratio > 0
    || gates.min_accepted_cited_ratio > 0 || gates.max_cited_arxiv_only_ratio < 1
    || gates.min_cited_ab_sources_per_taxonomy_cell > 0 || Object.values(gates.min_citation_depths_per_section).some((target) => target > 0);
  if (!enabled) return { id: "cited_literature_release_gates", pass: true, findings: ["no cited-literature release gates are configured"] };
  if (config.research.provider === "seed") return { id: "cited_literature_release_gates", pass: true, findings: ["seed provider: cited-literature release gates are informational"] };

  const byId = new Map(sources.map((source) => [source.id, source]));
  const cited = citedSourceIds(chapters);
  const citedSources = [...cited].map((id) => byId.get(id)).filter((source): source is ClassifiedSource => Boolean(source));
  const findings: string[] = [];
  if (citedSources.length < gates.min_cited_sources) {
    findings.push(`cited sources ${citedSources.length} is below configured minimum ${gates.min_cited_sources}`);
  }
  const accepted = citedSources.filter(isAcceptedSource).length;
  const acceptedRatio = accepted / Math.max(1, citedSources.length);
  const withinOneYear = citedSources.filter(isWithinOneCalendarYear).length;
  const withinOneYearRatio = withinOneYear / Math.max(1, citedSources.length);
  const arxivOnly = citedSources.filter(isArxivOnlySource).length;
  const arxivOnlyRatio = arxivOnly / Math.max(1, citedSources.length);
  if (withinOneYearRatio < gates.min_cited_within_one_year_ratio) {
    findings.push(`within-one-calendar-year cited-source ratio ${withinOneYearRatio.toFixed(3)} (${withinOneYear}/${citedSources.length}) is below configured ${gates.min_cited_within_one_year_ratio.toFixed(3)}`);
  }
  if (acceptedRatio < gates.min_accepted_cited_ratio) {
    findings.push(`accepted cited-source ratio ${acceptedRatio.toFixed(3)} (${accepted}/${citedSources.length}) is below configured ${gates.min_accepted_cited_ratio.toFixed(3)}`);
  }
  if (arxivOnlyRatio > gates.max_cited_arxiv_only_ratio) {
    findings.push(`arXiv-only cited-source ratio ${arxivOnlyRatio.toFixed(3)} (${arxivOnly}/${citedSources.length}) exceeds configured ${gates.max_cited_arxiv_only_ratio.toFixed(3)}`);
  }
  if (gates.min_citations_per_page > 0) {
    const pages = await pdfPageCount(workspaceDir);
    if (pages === null) {
      findings.push("cited sources per page cannot be checked because pdfinfo could not read build/manuscript.pdf");
    } else {
      const density = citedSources.length / Math.max(1, pages);
      if (density < gates.min_citations_per_page) findings.push(`cited-source density ${density.toFixed(2)} per page (${citedSources.length}/${pages}) is below configured ${gates.min_citations_per_page.toFixed(2)}`);
    }
  }
  for (const chapter of chapters) {
    const chapterSources = [...new Set(markers(chapter.content))].map((id) => byId.get(id)).filter((source): source is ClassifiedSource => Boolean(source));
    for (const depth of ["A", "B", "C"] as const) {
      const required = gates.min_citation_depths_per_section[depth];
      if (required === 0) continue;
      const found = chapterSources.filter((source) => source.citation_depth === depth).length;
      if (found < required) findings.push(`${chapter.rel} has ${found} ${depth}-depth cited sources; configured minimum is ${required}`);
    }
  }
  if (gates.min_cited_ab_sources_per_taxonomy_cell > 0) {
    for (const cell of config.research.taxonomy) {
      const found = citedSources.filter((source) => (source.citation_depth === "A" || source.citation_depth === "B") && sourceMatchesTaxonomy(source, cell)).length;
      if (found < gates.min_cited_ab_sources_per_taxonomy_cell) {
        findings.push(`taxonomy cell "${cell}" has ${found} woven A/B-depth sources; configured minimum is ${gates.min_cited_ab_sources_per_taxonomy_cell}`);
      }
    }
  }
  const pages = gates.min_citations_per_page > 0 ? await pdfPageCount(workspaceDir) : null;
  const summary = `cited=${citedSources.length}; within_1yr=${withinOneYear}/${citedSources.length}; accepted=${accepted}/${citedSources.length}; arxiv_only=${arxivOnly}/${citedSources.length}; pages=${pages ?? "not measured"}`;
  return { id: "cited_literature_release_gates", pass: findings.length === 0, findings: findings.length === 0 ? [summary] : [summary, ...findings] };
}

function sectionIdFromChapter(rel: string): string {
  return path.basename(rel, ".md");
}

function checkCitationMarkers(
  chapters: Array<{ rel: string; content: string }>,
  sourceIds: Set<string>,
): ValidationCheck {
  const findings: string[] = [];
  if (chapters.length === 0) {
    findings.push("citation_markers_present: no chapter Markdown files found in chapters/");
  }
  for (const chapter of chapters) {
    const ids = markers(chapter.content);
    if (ids.length === 0) {
      findings.push(`citation_markers_present: ${chapter.rel} has no [source:<id>] markers`);
    }
    for (const id of ids) {
      if (!sourceIds.has(id)) {
        findings.push(`citation_markers_present: ${chapter.rel} references unknown source id "${id}"`);
      }
    }
  }
  return { id: "citation_markers_present", pass: findings.length === 0, findings };
}

function checkSourceCoverage(
  chapters: Array<{ rel: string; content: string }>,
  citationPlan: CitationPlanEntry[],
  sourceIds: Set<string>,
): ValidationCheck {
  const findings: string[] = [];
  const planBySection = new Map(citationPlan.map((entry) => [entry.section_id, entry]));
  for (const entry of citationPlan) {
    for (const sourceId of entry.source_ids) {
      if (!sourceIds.has(sourceId)) {
        findings.push(`source_coverage: citation plan references unknown source id "${sourceId}"`);
      }
    }
  }
  for (const chapter of chapters) {
    const sectionId = sectionIdFromChapter(chapter.rel);
    const plan = planBySection.get(sectionId);
    if (!plan) continue;
    const used = new Set(markers(chapter.content));
    if (!plan.source_ids.some((id) => used.has(id))) {
      findings.push(`source_coverage: ${chapter.rel} does not cite any planned source for ${sectionId}`);
    }
  }
  return { id: "source_coverage", pass: findings.length === 0, findings };
}

function checkBibliography(
  bibliography: string | null,
  sources: ClassifiedSource[],
): ValidationCheck {
  const findings: string[] = [];
  if (bibliography === null || bibliography.trim().length === 0) {
    findings.push("bibliography_consistent: sources/bibliography.bib is missing or empty");
    return { id: "bibliography_consistent", pass: false, findings };
  }
  for (const source of sources) {
    if (!bibliography.includes(source.title)) {
      findings.push(`bibliography_consistent: bibliography is missing title "${source.title}"`);
    }
  }
  return { id: "bibliography_consistent", pass: findings.length === 0, findings };
}

async function checkManuscriptBuild(workspaceDir: string): Promise<ValidationCheck> {
  const rel = "build/manuscript.pdf";
  const stat = await statIfExists(path.join(workspaceDir, rel));
  const findings = stat === null || stat.size === 0
    ? [`manuscript_build: ${rel} is missing or empty`]
    : [];
  return { id: "manuscript_build", pass: findings.length === 0, findings };
}

function checkLiteratureQuality(sources: ClassifiedSource[]): ValidationCheck {
  const lqs = computeLiteratureQuality(sources);
  const findings = lqs.score >= 5
    ? []
    : [`literature_quality_score: score ${lqs.score}/10 is below the 5.0 alpha threshold`];
  return { id: "literature_quality_score", pass: findings.length === 0, findings };
}

function checkCitationVerification(
  sources: ClassifiedSource[],
  citationPlan: CitationPlanEntry[],
  chapters: Array<{ rel: string; content: string }>,
  bibliography: string | null,
): ValidationCheck {
  const verification = computeCitationVerification(sources, citationPlan, chapters, bibliography);
  return {
    id: "citation_verification",
    pass: verification.pass,
    findings: verification.findings.map((finding) => `citation_verification: ${finding}`),
  };
}

async function checkResearchPolicy(workspaceDir: string, sources: ClassifiedSource[]): Promise<ValidationCheck> {
  const findings: string[] = [];
  let config;
  try {
    config = await loadProjectConfig(workspaceDir);
  } catch {
    return { id: "research_policy", pass: true, findings: ["longwrite.yaml unavailable; policy check skipped"] };
  }
  const policy = config.research.source_policy;
  if (config.research.provider === "seed") {
    return { id: "research_policy", pass: true, findings: ["seed provider: live-source policy thresholds are informational"] };
  }
  const currentYear = new Date().getFullYear();
  const recentRatio = sources.filter((source) => source.year >= currentYear - 1).length / Math.max(1, sources.length);
  const verifiedRatio = sources.filter((source) => Boolean(source.identifiers?.doi || source.identifiers?.arxiv_id || source.identifiers?.semantic_scholar_id)).length / Math.max(1, sources.length);
  const arxivOnlyRatio = sources.filter((source) => source.source === "arxiv" && !source.identifiers?.doi).length / Math.max(1, sources.length);
  if (recentRatio < policy.min_recent_ratio) findings.push(`recent source ratio ${recentRatio.toFixed(2)} is below configured ${policy.min_recent_ratio.toFixed(2)}`);
  if (verifiedRatio < policy.min_verified_ratio) findings.push(`verified metadata ratio ${verifiedRatio.toFixed(2)} is below configured ${policy.min_verified_ratio.toFixed(2)}`);
  if (arxivOnlyRatio > policy.max_arxiv_only_ratio) findings.push(`arXiv-only ratio ${arxivOnlyRatio.toFixed(2)} exceeds configured ${policy.max_arxiv_only_ratio.toFixed(2)}`);
  return { id: "research_policy", pass: findings.length === 0, findings };
}

async function checkCitationUrlLiveness(
  workspaceDir: string,
  requireLiveUrls: boolean,
): Promise<ValidationCheck> {
  const result = await readJsonlFile<{ source_id?: string; status?: string; url?: string }>(
    workspaceDir,
    "sources/citation-verification.jsonl",
  );
  if (result.error) {
    return {
      id: "citation_url_liveness",
      pass: !requireLiveUrls,
      findings: requireLiveUrls
        ? ["citation_url_liveness: sources/citation-verification.jsonl is required when source_policy.require_live_urls is true"]
        : ["citation URL verification has not run; enable require_live_urls to make this a release gate"],
    };
  }
  const failures = result.rows.filter((entry) => entry.status !== "live" && entry.status !== "redirect");
  return {
    id: "citation_url_liveness",
    pass: !requireLiveUrls || failures.length === 0,
    findings: failures.length === 0
      ? [`${result.rows.length} cited source URL(s) verified live or redirected`]
      : failures.map((entry) => `citation URL for ${entry.source_id ?? "unknown source"} is ${entry.status ?? "unknown"}: ${entry.url ?? "no URL"}`),
  };
}

function checkEvidenceCitationIntegrity(
  chapters: Array<{ rel: string; content: string }>,
  sourceIds: Set<string>,
): ValidationCheck {
  const findings: string[] = [];
  for (const chapter of chapters) {
    const ids = markers(chapter.content);
    if (ids.length === 0) findings.push(`${chapter.rel} has no [source:<id>] markers.`);
    for (const id of ids) {
      if (!sourceIds.has(id)) findings.push(`${chapter.rel} cites unknown source id "${id}".`);
    }
  }
  return { id: "citation_verification", pass: findings.length === 0, findings };
}

async function checkEvidenceCoverage(workspaceDir: string): Promise<ValidationCheck> {
  const coverage = await jsonIfExists(path.join(workspaceDir, "evidence", "coverage.json"));
  if (coverage === null) return { id: "evidence_coverage", pass: true, findings: ["evidence/coverage.json not present; evidence allocation has not run"] };
  const rows = Array.isArray(coverage.taxonomy) ? coverage.taxonomy as Array<Record<string, unknown>> : [];
  const findings = rows
    .filter((row) => typeof row.source_count !== "number" || row.source_count < 2)
    .map((row) => `taxonomy coverage for "${String(row.cell ?? "unknown")}" has ${String(row.source_count ?? 0)} sources; minimum is 2`);
  return { id: "evidence_coverage", pass: findings.length === 0, findings };
}

async function checkDirectTaxonomyCoverage(workspaceDir: string, provider?: string): Promise<ValidationCheck> {
  if (provider === undefined || provider === "seed") return { id: "taxonomy_direct_evidence", pass: true, findings: ["source provider unavailable or seed: A/B-depth taxonomy target is informational"] };
  const coverage = await jsonIfExists(path.join(workspaceDir, "evidence", "coverage.json"));
  if (coverage === null) return { id: "taxonomy_direct_evidence", pass: false, findings: ["evidence/coverage.json is required for a live research release"] };
  const rows = Array.isArray(coverage.taxonomy) ? coverage.taxonomy as Array<Record<string, unknown>> : [];
  const findings = rows
    .filter((row) => typeof row.direct_source_count !== "number" || row.direct_source_count < 2)
    .map((row) => `taxonomy cell "${String(row.cell ?? "unknown")}" has ${String(row.direct_source_count ?? 0)} A/B-depth sources; minimum is 2`);
  return { id: "taxonomy_direct_evidence", pass: findings.length === 0, findings };
}

async function checkReviewTarget(workspaceDir: string): Promise<ValidationCheck> {
  const scorecard = await statIfExists(path.join(workspaceDir, "reviews", "scorecard.json"));
  if (scorecard === null) return { id: "review_target", pass: true, findings: ["no scorecard found; review target check skipped"] };
  const metrics = await jsonIfExists(path.join(workspaceDir, "reports", "metrics.json"));
  const score = metrics?.review_score;
  if (typeof score !== "number") return { id: "review_target", pass: false, findings: ["reports/metrics.json must contain numeric review_score after a scorecard review"] };
  return {
    id: "review_target",
    pass: score >= 8,
    findings: score >= 8 ? [] : [`review_score ${score.toFixed(1)} is below the research release target 8.0`],
  };
}

async function checkEmpiricalExperiment(workspaceDir: string): Promise<ValidationCheck> {
  const config = await loadProjectConfig(workspaceDir).catch(() => null);
  if (!config || config.research.paper_kind !== "empirical") {
    return { id: "empirical_experiment", pass: true, findings: ["survey paper: empirical experiment gate is not applicable"] };
  }
  const experiment = config.research.experiment;
  if (!experiment.enabled) return { id: "empirical_experiment", pass: false, findings: ["empirical paper requires research.experiment.enabled=true; do not claim experimental validation without an audited results artifact"] };
  if (experiment.manifest_path) {
    const result = await validateImportedExperiment(workspaceDir);
    return { id: "empirical_experiment", pass: result.pass, findings: [result.finding] };
  }
  const raw = await jsonIfExists(path.join(workspaceDir, experiment.results_path));
  if (raw === null) return { id: "empirical_experiment", pass: false, findings: [`empirical paper requires ${experiment.results_path} with hypothesis, trials, results, and statistical_test`] };
  const trials = raw.trials;
  const results = raw.results;
  const valid = typeof raw.hypothesis === "string" && raw.hypothesis.trim().length > 0
    && typeof trials === "number" && Number.isInteger(trials) && trials >= experiment.min_trials
    && Array.isArray(results) && results.length > 0
    && typeof raw.statistical_test === "string" && raw.statistical_test.trim().length > 0;
  return {
    id: "empirical_experiment",
    pass: valid,
    findings: valid ? [`audited experiment contract passed with ${trials} trials`] : [`${experiment.results_path} must include non-empty hypothesis/results/statistical_test and trials >= ${experiment.min_trials}`],
  };
}

/** A configured full-paper target is a release contract, not merely a display
 * hint. The lower bound allows normal count variance while preventing a
 * short scaffold from being labelled a successful full manuscript. */
async function checkTargetLength(
  workspaceDir: string,
  chapters: Array<{ rel: string; content: string }>,
): Promise<ValidationCheck> {
  const config = await loadProjectConfig(workspaceDir).catch(() => null);
  const target = config?.writing.target_length_words;
  if (!isFullResearchMode(config?.project.mode) || !target) {
    return { id: "target_length", pass: true, findings: ["target length is informational outside the full research release modes"] };
  }
  const total = chapters.reduce((sum, chapter) => sum + countWords(chapter.content), 0);
  const minimum = Math.ceil(target * 0.8);
  return {
    id: "target_length",
    pass: total >= minimum,
    findings: total >= minimum
      ? [`${total} chapter words meets the full-release minimum ${minimum} for the ${target}-word target`]
      : [`${total} chapter words is below the full-release minimum ${minimum} for the ${target}-word target; expand evidence-backed prose before release`],
  };
}

/** No prior-resolved weakness category may reappear in the final review round
 *  (AutoResearch Gate 5). review_regressions is written by the scorecard scorer. */
async function checkReviewRegressions(workspaceDir: string): Promise<ValidationCheck> {
  const scorecard = await statIfExists(path.join(workspaceDir, "reviews", "scorecard.json"));
  if (scorecard === null) return { id: "review_no_regressions", pass: true, findings: ["no scorecard found; regression check skipped"] };
  const metrics = await jsonIfExists(path.join(workspaceDir, "reports", "metrics.json"));
  const regressions = typeof metrics?.review_regressions === "number" ? metrics.review_regressions : 0;
  return {
    id: "review_no_regressions",
    pass: regressions === 0,
    findings: regressions === 0 ? [] : [`${regressions} previously-resolved weakness categor${regressions === 1 ? "y" : "ies"} reappeared (see reports/regressions.md)`],
  };
}

async function checkClaimSupport(workspaceDir: string): Promise<ValidationCheck> {
  const judgments = await statIfExists(path.join(workspaceDir, "reviews", "claim-judgments.jsonl"));
  if (judgments === null) return { id: "claim_support", pass: true, findings: ["no claim judgments found; claim gate check skipped"] };
  const metrics = await jsonIfExists(path.join(workspaceDir, "reports", "metrics.json"));
  const rate = metrics?.claim_support_rate;
  if (typeof rate !== "number") return { id: "claim_support", pass: false, findings: ["reports/metrics.json must contain claim_support_rate after claim judgments"] };
  return {
    id: "claim_support",
    pass: rate >= 0.9,
    findings: rate >= 0.9 ? [] : [`claim_support_rate ${rate.toFixed(3)} is below the release target 0.900`],
  };
}

async function checkPublicationArtifacts(workspaceDir: string): Promise<ValidationCheck[]> {
  const main = await statIfExists(path.join(workspaceDir, "paper", "main.tex"));
  const manifest = await statIfExists(path.join(workspaceDir, "figures", "manifest.json"));
  if (main === null && manifest === null) {
    return [{ id: "publication_artifact_contract", pass: true, findings: ["paper/ and figures/ artifacts absent; publication rendering checks skipped"] }];
  }
  const [latex, figures] = await Promise.all([validateLatexWorkspace(workspaceDir), validateFigureWorkspace(workspaceDir)]);
  return [
    { id: "publication_latex", pass: latex.pass, findings: latex.checks.flatMap((check) => check.findings) },
    { id: "publication_figures", pass: figures.pass, findings: figures.checks.flatMap((check) => check.findings) },
  ];
}

async function checkFullResearchContracts(workspaceDir: string): Promise<ValidationCheck[]> {
  const config = await loadProjectConfig(workspaceDir).catch(() => null);
  if (!isFullResearchMode(config?.project.mode)) {
    return [{ id: "full_research_contracts", pass: true, findings: ["not a full research release mode; full contract gates are informational"] }];
  }
  const requireJsonPass = async (id: string, rel: string): Promise<ValidationCheck> => {
    const parsed = await jsonIfExists(path.join(workspaceDir, rel));
    if (parsed === null) return { id, pass: false, findings: [`${id}: ${rel} is missing or invalid`] };
    if (parsed.pass !== true) return { id, pass: false, findings: [`${id}: ${rel} did not pass`] };
    return { id, pass: true, findings: [] };
  };
  const identity = await readJsonlFile<Record<string, unknown>>(workspaceDir, "sources/source-identities.jsonl");
  const identityFailures = identity.error
    ? [identity.error]
    : identity.rows
      .filter((row) => !row.canonical_url || (!row.doi && !row.arxiv_id && !row.semantic_scholar_id && !row.openalex_id))
      .map((row) => `source identity for ${String(row.source_id ?? "unknown")} lacks canonical URL or strong identifier`);
  const metrics = await jsonIfExists(path.join(workspaceDir, "reports", "metrics.json"));
  const doubleReviewed = typeof metrics?.claim_samples_double_reviewed === "number" ? metrics.claim_samples_double_reviewed : 0;
  const disagreements = typeof metrics?.claim_review_disagreements === "number" ? metrics.claim_review_disagreements : 0;
  return [
    await requireJsonPass("full_corpus_gates", "reports/corpus-gates.json"),
    await requireJsonPass("full_survey_contract", "reports/survey-contract.json"),
    { id: "full_source_identity", pass: identityFailures.length === 0, findings: identityFailures },
    {
      id: "full_claim_double_review",
      pass: doubleReviewed > 0 && disagreements === 0,
      findings: doubleReviewed > 0 && disagreements === 0
        ? []
        : [`claim double review requires at least one double-reviewed sample and zero disagreements; got double_reviewed=${doubleReviewed}, disagreements=${disagreements}`],
    },
  ];
}

export function validationReportToMarkdown(report: ValidationReport): string {
  const lines = [
    "# LongWrite Validation Report",
    "",
    `Status: ${report.pass ? "pass" : "fail"}`,
    "",
  ];
  for (const check of report.checks) {
    lines.push(`## ${check.id}`, "", `Status: ${check.pass ? "pass" : "fail"}`, "");
    if (check.findings.length === 0) {
      lines.push("- No findings.", "");
    } else {
      for (const finding of check.findings) lines.push(`- ${finding}`);
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function validateResearchWorkspace(workspaceDir: string): Promise<ValidationReport> {
  const sourceResult = await readJsonlFile<ClassifiedSource>(workspaceDir, "sources/classified_sources.jsonl");
  const planResult = await readJsonlFile<CitationPlanEntry>(workspaceDir, "sources/citation_plan.jsonl");
  const bibliography = await readIfExists(path.join(workspaceDir, "sources/bibliography.bib"));
  const chapters = await chapterFiles(workspaceDir);
  const sources = sourceResult.rows;
  const sourceIds = new Set(sources.map((source) => source.id));
  const setupFindings = [sourceResult.error, planResult.error].filter((finding): finding is string => Boolean(finding));

  let configuredProvider: string | undefined;
  let requireLiveUrls = false;
  try {
    const config = await loadProjectConfig(workspaceDir);
    configuredProvider = config.research.provider;
    requireLiveUrls = config.research.source_policy.require_live_urls;
  } catch {
    configuredProvider = undefined;
  }
  const evidenceManifest = await statIfExists(path.join(workspaceDir, "evidence", "manifest.json"));
  const evidenceEnabled = evidenceManifest !== null;
  const evidenceChecks: ValidationCheck[] = evidenceEnabled
    ? [
        await checkEvidenceCoverage(workspaceDir),
        { id: "citation_evidence_ledger", ...(await validateEvidenceLedger(workspaceDir, { allowMetadataOnly: configuredProvider === "seed" })) },
      ]
    : [];
  const checks: ValidationCheck[] = [
    { id: "research_artifacts_present", pass: setupFindings.length === 0, findings: setupFindings },
    checkCitationMarkers(chapters, sourceIds),
    evidenceEnabled
      ? { id: "source_coverage", pass: true, findings: ["outline-specific evidence packets supersede the legacy generic citation plan"] }
      : checkSourceCoverage(chapters, planResult.rows, sourceIds),
    checkBibliography(bibliography, sources),
    configuredProvider === "seed"
      ? { id: "literature_quality_score", pass: true, findings: ["seed provider: LQS is informational"] }
      : checkLiteratureQuality(sources),
    evidenceEnabled
      ? checkEvidenceCitationIntegrity(chapters, sourceIds)
      : checkCitationVerification(sources, planResult.rows, chapters, bibliography),
    await checkResearchPolicy(workspaceDir, sources),
    await checkCitedLiteratureReleaseGates(workspaceDir, chapters, sources),
    await checkCitationUrlLiveness(workspaceDir, requireLiveUrls),
    await checkCodebaseEvidence(workspaceDir, chapters),
    ...evidenceChecks,
    await checkDirectTaxonomyCoverage(workspaceDir, configuredProvider),
    await checkTargetLength(workspaceDir, chapters),
    await checkReviewTarget(workspaceDir),
    await checkEmpiricalExperiment(workspaceDir),
    await checkReviewRegressions(workspaceDir),
    await checkClaimSupport(workspaceDir),
    ...(await checkFullResearchContracts(workspaceDir)),
    ...(await checkPublicationArtifacts(workspaceDir)),
    await checkManuscriptBuild(workspaceDir),
  ];
  return { pass: checks.every((check) => check.pass), checks };
}

export async function writeValidationReport(workspaceDir: string, report: ValidationReport): Promise<string[]> {
  const reportsDir = path.join(workspaceDir, "reports");
  await fs.mkdir(reportsDir, { recursive: true });
  const jsonRel = "reports/longwrite-validation.json";
  const markdownRel = "reports/longwrite-validation.md";
  await fs.writeFile(path.join(workspaceDir, jsonRel), `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  await fs.writeFile(path.join(workspaceDir, markdownRel), validationReportToMarkdown(report), "utf-8");
  return [jsonRel, markdownRel];
}
