import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { scaffoldExperimentWorkspace, scaffoldFlagshipWorkspace } from "../src/lib/scaffold.js";
import { ExperimentConfig } from "../src/lib/schema.js";
import { writeAggregateResultsStage, writeAuditStage, writeDesignStage, writeReportStage, writeStudyAuditStage, writeSuitePlanStage } from "../src/lib/stages.js";

const dirs: string[] = [];
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

function config() {
  return ExperimentConfig.parse({
    version: 1, project: { id: "memory-ablation" }, profile: "existing_code", hypothesis: "Memory helps planning.",
    inputs: { code: [{ id: "repo", source: "https://example.com/repo.git", revision: "abcdef1234567", materialize: "external" }] },
    evaluation: { primary_metric: "success_rate", direction: "maximize", baseline_id: "baseline", control: "fixed prompts", seeds: [11, 23], statistical_test: "paired bootstrap confidence interval" },
    suite: { id: "suite", max_rounds: 2, studies: [
      { id: "baseline", kind: "inference_comparison", conditions: ["baseline"], acceptance_criteria: ["baseline"] },
      { id: "candidate", kind: "training_ablation", depends_on: ["baseline"], conditions: ["candidate"], acceptance_criteria: ["candidate"] },
    ] },
    runner: { kind: "command", command: "true" }, execution: { max_trials: 8, max_active_run_minutes: 10, max_parallel_trials: 2, requires_design_approval: false, requires_revision_approval: false },
  });
}

async function writeLocks(dir: string) {
  await fs.mkdir(path.join(dir, "inputs"), { recursive: true });
  await fs.writeFile(path.join(dir, "inputs", "locks.json"), JSON.stringify({ version: 1, inputs: [{ id: "repo", source: "https://example.com/repo.git", revision: "abcdef1234567", resolved_revision: "abcdef1234567", materialize: "external" }] }) + "\n");
}

async function writeStudy(dir: string, id: string, condition: string, values: number[]) {
  const relLog = `logs/studies/${id}/runner.log`;
  await fs.mkdir(path.join(dir, path.dirname(relLog)), { recursive: true });
  await fs.writeFile(path.join(dir, relLog), "completed\n");
  const trials = values.map((value, index) => ({ id: `${id}-${index}`, seed: [11, 23][index], condition, status: "completed", metrics: { success_rate: value }, artifacts: [relLog] }));
  const rel = path.join("results", "studies", id, "raw-results.json");
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), JSON.stringify({ version: 1, study_id: id, status: "completed", trials, runner_version: "fixture", input_revisions: { repo: "abcdef1234567" }, environment: { python: "fixture" }, artifacts: { tables: [], figures: [], logs: [relLog] } }) + "\n");
}

