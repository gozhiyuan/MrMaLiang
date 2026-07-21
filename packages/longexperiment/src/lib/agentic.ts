import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import type { ExperimentConfig as ExperimentConfigType } from "./schema.js";
import { StudyRawResults } from "./schema.js";

const execFile = promisify(execFileCallback);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const longwriteCli = path.resolve(packageRoot, "..", "longwrite", "dist", "cli.js");

const AgenticExperimentProposal = z.object({
  version: z.literal(1),
  research_question: z.string().min(12),
  hypothesis: z.string().min(12),
  rationale: z.string().min(40),
  literature_source_ids: z.array(z.string().min(1)).min(2).max(30),
  primary_metric: z.string().min(1),
  direction: z.enum(["maximize", "minimize"]),
  baseline_condition: z.string().min(1),
  treatment_conditions: z.array(z.string().min(1)).min(1).max(12),
  control: z.string().min(8),
  seeds: z.array(z.number().int().nonnegative()).min(2).max(20),
  implementation_plan: z.array(z.string().min(8)).min(2).max(20),
  stopping_rule: z.string().min(12),
  risks: z.array(z.string().min(8)).min(1).max(12),
}).strict();

const CandidateBundle = z.object({
  version: z.literal(1),
  entrypoint: z.string().min(1),
  summary: z.string().min(20),
  files: z.array(z.object({
    path: z.string().min(1).max(300),
    role: z.enum(["source", "test", "config", "documentation"]),
    content: z.string(),
  }).strict()).min(2).max(80),
}).strict();

const ResultInterpretation = z.object({
  version: z.literal(1),
  conclusion: z.enum(["supported", "not_supported", "inconclusive"]),
  comparison_ids: z.array(z.string().min(1)).min(1),
  summary: z.string().min(30),
  limitations: z.array(z.string().min(8)).min(1),
  follow_up: z.string().min(8),
}).strict();

type LiteratureContext = { version: 1; sources: Array<{ id: string; title: string; abstract: string; url?: string; citation_depth?: string; quality_score?: number }> };
type LockFile = { inputs: Array<{ id: string; revision: string; resolved_revision: string; materialized_path?: string }> };

async function readJson<T>(filePath: string): Promise<T> { return JSON.parse(await fs.readFile(filePath, "utf8")) as T; }
async function writeJson(filePath: string, value: unknown): Promise<void> { await fs.mkdir(path.dirname(filePath), { recursive: true }); await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function sameValues(left: readonly unknown[], right: readonly unknown[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }

function candidateProcessEnv(workspace: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const allowed = ["PATH", "PYTHONPATH", "VIRTUAL_ENV", "CONDA_PREFIX", "CUDA_VISIBLE_DEVICES", "HF_HOME", "TRANSFORMERS_CACHE", "TORCH_HOME", "XDG_CACHE_HOME", "TMPDIR", "TMP", "TEMP", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key];
  // Do not expose the operator's home directory or provider/API credentials to
  // generated tests and runners. This reduces ambient authority but is not an
  // OS sandbox; the explicit human execution approval remains mandatory.
  env.HOME = path.join(workspace, "agent", "runtime-home");
  return { ...env, ...extra };
}

async function runLongWrite(args: string[], cwd: string): Promise<void> {
  await fs.access(longwriteCli).catch(() => { throw new Error("LongWrite is not built; run npm run build before agentic experiment research"); });
  await execFile(process.execPath, [longwriteCli, ...args], { cwd, env: process.env, maxBuffer: 20 * 1024 * 1024 });
}

async function selectedCodeFiles(root: string): Promise<string[]> {
  const preferred = new Set(["README", "README.md", "CITATION.cff", "pyproject.toml", "package.json"]);
  const result: string[] = [];
  async function visit(rel = ""): Promise<void> {
    if (result.length >= 80) return;
    const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (result.length >= 80) break;
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "__pycache__" || entry.name === "data") continue;
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && (preferred.has(entry.name) || [".py", ".md", ".yaml", ".yml", ".toml", ".json"].includes(path.extname(entry.name).toLowerCase()))) result.push(child);
    }
  }
  await visit();
  return result;
}

