import path from "node:path";
import { prepareResearchWorkspace } from "../lib/research/pipeline.js";
import { assessResearchWorkspace, writeResearchAssessment } from "../lib/ops/research-quality.js";
import type { ResearchProviderId } from "../lib/research/providers.js";
import { loadProjectConfig } from "../lib/project-config.js";
import { buildEvidenceIndex, allocateSectionEvidence } from "../lib/research/evidence.js";
import { openAICompatibleEmbeddings } from "../lib/research/embeddings.js";
import { z } from "zod";
import fs from "node:fs/promises";
import { snowballWorkspace } from "../lib/research/snowball.js";
import { AgenticActionPlan } from "../lib/ops/action-plan.js";
import { prepareCodebases } from "../lib/research/codebase.js";
import { discoverGithubCodebases, repairGithubCodebaseSelection } from "../lib/research/github-codebase-discovery.js";
import { importLongExperiment, prepareExperimentEvidence } from "../lib/research/experiment.js";
import { repairCodebaseAnalysis } from "../lib/research/codebase-analysis.js";
import { repairCodebaseComparison } from "../lib/research/codebase-comparison.js";

/** Copy only a reviewed, publication-eligible LongExperiment result into the
 * paper workspace. LongWrite validates the copied manifest again at release. */
export async function importExperimentManifest(workspaceDir: string, manifestPath: string): Promise<string> {
  const imported = await importLongExperiment(path.resolve(workspaceDir), path.resolve(manifestPath));
  return imported.manifestPath;
}

export async function prepareImportedExperiment(workspaceDir: string): Promise<string[]> {
  return prepareExperimentEvidence(path.resolve(workspaceDir));
}

export type ResearchPrepareOptions = {
  topic?: string;
  count?: string;
  limit?: string;
  provider?: string;
  allowSeedFallback?: boolean;
};

const providers = new Set<ResearchProviderId>(["seed", "arxiv", "semantic_scholar", "dblp", "crossref", "openalex", "multi"]);

function normalizeResearchOptions(opts: { topic?: string; provider?: string; limit?: string; count?: string }): {
  topic: string;
  provider: ResearchProviderId;
  limit?: number;
} {
  const topic = opts.topic?.trim();
  if (!topic) {
    throw new Error('Missing --topic. Example: longwrite research recall . --topic "Long-horizon agent memory"');
  }
  const limitText = opts.limit ?? opts.count;
  const limit = limitText ? Number.parseInt(limitText, 10) : undefined;
  if (limitText && (!Number.isInteger(limit) || limit === undefined || limit <= 0)) {
    throw new Error("--limit must be a positive integer");
  }
  const provider = opts.provider ?? "seed";
  if (!providers.has(provider as ResearchProviderId)) {
    throw new Error("--provider must be one of: seed, arxiv, semantic_scholar, dblp, crossref, openalex, multi");
  }
  return { topic, provider: provider as ResearchProviderId, limit };
}

export async function runResearchPrepare(workspaceDir: string, opts: ResearchPrepareOptions): Promise<void> {
  const topic = opts.topic?.trim();
  if (!topic) {
    throw new Error("Missing --topic. Example: longwrite research prepare . --topic \"Long-horizon agent memory\"");
  }
  const limitText = opts.limit ?? opts.count;
  const count = limitText ? Number.parseInt(limitText, 10) : undefined;
  if (limitText && (!Number.isInteger(count) || count === undefined || count <= 0)) {
    throw new Error("--limit must be a positive integer");
  }
  const provider = opts.provider ?? "seed";
  if (!providers.has(provider as ResearchProviderId)) {
    throw new Error("--provider must be one of: seed, arxiv, semantic_scholar, dblp, crossref, openalex, multi");
  }

  const written = await prepareResearchWorkspace({
    workspaceDir,
    topic,
    count,
    provider: provider as ResearchProviderId,
    fallbackToSeed: opts.allowSeedFallback === true,
  });

  console.log(`Prepared research artifacts in ${path.resolve(workspaceDir)}`);
  console.log(`Provider: ${provider}`);
  for (const file of written) console.log(`  + ${file}`);
}

