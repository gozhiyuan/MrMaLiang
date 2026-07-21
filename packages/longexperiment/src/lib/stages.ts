import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { type ExperimentConfig, ExperimentManifest, StudyRawResults, TrialRecord } from "./schema.js";
import { publicationEligible } from "./flagships.js";

const execFile = promisify(execFileCallback);

type LockEntry = { id: string; source: string; revision: string; resolved_revision: string; materialized_path?: string; materialize: "git" | "external"; checksum?: string };
type InputLocks = { version: 1; inputs: LockEntry[] };
type PlannedStudy = { id: string; kind: string; depends_on: string[]; conditions: string[]; acceptance_criteria: string[]; optional_action?: string };

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

async function readJson<T>(filePath: string, label = filePath): Promise<T> {
  try { return JSON.parse(await fs.readFile(filePath, "utf-8")) as T; }
  catch (error) { throw new Error(`${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
async function fileSha256(filePath: string): Promise<string> { return sha256(await fs.readFile(filePath)); }
function allInputs(config: ExperimentConfig) { return [...config.inputs.code, ...config.inputs.benchmarks, ...config.inputs.models]; }
function isCommitPin(revision: string): boolean { return /^[a-f0-9]{7,64}$/i.test(revision); }

async function command(bin: string, args: string[], cwd?: string): Promise<string> {
  try {
    // A pinned Hugging Face repository may contain multi-GB LFS weights. The
    // experiment contract records its immutable revision; it must not silently
    // download model blobs while preparing source locks.
    const result = await execFile(bin, args, { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" } });
    return result.stdout.trim();
  } catch (error) {
    throw new Error(`command failed: ${bin} ${args.join(" ")}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function safeRelative(value: string): boolean {
  return value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]/).includes("..");
}

function selectedStudies(config: ExperimentConfig): PlannedStudy[] {
  const studies = config.suite?.studies ?? [{ id: "primary", kind: "training_ablation", depends_on: [], acceptance_criteria: ["complete declared runner"], conditions: ["candidate"] }];
  const active = studies.filter((study) => !study.optional_action || config.execution.enabled_optional_actions.includes(study.optional_action));
  const ids = new Set(active.map((study) => study.id));
  for (const study of active) for (const dependency of study.depends_on) {
    if (!ids.has(dependency)) throw new Error(`active study ${study.id} depends on ${dependency}, which is optional but not enabled`);
  }
  return active.map((study) => ({ id: study.id, kind: study.kind, depends_on: study.depends_on, conditions: study.conditions, acceptance_criteria: study.acceptance_criteria, ...(study.optional_action ? { optional_action: study.optional_action } : {}) }));
}

export function suiteLevels(config: ExperimentConfig): PlannedStudy[][] {
  const studies = selectedStudies(config);
  const remaining = new Map(studies.map((study) => [study.id, study]));
  const completed = new Set<string>();
  const levels: PlannedStudy[][] = [];
  while (remaining.size > 0) {
    const level = [...remaining.values()].filter((study) => study.depends_on.every((dependency) => completed.has(dependency)));
    if (level.length === 0) throw new Error("suite dependencies cannot be scheduled (cycle or inactive dependency)");
    levels.push(level);
    for (const study of level) { completed.add(study.id); remaining.delete(study.id); }
  }
  return levels;
}

export async function writeDesignStage(workspace: string, config: ExperimentConfig): Promise<void> {
  const levels = suiteLevels(config);
  const design = [
    "# Experiment Design", "", "## Hypothesis", "", config.hypothesis, "",
    "## Controlled execution", "", `- Profile: ${config.profile}`, `- Maximum trials: ${config.execution.max_trials}`,
    `- Parallel trials/studies: ${config.execution.max_parallel_trials}`, `- Active-run limit: ${config.execution.max_active_run_minutes} minutes`, "",
    "## Evidence contract", "", "Each active study must emit results/studies/<study-id>/raw-results.json with one completed record per required seed and condition. The runner cannot self-certify publication eligibility: LongExperiment verifies pins, files, per-trial metrics, paired controls, confidence intervals, and checksums.", "",
    "## Dependency levels", "", ...levels.map((level, index) => `- Level ${index + 1}: ${level.map((study) => study.id).join(", ")}`), "",
  ].join("\n");
  await fs.mkdir(path.join(workspace, "reports"), { recursive: true });
  await fs.writeFile(path.join(workspace, "reports", "experiment-design.md"), design, "utf-8");
  await writeJson(path.join(workspace, "runs", "trial-plan.json"), {
    version: 1, hypothesis: config.hypothesis, max_trials: config.execution.max_trials,
    seeds: config.evaluation?.seeds ?? [], primary_metric: config.evaluation?.primary_metric ?? null,
    selected_optional_actions: config.execution.enabled_optional_actions, status: "approved-design-required",
  });
}

/** Materialize exact Git revisions before any runner starts. An external input
 * is still locked, but never silently treated as a checked-out source tree. */
export async function writePinInputsStage(workspace: string, config: ExperimentConfig): Promise<void> {
  const entries: LockEntry[] = [];
  for (const input of allInputs(config)) {
    if (!isCommitPin(input.revision)) throw new Error(`input ${input.id} revision must be an immutable commit/hash, not "${input.revision}"`);
    if (input.materialize === "external") {
      entries.push({ id: input.id, source: input.source, revision: input.revision, resolved_revision: input.revision, materialize: "external", ...(input.checksum ? { checksum: input.checksum } : {}) });
      continue;
    }
    const repo = path.join(workspace, "inputs", input.id, "repo");
    try { await fs.access(repo); }
    catch {
      await fs.mkdir(path.dirname(repo), { recursive: true });
      await command("git", ["clone", "--no-checkout", input.source, repo]);
    }
    await command("git", ["fetch", "--depth", "1", "origin", input.revision], repo);
    await command("git", ["checkout", "--detach", "FETCH_HEAD"], repo);
    const resolved = await command("git", ["rev-parse", "HEAD"], repo);
    if (!resolved.startsWith(input.revision)) throw new Error(`input ${input.id} resolved ${resolved}, expected configured pin ${input.revision}`);
    entries.push({ id: input.id, source: input.source, revision: input.revision, resolved_revision: resolved, materialize: "git", materialized_path: `inputs/${input.id}/repo`, ...(input.checksum ? { checksum: input.checksum } : {}) });
  }
  await writeJson(path.join(workspace, "inputs", "locks.json"), { version: 1, inputs: entries } satisfies InputLocks);
}

/** Candidate changes never share a mutable checkout with the baseline. */
export async function writeWorktreesStage(workspace: string, config: ExperimentConfig): Promise<void> {
  const locks = await readJson<InputLocks>(path.join(workspace, "inputs", "locks.json"));
  const byId = new Map(locks.inputs.map((entry) => [entry.id, entry]));
  const created: Array<{ id: string; input_id: string; revision: string; path: string; resolved_revision: string; role: string }> = [];
  for (const candidate of config.execution.candidate_worktrees) {
    const lock = byId.get(candidate.input_id);
    if (!lock?.materialized_path) throw new Error(`candidate worktree ${candidate.id} requires materialized Git input ${candidate.input_id}`);
    if (!isCommitPin(candidate.revision)) throw new Error(`candidate worktree ${candidate.id} revision must be an immutable commit/hash`);
    const repo = path.join(workspace, lock.materialized_path);
    const target = path.join(workspace, "worktrees", candidate.id);
    try { await fs.access(target); }
    catch {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await command("git", ["fetch", "--depth", "1", "origin", candidate.revision], repo);
      await command("git", ["worktree", "add", "--detach", target, "FETCH_HEAD"], repo);
    }
    const resolved = await command("git", ["rev-parse", "HEAD"], target);
    if (!resolved.startsWith(candidate.revision)) throw new Error(`candidate ${candidate.id} resolved ${resolved}, expected ${candidate.revision}`);
    created.push({ id: candidate.id, input_id: candidate.input_id, revision: candidate.revision, path: `worktrees/${candidate.id}`, resolved_revision: resolved, role: candidate.role });
  }
  await writeJson(path.join(workspace, "worktrees", "manifest.json"), { version: 1, worktrees: created });
}

/** A human-readable plan plus one foreach source per dependency level. */
export async function writeSuitePlanStage(workspace: string, config: ExperimentConfig): Promise<void> {
  const levels = suiteLevels(config);
  const seeds = config.evaluation?.seeds.length ?? 0;
  const plannedTrials = levels.flat().reduce((total, study) => total + study.conditions.length * seeds, 0);
  if (plannedTrials > config.execution.max_trials) {
    throw new Error(`suite requires ${plannedTrials} condition/seed trials, exceeding execution.max_trials ${config.execution.max_trials}`);
  }
  const plan = { version: 1, suite_id: config.suite?.id ?? "single-study", profile: config.profile, evaluation: config.evaluation ?? null, levels: levels.map((studies, index) => ({ id: `level-${index + 1}`, items: studies })), active_studies: levels.flat() };
  await writeJson(path.join(workspace, "runs", "suite-plan.json"), plan);
  await Promise.all(levels.map((studies, index) => writeJson(path.join(workspace, "runs", `study-level-${index + 1}.json`), { version: 1, items: studies })));
}

function runnerCommand(config: ExperimentConfig): { command: string; cwd?: string } {
  if (config.runner.kind === "command") {
    if (!config.runner.command) throw new Error("runner.command must be configured before a study can execute");
    return { command: config.runner.command, cwd: config.runner.workdir };
  }
  if (config.runner.kind === "autoscientists") {
    if (!config.runner.launch_command) throw new Error("runner.launch_command must be configured before an AutoScientists study can execute");
    return { command: config.runner.launch_command, cwd: config.runner.repo_path };
  }
  throw new Error("Modal studies are executed by the configured remote-job adapter, not stage run-study");
}

export async function runStudyStage(workspace: string, config: ExperimentConfig, studyId: string): Promise<void> {
  const plan = await readJson<{ active_studies: PlannedStudy[] }>(path.join(workspace, "runs", "suite-plan.json"));
  const study = plan.active_studies.find((item) => item.id === studyId);
  if (!study) throw new Error(`study ${studyId} is not active in runs/suite-plan.json`);
  const output = `results/studies/${studyId}/raw-results.json`;
  const log = path.join(workspace, "logs", "studies", studyId, "runner.log");
  await fs.mkdir(path.dirname(log), { recursive: true });
  const run = runnerCommand(config);
  const worktrees = await readJson<{ worktrees?: unknown }>(path.join(workspace, "worktrees", "manifest.json")).catch(() => ({ worktrees: [] }));
  try {
    const result = await execFile("sh", ["-lc", run.command], {
      cwd: run.cwd ? path.resolve(workspace, run.cwd) : workspace,
      encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, LONGEXPERIMENT_WORKSPACE: workspace, LONGEXPERIMENT_STUDY_ID: study.id, LONGEXPERIMENT_STUDY_KIND: study.kind, LONGEXPERIMENT_RESULT_PATH: output, LONGEXPERIMENT_SEEDS: (config.evaluation?.seeds ?? []).join(","), LONGEXPERIMENT_CONDITIONS: study.conditions.join(","), LONGEXPERIMENT_INPUT_LOCKS: "inputs/locks.json", LONGEXPERIMENT_WORKTREES: JSON.stringify(worktrees.worktrees ?? []) },
    });
    await fs.writeFile(log, `${result.stdout}\n${result.stderr}`, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await fs.appendFile(log, `\nRUNNER FAILED\n${message}\n`, "utf8");
    throw new Error(`study ${studyId} runner failed; inspect ${path.relative(workspace, log)}`);
  }
  await fs.access(path.join(workspace, output));
}

function expectedInputRevisions(config: ExperimentConfig): Record<string, string> { return Object.fromEntries(allInputs(config).map((input) => [input.id, input.revision])); }

async function verifyArtifacts(workspace: string, paths: string[], label: string): Promise<Array<{ path: string; sha256: string }>> {
  const result: Array<{ path: string; sha256: string }> = [];
  for (const rel of paths) {
    if (!safeRelative(rel)) throw new Error(`${label} artifact path is not workspace-relative: ${rel}`);
    const full = path.join(workspace, rel);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat?.isFile()) throw new Error(`${label} artifact does not exist: ${rel}`);
    result.push({ path: rel, sha256: await fileSha256(full) });
  }
  return result;
}

