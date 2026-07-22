#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { Command } from "commander";
import { parse, stringify } from "yaml";
import { assertNewWorkspace, projectIdFromDir, readMaliangProject, writeMaliangProject, type MaliangProject } from "./project.js";
import { initializeLifecycle, markLifecycle, readLifecycle } from "./lifecycle.js";
import { writeMaliangProvenance } from "./provenance.js";
import { resolveResearchAxes, TEMPLATES, templateById, templateModeSummary } from "./templates.js";
import { forwardCommand, componentCli } from "./proxy.js";
import { validateInitPassthrough } from "./init-passthrough.js";
import { runUnifiedPreflight } from "./preflight.js";
import { ROUTING_REGISTRY, type Component } from "./routing.js";
import { readFlagshipBlueprint } from "./blueprints.js";

const packageVersion = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

async function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? signal ?? "an unknown failure"}`)));
  });
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

async function runComponent(component: "longwrite" | "longexperiment", args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<void> {
  await run(process.execPath, [componentCli(component), ...args], cwd, env);
}

async function componentExists(component: "longwrite" | "longexperiment"): Promise<void> {
  try { await fs.access(componentCli(component)); } catch { throw new Error(`MrMaLiang is not built. Run: npm run build`); }
}

type InitOptions = {
  template: string;
  topic?: string;
  hypothesis?: string;
  repository?: string[];
  discoverRepositories?: boolean;
  repositoryQueryBudget?: string;
  repositoryMaxCandidates?: string;
  repositoryMaxReadmes?: string;
  repositoryMaxSelected?: string;
  repositoryLanguage?: string[];
  includeArchivedRepositories?: boolean;
  allowUnlicensedRepositories?: boolean;
  referenceLink?: string[];
  experimentAuthoring?: "prescribed" | "agentic";
  name?: string;
  experimentTemplate?: string;
  passthrough?: string[];
};
type InitCliOptions = Omit<InitOptions, "template"> & { template?: string; blueprint?: string };

function resolveInitOptions(options: InitCliOptions): InitOptions {
  if (!options.blueprint) {
    if (!options.template) throw new Error("--template <id> or --blueprint <id> is required; run maliang template list or inspect examples/flagships");
    return { ...options, template: options.template };
  }
  const blueprint = readFlagshipBlueprint(options.blueprint);
  if (options.template && options.template !== blueprint.template) {
    throw new Error(`--template ${options.template} conflicts with blueprint ${options.blueprint} (${blueprint.template})`);
  }
  return {
    ...options,
    template: blueprint.template,
    topic: options.topic ?? blueprint.topic,
    hypothesis: options.hypothesis ?? blueprint.hypothesis,
    repository: options.repository ?? blueprint.repositories,
    referenceLink: options.referenceLink ?? blueprint.reference_links,
    experimentAuthoring: options.experimentAuthoring ?? blueprint.experiment_authoring,
    experimentTemplate: options.experimentTemplate ?? blueprint.experiment_template,
    passthrough: [...(blueprint.init_args ?? []), ...(options.passthrough ?? [])],
  };
}

function inputId(source: string, index: number): string {
  const base = source.replace(/\/$/, "").split("/").pop()?.replace(/\.git$/i, "") || `repository-${index + 1}`;
  return `repo-${base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || index + 1}`;
}

async function resolveRepositoryInputs(repositories: string[], cwd: string): Promise<Array<Record<string, string>>> {
  const code: Array<Record<string, string>> = [];
  for (const [index, source] of repositories.entries()) {
    const local = await fs.stat(source).then((stat) => stat.isDirectory()).catch(() => false);
    const revision = local
      ? await commandOutput("git", ["-C", path.resolve(source), "rev-parse", "HEAD"], cwd)
      : (await commandOutput("git", ["ls-remote", source, "HEAD"], cwd)).split(/\s+/)[0];
    if (!/^[a-f0-9]{7,}$/i.test(revision)) throw new Error(`Could not resolve an immutable Git revision for ${source}`);
    code.push({
      id: inputId(source, index),
      source: local ? new URL(`file://${path.resolve(source)}`).href : source,
      revision,
      materialize: "git",
    });
  }
  return code;
}