export async function runResearchAssess(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const assessment = await assessResearchWorkspace(resolved);
  const written = await writeResearchAssessment(resolved, assessment);
  console.log(`Assessed research quality in ${resolved}`);
  console.log(`Literature quality score: ${assessment.literatureQuality.score}/10`);
  console.log(`Citation verification: ${assessment.citationVerification.pass ? "pass" : "fail"}`);
  for (const file of written) console.log(`  + ${file}`);
  if (!assessment.citationVerification.pass) {
    if (await seedProviderAdvisory(resolved)) {
      console.error("  seed provider: citation assessment advisory only (offline dev fixture)");
      return;
    }
    process.exitCode = 1;
  }
}

/** Snapshot configured Git/local repositories into inspectable codebase
 * evidence. This never executes repository code and does not use GitHub's
 * API: Git resolves a pinned commit locally. */
export async function runResearchPrepareCodebases(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const result = await prepareCodebases(resolved);
  console.log(`Prepared ${result.codebases} codebase evidence input(s), ${result.chunks} text chunk(s).`);
  for (const file of result.written) console.log(`  + ${file}`);
}

export async function runResearchRepairCodebaseAnalysis(workspaceDir: string): Promise<void> {
  const result = await repairCodebaseAnalysis(path.resolve(workspaceDir));
  console.log(`Validated repository architecture analysis; raw envelope normalized: ${result.normalized ? "yes" : "no"}.`);
  console.log(`  + evidence/codebase-analysis.json`);
  console.log(`  + ${result.reportPath}`);
}

export async function runResearchRepairCodebaseComparison(workspaceDir: string): Promise<void> {
  const result = await repairCodebaseComparison(path.resolve(workspaceDir));
  console.log(`Validated repository comparison packet; raw envelope normalized: ${result.normalized ? "yes" : "no"}.`);
}

export async function runResearchGithubCodebaseRecall(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const written = await discoverGithubCodebases(resolved);
  console.log(`Recalled GitHub codebase candidates in ${resolved}`);
  for (const file of written) console.log(`  + ${file}`);
}

export async function runResearchRepairGithubCodebaseSelection(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const written = await repairGithubCodebaseSelection(resolved);
  console.log(`Validated GitHub codebase selections in ${resolved}`);
  for (const file of written) console.log(`  + ${file}`);
}

export async function runResearchSnowball(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const { results, written } = await snowballWorkspace(resolved);
  console.log(`Citation-network expansion: ${results.filter((result) => result.status === "expanded").length} seed source(s) expanded.`);
  for (const file of written) console.log(`  + ${file}`);
}

export async function runResearchVenueUpgrade(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const config = await loadProjectConfig(resolved);
  const { upgrades, written } = await (await import("../lib/research/enrich.js")).enrichSourceMetadata(resolved, {
    maxSources: 60,
    enabled: config.research.provider !== "seed",
  });
  await fs.copyFile(path.join(resolved, "sources", "metadata-upgrades.jsonl"), path.join(resolved, "sources", "venue-upgrades.jsonl"));
  await fs.copyFile(path.join(resolved, "reports", "metadata-enrichment.md"), path.join(resolved, "reports", "venue-upgrade.md"));
  console.log(`Venue metadata upgrades: ${upgrades.filter((upgrade) => upgrade.status === "upgraded").length}`);
  for (const file of [...written, "sources/venue-upgrades.jsonl", "reports/venue-upgrade.md"]) console.log(`  + ${file}`);
}


export async function runResearchRecall(workspaceDir: string, opts: {
  topic?: string; provider?: string; limit?: string; targetCandidates?: string; queryBudget?: string; allowSeedFallback?: boolean;
}): Promise<void> {
  const { recallSources } = await import("../lib/research/pipeline.js");
  const { topic, provider, limit } = normalizeResearchOptions(opts);
  const targetCandidates = opts.targetCandidates ? Number.parseInt(opts.targetCandidates, 10) : undefined;
  const queryBudget = opts.queryBudget ? Number.parseInt(opts.queryBudget, 10) : undefined;
  if (targetCandidates !== undefined && (!Number.isInteger(targetCandidates) || targetCandidates < 1 || targetCandidates > 1_000)) {
    throw new Error("--target-candidates must be an integer from 1 to 1000");
  }
  if (queryBudget !== undefined && (!Number.isInteger(queryBudget) || queryBudget < 1 || queryBudget > 50)) {
    throw new Error("--query-budget must be an integer from 1 to 50");
  }
  const written = await recallSources({
    workspaceDir: path.resolve(workspaceDir),
    topic, provider, count: limit,
    fallbackToSeed: opts.allowSeedFallback === true,
    targetCandidates,
    queryBudget,
  });
  for (const file of written) console.log(`  + ${file}`);
}

