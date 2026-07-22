import fs from "node:fs/promises";
import path from "node:path";
import { stringify as stringifyYaml, parse as parseAgentYaml } from "yaml";
import type { LongWriteModeDef } from "./mode-schema.js";
import { compileModeToManifest, manifestToYaml } from "./compiler.js";
import { templatesDir } from "./paths.js";
import type { ResearchProviderId } from "./research/providers.js";
import { dimensionsForArtifact } from "./writing/scorecard.js";
import { writeNovelStage } from "./writing/novel.js";
import { writeTechnicalBookStage } from "./writing/technical-book.js";
import { requireSupportedNode } from "./node-runtime.js";
import { loadRuntimeProfileIfSelected } from "./runtime-profiles.js";
import { researchWorkflowProfile, researchWorkflowProfileDef, type ResearchWorkflowProfile } from "./research/workflow-profiles.js";
import { ensureWorkspaceEnvFiles } from "./workspace-env.js";
import { paperProfile, type PaperProfileId } from "./paper-profiles.js";
import { DEFAULT_GITHUB_CODEBASE_DISCOVERY, type CodebaseConfig, type GithubCodebaseDiscoveryConfig } from "./research/codebase-contract.js";

export type ScaffoldOptions = {
  mode: LongWriteModeDef;
  targetDir: string;
  projectId: string;
  projectName?: string;
  authors?: Array<{ name: string; email?: string }>;
  topic?: string;
  researchProvider?: ResearchProviderId;
  researchWorkflowProfile?: ResearchWorkflowProfile;
  researchPaperKind?: "survey" | "empirical";
  researchPaperProfile?: PaperProfileId;
  codebases?: CodebaseConfig[];
  codebaseDiscovery?: GithubCodebaseDiscoveryConfig;
  researchTargetCandidates?: number;
  researchQueryBudget?: number;
  researchWritingStrategy?: "scaffold_then_revise" | "llm_sections";
  taxonomy?: string[];
  reviewCadence?: "manual" | "daily" | "interval";
  reviewTime?: string;
  reviewIntervalHours?: number;
  batchApprovals?: boolean;
  targetLengthWords?: number;
  genre?: string;
  audience?: string;
  styleInstructions?: string;
  referenceInstructions?: string;
  /** Output language (e.g. "en", "zh", "中文"). Auto-detected from a CJK
   *  topic when omitted. */
  language?: string;
  referenceLinks?: string[];
  referenceFiles?: string[];
  outputFormats?: Array<"markdown" | "pdf">;
  publication?: {
    target?: "arxiv" | "custom";
    anonymous?: boolean;
    pageLimit?: number;
    requiredSections?: string[];
    templateDir?: string;
    documentClass?: string;
    documentClassOptions?: string[];
    citationStyle?: "numeric" | "author_year";
  };
  runtimeProfile?: string;
  runLimits?: {
    max_recorded_tokens?: number;
    max_unit_minutes?: number;
    max_active_run_minutes?: number;
    on_limit?: "pause";
  };
};

/** Workers write in the topic's language unless told otherwise. */
export function detectLanguage(topic?: string, explicit?: string): string | undefined {
  if (explicit?.trim()) return explicit.trim();
  if (topic && /[぀-ヿ㐀-鿿가-힯]/.test(topic)) {
    return /[가-힯]/.test(topic) ? "ko" : /[぀-ヿ]/.test(topic) ? "ja" : "zh";
  }
  return undefined;
}

const WORKSPACE_DIRS = [
  "sources",
  "notes",
  "bibles",
  "outline",
  "chapters",
  "examples",
  "reviews",
  "reports",
  "build",
  "references",
];

type ParsedAgentTemplate = {
  id: string;
  name?: string;
  persona?: string;
  tone?: string;
  boundaries: string[];
};

function parseAgentTemplate(raw: string): ParsedAgentTemplate | null {
  try {
    const parsed = parseAgentYaml(raw) as {
      id?: string;
      name?: string;
      soul?: { persona?: string; tone?: string; boundaries?: string[] };
    };
    if (!parsed?.id) return null;
    return {
      id: parsed.id,
      name: parsed.name,
      persona: parsed.soul?.persona,
      tone: parsed.soul?.tone,
      boundaries: Array.isArray(parsed.soul?.boundaries) ? parsed.soul.boundaries : [],
    };
  } catch {
    return null;
  }
}

