#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { parse } from "yaml";
import { compileExperimentToManifest, manifestYaml } from "./lib/compiler.js";
import { ExperimentConfig } from "./lib/schema.js";
import { scaffoldExperimentWorkspace, scaffoldFlagshipWorkspace } from "./lib/scaffold.js";
import { writeAggregateResultsStage, writeAuditStage, writeDesignStage, writePinInputsStage, writeReportStage, writeStudyAuditStage, writeSuitePlanStage, writeWorktreesStage, runStudyStage } from "./lib/stages.js";
import { materializeAgentCandidateStage, prepareAgentResearchContextStage, runAgenticStudyStage, smokeAgentCandidateStage, testAgentCandidateStage, validateAgentProposalStage, validateAgentResultInterpretationStage, writeAgentApprovalStage } from "./lib/agentic.js";

function slugFromDir(dir: string): string {
  const base = path.basename(path.resolve(dir));
  return base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "longexperiment-project";
}
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readConfig(workspace: string) {
  const raw = await fs.readFile(path.join(workspace, "experiment.yaml"), "utf-8");
  return ExperimentConfig.parse(parse(raw));
}

const program = new Command();
program.name("longexperiment").description("Long-running experiment workflows on MalaClaw").version("0.2.0");

program.command("init <dir>")
  .description("Scaffold a computational-experiment workspace; execution remains safe until a runner command is configured")
  .requiredOption("--hypothesis <text>", "Falsifiable hypothesis or experiment objective")
  .option("--id <id>", "Project id")
  .option("--name <name>", "Project name")
  .option("--research-question <text>", "Optional research question")
  .option("--profile <id>", "Experiment profile: existing_code, public_benchmark, or from_scratch (default: existing_code)")
  .option("--authoring <mode>", "Experiment authoring: prescribed or agentic (default: prescribed)")
  .option("--runner <kind>", "Runner: command or autoscientists (default: command)")
  .option("--command <shell>", "Command runner shell command")
  .option("--autoscientists-repo <path>", "External AutoScientists checkout")
  .option("--autoscientists-task <id>", "External AutoScientists task id")
  .action(async (dir, opts) => {
    if (opts.runner && !["command", "autoscientists"].includes(opts.runner)) throw new Error("--runner must be command or autoscientists; configure Modal in experiment.yaml");
    if (opts.profile && !["existing_code", "public_benchmark", "from_scratch"].includes(opts.profile)) throw new Error("--profile must be existing_code, public_benchmark, or from_scratch");
    if (opts.authoring && !["prescribed", "agentic"].includes(opts.authoring)) throw new Error("--authoring must be prescribed or agentic");
    const created = await scaffoldExperimentWorkspace({
      targetDir: dir, projectId: opts.id ?? slugFromDir(dir), name: opts.name,
      hypothesis: opts.hypothesis, researchQuestion: opts.researchQuestion,
      profile: opts.profile,
      authoringMode: opts.authoring,
      runnerKind: opts.runner, command: opts.command,
      autoScientistsRepo: opts.autoscientistsRepo, autoScientistsTask: opts.autoscientistsTask,
    });
    console.log(`Created LongExperiment workspace at ${path.resolve(dir)}`);
    for (const file of created) console.log(`  + ${file}`);
    console.log(`\nNext: configure experiment.yaml, then run: malaclaw flow run --runtime script`);
  });

program.command("flagship <id> <dir>")
  .description("Scaffold one pinned flagship experiment workspace")
  .action(async (id, dir) => {
    const file = path.join(packageRoot, "configs", "flagships", `${id}.yaml`);
    const raw = await fs.readFile(file, "utf8").catch(() => { throw new Error(`Unknown flagship ${id}; expected a config in configs/flagships`); });
    const config = ExperimentConfig.parse(parse(raw));
    const created = await scaffoldFlagshipWorkspace(path.resolve(dir), config);
    console.log(`Created ${id} flagship workspace at ${path.resolve(dir)}`);
    for (const rel of created) console.log(`  + ${rel}`);
    console.log("\nNext: review experiment.yaml and runner environment, then run malaclaw validate and malaclaw flow run.");
  });