export async function runResearchScore(workspaceDir: string): Promise<void> {
  const { scoreWorkspaceSources } = await import("../lib/research/pipeline.js");
  for (const file of await scoreWorkspaceSources(path.resolve(workspaceDir))) console.log(`  + ${file}`);
}

export async function runResearchEnrich(workspaceDir: string, opts: { maxSources?: string; enabled?: boolean } = {}): Promise<void> {
  const { enrichSourceMetadata } = await import("../lib/research/enrich.js");
  const maxSources = opts.maxSources ? Number.parseInt(opts.maxSources, 10) : undefined;
  if (maxSources !== undefined && (!Number.isInteger(maxSources) || maxSources < 1 || maxSources > 100)) {
    throw new Error("--max-sources must be an integer from 1 to 100");
  }
  const { upgrades, written } = await enrichSourceMetadata(path.resolve(workspaceDir), { maxSources, enabled: opts.enabled });
  for (const upgrade of upgrades) console.log(`  [${upgrade.status}] ${upgrade.source_id}`);
  for (const file of written) console.log(`  + ${file}`);
}

export async function runResearchClassify(workspaceDir: string, opts: { topic?: string }): Promise<void> {
  const { classifyWorkspaceSources } = await import("../lib/research/pipeline.js");
  const topic = opts.topic ?? "unspecified topic";
  for (const file of await classifyWorkspaceSources(path.resolve(workspaceDir), topic)) console.log(`  + ${file}`);
}

export async function runResearchSelectSemanticCandidates(workspaceDir: string): Promise<void> {
  const { selectSemanticCandidates } = await import("../lib/research/semantic-screen.js");
  for (const file of await selectSemanticCandidates(path.resolve(workspaceDir))) console.log(`  + ${file}`);
}

export async function runResearchRepairSemanticScreen(workspaceDir: string): Promise<void> {
  const { repairSemanticScreen } = await import("../lib/research/semantic-screen.js");
  const result = await repairSemanticScreen(path.resolve(workspaceDir));
  console.log(`semantic screen: envelope normalized: ${result.normalized ? "yes" : "no"}`);
}

export async function runResearchSelectSourceEvidenceCandidates(workspaceDir: string): Promise<void> {
  const { selectSourceEvidenceCandidates } = await import("../lib/research/semantic-screen.js");
  for (const file of await selectSourceEvidenceCandidates(path.resolve(workspaceDir))) console.log(`  + ${file}`);
}

export async function runResearchRepairSourceEvidence(workspaceDir: string): Promise<void> {
  const { repairSourceEvidencePackets } = await import("../lib/research/semantic-screen.js");
  const result = await repairSourceEvidencePackets(path.resolve(workspaceDir));
  console.log(`source evidence: envelope normalized: ${result.normalized ? "yes" : "no"}`);
}

export async function runResearchFinalizeEvidenceDepth(workspaceDir: string): Promise<void> {
  const { finalizeEvidenceBackedDepth } = await import("../lib/research/semantic-screen.js");
  for (const file of await finalizeEvidenceBackedDepth(path.resolve(workspaceDir))) console.log(`  + ${file}`);
}

const RemediationPlan = z.object({
  version: z.literal(1),
  actions: z.array(z.object({
    id: z.string(),
    weaknesses: z.array(z.object({ category: z.string(), detail: z.string() })),
  })),
}).strict();

type ExpansionPlan = z.infer<typeof RemediationPlan>;

