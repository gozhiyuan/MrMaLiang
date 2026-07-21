import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { afterAll, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = path.join(root, "apps", "maliang", "dist", "cli.js");
const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });

const temporaryRoot = path.join(os.tmpdir(), `maliang-cli-routing-e2e-${Date.now()}`);
afterAll(async () => { await fs.rm(temporaryRoot, { recursive: true, force: true }); });

describe("maliang command surface", () => {
  it("shows the research axes in the template catalog", () => {
    const result = run(["template", "list"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("paper.survey\tsurvey/literature|repository/none/-");
    expect(result.stdout).toContain("paper.empirical\tempirical/literature|repository/run/agentic|prescribed");
    expect(result.stdout).toContain("paper.empirical-import\tempirical/literature|repository/import/-");
    expect(result.stdout).not.toContain("paper.repository-empirical");
  });

  it("rejects an unknown convenience verb without forwarding", () => {
    const r = run(["reserch", "prepare", "x"]);
    expect(r.status).not.toBe(0);
    const combined = `${r.stderr}${r.stdout}`;
    expect(combined).toMatch(/[Uu]nknown command/);
    // Distinguishes our resolveInvocation error from commander's own
    // "unknown command" message, which shares the same substring.
    expect(combined).toContain("Run: maliang --help");
  });

  it("keeps native experiment subcommands (validate) as native", () => {
    const r = run(["experiment", "validate", "/nonexistent-workspace"]);
    // Native path throws "has no LongExperiment component" or a read error — NOT
    // the proxy's unknown-command error.
    expect(`${r.stderr}${r.stdout}`).not.toMatch(/Unknown command/);
  });

  it("forwards 'writing mode list' to LongWrite", async () => {
    const workspace = path.join(temporaryRoot, "writing-only");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(workspace, "maliang.yaml"),
      [
        "version: 1",
        "project:",
        "  id: writing-only",
        "  template: paper.survey",
        "research:",
        "  paperKind: survey",
        "  evidenceProfile: literature",
        "  experimentSource: none",
        "components:",
        "  writing:",
        "    workspace: writing",
        "handoff:",
        "  mode: none",
        "  state: not_required",
        "",
      ].join("\n"),
      "utf8",
    );

    const r = spawnSync(process.execPath, [cli, "writing", "mode", "list"], { cwd: workspace, encoding: "utf8" });
    const combined = `${r.stderr}${r.stdout}`;
    expect(combined).not.toMatch(/Unknown command/);
    expect(r.status).toBe(0);
    // LongWrite's `mode list` prints tab-separated bundled mode ids.
    expect(r.stdout).toMatch(/\t/);
  });

  it("names the actual resolved component in the forwarding notice when --component overrides it", async () => {
    const workspace = path.join(temporaryRoot, "component-override");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(workspace, "maliang.yaml"),
      [
        "version: 1",
        "project:",
        "  id: component-override",
        "  template: experiment.standalone",
        "components:",
        "  experiment:",
        "    workspace: experiment",
        "handoff:",
        "  mode: none",
        "  state: not_required",
        "",
      ].join("\n"),
      "utf8",
    );

    const r = spawnSync(process.execPath, [cli, "sync", workspace, "--component", "experiment"], { cwd: root, encoding: "utf8" });
    // The child longexperiment call may exit nonzero on a bare workspace;
    // only the forwarding notice (printed before the child runs) is asserted.
    expect(r.stderr).toContain("to experiment (longexperiment)");
  });

  it("renders registry-backed namespace help and propagates a real component failure", async () => {
    const help = run(["writing", "--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("sync");
    expect(help.stdout).toContain("research prepare");

    const workspace = path.join(temporaryRoot, "failing-writing");
    await fs.mkdir(path.join(workspace, "writing"), { recursive: true });
    await fs.writeFile(path.join(workspace, "maliang.yaml"), [
      "version: 1", "project:", "  id: failing-writing", "  template: paper.survey", "research:", "  paperKind: survey", "  evidenceProfile: literature", "  experimentSource: none", "components:", "  writing:", "    workspace: writing", "handoff:", "  mode: none", "  state: not_required", "",
    ].join("\n"));
    const failure = run(["writing", "validate", "config", workspace]);
    expect(failure.status).toBe(1);
  });

  it("materializes the long-agentic-survey blueprint through maliang init", async () => {
    const workspace = path.join(temporaryRoot, "blueprint-survey");
    const result = run(["init", workspace, "--blueprint", "long-agentic-survey"]);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const config = parse(await fs.readFile(path.join(workspace, "writing", "longwrite.yaml"), "utf8")) as any;
    expect(config.research.topic).toBe("Long-horizon memory and planning in LLM agents");
    expect(config.writing.target_length_words).toBe(24_000);
    expect(config.publication.presentation.citation_style).toBe("author_year");
    expect(config.figures.quality_gates).toMatchObject({ min_figures: 6, min_tables: 12 });
  });

  it("does not expose incubating experiment protocols as flagship blueprints", () => {
    const result = run(["init", path.join(temporaryRoot, "retired-blueprint"), "--blueprint", "nanogpt-ablation"]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("Unknown release-ready flagship blueprint: nanogpt-ablation");
  });

  it("rejects a workspace whose research axes no longer match its template", async () => {
    const workspace = path.join(temporaryRoot, "tampered-axes");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "maliang.yaml"), [
      "version: 1", "project:", "  id: tampered-axes", "  template: paper.survey",
      "research:", "  paperKind: empirical", "  evidenceProfile: literature", "  experimentSource: import",
      "components:", "  writing:", "    workspace: writing", "handoff:", "  mode: import_existing", "  state: awaiting_import", "",
    ].join("\n"));
    const result = run(["status", workspace]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/research axes do not match template|handoff mode does not match template/);
  });

  it("materializes the autonomous self-play empirical axes and guarded components", async () => {
    const workspace = path.join(temporaryRoot, "self-play-empirical");
    const result = run(["init", workspace, "--blueprint", "self-play-autonomous-empirical-paper"]);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const project = parse(await fs.readFile(path.join(workspace, "maliang.yaml"), "utf8")) as any;
    expect(project.research).toEqual({ paperKind: "empirical", evidenceProfile: "literature", experimentSource: "run", experimentAuthoring: "agentic" });
    expect(project.components).toEqual({ experiment: { workspace: "experiment" }, writing: { workspace: "writing" } });
    const experiment = parse(await fs.readFile(path.join(workspace, "experiment", "experiment.yaml"), "utf8")) as any;
    expect(experiment.authoring).toMatchObject({ mode: "agentic", max_revision_rounds: 3 });
    expect(experiment.outputs.longwrite_workspace).toBe("../writing");
    const writing = parse(await fs.readFile(path.join(workspace, "writing", "longwrite.yaml"), "utf8")) as any;
    expect(writing.research).toMatchObject({ paper_kind: "empirical", paper_profile: "literature_survey" });
  });

  it("materializes a prescribed integrated paper without pretending its runner is configured", async () => {
    const workspace = path.join(temporaryRoot, "prescribed-empirical");
    const result = run(["init", workspace, "--template", "paper.empirical", "--experiment-authoring", "prescribed", "--topic", "A declared benchmark protocol", "--hypothesis", "The treatment improves the fixed score."]);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const project = parse(await fs.readFile(path.join(workspace, "maliang.yaml"), "utf8")) as any;
    expect(project.research).toEqual({ paperKind: "empirical", evidenceProfile: "literature", experimentSource: "run", experimentAuthoring: "prescribed" });
    const experiment = parse(await fs.readFile(path.join(workspace, "experiment", "experiment.yaml"), "utf8")) as any;
    expect(experiment.authoring.mode).toBe("prescribed");
    expect(experiment.runner).toEqual({ kind: "command" });
  });

  it("treats a repository supplied to paper.survey only as code evidence", async () => {
    const repository = path.join(temporaryRoot, "survey-repository");
    await fs.mkdir(repository, { recursive: true });
    expect(spawnSync("git", ["init"], { cwd: repository }).status).toBe(0);
    expect(spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repository }).status).toBe(0);
    expect(spawnSync("git", ["config", "user.name", "MrMaLiang Test"], { cwd: repository }).status).toBe(0);
    await fs.writeFile(path.join(repository, "README.md"), "# Survey target\n", "utf8");
    expect(spawnSync("git", ["add", "README.md"], { cwd: repository }).status).toBe(0);
    expect(spawnSync("git", ["commit", "-m", "fixture"], { cwd: repository }).status).toBe(0);
    const workspace = path.join(temporaryRoot, "repository-survey-inferred");
    const result = run(["init", workspace, "--template", "paper.survey", "--topic", "Repository architecture", "--repository", repository, "--reference-link", "https://example.org/original-paper"]);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const project = parse(await fs.readFile(path.join(workspace, "maliang.yaml"), "utf8")) as any;
    expect(project.research).toEqual({ paperKind: "survey", evidenceProfile: "repository", experimentSource: "none" });
    expect(project.components.experiment).toBeUndefined();
    const writing = parse(await fs.readFile(path.join(workspace, "writing", "longwrite.yaml"), "utf8")) as any;
    expect(writing.research.paper_profile).toBe("repository_study");
    expect(writing.writing.reference_links).toContain("https://example.org/original-paper");
  });

  it("infers a repository survey from bounded GitHub discovery without requiring an explicit repository", async () => {
    const workspace = path.join(temporaryRoot, "repository-discovery-inferred");
    const result = run([
      "init", workspace, "--template", "paper.survey", "--topic", "Agent memory repositories",
      "--discover-repositories", "--repository-query-budget", "2", "--repository-max-candidates", "12",
      "--repository-max-readmes", "4", "--repository-max-selected", "2", "--repository-language", "Python",
    ]);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const project = parse(await fs.readFile(path.join(workspace, "maliang.yaml"), "utf8")) as any;
    expect(project.research).toEqual({ paperKind: "survey", evidenceProfile: "repository", experimentSource: "none" });
    const writing = parse(await fs.readFile(path.join(workspace, "writing", "longwrite.yaml"), "utf8")) as any;
    expect(writing.research).toMatchObject({
      paper_profile: "repository_study", codebases: [],
      codebase_discovery: { enabled: true, query_budget: 2, max_candidates: 12, max_readme_fetches: 4, max_selected: 2, languages: ["Python"] },
    });
    expect(writing.research.experiment.enabled).toBe(false);
  });

  it("rejects experiment-only options for a survey", () => {
    const workspace = path.join(temporaryRoot, "invalid-survey-experiment");
    const result = run(["init", workspace, "--template", "paper.survey", "--topic", "No execution", "--experiment-authoring", "agentic"]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("only valid for paper.empirical");
  });

  it("binds repository empirical writing and trials to the same immutable revision", async () => {
    const repository = path.join(temporaryRoot, "local-model-repository");
    await fs.mkdir(repository, { recursive: true });
    expect(spawnSync("git", ["init"], { cwd: repository }).status).toBe(0);
    expect(spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repository }).status).toBe(0);
    expect(spawnSync("git", ["config", "user.name", "MrMaLiang Test"], { cwd: repository }).status).toBe(0);
    await fs.writeFile(path.join(repository, "README.md"), "# Pinned model repository\n", "utf8");
    expect(spawnSync("git", ["add", "README.md"], { cwd: repository }).status).toBe(0);
    expect(spawnSync("git", ["commit", "-m", "fixture"], { cwd: repository }).status).toBe(0);
    const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).stdout.trim();

    const workspace = path.join(temporaryRoot, "repository-empirical");
    const result = run(["init", workspace, "--blueprint", "nanogpt-agentic-empirical-paper", "--repository", repository]);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const experiment = parse(await fs.readFile(path.join(workspace, "experiment", "experiment.yaml"), "utf8")) as any;
    const writing = parse(await fs.readFile(path.join(workspace, "writing", "longwrite.yaml"), "utf8")) as any;
    expect(experiment.inputs.code[0].revision).toBe(revision);
    expect(writing.research.codebases[0].ref).toBe(revision);
    expect(writing.research.experiment).toMatchObject({ codebase_id: experiment.inputs.code[0].id, input_id: experiment.inputs.code[0].id });
  });
});