describe("LongExperiment executable suite", () => {
  it("parses every flagship as pinned, configured suite contract", async () => {
    for (const name of ["self_play_small_model", "nanogpt_ablation", "proteingym_autoscientists"]) {
      const raw = parse(await fs.readFile(path.join(packageRoot, "configs", "flagships", `${name}.yaml`), "utf8"));
      const parsed = ExperimentConfig.parse(raw);
      expect(parsed.suite?.studies.length).toBeGreaterThan(1);
      expect(parsed.evaluation?.seeds.length).toBeGreaterThanOrEqual(2);
      expect(parsed.inputs.code.concat(parsed.inputs.benchmarks, parsed.inputs.models).every((item) => /^[a-f0-9]{7,}$/i.test(item.revision))).toBe(true);
      expect(parsed.runner.kind === "command" ? parsed.runner.command : parsed.runner.kind === "autoscientists" ? parsed.runner.launch_command : parsed.runner.adapter_command).toBeTruthy();
    }
  });

  it("compiles dependency levels into executable foreach stages", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longexperiment-")); dirs.push(dir);
    await scaffoldExperimentWorkspace({ targetDir: dir, projectId: "memory-ablation", hypothesis: "Memory retrieval improves planning." });
    const manifest = parse(await fs.readFile(path.join(dir, "malaclaw.yaml"), "utf-8"));
    expect(manifest.workflow.stages.map((stage: { id: string }) => stage.id)).toEqual(["pin_inputs", "design", "prepare_worktrees", "suite_plan", "study_level_1", "aggregate_results", "audit_results", "report"]);
    expect(manifest.workflow.stages.find((stage: { id: string }) => stage.id === "study_level_1").type).toBe("foreach");
    expect(await fs.stat(path.join(dir, "templates", "runners", "nanogpt.py"))).toBeDefined();
  });

  it("compiles agentic authoring into proposal, code, smoke, approval, audit, and interpretation contracts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longexperiment-agentic-")); dirs.push(dir);
    const raw = parse(await fs.readFile(path.join(packageRoot, "configs", "flagships", "self_play_autonomous_empirical.yaml"), "utf8"));
    await scaffoldFlagshipWorkspace(dir, ExperimentConfig.parse(raw));
    const manifest = parse(await fs.readFile(path.join(dir, "malaclaw.yaml"), "utf8"));
    const ids = manifest.workflow.stages.map((stage: { id: string }) => stage.id);
    expect(ids).toEqual(["pin_inputs", "experiment_search_plan", "experiment_research_context", "experiment_proposal_loop", "design_approval", "candidate_revision_loop", "revision_approval", "suite_plan", "study_level_1", "aggregate_results", "audit_results", "interpret_results", "validate_result_interpretation", "report"]);
    expect(manifest.workflow.runtime).toBeUndefined();
    expect(manifest.runtime).toBe("codex");
    expect(manifest.workflow.stages.find((stage: { id: string }) => stage.id === "experiment_proposal_loop")).toMatchObject({ type: "loop", max_rounds: 2, on_exhaustion: "fail" });
    expect(manifest.workflow.stages.find((stage: { id: string }) => stage.id === "candidate_revision_loop")).toMatchObject({ type: "loop", max_rounds: 3, on_exhaustion: "fail" });
    expect(manifest.workflow.stages.find((stage: { id: string }) => stage.id === "design_approval").requires_human_approval).toBe(true);
    expect(manifest.workflow.stages.find((stage: { id: string }) => stage.id === "revision_approval").requires_human_approval).toBe(true);
    const candidate = manifest.workflow.stages.find((stage: { id: string }) => stage.id === "candidate_revision_loop");
    expect(candidate.stages.map((stage: { id: string }) => stage.id)).toEqual(["author_candidate", "materialize_candidate", "candidate_execution_approval", "test_candidate", "smoke_candidate"]);
    expect(candidate.stages.find((stage: { id: string }) => stage.id === "candidate_execution_approval").requires_human_approval).toBe(true);
  });

  it("scaffolds a pinned flagship without copying any result artifact", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longexperiment-flagship-")); dirs.push(dir);
    const raw = parse(await fs.readFile(path.join(packageRoot, "configs", "flagships", "nanogpt_ablation.yaml"), "utf8"));
    await scaffoldFlagshipWorkspace(dir, ExperimentConfig.parse(raw));
    const written = parse(await fs.readFile(path.join(dir, "experiment.yaml"), "utf8"));
    expect(written.inputs.code[0].revision).toMatch(/^[a-f0-9]{40}$/);
    await expect(fs.stat(path.join(dir, "templates", "runners", "nanogpt.py"))).resolves.toBeDefined();
    await expect(fs.access(path.join(dir, "results", "experiment-manifest.json"))).rejects.toThrow();
  });

  it("audits every required trial then computes a deterministic paired comparison", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longexperiment-suite-")); dirs.push(dir);
    const parsed = config(); await writeLocks(dir); await writeDesignStage(dir, parsed); await writeSuitePlanStage(dir, parsed);
    await writeStudy(dir, "baseline", "baseline", [0.50, 0.55]);
    await writeStudy(dir, "candidate", "candidate", [0.70, 0.75]);
    await writeStudyAuditStage(dir, parsed, "baseline"); await writeStudyAuditStage(dir, parsed, "candidate");
    await writeAggregateResultsStage(dir, parsed); await writeAuditStage(dir, parsed); await writeReportStage(dir);
    const manifest = JSON.parse(await fs.readFile(path.join(dir, "results", "experiment-manifest.json"), "utf-8"));
    expect(manifest.publication_eligible).toBe(true);
    expect(manifest.trial_count).toBe(4);
    expect(manifest.comparisons[0]).toMatchObject({ metric: "success_rate", paired_seeds: [11, 23] });
    expect(manifest.provenance.result_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses a study with a missing configured seed", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longexperiment-missing-seed-")); dirs.push(dir);
    const parsed = config(); await writeLocks(dir); await writeSuitePlanStage(dir, parsed);
    await writeStudy(dir, "baseline", "baseline", [0.50, 0.55]);
    const file = path.join(dir, "results", "studies", "baseline", "raw-results.json");
    const raw = JSON.parse(await fs.readFile(file, "utf8")); raw.trials.pop(); await fs.writeFile(file, JSON.stringify(raw));
    await expect(writeStudyAuditStage(dir, parsed, "baseline")).rejects.toThrow("missing required trial");
  });

  it("enforces max_trials across the whole active suite, not per study", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longexperiment-suite-budget-")); dirs.push(dir);
    const parsed = config();
    const overBudget = { ...parsed, execution: { ...parsed.execution, max_trials: 3 } };
    await expect(writeSuitePlanStage(dir, overBudget)).rejects.toThrow(/suite requires 4.*exceeding execution.max_trials 3/);
  });
});