async function readExpansionPlan(resolved: string, actionPlan?: string): Promise<ExpansionPlan> {
  const rel = actionPlan?.trim();
  if (!rel) {
    try {
      return RemediationPlan.parse(JSON.parse(await fs.readFile(path.join(resolved, "reports", "remediation-plan.json"), "utf-8")));
    } catch (error) {
      throw new Error(`research expansion requires valid reports/remediation-plan.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (path.isAbsolute(rel) || rel.split(path.sep).includes("..")) {
    throw new Error("--action-plan must be a workspace-relative path");
  }
  let plan: z.infer<typeof AgenticActionPlan>;
  try {
    plan = AgenticActionPlan.parse(JSON.parse(await fs.readFile(path.join(resolved, rel), "utf-8")));
  } catch (error) {
    throw new Error(`research expansion requires valid ${rel}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const findings = new Map(plan.findings.map((finding) => [finding.id, finding]));
  return {
    version: 1,
    actions: plan.actions
      .filter((action) => action.tool === "targeted_research_expansion")
      .map((action) => ({
        id: "research_expansion",
        weaknesses: action.finding_ids.map((id) => {
          const finding = findings.get(id);
          if (!finding) throw new Error(`research expansion action ${action.id} references unknown finding ${id}`);
          return { category: finding.severity, detail: finding.summary };
        }),
      })),
  };
}

function expansionQueries(topic: string, actions: z.infer<typeof RemediationPlan>["actions"], limit: number): string[] {
  const terms = actions.flatMap((action) => action.weaknesses.flatMap((weakness) => `${weakness.category} ${weakness.detail}`
    .toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []))
    .filter((term, index, all) => all.indexOf(term) === index)
    .filter((term) => !["citation", "coverage", "source", "sources", "missing", "review", "section"].includes(term));
  const queries = [topic];
  for (let index = 0; index < terms.length; index += 3) {
    const suffix = terms.slice(index, index + 3).join(" ");
    if (suffix) queries.push(`${topic} ${suffix}`);
  }
  return [...new Set(queries)].slice(0, limit);
}

/** Apply the research-expansion remediation action as a bounded, idempotent
 * script stage. The LLM only identifies the deficit; this command owns the
 * provider calls and source/evidence refresh. */
export async function runResearchExpand(workspaceDir: string, opts: { actionPlan?: string } = {}): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const config = await loadProjectConfig(resolved);
  const reportPath = path.join(resolved, "reports", "research-expansion.md");
  const plan = await readExpansionPlan(resolved, opts.actionPlan);
  const actions = plan.actions.filter((action) => action.id === "research_expansion" || action.id === "evidence_repair");
  if (actions.length === 0) {
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, "# Research Expansion\n\nNo coverage or evidence remediation action was requested this round.\n", "utf-8");
    console.log("No research expansion requested.");
    return;
  }
  const topic = config.research.topic;
  if (!topic) throw new Error("longwrite.yaml research.topic is required for research expansion");
  // Seed is an offline, deterministic fixture provider. Recalling it again
  // cannot improve coverage, but it can replace section packets while a
  // dry-run worker intentionally leaves chapter prose untouched. Keep the
  // existing packets stable so dry-run remains a meaningful contract test.
  if (config.research.provider === "seed") {
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, [
      "# Research Expansion", "", "No live expansion was performed: the seed provider is an offline development fixture.",
      "Existing deterministic evidence packets were retained.", "",
    ].join("\n"), "utf-8");
    console.log("Seed provider: retained deterministic evidence packets.");
    return;
  }
  const queryVariants = expansionQueries(topic, actions, config.research.query_budget);
  await fs.mkdir(path.join(resolved, "sources"), { recursive: true });
  await fs.writeFile(path.join(resolved, "sources", "search-plan.json"), `${JSON.stringify({
    version: 1,
    topic,
    query_variants: queryVariants,
    exclusion_terms: [],
    venue_priorities: [],
    source_types: ["paper", "survey", "benchmark"],
    rationale: "Targeted expansion generated from the deterministic remediation plan.",
  }, null, 2)}\n`, "utf-8");
  const pipeline = await import("../lib/research/pipeline.js");
  const enrichment = await import("../lib/research/enrich.js");
  const fulltext = await import("../lib/research/fulltext.js");
  const written: string[] = [];
  written.push(...await pipeline.recallSources({
    workspaceDir: resolved,
    topic,
    provider: config.research.provider as ResearchProviderId,
    targetCandidates: config.research.target_candidates,
    queryBudget: config.research.query_budget,
  }));
  written.push(...(await enrichment.enrichSourceMetadata(resolved, {
    maxSources: 20,
    enabled: true,
  })).written);
  written.push(...await pipeline.scoreWorkspaceSources(resolved));
  written.push(...await pipeline.classifyWorkspaceSources(resolved, topic));
  // Agentic classification is deliberately provisional.  Refresh the bounded
  // title/abstract workset now, then let the quality-loop LLM stages re-screen
  // it and rebuild full-text packets before its next review.  This keeps a
  // review-triggered literature expansion on the same semantic/evidence path
  // as the initial corpus instead of silently reverting to metadata-only A/B.
  if (config.research.semantic_screen.enabled) {
    const semantic = await import("../lib/research/semantic-screen.js");
    written.push(...await semantic.selectSemanticCandidates(resolved));
  }
  if (config.research.semantic_screen.enabled) {
    await fs.writeFile(reportPath, [
      "# Research Expansion", "", `Expanded topic: ${topic}`, `Queries: ${queryVariants.length}`, "",
      "## Triggered Actions", "", ...actions.map((action) => `- ${action.id}: ${action.weaknesses.length} finding(s)`), "",
      "## Next Evidence Refresh", "",
      "- Refreshed bounded semantic-screen candidates. The enclosing quality loop will re-screen abstracts, ingest approved full text, validate source packets, finalize A/B depth, re-run corpus gates, and reallocate section evidence before its next review.", "",
      "## Refreshed Artifacts", "", ...[...new Set(written)].map((file) => `- ${file}`), "",
    ].join("\n"), "utf-8");
    console.log(`Expanded research corpus with ${queryVariants.length} targeted query variant(s); semantic evidence refresh queued in the quality loop.`);
    return;
  }
  written.push(...(await fulltext.ingestFulltext(resolved, fetch, undefined, {
    maxSources: config.research.fulltext.max_core_sources,
    allowPdfDownload: config.research.fulltext.allow_pdf_download,
  })).written);
  const embeddingClient = config.research.retrieval.backend === "hybrid_openai"
    ? openAICompatibleEmbeddings({ model: config.research.retrieval.embedding_model })
    : undefined;
  written.push(...(await buildEvidenceIndex(resolved, { backend: config.research.retrieval.backend, embeddingClient })).written);
  const allocation = await allocateSectionEvidence(resolved, config.research.taxonomy, { embeddingClient });
  written.push(...allocation.packets, allocation.coveragePath);
  await fs.writeFile(reportPath, [
    "# Research Expansion", "", `Expanded topic: ${topic}`, `Queries: ${queryVariants.length}`, "",
    "## Triggered Actions", "", ...actions.map((action) => `- ${action.id}: ${action.weaknesses.length} finding(s)`), "",
    "## Refreshed Artifacts", "", ...[...new Set(written)].map((file) => `- ${file}`), "",
  ].join("\n"), "utf-8");
  console.log(`Expanded research corpus with ${queryVariants.length} targeted query variant(s).`);
}