export async function writeStudyAuditStage(workspace: string, config: ExperimentConfig, studyId: string): Promise<void> {
  const plan = await readJson<{ active_studies: PlannedStudy[] }>(path.join(workspace, "runs", "suite-plan.json"));
  const study = plan.active_studies.find((item) => item.id === studyId);
  if (!study) throw new Error(`study ${studyId} is not active`);
  const rel = `results/studies/${studyId}/raw-results.json`;
  const raw = StudyRawResults.parse(await readJson(path.join(workspace, rel), rel));
  if (raw.study_id !== studyId || raw.status !== "completed") throw new Error(`study ${studyId} must be completed and identify itself correctly`);
  const expectedSeeds = config.evaluation?.seeds ?? [];
  const expectedPairs = new Set(study.conditions.flatMap((condition) => expectedSeeds.map((seed) => `${condition}:${seed}`)));
  const actualPairs = new Set(raw.trials.map((trial) => `${trial.condition}:${trial.seed}`));
  if (actualPairs.size !== raw.trials.length) throw new Error(`study ${studyId} has duplicate condition/seed trial records`);
  for (const pair of expectedPairs) if (!actualPairs.has(pair)) throw new Error(`study ${studyId} is missing required trial ${pair}`);
  if (raw.trials.length > config.execution.max_trials) throw new Error(`study ${studyId} has ${raw.trials.length} trials, exceeding execution.max_trials ${config.execution.max_trials}`);
  const requiredRevisions = expectedInputRevisions(config);
  for (const [id, revision] of Object.entries(requiredRevisions)) if (raw.input_revisions[id] !== revision) throw new Error(`study ${studyId} input revision mismatch for ${id}`);
  const artifactPaths = [...raw.artifacts.tables, ...raw.artifacts.figures, ...raw.artifacts.logs, ...raw.trials.flatMap((trial) => trial.artifacts)];
  const artifacts = await verifyArtifacts(workspace, artifactPaths, `study ${studyId}`);
  await writeJson(path.join(workspace, "results", "studies", studyId, "audit.json"), { version: 1, study_id: studyId, status: "passed", required_seeds: expectedSeeds, required_conditions: study.conditions, raw_results_sha256: await fileSha256(path.join(workspace, rel)), artifacts, verified_at: new Date().toISOString() });
}

