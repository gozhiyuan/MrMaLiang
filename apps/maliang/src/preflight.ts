import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { parse } from "yaml";
import { readMaliangProject } from "./project.js";
import { componentSubdir } from "./forward.js";
import { componentCli } from "./proxy.js";

export type ComponentReport = { status: "pass" | "fail" | "not_required"; checks: Array<{ id: string; pass: boolean; finding: string }> };
export type UnifiedPreflight = { version: 1; overall: "pass" | "fail"; writing: ComponentReport; experiment: ComponentReport; runtime: ComponentReport };

export function assembleUnifiedReport(parts: { writing: ComponentReport; experiment: ComponentReport; runtime: ComponentReport }): UnifiedPreflight {
  const required = [parts.writing, parts.experiment, parts.runtime].filter((r) => r.status !== "not_required");
  const overall = required.some((r) => r.status === "fail") ? "fail" : "pass";
  return { version: 1, overall, writing: parts.writing, experiment: parts.experiment, runtime: parts.runtime };
}

function statusFor(checks: Array<{ pass: boolean }>): "pass" | "fail" {
  return checks.every((check) => check.pass) ? "pass" : "fail";
}

async function commandOutput(command: string, args: string[], cwd: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${command} ${args.join(" ")} failed: ${stderr.trim() || `exit ${code}`}`)));
  });
}

/**
 * Spawns a child process and captures its outcome as DATA rather than
 * throwing: a component's own preflight command may legitimately exit
 * non-zero when it finds a failing check (that is a normal, expected
 * result to fold into the unified report, not a broken invocation).
 */
type CapturedRun = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; error?: string };

function captureRun(command: string, args: string[], cwd: string): Promise<CapturedRun> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => resolve({ code: null, signal: null, stdout, stderr, error: error.message }));
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

/** Runs the Node/MalaClaw lifecycle checks that gate any flagship run. */
async function runRuntimeChecks(workspace: string): Promise<ComponentReport> {
  const checks: Array<{ id: string; pass: boolean; finding: string }> = [];
  checks.push({ id: "node", pass: Number(process.versions.node.split(".")[0]) >= 22, finding: `Node ${process.version} (requires >=22)` });
  let malaclawVersion = "";
  try {
    malaclawVersion = await commandOutput("malaclaw", ["--version"], workspace);
  } catch {
    malaclawVersion = "";
  }
  const malaclawParts = malaclawVersion.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  const compatibleMalaClaw = Boolean(malaclawParts && malaclawParts[0] === 1 && (malaclawParts[1] > 0 || malaclawParts[2] >= 2));
  checks.push({ id: "malaclaw", pass: compatibleMalaClaw, finding: malaclawVersion ? `MalaClaw ${malaclawVersion} (supported >=1.0.2 <2.0.0)` : "MalaClaw >=1.0.2 <2.0.0 must be available on PATH" });
  return { status: statusFor(checks), checks };
}

/** Runner-configuration and immutable-input checks for the experiment component. */
async function runExperimentChecks(workspace: string, experimentSubdir: string): Promise<ComponentReport> {
  const checks: Array<{ id: string; pass: boolean; finding: string }> = [];
  let experiment: Record<string, any>;
  try {
    experiment = parse(await fs.readFile(path.join(workspace, experimentSubdir, "experiment.yaml"), "utf8")) as Record<string, any>;
  } catch (error) {
    return { status: "fail", checks: [{ id: "experiment_config", pass: false, finding: error instanceof Error ? error.message : String(error) }] };
  }
  const runner = experiment.runner ?? {};
  const agentic = experiment.authoring?.mode === "agentic";
  const configured = agentic || (runner.kind === "command" ? Boolean(runner.command) : runner.kind === "autoscientists" ? Boolean(runner.repo_path && runner.launch_command) : Boolean(runner.adapter_command && runner.app_path && runner.function_ref));
  checks.push({ id: "experiment_runner", pass: configured, finding: configured ? (agentic ? "agent-authored candidate runner is gated by schema, tests, smoke execution, and approval" : `configured ${runner.kind} runner`) : `configure runner fields for ${runner.kind ?? "command"} before execution` });
  const inputs = Object.values(experiment.inputs ?? {}).flat() as Array<{ id?: string; revision?: string }>;
  checks.push({ id: "experiment_inputs", pass: inputs.every((input) => /^[a-f0-9]{7,}$/i.test(input.revision ?? "")), finding: inputs.length ? "all declared experiment inputs use immutable revisions" : "no experiment inputs declared" });
  const evaluation = experiment.evaluation ?? {};
  const seeds = Array.isArray(evaluation.seeds) ? evaluation.seeds : [];
  const evaluationConfigured = typeof evaluation.primary_metric === "string" && typeof evaluation.baseline_id === "string" && ["maximize", "minimize"].includes(evaluation.direction) && seeds.length >= 2;
  checks.push({ id: "experiment_evaluation", pass: evaluationConfigured, finding: evaluationConfigured ? "primary metric, direction, baseline, and repeated seeds are fixed" : "configure a primary metric, direction, baseline, and at least two seeds" });
  const studies = Array.isArray(experiment.suite?.studies) ? experiment.suite.studies : [];
  const conditions = studies.flatMap((study: Record<string, unknown>) => Array.isArray(study.conditions) ? study.conditions : []);
  const suiteConfigured = studies.length > 0 && conditions.includes(evaluation.baseline_id) && conditions.some((condition: unknown) => condition !== evaluation.baseline_id);
  checks.push({ id: "experiment_suite", pass: suiteConfigured, finding: suiteConfigured ? "suite declares baseline and treatment conditions" : "configure an explicit suite with baseline and treatment conditions" });
  const plannedTrials = conditions.length * seeds.length;
  const withinTrialBudget = plannedTrials > 0 && plannedTrials <= Number(experiment.execution?.max_trials ?? 0);
  checks.push({ id: "experiment_trial_budget", pass: withinTrialBudget, finding: withinTrialBudget ? `${plannedTrials} planned condition/seed trials fit the declared ceiling` : `${plannedTrials} planned trials do not fit execution.max_trials` });
  if (agentic) {
    const approvals = experiment.execution?.requires_design_approval === true && experiment.execution?.requires_revision_approval === true;
    checks.push({ id: "agentic_approvals", pass: approvals, finding: approvals ? "design, generated-code execution, and full-trial approvals are required" : "agentic authoring requires design plus generated-code/full-trial approvals" });
    const bounded = Number(experiment.execution?.max_trials) > 0 && Number(experiment.execution?.max_active_run_minutes) > 0 && Number(experiment.authoring?.max_revision_rounds) > 0;
    checks.push({ id: "agentic_budget", pass: bounded, finding: bounded ? "trial, active-time, and revision-round ceilings are declared" : "agentic authoring requires positive trial, active-time, and revision-round ceilings" });
    const writing = typeof experiment.outputs?.longwrite_workspace === "string";
    checks.push({ id: "agentic_literature_handoff", pass: writing, finding: writing ? "pre-experiment recall is bound to the sibling LongWrite workspace" : "agentic empirical projects require outputs.longwrite_workspace" });
  }
  return { status: statusFor(checks), checks };
}

/**
 * Turns the (possibly-missing or malformed) generated writing preflight
 * report into a ComponentReport, folding a crash or bad JSON in as a
 * failing DATA point rather than letting it throw out of the caller.
 */
export function foldWritingReport(rawReport: string | null, outcome: Pick<CapturedRun, "code" | "signal" | "error">, fresh: boolean): ComponentReport {
  if (rawReport === null) {
    return { status: "fail", checks: [{ id: "writing_preflight", pass: false, finding: `longwrite preflight produced no reports/preflight.json (${outcome.error ?? `exit ${outcome.code ?? outcome.signal ?? "unknown"}`})` }] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawReport);
  } catch {
    return { status: "fail", checks: [{ id: "writing_preflight", pass: false, finding: "longwrite preflight report was not valid JSON" }] };
  }
  if (!parsed || typeof parsed !== "object" || typeof (parsed as { pass?: unknown }).pass !== "boolean" || !Array.isArray((parsed as { checks?: unknown }).checks)) {
    return { status: "fail", checks: [{ id: "writing_preflight", pass: false, finding: "longwrite preflight report did not match the expected schema" }] };
  }
  const checks = (parsed as { checks: unknown[] }).checks;
  if (!checks.every((check) => check && typeof check === "object" && typeof (check as { id?: unknown }).id === "string" && typeof (check as { pass?: unknown }).pass === "boolean" && typeof (check as { finding?: unknown }).finding === "string")) {
    return { status: "fail", checks: [{ id: "writing_preflight", pass: false, finding: "longwrite preflight report contained an invalid check" }] };
  }
  if (!fresh) return { status: "fail", checks: [{ id: "writing_preflight", pass: false, finding: "longwrite preflight did not produce a fresh report for this invocation" }] };
  const report = parsed as { pass: boolean; checks: Array<{ id: string; pass: boolean; finding: string }> };
  // A component preflight legitimately exits non-zero when *its report*
  // contains a failing check. Preserve those detailed checks for the unified
  // report. A passing report paired with a failed process, on the other hand,
  // is internally inconsistent and must fail closed.
  if (report.pass && ((outcome.code !== 0 && outcome.code !== null) || outcome.signal || outcome.error)) {
    return { status: "fail", checks: [{ id: "writing_preflight", pass: false, finding: `longwrite preflight exited unsuccessfully (${outcome.error ?? outcome.signal ?? `exit ${outcome.code}`})` }] };
  }
  return { status: report.pass ? "pass" : "fail", checks: report.checks };
}

/** Spawns `longwrite preflight` for the writing component and folds its generated report. */
async function runWritingChecks(workspace: string, writingSubdir: string, runtime: string | undefined): Promise<ComponentReport> {
  const writingDir = path.join(workspace, writingSubdir);
  const args = ["preflight", writingDir, ...(runtime ? ["--runtime", runtime] : [])];
  const reportPath = path.join(workspace, writingSubdir, "reports", "preflight.json");
  // This report is a derived snapshot. Remove only this prior snapshot before
  // invoking the component so a crash cannot be mistaken for an earlier pass.
  await fs.unlink(reportPath).catch(() => undefined);
  const captured = await captureRun(process.execPath, [componentCli("longwrite"), ...args], workspace);
  const rawReport = await fs.readFile(reportPath, "utf8").catch(() => null);
  return foldWritingReport(rawReport, captured, rawReport !== null);
}

export async function runUnifiedPreflight(workspace: string, runtime: string | undefined): Promise<UnifiedPreflight> {
  const resolvedWorkspace = path.resolve(workspace);
  const project = await readMaliangProject(resolvedWorkspace);

  const runtimeReport = await runRuntimeChecks(resolvedWorkspace);

  const experimentReport: ComponentReport = project.components.experiment
    ? await runExperimentChecks(resolvedWorkspace, componentSubdir(project, "experiment"))
    : { status: "not_required", checks: [] };

  const writingReport: ComponentReport = project.components.writing
    ? await runWritingChecks(resolvedWorkspace, componentSubdir(project, "writing"), runtime)
    : { status: "not_required", checks: [] };

  const report = assembleUnifiedReport({ writing: writingReport, experiment: experimentReport, runtime: runtimeReport });

  const reportsDir = path.join(resolvedWorkspace, "reports");
  await fs.mkdir(reportsDir, { recursive: true });
  await fs.writeFile(path.join(reportsDir, "maliang-preflight.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  return report;
}