export async function runResearchFulltext(workspaceDir: string, opts: { maxSources?: string; pdfDownload?: boolean; refresh?: boolean } = {}): Promise<void> {
  const { ingestFulltext } = await import("../lib/research/fulltext.js");
  const maxSources = opts.maxSources ? Number.parseInt(opts.maxSources, 10) : undefined;
  if (maxSources !== undefined && (!Number.isInteger(maxSources) || maxSources < 1 || maxSources > 200)) {
    throw new Error("--max-sources must be an integer from 1 to 200");
  }
  const { results, written } = await ingestFulltext(path.resolve(workspaceDir), fetch, undefined, {
    maxSources,
    allowPdfDownload: opts.pdfDownload !== false,
    refresh: opts.refresh === true,
  });
  for (const r of results) console.log(`  [${r.status}] ${r.sourceId}: ${r.detail}`);
  for (const file of written) console.log(`  + ${file}`);
}

export async function runResearchVerify(workspaceDir: string, opts: { maxSources?: string } = {}): Promise<void> {
  const { verifyCitedSourceUrls } = await import("../lib/research/verify.js");
  const maxSources = opts.maxSources ? Number.parseInt(opts.maxSources, 10) : undefined;
  if (maxSources !== undefined && (!Number.isInteger(maxSources) || maxSources < 1 || maxSources > 200)) {
    throw new Error("--max-sources must be an integer from 1 to 200");
  }
  const { results, written } = await verifyCitedSourceUrls(path.resolve(workspaceDir), { maxSources });
  for (const result of results) console.log(`  [${result.status}] ${result.source_id}: ${result.url}`);
  for (const file of written) console.log(`  + ${file}`);
}


/** Seed is a declared offline development fixture (see providers/seed). Its
 *  fixed tiny corpus and the dry-run runtime's placeholder artifacts cannot
 *  satisfy real quality gates. Gates therefore ENFORCE for live providers and
 *  are advisory-only on seed, so a free dry-run proves the pipeline wires
 *  end-to-end while real runs prove coverage/quality. */
async function seedProviderAdvisory(workspaceDir: string): Promise<boolean> {
  try {
    const config = await loadProjectConfig(workspaceDir);
    return config.research.provider === "seed";
  } catch {
    return false;
  }
}

