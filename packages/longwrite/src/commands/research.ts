import path from "node:path";
import { createHash } from "node:crypto";
import { prepareResearchWorkspace } from "../lib/research/pipeline.js";
import { assessResearchWorkspace, writeResearchAssessment } from "../lib/ops/research-quality.js";
import { providerById, type ResearchProviderId } from "../lib/research/providers.js";
import { loadProjectConfig } from "../lib/project-config.js";
import { buildEvidenceIndex, allocateSectionEvidence } from "../lib/research/evidence.js";
import { openAICompatibleEmbeddings } from "../lib/research/embeddings.js";
import { z } from "zod";
import fs from "node:fs/promises";
import { snowballWorkspace } from "../lib/research/snowball.js";
import { AgenticActionPlan, enrichFinalReleaseActionPlan, evidenceCapacity, gateAcceptanceCriterion } from "../lib/ops/action-plan.js";
import { prepareCodebases } from "../lib/research/codebase.js";
import { discoverGithubCodebases, repairGithubCodebaseSelection } from "../lib/research/github-codebase-discovery.js";
import { importLongExperiment, prepareExperimentEvidence } from "../lib/research/experiment.js";
import { repairCodebaseAnalysis } from "../lib/research/codebase-analysis.js";
import { repairCodebaseComparison } from "../lib/research/codebase-comparison.js";
import { loadSearchPlan, type SearchPlan } from "../lib/research/search-plan.js";
import { gateOwnedByTool, repairRouteForGate } from "../lib/ops/repair-routing.js";
import type { ClassifiedSource } from "../lib/research/types.js";

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

export async function runResearchBackfillValidatedEvidenceHistory(workspaceDir: string): Promise<void> {
  const { backfillValidatedEvidenceHistory } = await import("../lib/research/semantic-screen.js");
  const result = await backfillValidatedEvidenceHistory(path.resolve(workspaceDir));
  console.log(`validated evidence history: recovered ${result.recovered} packet record(s); cumulative total ${result.total}`);
  console.log(`  + ${result.reportPath}`);
}

export async function runResearchRestoreRecoveryCorpus(workspaceDir: string): Promise<void> {
  const { restoreRecoveryCorpusFromCheckpoints } = await import("../lib/research/semantic-screen.js");
  const result = await restoreRecoveryCorpusFromCheckpoints(path.resolve(workspaceDir));
  console.log(`recovery corpus: restored ${result.restored} checkpoint source record(s); durable total ${result.total}`);
  console.log(`  + ${result.reportPath}`);
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

export type ExpansionAction = ExpansionPlan["actions"][number] & {
  source_action_id?: string;
  rationale?: string;
  acceptance_criteria?: Array<{
    metric: string;
    target: number;
    scope?: string;
  }>;
};

type ExpansionRequest = {
  version: 1;
  actions: ExpansionAction[];
};

async function readExpansionPlan(resolved: string, actionPlan?: string): Promise<ExpansionRequest> {
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
        source_action_id: action.id,
        rationale: action.rationale,
        acceptance_criteria: action.acceptance_criteria,
        weaknesses: action.finding_ids.map((id) => {
          const finding = findings.get(id);
          if (!finding) throw new Error(`research expansion action ${action.id} references unknown finding ${id}`);
          return { category: finding.severity, detail: finding.summary };
        }),
      })),
  };
}

const EXPANSION_STOP_WORDS = new Set([
  "accepted", "action", "also", "and", "are", "backed", "before", "but", "cannot", "citation", "citations", "cited",
  "close", "concrete", "configured", "coverage", "critical", "current", "deterministic", "evidence", "expose", "exposes",
  "failed", "failing", "final", "finding", "from", "gap", "gate", "gates", "into", "its", "literature", "major", "meet",
  "minimum", "missing", "needs", "only", "packet", "packet-backed", "packets", "prose", "ratio", "release", "reports",
  "required", "requires", "retrieve", "revising", "review", "section", "source", "sources", "target", "that", "the", "their",
  "this", "those", "validation", "with", "work",
]);

function boundedTerms(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [])
    .flatMap((term) => term.split("-").filter(Boolean))
    .filter((term) => /^[a-z]/.test(term))
    .filter((term) => !EXPANSION_STOP_WORDS.has(term));
}

/** Build a durable identity for one concrete evidence deficit. Reopening the
 * same recovery continues its next bounded query batch; a changed deficit,
 * section scope, or acceptance target receives an independent checkpoint. */
export function expansionIntentKey(topic: string, actions: ExpansionAction[]): string {
  const normalized = actions.map((action) => ({
    id: action.source_action_id ?? action.id,
    rationale: action.rationale ?? "",
    weaknesses: action.weaknesses,
    acceptance_criteria: action.acceptance_criteria ?? [],
  }));
  return createHash("sha256").update(JSON.stringify({ topic, actions: normalized })).digest("hex").slice(0, 20);
}

/** Translate an LLM-selected deficit into bounded scholarly-search queries.
 * Intellectual diagnosis stays with the planner; this adapter retains that
 * diagnosis and adds mechanical qualifiers implied by measurable criteria. */
