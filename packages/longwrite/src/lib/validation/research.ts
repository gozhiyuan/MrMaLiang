import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { parseJsonl } from "../research/jsonl.js";
import type { CitationPlanEntry, ClassifiedSource } from "../research/types.js";
import { bibtexKey, bibtexKeys } from "../research/bibtex.js";
import { computeCitationVerification, computeLiteratureQuality } from "../ops/research-quality.js";
import { validateEvidenceLedger } from "../research/evidence.js";
import { citationMarkers } from "../research/citation-markers.js";
import { sourceMatchesTaxonomy } from "../research/taxonomy.js";
import { loadProjectConfig } from "../project-config.js";
import { EDITABLE_KIND_PATHS, OPERATOR_TARGET_KINDS, gateId, slugify, type ArtifactKind, type RequiredEffect } from "../registry/ids.js";
import { FindingSchema, type Finding, type StructuredCheck } from "../registry/records.js";
import { GLOBAL_SCOPE, scopeKey } from "../registry/scope.js";
import { paperProfile } from "../paper-profiles.js";
import { validateImportedExperiment } from "../research/experiment.js";
import { validateLatexWorkspace } from "./latex.js";
import { validateFigureWorkspace } from "./figures.js";
import { countWords } from "../ops/word-metrics.js";
import { codebaseMarkerIds, loadCodebaseManifest } from "../research/codebase-contract.js";
import { CodebaseComparisonPacket, validateCodebaseComparison } from "../research/codebase-comparison.js";
import { checkVisualReviewReleaseGate } from "../ops/visual-review.js";
import { computeRedundancy } from "../research/redundancy.js";
import { detectContradictions, type ClaimJudgment } from "../research/contradiction.js";
import { ClaimJudgment as ClaimJudgmentSchema } from "../ops/claim-gate.js";
import { LandmarkCandidates, matchLandmarksToCorpus, computeLandmarkCoverage } from "../research/landmark.js";

const execFile = promisify(execFileCallback);

/** A check now carries findings the kernel can route. The prose each one used
 * to be survives as `diagnostic`, which is for operators and is never parsed. */
export type ValidationCheck = StructuredCheck;

export type ValidationReport = {
  pass: boolean;
  checks: ValidationCheck[];
};

/** Builds a finding for a gate declared by this module's own PRODUCER.
 *
 * The (kind, effect) pair is always passed explicitly. There is no default:
 * a gate acquiring a new failure mode must say how it is repaired, and
 * tests/routing-coverage.test.ts fails if it emits a triple it never
 * declared. */
function rFinding(args: {
  gate: string;
  kind: ArtifactKind;
  effect: RequiredEffect;
  subject: string;
  diagnostic: string;
  path?: string;
  location?: string;
  scope?: string;
  severity?: "minor" | "major" | "critical";
}): Finding {
  const fallback = EDITABLE_KIND_PATHS[args.kind][0];
  return FindingSchema.parse({
    id: `${args.gate}-${args.subject}`.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+/, "") || "finding",
    gate_id: args.gate,
    artifact: OPERATOR_TARGET_KINDS.includes(args.kind)
      ? { kind: args.kind, target: args.subject }
      : { kind: args.kind, path: args.path ?? fallback, artifact_id: args.subject },
    ...(args.location === undefined ? {} : { location: args.location }),
    objective_scope_key: args.scope ?? GLOBAL_SCOPE,
    required_effect: args.effect,
    severity: args.severity ?? "major",
    diagnostic: args.diagnostic,
  });
}

/** A check that passed, or one whose gate does not apply to this workspace.
 * Its prose is informational and has nothing to route. */
function note(gate: string, pass: boolean, diagnostic: string): ValidationCheck {
  return { id: gateId(gate), pass, findings: [], measurements: [], requires_diagnosis: false, diagnostic };
}