async function writeCorpusGateMetrics(workspaceDir: string, report: {
  pass: boolean;
  core_source_count: number;
  source_count: number;
  recent_ratio: number;
  source_type_count: number;
}): Promise<string> {
  const metricsPath = path.join(workspaceDir, "reports", "metrics.json");
  let metrics: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await fs.readFile(metricsPath, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metrics = parsed as Record<string, unknown>;
  } catch {
    // A malformed or absent prior scorecard must not hide a fresh deterministic
    // corpus measurement. Later scoring stages own their additional metrics.
  }
  Object.assign(metrics, {
    corpus_gate_pass: report.pass ? 1 : 0,
    corpus_core_sources: report.core_source_count,
    corpus_source_count: report.source_count,
    corpus_recent_ratio: report.recent_ratio,
    corpus_source_type_count: report.source_type_count,
  });
  await fs.mkdir(path.dirname(metricsPath), { recursive: true });
  await fs.writeFile(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf-8");
  return "reports/metrics.json";
}

export async function runResearchCorpusGates(workspaceDir: string, opts: { advisory?: boolean } = {}): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const { evaluateCorpusGates, writeCorpusGateReport } = await import("../lib/research/corpus-gates.js");
  const report = await evaluateCorpusGates(resolved);
  const written = [...await writeCorpusGateReport(resolved, report), await writeCorpusGateMetrics(resolved, report)];
  console.log(`Corpus gates: ${report.pass ? "pass" : "fail"}`);
  for (const finding of report.findings) console.log(`  [${finding.pass ? "pass" : "fail"}] ${finding.detail}`);
  for (const file of written) console.log(`  + ${file}`);
  if (!report.pass && !opts.advisory) {
    // The seed provider is an offline development fixture; its tiny fixed
    // corpus can never meet breadth gates. Enforce for live providers only —
    // matching fulltext/expand, which also no-op on seed. Dry runs prove
    // plumbing; real runs prove coverage.
    if (await seedProviderAdvisory(resolved)) {
      console.log("  seed provider: breadth gates advisory only (offline dev fixture)");
      return;
    }
    process.exitCode = 1;
  }
}

/** Translate the research action-dispatch record into the numeric gate metric
 * `research_expansion_dispatched` so the compiled workflow can skip the LLM
 * evidence-refresh stages when no targeted_research_expansion actually ran.
 * Without the gate those stages are asked to "preserve" an unchanged declared
 * output, which the runtime freshness check rejects as stale — wasting a full
 * model turn per round before it self-heals by rewriting identical content.
 *
 * Fail open: when the dispatch record is missing or malformed we cannot prove
 * that no expansion ran, so we permit the refresh (a rare wasted turn) rather
 * than risk leaving newly recalled sources metadata-only. */