export function buildExpansionQueries(
  topic: string,
  actions: ExpansionAction[],
  taxonomy: string[],
  venuePriorities: string[],
  limit: number,
  exactLandmarkTitles: string[] = [],
): string[] {
  const criteria = actions.flatMap((action) => action.acceptance_criteria ?? []);
  const acceptedRequired = criteria.some((criterion) => criterion.metric === "accepted_cited_ratio" && criterion.target > 0);
  const citedSourcesRequired = criteria.some((criterion) => criterion.metric === "cited_sources" && criterion.target > 0);
  // Exact missing landmark titles come first. The old adapter tokenized a
  // 30-title finding into generic four-word chunks, retrieving unrelated
  // papers with overlapping acronyms instead of the named canonical works.
  const queries: string[] = exactLandmarkTitles.map((title) => title.replace(/\s+/g, " ").trim()).filter(Boolean);

  for (const criterion of criteria) {
    if (criterion.metric === "accepted_cited_ratio") {
      queries.push(`${topic} peer reviewed conference journal proceedings`);
    } else if (criterion.metric === "cited_sources") {
      queries.push(`${topic} systematic survey benchmark empirical evaluation`);
    } else if (criterion.metric === "citation_depth_per_section") {
      queries.push(`${topic} ${criterion.scope ?? "mechanism evaluation"}`);
    } else if (criterion.scope) {
      queries.push(`${topic} ${criterion.scope}`);
    }
  }

  const contextTerms = actions.flatMap((action) => [
    ...boundedTerms(action.rationale ?? ""),
    ...action.weaknesses.flatMap((weakness) => boundedTerms(weakness.detail)),
    ...(action.acceptance_criteria ?? []).flatMap((criterion) => boundedTerms(criterion.scope ?? "")),
  ])
    .filter((term, index, all) => all.indexOf(term) === index)
    .slice(0, 32);
  for (let index = 0; index < contextTerms.length; index += 4) {
    const suffix = contextTerms.slice(index, index + 4).join(" ");
    if (suffix) queries.push(`${topic} ${suffix}`);
  }

  const publicationQualifier = acceptedRequired ? " peer reviewed" : "";
  for (const cell of taxonomy) queries.push(`${topic} ${cell}${publicationQualifier}`);
  if (acceptedRequired) {
    for (const venue of venuePriorities.slice(0, 6)) queries.push(`${topic} ${venue} proceedings`);
  }
  if (citedSourcesRequired && queries.length === 0) queries.push(`${topic} survey`);
  return [...new Set(queries.map((query) => query.replace(/\s+/g, " ").trim()))].slice(0, limit);
}

/** Preserve the original taxonomy query groups during targeted recovery.
 * Recovery used to replace the search plan with generic failure prose, which
 * made the next bounded recall forget the declared coverage program. */
export function buildExpansionSearchPlan(
  topic: string,
  expansion: string[],
  taxonomy: string[],
  previous?: SearchPlan,
): SearchPlan {
  const taxonomy_cells = previous?.taxonomy_cells.length
    ? previous.taxonomy_cells
    : taxonomy.map((cell) => ({
      cell,
      query_variants: [cell, `${topic} ${cell}`, `${cell} survey`],
    }));
  return {
    version: 1,
    topic,
    query_variants: [...new Set([...(previous?.query_variants ?? []), ...expansion])].slice(0, 50),
    taxonomy_cells,
    exclusion_terms: previous?.exclusion_terms ?? [],
    venue_priorities: previous?.venue_priorities ?? [],
    source_types: previous?.source_types.length ? previous.source_types : ["paper", "survey", "benchmark"],
    rationale: "Targeted expansion preserves the original taxonomy coverage program and adds remediation queries.",
  };
}

type ExpansionCheckpoint = {
  version: 2;
  intents: Record<string, {
    action_ids: string[];
    completed_queries: string[];
    updated_at: string;
  }>;
  migrated_legacy_queries?: string[];
  updated_at: string;
};

const EXPANSION_CHECKPOINT_PATH = "reports/research-expansion-checkpoint.json";

async function loadExpansionCheckpoint(workspaceDir: string): Promise<ExpansionCheckpoint> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(workspaceDir, EXPANSION_CHECKPOINT_PATH), "utf-8")) as {
      version?: unknown;
      intents?: unknown;
      completed_queries?: unknown;
      updated_at?: unknown;
    };
    if (parsed.version === 2 && parsed.intents && typeof parsed.intents === "object" && !Array.isArray(parsed.intents)) {
      const intents: ExpansionCheckpoint["intents"] = {};
      for (const [key, raw] of Object.entries(parsed.intents as Record<string, unknown>)) {
        if (!raw || typeof raw !== "object") continue;
        const entry = raw as { action_ids?: unknown; completed_queries?: unknown; updated_at?: unknown };
        if (!Array.isArray(entry.completed_queries) || !entry.completed_queries.every((value) => typeof value === "string")) continue;
        intents[key] = {
          action_ids: Array.isArray(entry.action_ids) ? entry.action_ids.filter((value): value is string => typeof value === "string") : [],
          completed_queries: [...new Set(entry.completed_queries)],
          updated_at: typeof entry.updated_at === "string" ? entry.updated_at : new Date(0).toISOString(),
        };
      }
      return { version: 2, intents, updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : new Date(0).toISOString() };
    }
    if (parsed.version === 1 && Array.isArray(parsed.completed_queries) && parsed.completed_queries.every((value) => typeof value === "string")) {
      // V1 was global and therefore could suppress unrelated future deficits.
      // Preserve it for provenance, but do not attach it to a new intent.
      return {
        version: 2,
        intents: {},
        migrated_legacy_queries: [...new Set(parsed.completed_queries)],
        updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : new Date(0).toISOString(),
      };
    }
  } catch {
    // A missing checkpoint starts a new bounded expansion; a malformed one is
    // not trusted and therefore cannot silently suppress retrieval work.
  }
  return { version: 2, intents: {}, updated_at: new Date(0).toISOString() };
}