/** Reuse LongWrite's provider normalization/scoring for pre-experiment recall,
 * then expose only a bounded abstract dossier plus a bounded code snapshot to
 * the experiment-proposal agent. The full paper pipeline later revalidates
 * source evidence independently. */
export async function prepareAgentResearchContextStage(workspace: string, config: ExperimentConfigType): Promise<void> {
  if (config.authoring.mode !== "agentic") throw new Error("research context is available only for agentic authoring");
  const writingRel = config.outputs.longwrite_workspace;
  if (!writingRel) throw new Error("agentic empirical research requires outputs.longwrite_workspace");
  const writing = path.resolve(workspace, writingRel);
  const searchPlan = path.join(workspace, "agent", "search-plan.json");
  await fs.access(searchPlan);
  await fs.mkdir(path.join(writing, "sources"), { recursive: true });
  await fs.copyFile(searchPlan, path.join(writing, "sources", "search-plan.json"));
  for (const command of ["recall", "enrich", "score", "classify"] as const) await runLongWrite(["research", command, writing], workspace);

  const rows = (await fs.readFile(path.join(writing, "sources", "classified_sources.jsonl"), "utf8"))
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.citation_depth !== "D")
    .sort((a, b) => Number(b.quality_score ?? 0) - Number(a.quality_score ?? 0))
    .slice(0, 40)
    .map((row) => ({ id: String(row.id), title: String(row.title), abstract: String(row.abstract ?? ""), ...(typeof row.url === "string" ? { url: row.url } : {}), citation_depth: String(row.citation_depth), quality_score: Number(row.quality_score ?? 0) }));
  const context: LiteratureContext = { version: 1, sources: rows };
  await writeJson(path.join(workspace, "agent", "literature-context.json"), context);

  const locks = await readJson<LockFile>(path.join(workspace, "inputs", "locks.json"));
  const baseId = config.authoring.base_input_id;
  const lock = baseId ? locks.inputs.find((entry) => entry.id === baseId) : undefined;
  const lines = ["# Bounded Code Context", "", "This context is descriptive only. The pinned input lock remains authoritative.", ""];
  if (lock?.materialized_path) {
    const root = path.join(workspace, lock.materialized_path);
    let chars = lines.join("\n").length;
    for (const rel of await selectedCodeFiles(root)) {
      const abs = path.join(root, rel);
      const stat = await fs.stat(abs);
      if (stat.size > 100_000) continue;
      const text = await fs.readFile(abs, "utf8");
      const block = `## ${rel}\n\n${text}\n`;
      if (chars + block.length > 140_000) break;
      lines.push(block); chars += block.length;
    }
  } else lines.push("No base code repository is configured; author a minimal experiment project from scratch.", "");
  await fs.writeFile(path.join(workspace, "agent", "code-context.md"), `${lines.join("\n")}\n`, "utf8");
}