async function pinWritingRepositories(writingDir: string, code: Array<Record<string, string>>): Promise<void> {
  const writingPath = path.join(writingDir, "longwrite.yaml");
  const writing = parse(await fs.readFile(writingPath, "utf8")) as Record<string, any>;
  const revisions = new Map(code.map((input) => [input.id, input.revision]));
  writing.research.codebases = (writing.research.codebases ?? []).map((input: Record<string, unknown>) => revisions.has(String(input.id)) ? { ...input, ref: revisions.get(String(input.id)) } : input);
  await fs.writeFile(writingPath, stringify(writing), "utf8");
}

async function pinRepositoryInputs(experimentDir: string, repositories: string[], writingDir?: string): Promise<void> {
  const configPath = path.join(experimentDir, "experiment.yaml");
  const config = parse(await fs.readFile(configPath, "utf8")) as Record<string, any>;
  const inputs = config.inputs ?? { code: [], benchmarks: [], models: [] };
  const code = await resolveRepositoryInputs(repositories, experimentDir);
  config.inputs = { ...inputs, code };
  if (config.authoring?.mode === "agentic" && code.length) config.authoring = { ...config.authoring, base_input_id: code[0].id };
  config.outputs = { ...(config.outputs ?? {}), ...(writingDir ? { longwrite_workspace: path.relative(experimentDir, writingDir) } : {}) };
  await fs.writeFile(configPath, stringify(config), "utf8");
  await runComponent("longexperiment", ["sync", experimentDir], path.dirname(experimentDir));
  if (writingDir) await pinWritingRepositories(writingDir, code);
}

async function linkExperimentWriting(experimentDir: string, writingDir: string): Promise<void> {
  const configPath = path.join(experimentDir, "experiment.yaml");
  const config = parse(await fs.readFile(configPath, "utf8")) as Record<string, any>;
  config.outputs = { ...(config.outputs ?? {}), longwrite_workspace: path.relative(experimentDir, writingDir) };
  await fs.writeFile(configPath, stringify(config), "utf8");
  await runComponent("longexperiment", ["sync", experimentDir], path.dirname(experimentDir));
}

/** Empirical workspaces are manifest-first from their first scaffold. The old
 * results_path fallback remains in LongWrite only for migrated workspaces. */
async function configureEmpiricalWriting(writingDir: string, repositories: string[] = []): Promise<void> {
  const configPath = path.join(writingDir, "longwrite.yaml");
  const config = parse(await fs.readFile(configPath, "utf8")) as Record<string, any>;
  const research = config.research ?? {};
  const existing = research.experiment ?? {};
  research.experiment = {
    ...existing,
    enabled: true,
    manifest_path: "experiments/longexperiment-manifest.json",
    ...(repositories.length ? { codebase_id: inputId(repositories[0], 0), input_id: inputId(repositories[0], 0) } : {}),
  };
  delete research.experiment.results_path;
  config.research = research;
  await fs.writeFile(configPath, stringify(config), "utf8");
  await runComponent("longwrite", ["sync", writingDir], path.dirname(writingDir));
}

