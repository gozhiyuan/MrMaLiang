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
import { assertAuthorizedForUnattendedRun, issueLease } from "./lib/authorization.js";
import { readLineage } from "./lib/lineage.js";
import { initializeResearchState, readResearchState, updateResearchState } from "./lib/research-state.js";
import { ExperimentPilot } from "./lib/schema.js";
import { reconcileClaims } from "./lib/reproduction/claims.js";
import { auditBaseline, auditRoundCandidate, materializeRoundCandidates, promoteRound, researchInit, runCandidateStage, validateRoundPlan, verifyCandidateStage, writeResearchFindings } from "./lib/research-round.js";

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

program.command("authorize <workspace>")
  .description("Issue a bounded, config-bound unattended execution lease")
  .requiredOption("--unattended", "Confirm that this is an unattended authorization")
  .requiredOption("--max-trials <n>", "Maximum trial records allowed", Number)
  .requiredOption("--max-gpu-hours <n>", "Maximum GPU hours allowed", Number)
  .requiredOption("--max-wall-hours <n>", "Maximum wall-clock hours allowed", Number)
  .requiredOption("--expires-in <hours>", "Lease lifetime in hours", Number)
  .requiredOption("--approved-by <identity>", "Human approving this lease")
  .option("--max-storage-gb <n>", "Maximum artifact storage in GB", Number)
  .option("--max-cost-usd <n>", "Maximum provider cost in USD", Number)
  .option("--allowed-host <host...>", "Allowed network host(s)")
  .option("--yes", "Write the lease after reviewing these limits")
  .action(async (workspace, options) => {
    if (!options.yes) throw new Error("Refusing to issue an unattended lease without --yes");
    const lease = await issueLease(path.resolve(workspace), {
      maxTrials: options.maxTrials, maxGpuHours: options.maxGpuHours, maxWallHours: options.maxWallHours,
      expiresInHours: options.expiresIn, approvedBy: options.approvedBy,
      ...(options.maxStorageGb !== undefined ? { maxStorageGb: options.maxStorageGb } : {}),
      ...(options.maxCostUsd !== undefined ? { maxCostUsd: options.maxCostUsd } : {}),
      ...(options.allowedHost ? { allowedHosts: options.allowedHost } : {}),
    });
    console.log(JSON.stringify(lease, null, 2));
  });

program.command("lineage <workspace>").description("Inspect the immutable experiment lineage graph").action(async (workspace) => {
  console.log(JSON.stringify(await readLineage(path.resolve(workspace)), null, 2));
});
program.command("champion <workspace>").description("Show the current deterministic champion").action(async (workspace) => {
  const graph = await readLineage(path.resolve(workspace));
  const champion = graph.nodes.find((node) => node.id === graph.champion_node_id);
  if (!champion) throw new Error("lineage has no champion node");
  console.log(JSON.stringify(champion, null, 2));
});
program.command("dead-ends <workspace>").description("List retained failed/discarded candidates").action(async (workspace) => {
  const graph = await readLineage(path.resolve(workspace));
  console.log(JSON.stringify(graph.nodes.filter((node) => node.kind === "dead_end"), null, 2));
});

const researchState = program.command("research-state").description("Inspect and update the portable generalized-research state");
researchState.command("init <workspace>")
  .description("Initialize state before a bounded generalized-research run")
  .requiredOption("--pilot <pilot>", "repository_optimization, survey_pilot_study, or paper_reproduction")
  .requiredOption("--champion <nodeId>", "Initial lineage champion node id")
  .action(async (workspace, options) => {
    const pilot = ExperimentPilot.parse(options.pilot);
    console.log(JSON.stringify(await initializeResearchState(path.resolve(workspace), { pilot, champion_node_id: options.champion }), null, 2));
  });
researchState.command("show <workspace>")
  .description("Print the current generalized-research state")
  .action(async (workspace) => {
    console.log(JSON.stringify(await readResearchState(path.resolve(workspace)), null, 2));
  });