export async function validateAgentProposalStage(workspace: string, config: ExperimentConfigType): Promise<void> {
  const proposalPath = path.join(workspace, "agent", "experiment-proposal.json");
  let parsed: unknown;
  const findings: string[] = [];
  try { parsed = await readJson(proposalPath); } catch (error) { findings.push(`proposal is not readable JSON: ${error instanceof Error ? error.message : String(error)}`); }
  const result = AgenticExperimentProposal.safeParse(parsed);
  if (!result.success) findings.push(...result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
  const evaluation = config.evaluation;
  const context = await readJson<LiteratureContext>(path.join(workspace, "agent", "literature-context.json")).catch(() => ({ version: 1 as const, sources: [] }));
  if (result.success && evaluation) {
    const proposal = result.data;
    if (proposal.primary_metric !== evaluation.primary_metric) findings.push(`primary_metric must remain ${evaluation.primary_metric}`);
    if (proposal.direction !== evaluation.direction) findings.push(`direction must remain ${evaluation.direction}`);
    if (proposal.baseline_condition !== evaluation.baseline_id) findings.push(`baseline_condition must remain ${evaluation.baseline_id}`);
    if (proposal.control !== evaluation.control) findings.push(`control must remain the approved evaluation control`);
    if (!sameValues(proposal.seeds, evaluation.seeds)) findings.push("seeds must exactly match the approved evaluation seeds");
    const configured = [...new Set((config.suite?.studies ?? []).flatMap((study) => study.conditions).filter((condition) => condition !== evaluation.baseline_id))].sort();
    if (!sameValues([...proposal.treatment_conditions].sort(), configured)) findings.push(`treatment_conditions must exactly match configured conditions: ${configured.join(", ")}`);
    const known = new Set(context.sources.map((source) => source.id));
    for (const id of proposal.literature_source_ids) if (!known.has(id)) findings.push(`unknown literature source id ${id}`);
  }
  const pass = result.success && findings.length === 0;
  if (pass) await writeJson(path.join(workspace, "agent", "validated-proposal.json"), result.data);
  await writeJson(path.join(workspace, "agent", "proposal-validation.json"), { version: 1, pass, findings });
  await writeJson(path.join(workspace, "reports", "metrics.json"), { proposal_readiness: pass ? 1 : 0 });
  const proposal = result.success ? result.data : null;
  await fs.writeFile(path.join(workspace, "reports", "experiment-design.md"), [
    "# Agent-authored Experiment Design", "", `Status: ${pass ? "validated" : "needs revision"}`, "",
    ...(proposal ? ["## Hypothesis", "", proposal.hypothesis, "", "## Method", "", ...proposal.implementation_plan.map((item) => `- ${item}`), ""] : []),
    "## Validation findings", "", ...(findings.length ? findings.map((finding) => `- ${finding}`) : ["- All proposal fields match the approved evidence, evaluation, seed, control, and budget envelope."]), "",
  ].join("\n"), "utf8");
  await writeJson(path.join(workspace, "runs", "trial-plan.json"), { version: 1, status: pass ? "validated-awaiting-approval" : "invalid", proposal_path: "agent/validated-proposal.json", max_trials: config.execution.max_trials, max_active_run_minutes: config.execution.max_active_run_minutes });
}

function safeBundlePath(rel: string): boolean {
  if (path.isAbsolute(rel) || rel.includes("\\")) return false;
  const normalized = path.posix.normalize(rel);
  return normalized === rel && !normalized.startsWith("../") && normalized !== ".." && !normalized.split("/").includes(".git");
}

async function assertNoSymlinkPath(root: string, rel: string): Promise<void> {
  let current = root;
  for (const segment of rel.split("/")) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stat?.isSymbolicLink()) throw new Error(`candidate overlay path traverses a symbolic link: ${rel}`);
  }
}