async function initializeWorkspace(target: string, options: InitOptions): Promise<void> {
  const workspace = path.resolve(target);
  const template = templateById(options.template);
  const researchAxes = resolveResearchAxes(template, {
    hasRepository: Boolean(options.repository?.length || options.discoverRepositories),
    experimentAuthoring: options.experimentAuthoring,
  });
  await assertNewWorkspace(workspace);
  if (template.writing && !options.topic) throw new Error(`--topic is required by ${template.id}`);
  if (template.experiment && !template.experiment.flagship && !options.experimentTemplate && !options.hypothesis) throw new Error(`--hypothesis is required by ${template.id}`);
  if (researchAxes && researchAxes.experimentSource !== "run" && options.hypothesis) throw new Error("--hypothesis is only valid when paper.empirical runs a new experiment");
  if (options.discoverRepositories && researchAxes?.paperKind !== "survey") throw new Error("--discover-repositories is currently supported only by paper.survey");
  if (!template.writing && options.referenceLink?.length) throw new Error("--reference-link requires a writing template");
  if (!template.writing) {
    const passthrough = validateInitPassthrough(options.passthrough ?? [], { hasWriting: false });
    if (!passthrough.ok) throw new Error(passthrough.message);
  }
  if (template.experiment) await componentExists("longexperiment");
  if (template.writing) await componentExists("longwrite");

  const components: MaliangProject["components"] = {};
  let experimentDir: string | undefined;
  if (template.experiment) {
    experimentDir = path.join(workspace, "experiment");
    const flagship = template.experiment.flagship ?? options.experimentTemplate;
    if (flagship && flagship !== "standalone") {
      await runComponent("longexperiment", ["flagship", flagship, experimentDir], workspace);
    } else {
      const profile = researchAxes?.evidenceProfile === "repository" ? "existing_code" : "from_scratch";
      const authoring = researchAxes?.experimentAuthoring ?? template.experiment.authoring ?? "prescribed";
      await runComponent("longexperiment", ["init", experimentDir, "--hypothesis", options.hypothesis!, "--profile", profile, "--authoring", authoring], workspace);
    }
    if (researchAxes?.experimentAuthoring) {
      const experimentConfig = parse(await fs.readFile(path.join(experimentDir, "experiment.yaml"), "utf8")) as Record<string, any>;
      if (experimentConfig.authoring?.mode !== researchAxes.experimentAuthoring) {
        throw new Error(`Experiment template authoring mode ${experimentConfig.authoring?.mode ?? "missing"} conflicts with --experiment-authoring ${researchAxes.experimentAuthoring}`);
      }
    }
    components.experiment = { workspace: "experiment" };
  }
  if (template.writing) {
    const writingDir = path.join(workspace, "writing");
    const args = ["init", writingDir, "--mode", template.writing.mode, "--topic", options.topic!];
    if (researchAxes) args.push("--research-paper-kind", researchAxes.paperKind);
    if (researchAxes) args.push("--research-paper-profile", researchAxes.evidenceProfile === "repository" ? "repository_study" : "literature_survey");
    for (const repository of options.repository ?? []) args.push("--repository", repository);
    if (options.discoverRepositories) args.push("--discover-repositories");
    if (options.repositoryQueryBudget) args.push("--repository-query-budget", options.repositoryQueryBudget);
    if (options.repositoryMaxCandidates) args.push("--repository-max-candidates", options.repositoryMaxCandidates);
    if (options.repositoryMaxReadmes) args.push("--repository-max-readmes", options.repositoryMaxReadmes);
    if (options.repositoryMaxSelected) args.push("--repository-max-selected", options.repositoryMaxSelected);
    if (options.repositoryLanguage?.length) args.push("--repository-language", ...options.repositoryLanguage);
    if (options.includeArchivedRepositories) args.push("--include-archived-repositories");
    if (options.allowUnlicensedRepositories) args.push("--allow-unlicensed-repositories");
    if (options.referenceLink?.length) args.push("--reference-link", ...options.referenceLink);
    if (options.name) args.push("--name", options.name);
    const passthrough = validateInitPassthrough(options.passthrough ?? [], { hasWriting: true });
    if (!passthrough.ok) throw new Error(passthrough.message);
    args.push(...passthrough.args);
    await runComponent("longwrite", args, workspace, { ...process.env, MALIANG_PARENT_WORKSPACE: workspace });
    components.writing = { workspace: "writing" };
  }
  if (researchAxes?.paperKind === "empirical") await configureEmpiricalWriting(path.join(workspace, "writing"), options.repository);
  // configureEmpiricalWriting() runs LongWrite sync, which may regenerate the
  // repository declaration from its scaffold input. Pin only after that sync so
  // the paper and experiment retain the same immutable source revision.
  if (experimentDir && options.repository?.length) await pinRepositoryInputs(experimentDir, options.repository, template.writing ? path.join(workspace, "writing") : undefined);
  else if (researchAxes?.experimentSource === "import" && options.repository?.length) {
    await pinWritingRepositories(path.join(workspace, "writing"), await resolveRepositoryInputs(options.repository, workspace));
  }
  else if (experimentDir && template.writing) await linkExperimentWriting(experimentDir, path.join(workspace, "writing"));

  const handoffMode = template.handoff ?? "none";
  const project: MaliangProject = {
    version: 1,
    project: { id: projectIdFromDir(workspace), ...(options.name ? { name: options.name } : {}), template: template.id },
    ...(researchAxes ? { research: researchAxes } : {}),
    components,
    handoff: {
      mode: handoffMode,
      state: handoffMode === "none" ? "not_required" : handoffMode === "run_then_import" ? "awaiting_experiment" : "awaiting_import",
      ...(handoffMode === "run_then_import" ? { manifest_path: "experiment/results/experiment-manifest.json" } : {}),
    },
  };
  await writeMaliangProject(workspace, project);
  await initializeLifecycle(workspace, components, handoffMode);
  await writeMaliangProvenance(workspace, "workspace_initialized");
  console.log(`Created ${template.title} workspace at ${workspace}`);
  console.log("Next: maliang run " + workspace);
}