function mean(values: number[]): number { return values.reduce((total, value) => total + value, 0) / values.length; }
function percentile(values: number[], q: number): number { const sorted = [...values].sort((a, b) => a - b); const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1)))); return sorted[index]; }
function deterministicBootstrap(deltas: number[], repeats = 2000): { lower: number; upper: number } {
  let state = 0x9e3779b9;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return ((state >>> 0) % 1_000_000) / 1_000_000; };
  const samples: number[] = [];
  for (let i = 0; i < repeats; i += 1) samples.push(mean(Array.from({ length: deltas.length }, () => deltas[Math.floor(random() * deltas.length)])));
  return { lower: percentile(samples, 0.025), upper: percentile(samples, 0.975) };
}

export async function writeAggregateResultsStage(workspace: string, config: ExperimentConfig): Promise<void> {
  const plan = await readJson<{ active_studies: PlannedStudy[] }>(path.join(workspace, "runs", "suite-plan.json"));
  const rows = await Promise.all(plan.active_studies.map(async (study) => StudyRawResults.parse(await readJson(path.join(workspace, "results", "studies", study.id, "raw-results.json")))));
  const trials = rows.flatMap((row) => row.trials);
  if (trials.length === 0) throw new Error("no completed trials were supplied by active studies");
  const evaluation = config.evaluation;
  if (!evaluation) throw new Error("publication aggregation requires an evaluation contract");
  const baseline = new Map(trials.filter((trial) => trial.condition === evaluation.baseline_id).map((trial) => [trial.seed, trial]));
  if (baseline.size !== evaluation.seeds.length) throw new Error(`expected one ${evaluation.baseline_id} baseline trial for every configured seed`);
  const treatments = [...new Set(trials.map((trial) => trial.condition).filter((condition) => condition !== evaluation.baseline_id))];
  const comparisons = treatments.flatMap((treatment) => {
    const bySeed = new Map(trials.filter((trial) => trial.condition === treatment).map((trial) => [trial.seed, trial]));
    const paired = evaluation.seeds.flatMap((seed) => {
      const base = baseline.get(seed); const candidate = bySeed.get(seed);
      return base && candidate ? [{ seed, base, candidate }] : [];
    });
    if (paired.length < evaluation.seeds.length) return [];
    const deltas = paired.map(({ base, candidate }) => candidate.metrics[evaluation.primary_metric] - base.metrics[evaluation.primary_metric]);
    if (deltas.some((value) => !Number.isFinite(value))) throw new Error(`treatment ${treatment} is missing primary metric ${evaluation.primary_metric}`);
    const confidence = deterministicBootstrap(deltas);
    return [{ id: `${treatment}-vs-${evaluation.baseline_id}`, metric: evaluation.primary_metric, baseline_condition: evaluation.baseline_id, treatment_condition: treatment, estimate: mean(deltas), confidence_interval: { level: 0.95, ...confidence }, method: `deterministic paired bootstrap (n=${deltas.length}, 2000 resamples)`, paired_seeds: paired.map((item) => item.seed) }];
  });
  if (comparisons.length === 0) throw new Error(`no treatment has a complete paired comparison against baseline ${evaluation.baseline_id}`);
  const aggregateMetrics = Object.fromEntries(treatments.map((condition) => [condition, mean(trials.filter((trial) => trial.condition === condition).map((trial) => trial.metrics[evaluation.primary_metric]).filter((value): value is number => typeof value === "number"))]));
  const artifacts = { tables: rows.flatMap((row) => row.artifacts.tables), figures: rows.flatMap((row) => row.artifacts.figures), logs: rows.flatMap((row) => row.artifacts.logs) };
  await writeJson(path.join(workspace, "results", "raw-results.json"), { version: 1, status: "completed", best_run_id: comparisons[0].id, trial_count: trials.length, statistical_test: evaluation.statistical_test, metrics: aggregateMetrics, trials, comparisons, artifacts, runner_version: [...new Set(rows.map((row) => row.runner_version))].join(","), input_revisions: expectedInputRevisions(config), environment: Object.assign({}, ...rows.map((row) => row.environment)) });
}

