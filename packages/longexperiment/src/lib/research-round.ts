import { execFile as execFileCallback } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { ExperimentConfig, ResearchLoopPolicy } from "./schema.js";
import { createTaskProfileRegistry } from "../profiles/index.js";
import { recordDeadEndEvidence } from "./dead-ends.js";
import { freezeBaseline, materializeCandidateWorktree } from "./git-lineage.js";
import { addCandidateNode, completeRound, initializeLineage, markDeadEnd, promoteChampion, readLineage, recordCandidateCommit, recordCandidateResult, recordRunStatus, startRound } from "./lineage.js";
import { deduplicateProposal, ResearchProposal, validateProposalPacket } from "./proposals.js";
import { initializeResearchState, readResearchState, updateResearchState } from "./research-state.js";
import { archiveActiveRound, startActiveRound } from "./rounds.js";

const execFile = promisify(execFileCallback);

/**
 * The deterministic half of the generalized research loop (LE-4.3).
 *
 * An agent proposes; these commands certify. Every function here is a script
 * stage in the compiled loop, so the engine — not a model — decides what runs
 * next, what becomes champion, and when the search stops.
 */

export const ACTIVE_ROUND_DIR = path.join("runs", "active-round");
export const METRICS_PATH = path.join("reports", "metrics.json");

export const RoundCandidate = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  proposal_id: z.string(),
  hypothesis_family: z.string(),
  branch: z.string().min(1),
  changed_paths: z.array(z.string()).min(1),
}).strict();
export type RoundCandidate = z.infer<typeof RoundCandidate>;

export const RoundPlan = z.object({
  version: z.literal(1),
  round_id: z.string().min(1),
  parent_node_id: z.string().min(1),
  candidates: z.array(RoundCandidate),
  rejected: z.array(z.object({ proposal_id: z.string(), reasons: z.array(z.string()) }).strict()),
  /** The foreach source. `foreach: runs/active-round/candidates.items` makes
   *  the engine read THIS file and look for an `items` array — a sibling
   *  `candidates.items.json` is never opened. */
  items: z.array(z.object({ id: z.string() }).strict()),
}).strict();
export type RoundPlan = z.infer<typeof RoundPlan>;

/** What a candidate's audit must establish before promotion may consider it. */
export const CandidateAudit = z.object({
  version: z.literal(1),
  candidate_id: z.string(),
  status: z.enum(["completed", "crashed"]),
  primary_metric: z.number().finite().optional(),
  confidence: z.object({ lower: z.number().finite(), upper: z.number().finite() }).strict().optional(),
  constraints_passed: z.boolean(),
  complexity_score: z.number().nonnegative().optional(),
  findings: z.array(z.string()).default([]),
}).strict();
export type CandidateAudit = z.infer<typeof CandidateAudit>;

async function writeAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try { await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8"); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
}
async function readJson(file: string): Promise<unknown> {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { throw new Error(`cannot read required round artifact ${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`); }
}
function profileFor(config: ExperimentConfig) { return createTaskProfileRegistry().resolve(config); }
/** These commands only run inside a compiled research loop, which never
 * compiles without `research:`. Failing loudly beats silently searching under
 * defaults nobody configured. */
function policyFor(config: ExperimentConfig): ResearchLoopPolicy {
  if (!config.research) throw new Error("this workspace has no research: policy, so it does not run the generalized research loop");
  return config.research;
}
function activeRound(workspace: string, file: string): string { return path.join(workspace, ACTIVE_ROUND_DIR, file); }

/**
 * Gate proposals before any compute is scheduled.
 *
 * Rejection is recorded rather than thrown: a round that produces one usable
 * candidate out of three is a normal round, and the discarded reasoning is
 * evidence. An empty surviving set is the failure, because it means the round
 * would spend nothing and learn nothing.
 */