export async function runResearchDispatchMetrics(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  let dispatched = 1;
  try {
    const record = JSON.parse(await fs.readFile(path.join(resolved, "reports", "action-dispatch-research.json"), "utf-8")) as { executions?: unknown };
    if (Array.isArray(record.executions)) dispatched = record.executions.length > 0 ? 1 : 0;
  } catch {
    // Missing or unparseable dispatch record: fail open (see doc comment).
  }
  const metricsPath = path.join(resolved, "reports", "metrics.json");
  let metrics: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await fs.readFile(metricsPath, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metrics = parsed as Record<string, unknown>;
  } catch {
    // A malformed prior metrics snapshot must not block the fresh gate metric.
  }
  metrics.research_expansion_dispatched = dispatched;
  await fs.mkdir(path.dirname(metricsPath), { recursive: true });
  await fs.writeFile(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf-8");
  console.log(`research_expansion_dispatched = ${dispatched}`);
}

/** Validate the narrow pre-outline recovery plan.  It may select exactly one
 * allowlisted research expansion and must be grounded in the currently failed
 * deterministic corpus findings; the script never invents a remediation. */
export async function runResearchRepairCorpusRecoveryPlan(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const target = path.join(resolved, "reports", "corpus-recovery-plan.json");
  const reportPath = path.join(resolved, "reports", "corpus-recovery-plan-repair.md");
  const config = await loadProjectConfig(resolved);
  try {
    const raw = await fs.readFile(target, "utf-8");
    const trimmed = raw.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
    const plan = AgenticActionPlan.parse(JSON.parse((fenced?.[1] ?? trimmed).trim()));
    const corpus = JSON.parse(await fs.readFile(path.join(resolved, "reports", "corpus-gates.json"), "utf-8")) as {
      pass?: boolean;
      findings?: Array<{ id?: string; pass?: boolean }>;
    };
    const failedIds = new Set((corpus.findings ?? []).filter((finding) => finding.pass === false).map((finding) => finding.id).filter((id): id is string => Boolean(id)));
    if (corpus.pass || failedIds.size === 0) throw new Error("a recovery plan is valid only while a corpus gate is failing");
    if (plan.actions.length !== 1 || plan.actions[0]?.tool !== "targeted_research_expansion") {
      throw new Error("select exactly one targeted_research_expansion action");
    }
    const action = plan.actions[0]!;
    if (action.finding_ids.some((id) => !failedIds.has(id))) {
      throw new Error("recovery action may reference only currently failed corpus-gate finding IDs");
    }
    if (!action.acceptance_criteria.some((criterion) =>
      criterion.metric === "core_sources" && criterion.target >= config.research.corpus_gates.min_core_sources,
    )) {
      throw new Error(`recovery action requires core_sources >= ${config.research.corpus_gates.min_core_sources}`);
    }
    await fs.writeFile(target, `${JSON.stringify(plan, null, 2)}\n`, "utf-8");
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, [
      "# Corpus evidence recovery-plan validation", "", "- Status: pass",
      `- Failed findings addressed: ${action.finding_ids.join(", ")}`,
      `- Required core sources: ${config.research.corpus_gates.min_core_sources}`,
      "- Dispatch: one bounded targeted_research_expansion action", "",
    ].join("\n"), "utf-8");
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, [
      "# Corpus evidence recovery-plan validation", "", "- Status: failed", `- Detail: ${detail}`,
      "- Required repair: write exactly one AgenticActionPlan JSON object with one targeted_research_expansion action, using only currently failed corpus-gate finding IDs and core_sources as a measurable acceptance criterion.", "",
    ].join("\n"), "utf-8");
    throw new Error("reports/corpus-recovery-plan.json: invalid bounded corpus recovery plan; see reports/corpus-recovery-plan-repair.md");
  }
}

/** Validate a final-release remediation plan against the actual failed
 * release checks.  It never relaxes a gate: the LLM may choose an allowlisted
 * corrective action, while this adapter makes sure every current failure is
 * explicitly owned before the recovery loop spends another round. */
export async function runResearchRepairFinalReleasePlan(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const target = path.join(resolved, "reviews", "action-plan.json");
  const reportPath = path.join(resolved, "reports", "final-release-plan-repair.md");
  try {
    const plan = AgenticActionPlan.parse(JSON.parse(await fs.readFile(target, "utf-8")));
    const validation = JSON.parse(await fs.readFile(path.join(resolved, "reports", "longwrite-validation.json"), "utf-8")) as {
      pass?: boolean;
      checks?: Array<{ id?: string; pass?: boolean }>;
    };
    const failedIds = new Set((validation.checks ?? [])
      .filter((check) => check.pass === false)
      .map((check) => check.id)
      .filter((id): id is string => Boolean(id)));
    if (validation.pass || failedIds.size === 0) {
      if (plan.actions.length !== 0) throw new Error("a final-release plan must be empty when all release checks pass");
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(reportPath, "# Final-release plan validation\n\n- Status: pass\n- No failed release checks require recovery.\n", "utf-8");
      return;
    }
    if (plan.actions.length === 0) throw new Error("failed release checks require one or more corrective actions");
    const allowedTools = new Set(["targeted_research_expansion", "reopen_outline", "revise_sections", "revise_visual_plan", "request_operator_clarification"]);
    const addressed = new Set<string>();
    for (const action of plan.actions) {
      if (!allowedTools.has(action.tool)) throw new Error(`action ${action.id} selects unsupported final-release tool ${action.tool}`);
      for (const findingId of action.finding_ids) {
        if (!failedIds.has(findingId)) throw new Error(`action ${action.id} references non-failed release check ${findingId}`);
        addressed.add(findingId);
      }
    }
    const missing = [...failedIds].filter((id) => !addressed.has(id));
    if (missing.length > 0) throw new Error(`final-release plan does not address failed checks: ${missing.join(", ")}`);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, [
      "# Final-release plan validation", "", "- Status: pass",
      `- Failed checks addressed: ${[...failedIds].join(", ")}`,
      `- Selected actions: ${plan.actions.map((action) => action.tool).join(", ")}`, "",
    ].join("\n"), "utf-8");
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, [
      "# Final-release plan validation", "", "- Status: failed", `- Detail: ${detail}`,
      "- Required repair: use only the currently failed IDs in reports/longwrite-validation.json, select allowlisted corrective actions, and cover every failed release check without lowering a gate.", "",
    ].join("\n"), "utf-8");
    throw new Error("reviews/action-plan.json: invalid final-release recovery plan; see reports/final-release-plan-repair.md");
  }
}