export async function materializeAgentCandidateStage(workspace: string, config: ExperimentConfigType): Promise<void> {
  if (config.authoring.mode !== "agentic") throw new Error("candidate materialization requires agentic authoring");
  const findings: string[] = [];
  let parsed: unknown;
  try { parsed = await readJson(path.join(workspace, "agent", "candidate-bundle.json")); } catch (error) { findings.push(`candidate bundle is not readable JSON: ${error instanceof Error ? error.message : String(error)}`); }
  const result = CandidateBundle.safeParse(parsed);
  if (!result.success) findings.push(...result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
  if (result.success) {
    if (result.data.entrypoint !== config.authoring.entrypoint) findings.push(`entrypoint must be ${config.authoring.entrypoint}`);
    if (result.data.files.length > config.authoring.max_files) findings.push(`file count exceeds ${config.authoring.max_files}`);
    const paths = new Set<string>();
    for (const file of result.data.files) {
      if (!safeBundlePath(file.path)) findings.push(`unsafe candidate path ${file.path}`);
      if (paths.has(file.path)) findings.push(`duplicate candidate path ${file.path}`);
      paths.add(file.path);
      if (Buffer.byteLength(file.content) > config.authoring.max_file_bytes) findings.push(`${file.path} exceeds max_file_bytes`);
      if (![".py", ".json", ".yaml", ".yml", ".toml", ".md", ".txt"].includes(path.extname(file.path).toLowerCase())) findings.push(`unsupported candidate file type ${file.path}`);
    }
    if (!paths.has(config.authoring.entrypoint)) findings.push(`bundle must include entrypoint ${config.authoring.entrypoint}`);
    if (config.authoring.require_tests && !result.data.files.some((file) => file.role === "test" && /(^|\/)test_[^/]+\.py$/.test(file.path))) findings.push("bundle must include at least one test_*.py file");
  }
  const pass = result.success && findings.length === 0;
  const project = path.join(workspace, "agent", "candidate", "project");
  if (pass) {
    // Reconstruct from the pinned base every round. Otherwise a file omitted
    // from a complete replacement bundle could survive from an earlier round.
    await fs.rm(project, { recursive: true, force: true });
    await fs.mkdir(project, { recursive: true });
    const baseId = config.authoring.base_input_id;
    if (baseId) {
      const locks = await readJson<LockFile>(path.join(workspace, "inputs", "locks.json"));
      const lock = locks.inputs.find((entry) => entry.id === baseId);
      if (!lock?.materialized_path) throw new Error(`base input ${baseId} is not materialized`);
      await fs.cp(path.join(workspace, lock.materialized_path), project, { recursive: true, filter: (source) => path.basename(source) !== ".git" });
      await fs.writeFile(path.join(project, ".maliang-base-copied"), `${lock.resolved_revision}\n`, "utf8");
    }
    for (const file of result.data.files) {
      await assertNoSymlinkPath(project, file.path);
      const target = path.join(project, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.content, "utf8");
    }
  }
  const manifest = { version: 1, status: pass ? "materialized" : "invalid", entrypoint: config.authoring.entrypoint, findings, files: result.success ? result.data.files.map((file) => ({ path: file.path, role: file.role, bytes: Buffer.byteLength(file.content), sha256: sha256(file.content) })) : [] };
  await writeJson(path.join(workspace, "agent", "candidate", "manifest.json"), manifest);
  await fs.writeFile(path.join(workspace, "reports", "candidate-materialization.md"), ["# Candidate Materialization", "", `Status: ${pass ? "pass" : "fail"}`, "", ...(findings.length ? findings.map((finding) => `- ${finding}`) : ["- Candidate source bundle is schema-valid and confined to the generated project root."]), ""].join("\n"), "utf8");
}

export async function testAgentCandidateStage(workspace: string, config: ExperimentConfigType): Promise<void> {
  if (config.authoring.mode !== "agentic") throw new Error("candidate tests require agentic authoring");
  const manifest = await readJson<{ status: string; files: Array<{ path: string }> }>(path.join(workspace, "agent", "candidate", "manifest.json"));
  const project = path.join(workspace, "agent", "candidate", "project");
  const logs: string[] = [];
  let pass = manifest.status === "materialized";
  if (pass) {
    try {
      await fs.mkdir(path.join(workspace, "agent", "runtime-home"), { recursive: true });
      const env = candidateProcessEnv(workspace);
      const python = manifest.files.filter((file) => file.path.endsWith(".py")).map((file) => file.path);
      if (python.length) {
        const compiled = await execFile("python3", ["-m", "py_compile", ...python], { cwd: project, env, maxBuffer: 5 * 1024 * 1024 });
        logs.push(compiled.stdout, compiled.stderr);
      }
      if (config.authoring.require_tests) {
        const tested = await execFile("python3", ["-m", "unittest", "discover", "-s", ".", "-p", "test_*.py"], { cwd: project, env, maxBuffer: 10 * 1024 * 1024 });
        logs.push(tested.stdout, tested.stderr);
      }
    } catch (error) { pass = false; logs.push(error instanceof Error ? error.message : String(error)); }
  } else logs.push("candidate bundle did not pass materialization validation");
  await fs.mkdir(path.join(workspace, "logs"), { recursive: true });
  await fs.writeFile(path.join(workspace, "logs", "agent-candidate-tests.log"), `${logs.join("\n")}\n`, "utf8");
  await writeJson(path.join(workspace, "agent", "candidate-test.json"), { version: 1, pass, log: "logs/agent-candidate-tests.log" });
}

function metricFromOutput(stdout: string, primaryMetric: string): { metric: number; artifacts: string[] } {
  const line = stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).at(-1);
  if (!line) throw new Error("runner produced no JSON result");
  const row = JSON.parse(line) as { metric?: unknown; metrics?: Record<string, unknown>; artifacts?: unknown };
  const value = typeof row.metric === "number" ? row.metric : row.metrics?.[primaryMetric];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`runner must report finite metric ${primaryMetric}`);
  if (row.artifacts !== undefined && (!Array.isArray(row.artifacts) || !row.artifacts.every((item) => typeof item === "string"))) throw new Error("runner artifacts must be string paths");
  return { metric: value, artifacts: (row.artifacts as string[] | undefined) ?? [] };
}