export async function validateRoundPlan(workspace: string, config: ExperimentConfig): Promise<RoundPlan> {
  const profile = profileFor(config);
  const state = await readResearchState(workspace);
  const plan = profile.buildRound({ round: state.current_round + 1, parentNodeId: state.champion_node_id, maxRounds: policyFor(config).max_rounds });

  const raw = (await readJson(activeRound(workspace, "proposals.raw.json"))) as { proposals?: unknown[]; critiques?: unknown[] };
  const critiques = Array.isArray(raw.critiques) ? raw.critiques : [];
  const limit = Math.min(plan.max_candidates, policyFor(config).max_candidates_per_round);

  const accepted: RoundCandidate[] = [];
  const rejected: RoundPlan["rejected"] = [];
  const seen: ResearchProposal[] = [];
  for (const item of Array.isArray(raw.proposals) ? raw.proposals : []) {
    let proposal: ResearchProposal;
    try { ({ proposal } = validateProposalPacket(item, critiques)); }
    catch (error) { rejected.push({ proposal_id: String((item as { id?: unknown })?.id ?? "unknown"), reasons: [error instanceof Error ? error.message : String(error)] }); continue; }

    const duplicate = deduplicateProposal(proposal, seen);
    if (duplicate.duplicate) { rejected.push({ proposal_id: proposal.id, reasons: duplicate.reasons }); continue; }

    const outsidePolicy = proposal.changed_paths.filter((candidatePath) => !isMutable(candidatePath, profile.mutationPolicy(config)));
    if (outsidePolicy.length > 0) { rejected.push({ proposal_id: proposal.id, reasons: [`requests changes outside the mutation policy: ${outsidePolicy.sort().join(", ")}`] }); continue; }

    if (accepted.length >= limit) { rejected.push({ proposal_id: proposal.id, reasons: [`round candidate cap ${limit} already reached`] }); continue; }
    seen.push(proposal);
    accepted.push({ id: proposal.id, proposal_id: proposal.id, hypothesis_family: proposal.hypothesis_family, branch: `candidate/${plan.round_id}/${proposal.id}`, changed_paths: proposal.changed_paths });
  }
  if (accepted.length === 0) throw new Error(`round ${plan.round_id} has no proposal that survives critique, novelty, and mutation-policy validation`);

  const validated = RoundPlan.parse({
    version: 1, round_id: plan.round_id, parent_node_id: plan.parent_node_id,
    candidates: accepted, rejected, items: accepted.map((candidate) => ({ id: candidate.id })),
  });
  await startActiveRound(workspace, plan.round_id, validated as unknown as Record<string, unknown>);
  await writeAtomic(activeRound(workspace, "candidates.json"), validated);
  await startRound(workspace, { id: plan.round_id, parent_node_id: plan.parent_node_id, proposal_ids: accepted.map((candidate) => candidate.proposal_id) });
  return validated;
}

function isMutable(candidatePath: string, policy: { mutable_paths: string[]; protected_paths: string[] }): boolean {
  if (policy.protected_paths.some((blocked) => candidatePath === blocked || candidatePath.startsWith(`${blocked}/`))) return false;
  return policy.mutable_paths.some((allowed) => candidatePath === allowed || candidatePath.startsWith(`${allowed}/`));
}

/** Give every validated candidate an immutable branch off the same parent. */
export async function materializeRoundCandidates(workspace: string, config: ExperimentConfig): Promise<RoundPlan> {
  const plan = RoundPlan.parse(await readJson(activeRound(workspace, "candidates.json")));
  const graph = await readLineage(workspace);
  const parent = graph.nodes.find((node) => node.id === plan.parent_node_id);
  if (!parent) throw new Error(`round parent ${plan.parent_node_id} is not in the lineage`);
  const repo = await resolveBaseRepo(workspace, config);

  const worktrees = [];
  for (const candidate of plan.candidates) {
    const materialized = await materializeCandidateWorktree(repo, workspace, candidate.id, candidate.branch, parent.commit_sha);
    if (!graph.nodes.some((node) => node.id === candidate.id)) {
      await addCandidateNode(workspace, { id: candidate.id, parent_id: parent.id, round_id: plan.round_id, hypothesis_id: candidate.hypothesis_family, branch: materialized.branch, commit_sha: materialized.commit_sha, status: "materialized" });
    }
    worktrees.push({ candidate_id: candidate.id, ...materialized });
  }
  await writeAtomic(path.join(workspace, "worktrees", "manifest.json"), { version: 1, round_id: plan.round_id, worktrees });
  return plan;
}