export async function runResearchReconcileIdentities(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const { reconcileWorkspaceSources } = await import("../lib/research/identity.js");
  const { records, written } = await reconcileWorkspaceSources(resolved);
  console.log(`Reconciled source identities: ${records.length}`);
  for (const file of written) console.log(`  + ${file}`);
}

export async function runResearchSurveyContract(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const { evaluateSurveyContract } = await import("../lib/research/survey-contract.js");
  const { report, written } = await evaluateSurveyContract(resolved);
  console.log(`Survey contract: ${report.pass ? "pass" : "fail"}`);
  for (const finding of report.findings) console.log(`  [${finding.pass ? "pass" : "fail"}] ${finding.detail}`);
  for (const file of written) console.log(`  + ${file}`);
  if (!report.pass) {
    if (await seedProviderAdvisory(resolved)) {
      console.log("  seed provider: survey contract advisory only (offline dev fixture)");
      return;
    }
    process.exitCode = 1;
  }
}

async function readJsonlIds(absPath: string): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(absPath, "utf-8");
    return new Set(raw.split("\n").filter(Boolean).map((line) => {
      const parsed = JSON.parse(line) as { id?: unknown; source_id?: unknown };
      return String(parsed.id ?? parsed.source_id ?? "");
    }).filter(Boolean));
  } catch {
    return new Set();
  }
}

export async function runResearchRefresh(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const config = await loadProjectConfig(resolved);
  if (!config.research.topic) throw new Error("longwrite.yaml research.topic is required for refresh");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveDir = path.join(resolved, "sources", "archive", stamp);
  await fs.mkdir(archiveDir, { recursive: true });
  const oldIds = await readJsonlIds(path.join(resolved, "sources", "classified_sources.jsonl"));
  for (const rel of ["raw_results.jsonl", "deduped_sources.jsonl", "scored_sources.jsonl", "classified_sources.jsonl", "bibliography.bib", "citation_plan.jsonl"]) {
    await fs.copyFile(path.join(resolved, "sources", rel), path.join(archiveDir, rel)).catch(() => {});
  }
  const pipeline = await import("../lib/research/pipeline.js");
  const written: string[] = [];
  written.push(...await pipeline.recallSources({
    workspaceDir: resolved,
    topic: config.research.topic,
    provider: config.research.provider as ResearchProviderId,
    targetCandidates: config.research.target_candidates,
    queryBudget: config.research.query_budget,
  }));
  written.push(...await pipeline.scoreWorkspaceSources(resolved));
  written.push(...await pipeline.classifyWorkspaceSources(resolved, config.research.topic));
  const newIds = await readJsonlIds(path.join(resolved, "sources", "classified_sources.jsonl"));
  const added = [...newIds].filter((id) => !oldIds.has(id));
  const removed = [...oldIds].filter((id) => !newIds.has(id));
  await fs.mkdir(path.join(resolved, "reports"), { recursive: true });
  const report = [
    "# Literature Refresh Delta",
    "",
    `Archived previous corpus: sources/archive/${stamp}/`,
    `Added sources: ${added.length}`,
    `Removed sources: ${removed.length}`,
    "",
    "## Reopen Plan",
    "",
    "- retrieval/corpus stages: recall, snowball_recall, enrich, venue_upgrade, score, classify, identity_reconcile, corpus_gates",
    "- evidence stages: fulltext, evidence_index, allocate_evidence",
    "- structure stages: outline, survey_contract, structure_audit",
    "- review stages: quality_loop, verify_citations, assess, final_validate",
    "",
    "## Added",
    "",
    ...added.slice(0, 100).map((id) => `- ${id}`),
    "",
    "## Removed",
    "",
    ...removed.slice(0, 100).map((id) => `- ${id}`),
    "",
  ].join("\n");
  await fs.writeFile(path.join(resolved, "reports", "literature-refresh-delta.md"), report, "utf-8");
  console.log(`Refreshed literature corpus. Added ${added.length}, removed ${removed.length}.`);
  for (const file of [...written, "reports/literature-refresh-delta.md"]) console.log(`  + ${file}`);
}
