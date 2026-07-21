import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { ExperimentConfig, type ExperimentConfig as ExperimentConfigType } from "./schema.js";
import { manifestYaml } from "./compiler.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export type ScaffoldOptions = {
  targetDir: string;
  projectId: string;
  name?: string;
  hypothesis: string;
  profile?: "existing_code" | "public_benchmark" | "from_scratch";
  authoringMode?: "prescribed" | "agentic";
  researchQuestion?: string;
  runnerKind?: "command" | "autoscientists";
  command?: string;
  autoScientistsRepo?: string;
  autoScientistsTask?: string;
};

export async function scaffoldExperimentWorkspace(opts: ScaffoldOptions): Promise<string[]> {
  const configPath = path.join(opts.targetDir, "experiment.yaml");
  try {
    await fs.access(configPath);
    throw new Error(`Refusing to scaffold: ${configPath} already exists`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Refusing")) throw error;
  }

  const raw: ExperimentConfigType = ExperimentConfig.parse({
    version: 1,
    project: { id: opts.projectId, name: opts.name ?? opts.projectId },
    profile: opts.profile ?? "existing_code",
    authoring: opts.authoringMode === "agentic" ? { mode: "agentic" } : { mode: "prescribed" },
    hypothesis: opts.hypothesis,
    ...(opts.researchQuestion ? { research_question: opts.researchQuestion } : {}),
    ...(opts.authoringMode === "agentic" ? {
      evaluation: { primary_metric: "primary_metric", direction: "maximize", baseline_id: "baseline", control: "fixed evaluation data, compute budget, and evaluator", seeds: [11, 23, 47], statistical_test: "paired bootstrap confidence interval" },
      suite: { id: "agentic-primary-study", max_rounds: 3, studies: [{ id: "primary", kind: "training_ablation", depends_on: [], acceptance_criteria: ["complete baseline and candidate trials under the approved metric"], conditions: ["baseline", "candidate"] }] },
      execution: { max_trials: 12, max_active_run_minutes: 480, max_parallel_trials: 1, requires_design_approval: true, requires_revision_approval: true, candidate_worktrees: [], enabled_optional_actions: [] },
    } : {}),
    runner: opts.runnerKind === "autoscientists"
      ? { kind: "autoscientists", repo_path: opts.autoScientistsRepo ?? "../AutoScientists", task: opts.autoScientistsTask ?? "configure-task" }
      : { kind: "command", ...(opts.command ? { command: opts.command } : {}) },
  });
  const dirs = ["runs", "results", "reports", "artifacts", "logs", "inputs", "worktrees", "agent"];
  await fs.mkdir(opts.targetDir, { recursive: true });
  for (const dir of dirs) await fs.mkdir(path.join(opts.targetDir, dir), { recursive: true });
  await fs.writeFile(configPath, stringify(raw), "utf-8");
  await fs.writeFile(path.join(opts.targetDir, "experiment_brief.md"), [
    "# Experiment Brief", "", `## Hypothesis`, "", raw.hypothesis, "",
    "## Success Contract", "",
    "The completed runner must write results/raw-results.json. The audit stage then creates results/experiment-manifest.json, with metrics and artifact paths suitable for LongWrite.", "",
    "## Scope", "",
    "This workspace controls an experiment runner through MalaClaw. It does not claim to reproduce an external runner's private or task-specific internal agent graph.", "",
  ].join("\n"), "utf-8");
  await fs.writeFile(path.join(opts.targetDir, "malaclaw.yaml"), manifestYaml(raw), "utf-8");
  await fs.cp(path.join(packageRoot, "templates"), path.join(opts.targetDir, "templates"), { recursive: true });
  return [...dirs.map((dir) => `${dir}/`), "experiment.yaml", "experiment_brief.md", "malaclaw.yaml", "templates/"];
}

/** Create a workspace from a checked-in flagship config without copying its
 * result artifacts. Keeping this separate from `init` makes the runnable
 * flagship package inspectable and avoids a hidden config fork. */
export async function scaffoldFlagshipWorkspace(targetDir: string, config: ExperimentConfigType): Promise<string[]> {
  const configPath = path.join(targetDir, "experiment.yaml");
  try { await fs.access(configPath); throw new Error(`Refusing to scaffold: ${configPath} already exists`); }
  catch (error) { if (error instanceof Error && error.message.startsWith("Refusing")) throw error; }
  const dirs = ["runs", "results", "reports", "artifacts", "logs", "inputs", "worktrees", ...(config.authoring.mode === "agentic" ? ["agent"] : [])];
  await fs.mkdir(targetDir, { recursive: true });
  for (const dir of dirs) await fs.mkdir(path.join(targetDir, dir), { recursive: true });
  await fs.writeFile(configPath, stringify(config), "utf8");
  await fs.writeFile(path.join(targetDir, "experiment_brief.md"), [
    `# ${config.project.name ?? config.project.id}`, "", "## Hypothesis", "", config.hypothesis, "",
    "## Flagship execution contract", "", "Review experiment.yaml, runner-specific environment variables, immutable input pins, and budget before approving the design. The run must produce per-study records; LongExperiment verifies results rather than accepting a self-reported summary.", "",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(targetDir, "malaclaw.yaml"), manifestYaml(config), "utf8");
  await fs.cp(path.join(packageRoot, "templates"), path.join(targetDir, "templates"), { recursive: true });
  return [...dirs.map((dir) => `${dir}/`), "experiment.yaml", "experiment_brief.md", "malaclaw.yaml", "templates/"];
}