async function writeExpansionCheckpoint(workspaceDir: string, checkpoint: ExpansionCheckpoint): Promise<void> {
  const target = path.join(workspaceDir, EXPANSION_CHECKPOINT_PATH);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf-8");
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
  const previousLoad = await loadSearchPlan(resolved);
  const previousPlan = previousLoad.present && previousLoad.ok ? previousLoad.plan : undefined;
  let exactLandmarkTitles: string[] = [];
  if (actions.some((action) => (action.acceptance_criteria ?? []).some((criterion) => criterion.metric === "landmark_coverage_ratio"))) {
    try {
      const [{ LandmarkCandidates, matchLandmarksToCorpus }, classifiedRaw, landmarkRaw] = await Promise.all([
        import("../lib/research/landmark.js"),
        fs.readFile(path.join(resolved, "sources", "classified_sources.jsonl"), "utf-8"),
        fs.readFile(path.join(resolved, "research", "landmark-candidates.json"), "utf-8"),
      ]);
      const candidates = LandmarkCandidates.parse(JSON.parse(landmarkRaw)).candidates
        .filter((candidate) => candidate.confidence !== "low")
        .slice(0, config.research.corpus_gates.max_landmark_candidates);
      const sources = classifiedRaw.split("\n").filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line) as ClassifiedSource]; } catch { return []; }
      }).filter((source) => source.citation_depth === "A" || source.citation_depth === "B");
      const matches = matchLandmarksToCorpus(candidates, sources);
      exactLandmarkTitles = matches.filter((match) => match.matchedSourceId === null).map((match) => match.candidate);
    } catch {
      // Fall back to the bounded diagnostic terms when the optional landmark
      // artifact is unavailable; expansion remains useful for other gates.
    }
  }
  const queryVariants = buildExpansionQueries(topic, actions, config.research.taxonomy, previousPlan?.venue_priorities ?? [], config.research.query_budget, exactLandmarkTitles);
  const checkpoint = await loadExpansionCheckpoint(resolved);
  const intentKey = expansionIntentKey(topic, actions);
  const intent = checkpoint.intents[intentKey] ?? {
    action_ids: actions.map((action) => action.source_action_id ?? action.id),
    completed_queries: [],
    updated_at: new Date(0).toISOString(),
  };
  // The checkpoint is deliberately cumulative across recovery rounds.  Report
  // progress relative to this request, though: otherwise a prior round's
  // completed queries can yield misleading counters such as "36/24".
  const completedThisRequest = queryVariants.filter((query) => intent.completed_queries.includes(query));
  const pendingQueries = queryVariants.filter((query) => !intent.completed_queries.includes(query));
  const batch = pendingQueries.slice(0, config.research.expansion.max_queries_per_run);
  // Execute only fresh targeted queries. The previous implementation wrote
  // the entire historical plan then recalled up to the global 50-query budget,
  // turning a small remediation request into a full corpus rebuild.
  const expansionPlan = buildExpansionSearchPlan(topic, batch, config.research.taxonomy, previousPlan);
  expansionPlan.query_variants = batch;
  await fs.mkdir(path.join(resolved, "sources"), { recursive: true });
  await fs.writeFile(path.join(resolved, "sources", "search-plan.json"), `${JSON.stringify(expansionPlan, null, 2)}\n`, "utf-8");
  if (batch.length === 0) {
    await fs.writeFile(reportPath, [
      "# Research Expansion", "", "All currently targeted query variants are already checkpointed.",
      "Use the existing validated corpus for manuscript repair; a new expansion requires a genuinely new evidence gap.", "",
      `- Checkpoint: ${EXPANSION_CHECKPOINT_PATH}`,
      `- Deficit intent: ${intentKey}`,
      `- Completed queries for this deficit: ${intent.completed_queries.length}`,
    ].join("\n"), "utf-8");
    console.log("Research expansion is already checkpointed; no provider calls made.");
    return;
  }
  const pipeline = await import("../lib/research/pipeline.js");
  const enrichment = await import("../lib/research/enrich.js");
  const fulltext = await import("../lib/research/fulltext.js");
  const written: string[] = [];
  console.log(`[research-expansion] batch ${completedThisRequest.length + 1}-${completedThisRequest.length + batch.length} of ${queryVariants.length}; ${batch.length} query variant(s), target ${config.research.expansion.target_candidates} candidates.`);
  written.push(...await pipeline.recallSources({
    workspaceDir: resolved,
    topic,
    provider: config.research.provider as ResearchProviderId,
    targetCandidates: config.research.expansion.target_candidates,
    queryBudget: batch.length,
    // Recovery batches must execute the just-derived deficit queries, not the
    // taxonomy variants that are intentionally retained in search-plan.json
    // for provenance and future normal recall.
    queries: batch,
    mergeExisting: true,
    providerFactory: (id) => providerById(id, {
      timeoutMs: config.research.expansion.provider_timeout_seconds * 1_000,
      onProgress: ({ provider, outcome, sources, error }) => {
        console.log(`[research-expansion] provider=${provider} outcome=${outcome}${sources === undefined ? "" : ` sources=${sources}`}${error ? ` error=${error}` : ""}`);
      },
    }),
  }));
  intent.completed_queries = [...new Set([...intent.completed_queries, ...batch])];
  intent.updated_at = new Date().toISOString();
  checkpoint.intents[intentKey] = intent;
  checkpoint.updated_at = new Date().toISOString();
  await writeExpansionCheckpoint(resolved, checkpoint);
  const completedAfterThisRequest = queryVariants.filter((query) => intent.completed_queries.includes(query)).length;
  const cumulativeQueries = Object.values(checkpoint.intents).reduce((sum, entry) => sum + entry.completed_queries.length, 0);
  console.log(`[research-expansion] checkpoint saved: ${completedAfterThisRequest}/${queryVariants.length} query variant(s) for deficit ${intentKey}; ${cumulativeQueries} cumulative across intents.`);
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
      "# Research Expansion", "", `Expanded topic: ${topic}`, `Deficit intent: ${intentKey}`, `Queries this batch: ${batch.length}`, `Targeted queries checkpointed for this deficit: ${completedAfterThisRequest}/${queryVariants.length}`, `Cumulative targeted queries checkpointed: ${cumulativeQueries}`, `Provider timeout: ${config.research.expansion.provider_timeout_seconds}s`, "",
      "## Triggered Actions", "", ...actions.map((action) => `- ${action.id}: ${action.weaknesses.length} finding(s)`), "",
      "## Next Evidence Refresh", "",
      "- Refreshed bounded semantic-screen candidates. The enclosing quality loop will re-screen abstracts, ingest approved full text, validate source packets, finalize A/B depth, re-run corpus gates, and reallocate section evidence before its next review.", "",
      "## Refreshed Artifacts", "", ...[...new Set([...written, EXPANSION_CHECKPOINT_PATH])].map((file) => `- ${file}`), "",
    ].join("\n"), "utf-8");
    console.log(`Expanded research corpus with ${batch.length} targeted query variant(s); semantic evidence refresh queued in the quality loop.`);
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