async function prepareHandoff(workspace: string, manifest: string): Promise<void> {
  const project = await readMaliangProject(workspace);
  if (!project.components.writing) throw new Error("This template has no LongWrite component");
  const writing = path.join(workspace, project.components.writing.workspace);
  const source = path.resolve(workspace, manifest);
  await fs.access(source);
  await markLifecycle(workspace, "handoff", "running");
  try {
    if (project.research?.evidenceProfile === "repository") {
      await runComponent("longwrite", ["research", "codebases", writing], workspace);
    }
    await runComponent("longwrite", ["research", "import-experiment", writing, "--manifest", source], workspace);
    await runComponent("longwrite", ["research", "prepare-experiment", writing], workspace);
    await runComponent("longwrite", ["sync", writing], workspace);
    project.handoff.state = "prepared";
    project.handoff.manifest_path = path.relative(workspace, source);
    await writeMaliangProject(workspace, project);
    await markLifecycle(workspace, "handoff", "completed", "manifest, artifacts, and empirical packets verified");
    await writeMaliangProvenance(workspace, "empirical_handoff_verified");
    console.log("Verified LongExperiment handoff and prepared bounded empirical evidence packets.");
  } catch (error) {
    await markLifecycle(workspace, "handoff", "blocked", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function runWorkspace(target: string, runtime?: string): Promise<void> {
  const workspace = path.resolve(target);
  const project = await readMaliangProject(workspace);
  if (project.components.experiment && project.handoff.mode === "run_then_import" && project.handoff.state !== "prepared") {
    const experimentDir = path.join(workspace, project.components.experiment.workspace);
    const manifest = path.join(workspace, project.handoff.manifest_path!);
    try { await fs.access(manifest); } catch {
      await markLifecycle(workspace, "experiment", "running");
      try {
        await run("malaclaw", ["flow", "run", ...(runtime ? ["--runtime", runtime] : [])], experimentDir);
        await markLifecycle(workspace, "experiment", "awaiting_approval", "experiment flow has not yet produced an audited manifest");
        await writeMaliangProvenance(workspace, "experiment_phase_checkpoint");
        console.log("Experiment phase is not yet handoff-ready. Approve/retry it as needed, then run this command again.");
        return;
      } catch (error) {
        await markLifecycle(workspace, "experiment", "blocked", error instanceof Error ? error.message : String(error));
        await writeMaliangProvenance(workspace, "experiment_phase_blocked");
        throw error;
      }
    }
    await markLifecycle(workspace, "experiment", "completed", "audited experiment manifest found");
    await prepareHandoff(workspace, project.handoff.manifest_path!);
  }
  if (project.components.experiment && !project.components.writing) {
    await markLifecycle(workspace, "experiment", "running");
    await run("malaclaw", ["flow", "run", ...(runtime ? ["--runtime", runtime] : [])], path.join(workspace, project.components.experiment.workspace));
    await markLifecycle(workspace, "experiment", "awaiting_approval", "inspect the experiment flow state for completion");
    await writeMaliangProvenance(workspace, "standalone_experiment_checkpoint");
    return;
  }
  if (project.handoff.mode === "import_existing" && project.handoff.state !== "prepared") throw new Error("Import an audited result first: maliang handoff import <workspace> --manifest <path>");
  if (project.components.writing) {
    await markLifecycle(workspace, "writing", "running");
    try {
      await runComponent("longwrite", ["run", path.join(workspace, project.components.writing.workspace), ...(runtime ? ["--runtime", runtime] : [])], workspace);
      await markLifecycle(workspace, "writing", "completed", "LongWrite command returned successfully");
      await writeMaliangProvenance(workspace, "writing_phase_completed");
    } catch (error) {
      await markLifecycle(workspace, "writing", "blocked", error instanceof Error ? error.message : String(error));
      await writeMaliangProvenance(workspace, "writing_phase_blocked");
      throw error;
    }
  }
}

/**
 * `maliang init <dir> --template ... -- <longwrite flags...>` lets operators
 * append LongWrite customization after a literal `--`. Commander's handling
 * of unrecognized post-`--` flags is not reliable enough to depend on, so we
 * capture that boundary directly from process.argv and strip it before
 * commander ever sees it: only the `init` invocation gets this treatment
 * (identified by argv[2], the first user-supplied token), so `--` retains
 * whatever behavior other subcommands already give it.
 */
const dashDashIndex = process.argv[2] === "init" ? process.argv.indexOf("--") : -1;
const cliArgv = dashDashIndex === -1 ? process.argv : process.argv.slice(0, dashDashIndex);
const initPassthrough = dashDashIndex === -1 ? undefined : process.argv.slice(dashDashIndex + 1);

const program = new Command();
program.name("maliang").description("MrMaLiang unified writing and experiment workflows").version(packageVersion);

const templates = program.command("template").description("Inspect bundled MrMaLiang templates");
templates.command("list").action(() => {
  for (const template of TEMPLATES) {
    console.log(`${template.id}\t${templateModeSummary(template)}\t${template.title}\t${template.description}`);
  }
});
templates.command("show <id>").action((id) => console.log(JSON.stringify(templateById(id), null, 2)));

program.command("init <dir>")
  .option("--template <id>", "Template id; run maliang template list")
  .option("--blueprint <id>", "Materialize a versioned examples/flagships blueprint")
  .option("--topic <text>", "Writing topic")
  .option("--hypothesis <text>", "Falsifiable experiment hypothesis")
  .option("--repository <source...>", "Pinned Git URL or local Git path; repeatable")
  .option("--discover-repositories", "Search GitHub for bounded supplementary repository evidence")
  .option("--repository-query-budget <n>", "Maximum GitHub search queries (1-20)")
  .option("--repository-max-candidates <n>", "Maximum GitHub candidates retained (1-100)")
  .option("--repository-max-readmes <n>", "Maximum candidate READMEs fetched (0-40)")
  .option("--repository-max-selected <n>", "Maximum discovered repositories pinned (1-10)")
  .option("--repository-language <language...>", "Optional GitHub language filters")
  .option("--include-archived-repositories", "Allow archived GitHub repositories")
  .option("--allow-unlicensed-repositories", "Allow candidates without a detected license")
  .option("--reference-link <url...>", "Original paper or other reference URL(s); repeatable")
  .option("--experiment-authoring <mode>", "Experiment authoring for paper.empirical: agentic or prescribed")
  .option("--name <text>", "Project name")
  .option("--experiment-template <id>", "Optional LongExperiment flagship for an empirical-paper template")
  .action((dir, options) => initializeWorkspace(dir, resolveInitOptions({ ...options, passthrough: initPassthrough })));

program.command("run <workspace>")
  .option("--runtime <id>", "MalaClaw runtime, e.g. codex or script")
  .action(async (workspace, options) => runWorkspace(workspace, options.runtime));

program.command("status <workspace>").action(async (workspace) => {
  const resolved = path.resolve(workspace);
  const project = await readMaliangProject(resolved);
  const lifecycle = await readLifecycle(resolved).catch(() => undefined);
  console.log(JSON.stringify({ project, lifecycle }, null, 2));
});

program.command("provenance <workspace>")
  .option("--event <text>", "Provenance event label", "manual_record")
  .action(async (workspace, options) => console.log(`Recorded provenance: ${await writeMaliangProvenance(path.resolve(workspace), options.event)}`));

program.command("preflight <workspace>")
  .description("Check runner, input pins, runtime, and manuscript handoff readiness without executing a workflow")
  .option("--runtime <id>", "MalaClaw runtime, e.g. codex or script")
  .action(async (workspace, options) => {
    const report = await runUnifiedPreflight(workspace, options.runtime);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.overall === "fail" ? 1 : 0;
  });

const handoff = program.command("handoff").description("Manage audited LongExperiment-to-LongWrite evidence handoffs");
handoff.command("import <workspace>").requiredOption("--manifest <path>", "Experiment manifest path").action(async (workspace, options) => prepareHandoff(path.resolve(workspace), options.manifest));

const experiment = program.command("experiment").description("Create and validate LongExperiment workspaces through Maliang");
experiment.command("flagship <id> <dir>").action(async (id, dir) => {
  const matching = TEMPLATES.find((template) => template.experiment?.flagship === id);
  if (!matching) throw new Error(`Unknown flagship ${id}. Run: maliang template list`);
  await initializeWorkspace(dir, { template: matching.id, hypothesis: "flagship configuration" });
});
experiment.command("validate <workspace>").action(async (workspace) => {
  const project = await readMaliangProject(path.resolve(workspace));
  if (!project.components.experiment) throw new Error("This workspace has no LongExperiment component");
  await runComponent("longexperiment", ["validate", path.join(path.resolve(workspace), project.components.experiment.workspace)], path.resolve(workspace));
});

function publicCommands(component: Component, prefix: string[] = []): string[] {
  return ROUTING_REGISTRY
    .filter((contract) => contract.components.includes(component))
    .map((contract) => contract.commandPath)
    .filter((path) => prefix.every((segment, index) => path[index] === segment))
    .map((path) => path.slice(prefix.length).join(" "))
    .filter(Boolean)
    .sort();
}

function proxyHelp(component: Component, prefix: string[] = []): string {
  const commands = publicCommands(component, prefix);
  return commands.length
    ? `\nPublic ${component} commands:\n${commands.map((command) => `  ${command}`).join("\n")}\n`
    : `\nNo public ${component} commands match this path.\n`;
}

function registerProxyNamespace(name: "writing"): void {
  program.command(`${name}`)
    .description(`Forward an operator command to the ${name} component`)
    .addHelpText("after", () => proxyHelp(name))
    .allowUnknownOption(true)
    .argument("[args...]")
    .action(async (args: string[]) => { process.exitCode = await forwardCommand(args, { forcedComponent: name }); });
}
registerProxyNamespace("writing");

// "experiment" already exists as a native group (flagship/validate); forward
// any other experiment verb (e.g. "sync", "mode list") to LongExperiment.
experiment.addHelpText("after", () => proxyHelp("experiment"));
experiment.command("*", { hidden: true }).allowUnknownOption(true).action(async function (this: { args: string[] }) {
  process.exitCode = await forwardCommand(this.args, { forcedComponent: "experiment" });
});

// Convenience fallback: an allowlisted top-level verb not claimed by any
// native command (e.g. "maliang sync <workspace>"). Unknown verbs are
// rejected with a clear error and never forwarded.
program.allowUnknownOption(true);
program.command("*", { hidden: true }).allowUnknownOption(true).action(async function (this: { args: string[] }) {
  process.exitCode = await forwardCommand(this.args, { notify: true });
});

function maybePrintProxyHelp(argv: readonly string[]): boolean {
  const [namespace, ...rest] = argv;
  const component = namespace === "writing" ? "writing" : namespace === "experiment" ? "experiment" : undefined;
  if (!component || !rest.includes("--help")) return false;
  const prefix = rest.filter((token) => token !== "--help" && !token.startsWith("-"));
  console.log(`Usage: maliang ${namespace}${prefix.length ? ` ${prefix.join(" ")}` : ""} <command> [workspace] [options]`);
  if (namespace === "experiment" && prefix.length === 0) {
    console.log("\nNative experiment commands:\n  flagship <id> <dir>\n  validate <workspace>");
  }
  console.log(proxyHelp(component, prefix));
  return true;
}

const publicArgv = cliArgv.slice(2);
if (!maybePrintProxyHelp(publicArgv)) program.parseAsync(cliArgv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