export async function writeAuditStage(workspace: string, config: ExperimentConfig): Promise<void> {
  const rawPath = path.join(workspace, "results", "raw-results.json");
  const raw = await readJson<{ version?: unknown; status?: unknown; best_run_id?: unknown; trial_count?: unknown; statistical_test?: unknown; metrics?: unknown; trials?: unknown; comparisons?: unknown; artifacts?: unknown; runner_version?: unknown; input_revisions?: unknown; environment?: unknown }>(rawPath);
  if (raw.version !== 1 || raw.status !== "completed" || !Array.isArray(raw.trials) || !Array.isArray(raw.comparisons) || !raw.metrics || typeof raw.metrics !== "object") throw new Error("aggregate raw-results.json is incomplete or not completed");
  const trials = raw.trials.map((trial) => TrialRecord.parse(trial));
  if (raw.trial_count !== trials.length || trials.length === 0) throw new Error("aggregate trial_count must exactly match completed trial records");
  const evaluation = config.evaluation;
  if (!evaluation || raw.statistical_test !== evaluation.statistical_test) throw new Error("aggregate statistical_test must equal the configured evaluation contract");
  const comparisons = raw.comparisons as Array<{ metric?: unknown; paired_seeds?: unknown; confidence_interval?: unknown }>;
  if (comparisons.length === 0 || comparisons.some((comparison) => comparison.metric !== evaluation.primary_metric || !Array.isArray(comparison.paired_seeds) || comparison.paired_seeds.length < evaluation.seeds.length || !comparison.confidence_interval)) throw new Error("aggregate comparisons do not satisfy the configured paired evaluation contract");
  const revisions = raw.input_revisions as Record<string, unknown>;
  for (const [id, pin] of Object.entries(expectedInputRevisions(config))) if (revisions?.[id] !== pin) throw new Error(`aggregate input revision mismatch for ${id}`);
  const artifacts = raw.artifacts as { tables?: string[]; figures?: string[]; logs?: string[] };
  const verifiedArtifacts = await verifyArtifacts(workspace, [...(artifacts.tables ?? []), ...(artifacts.figures ?? []), ...(artifacts.logs ?? [])], "aggregate result");
  const locksPath = path.join(workspace, "inputs", "locks.json");
  const resultSha = await fileSha256(rawPath);
  const manifest = ExperimentManifest.parse({
    version: 1, project_id: config.project.id, hypothesis: config.hypothesis, status: "completed", ...(typeof raw.best_run_id === "string" ? { best_run_id: raw.best_run_id } : {}),
    trial_count: trials.length, statistical_test: evaluation.statistical_test, metrics: raw.metrics, trials, comparisons: raw.comparisons,
    artifacts: { results_json: "results/raw-results.json", tables: artifacts.tables ?? [], figures: artifacts.figures ?? [], logs: [...new Set(["logs/runner.log", ...(artifacts.logs ?? [])])] },
    provenance: { runner_kind: config.runner.kind, ...(typeof raw.runner_version === "string" ? { runner_version: raw.runner_version } : {}), input_revisions: expectedInputRevisions(config), input_locks_sha256: await fileSha256(locksPath), result_sha256: resultSha, environment: (raw.environment && typeof raw.environment === "object" ? raw.environment : {}) as Record<string, string>, generated_at: new Date().toISOString() },
    publication_eligible: publicationEligible(config, { status: "completed", trialCount: trials.length, comparisons: raw.comparisons as never[], verifiedArtifacts: verifiedArtifacts.length, requiredSeeds: evaluation.seeds.length }),
  });
  await writeJson(path.join(workspace, "results", "experiment-manifest.json"), manifest);
  await fs.writeFile(path.join(workspace, "reports", "result-audit.md"), ["# Result Audit", "", `Status: **${manifest.status}**`, `Publication eligible: **${manifest.publication_eligible ? "yes" : "no"}**`, "", "## Verified comparisons", "", ...manifest.comparisons.map((comparison) => `- ${comparison.id}: ${comparison.metric} Δ=${comparison.estimate.toFixed(6)}, 95% CI [${comparison.confidence_interval.lower.toFixed(6)}, ${comparison.confidence_interval.upper.toFixed(6)}], paired seeds ${comparison.paired_seeds.join(", ")}`), "", "## Immutable provenance", "", `- Input locks SHA-256: ${manifest.provenance.input_locks_sha256}`, `- Result SHA-256: ${manifest.provenance.result_sha256}`, ...verifiedArtifacts.map((artifact) => `- ${artifact.path}: ${artifact.sha256}`), ""].join("\n"), "utf-8");
}

export async function writeReportStage(workspace: string): Promise<void> {
  const manifest = ExperimentManifest.parse(await readJson(path.join(workspace, "results", "experiment-manifest.json")));
  const lines = ["# Experiment Report", "", "## Hypothesis", "", manifest.hypothesis, "", "## Status", "", manifest.status, "", "## Verified Results", "", ...manifest.comparisons.map((comparison) => `- ${comparison.id}: ${comparison.metric} Δ=${comparison.estimate}; 95% CI [${comparison.confidence_interval.lower}, ${comparison.confidence_interval.upper}]`), "", "## Downstream Hand-off", "", "LongWrite may consume only results/experiment-manifest.json and the checksummed artifacts it names. It must bind this manifest to a matching pinned repository snapshot before making code-specific empirical claims.", ""];
  await fs.writeFile(path.join(workspace, "reports", "experiment-report.md"), lines.join("\n"), "utf-8");
}