async function executeCandidate(workspace: string, config: ExperimentConfigType, studyId: string, condition: string, seed: number, smoke: boolean): Promise<{ metric: number; artifacts: string[]; stdout: string }> {
  if (config.authoring.mode !== "agentic" || !config.evaluation) throw new Error("agentic candidate execution requires authoring and evaluation config");
  const project = path.join(workspace, "agent", "candidate", "project");
  const artifactDir = path.join(workspace, "artifacts", smoke ? "smoke" : "trials", studyId, condition, String(seed));
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.mkdir(path.join(workspace, "agent", "runtime-home"), { recursive: true });
  const result = await execFile("python3", [config.authoring.entrypoint], {
    cwd: project,
    env: candidateProcessEnv(workspace, { LONGEXPERIMENT_WORKSPACE: workspace, LONGEXPERIMENT_STUDY_ID: studyId, LONGEXPERIMENT_CONDITION: condition, LONGEXPERIMENT_SEED: String(seed), LONGEXPERIMENT_SMOKE: smoke ? "1" : "0", LONGEXPERIMENT_ARTIFACT_DIR: artifactDir, LONGEXPERIMENT_PRIMARY_METRIC: config.evaluation.primary_metric }),
    maxBuffer: 20 * 1024 * 1024,
  });
  return { ...metricFromOutput(result.stdout, config.evaluation.primary_metric), stdout: `${result.stdout}${result.stderr}` };
}

export async function smokeAgentCandidateStage(workspace: string, config: ExperimentConfigType): Promise<void> {
  if (config.authoring.mode !== "agentic" || !config.evaluation) throw new Error("agentic smoke requires evaluation config");
  const test = await readJson<{ pass: boolean }>(path.join(workspace, "agent", "candidate-test.json"));
  const proposal = await readJson<z.infer<typeof AgenticExperimentProposal>>(path.join(workspace, "agent", "validated-proposal.json"));
  const rows: Array<{ condition: string; seed: number; metric?: number; error?: string }> = [];
  if (test.pass) {
    for (const condition of [proposal.baseline_condition, proposal.treatment_conditions[0]]) {
      try {
        const result = await executeCandidate(workspace, config, "smoke", condition, proposal.seeds[0], true);
        rows.push({ condition, seed: proposal.seeds[0], metric: result.metric });
        await fs.writeFile(path.join(workspace, "logs", `smoke-${condition}.log`), result.stdout, "utf8");
      } catch (error) { rows.push({ condition, seed: proposal.seeds[0], error: error instanceof Error ? error.message : String(error) }); }
    }
  }
  const pass = test.pass && rows.length === 2 && rows.every((row) => typeof row.metric === "number");
  await writeJson(path.join(workspace, "agent", "smoke-results.json"), { version: 1, pass, rows });
  await writeJson(path.join(workspace, "reports", "metrics.json"), { experiment_readiness: pass ? 1 : 0 });
  await fs.writeFile(path.join(workspace, "reports", "agentic-readiness.md"), ["# Agentic Experiment Readiness", "", `Status: ${pass ? "ready for approved trials" : "candidate revision required"}`, "", ...rows.map((row) => `- ${row.condition}, seed ${row.seed}: ${row.metric ?? row.error}`), ""].join("\n"), "utf8");
}