researchState.command("update <workspace>")
  .description("Atomically update the active generalized-research state")
  .option("--status <status>", "planned, running, paused, completed, or blocked")
  .option("--round <n>", "Current completed/active round", Number)
  .option("--champion <nodeId>", "Current champion node id")
  .option("--stagnation-rounds <n>", "Consecutive rounds without promotion", Number)
  .option("--stop-reason <reason>", "Durable reason for a stopped run")
  .action(async (workspace, options) => {
    const update = {
      ...(options.status !== undefined ? { status: options.status } : {}),
      ...(options.round !== undefined ? { current_round: options.round } : {}),
      ...(options.champion !== undefined ? { champion_node_id: options.champion } : {}),
      ...(options.stagnationRounds !== undefined ? { stagnation_rounds: options.stagnationRounds } : {}),
      ...(options.stopReason !== undefined ? { stop_reason: options.stopReason } : {}),
    };
    if (Object.keys(update).length === 0) throw new Error("Provide at least one state field to update.");
    console.log(JSON.stringify(await updateResearchState(path.resolve(workspace), update), null, 2));
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

stage.command("assert-authorization <workspace>").action(async (workspace) => {
  const resolved = path.resolve(workspace);
  const lease = await assertAuthorizedForUnattendedRun(resolved);
  await fs.mkdir(path.join(resolved, "reports"), { recursive: true });
  await fs.writeFile(path.join(resolved, "reports", "authorization.md"), [
    "# Execution Authorization", "",
    lease
      ? `Valid unattended lease bound to config SHA-256: ${lease.config_sha256}`
      : "Interactive execution: explicit approval gates remain required.",
    "",
  ].join("\n"), "utf8");
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

// Generalized research loop (LE-4.3). Each command is deterministic and is the
// only writer of the artifact it owns; agents contribute proposals, never state.
stage.command("research-init <workspace>").action(async (workspace) => {
  const resolved = path.resolve(workspace);
  const { commit_sha } = await researchInit(resolved, await readConfig(resolved));
  console.log(`baseline frozen at ${commit_sha}`);
});

stage.command("run-candidate <workspace> <candidateId>").action(async (workspace, candidateId) => {
  const resolved = path.resolve(workspace);
  await runCandidateStage(resolved, await readConfig(resolved), candidateId);
});

stage.command("verify-candidate <workspace> <candidateId>").action(async (workspace, candidateId) => {
  const resolved = path.resolve(workspace);
  const result = await verifyCandidateStage(resolved, await readConfig(resolved), candidateId);
  console.log(`${candidateId} committed as ${result.commit_sha.slice(0, 12)} (${result.changed.join(", ")})`);
});

stage.command("audit-baseline <workspace>").action(async (workspace) => {
  const resolved = path.resolve(workspace);
  const audit = await auditBaseline(resolved, await readConfig(resolved));
  console.log(`baseline metric ${audit.primary_metric}`);
});

stage.command("validate-round-plan <workspace>").action(async (workspace) => {
  const resolved = path.resolve(workspace);
  const plan = await validateRoundPlan(resolved, await readConfig(resolved));
  console.log(`${plan.round_id}: ${plan.candidates.length} candidate(s) accepted, ${plan.rejected.length} rejected`);
});

stage.command("materialize-candidates <workspace>").action(async (workspace) => {
  const resolved = path.resolve(workspace);
  const plan = await materializeRoundCandidates(resolved, await readConfig(resolved));
  console.log(`materialized ${plan.candidates.length} candidate branch(es) for ${plan.round_id}`);
});

stage.command("audit-candidate <workspace> <candidateId>").action(async (workspace, candidateId) => {
  const resolved = path.resolve(workspace);
  const audit = await auditRoundCandidate(resolved, await readConfig(resolved), candidateId);
  console.log(`${candidateId}: ${audit.status}${audit.primary_metric === undefined ? "" : ` (${audit.primary_metric})`}`);
});

stage.command("promote-round <workspace>").action(async (workspace) => {
  const resolved = path.resolve(workspace);
  const promotion = await promoteRound(resolved, await readConfig(resolved));
  console.log(`${promotion.round_id}: champion ${promotion.champion_node_id}${promotion.stop ? ` (stopping: ${promotion.stop_reason})` : ""}`);
});

stage.command("research-report <workspace>").action(async (workspace) => {
  await writeResearchFindings(path.resolve(workspace));
});

stage.command("reconcile-claims <workspace>").action(async (workspace) => {
  const resolved = path.resolve(workspace);
  const [paperText, candidates] = await Promise.all([
    fs.readFile(path.join(resolved, "paper", "text.txt"), "utf8"),
    fs.readFile(path.join(resolved, "reproduction", "claims-candidates.json"), "utf8"),
  ]);
  const parsed: unknown = JSON.parse(candidates);
  if (!Array.isArray(parsed)) throw new Error("reproduction/claims-candidates.json must be an array");
  const claims = reconcileClaims(paperText, parsed);
  await fs.mkdir(path.join(resolved, "reproduction"), { recursive: true });
  await fs.writeFile(path.join(resolved, "reproduction", "claims.json"), JSON.stringify({ version: 1, claims }, null, 2) + "\n", "utf8");
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