async function resolveBaseRepo(workspace: string, config: ExperimentConfig): Promise<string> {
  const baseId = config.authoring.mode === "agentic" ? config.authoring.base_input_id : undefined;
  const input = baseId ? config.inputs.code.find((item) => item.id === baseId) : config.inputs.code[0];
  if (!input) throw new Error("the research loop requires at least one pinned code input to branch from");
  return path.join(workspace, "inputs", input.id, "repo");
}

/**
 * Turn one candidate's raw results into a lineage-recorded audit.
 *
 * This is the step that was missing: without it, lineage nodes stayed at
 * "materialized" forever and promotion had no audited metric to compare.
 */
export async function auditRoundCandidate(workspace: string, config: ExperimentConfig, candidateId: string): Promise<CandidateAudit> {
  const plan = RoundPlan.parse(await readJson(activeRound(workspace, "candidates.json")));
  if (!plan.candidates.some((candidate) => candidate.id === candidateId)) throw new Error(`candidate ${candidateId} is not part of round ${plan.round_id}`);
  const resultPath = path.join(workspace, "results", "studies", candidateId, "raw-results.json");

  let audit: CandidateAudit;
  try {
    const raw = (await readJson(resultPath)) as { status?: string; trials?: Array<{ metrics?: Record<string, number> }> };
    const metricName = config.evaluation?.primary_metric;
    if (!metricName) throw new Error("the research loop requires an evaluation contract with a primary metric");
    const values = (raw.trials ?? []).map((trial) => trial.metrics?.[metricName]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (raw.status !== "completed" || values.length === 0) throw new Error(`candidate ${candidateId} produced no finite ${metricName}`);
    audit = CandidateAudit.parse({
      version: 1, candidate_id: candidateId, status: "completed",
      primary_metric: values.reduce((total, value) => total + value, 0) / values.length,
      constraints_passed: true, complexity_score: plan.candidates.find((item) => item.id === candidateId)?.changed_paths.length ?? 0, findings: [],
    });
    await recordRunStatus(workspace, candidateId, "completed");
    await recordCandidateResult(workspace, candidateId, { primary_metric: audit.primary_metric, complexity_score: audit.complexity_score, result_artifact: path.posix.join("results", "studies", candidateId, "raw-results.json") });
  } catch (error) {
    // A crashed candidate is durable evidence, not a lost round. Record it and
    // let promotion treat it as a dead end.
    audit = CandidateAudit.parse({ version: 1, candidate_id: candidateId, status: "crashed", constraints_passed: false, findings: [error instanceof Error ? error.message : String(error)] });
    await recordRunStatus(workspace, candidateId, "failed");
  }
  await writeAtomic(path.join(workspace, "results", "studies", candidateId, "audit.json"), audit);
  return audit;
}

/**
 * Freeze the baseline and open the lineage. Nothing may be promoted against a
 * baseline that is not itself an immutable commit with an audited metric, so
 * this runs before the loop and never inside it.
 */
export async function researchInit(workspace: string, config: ExperimentConfig): Promise<{ commit_sha: string }> {
  if (!config.pilot) throw new Error("the research loop requires an explicit experiment pilot");
  const repo = await resolveBaseRepo(workspace, config);
  const baseline = await freezeBaseline(repo);
  await initializeLineage(workspace, { id: "baseline", round_id: "baseline", branch: baseline.branch, commit_sha: baseline.commit_sha, status: "completed" });
  await initializeResearchState(workspace, { pilot: config.pilot, champion_node_id: "baseline" });
  await writeAtomic(path.join(workspace, "worktrees", "manifest.json"), { version: 1, round_id: "baseline", worktrees: [{ candidate_id: "baseline", branch: baseline.branch, commit_sha: baseline.commit_sha, worktree_path: path.posix.join("inputs", path.basename(path.dirname(repo)), "repo"), reused_branch: true }] });
  return { commit_sha: baseline.commit_sha };
}

/** Record the baseline's own measurement so round 1 has an incumbent to beat. */
export async function auditBaseline(workspace: string, config: ExperimentConfig): Promise<CandidateAudit> {
  const metricName = config.evaluation?.primary_metric;
  if (!metricName) throw new Error("the research loop requires an evaluation contract with a primary metric");
  const raw = (await readJson(path.join(workspace, "results", "studies", "baseline", "raw-results.json"))) as { status?: string; trials?: Array<{ metrics?: Record<string, number> }> };
  const values = (raw.trials ?? []).map((trial) => trial.metrics?.[metricName]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (raw.status !== "completed" || values.length === 0) throw new Error(`the baseline produced no finite ${metricName}; the search has nothing to improve on`);
  const audit = CandidateAudit.parse({
    version: 1, candidate_id: "baseline", status: "completed",
    primary_metric: values.reduce((total, value) => total + value, 0) / values.length,
    constraints_passed: true, complexity_score: 0, findings: [],
  });
  await recordCandidateResult(workspace, "baseline", { primary_metric: audit.primary_metric, complexity_score: 0, result_artifact: path.posix.join("results", "studies", "baseline", "raw-results.json") });
  await writeAtomic(path.join(workspace, "results", "studies", "baseline", "audit.json"), audit);
  return audit;
}

/** Human-readable close-out: champion path, dead ends, and why the search stopped. */
export async function writeResearchFindings(workspace: string): Promise<string> {
  const graph = await readLineage(workspace);
  const state = await readResearchState(workspace);
  const champion = graph.nodes.find((node) => node.id === graph.champion_node_id);
  const deadEnds = graph.nodes.filter((node) => node.kind === "dead_end");
  const body = [
    "# Research findings", "",
    `- Pilot: ${state.pilot}`,
    `- Rounds completed: ${state.current_round}`,
    `- Champion: ${graph.champion_node_id} (commit ${champion?.commit_sha ?? "unknown"})`,
    `- Champion metric: ${champion?.primary_metric ?? "not recorded"}`,
    `- Stop reason: ${state.stop_reason ?? "search still open"}`,
    "", "## Dead ends", "",
    ...(deadEnds.length === 0 ? ["None recorded."] : deadEnds.map((node) => `- ${node.id} (${node.decision ?? "discarded"}): ${node.decision_reason ?? "no reason recorded"}`)),
    "", "## Rounds", "",
    ...graph.rounds.map((round) => `- ${round.id}: winner ${round.winner_node_id ?? "none"} from ${round.candidate_node_ids.length} candidate(s)`),
    "",
  ].join("\n");
  await fs.mkdir(path.join(workspace, "reports"), { recursive: true });
  await fs.writeFile(path.join(workspace, "reports", "research-findings.md"), body, "utf8");
  return body;
}

export type RoundPromotion = {
  round_id: string;
  winner_node_id: string | null;
  champion_node_id: string;
  champion_improvement: number;
  stop: boolean;
  stop_reason?: string;
};

/**
 * The single deterministic writer of champion state (design principle 7).
 *
 * No agent output reaches this function: it reads audited metrics, applies the
 * profile's promotion policy, and records both the winner and every dead end.
 */
export async function promoteRound(workspace: string, config: ExperimentConfig): Promise<RoundPromotion> {
  const profile = profileFor(config);
  const plan = RoundPlan.parse(await readJson(activeRound(workspace, "candidates.json")));
  const state = await readResearchState(workspace);
  const graph = await readLineage(workspace);
  const incumbent = graph.nodes.find((node) => node.id === state.champion_node_id);
  if (!incumbent) throw new Error(`champion ${state.champion_node_id} is not in the lineage`);
  const incumbentMetric = incumbent.primary_metric;
  if (incumbentMetric === undefined) throw new Error(`champion ${incumbent.id} has no audited primary metric to compare against`);
  const direction = config.evaluation?.direction;
  if (!direction) throw new Error("the research loop requires an evaluation contract with a metric direction");

  const audits: CandidateAudit[] = [];
  for (const candidate of plan.candidates) {
    audits.push(CandidateAudit.parse(await readJson(path.join(workspace, "results", "studies", candidate.id, "audit.json"))));
  }

  let winner: { id: string; metric: number; reason: string } | null = null;
  for (const audit of audits) {
    const decision = profile.decidePromotion({
      direction, incumbentMetric,
      candidateMetric: audit.primary_metric,
      ...(audit.confidence ? { candidateConfidence: audit.confidence } : {}),
      incumbentComplexity: incumbent.complexity_score,
      candidateComplexity: audit.complexity_score,
      constraintsPassed: audit.constraints_passed,
      crashed: audit.status === "crashed",
      minimumImprovement: policyFor(config).minimum_improvement,
    });
    if (decision.decision === "promote" && audit.primary_metric !== undefined) {
      const better = winner === null || (direction === "maximize" ? audit.primary_metric > winner.metric : audit.primary_metric < winner.metric);
      if (better) winner = { id: audit.candidate_id, metric: audit.primary_metric, reason: decision.reason };
      continue;
    }
    await markDeadEnd(workspace, audit.candidate_id, decision.decision === "crash" ? "crash" : "discard", decision.reason);
    const family = plan.candidates.find((candidate) => candidate.id === audit.candidate_id)?.hypothesis_family;
    if (family) {
      await recordDeadEndEvidence(workspace, {
        candidate_node_id: audit.candidate_id, hypothesis_family: family,
        outcome: decision.decision === "crash" ? "crashed" : "discarded",
        reason: decision.reason,
      });
    }
  }

  if (winner) await promoteChampion(workspace, winner.id, winner.reason);
  await completeRound(workspace, plan.round_id, winner?.id ?? null);

  const championImprovement = winner ? (direction === "maximize" ? winner.metric - incumbentMetric : incumbentMetric - winner.metric) : 0;
  const stagnation = winner ? 0 : state.stagnation_rounds + 1;
  const round = state.current_round + 1;
  const stopDecision = profile.shouldStop({ round, maxRounds: policyFor(config).max_rounds, stagnationRounds: stagnation });
  const stop = stopDecision.stop || stagnation >= policyFor(config).max_stagnant_rounds;
  const stopReason = stopDecision.stop ? stopDecision.reason : stagnation >= policyFor(config).max_stagnant_rounds ? `${stagnation} consecutive rounds without a promotion` : undefined;

  await archiveActiveRound(workspace);
  await updateResearchState(workspace, {
    current_round: round,
    champion_node_id: winner?.id ?? state.champion_node_id,
    stagnation_rounds: stagnation,
    status: stop ? "completed" : "running",
    ...(stop && stopReason ? { stop_reason: stopReason } : {}),
  });

  // The engine reads only this file to decide whether the loop continues, so a
  // stop decision must be expressed as a metric, never as prose.
  await writeAtomic(path.join(workspace, METRICS_PATH), {
    research_stop: stop ? 1 : 0,
    champion_improvement: championImprovement,
    consecutive_non_improving_rounds: stagnation,
    round,
  });

  return { round_id: plan.round_id, winner_node_id: winner?.id ?? null, champion_node_id: winner?.id ?? state.champion_node_id, champion_improvement: championImprovement, stop, ...(stopReason ? { stop_reason: stopReason } : {}) };
}

/**
 * Execute one candidate (or the baseline) through the configured runner.
 *
 * The research loop deliberately does NOT reuse `run-study`. That command reads
 * `runs/suite-plan.json` and refuses an id it does not find there — but the
 * loop never builds a suite plan, because its unit of work is a candidate
 * commit, not a declared study. Reusing it made `baseline_execute` fail on
 * every repository-optimization pilot before a single candidate was proposed.
 *
 * The evaluator and command are identical for every sibling; only the worktree
 * differs. That is the control the whole comparison rests on.
 */
export async function runCandidateStage(workspace: string, config: ExperimentConfig, candidateId: string): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidateId)) throw new Error(`unsafe candidate id ${candidateId}`);
  const evaluation = config.evaluation;
  if (!evaluation) throw new Error("the research loop requires an evaluation contract");
  if (config.runner.kind !== "command" || !config.runner.command) {
    throw new Error("runCandidateStage is the local-runner path; a remote runner executes through its adapter");
  }

  const output = path.posix.join("results", "studies", candidateId, "raw-results.json");
  const log = path.join(workspace, "logs", "studies", candidateId, "runner.log");
  await fs.mkdir(path.dirname(log), { recursive: true });

  const conditions = candidateId === "baseline"
    ? [evaluation.baseline_id]
    : [...new Set(config.suite?.studies.flatMap((study) => study.conditions).filter((condition) => condition !== evaluation.baseline_id) ?? ["candidate"])];

  try {
    const result = await execFile("sh", ["-lc", config.runner.command], {
      cwd: config.runner.workdir ? path.resolve(workspace, config.runner.workdir) : workspace,
      encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        LONGEXPERIMENT_WORKSPACE: workspace,
        LONGEXPERIMENT_STUDY_ID: candidateId,
        LONGEXPERIMENT_CANDIDATE_ID: candidateId,
        LONGEXPERIMENT_RESULT_PATH: output,
        LONGEXPERIMENT_SEEDS: evaluation.seeds.join(","),
        LONGEXPERIMENT_CONDITIONS: conditions.join(","),
        LONGEXPERIMENT_PRIMARY_METRIC: evaluation.primary_metric,
        LONGEXPERIMENT_INPUT_LOCKS: "inputs/locks.json",
      },
    });
    await fs.writeFile(log, `${result.stdout}\n${result.stderr}`, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await fs.appendFile(log, `\nRUNNER FAILED\n${message}\n`, "utf8");
    throw new Error(`candidate ${candidateId} runner failed; inspect ${path.relative(workspace, log)}`);
  }
  await fs.access(path.join(workspace, output));
}