export async function runAgenticStudyStage(workspace: string, config: ExperimentConfigType, studyId: string): Promise<void> {
  if (config.authoring.mode !== "agentic" || !config.evaluation) throw new Error("agentic study execution requires evaluation config");
  const study = config.suite?.studies.find((item) => item.id === studyId);
  if (!study) throw new Error(`unknown agentic study ${studyId}`);
  const locks = await readJson<LockFile>(path.join(workspace, "inputs", "locks.json"));
  const trials: Array<{ id: string; seed: number; condition: string; status: "completed"; metrics: Record<string, number>; artifacts: string[] }> = [];
  const logs: string[] = [];
  for (const condition of study.conditions) for (const seed of config.evaluation.seeds) {
    const result = await executeCandidate(workspace, config, studyId, condition, seed, false);
    const logRel = `logs/studies/${studyId}/${condition}-${seed}.log`;
    await fs.mkdir(path.dirname(path.join(workspace, logRel)), { recursive: true });
    await fs.writeFile(path.join(workspace, logRel), result.stdout, "utf8"); logs.push(logRel);
    for (const artifact of result.artifacts) {
      if (path.isAbsolute(artifact) || path.posix.normalize(artifact).startsWith("../")) throw new Error(`runner returned unsafe artifact path ${artifact}`);
      await fs.access(path.join(workspace, artifact));
    }
    trials.push({ id: `${studyId}-${condition}-${seed}`, seed, condition, status: "completed", metrics: { [config.evaluation.primary_metric]: result.metric }, artifacts: result.artifacts });
  }
  const raw = StudyRawResults.parse({ version: 1, study_id: studyId, status: "completed", trials, runner_version: "agent-authored-candidate-v1", input_revisions: Object.fromEntries(locks.inputs.map((entry) => [entry.id, entry.revision])), environment: { authoring: "agentic", entrypoint: config.authoring.entrypoint }, artifacts: { tables: [], figures: [], logs } });
  await writeJson(path.join(workspace, "results", "studies", studyId, "raw-results.json"), raw);
}

export async function writeAgentApprovalStage(workspace: string, kind: "design" | "candidate" | "revision"): Promise<void> {
  await fs.writeFile(path.join(workspace, "reports", `${kind}-approval.md`), [
    `# ${kind === "design" ? "Design" : kind === "candidate" ? "Candidate Execution" : "Full-Trial Revision"} Approval`, "",
    "This marker records that MalaClaw released the explicit approval-gated stage. It does not certify scientific validity or experimental results.", "",
  ].join("\n"), "utf8");
}

export async function validateAgentResultInterpretationStage(workspace: string, config: ExperimentConfigType): Promise<void> {
  if (!config.evaluation) throw new Error("result interpretation requires evaluation config");
  const raw = await readJson<{ comparisons: Array<{ id: string; confidence_interval: { lower: number; upper: number } }> }>(path.join(workspace, "results", "raw-results.json"));
  const interpretation = ResultInterpretation.parse(await readJson(path.join(workspace, "agent", "result-interpretation.json")));
  const byId = new Map(raw.comparisons.map((comparison) => [comparison.id, comparison]));
  for (const id of interpretation.comparison_ids) if (!byId.has(id)) throw new Error(`result interpretation references unknown comparison ${id}`);
  const selected = interpretation.comparison_ids.map((id) => byId.get(id)!);
  const favorable = selected.every((comparison) => config.evaluation!.direction === "maximize" ? comparison.confidence_interval.lower > 0 : comparison.confidence_interval.upper < 0);
  const unfavorable = selected.every((comparison) => config.evaluation!.direction === "maximize" ? comparison.confidence_interval.upper < 0 : comparison.confidence_interval.lower > 0);
  const deterministicConclusion = favorable ? "supported" : unfavorable ? "not_supported" : "inconclusive";
  if (interpretation.conclusion !== deterministicConclusion) throw new Error(`interpretation conclusion ${interpretation.conclusion} conflicts with confidence intervals (${deterministicConclusion})`);
  await fs.writeFile(path.join(workspace, "reports", "result-interpretation.md"), [
    "# Result Interpretation", "", `Conclusion: ${interpretation.conclusion}`, "", interpretation.summary, "", "## Limitations", "", ...interpretation.limitations.map((item) => `- ${item}`), "", "## Follow-up", "", interpretation.follow_up, "",
  ].join("\n"), "utf8");
  await writeJson(path.join(workspace, "agent", "result-interpretation-validation.json"), { version: 1, pass: true, deterministic_conclusion: deterministicConclusion, comparison_ids: interpretation.comparison_ids });
}