export async function runResearchVerify(workspaceDir: string, opts: { maxSources?: string; section?: string } = {}): Promise<void> {
  const { verifyCitedSourceUrls } = await import("../lib/research/verify.js");
  const maxSources = opts.maxSources ? Number.parseInt(opts.maxSources, 10) : undefined;
  if (maxSources !== undefined && (!Number.isInteger(maxSources) || maxSources < 1 || maxSources > 200)) {
    throw new Error("--max-sources must be an integer from 1 to 200");
  }
  const { results, written } = await verifyCitedSourceUrls(path.resolve(workspaceDir), { maxSources, section: opts.section });
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

/** Translate the split action plans and research dispatch record into numeric
 * gate metrics so the compiled workflow can skip work whose inputs did not
 * change this round. `research_expansion_dispatched` controls corpus refresh;
 * `manuscript_revision_planned` controls fresh claim judging.
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
    if (Array.isArray(record.executions)) {
      dispatched = record.executions.some((entry) => entry && typeof entry === "object" && (entry as { status?: unknown }).status === "succeeded") ? 1 : 0;
    }
  } catch {
    // Missing or unparseable dispatch record: fail open (see doc comment).
  }
  let manuscriptRevisionPlanned = 1;
  try {
    const revisionPlan = JSON.parse(await fs.readFile(path.join(resolved, "reviews", "revision-action-plan.json"), "utf-8")) as {
      actions?: unknown;
    };
    if (Array.isArray(revisionPlan.actions)) {
      manuscriptRevisionPlanned = revisionPlan.actions.some((entry) =>
        entry && typeof entry === "object" && (entry as { tool?: unknown }).tool === "revise_sections") ? 1 : 0;
    }
  } catch {
    // Fail open: an unavailable split plan must not suppress claim review.
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
  metrics.manuscript_revision_planned = manuscriptRevisionPlanned;
  await fs.mkdir(path.dirname(metricsPath), { recursive: true });
  await fs.writeFile(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf-8");
  console.log(`research_expansion_dispatched = ${dispatched}`);
  console.log(`manuscript_revision_planned = ${manuscriptRevisionPlanned}`);
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
    if ((corpus.findings ?? []).some((finding) => finding.pass === false && typeof finding.id !== "string")) {
      throw new Error("corpus-gate report contains a failed finding without a string id");
    }
    const failedIds = new Set((corpus.findings ?? []).filter((finding) => finding.pass === false).map((finding) => finding.id).filter((id): id is string => typeof id === "string"));
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
    // A clarification-only plan is normally invalid because deterministic
    // failures must receive an executable owner. The one exception is the
    // typed circuit breaker emitted after two mechanically confirmed stalled
    // rounds. Validate that exception before enrichment, which otherwise
    // correctly restores the mandatory executable action.
    const rawPlan = AgenticActionPlan.parse(JSON.parse(await fs.readFile(target, "utf-8")));
    const metrics = await fs.readFile(path.join(resolved, "reports", "metrics.json"), "utf-8")
      .then((raw) => JSON.parse(raw) as Record<string, unknown>).catch(() => ({} as Record<string, unknown>));
    const stalledClarification = rawPlan.actions.length === 1
      && rawPlan.actions[0]?.id === "repair-stalled-operator-decision"
      && rawPlan.actions[0].tool === "request_operator_clarification"
      && typeof metrics.repair_stalled_rounds === "number"
      && metrics.repair_stalled_rounds >= 2;
    if (stalledClarification) {
      const validation = JSON.parse(await fs.readFile(path.join(resolved, "reports", "longwrite-validation.json"), "utf-8")) as {
        pass?: boolean; checks?: Array<{ id?: string; pass?: boolean }>;
      };
      const failedIds = (validation.checks ?? []).filter((check) => check.pass === false)
        .map((check) => check.id).filter((id): id is string => typeof id === "string");
      const actionIds = new Set(rawPlan.actions[0]!.finding_ids);
      if (validation.pass || failedIds.length === 0 || failedIds.some((id) => !actionIds.has(id)) || actionIds.size !== failedIds.length) {
        throw new Error("stalled repair clarification must exactly cover all currently failed release checks");
      }
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(reportPath, [
        "# Final-release plan validation", "", "- Status: pass",
        `- Circuit breaker: ${metrics.repair_stalled_rounds} consecutive wholly stalled repair rounds`,
        `- Failed checks awaiting an operator decision: ${failedIds.join(", ")}`,
        "- Selected action: request_operator_clarification", "",
      ].join("\n"), "utf-8");
      return;
    }
    await enrichFinalReleaseActionPlan(resolved);
    const plan = AgenticActionPlan.parse(JSON.parse(await fs.readFile(target, "utf-8")));
    const validation = JSON.parse(await fs.readFile(path.join(resolved, "reports", "longwrite-validation.json"), "utf-8")) as {
      pass?: boolean;
      checks?: Array<{ id?: string; pass?: boolean; findings?: unknown }>;
    };
    if ((validation.checks ?? []).some((check) => check.pass === false && typeof check.id !== "string")) {
      throw new Error("final-release validation contains a failed check without a string id");
    }
    const failedIds = new Set((validation.checks ?? [])
      .filter((check) => check.pass === false)
      .map((check) => check.id)
      .filter((id): id is string => typeof id === "string"));
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
    const ownershipMissing = [...failedIds].filter((id) => !plan.actions.some((action) =>
      action.tool !== "request_operator_clarification"
      && action.finding_ids.includes(id)
      && gateOwnedByTool(id, action.tool)));
    if (ownershipMissing.length > 0) {
      throw new Error(`final-release plan assigns no compatible repair capability to: ${ownershipMissing.join(", ")}`);
    }
    // An outline is a planning artifact and an evidence expansion only makes
    // new material available.  Neither changes the rendered manuscript on
    // its own.  Require a prose revision to explicitly own failures whose
    // deterministic remedy is woven, evidence-backed manuscript content.
    // Without this, a plausible-looking plan can spend a recovery round on
    // retrieval or an outline refresh and then re-run the exact same paper.
    const proseOwned = new Set(plan.actions
      .filter((action) => action.tool === "revise_sections")
      .flatMap((action) => action.finding_ids));
    const visuallyOwnedReviewTarget = failedIds.has("rendered_visual_review") && plan.actions.some((action) =>
      action.tool === "revise_visual_plan" && action.finding_ids.includes("review_target")
      && action.acceptance_criteria.some((criterion) => criterion.metric === "review_score" && criterion.target >= 8));
    const proseRequired = [...failedIds].filter((id) => repairRouteForGate(id).preferred === "revise_sections"
      && !(id === "review_target" && visuallyOwnedReviewTarget));
    const proseMissing = proseRequired.filter((id) => !proseOwned.has(id));
    if (proseMissing.length > 0) {
      throw new Error(`final-release plan must assign revise_sections to: ${proseMissing.join(", ")}`);
    }
    const proseAction = plan.actions.find((action) => action.tool === "revise_sections");
    if (proseAction) {
      const citedText = (validation.checks?.find((check) => check.id === "cited_literature_release_gates")?.findings as unknown[] | undefined)
        ?.filter((finding): finding is string => typeof finding === "string").join(" ") ?? "";
      const hasCriterion = (metric: AgenticActionPlan["actions"][number]["acceptance_criteria"][number]["metric"], target: number) =>
        proseAction.acceptance_criteria.some((criterion) => criterion.metric === metric && criterion.target >= target);
      if (/cited sources .*below configured minimum|accepted cited-source ratio .*below configured/i.test(citedText)) {
        const config = await loadProjectConfig(resolved);
        if (/cited sources .*below configured minimum/i.test(citedText)
          && !hasCriterion("cited_sources", config.research.release_gates.min_cited_sources)) {
          throw new Error(`final-release prose repair requires cited_sources >= ${config.research.release_gates.min_cited_sources}`);
        }
        if (/accepted cited-source ratio .*below configured/i.test(citedText)
          && !hasCriterion("accepted_cited_ratio", config.research.release_gates.min_accepted_cited_ratio)) {
          throw new Error(`final-release prose repair requires accepted_cited_ratio >= ${config.research.release_gates.min_accepted_cited_ratio}`);
        }
      }
      if (failedIds.has("review_target") && !hasCriterion("review_score", 8)) {
        throw new Error("final-release prose repair requires review_score >= 8");
      }
    }
    // A clarification is a genuine human-decision escape hatch, not a way to
    // acknowledge a deterministic, repairable release failure while doing no
    // repair.  If the plan can name a normal bounded action, it must do so;
    // in particular table/figure rendering failures always require the
    // durable visual-plan action, never a waiver or a clarification-only
    // round.
    const executable = plan.actions.filter((action) => action.tool !== "request_operator_clarification");
    if (executable.length === 0) {
      throw new Error("final-release plan cannot use request_operator_clarification as its only corrective action");
    }
    const visualMissing = [...failedIds].filter((id) => repairRouteForGate(id).preferred === "revise_visual_plan"
      && !plan.actions.some((action) => action.tool === "revise_visual_plan" && action.finding_ids.includes(id)));
    if (visualMissing.length > 0) throw new Error(`final-release plan must assign revise_visual_plan to: ${visualMissing.join(", ")}`);
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

/** Produce the bounded, mechanical part of a final-release recovery plan.
 *
 * The release validator already identifies the failed gate IDs and the
 * dispatcher owns the only safe repair tools. Asking a model to restate that
 * mapping made the final recovery loop depend on a second whole-paper read;
 * on large manuscripts that decision can time out repeatedly without doing
 * any repair. This generator deliberately makes no quality judgement. It
 * records every failed gate and routes it to the minimal executable repair;
 * the subsequent independent reviews and release validator still decide
 * whether the repair actually worked. */
export async function runResearchGenerateFinalReleasePlan(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const config = await loadProjectConfig(resolved);
  const validationPath = path.join(resolved, "reports", "longwrite-validation.json");
  const validation = JSON.parse(await fs.readFile(validationPath, "utf-8")) as {
    pass?: unknown;
    checks?: Array<{ id?: unknown; pass?: unknown; detail?: unknown; finding?: unknown; findings?: unknown }>;
  };
  if ((validation.checks ?? []).some((check) => check.pass === false && typeof check.id !== "string")) {
    throw new Error("final-release validation contains a failed check without a string id");
  }
  const failed = (validation.checks ?? []).filter((check): check is { id: string; pass?: unknown; detail?: unknown; finding?: unknown; findings?: unknown } =>
    check.pass === false && typeof check.id === "string",
  );
  const failedIds = failed.map((check) => check.id);
  const priorMetrics = await fs.readFile(path.join(resolved, "reports", "metrics.json"), "utf-8")
    .then((raw) => JSON.parse(raw) as Record<string, unknown>).catch(() => ({} as Record<string, unknown>));
  const stalledRounds = typeof priorMetrics.repair_stalled_rounds === "number" ? priorMetrics.repair_stalled_rounds : 0;
  type ReviewWeakness = { category: string; detail: string; severity: "critical" | "major" | "minor" };
  type ReviewScorecard = { personas?: Array<{ id?: unknown; weaknesses?: Array<{ category?: unknown; detail?: unknown; severity?: unknown }> }> };
  let scorecard: ReviewScorecard = {};
  try {
    scorecard = JSON.parse(await fs.readFile(path.join(resolved, "reviews", "scorecard.json"), "utf-8")) as ReviewScorecard;
  } catch {
    // A missing scorecard cannot hide deterministic gate findings; it merely
    // means there are no additional reviewer-specific repairs to route.
  }
  const weaknessMap = new Map<string, ReviewWeakness>();
  for (const persona of scorecard.personas ?? []) {
    for (const weakness of persona.weaknesses ?? []) {
      if (typeof weakness.category !== "string" || typeof weakness.detail !== "string") continue;
      const severity: ReviewWeakness["severity"] = weakness.severity === "critical" || weakness.severity === "minor" ? weakness.severity : "major";
      weaknessMap.set(`${weakness.category}\u0000${weakness.detail}`, { category: weakness.category, detail: weakness.detail, severity });
    }
  }
  const severityRank: Record<ReviewWeakness["severity"], number> = { critical: 0, major: 1, minor: 2 };
  const reviewWeaknesses = [...weaknessMap.values()]
    .sort((left, right) => severityRank[left.severity] - severityRank[right.severity]);
  const visualPattern = /\b(figures?|tables?|visual(?:ization)?|diagrams?|charts?|captions?|layout|typograph(?:y|ic)|render(?:ed|ing)?|page break|bibliograph(?:y|ic))\b/i;
  const visualWeaknesses = reviewWeaknesses.filter((weakness) => visualPattern.test(`${weakness.category} ${weakness.detail}`));
  const proseWeaknesses = reviewWeaknesses.filter((weakness) => !visualPattern.test(`${weakness.category} ${weakness.detail}`));
  const blockingProseWeaknesses = proseWeaknesses.filter((weakness) => weakness.severity !== "minor");
  const blockingVisualWeaknesses = visualWeaknesses.filter((weakness) => weakness.severity !== "minor");
  const reviewDetail = reviewWeaknesses.slice(0, 16)
    .map((weakness) => `[${weakness.severity}] ${weakness.category}: ${weakness.detail}`)
    .join("; ");
  const findings = failed.map((check) => ({
    id: check.id,
    severity: "critical" as const,
    summary: check.id === "review_target" && reviewDetail
      ? `${Array.isArray(check.findings) ? check.findings.filter((finding): finding is string => typeof finding === "string").join("; ") : "Review target failed"}. Concrete reviewer findings: ${reviewDetail}`.slice(0, 7_500)
      : Array.isArray(check.findings) && check.findings.every((finding) => typeof finding === "string") && check.findings.length > 0
      ? check.findings.join("; ").slice(0, 7_500)
      : typeof check.detail === "string" ? check.detail.slice(0, 7_500)
      : typeof check.finding === "string" ? check.finding.slice(0, 7_500)
        : `Deterministic final-release validation reports ${check.id} as failing.`,
  }));
  const actions: AgenticActionPlan["actions"] = [];
  const visual: string[] = failedIds.filter((id) => repairRouteForGate(id).preferred === "revise_visual_plan");
  if (failedIds.includes("review_target") && visualWeaknesses.length > 0) visual.push("review_target");
  // A low aggregate review score can be caused entirely by a blocking visual
  // defect. In that case, routing review_target to both prose and visual tools
  // rewrites already-supported chapters without any prose acceptance delta.
  // Let the visual action own review_target when all nonvisual feedback is
  // minor and the rendered visual gate is independently failing.
  const visualOnlyReviewTarget = failedIds.includes("rendered_visual_review")
    && blockingVisualWeaknesses.length > 0 && blockingProseWeaknesses.length === 0;
  const research = failedIds.filter((id) => repairRouteForGate(id).preferred === "targeted_research_expansion");
  const prose = failedIds.filter((id) => repairRouteForGate(id).preferred === "revise_sections" && !(id === "review_target" && visualOnlyReviewTarget));
  if (research.length > 0) {
    const detail = failed.filter((check) => research.includes(check.id))
      .flatMap((check) => Array.isArray(check.findings) ? check.findings.filter((finding): finding is string => typeof finding === "string") : [])
      .join("; ");
    actions.push({
      id: "required-final-release-research-repair",
      tool: "targeted_research_expansion",
      finding_ids: research,
      rationale: `Run bounded evidence acquisition targeted only at the missing landmark works or coverage cells named by the deterministic release report; refresh classification, full text, evidence extraction, and allocation before any dependent prose repair.${detail ? ` Exact gaps: ${detail}` : ""}`.slice(0, 8_000),
      acceptance_criteria: (await Promise.all(research.map((id) => gateAcceptanceCriterion(resolved, id, config)))).slice(0, 5),
    });
  }
  if (prose.length > 0) {
    const citedFinding = failed.find((check) => check.id === "cited_literature_release_gates");
    const citedText = Array.isArray(citedFinding?.findings)
      ? citedFinding.findings.filter((finding): finding is string => typeof finding === "string").join(" ")
      : "";
    const acceptance: AgenticActionPlan["actions"][number]["acceptance_criteria"] = [];
    if (/cited sources .*below configured minimum/i.test(citedText)) {
      acceptance.push({ metric: "cited_sources", target: config.research.release_gates.min_cited_sources, scope: "distinct sources cited in chapters/*.md" });
    }
    if (/accepted cited-source ratio .*below configured/i.test(citedText)) {
      acceptance.push({ metric: "accepted_cited_ratio", target: config.research.release_gates.min_accepted_cited_ratio, scope: "distinct sources cited in chapters/*.md" });
    }
    if (/citation density .*below|citations? per page .*below/i.test(citedText)) {
      acceptance.push({ metric: "citations_per_page", target: config.research.release_gates.min_citations_per_page, scope: "rendered manuscript" });
    }
    if (/within[_ -]?1yr|within one year/i.test(citedText)) {
      acceptance.push({ metric: "cited_within_one_year_ratio", target: config.research.release_gates.min_cited_within_one_year_ratio, scope: "distinct sources cited in chapters/*.md" });
    }
    for (const id of prose) {
      if (["claim_support", "review_target", "claim_contradictions", "prose_redundancy", "landmark_citation_coverage"].includes(id)) acceptance.push(await gateAcceptanceCriterion(resolved, id, config));
    }
    if (acceptance.length === 0) acceptance.push({ metric: "citation_depth_per_section", operator: "at_least", target: 1, scope: "sections named by the current release assessment" });
    const proseDetail = proseWeaknesses.slice(0, 12).map((weakness) => `${weakness.category}: ${weakness.detail}`).join("; ");
    actions.push({
      id: "required-final-release-prose-repair",
      tool: "revise_sections",
      finding_ids: prose,
      rationale: `Apply the exact deterministic release targets to evidence-backed manuscript prose. Narrow or remove unsupported claims and weave only packet-backed, verified sources; do not lower any release target.${proseDetail ? ` Concrete prose findings: ${proseDetail}` : ""}`.slice(0, 8_000),
      acceptance_criteria: acceptance.slice(0, 5),
    });
  }
  if (visual.length > 0) {
    const visualDetail = visualWeaknesses.slice(0, 12).map((weakness) => `${weakness.category}: ${weakness.detail}`).join("; ");
    actions.push({
      id: "required-final-release-visual-repair",
      tool: "revise_visual_plan",
      finding_ids: [...new Set(visual)],
      rationale: `Repair the named figure/table content, placement, captions, and legibility defects, then require a fresh rendered-PDF review. The visual gate cannot be waived.${visualDetail ? ` Concrete visual findings: ${visualDetail}` : ""}`.slice(0, 8_000),
      acceptance_criteria: [
        ...(await Promise.all(visual.filter((id) => id !== "review_target").map((id) => gateAcceptanceCriterion(resolved, id, config)))),
        ...(visual.includes("review_target") ? [{ metric: "review_score" as const, operator: "at_least" as const, target: 8, scope: "fresh independent multi-persona review after visual repair" }] : []),
      ],
    });
  }
  // When the deterministic packet inventory cannot support the configured
  // accepted-source floor, add bounded retrieval before the prose editor runs.
  // Capacity is intentionally checked here rather than guessed from a review.
  if (failedIds.includes("cited_literature_release_gates")) {
    const capacity = await evidenceCapacity(resolved, config.research.release_gates.min_accepted_cited_ratio);
    if (capacity.requiresExpansion) {
      actions.unshift({
        id: "expand-final-release-evidence-capacity",
        tool: "targeted_research_expansion",
        finding_ids: ["cited_literature_release_gates"],
        rationale: `The current packet-backed evidence cannot meet the configured release capacity: ${capacity.reasons.join("; ")}. Retrieve only sources that close this concrete gap before revising prose.`,
        acceptance_criteria: [
          { metric: "cited_sources", target: config.research.release_gates.min_cited_sources },
          ...(config.research.release_gates.min_accepted_cited_ratio > 0
            ? [{ metric: "accepted_cited_ratio" as const, target: config.research.release_gates.min_accepted_cited_ratio }]
            : []),
        ],
      });
    }
  }
  // Two rounds in which no dispatched action satisfies even one owning gate
  // indicate an infeasible or mis-scoped repair, not permission to spend a
  // third identical round. Pause on a typed operator decision with the exact
  // remaining gates. This is a recoverable escalation, not a false success or
  // an opaque max-round failure.
  if (stalledRounds >= 2 && failedIds.length > 0) {
    actions.splice(0, actions.length, {
      id: "repair-stalled-operator-decision",
      tool: "request_operator_clarification",
      finding_ids: failedIds,
      rationale: `Automated repair completed ${stalledRounds} consecutive rounds without satisfying any owning release gate. Decide whether to broaden the evidence budget, revise the paper scope/profile, or provide targeted source/venue guidance. Remaining gates: ${failedIds.join(", ")}.`,
      acceptance_criteria: [await gateAcceptanceCriterion(resolved, failedIds[0]!, config)],
    });
  }
  const plan = AgenticActionPlan.parse({ version: 1, findings, actions });
  const target = path.join(resolved, "reviews", "action-plan.json");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(plan, null, 2)}\n`, "utf-8");
  await runResearchRepairFinalReleasePlan(resolved);
  console.log(`Generated deterministic final-release plan for ${failedIds.length} failed gate(s).`);
}

/** Produce the exact chapter/source repair scope that a prose revision must
 * close. Keeping this deterministic prevents a broad final-validator log from
 * being translated into an arbitrary, low-impact rewrite. */
export async function runResearchCitationRepairPacket(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const { items, written } = await import("../lib/research/recovery-repair.js").then((mod) => mod.writeCitationRepairPacket(resolved));
  console.log(`Citation repair packet: ${items} chapter/source work item(s).`);
  for (const file of written) console.log(`  + ${file}`);
}

export async function runResearchCitedSourceUpgradePacket(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const { items, written } = await import("../lib/research/recovery-repair.js").then((mod) => mod.writeCitedSourceUpgradePacket(resolved));
  console.log(`Accepted-source citation upgrade packet: ${items} chapter/source work item(s).`);
  for (const file of written) console.log(`  + ${file}`);
}

/** Snapshot release metrics before a bounded recovery round. */
export async function runResearchFinalReleaseBaseline(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const written = await import("../lib/research/recovery-repair.js").then((mod) => mod.writeFinalReleaseBaseline(resolved));
  console.log(`Final-release baseline written: ${written}`);
}

/** Record whether a completed remediation made deterministic progress.
 *
 * This is advisory telemetry, not a workflow failure: a loop engine may
 * continue after a failed child, which would turn an intended "stop" signal
 * into an accidental extra recovery round.  The release validator remains the
 * sole publication blocker. */
export async function runResearchAssessFinalReleaseProgress(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const result = await import("../lib/research/recovery-repair.js").then((mod) => mod.assessFinalReleaseProgress(resolved));
  console.log(`Final-release recovery progress: ${result.improvements.length} improvement(s).`);
  for (const improvement of result.improvements) console.log(`  + ${improvement}`);
  console.log(`  + ${result.reportPath}`);
  if (!result.pass) {
    console.warn("No failed release gate or tracked recovery metric improved; recorded for the next bounded recovery decision.");
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

/** Observation only: this never fails, because there is no correct number of
 * artifacts for a paper to have. It reports where validated evidence sits and
 * what the visual plan currently serves, so the planner chooses from evidence
 * rather than from a quota. */
export async function runResearchComparisonOpportunities(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const { writeComparisonOpportunities, evaluateComparisonOpportunities } = await import("../lib/research/comparison-opportunities.js");
  const report = await evaluateComparisonOpportunities(resolved);
  const written = await writeComparisonOpportunities(resolved);
  const unserved = report.sections.filter((section) => section.packet_backed_sources > 0 && section.placed_artifacts.length === 0);
  console.log(`Comparison opportunities: ${report.sections.length} sections, ${unserved.length} with validated evidence and no placed artifact`);
  for (const file of written) console.log(`  + ${file}`);
}

/** Reports which release gates the current corpus can still satisfy. Never
 * fails: a gate out of reach is an operator decision, and failing here would
 * only relocate the same dead end to an earlier stage. */
export async function runResearchGateReachability(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const { writeGateReachability } = await import("../lib/research/gate-reachability.js");
  const { report, written } = await writeGateReachability(resolved);
  const blocked = report.gates.filter((gate) => !gate.reachable);
  console.log(report.evaluated
    ? `Release-gate reachability: ${report.gates.length} gates, ${blocked.length} already out of reach`
    : "Release-gate reachability: no classified corpus yet");
  for (const gate of blocked) console.log(`  [unreachable] ${gate.id}: ${gate.detail}`);
  for (const file of written) console.log(`  + ${file}`);
}

/** Folds the previous round's artifact plan into append-only history so the
 * next planner can see what the loop has already tried. */
export async function runResearchDirectionMemory(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const { writeDirectionMemory } = await import("../lib/research/direction-memory.js");
  const { memory, written } = await writeDirectionMemory(resolved);
  console.log(`Directions tried: ${memory.directions.length} across ${memory.rounds_recorded} planning round(s)`);
  for (const file of written) console.log(`  + ${file}`);
}

/** Decides from recorded scores whether the loop must change its frame. An
 * agent judging its own progress is what produced the flat rounds, so this is
 * computed rather than asked. */
export async function runResearchStallStatus(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const { writeStallStatus } = await import("../lib/research/stall.js");
  const { status, written } = await writeStallStatus(resolved);
  console.log(`Loop posture: ${status.posture} (${status.stale_rounds} round(s) without improvement across ${status.rounds})`);
  console.log(`  eligible actions: ${status.eligible_tools.join(", ")}`);
  for (const file of written) console.log(`  + ${file}`);
}

/** Rebuilds the comparison-dimension vocabulary from existing evidence. Also
 * the migration path for a corpus that predates the registry: the promotion
 * rule supplies the only judgment needed — whether sources converged on an
 * axis — so no LLM pass is required to bootstrap it. */
export async function runResearchComparisonRegistry(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const { refreshComparisonRegistry, PROMOTION_THRESHOLD } = await import("../lib/research/comparison-registry.js");
  const { registry, written } = await refreshComparisonRegistry(resolved);
  console.log(`Comparison dimensions: ${registry.dimensions.length} in vocabulary, ${registry.proposed.length} proposed (promote at ${PROMOTION_THRESHOLD} sources)`);
  for (const entry of registry.dimensions.slice(0, 10)) console.log(`  ${entry.sources.length}x  ${entry.label}`);
  for (const file of written) console.log(`  + ${file}`);
}