program.command("sync <workspace>")
  .description("Regenerate malaclaw.yaml from experiment.yaml")
  .action(async (workspace) => {
    const resolved = path.resolve(workspace);
    const config = await readConfig(resolved);
    await fs.writeFile(path.join(resolved, "malaclaw.yaml"), manifestYaml(config), "utf-8");
    console.log(`Synced ${path.join(resolved, "malaclaw.yaml")}`);
  });

program.command("validate <workspace>")
  .description("Validate experiment.yaml and print its MalaClaw workflow shape")
  .action(async (workspace) => {
    const config = await readConfig(path.resolve(workspace));
    const manifest = compileExperimentToManifest(config) as { workflow: { stages: Array<{ id: string }> } };
    console.log(`Valid LongExperiment config: ${config.project.id}`);
    console.log(`Runner: ${config.runner.kind}`);
    console.log(`Stages: ${manifest.workflow.stages.map((stage) => stage.id).join(" -> ")}`);
  });

const stage = program.command("stage").description("Internal deterministic stage commands used by generated workflows");

stage.command("design <workspace>").action(async (workspace) => {
  const resolved = path.resolve(workspace);
  await writeDesignStage(resolved, await readConfig(resolved));
});

stage.command("pin-inputs <workspace>").action(async (workspace) => {
  const resolved = path.resolve(workspace);
  await writePinInputsStage(resolved, await readConfig(resolved));
});

stage.command("worktrees <workspace>").action(async (workspace) => {
  const resolved = path.resolve(workspace);
  await writeWorktreesStage(resolved, await readConfig(resolved));
});

stage.command("run-study <workspace> <studyId>").action(async (workspace, studyId) => {
  const resolved = path.resolve(workspace);
  await runStudyStage(resolved, await readConfig(resolved), studyId);
});

stage.command("audit-study <workspace> <studyId>").action(async (workspace, studyId) => {
  const resolved = path.resolve(workspace);
  await writeStudyAuditStage(resolved, await readConfig(resolved), studyId);
});

stage.command("aggregate <workspace>").action(async (workspace) => {
  const resolved = path.resolve(workspace);
  await writeAggregateResultsStage(resolved, await readConfig(resolved));
});

stage.command("audit <workspace>").action(async (workspace) => {
  const resolved = path.resolve(workspace);
  await writeAuditStage(resolved, await readConfig(resolved));
});

stage.command("suite-plan <workspace>").action(async (workspace) => {
  const resolved = path.resolve(workspace);
  await writeSuitePlanStage(resolved, await readConfig(resolved));
});

stage.command("report <workspace>").action(async (workspace) => {
  await writeReportStage(path.resolve(workspace));
});

stage.command("research-context <workspace>").action(async (workspace) => {
  const resolved = path.resolve(workspace);
  await prepareAgentResearchContextStage(resolved, await readConfig(resolved));
});

stage.command("validate-proposal <workspace>").action(async (workspace) => {
  const resolved = path.resolve(workspace);
  await validateAgentProposalStage(resolved, await readConfig(resolved));
});

stage.command("materialize-candidate <workspace>").action(async (workspace) => {
  const resolved = path.resolve(workspace);
  await materializeAgentCandidateStage(resolved, await readConfig(resolved));
});

stage.command("test-candidate <workspace>").action(async (workspace) => {
  const resolved = path.resolve(workspace);
  await testAgentCandidateStage(resolved, await readConfig(resolved));
});

stage.command("smoke-candidate <workspace>").action(async (workspace) => {
  const resolved = path.resolve(workspace);
  await smokeAgentCandidateStage(resolved, await readConfig(resolved));
});

stage.command("run-agentic-study <workspace> <studyId>").action(async (workspace, studyId) => {
  const resolved = path.resolve(workspace);
  await runAgenticStudyStage(resolved, await readConfig(resolved), studyId);
});

stage.command("approval <workspace> <kind>").action(async (workspace, kind) => {
  if (kind !== "design" && kind !== "candidate" && kind !== "revision") throw new Error("approval kind must be design, candidate, or revision");
  await writeAgentApprovalStage(path.resolve(workspace), kind);
});

stage.command("validate-result-interpretation <workspace>").action(async (workspace) => {
  const resolved = path.resolve(workspace);
  await validateAgentResultInterpretationStage(resolved, await readConfig(resolved));
});

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
