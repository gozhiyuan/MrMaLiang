import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { runInit } from "../src/commands/init.js";
import { shouldRunWizard } from "../src/commands/init-wizard.js";

const tempDirs: string[] = [];

async function makeRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-init-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

describe("runInit", () => {
  it("defaults to the flagship agentic workspace", async () => {
    const root = await makeRoot();
    const target = path.join(root, "survey");
    await runInit(target, { topic: "Long-horizon agent memory" });
    const config = parseYaml(await fs.readFile(path.join(target, "longwrite.yaml"), "utf-8"));
    expect(config.project.mode).toBe("auto_research_agentic");
    expect(config.research.provider).toBe("multi");
    expect(config.research.workflow_profile).toBe("deep");
    expect(config.research.writing_strategy).toBe("llm_sections");
  });

  it("writes visible operational defaults for a full flagship workspace", async () => {
    const root = await makeRoot();
    const target = path.join(root, "survey");
    await runInit(target, { mode: "auto_research_agentic", topic: "Long-horizon agent memory" });
    const config = parseYaml(await fs.readFile(path.join(target, "longwrite.yaml"), "utf-8"));
    expect(config.run_limits).toEqual({
      max_unit_minutes: 30,
      max_active_run_minutes: 1440,
      max_recorded_tokens: 10000000,
      on_limit: "pause",
    });
    expect(config.research.writing_strategy).toBe("llm_sections");
  });

  it("keeps direct LLM drafting for every full-mode breadth profile", async () => {
    const root = await makeRoot();
    const target = path.join(root, "survey");
    await runInit(target, {
      mode: "auto_research_agentic",
      topic: "Long-horizon agent memory",
      researchWorkflowProfile: "fast",
    });
    const config = parseYaml(await fs.readFile(path.join(target, "longwrite.yaml"), "utf-8"));
    expect(config.research.writing_strategy).toBe("llm_sections");
  });

  it("gives the agentic mode the full flagship setup defaults", async () => {
    const root = await makeRoot();
    const target = path.join(root, "agentic-survey");
    await runInit(target, { mode: "auto_research_agentic", topic: "Long-horizon agent memory" });
    const config = parseYaml(await fs.readFile(path.join(target, "longwrite.yaml"), "utf-8"));
    expect(config.research.provider).toBe("multi");
    expect(config.research.writing_strategy).toBe("llm_sections");
    expect(config.research.source_policy.require_live_urls).toBe(true);
    expect(config.research.release_gates).toMatchObject({
      min_cited_sources: 80,
      min_citations_per_page: 3,
      min_cited_within_one_year_ratio: 0.3,
      min_accepted_cited_ratio: 0.3,
      max_cited_arxiv_only_ratio: 0.5,
      min_citation_depths_per_section: { A: 1, B: 2, C: 2 },
      min_cited_ab_sources_per_taxonomy_cell: 2,
    });
    expect(config.figures.quality_gates).toEqual({ min_figures: 6, min_tables: 12, min_comparative_tables: 3, min_verified_metadata_plots: 3, max_nanobanana_illustrations: 1, require_insight_statements: true });
    expect(config.publication.presentation).toMatchObject({
      citation_style: "author_year", show_production_statistics: true,
      disclosure: { enabled: true, provenance: { enabled: true } },
    });
    expect(config.run_limits.max_recorded_tokens).toBe(10000000);
  });

  it("suppresses public provenance disclosure for an anonymous flagship workspace", async () => {
    const root = await makeRoot();
    const target = path.join(root, "anonymous-survey");
    await runInit(target, { topic: "Long-horizon agent memory", anonymous: true });
    const config = parseYaml(await fs.readFile(path.join(target, "longwrite.yaml"), "utf8"));
    expect(config.publication).toMatchObject({ anonymous: true, presentation: { disclosure: { enabled: false, provenance: { enabled: false } } } });
  });

  it("scaffolds a shorter repository-study paper with a pinned primary codebase", async () => {
    const root = await makeRoot();
    const target = path.join(root, "repo-study");
    await runInit(target, {
      topic: "Architecture of a long-horizon research system",
      researchPaperProfile: "repository_study",
      repository: ["https://github.com/example/longexperiment.git"],
    });
    const config = parseYaml(await fs.readFile(path.join(target, "longwrite.yaml"), "utf8"));
    const manifest = await fs.readFile(path.join(target, "malaclaw.yaml"), "utf8");
    expect(config.research).toMatchObject({
      paper_kind: "survey", paper_profile: "repository_study", workflow_profile: "standard",
      codebases: [{ id: "repo-longexperiment", source: "https://github.com/example/longexperiment.git", ref: "HEAD", role: "primary_artifact" }],
      release_gates: { min_cited_sources: 12, min_citation_depths_per_section: { B: 1, C: 1 } },
    });
    expect(config.writing.target_length_words).toBe(10000);
    expect(config.publication.min_pages).toBeUndefined();
    expect(config.publication.presentation).toMatchObject({ citation_style: "numeric", show_production_statistics: false });
    expect(config.figures.quality_gates).toMatchObject({ min_figures: 3, min_tables: 3 });
    expect(config.research.provider).toBe("multi");
    expect(manifest).toContain("semantic_candidate_select");
    expect(await fs.readFile(path.join(target, ".malaclaw", "fixtures", "chapters", "section-1.md"), "utf8")).toContain("[codebase:repo-longexperiment]");
  });

  it("does not impose the survey page floor on a literature-driven empirical paper", async () => {
    const root = await makeRoot();
    const target = path.join(root, "empirical");
    await runInit(target, {
      topic: "A controlled self-play intervention",
      researchPaperKind: "empirical",
      researchPaperProfile: "literature_survey",
      targetLengthWords: "14000",
    });
    const config = parseYaml(await fs.readFile(path.join(target, "longwrite.yaml"), "utf8"));
    expect(config.research).toMatchObject({ paper_kind: "empirical", paper_profile: "literature_survey" });
    expect(config.writing.target_length_words).toBe(14_000);
    expect(config.publication.min_pages).toBeUndefined();
  });

  it("resolves a local --repository path from the launch directory, not the new workspace", async () => {
    const root = await makeRoot();
    const repository = path.join(root, "existing-repository");
    await fs.mkdir(repository);
    const target = path.join(root, "paper");
    await runInit(target, {
      topic: "Repository architecture",
      researchPaperProfile: "repository_study",
      repository: [path.relative(process.cwd(), repository)],
    });
    const config = parseYaml(await fs.readFile(path.join(target, "longwrite.yaml"), "utf8"));
    expect(config.research.codebases[0].source).toBe(repository);
  });

  it("requires a repository for the repository-study profile", async () => {
    const root = await makeRoot();
    await expect(runInit(path.join(root, "repo-study"), {
      topic: "Repository architecture",
      researchPaperProfile: "repository_study",
    })).rejects.toThrow(/requires at least one --repository or --discover-repositories/);
  });

  it("scaffolds bounded GitHub discovery as a repository-study evidence source", async () => {
    const root = await makeRoot();
    const target = path.join(root, "discovery-study");
    await runInit(target, {
      topic: "Agent memory repositories",
      researchPaperProfile: "repository_study",
      discoverRepositories: true,
      repositoryQueryBudget: "3",
      repositoryMaxCandidates: "18",
      repositoryMaxReadmes: "7",
      repositoryMaxSelected: "4",
      repositoryLanguage: ["Python", "TypeScript"],
      includeArchivedRepositories: true,
      allowUnlicensedRepositories: true,
    });
    const config = parseYaml(await fs.readFile(path.join(target, "longwrite.yaml"), "utf8"));
    expect(config.research.codebases).toEqual([]);
    expect(config.research.codebase_discovery).toEqual({
      enabled: true, provider: "github", query_budget: 3, max_candidates: 18, max_readme_fetches: 7,
      max_selected: 4, require_license: false, include_archived: true, languages: ["Python", "TypeScript"],
    });
    const manifest = await fs.readFile(path.join(target, "malaclaw.yaml"), "utf8");
    expect(manifest).toContain("github_codebase_recall");
    expect(manifest).toContain("github_codebase_screen");
  });

  it("rejects discovery controls outside the repository-study profile", async () => {
    const root = await makeRoot();
    await expect(runInit(path.join(root, "bad-discovery"), {
      topic: "Agent memory", discoverRepositories: true,
    })).rejects.toThrow(/requires --research-paper-profile repository_study/i);
  });

  it("accepts init-time operational guardrail overrides", async () => {
    const root = await makeRoot();
    const target = path.join(root, "survey");
    await runInit(target, {
      mode: "auto_research_agentic",
      topic: "Long-horizon agent memory",
      maxUnitMinutes: "45",
      maxActiveRunMinutes: "360",
      maxRecordedTokens: "500000",
    });
    const config = parseYaml(await fs.readFile(path.join(target, "longwrite.yaml"), "utf-8"));
    expect(config.run_limits).toEqual({
      max_unit_minutes: 45,
      max_active_run_minutes: 360,
      max_recorded_tokens: 500000,
      on_limit: "pause",
    });
  });

  it("rejects unknown research providers", async () => {
    const root = await makeRoot();
    await expect(runInit(path.join(root, "survey"), {
      topic: "Long-horizon agent memory",
      researchProvider: "nope",
    })).rejects.toThrow(/research-provider/);
  });

  it("stores review policy options", async () => {
    const root = await makeRoot();
    const target = path.join(root, "survey");
    await runInit(target, {
      topic: "Long-horizon agent memory",
      reviewCadence: "interval",
      reviewIntervalHours: "6",
      batchApprovals: true,
    });
    const config = parseYaml(await fs.readFile(path.join(target, "longwrite.yaml"), "utf-8"));
    expect(config.review.cadence).toBe("interval");
    expect(config.review.interval_hours).toBe(6);
    expect(config.review.batch_approvals).toBe(true);
  });

  it("stores authors, emails, and requested output formats", async () => {
    const root = await makeRoot();
    const target = path.join(root, "novel");
    await runInit(target, {
      mode: "novel",
      topic: "A memory city",
      author: ["Ada Lovelace", "Grace Hopper"],
      email: ["ada@example.com"],
      outputFormat: ["markdown", "pdf"],
      referenceInstructions: "Use the notes for terminology only; never cite them as evidence.",
    });
    const config = parseYaml(await fs.readFile(path.join(target, "longwrite.yaml"), "utf-8"));
    expect(config.project.authors).toEqual([
      { name: "Ada Lovelace", email: "ada@example.com" },
      { name: "Grace Hopper" },
    ]);
    expect(config.writing.output_formats).toEqual(["markdown", "pdf"]);
    expect(config.writing.reference_instructions).toBe("Use the notes for terminology only; never cite them as evidence.");
    expect(await fs.readFile(path.join(target, "project_brief.md"), "utf-8"))
      .toContain("Reference-use instructions: Use the notes for terminology only");
  });

  it("stores runtime profile and compiles advisor/executor tiers", async () => {
    const root = await makeRoot();
    const target = path.join(root, "survey");
    await runInit(target, {
      topic: "Long-horizon agent memory",
      runtimeProfile: "codex_first",
    });
    const config = parseYaml(await fs.readFile(path.join(target, "longwrite.yaml"), "utf-8"));
    expect(config.runtime_profile).toBe("codex_first");
    const manifest = parseYaml(await fs.readFile(path.join(target, "malaclaw.yaml"), "utf-8"));
    expect(manifest.workflow.model_tiers.advisor.runtime).toBe("claude-code");
    expect(manifest.workflow.stages.find((s: { id: string }) => s.id === "intake").model_tier).toBe("advisor");
  });

  it("rejects unknown runtime profiles", async () => {
    const root = await makeRoot();
    await expect(runInit(path.join(root, "survey"), {
      topic: "Long-horizon agent memory",
      runtimeProfile: "expensive_magic",
    })).rejects.toThrow(/runtime-profile/);
  });

  it("rejects invalid review options", async () => {
    const root = await makeRoot();
    await expect(runInit(path.join(root, "survey"), {
      topic: "Long-horizon agent memory",
      reviewCadence: "whenever",
    })).rejects.toThrow(/review-cadence/);
    await expect(runInit(path.join(root, "survey2"), {
      topic: "Long-horizon agent memory",
      reviewIntervalHours: "0",
    })).rejects.toThrow(/review-interval-hours/);
  });
});

describe("shouldRunWizard", () => {
  it("always runs with the explicit --interactive flag", () => {
    expect(shouldRunWizard({ interactive: true, topic: "already set" })).toBe(true);
  });

  it("never runs without a TTY (CI, pipes, scripted scaffolds)", () => {
    // Vitest runs without a TTY, so the non-interactive path is what we can
    // assert directly: a topic-less init must not hang waiting for prompts.
    expect(process.stdin.isTTY).toBeFalsy();
    expect(shouldRunWizard({})).toBe(false);
  });

  it("skips the wizard when a topic was provided on the command line", () => {
    expect(shouldRunWizard({ topic: "Long-horizon agent memory" })).toBe(false);
  });
});