/** Create a self-contained writing workspace. */
export async function scaffoldWorkspace(opts: ScaffoldOptions): Promise<string[]> {
  requireSupportedNode("Creating a LongWrite workspace");
  const { mode, targetDir } = opts;
  const isResearchMode = mode.artifact_type === "research_paper";
  const selectedPaperProfile = paperProfile(opts.researchPaperProfile);
  const workflowProfile = opts.researchWorkflowProfile
    ? researchWorkflowProfile(opts.researchWorkflowProfile)
    : (isResearchMode ? selectedPaperProfile.defaultWorkflowProfile : mode.default_workflow_profile ?? "standard");
  const profileDefaults = researchWorkflowProfileDef(workflowProfile);
  // The initial Malaclaw manifest and longwrite.yaml must name the same
  // provider. A standard repository-study still needs live research, even
  // though its workflow budget is smaller than a deep literature survey.
  const researchProvider = opts.researchProvider ?? (isResearchMode || mode.default_workflow_profile === "deep" ? "multi" : "seed");
  // auto_research_agentic is the only research-paper mode; every research
  // workspace uses the release-grade defaults.
  const defaultWritingStrategy = isResearchMode
    ? "llm_sections"
    : "scaffold_then_revise";
  const writingStrategy = opts.researchWritingStrategy ?? defaultWritingStrategy;
  const defaultResearchCandidates = isResearchMode ? profileDefaults.targetCandidates : 100;
  const defaultResearchQueryBudget = isResearchMode ? profileDefaults.queryBudget : 24;
  const requireLiveUrls = isResearchMode;
  const runtimeProfile = await loadRuntimeProfileIfSelected(opts.runtimeProfile);
  const manifestPath = path.join(targetDir, "malaclaw.yaml");
  try {
    await fs.access(manifestPath);
    throw new Error(`Refusing to scaffold: ${manifestPath} already exists`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Refusing")) throw err;
  }

  const created: string[] = [];
  await fs.mkdir(targetDir, { recursive: true });
  for (const dir of WORKSPACE_DIRS) {
    await fs.mkdir(path.join(targetDir, dir), { recursive: true });
    created.push(`${dir}/`);
  }
  created.push(...await ensureWorkspaceEnvFiles(targetDir));

  // Style/language directives live in the brief because every writing stage
  // takes project_brief.md as an input — this is how they reach the workers.
  // Research papers and technical books stay English unless the user says
  // otherwise; only novels auto-detect the topic's language.
  const language = mode.artifact_type === "novel"
    ? detectLanguage(opts.topic, opts.language)
    : opts.language?.trim() || undefined;
  const defaultTargetLengthWords = mode.id === "auto_research_agentic" ? selectedPaperProfile.targetWords : undefined;
  const targetLengthWords = opts.targetLengthWords ?? defaultTargetLengthWords;
  const directives = [
    ...((opts.authors ?? []).map((author) => `- Author: ${author.name}${author.email ? ` <${author.email}>` : ""}`)),
    ...(language ? [`- Language: write ALL prose, reviews, and artifacts in ${language}.`] : []),
    ...(opts.genre ? [`- Genre: ${opts.genre}`] : []),
    ...(opts.audience ? [`- Audience: ${opts.audience}`] : []),
    ...(targetLengthWords ? [`- Target length: about ${targetLengthWords} words total.`] : []),
    ...(mode.artifact_type === "research_paper" ? [`- Research paper kind: ${opts.researchPaperKind ?? "survey"}; paper profile: ${opts.researchPaperProfile ?? "literature_survey"}.`] : []),
    ...(mode.artifact_type === "research_paper" ? [`- Publication target: ${opts.publication?.target ?? "arxiv"}${opts.publication?.anonymous ? " (anonymous)" : ""}.`] : []),
    ...(opts.publication?.requiredSections?.length ? [`- Required submission sections: ${opts.publication.requiredSections.join(", ")}.`] : []),
    `- Research target: ${opts.researchTargetCandidates ?? defaultResearchCandidates} candidates across up to ${opts.researchQueryBudget ?? defaultResearchQueryBudget} queries.`,
    ...((opts.taxonomy ?? []).map((term) => `- Taxonomy coverage cell: ${term}`)),
    ...(opts.styleInstructions ? [`- Style: ${opts.styleInstructions}`] : []),
    ...(opts.referenceInstructions ? [`- Reference-use instructions: ${opts.referenceInstructions}`] : []),
    ...((opts.referenceLinks ?? []).map((link) => `- Reference link: ${link}`)),
    ...((opts.referenceFiles ?? []).map((file) => `- Reference file: ${file}`)),
    ...((opts.referenceLinks?.length || opts.referenceFiles?.length) ? [
      "- Reference-use policy: Recognized arXiv, DOI, and OpenReview links are authoritative scholarly seeds and must resolve exactly through the research pipeline before citation. Other links/files remain context for scope, terminology, or style and are not citable evidence until independently retrieved and validated.",
      "- Reference-file access: Prefer files copied into this workspace under references/. External absolute paths may be unavailable to a headless runtime.",
    ] : []),
  ];
  const brief =
    `# Project Brief\n\n` +
    `Mode: ${mode.name} (${mode.id})\n` +
    `Artifact: ${mode.artifact_type}\n\n` +
    `## Topic\n\n${opts.topic ?? "TODO: describe what you want to write."}\n` +
    (directives.length > 0 ? `\n## Style and Language\n\n${directives.join("\n")}\n` : "");
  await fs.writeFile(path.join(targetDir, "project_brief.md"), brief, "utf-8");
  created.push("project_brief.md");

  const longwriteConfig = {
    version: 1,
    project: {
      id: opts.projectId,
      name: opts.projectName ?? opts.projectId,
      artifact_type: mode.artifact_type,
      mode: mode.id,
      authors: opts.authors ?? [],
    },
    ...(runtimeProfile ? { runtime_profile: runtimeProfile.id } : {}),
    research: {
      provider: researchProvider,
      paper_kind: opts.researchPaperKind ?? "survey",
      paper_profile: opts.researchPaperProfile ?? "literature_survey",
      workflow_profile: workflowProfile,
      ...(opts.topic ? { topic: opts.topic } : {}),
      target_candidates: opts.researchTargetCandidates ?? defaultResearchCandidates,
      query_budget: opts.researchQueryBudget ?? defaultResearchQueryBudget,
      taxonomy: opts.taxonomy ?? [],
      codebases: opts.codebases ?? [],
      codebase_discovery: opts.codebaseDiscovery ?? DEFAULT_GITHUB_CODEBASE_DISCOVERY,
      source_policy: { min_recent_ratio: 0.4, min_verified_ratio: 0.8, max_arxiv_only_ratio: 0.6, require_live_urls: requireLiveUrls },
      release_gates: mode.id === "auto_research_agentic"
        ? selectedPaperProfile.releaseGates
        : { min_cited_sources: 0, min_citations_per_page: 0, min_cited_within_one_year_ratio: 0, min_accepted_cited_ratio: 0, max_cited_arxiv_only_ratio: 1, min_citation_depths_per_section: { A: 0, B: 0, C: 0 }, min_cited_ab_sources_per_taxonomy_cell: 0 },
      experiment: opts.researchPaperKind === "empirical"
        ? { enabled: true, results_path: "experiments/results.json", min_trials: 3 }
        : { enabled: false, results_path: "experiments/results.json", min_trials: 3 },
      fulltext: { max_core_sources: isResearchMode ? profileDefaults.fulltextMaxSources : 40, allow_pdf_download: true },
      semantic_screen: mode.id === "auto_research_agentic"
        ? { enabled: true, max_candidates: 100, min_candidates_per_taxonomy_cell: 3, max_evidence_sources: 32, min_supported_claims_for_a: 2, min_supported_claims_for_b: 1 }
        : { enabled: false, max_candidates: 80, min_candidates_per_taxonomy_cell: 3, max_evidence_sources: 24, min_supported_claims_for_a: 2, min_supported_claims_for_b: 1 },
      outline_review: mode.id === "auto_research_agentic"
        ? { enabled: true, max_rounds: 2, approval_mode: "auto" }
        : { enabled: false, max_rounds: 2, approval_mode: "auto" },
      verification: { max_sources: workflowProfile === "deep" ? 100 : 30 },
      corpus_gates: mode.id === "auto_research_agentic"
        ? selectedPaperProfile.corpusGates
        : { min_candidates: 40, min_sources_per_taxonomy_cell: 1, min_core_sources: 6, min_recent_ratio: 0.1, min_source_type_diversity: 1 },
      writing_strategy: writingStrategy,
      retrieval: { backend: "sqlite_fts", embedding_model: "text-embedding-3-small" },
    },
    writing: {
      ...(language ? { language } : {}),
      ...(targetLengthWords ? { target_length_words: targetLengthWords } : {}),
      ...(opts.genre ? { genre: opts.genre } : {}),
      ...(opts.audience ? { audience: opts.audience } : {}),
      ...(opts.styleInstructions ? { style_instructions: opts.styleInstructions } : {}),
      ...(opts.referenceInstructions ? { reference_instructions: opts.referenceInstructions } : {}),
      reference_links: opts.referenceLinks ?? [],
      reference_files: opts.referenceFiles ?? [],
      output_formats: opts.outputFormats ?? ["markdown"],
    },
    publication: {
      target: opts.publication?.target ?? "arxiv",
      anonymous: opts.publication?.anonymous ?? false,
      // The 60-page contract belongs to the long literature-survey flagship.
      // Literature-driven empirical papers share literature evidence defaults,
      // but their length is governed by the explicit manuscript target because
      // methods/results density differs materially from a survey.
      ...(mode.id === "auto_research_agentic" && opts.researchPaperKind !== "empirical" && selectedPaperProfile.minPages ? { min_pages: selectedPaperProfile.minPages } : {}),
      ...(opts.publication?.pageLimit ? { page_limit: opts.publication.pageLimit } : {}),
      required_sections: opts.publication?.requiredSections ?? [],
      ...(opts.publication?.templateDir ? { template_dir: opts.publication.templateDir } : {}),
      ...(opts.publication?.documentClass ? { document_class: opts.publication.documentClass } : {}),
      document_class_options: opts.publication?.documentClassOptions ?? [],
      presentation: {
        citation_style: opts.publication?.citationStyle ?? (workflowProfile === "deep" ? "author_year" : "numeric"),
        show_production_statistics: workflowProfile === "deep",
        disclosure: {
          enabled: mode.id === "auto_research_agentic" && !opts.publication?.anonymous,
          ...(mode.id === "auto_research_agentic" && !opts.publication?.anonymous
            ? { ai_use: "MrMaLiang's agentic research workflow supported literature research, drafting, review, and figure planning through its LongWrite writing component and the MalaClaw runtime." }
            : {}),
          provenance: { enabled: mode.id === "auto_research_agentic" && !opts.publication?.anonymous, include_longwrite: true, include_malaclaw: true, include_runtime_models: true },
        },
      },
    },
    figures: {
      quality_gates: mode.id === "auto_research_agentic"
        ? selectedPaperProfile.figureGates
        : mode.default_workflow_profile === "deep"
        ? { min_figures: 3, min_tables: 5, min_comparative_tables: 1, min_verified_metadata_plots: 2, max_nanobanana_illustrations: 1, require_insight_statements: true }
        : { min_figures: 0, min_tables: 0, min_comparative_tables: 0, min_verified_metadata_plots: 0, max_nanobanana_illustrations: 1, require_insight_statements: false },
    },
    ...(opts.runLimits ? { run_limits: opts.runLimits } : {}),
    execution: { stage_overrides: {} },
    review: {
      cadence: opts.reviewCadence ?? "manual",
      time: opts.reviewTime ?? "08:00",
      interval_hours: opts.reviewIntervalHours ?? 4,
      batch_approvals: opts.batchApprovals ?? false,
    },
  };
  await fs.writeFile(path.join(targetDir, "longwrite.yaml"), stringifyYaml(longwriteConfig), "utf-8");
  created.push("longwrite.yaml");

  const manifest = compileModeToManifest(mode, {
    projectId: opts.projectId,
    projectName: opts.projectName,
    topic: opts.topic,
    researchProvider,
    runtimeProfile,
    runLimits: opts.runLimits,
    stageOverrides: {},
    researchPolicy: {
      workflowProfile,
      targetCandidates: opts.researchTargetCandidates ?? defaultResearchCandidates,
      queryBudget: opts.researchQueryBudget ?? defaultResearchQueryBudget,
      taxonomy: opts.taxonomy ?? [],
      paperProfile: opts.researchPaperProfile ?? "literature_survey",
      codebases: opts.codebases ?? [],
      codebaseDiscovery: {
        enabled: opts.codebaseDiscovery?.enabled ?? false,
        queryBudget: opts.codebaseDiscovery?.query_budget ?? 10,
        maxCandidates: opts.codebaseDiscovery?.max_candidates ?? 40,
        maxReadmeFetches: opts.codebaseDiscovery?.max_readme_fetches ?? 12,
        maxSelected: opts.codebaseDiscovery?.max_selected ?? 8,
        requireLicense: opts.codebaseDiscovery?.require_license ?? true,
        includeArchived: opts.codebaseDiscovery?.include_archived ?? false,
        languages: opts.codebaseDiscovery?.languages ?? [],
      },
      fulltextMaxSources: isResearchMode ? profileDefaults.fulltextMaxSources : 40,
      allowPdfDownload: true,
      semanticScreenEnabled: mode.id === "auto_research_agentic",
      outlineReviewEnabled: mode.id === "auto_research_agentic",
      outlineReviewMaxRounds: 2,
      outlineApprovalMode: "auto",
      verificationMaxSources: workflowProfile === "deep" ? 100 : 30,
      writingStrategy,
      experiment: {
        enabled: opts.researchPaperKind === "empirical",
        // An empirical workspace is intentionally not runnable until the
        // operator imports an audited LongExperiment bundle and pins this.
        manifestPath: undefined,
      },
    },
  });
  await fs.writeFile(manifestPath, manifestToYaml(manifest), "utf-8");
  created.push("malaclaw.yaml");

  await fs.cp(templatesDir(), path.join(targetDir, "templates"), { recursive: true });
  created.push("templates/");

  // Compile each agent template into roles/<id>.md — MalaClaw injects these
  // into every stage prompt for the matching owner, so owners are real
  // personas with boundaries, not labels.
  const rolesDir = path.join(targetDir, "roles");
  await fs.mkdir(rolesDir, { recursive: true });
  const agentTemplateDir = path.join(targetDir, "templates", "agents");
  for (const entry of (await fs.readdir(agentTemplateDir)).filter((e) => e.endsWith(".yaml")).sort()) {
    const agent = parseAgentTemplate(await fs.readFile(path.join(agentTemplateDir, entry), "utf-8"));
    if (!agent) continue;
    const lines = [
      `# ${agent.name ?? agent.id}`,
      "",
      agent.persona ?? "",
      ...(agent.tone ? ["", `Tone: ${agent.tone}`] : []),
      ...(agent.boundaries.length > 0
        ? ["", "Boundaries (non-negotiable):", ...agent.boundaries.map((b) => `- ${b}`)]
        : []),
      "",
    ];
    await fs.writeFile(path.join(rolesDir, `${agent.id}.md`), lines.join("\n"), "utf-8");
  }
  created.push("roles/");

  // Dry-run fixtures: MalaClaw's DryRunRuntime copies
  // .malaclaw/fixtures/units/<unitKey>/<output> (then .malaclaw/fixtures/<output>)
  // when producing outputs, so the free `--runtime dry-run` pass survives the
  // domain validators. Scorecard ladders improve per round so quality loops
  // demonstrate real behavior (caps hold; the loop stops early on merit).
  const fixturesRoot = path.join(targetDir, ".malaclaw", "fixtures");
  const dims = dimensionsForArtifact(mode.artifact_type, opts.researchPaperKind ?? "survey");
  const writeScorecardLadder = async (entries: Array<{ rel: string; score: number; detail: string }>) => {
    for (const fixture of entries) {
      const dir = path.join(fixturesRoot, fixture.rel, "reviews");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "scorecard.json"),
        JSON.stringify({
          version: 1,
          personas: ["experimentalist", "theorist", "newcomer"].map((id) => ({
            id,
            scores: Object.fromEntries(dims.map((d) => [d, fixture.score])),
            weaknesses: [{ category: "coverage", detail: fixture.detail, severity: "minor" }],
          })),
        }, null, 2),
        "utf-8",
      );
    }
  };

  if (mode.artifact_type === "research_paper") {
    // Dry-run fixture: a valid search plan so the free pass survives the
    // planner validator and plan-driven recall.
    const planDir = path.join(fixturesRoot, "sources");
    await fs.mkdir(planDir, { recursive: true });
    await fs.writeFile(
      path.join(planDir, "search-plan.json"),
      JSON.stringify({
        version: 1,
        topic: opts.topic ?? "unspecified topic",
        query_variants: [opts.topic ?? "unspecified topic"],
        taxonomy_cells: (opts.taxonomy ?? []).map((cell) => ({
          cell,
          query_variants: [
            `${opts.topic ?? "unspecified topic"} ${cell}`,
            `${cell} survey taxonomy`,
            `${cell} benchmark evidence`,
          ],
        })),
        exclusion_terms: [],
        venue_priorities: [],
        rationale: "dry-run fixture: single topic-derived query",
      }, null, 2),
      "utf-8",
    );
    await fs.writeFile(
      path.join(fixturesRoot, "outline.json"),
      JSON.stringify({
        sections: [
          { id: "section-1", title: "Background and Scope", keywords: ["memory", "planning"] },
          { id: "section-2", title: "Methods and Evidence", keywords: ["retrieval", "evaluation"] },
        ],
      }, null, 2),
      "utf-8",
    );
    if ((opts.codebases?.length ?? 0) > 0) {
      const chapterFixtureDir = path.join(fixturesRoot, "chapters");
      await fs.mkdir(chapterFixtureDir, { recursive: true });
      const primaryMarkers = opts.codebases!
        .filter((codebase) => codebase.role === "primary_artifact")
        .map((codebase) => `[codebase:${codebase.id}]`)
        .join(" ");
      await fs.writeFile(path.join(chapterFixtureDir, "section-1.md"), [
        "# Background and Scope", "",
        `This dry-run fixture exercises the pinned-software citation channel ${primaryMarkers}.`, "",
        "It is control-plane prose only and makes no claim about execution results.", "",
      ].join("\n"), "utf8");
      await fs.writeFile(path.join(chapterFixtureDir, "section-2.md"), [
        "# Methods and Evidence", "",
        "This dry-run fixture preserves the separation between software evidence and scholarly evidence.", "",
      ].join("\n"), "utf8");
    }
    // LLM-owned planning/judging stages still need schema-valid output in a
    // free dry run. These fixtures exercise the same placement and claim-gate
    // contracts as a real worker, rather than relying on DryRunRuntime's
    // generic JSON/Markdown placeholders.
    const figuresFixtureDir = path.join(fixturesRoot, "figures");
    await fs.mkdir(figuresFixtureDir, { recursive: true });
    await fs.writeFile(
      path.join(figuresFixtureDir, "placement-plan.json"),
      JSON.stringify({
        version: 1,
        placements: [
          { id: "source-years", placement: { section_id: "section-1", discussion: "The corpus chronology clarifies the evidence base." } },
          { id: "evidence-profile", placement: { section_id: "section-1", discussion: "The evidence-depth distribution qualifies the survey's synthesis." } },
        ],
      }, null, 2),
      "utf-8",
    );
    const reviewFixtureDir = path.join(fixturesRoot, "reviews");
    await fs.mkdir(reviewFixtureDir, { recursive: true });
    await fs.writeFile(
      path.join(reviewFixtureDir, "claim-judgments.jsonl"),
      `${JSON.stringify({
        source_id: "source-1",
        chapter: "section-1",
        claim: "The dry-run claim is supported by its assigned evidence packet.",
        verdict: "entailed",
      })}\n`,
      "utf-8",
    );
    if (mode.id === "auto_research_agentic") {
      // The agentic workflow has an additional LLM-owned control-plane output.
      // Keep dry-run coverage honest: this fixture selects a declared action,
      // so CI exercises validation and materialization by MalaClaw's bounded
      // dispatcher instead of merely skipping the adaptive branch.
      await fs.writeFile(
        path.join(reviewFixtureDir, "artifact-plan.json"),
        JSON.stringify({ version: 1, intents: [] }, null, 2),
        "utf-8",
      );
      await fs.writeFile(
        path.join(reviewFixtureDir, "action-plan.json"),
        JSON.stringify({
          version: 1,
          findings: [{
            id: "coverage-gap",
            severity: "minor",
            summary: "The fixture review requests a narrowly scoped prose revision.",
          }],
          actions: [{
            id: "revise-fixture",
            tool: "revise_sections",
            finding_ids: ["coverage-gap"],
            rationale: "Exercise the allowlisted revision action during the dry-run control-plane check.",
            acceptance_criteria: [{ metric: "cited_sources", target: 1 }],
          }],
        }, null, 2),
        "utf-8",
      );
    }
    await writeScorecardLadder([
      // Ladder: r1 5.8 -> 6.8 (within +1.5 cap), r2 7.4 -> 8.0 meets stop_when.
      { rel: "units/quality_loop-r1-review", score: 5.8, detail: "dry-run round 1 review" },
      { rel: "units/quality_loop-r1-revise", score: 6.8, detail: "dry-run round 1 revision" },
      { rel: "units/quality_loop-r2-review", score: 7.4, detail: "dry-run round 2 review" },
      { rel: "units/quality_loop-r2-revise", score: 8.0, detail: "dry-run round 2 revision" },
      // The shared fixture is the fallback for loop implementations that do
      // not expose a round-specific key to the dry-run runtime. Round one is
      // still capped at 7.0 by the deterministic scorer; the following
      // revision validation reaches 8.0 without bypassing that guard.
      { rel: "", score: 8.0, detail: "dry-run publication-ready review" },
    ]);
    created.push(".malaclaw/fixtures/ (dry-run scorecard ladder)");
  }

  if (mode.id === "novel" || mode.id === "technical_book") {
    // The creative stages run on LLM runtimes now, so dry runs need a full
    // consistent artifact set to satisfy the structural validators. The
    // deterministic stage writers act as fixture factories: they generate a
    // coherent bible/outline/chapter/report set into the fixtures root,
    // which the dry-run runtime copies per declared output.
    await fs.mkdir(fixturesRoot, { recursive: true });
    // Seed the fixture factory with the workspace config so topic/genre/style
    // flow into the generated fixtures.
    await fs.copyFile(path.join(targetDir, "longwrite.yaml"), path.join(fixturesRoot, "longwrite.yaml"));
    const writer = mode.id === "novel" ? writeNovelStage : writeTechnicalBookStage;
    const isConcrete = (out: string) => !out.includes("*") && !out.includes("{{");

    const stages = (mode.workflow as { stages: Array<Record<string, unknown>> }).stages;
    const runStageOutputs = async (outputs: string[]) => {
      const concrete = outputs.filter(isConcrete).filter((o) => o !== "reviews/scorecard.json");
      if (concrete.length > 0) await writer(fixturesRoot, concrete);
    };
    for (const stage of stages) {
      if (Array.isArray(stage.stages)) {
        for (const child of stage.stages as Array<Record<string, unknown>>) {
          await runStageOutputs((child.outputs as string[] | undefined) ?? []);
        }
        continue;
      }
      if (Array.isArray(stage.steps)) {
        // Expand {{chapter.id}} templates against the outline the writer
        // itself generated, so chapters and arcs stay consistent.
        const outlineRaw = await fs.readFile(path.join(fixturesRoot, "outline.json"), "utf-8").catch(() => "{}");
        const ids = ((JSON.parse(outlineRaw) as { chapters?: Array<{ id?: string }> }).chapters ?? [])
          .map((c) => c.id)
          .filter((id): id is string => typeof id === "string");
        for (const id of ids) {
          for (const step of stage.steps as Array<Record<string, unknown>>) {
            const outputs = ((step.outputs as string[] | undefined) ?? [])
              .map((o) => o.replaceAll("{{chapter.id}}", id).replaceAll("{{item.id}}", id));
            await runStageOutputs(outputs);
          }
        }
        continue;
      }
      await runStageOutputs((stage.outputs as string[] | undefined) ?? []);
    }
    await fs.rm(path.join(fixturesRoot, "longwrite.yaml"), { force: true });

    await writeScorecardLadder([
      // max_rounds is 2: r1 6.4 -> 7.2, r2 7.8 -> 8.2 meets stop_when 8.0.
      { rel: "units/quality_loop-r1-feedback_review", score: 6.4, detail: "dry-run round 1 review" },
      { rel: "units/quality_loop-r1-revise", score: 7.2, detail: "dry-run round 1 revision" },
      { rel: "units/quality_loop-r2-feedback_review", score: 7.8, detail: "dry-run round 2 review" },
      { rel: "units/quality_loop-r2-revise", score: 8.2, detail: "dry-run round 2 revision" },
      { rel: "", score: 6, detail: "dry-run placeholder review" },
    ]);
    created.push(".malaclaw/fixtures/ (dry-run artifact set + scorecard ladder)");
  }

  const readme =
    `# ${opts.projectName ?? opts.projectId}\n\n` +
    `A ${mode.name} workspace generated by \`longwrite init\`.\n\n` +
    "```bash\n" +
    "malaclaw validate\n" +
    "malaclaw flow run --runtime dry-run\n" +
    "malaclaw flow report\n" +
    "```\n";
  await fs.writeFile(path.join(targetDir, "README.md"), readme, "utf-8");
  created.push("README.md");

  return created;
}
