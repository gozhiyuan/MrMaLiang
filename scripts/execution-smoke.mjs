#!/usr/bin/env node
/**
 * Execution smoke: every scaffolded workspace must validate, and a prescribed
 * experiment must actually run.
 *
 * The golden-manifest suites compare compiled output against itself, so they
 * froze manifests the engine rejected and never noticed:
 *
 *  - prescribed workspaces emitted the worker runtime `script` into the
 *    manifest-level `runtime`, which is the provisioning enum;
 *  - the agentic search-plan stage declared `../writing/project_brief.md`,
 *    escaping the workspace;
 *  - the `fast` workflow profile disabled `structure_audit` while its in-loop
 *    consumers still required its outputs.
 *
 * All three failed `malaclaw validate` while the whole suite was green. This
 * scaffolds real workspaces, validates each, and executes one prescribed
 * experiment with a deterministic local runner — no model, no GPU, no network.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const maliang = path.join(root, "apps", "maliang", "dist", "cli.js");
const malaclaw = process.env.MALACLAW_SOURCE_DIR
  ? path.join(path.resolve(process.env.MALACLAW_SOURCE_DIR), "dist", "cli.js")
  : null;

const failures = [];
function check(condition, description) {
  if (condition) console.log(`  ok   ${description}`);
  else { console.log(`  FAIL ${description}`); failures.push(description); }
}
async function cli(bin, args, cwd) {
  try { return await run(process.execPath, [bin, ...args], { cwd, maxBuffer: 32e6 }); }
  catch (error) { return { stdout: error.stdout ?? "", stderr: error.stderr ?? String(error), failed: true }; }
}

const SCAFFOLDS = [
  { name: "survey (deep)", args: ["--template", "paper.survey", "--topic", "Durable agent workflows"], component: "writing" },
  // The fast profile disables stages other stages consume; it must still compile
  // to a workflow the engine accepts.
  { name: "survey (fast profile)", args: ["--template", "paper.survey", "--topic", "Durable agent workflows", "--", "--research-workflow-profile", "fast"], component: "writing" },
  { name: "standalone experiment", args: ["--template", "experiment.standalone", "--hypothesis", "A bounded search beats the frozen baseline"], component: "experiment" },
];

async function scaffoldsValidate(base) {
  console.log("\nscaffolded workspaces validate through the engine");
  for (const [index, scaffold] of SCAFFOLDS.entries()) {
    const name = `smoke-${index}`;
    const created = await cli(maliang, ["init", name, ...scaffold.args], base);
    if (created.failed) { check(false, `${scaffold.name}: maliang init`); continue; }
    if (!malaclaw) { console.log(`  skip ${scaffold.name}: MALACLAW_SOURCE_DIR not set`); continue; }
    const validated = await cli(malaclaw, ["validate"], path.join(base, name, scaffold.component));
    check(!validated.failed, `${scaffold.name}: compiled manifest passes malaclaw validate`);
    if (validated.failed) {
      console.log(`       ${`${validated.stdout}${validated.stderr}`.trim().split("\n").slice(-3).join("\n       ")}`);
    }
  }
}

/** A prescribed experiment must execute its study foreach, not just compile. */
async function experimentExecutes(base) {
  console.log("\nprescribed experiment executes its study foreach");
  if (!malaclaw) { console.log("  skip: MALACLAW_SOURCE_DIR not set"); return; }
  const name = "smoke-exec";
  const created = await cli(maliang, ["init", name, "--template", "experiment.standalone", "--hypothesis", "A bounded search beats the frozen baseline"], base);
  if (created.failed) { check(false, "maliang init standalone experiment"); return; }
  const workspace = path.join(base, name, "experiment");

  await fs.writeFile(path.join(workspace, "runner.mjs"), `
import fs from "node:fs";
import path from "node:path";
const conditions = (process.env.LONGEXPERIMENT_CONDITIONS ?? "baseline,candidate").split(",").filter(Boolean);
const seeds = (process.env.LONGEXPERIMENT_SEEDS ?? "11,23").split(",").filter(Boolean).map(Number);
const studyId = process.env.LONGEXPERIMENT_STUDY_ID ?? "primary";
const metric = process.env.LONGEXPERIMENT_PRIMARY_METRIC ?? "success_rate";
const dir = path.join("results", "studies", studyId);
fs.mkdirSync(dir, { recursive: true });
const value = (condition, seed) => Number(((condition === "baseline" ? 0.6 : 0.72) + (seed % 7) / 1000).toFixed(6));
const trials = conditions.flatMap((condition) => seeds.map((seed) => ({
  id: studyId + "-" + condition + "-" + seed, seed, condition, status: "completed",
  metrics: { [metric]: value(condition, seed) }, artifacts: [],
})));
fs.writeFileSync(path.join(dir, "raw-results.json"), JSON.stringify({
  version: 1, study_id: studyId, status: "completed", runner_version: "smoke-fixture-v1",
  input_revisions: {}, environment: { runner: "smoke" }, trials,
  artifacts: { tables: [], figures: [], logs: [] },
}, null, 2));
`);
  await fs.writeFile(path.join(workspace, "experiment.yaml"), `version: 1
project: { id: experiment, name: experiment, mode: computational_experiment }
profile: from_scratch
authoring: { mode: prescribed }
hypothesis: A bounded search beats the frozen baseline
inputs: { code: [], benchmarks: [], models: [] }
evaluation:
  primary_metric: success_rate
  direction: maximize
  baseline_id: baseline
  control: fixed local fixture evaluator
  seeds: [11, 23, 47]
  statistical_test: deterministic paired bootstrap
suite:
  id: suite
  max_rounds: 1
  studies:
    - id: primary
      kind: inference_comparison
      conditions: [baseline, candidate]
      acceptance_criteria: [candidate improves success_rate over baseline]
runner: { kind: command, command: node runner.mjs }
execution:
  max_trials: 12
  max_active_run_minutes: 30
  max_parallel_trials: 1
  requires_design_approval: true
  requires_revision_approval: true
  candidate_worktrees: []
  enabled_optional_actions: []
outputs: {}
`);

  check(!(await cli(malaclaw, ["validate"], workspace)).failed, "configured experiment passes malaclaw validate");
  await cli(malaclaw, ["flow", "run", "--runtime", "script"], workspace);
  await cli(malaclaw, ["flow", "approve", "approve-design-001"], workspace);
  const finished = await cli(malaclaw, ["flow", "run", "--runtime", "script"], workspace);
  const status = `${finished.stdout}${finished.stderr}`;

  check(/Flow status: completed/.test(status), "experiment flow reaches completed");
  const raw = await fs.readFile(path.join(workspace, "results", "studies", "primary", "raw-results.json"), "utf8").catch(() => null);
  check(raw !== null, "study foreach executed its runner and produced raw results");
  const manifest = await fs.readFile(path.join(workspace, "results", "experiment-manifest.json"), "utf8").catch(() => null);
  check(manifest !== null, "deterministic audit produced a certified experiment manifest");
  if (manifest) {
    const parsed = JSON.parse(manifest);
    check(parsed.comparisons?.length > 0, "manifest carries at least one audited comparison");
  }
}

const base = await fs.mkdtemp(path.join(os.tmpdir(), "maliang-exec-smoke-"));
try {
  await scaffoldsValidate(base);
  await experimentExecutes(base);
} finally {
  await fs.rm(base, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
  console.error(`execution smoke failed (${failures.length}):`);
  for (const item of failures) console.error(`  - ${item}`);
  process.exit(1);
}
console.log("execution smoke passed");