function checkOf(gate: string, findings: Finding[], diagnostic?: string): ValidationCheck {
  return {
    id: gateId(gate), pass: findings.length === 0, findings, measurements: [],
    requires_diagnosis: false, ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

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

export async function chapterFiles(workspaceDir: string): Promise<Array<{ rel: string; content: string }>> {
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

export function citedSourceIds(chapters: Array<{ rel: string; content: string }>): Set<string> {
  return new Set(chapters.flatMap((chapter) => markers(chapter.content)));
}

/** Codebases are separately pinned software artifacts. They are deliberately
 * not mixed into source/LQS/cited-literature calculations. */
async function checkCodebaseEvidence(
  workspaceDir: string,
  chapters: Array<{ rel: string; content: string }>,
): Promise<ValidationCheck> {
  const GATE = "codebase_evidence";
  const fail = (subject: string, diagnostic: string): Finding => rFinding({
    gate: GATE, kind: "evidence_packet", effect: "acquire_additional_evidence", subject, diagnostic });
  const config = await loadProjectConfig(workspaceDir).catch(() => null);
  if (!config) return note(GATE, true, "project configuration is unavailable");
  const requiresCodebase = config.research.codebases.length > 0 || config.research.codebase_discovery.enabled;
  if (!requiresCodebase) return note(GATE, true, "no codebase inputs are configured");
  let manifest;
  try {
    manifest = await loadCodebaseManifest(workspaceDir);
  } catch (error) {
    return checkOf(GATE, [fail("manifest", error instanceof Error ? error.message : "codebases/manifest.json is not valid pinned codebase metadata")]);
  }
  if (!manifest) return checkOf(GATE, [fail("manifest", "configured or discovered codebases require codebases/manifest.json; run longwrite research codebases .")]);
  const ids = new Set(manifest.codebases.map((record) => record.id));
  const citedCodebases = new Set(chapters.flatMap((chapter) => codebaseMarkerIds(chapter.content)));
  const findings: Finding[] = [];
  if (paperProfile(config.research.paper_profile).requiresCodebase && ids.size === 0) findings.push(fail("snapshot", `${config.research.paper_profile} requires at least one resolved pinned codebase snapshot`));
  for (const configured of config.research.codebases) if (!ids.has(configured.id)) findings.push(fail(configured.id, `configured codebase "${configured.id}" has no resolved pinned snapshot`));
  for (const record of manifest.codebases.filter((item) => item.role === "primary_artifact")) {
    // A primary artifact nobody cites is missing from the argument, which is
    // an evidence gap rather than a prose defect.
    if (!citedCodebases.has(record.id)) findings.push(fail(record.id, `primary codebase "${record.id}" is not woven into chapter prose with a [codebase:${record.id}] locator`));
  }
  for (const chapter of chapters) for (const id of codebaseMarkerIds(chapter.content)) {
    if (!ids.has(id)) findings.push(fail(id, `${chapter.rel} references unknown codebase id "${id}"`));
  }
  try {
    const packet = CodebaseComparisonPacket.parse(JSON.parse(await fs.readFile(path.join(workspaceDir, "evidence", "codebase-comparison.json"), "utf8")));
    await validateCodebaseComparison(workspaceDir, packet);
  } catch (error) {
    findings.push(fail("comparison", `evidence/codebase-comparison.json is missing or invalid: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`));
  }
  const unusedSupplementary = manifest.codebases.filter((item) => item.role === "supplementary_artifact" && !citedCodebases.has(item.id)).map((item) => item.id);
  const summary = `${ids.size} pinned codebase snapshot(s); primary=${manifest.codebases.filter((item) => item.role === "primary_artifact").length}; cited=${citedCodebases.size}; unused supplementary=${unusedSupplementary.join(", ") || "none"}; codebase citations are excluded from scholarly gates`;
  return checkOf(GATE, findings, summary);
}

/** Acceptance must be recoverable from provider metadata. A DOI alone is not
 * sufficient because it may identify a preprint or non-archival record. */
export function isAcceptedSource(source: ClassifiedSource): boolean {
  const status = source.identity?.publication_status?.toLowerCase() ?? "";
  if (/(accepted|published|inproceedings|journal|proceedings)/.test(status)) return true;
  return Boolean(source.identifiers?.doi) && !/(arxiv|preprint|unknown)/i.test(source.venue);
}

export function isArxivOnlySource(source: ClassifiedSource): boolean {
  return !source.identifiers?.doi && Boolean(source.identifiers?.arxiv_id);
}

/** `asOf` is explicit rather than read from the wall clock, so a measurement
 * taken today and the same measurement replayed next year agree. Reading
 * `new Date()` here made the result depend on when it happened to run. */
export function isWithinOneCalendarYear(source: ClassifiedSource, asOf: string): boolean {
  const age = new Date(asOf).getUTCFullYear() - source.year;
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
  asOfDate: string,
): Promise<ValidationCheck> {
  const GATE = "cited_literature_release_gates";
  // Too few or too weak cited sources is a corpus problem; a section short on
  // depth is a prose problem, because the sources exist and are simply not
  // woven in. Two different repairs, so two different triples.
  const corpus = (subject: string, diagnostic: string): Finding => rFinding({
    gate: GATE, kind: "corpus", effect: "upgrade_source_quality", subject, diagnostic });
  const prose = (subject: string, diagnostic: string, chapterPath?: string): Finding => rFinding({
    gate: GATE, kind: "chapter_prose", effect: "add_supporting_citation", subject, diagnostic,
    ...(chapterPath === undefined ? {} : { path: chapterPath }) });
  const config = await loadProjectConfig(workspaceDir).catch(() => null);
  if (!config || !isFullResearchMode(config.project.mode)) {
    return note(GATE, true, "not a full research release mode; cited-literature gates are informational");
  }
  const gates = config.research.release_gates;
  const enabled = gates.min_cited_sources > 0 || gates.min_citations_per_page > 0 || gates.min_cited_within_one_year_ratio > 0
    || gates.min_accepted_cited_ratio > 0 || gates.max_cited_arxiv_only_ratio < 1
    || gates.min_cited_ab_sources_per_taxonomy_cell > 0 || Object.values(gates.min_citation_depths_per_section).some((target) => target > 0);
  if (!enabled) return note(GATE, true, "no cited-literature release gates are configured");
  if (config.research.provider === "seed") return note(GATE, true, "seed provider: cited-literature release gates are informational");

  const byId = new Map(sources.map((source) => [source.id, source]));
  const cited = citedSourceIds(chapters);
  const citedSources = [...cited].map((id) => byId.get(id)).filter((source): source is ClassifiedSource => Boolean(source));
  const findings: Finding[] = [];
  if (citedSources.length < gates.min_cited_sources) {
    findings.push(corpus("cited-count", `cited sources ${citedSources.length} is below configured minimum ${gates.min_cited_sources}`));
  }
  const accepted = citedSources.filter(isAcceptedSource).length;
  const acceptedRatio = accepted / Math.max(1, citedSources.length);
  const withinOneYear = citedSources.filter((source) => isWithinOneCalendarYear(source, asOfDate)).length;
  const withinOneYearRatio = withinOneYear / Math.max(1, citedSources.length);
  const arxivOnly = citedSources.filter(isArxivOnlySource).length;
  const arxivOnlyRatio = arxivOnly / Math.max(1, citedSources.length);
  if (withinOneYearRatio < gates.min_cited_within_one_year_ratio) {
    findings.push(corpus("recency", `within-one-calendar-year cited-source ratio ${withinOneYearRatio.toFixed(3)} (${withinOneYear}/${citedSources.length}) is below configured ${gates.min_cited_within_one_year_ratio.toFixed(3)}`));
  }
  if (acceptedRatio < gates.min_accepted_cited_ratio) {
    findings.push(corpus("acceptance", `accepted cited-source ratio ${acceptedRatio.toFixed(3)} (${accepted}/${citedSources.length}) is below configured ${gates.min_accepted_cited_ratio.toFixed(3)}`));
  }
  if (arxivOnlyRatio > gates.max_cited_arxiv_only_ratio) {
    findings.push(corpus("venue-mix", `arXiv-only cited-source ratio ${arxivOnlyRatio.toFixed(3)} (${arxivOnly}/${citedSources.length}) exceeds configured ${gates.max_cited_arxiv_only_ratio.toFixed(3)}`));
  }
  if (gates.min_citations_per_page > 0) {
    const pages = await pdfPageCount(workspaceDir);
    if (pages === null) {
      findings.push(prose("citation-density", "cited sources per page cannot be checked because pdfinfo could not read build/manuscript.pdf"));
    } else {
      // This gate is explicitly configured as *citations* per page. Counting
      // unique bibliography entries here made a long paper require an
      // impossible number of distinct sources even when it cited its evidence
      // appropriately throughout the prose.
      const citationCount = chapters.reduce((total, chapter) => total + markers(chapter.content).length, 0);
      const density = citationCount / Math.max(1, pages);
      if (density < gates.min_citations_per_page) findings.push(prose("citation-density", `citation density ${density.toFixed(2)} per page (${citationCount}/${pages}) is below configured ${gates.min_citations_per_page.toFixed(2)}`));
    }
  }
  for (const chapter of chapters) {
    const chapterSources = [...new Set(markers(chapter.content))].map((id) => byId.get(id)).filter((source): source is ClassifiedSource => Boolean(source));
    for (const depth of ["A", "B", "C"] as const) {
      const required = gates.min_citation_depths_per_section[depth];
      if (required === 0) continue;
      const found = chapterSources.filter((source) => source.citation_depth === depth).length;
      if (found < required) findings.push(prose(`${sectionIdFromChapter(chapter.rel)}-${depth}`, `${chapter.rel} has ${found} ${depth}-depth cited sources; configured minimum is ${required}`, chapter.rel));
    }
  }
  if (gates.min_cited_ab_sources_per_taxonomy_cell > 0) {
    for (const cell of config.research.taxonomy) {
      const found = citedSources.filter((source) => (source.citation_depth === "A" || source.citation_depth === "B") && sourceMatchesTaxonomy(source, cell)).length;
      if (found < gates.min_cited_ab_sources_per_taxonomy_cell) {
        // The sources exist in the corpus; what is missing is their use in
        // prose, so this is a citation gap and not a retrieval one.
        findings.push(rFinding({
          gate: GATE, kind: "chapter_prose", effect: "add_supporting_citation",
          subject: `cell-${slugify(cell)}`, scope: scopeKey("taxonomy_cell", cell),
          diagnostic: `taxonomy cell "${cell}" has ${found} woven A/B-depth sources; configured minimum is ${gates.min_cited_ab_sources_per_taxonomy_cell}`,
        }));
      }
    }
  }
  const pages = gates.min_citations_per_page > 0 ? await pdfPageCount(workspaceDir) : null;
  const citationCount = chapters.reduce((total, chapter) => total + markers(chapter.content).length, 0);
  const citationDensity = pages === null ? undefined : citationCount / Math.max(1, pages);
  const summary = `cited=${citedSources.length}; citations=${citationCount}; citation_density=${citationDensity === undefined ? "not measured" : citationDensity.toFixed(2)}; within_1yr=${withinOneYear}/${citedSources.length}; accepted=${accepted}/${citedSources.length}; arxiv_only=${arxivOnly}/${citedSources.length}; pages=${pages ?? "not measured"}`;
  return checkOf(GATE, findings, summary);
}

function sectionIdFromChapter(rel: string): string {
  return path.basename(rel, ".md");
}

function checkCitationMarkers(
  chapters: Array<{ rel: string; content: string }>,
  sourceIds: Set<string>,
): ValidationCheck {
  const GATE = "citation_markers_present";
  const findings: Finding[] = [];
  const fail = (subject: string, diagnostic: string, chapterPath?: string) => findings.push(rFinding({
    gate: GATE, kind: "chapter_prose", effect: "repair_citation_marker", subject, diagnostic,
    ...(chapterPath === undefined ? {} : { path: chapterPath }) }));
  if (chapters.length === 0) {
    fail("chapters", "citation_markers_present: no chapter Markdown files found in chapters/");
  }
  for (const chapter of chapters) {
    const ids = markers(chapter.content);
    if (ids.length === 0) {
      fail(sectionIdFromChapter(chapter.rel), `citation_markers_present: ${chapter.rel} has no [source:<id>] markers`, chapter.rel);
    }
    for (const id of ids) {
      if (!sourceIds.has(id)) {
        fail(`${sectionIdFromChapter(chapter.rel)}-${id}`, `citation_markers_present: ${chapter.rel} references unknown source id "${id}"`, chapter.rel);
      }
    }
  }
  return checkOf(GATE, findings);
}

function checkSourceCoverage(
  chapters: Array<{ rel: string; content: string }>,
  citationPlan: CitationPlanEntry[],
  sourceIds: Set<string>,
): ValidationCheck {
  const GATE = "source_coverage";
  const findings: Finding[] = [];
  const fail = (subject: string, diagnostic: string) => findings.push(rFinding({
    gate: GATE, kind: "corpus", effect: "acquire_additional_evidence", subject, diagnostic }));
  const planBySection = new Map(citationPlan.map((entry) => [entry.section_id, entry]));
  for (const entry of citationPlan) {
    for (const sourceId of entry.source_ids) {
      if (!sourceIds.has(sourceId)) {
        fail(sourceId, `source_coverage: citation plan references unknown source id "${sourceId}"`);
      }
    }
  }
  for (const chapter of chapters) {
    const sectionId = sectionIdFromChapter(chapter.rel);
    const plan = planBySection.get(sectionId);
    if (!plan) continue;
    const used = new Set(markers(chapter.content));
    if (!plan.source_ids.some((id) => used.has(id))) {
      fail(sectionId, `source_coverage: ${chapter.rel} does not cite any planned source for ${sectionId}`);
    }
  }
  return checkOf(GATE, findings);
}

function checkBibliography(
  bibliography: string | null,
  sources: ClassifiedSource[],
): ValidationCheck {
  const GATE = "bibliography_consistent";
  const findings: Finding[] = [];
  const fail = (subject: string, diagnostic: string) => findings.push(rFinding({
    gate: GATE, kind: "bibliography", effect: "repair_bibliography_consistency", subject, diagnostic }));
  if (bibliography === null || bibliography.trim().length === 0) {
    fail("bibliography", "bibliography_consistent: sources/bibliography.bib is missing or empty");
    return checkOf(GATE, findings);
  }
  const keys = bibtexKeys(bibliography);
  for (const source of sources) {
    if (!keys.has(bibtexKey(source))) {
      fail(source.id, `bibliography_consistent: bibliography is missing source id "${source.id}"`);
    }
  }
  return checkOf(GATE, findings);
}

async function checkManuscriptBuild(workspaceDir: string): Promise<ValidationCheck> {
  const rel = "build/manuscript.pdf";
  const stat = await statIfExists(path.join(workspaceDir, rel));
  // An absent PDF is a build failure, and nothing this product owns installs a
  // LaTeX toolchain, so it goes to the operator rather than to a repair.
  const findings = stat === null || stat.size === 0
    ? [rFinding({ gate: "manuscript_build", kind: "toolchain", effect: "repair_toolchain",
        subject: "pdflatex", severity: "critical",
        diagnostic: `manuscript_build: ${rel} is missing or empty` })]
    : [];
  return checkOf("manuscript_build", findings);
}

function checkLiteratureQuality(sources: ClassifiedSource[]): ValidationCheck {
  const lqs = computeLiteratureQuality(sources);
  const findings = lqs.score >= 5
    ? []
    : [rFinding({ gate: "literature_quality_score", kind: "corpus", effect: "upgrade_source_quality",
        subject: "quality-score",
        diagnostic: `literature_quality_score: score ${lqs.score}/10 is below the 5.0 alpha threshold` })];
  return checkOf("literature_quality_score", findings);
}

function checkProseRedundancy(
  chapters: Array<{ rel: string; content: string }>,
  thresholds: { tracked_phrases: string[]; max_tracked_phrase_occurrences: number; repeated_ngram_size: number; max_repeated_ngram_occurrences: number },
): ValidationCheck {
  if (thresholds.max_tracked_phrase_occurrences < 0 && thresholds.max_repeated_ngram_occurrences < 0) {
    return note("prose_redundancy", true, "prose redundancy gate is not configured");
  }
  const report = computeRedundancy(chapters, {
    trackedPhrases: thresholds.tracked_phrases,
    maxTrackedOccurrences: thresholds.max_tracked_phrase_occurrences < 0 ? Number.MAX_SAFE_INTEGER : thresholds.max_tracked_phrase_occurrences,
    ngramSize: thresholds.repeated_ngram_size,
    maxNgramOccurrences: thresholds.max_repeated_ngram_occurrences < 0 ? Number.MAX_SAFE_INTEGER : thresholds.max_repeated_ngram_occurrences,
  });
  const trim = (subject: string, diagnostic: string): Finding => rFinding({
    gate: "prose_redundancy", kind: "chapter_prose", effect: "remove_redundant_prose", subject, diagnostic });
  const findings = [
    ...report.trackedPhraseOveruse.map((item, index) => trim(`phrase-${index}`, `prose_redundancy: phrase "${item.phrase}" appears ${item.count} times across ${item.sections.length} section(s) (${item.sections.join(", ")}); configured maximum is ${thresholds.max_tracked_phrase_occurrences}`)),
    ...report.repeatedNgramOveruse.map((item, index) => trim(`ngram-${index}`, `prose_redundancy: repeated phrase "${item.phrase}" appears ${item.count} times across ${item.sections.length} sections; configured maximum is ${thresholds.max_repeated_ngram_occurrences}`)),
  ];
  return checkOf("prose_redundancy", findings);
}

function checkCitationVerification(
  sources: ClassifiedSource[],
  citationPlan: CitationPlanEntry[],
  chapters: Array<{ rel: string; content: string }>,
  bibliography: string | null,
): ValidationCheck {
  const GATE = "citation_verification";
  const verification = computeCitationVerification(sources, citationPlan, chapters, bibliography);
  // Classified from the same inputs the report was computed from, never by
  // parsing its sentences. Three different defects hide behind one gate and
  // each has a different owner: prose that cites wrongly, a source record that
  // does not exist, and a bibliography that does not resolve.
  const findings: Finding[] = [];
  const sourceIds = new Set(sources.map((source) => source.id));
  const cited = new Set<string>();
  const prose = (subject: string, diagnostic: string, chapterPath?: string) => findings.push(rFinding({
    gate: GATE, kind: "chapter_prose", effect: "repair_citation_marker", subject, diagnostic,
    ...(chapterPath === undefined ? {} : { path: chapterPath }) }));
  if (chapters.length === 0) prose("chapters", "citation_verification: no chapter Markdown files found in chapters/");
  for (const chapter of chapters) {
    const ids = markers(chapter.content);
    const section = sectionIdFromChapter(chapter.rel);
    if (ids.length === 0) prose(section, `citation_verification: ${chapter.rel} has no [source:<id>] markers`, chapter.rel);
    for (const id of ids) {
      cited.add(id);
      if (!sourceIds.has(id)) prose(`${section}-${id}`, `citation_verification: ${chapter.rel} cites unknown source id "${id}"`, chapter.rel);
    }
    const planned = citationPlan.find((entry) => entry.section_id === section);
    if (planned && !planned.source_ids.some((id) => ids.includes(id))) {
      prose(`${section}-planned`, `citation_verification: ${chapter.rel} cites none of its planned sources (${planned.source_ids.join(", ")})`, chapter.rel);
    }
  }
  for (const id of new Set(citationPlan.flatMap((entry) => entry.source_ids))) {
    // A planned id with no record behind it is a metadata defect: the prose
    // cannot cite a source that was never classified.
    if (!sourceIds.has(id)) findings.push(rFinding({
      gate: GATE, kind: "source_record", effect: "repair_source_metadata", subject: id,
      diagnostic: `citation_verification: citation plan references unknown source id "${id}"` }));
    else if (!cited.has(id)) prose(`planned-${id}`, `citation_verification: planned source "${id}" is not cited in any chapter`);
  }
  const bib = (subject: string, diagnostic: string) => findings.push(rFinding({
    gate: GATE, kind: "bibliography", effect: "repair_bibliography_consistency", subject, diagnostic }));
  if (bibliography === null || bibliography.trim().length === 0) {
    bib("bibliography", "citation_verification: sources/bibliography.bib is missing or empty");
  } else {
    const keys = bibtexKeys(bibliography);
    for (const source of sources) {
      if (!keys.has(bibtexKey(source))) bib(source.id, `citation_verification: bibliography is missing source id "${source.id}"`);
    }
  }
  return {
    id: gateId(GATE), pass: verification.pass && findings.length === 0, findings,
    measurements: [], requires_diagnosis: false,
    diagnostic: `${verification.markerCount} marker(s); ${verification.citedSourceCount} cited source(s)`,
  };
}

async function checkResearchPolicy(workspaceDir: string, sources: ClassifiedSource[]): Promise<ValidationCheck> {
  const GATE = "research_policy";
  const findings: Finding[] = [];
  const fail = (subject: string, diagnostic: string) => findings.push(rFinding({
    gate: GATE, kind: "corpus", effect: "upgrade_source_quality", subject, diagnostic }));
  let config;
  try {
    config = await loadProjectConfig(workspaceDir);
  } catch {
    return note(GATE, true, "longwrite.yaml unavailable; policy check skipped");
  }
  const policy = config.research.source_policy;
  if (config.research.provider === "seed") {
    return note(GATE, true, "seed provider: live-source policy thresholds are informational");
  }
  const currentYear = new Date().getFullYear();
  const recentRatio = sources.filter((source) => source.year >= currentYear - 1).length / Math.max(1, sources.length);
  const verifiedRatio = sources.filter((source) => Boolean(source.identifiers?.doi || source.identifiers?.arxiv_id || source.identifiers?.semantic_scholar_id)).length / Math.max(1, sources.length);
  const arxivOnlyRatio = sources.filter((source) => source.source === "arxiv" && !source.identifiers?.doi).length / Math.max(1, sources.length);
  if (recentRatio < policy.min_recent_ratio) fail("recency", `recent source ratio ${recentRatio.toFixed(2)} is below configured ${policy.min_recent_ratio.toFixed(2)}`);
  if (verifiedRatio < policy.min_verified_ratio) fail("verified-metadata", `verified metadata ratio ${verifiedRatio.toFixed(2)} is below configured ${policy.min_verified_ratio.toFixed(2)}`);
  if (arxivOnlyRatio > policy.max_arxiv_only_ratio) fail("venue-mix", `arXiv-only ratio ${arxivOnlyRatio.toFixed(2)} exceeds configured ${policy.max_arxiv_only_ratio.toFixed(2)}`);
  return checkOf(GATE, findings);
}

async function checkCitationUrlLiveness(
  workspaceDir: string,
  requireLiveUrls: boolean,
): Promise<ValidationCheck> {
  const result = await readJsonlFile<{ source_id?: string; status?: string; url?: string }>(
    workspaceDir,
    "sources/citation-verification.jsonl",
  );
  const GATE = "citation_url_liveness";
  // A dead or missing URL is a defect in the source record, not in the prose
  // that cites it: the citation is correct and the metadata behind it is not.
  const fail = (subject: string, diagnostic: string): Finding => rFinding({
    gate: GATE, kind: "source_record", effect: "repair_source_metadata", subject, diagnostic });
  if (result.error) {
    return requireLiveUrls
      ? checkOf(GATE, [fail("verification-log", "citation_url_liveness: sources/citation-verification.jsonl is required when source_policy.require_live_urls is true")])
      : note(GATE, true, "citation URL verification has not run; enable require_live_urls to make this a release gate");
  }
  const failures = result.rows.filter((entry) => entry.status !== "live" && entry.status !== "redirect");
  if (failures.length === 0) {
    return note(GATE, true, `${result.rows.length} cited source URL(s) verified live or redirected`);
  }
  const findings = failures.map((entry) => fail(entry.source_id ?? "unknown-source",
    `citation URL for ${entry.source_id ?? "unknown source"} is ${entry.status ?? "unknown"}: ${entry.url ?? "no URL"}`));
  // Informational when the policy does not require live URLs: the defect is
  // real and worth reporting, but it does not close the gate.
  return { id: gateId(GATE), pass: !requireLiveUrls, findings: requireLiveUrls ? findings : [],
    measurements: [], requires_diagnosis: false,
    diagnostic: findings.map((item) => item.diagnostic).join("; ") };
}

function checkEvidenceCitationIntegrity(
  chapters: Array<{ rel: string; content: string }>,
  sourceIds: Set<string>,
): ValidationCheck {
  const GATE = "citation_verification";
  const findings: Finding[] = [];
  const fail = (subject: string, diagnostic: string, chapterPath: string) => findings.push(rFinding({
    gate: GATE, kind: "chapter_prose", effect: "repair_citation_marker", subject, diagnostic, path: chapterPath }));
  for (const chapter of chapters) {
    const ids = markers(chapter.content);
    const section = sectionIdFromChapter(chapter.rel);
    if (ids.length === 0) fail(section, `${chapter.rel} has no [source:<id>] markers.`, chapter.rel);
    for (const id of ids) {
      if (!sourceIds.has(id)) fail(`${section}-${id}`, `${chapter.rel} cites unknown source id "${id}".`, chapter.rel);
    }
  }
  return checkOf(GATE, findings);
}

async function checkEvidenceCoverage(workspaceDir: string): Promise<ValidationCheck> {
  const GATE = "evidence_coverage";
  const coverage = await jsonIfExists(path.join(workspaceDir, "evidence", "coverage.json"));
  if (coverage === null) return note(GATE, true, "evidence/coverage.json not present; evidence allocation has not run");
  const rows = Array.isArray(coverage.taxonomy) ? coverage.taxonomy as Array<Record<string, unknown>> : [];
  const findings = rows
    .filter((row) => typeof row.source_count !== "number" || row.source_count < 2)
    .map((row) => {
      const cell = String(row.cell ?? "unknown");
      // Scoped to the cell that is short, so a repair knows where to look.
      return rFinding({
        gate: GATE, kind: "corpus", effect: "acquire_additional_evidence",
        subject: `cell-${slugify(cell)}`, scope: scopeKey("taxonomy_cell", cell),
        diagnostic: `taxonomy coverage for "${cell}" has ${String(row.source_count ?? 0)} sources; minimum is 2`,
      });
    });
  return checkOf(GATE, findings);
}

async function checkDirectTaxonomyCoverage(workspaceDir: string, provider?: string): Promise<ValidationCheck> {
  const GATE = "taxonomy_direct_evidence";
  if (provider === undefined || provider === "seed") return note(GATE, true, "source provider unavailable or seed: A/B-depth taxonomy target is informational");
  const coverage = await jsonIfExists(path.join(workspaceDir, "evidence", "coverage.json"));
  if (coverage === null) return checkOf(GATE, [rFinding({
    gate: GATE, kind: "evidence_packet", effect: "acquire_additional_evidence", subject: "coverage",
    diagnostic: "evidence/coverage.json is required for a live research release" })]);
  const rows = Array.isArray(coverage.taxonomy) ? coverage.taxonomy as Array<Record<string, unknown>> : [];
  const findings = rows
    .filter((row) => typeof row.direct_source_count !== "number" || row.direct_source_count < 2)
    .map((row) => {
      const cell = String(row.cell ?? "unknown");
      return rFinding({
        gate: GATE, kind: "evidence_packet", effect: "acquire_additional_evidence",
        subject: `cell-${slugify(cell)}`, scope: scopeKey("taxonomy_cell", cell),
        diagnostic: `taxonomy cell "${cell}" has ${String(row.direct_source_count ?? 0)} A/B-depth sources; minimum is 2`,
      });
    });
  return checkOf(GATE, findings);
}

async function checkReviewTarget(workspaceDir: string): Promise<ValidationCheck> {
  const GATE = "review_target";
  const scorecard = await statIfExists(path.join(workspaceDir, "reviews", "scorecard.json"));
  if (scorecard === null) return note(GATE, true, "no scorecard found; review target check skipped");
  const metrics = await jsonIfExists(path.join(workspaceDir, "reports", "metrics.json"));
  const score = metrics?.review_score;
  // A low review score is a claim about the argument, so the prose is what a
  // repair edits; the gate also declares figure and outline routes for the
  // cases diagnosis attributes elsewhere.
  const fail = (subject: string, diagnostic: string): Finding => rFinding({
    gate: GATE, kind: "chapter_prose", effect: "remove_unsupported_claim", subject, diagnostic });
  if (typeof score !== "number") return checkOf(GATE, [fail("score", "reports/metrics.json must contain numeric review_score after a scorecard review")]);
  return score >= 8
    ? note(GATE, true, `review_score ${score.toFixed(1)} meets the research release target 8.0`)
    : checkOf(GATE, [fail("score", `review_score ${score.toFixed(1)} is below the research release target 8.0`)]);
}

async function checkEmpiricalExperiment(workspaceDir: string): Promise<ValidationCheck> {
  const GATE = "empirical_experiment";
  const config = await loadProjectConfig(workspaceDir).catch(() => null);
  if (!config || config.research.paper_kind !== "empirical") {
    return note(GATE, true, "survey paper: empirical experiment gate is not applicable");
  }
  const experiment = config.research.experiment;
  // An environment gate: it reports a precondition an operator must satisfy
  // and declares no findings, so it sets requires_diagnosis when it fails
  // rather than inventing an artifact nobody here can edit.
  const blocked = (diagnostic: string): ValidationCheck => ({
    id: gateId(GATE), pass: false, findings: [], measurements: [], requires_diagnosis: true, diagnostic });
  if (!experiment.enabled) return blocked("empirical paper requires research.experiment.enabled=true; do not claim experimental validation without an audited results artifact");
  if (experiment.manifest_path) {
    const result = await validateImportedExperiment(workspaceDir);
    return result.pass ? note(GATE, true, result.finding) : blocked(result.finding);
  }
  const raw = await jsonIfExists(path.join(workspaceDir, experiment.results_path));
  if (raw === null) return blocked(`empirical paper requires ${experiment.results_path} with hypothesis, trials, results, and statistical_test`);
  const trials = raw.trials;
  const results = raw.results;
  const valid = typeof raw.hypothesis === "string" && raw.hypothesis.trim().length > 0
    && typeof trials === "number" && Number.isInteger(trials) && trials >= experiment.min_trials
    && Array.isArray(results) && results.length > 0
    && typeof raw.statistical_test === "string" && raw.statistical_test.trim().length > 0;
  return valid
    ? note(GATE, true, `audited experiment contract passed with ${trials} trials`)
    : blocked(`${experiment.results_path} must include non-empty hypothesis/results/statistical_test and trials >= ${experiment.min_trials}`);
}

/** A configured full-paper target is a release contract, not merely a display
 * hint. The lower bound allows normal count variance while preventing a
 * short scaffold from being labelled a successful full manuscript. */
async function checkTargetLength(
  workspaceDir: string,
  chapters: Array<{ rel: string; content: string }>,
): Promise<ValidationCheck> {
  const GATE = "target_length";
  const config = await loadProjectConfig(workspaceDir).catch(() => null);
  const target = config?.writing.target_length_words;
  if (!isFullResearchMode(config?.project.mode) || !target) {
    return note(GATE, true, "target length is informational outside the full research release modes");
  }
  const total = chapters.reduce((sum, chapter) => sum + countWords(chapter.content), 0);
  const minimum = Math.ceil(target * 0.8);
  if (total >= minimum) {
    return note(GATE, true, `${total} chapter words meets the full-release minimum ${minimum} for the ${target}-word target`);
  }
  // An under-length manuscript needs more argument, not less prose. The route
  // table previously offered only remove_redundant_prose here, which left this
  // failure with no repair that could ever satisfy it.
  return checkOf(GATE, [rFinding({
    gate: GATE, kind: "chapter_prose", effect: "expand_argument", subject: "length",
    diagnostic: `${total} chapter words is below the full-release minimum ${minimum} for the ${target}-word target; expand evidence-backed prose before release`,
  })]);
}

async function checkClaimSupport(workspaceDir: string): Promise<ValidationCheck> {
  const GATE = "claim_support";
  const judgments = await statIfExists(path.join(workspaceDir, "reviews", "claim-judgments.jsonl"));
  if (judgments === null) return note(GATE, true, "no claim judgments found; claim gate check skipped");
  const metrics = await jsonIfExists(path.join(workspaceDir, "reports", "metrics.json"));
  const rate = metrics?.claim_support_rate;
  const fail = (subject: string, diagnostic: string): Finding => rFinding({
    gate: GATE, kind: "chapter_prose", effect: "remove_unsupported_claim", subject, diagnostic });
  if (typeof rate !== "number") return checkOf(GATE, [fail("rate", "reports/metrics.json must contain claim_support_rate after claim judgments")]);
  return rate >= 0.9
    ? note(GATE, true, `claim_support_rate ${rate.toFixed(3)} meets the release target 0.900`)
    : checkOf(GATE, [fail("rate", `claim_support_rate ${rate.toFixed(3)} is below the release target 0.900`)]);
}

async function checkNoContradictions(workspaceDir: string): Promise<ValidationCheck> {
  const GATE = "claim_contradictions";
  const resolve = (subject: string, diagnostic: string): Finding => rFinding({
    gate: GATE, kind: "chapter_prose", effect: "resolve_contradiction", subject, diagnostic });
  const result = await readJsonlFile<ClaimJudgment>(workspaceDir, "reviews/claim-judgments.jsonl");
  if (result.error?.endsWith("is missing")) return note(GATE, true, "no claim judgments found; contradiction check skipped");
  if (result.error) return checkOf(GATE, [resolve("judgments", `claim_contradictions: ${result.error}`)]);
  const parsed = result.rows.map((row, index) => ({ index, parsed: ClaimJudgmentSchema.safeParse(row) }));
  const invalid = parsed.filter((entry) => !entry.parsed.success);
  if (invalid.length > 0) {
    return checkOf(GATE, invalid.map((entry) => resolve(`row-${entry.index + 1}`,
      `claim_contradictions: reviews/claim-judgments.jsonl row ${entry.index + 1} violates the claim-judgment schema`)));
  }
  const contradictions = detectContradictions(parsed.map((entry) => entry.parsed.data as ClaimJudgment));
  const findings = contradictions.map((group) => resolve(`subject-${slugify(group.subject_key)}`,
    `claim_contradictions: subject "${group.subject_key}" is both affirmed and denied across ${group.chapters.join(", ")}: ${group.claims.map((claim) => `[${claim.chapter}] ${claim.polarity}: ${claim.claim}`).join(" | ")}`));
  return checkOf(GATE, findings);
}

async function checkLandmarkCoverage(workspaceDir: string, sources: ClassifiedSource[], chapters: Array<{ rel: string; content: string }>): Promise<ValidationCheck[]> {
  const config = await loadProjectConfig(workspaceDir).catch(() => null);
  const threshold = config?.research.corpus_gates.min_landmark_coverage_ratio ?? 0;
  const citationThreshold = config?.research.corpus_gates.min_landmark_citation_coverage_ratio ?? 0;
  // Coverage is a retrieval gap: the landmark work is not in the corpus at
  // A/B depth. Citation coverage is a prose gap: it is in the corpus and the
  // manuscript never cites it. Different repairs, so different triples.
  const missingEvidence = (subject: string, diagnostic: string): Finding => rFinding({
    gate: "landmark_coverage", kind: "corpus", effect: "acquire_additional_evidence", subject, diagnostic });
  const missingCitation = (subject: string, diagnostic: string): Finding => rFinding({
    gate: "landmark_citation_coverage", kind: "chapter_prose", effect: "add_supporting_citation", subject, diagnostic });
  if (threshold <= 0 && citationThreshold <= 0) return [
    note("landmark_coverage", true, "landmark coverage gate is not configured"),
    note("landmark_citation_coverage", true, "landmark citation coverage gate is not configured"),
  ];
  const raw = await readIfExists(path.join(workspaceDir, "research", "landmark-candidates.json"));
  if (raw === null) return [
    threshold <= 0
      ? note("landmark_coverage", true, "landmark coverage gate is not configured")
      : checkOf("landmark_coverage", [missingEvidence("candidates", "landmark_coverage: research/landmark-candidates.json is required when landmark coverage is configured; run the landmark_scout stage")]),
    citationThreshold <= 0
      ? note("landmark_citation_coverage", true, "landmark citation coverage gate is not configured")
      : checkOf("landmark_citation_coverage", [missingCitation("candidates", "landmark_citation_coverage: landmark discovery has not produced a candidate set")]),
  ];
  let candidates: LandmarkCandidates;
  try {
    candidates = LandmarkCandidates.parse(JSON.parse(raw));
  } catch (error) {
    const finding = `research/landmark-candidates.json is invalid: ${error instanceof Error ? error.message : String(error)}`;
    return [
      checkOf("landmark_coverage", [missingEvidence("candidates", `landmark_coverage: ${finding}`)]),
      checkOf("landmark_citation_coverage", [missingCitation("candidates", `landmark_citation_coverage: ${finding}`)]),
    ];
  }
  const maxCandidates = config?.research.corpus_gates.max_landmark_candidates ?? 20;
  // Candidate order is part of the scout contract. Bound the release
  // denominator to the configured paper scope so an over-enthusiastic scout
  // cannot turn every adjacent work into a mandatory citation.
  const canonical = candidates.candidates.filter((candidate) => candidate.confidence !== "low").slice(0, maxCandidates);
  if (canonical.length === 0) {
    const finding = "landmark scout produced no high/medium-confidence candidates";
    return [
      threshold <= 0 ? note("landmark_coverage", true, finding)
        : checkOf("landmark_coverage", [missingEvidence("candidates", `landmark_coverage: ${finding}`)]),
      citationThreshold <= 0 ? note("landmark_citation_coverage", true, finding)
        : checkOf("landmark_citation_coverage", [missingCitation("candidates", `landmark_citation_coverage: ${finding}`)]),
    ];
  }
  const evidenceSources = sources.filter((source) => source.citation_depth === "A" || source.citation_depth === "B");
  const matches = matchLandmarksToCorpus(canonical, evidenceSources);
  const coverage = computeLandmarkCoverage(matches);
  const cited = citedSourceIds(chapters);
  const citationCoverage = computeLandmarkCoverage(matches.map((match) => cited.has(match.matchedSourceId ?? "") ? match : { ...match, matchedSourceId: null, matchedBy: null }));
  return [
    threshold <= 0 || coverage.coverageRatio >= threshold
      ? note("landmark_coverage", true, `landmark_coverage: ${coverage.matched}/${coverage.total} high/medium landmark works have A/B evidence`)
      : checkOf("landmark_coverage", [missingEvidence("coverage", `landmark_coverage: A/B evidence coverage ratio ${coverage.coverageRatio.toFixed(3)} (${coverage.matched}/${coverage.total}) is below configured minimum ${threshold.toFixed(3)}; missing: ${coverage.unmatched.join(", ")}`)]),
    citationThreshold <= 0 || citationCoverage.coverageRatio >= citationThreshold
      ? note("landmark_citation_coverage", true, `landmark_citation_coverage: ${citationCoverage.matched}/${citationCoverage.total} high/medium landmark works with A/B evidence are cited in the manuscript`)
      : checkOf("landmark_citation_coverage", [missingCitation("coverage", `landmark_citation_coverage: cited A/B landmark ratio ${citationCoverage.coverageRatio.toFixed(3)} (${citationCoverage.matched}/${citationCoverage.total}) is below configured minimum ${citationThreshold.toFixed(3)}; missing or uncited: ${citationCoverage.unmatched.join(", ")}`)]),
  ];
}

async function checkPublicationArtifacts(workspaceDir: string): Promise<ValidationCheck[]> {
  const main = await statIfExists(path.join(workspaceDir, "paper", "main.tex"));
  const manifest = await statIfExists(path.join(workspaceDir, "figures", "manifest.json"));
  if (main === null && manifest === null) {
    return [note("publication_artifact_contract", true, "paper/ and figures/ artifacts absent; publication rendering checks skipped")];
  }
  const [latex, figures] = await Promise.all([validateLatexWorkspace(workspaceDir), validateFigureWorkspace(workspaceDir)]);
  // Aggregates. The routable findings reach the kernel from the latex and
  // figures producers themselves; re-emitting them here would double-count one
  // defect as two, so these carry the prose and request diagnosis on failure.
  const aggregate = (gate: string, pass: boolean, diagnostics: string[]): ValidationCheck => ({
    id: gateId(gate), pass, findings: [], measurements: [], requires_diagnosis: !pass,
    diagnostic: diagnostics.join("; ") || undefined,
  });
  return [
    aggregate("publication_latex", latex.pass, latex.checks.flatMap((check) => check.findings.map((item) => item.diagnostic))),
    aggregate("publication_figures", figures.pass, figures.checks.flatMap((check) => check.findings.map((item) => item.diagnostic))),
  ];
}

async function checkFullResearchContracts(workspaceDir: string): Promise<ValidationCheck[]> {
  const config = await loadProjectConfig(workspaceDir).catch(() => null);
  if (!config || !isFullResearchMode(config.project.mode)) {
    return [note("full_research_contracts", true, "not a full research release mode; full contract gates are informational")];
  }
  /** Re-reads another producer's report. It declares no findings of its own:
   * the corpus and survey producers already emit routable ones, and repeating
   * them here would make one defect look like two. On failure it asks for
   * diagnosis instead. */
  const requireJsonPass = async (gate: string, rel: string): Promise<ValidationCheck> => {
    const parsed = await jsonIfExists(path.join(workspaceDir, rel));
    if (parsed === null) return { id: gateId(gate), pass: false, findings: [], measurements: [], requires_diagnosis: true, diagnostic: `${gate}: ${rel} is missing or invalid` };
    if (parsed.pass !== true) return { id: gateId(gate), pass: false, findings: [], measurements: [], requires_diagnosis: true, diagnostic: `${gate}: ${rel} did not pass` };
    return note(gate, true, `${rel} passed`);
  };
  const identity = await readJsonlFile<Record<string, unknown>>(workspaceDir, "sources/source-identities.jsonl");
  const identityFail = (subject: string, diagnostic: string): Finding => rFinding({
    gate: "full_source_identity", kind: "source_record", effect: "repair_source_metadata", subject, diagnostic });
  const identityFailures = identity.error
    ? [identityFail("identities", identity.error)]
    : identity.rows
      .filter((row) => !row.canonical_url || (!row.doi && !row.arxiv_id && !row.semantic_scholar_id && !row.openalex_id))
      .map((row) => identityFail(String(row.source_id ?? "unknown"), `source identity for ${String(row.source_id ?? "unknown")} lacks canonical URL or strong identifier`));
  const metrics = await jsonIfExists(path.join(workspaceDir, "reports", "metrics.json"));
  const doubleReviewed = typeof metrics?.claim_samples_double_reviewed === "number" ? metrics.claim_samples_double_reviewed : 0;
  const disagreements = typeof metrics?.claim_review_disagreements === "number" ? metrics.claim_review_disagreements : 0;
  return [
    await requireJsonPass("full_corpus_gates", "reports/corpus-gates.json"),
    await requireJsonPass("full_survey_contract", "reports/survey-contract.json"),
    checkOf("full_source_identity", identityFailures),
    // A measurement gate: it is satisfied by re-running the double review, not
    // by editing an artifact, so it declares no findings.
    doubleReviewed > 0 && disagreements === 0
      ? note("full_claim_double_review", true, `${doubleReviewed} double-reviewed sample(s), no disagreements`)
      : { id: gateId("full_claim_double_review"), pass: false, findings: [], measurements: [], requires_diagnosis: true,
          diagnostic: `claim double review requires at least one double-reviewed sample and zero disagreements; got double_reviewed=${doubleReviewed}, disagreements=${disagreements}` },
    await checkVisualReviewReleaseGate(workspaceDir, config.research.provider !== "seed"),
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

/** `asOfDate` defaults to now for a live run and is passed explicitly by the
 * measurement path, so a recency gate is reproducible rather than dependent on
 * the day it happened to execute. */
export async function validateResearchWorkspace(
  workspaceDir: string,
  asOfDate: string = new Date().toISOString(),
): Promise<ValidationReport> {
  const sourceResult = await readJsonlFile<ClassifiedSource>(workspaceDir, "sources/classified_sources.jsonl");
  const planResult = await readJsonlFile<CitationPlanEntry>(workspaceDir, "sources/citation_plan.jsonl");
  const bibliography = await readIfExists(path.join(workspaceDir, "sources/bibliography.bib"));
  const chapters = await chapterFiles(workspaceDir);
  const sources = sourceResult.rows;
  const sourceIds = new Set(sources.map((source) => source.id));
  const setupFindings = [sourceResult.error, planResult.error].filter((finding): finding is string => Boolean(finding));

  let configuredProvider: string | undefined;
  let requireLiveUrls = false;
  let config: Awaited<ReturnType<typeof loadProjectConfig>> | null = null;
  try {
    config = await loadProjectConfig(workspaceDir);
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
        await (async () => {
          const ledger = await validateEvidenceLedger(workspaceDir, { allowMetadataOnly: configuredProvider === "seed" });
          // A ledger defect is a citation the evidence does not back, which is
          // repaired where the marker is written.
          return checkOf("citation_evidence_ledger", ledger.findings.map((diagnostic, index) => rFinding({
            gate: "citation_evidence_ledger", kind: "chapter_prose", effect: "repair_citation_marker",
            subject: `entry-${index + 1}`, diagnostic })));
        })(),
      ]
    : [];
  const checks: ValidationCheck[] = [
    // Absent research artifacts are an evidence gap, not a figure defect: the
    // repair is to gather the corpus, not to redraw anything.
    checkOf("research_artifacts_present", setupFindings.map((diagnostic, index) => rFinding({
      gate: "research_artifacts_present", kind: "evidence_packet", effect: "acquire_additional_evidence",
      subject: `artifact-${index + 1}`, severity: "critical", diagnostic }))),
    checkCitationMarkers(chapters, sourceIds),
    evidenceEnabled
      ? note("source_coverage", true, "outline-specific evidence packets supersede the legacy generic citation plan")
      : checkSourceCoverage(chapters, planResult.rows, sourceIds),
    checkBibliography(bibliography, sources),
    configuredProvider === "seed"
      ? note("literature_quality_score", true, "seed provider: LQS is informational")
      : checkLiteratureQuality(sources),
    config === null ? note("prose_redundancy", true, "longwrite.yaml unavailable; redundancy gate skipped")
      : checkProseRedundancy(chapters, config.research.quality_control),
    evidenceEnabled
      ? checkEvidenceCitationIntegrity(chapters, sourceIds)
      : checkCitationVerification(sources, planResult.rows, chapters, bibliography),
    await checkResearchPolicy(workspaceDir, sources),
    await checkCitedLiteratureReleaseGates(workspaceDir, chapters, sources, asOfDate),
    await checkCitationUrlLiveness(workspaceDir, requireLiveUrls),
    await checkCodebaseEvidence(workspaceDir, chapters),
    ...evidenceChecks,
    await checkDirectTaxonomyCoverage(workspaceDir, configuredProvider),
    await checkTargetLength(workspaceDir, chapters),
    await checkReviewTarget(workspaceDir),
    await checkEmpiricalExperiment(workspaceDir),
    await checkClaimSupport(workspaceDir),
    await checkNoContradictions(workspaceDir),
    ...(await checkLandmarkCoverage(workspaceDir, sources, chapters)),
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
  const gatesRel = "reports/release-gates.json";
  await fs.writeFile(path.join(workspaceDir, jsonRel), `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  await fs.writeFile(path.join(workspaceDir, markdownRel), validationReportToMarkdown(report), "utf-8");
  await fs.writeFile(path.join(workspaceDir, gatesRel), `${JSON.stringify({
    version: 1,
    generated_at: new Date().toISOString(),
    pass: report.pass,
    summary: {
      total: report.checks.length,
      passed: report.checks.filter((check) => check.pass).length,
      failed: report.checks.filter((check) => !check.pass).length,
    },
    gates: report.checks.map((check) => ({ id: check.id, pass: check.pass, findings: check.findings })),
  }, null, 2)}\n`, "utf-8");
  return [jsonRel, markdownRel, gatesRel];
}

import { defineProducer } from "../registry/producer-types.js";

/** Gate declarations, kept beside the checks that emit them so a reviewer
 * sees a gate's repair semantics and its code together. The class table,
 * legal triples and routes are all generated from this.
 *
 * `review_no_regressions` is deliberately absent: `must_preserve` in the
 * kernel subsumes it, and a weaker duplicate would let a regression pass one
 * check while failing the other. */
export const PRODUCER = defineProducer({
  module: "research",
  gates: [
    { id: "source_coverage", class: "manuscript", findings: [
      { kind: "corpus", effect: "acquire_additional_evidence", capability: "targeted_research_expansion" },
    ] },
    { id: "evidence_coverage", class: "manuscript", findings: [
      { kind: "corpus", effect: "acquire_additional_evidence", capability: "targeted_research_expansion" },
      { kind: "evidence_packet", effect: "acquire_additional_evidence", capability: "targeted_research_expansion" },
    ] },
    { id: "literature_quality_score", class: "manuscript", findings: [
      { kind: "corpus", effect: "upgrade_source_quality", capability: "targeted_research_expansion" },
    ] },
    { id: "research_policy", class: "manuscript", findings: [
      { kind: "corpus", effect: "upgrade_source_quality", capability: "targeted_research_expansion" },
    ] },
    { id: "landmark_coverage", class: "manuscript", observes: ["landmark_coverage_ratio"], findings: [
      { kind: "corpus", effect: "acquire_additional_evidence", capability: "targeted_research_expansion" },
    ] },
    { id: "codebase_evidence", class: "manuscript", findings: [
      { kind: "evidence_packet", effect: "acquire_additional_evidence", capability: "targeted_research_expansion" },
    ] },
    { id: "taxonomy_direct_evidence", class: "manuscript", findings: [
      { kind: "evidence_packet", effect: "acquire_additional_evidence", capability: "targeted_research_expansion" },
      { kind: "chapter_prose", effect: "add_supporting_citation", capability: "revise_sections" },
    ] },
    { id: "research_artifacts_present", class: "manuscript", findings: [
      { kind: "evidence_packet", effect: "acquire_additional_evidence", capability: "targeted_research_expansion" },
    ] },
    { id: "citation_url_liveness", class: "manuscript", findings: [
      { kind: "source_record", effect: "repair_source_metadata", capability: "repair_source_metadata" },
    ] },
    { id: "full_source_identity", class: "manuscript", findings: [
      { kind: "source_record", effect: "repair_source_metadata", capability: "repair_source_metadata" },
    ] },
    { id: "bibliography_consistent", class: "manuscript", findings: [
      { kind: "bibliography", effect: "repair_bibliography_consistency", capability: "repair_bibliography" },
    ] },
    { id: "landmark_citation_coverage", class: "manuscript", observes: ["landmark_citation_coverage_ratio"], findings: [
      { kind: "chapter_prose", effect: "add_supporting_citation", capability: "revise_sections" },
    ] },
    { id: "cited_literature_release_gates", class: "manuscript", observes: ["cited_sources", "citation_depth_per_section"], findings: [
      { kind: "chapter_prose", effect: "add_supporting_citation", capability: "revise_sections" },
      { kind: "chapter_prose", effect: "remove_unsupported_claim", capability: "revise_sections" },
      { kind: "corpus", effect: "upgrade_source_quality", capability: "targeted_research_expansion" },
    ] },
    { id: "citation_markers_present", class: "manuscript", findings: [
      { kind: "chapter_prose", effect: "repair_citation_marker", capability: "revise_sections" },
    ] },
    { id: "citation_evidence_ledger", class: "manuscript", findings: [
      { kind: "chapter_prose", effect: "repair_citation_marker", capability: "revise_sections" },
    ] },
    { id: "citation_verification", class: "manuscript", observes: ["citation_verification_status"], findings: [
      { kind: "chapter_prose", effect: "repair_citation_marker", capability: "revise_sections" },
      { kind: "source_record", effect: "repair_source_metadata", capability: "repair_source_metadata" },
      { kind: "bibliography", effect: "repair_bibliography_consistency", capability: "repair_bibliography" },
    ] },
    { id: "claim_support", class: "manuscript", observes: ["claim_support"], findings: [
      { kind: "chapter_prose", effect: "remove_unsupported_claim", capability: "revise_sections" },
    ] },
    { id: "claim_contradictions", class: "manuscript", observes: ["claim_contradictions"], findings: [
      { kind: "chapter_prose", effect: "resolve_contradiction", capability: "revise_sections" },
      { kind: "outline", effect: "replace_organizing_claim", capability: "reopen_outline" },
    ] },
    { id: "prose_redundancy", class: "manuscript", observes: ["prose_redundancy"], findings: [
      { kind: "chapter_prose", effect: "remove_redundant_prose", capability: "revise_sections" },
    ] },
    { id: "target_length", class: "manuscript", findings: [
      { kind: "chapter_prose", effect: "expand_argument", capability: "revise_sections" },
      { kind: "chapter_prose", effect: "remove_redundant_prose", capability: "revise_sections" },
    ] },
    { id: "review_target", class: "manuscript", observes: ["review_score"], findings: [
      { kind: "chapter_prose", effect: "remove_unsupported_claim", capability: "revise_sections" },
      { kind: "figure_spec", effect: "repair_artifact_content", capability: "revise_visual_plan" },
      { kind: "outline", effect: "replace_organizing_claim", capability: "reopen_outline" },
    ] },
    { id: "full_research_contracts", class: "manuscript", findings: [
      { kind: "outline", effect: "replace_organizing_claim", capability: "reopen_outline" },
    ] },
    { id: "publication_figures", class: "manuscript", observes: ["figures", "tables"], findings: [
      { kind: "figure_spec", effect: "repair_artifact_content", capability: "revise_visual_plan" },
    ] },
    { id: "publication_latex", class: "manuscript", findings: [
      { kind: "figure_spec", effect: "repair_artifact_placement", capability: "revise_visual_plan" },
    ] },
    { id: "publication_artifact_contract", class: "manuscript", findings: [
      { kind: "figure_spec", effect: "repair_artifact_content", capability: "revise_visual_plan" },
    ] },
    { id: "manuscript_build", class: "manuscript", findings: [
      { kind: "figure_spec", effect: "repair_artifact_placement", capability: "revise_visual_plan" },
      { kind: "bibliography", effect: "repair_bibliography_consistency", capability: "repair_bibliography" },
      { kind: "toolchain", effect: "repair_toolchain", capability: "request_operator_clarification" },
    ] },
    { id: "full_claim_double_review", class: "measurement", findings: [] },
    { id: "empirical_experiment", class: "environment", findings: [] },
  ],
});