/**
 * Turn an implemented candidate worktree into an immutable, policy-checked commit.
 *
 * The loop previously materialized a branch and ran it, but nothing applied the
 * proposal — so every candidate scored identically to the baseline and the
 * search could never find anything. Authoring is the agent's job; this stage is
 * the deterministic half that decides whether what it wrote is admissible:
 *
 *  - only `mutable_paths` may change, never a `protected_paths` entry;
 *  - the file and byte budgets are enforced before any compute is spent;
 *  - an empty diff is rejected, because an unchanged candidate is not a
 *    candidate — it silently re-measures the baseline.
 */
export async function verifyCandidateStage(workspace: string, config: ExperimentConfig, candidateId: string): Promise<{ commit_sha: string; changed: string[] }> {
  const plan = RoundPlan.parse(await readJson(activeRound(workspace, "candidates.json")));
  if (!plan.candidates.some((candidate) => candidate.id === candidateId)) throw new Error(`candidate ${candidateId} is not part of round ${plan.round_id}`);
  const policy = profileFor(config).mutationPolicy(config);
  const tree = path.join(workspace, "worktrees", candidateId);

  const git = async (args: string[]) => (await execFile("git", ["-C", tree, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })).stdout;
  const changed = (await git(["status", "--porcelain"])).split("\n")
    .map((line) => line.slice(3).trim()).filter(Boolean);

  if (changed.length === 0) {
    throw new Error(`candidate ${candidateId} changed nothing; an unchanged worktree just re-measures the baseline`);
  }
  const forbidden = changed.filter((file) => !isMutable(file, policy));
  if (forbidden.length > 0) {
    throw new Error(`candidate ${candidateId} modified paths outside the mutation policy: ${forbidden.sort().join(", ")}`);
  }
  if (changed.length > policy.max_files_changed) {
    throw new Error(`candidate ${candidateId} changed ${changed.length} files, above max_files_changed ${policy.max_files_changed}`);
  }
  let bytes = 0;
  for (const file of changed) {
    const stat = await fs.stat(path.join(tree, file)).catch(() => null);
    bytes += stat?.size ?? 0;
  }
  if (bytes > policy.max_total_bytes_changed) {
    throw new Error(`candidate ${candidateId} changed ${bytes} bytes, above max_total_bytes_changed ${policy.max_total_bytes_changed}`);
  }

  await git(["add", "-A"]);
  await execFile("git", ["-C", tree, "-c", "user.email=longexperiment@local", "-c", "user.name=LongExperiment", "commit", "-m", `candidate ${candidateId}`], { encoding: "utf8" });
  const commit_sha = (await git(["rev-parse", "HEAD"])).trim();
  await recordCandidateCommit(workspace, candidateId, commit_sha);
  await writeAtomic(path.join(workspace, "results", "studies", candidateId, "candidate-commit.json"), {
    version: 1, candidate_id: candidateId, commit_sha, changed_paths: changed.sort(), bytes_changed: bytes,
  });
  return { commit_sha, changed: changed.sort() };
}
