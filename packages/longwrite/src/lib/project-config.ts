import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { PAPER_PROFILE_IDS, paperProfile } from "./paper-profiles.js";
import { CodebaseInput, DEFAULT_GITHUB_CODEBASE_DISCOVERY, GithubCodebaseDiscovery } from "./research/codebase-contract.js";

const ProjectId = z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a slug-like id");
const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM in 24-hour time");
const ResearchProvider = z.enum(["seed", "arxiv", "semantic_scholar", "dblp", "crossref", "openalex", "multi"]);
const ResearchPaperKind = z.enum(["survey", "empirical"]);
/** Paper kind controls review evidence (survey vs experiment); profile
 * controls the organizing artifact and evidence emphasis. */
const ResearchPaperProfile = z.enum(PAPER_PROFILE_IDS);
const ResearchWorkflowProfile = z.enum(["fast", "standard", "deep"]);
const OutputFormat = z.enum(["markdown", "pdf"]);
const SubmissionTarget = z.enum(["arxiv", "custom"]);
const Ratio = z.number().min(0).max(1);
const CitationDepthTargets = z.object({
  A: z.number().int().min(0).max(50).default(0),
  B: z.number().int().min(0).max(50).default(0),
  C: z.number().int().min(0).max(50).default(0),
}).strict().default({ A: 0, B: 0, C: 0 });
const RepositoryFigureInput = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  codebase_id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  /** Path within the already pinned repository snapshot; never a URL. */
  path: z.string().min(1).max(500),
  title: z.string().min(1).max(180),
  caption: z.string().min(1).max(500),
  insight: z.string().min(24).max(800),
  license: z.string().min(1).max(200),
}).strict();
const ProjectAuthor = z
  .object({
    name: z.string().min(1),
    email: z.string().email().optional(),
  })
  .strict();
const StageOverride = z
  .object({
    runtime: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    model_tier: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    requires_human_approval: z.boolean().optional(),
    max_parallel: z.number().int().positive().optional(),
  })
  .strict();

export const LongWriteProjectConfig = z
  .object({
    version: z.literal(1),
    project: z
      .object({
        id: ProjectId,
        name: z.string().min(1).optional(),
        artifact_type: z.string().min(1),
        mode: z.string().min(1),
        authors: z.array(ProjectAuthor).default([]),
      })
      .strict(),
    runtime_profile: z.string().min(1).optional(),
    research: z
      .object({
        provider: ResearchProvider.default("seed"),
        /** Surveys are judged on coverage and synthesis; empirical papers
         * retain an experiment-validation axis. */
        paper_kind: ResearchPaperKind.default("survey"),
        paper_profile: ResearchPaperProfile.default("literature_survey"),
        workflow_profile: ResearchWorkflowProfile.default("standard"),
        topic: z.string().min(1).optional(),
        /** Total target candidates across all executed query variants. */
        target_candidates: z.number().int().min(1).max(1_000).default(100),
        /** Maximum planner-generated queries to execute for this run. */
        query_budget: z.number().int().min(1).max(50).default(24),
        taxonomy: z.array(z.string().min(2)).max(50).default([]),
        /** Pinned local/Git repository inputs are codebase evidence and
         * software citations; they never count as scholarly literature. */
        codebases: z.array(CodebaseInput).max(10).default([]),
        /** Opt-in reuse of a pinned repository visual. The snapshot, path,
         * checksum, revision, license, and attribution are retained in the
         * publication manifest; repository graphics are never experiment data. */
        repository_figures: z.array(RepositoryFigureInput).max(10).default([]),
        /** Optional GitHub API discovery yields bounded candidates; an LLM
         * screens metadata/README excerpts before Git snapshots are created. */
        codebase_discovery: GithubCodebaseDiscovery,
        source_policy: z
          .object({
            min_recent_ratio: Ratio.default(0.4),
            min_verified_ratio: Ratio.default(0.8),
            max_arxiv_only_ratio: Ratio.default(0.6),
            require_live_urls: z.boolean().default(false),
          })
          .strict()
          .default({ min_recent_ratio: 0.4, min_verified_ratio: 0.8, max_arxiv_only_ratio: 0.6, require_live_urls: false }),
        /** Release gates apply to the sources actually cited in the reader
         * manuscript, not to the broader retrieval corpus. Zero values keep
         * the corresponding gate informational for legacy workspaces. */
        release_gates: z
          .object({
            min_cited_sources: z.number().int().min(0).max(2_000).default(0),
            min_citations_per_page: z.number().min(0).max(50).default(0),
            /** Publication years are the only durable recency metadata across
             * providers, so “within one year” is calendar-year based. */
            min_cited_within_one_year_ratio: Ratio.default(0),
            min_accepted_cited_ratio: Ratio.default(0),
            max_cited_arxiv_only_ratio: Ratio.default(1),
            min_citation_depths_per_section: CitationDepthTargets,
            min_cited_ab_sources_per_taxonomy_cell: z.number().int().min(0).max(100).default(0),
          })
          .strict()
          .default({ min_cited_sources: 0, min_citations_per_page: 0, min_cited_within_one_year_ratio: 0, min_accepted_cited_ratio: 0, max_cited_arxiv_only_ratio: 1, min_citation_depths_per_section: { A: 0, B: 0, C: 0 }, min_cited_ab_sources_per_taxonomy_cell: 0 }),
        /** Empirical runs are opt-in because LongWrite must never fabricate
         * experiment results. A valid audited results file is a release gate
         * only when paper_kind is empirical. */
        experiment: z.object({
          enabled: z.boolean().default(false),
          results_path: z.string().min(1).default("experiments/results.json"),
          manifest_path: z.string().min(1).optional(),
          min_trials: z.number().int().min(1).max(100).default(3),
          /** For a repository empirical paper, bind the experiment's pinned
           * input revision to this already snapshotted LongWrite codebase. */
          codebase_id: z.string().regex(/^[a-z][a-z0-9_-]*$/).optional(),
          input_id: z.string().regex(/^[a-z][a-z0-9_-]*$/).optional(),
        }).strict().default({ enabled: false, results_path: "experiments/results.json", min_trials: 3 }),
        fulltext: z
          .object({
            max_core_sources: z.number().int().min(1).max(200).default(40),
            allow_pdf_download: z.boolean().default(true),
          })
          .strict()
          .default({ max_core_sources: 40, allow_pdf_download: true }),
        /** Agentic-only semantic bridge: scripts bound the candidate set, an
         * LLM screens abstracts, and A/B depth later requires full-text
         * evidence. Stable V2 ignores it because it has no such stages. */
        semantic_screen: z
          .object({
            enabled: z.boolean().default(false),
            max_candidates: z.number().int().min(1).max(200).default(80),
            min_candidates_per_taxonomy_cell: z.number().int().min(0).max(20).default(3),
            max_evidence_sources: z.number().int().min(1).max(100).default(24),
            min_supported_claims_for_a: z.number().int().min(1).max(10).default(2),
            min_supported_claims_for_b: z.number().int().min(1).max(10).default(1),
          })
          .strict()
          .default({ enabled: false, max_candidates: 80, min_candidates_per_taxonomy_cell: 3, max_evidence_sources: 24, min_supported_claims_for_a: 2, min_supported_claims_for_b: 1 }),
        /** Bounded pre-draft outline critique is agentic-only. It is kept
         * separate from manuscript review because it changes the paper's
         * intellectual structure before any chapter prose exists. */
        outline_review: z
          .object({
            enabled: z.boolean().default(false),
            max_rounds: z.number().int().min(1).max(4).default(2),
            approval_mode: z.enum(["auto", "human"]).default("auto"),
          })
          .strict()
          .default({ enabled: false, max_rounds: 2, approval_mode: "auto" }),
        verification: z
          .object({
            max_sources: z.number().int().min(1).max(200).default(30),
          })
          .strict()
          .default({ max_sources: 30 }),
        corpus_gates: z
          .object({
            min_candidates: z.number().int().min(1).max(2_000).default(200),
            min_sources_per_taxonomy_cell: z.number().int().min(0).max(100).default(3),
            min_core_sources: z.number().int().min(0).max(500).default(20),
            min_recent_ratio: Ratio.default(0.25),
            min_source_type_diversity: z.number().int().min(1).max(10).default(3),
          })
          .strict()
          .default({ min_candidates: 200, min_sources_per_taxonomy_cell: 3, min_core_sources: 20, min_recent_ratio: 0.25, min_source_type_diversity: 3 }),
        // The default deterministic scaffold makes dry-runs reproducible.
        // llm_sections promotes each foreach section to a real worker task
        // with its evidence packet injected through MalaClaw skills.
        writing_strategy: z.enum(["scaffold_then_revise", "llm_sections"]).default("scaffold_then_revise"),
        retrieval: z
          .object({
            backend: z.enum(["sqlite_fts", "hybrid_openai"]).default("sqlite_fts"),
            embedding_model: z.string().min(1).default("text-embedding-3-small"),
          })
          .strict()
          .default({ backend: "sqlite_fts", embedding_model: "text-embedding-3-small" }),
      })
      .strict()
      .default({ provider: "seed", paper_kind: "survey", paper_profile: "literature_survey", workflow_profile: "standard", target_candidates: 100, query_budget: 24, taxonomy: [], codebases: [], repository_figures: [], codebase_discovery: DEFAULT_GITHUB_CODEBASE_DISCOVERY, source_policy: { min_recent_ratio: 0.4, min_verified_ratio: 0.8, max_arxiv_only_ratio: 0.6, require_live_urls: false }, release_gates: { min_cited_sources: 0, min_citations_per_page: 0, min_cited_within_one_year_ratio: 0, min_accepted_cited_ratio: 0, max_cited_arxiv_only_ratio: 1, min_citation_depths_per_section: { A: 0, B: 0, C: 0 }, min_cited_ab_sources_per_taxonomy_cell: 0 }, experiment: { enabled: false, results_path: "experiments/results.json", min_trials: 3 }, fulltext: { max_core_sources: 40, allow_pdf_download: true }, semantic_screen: { enabled: false, max_candidates: 80, min_candidates_per_taxonomy_cell: 3, max_evidence_sources: 24, min_supported_claims_for_a: 2, min_supported_claims_for_b: 1 }, outline_review: { enabled: false, max_rounds: 2, approval_mode: "auto" }, verification: { max_sources: 30 }, corpus_gates: { min_candidates: 200, min_sources_per_taxonomy_cell: 3, min_core_sources: 20, min_recent_ratio: 0.25, min_source_type_diversity: 3 }, writing_strategy: "scaffold_then_revise", retrieval: { backend: "sqlite_fts", embedding_model: "text-embedding-3-small" } }),
    // Run guardrails compiled into the MalaClaw workflow. These protect
    // THIS run; they are not provider quotas (which MalaClaw cannot see)
    // and token caps are checked between units, so one in-flight unit can
    // overshoot. on_limit: pause is the only policy — never silent
    // downgrades, never auto-approved gates.
    run_limits: z
      .object({
        max_recorded_tokens: z.number().int().positive().optional(),
        max_unit_minutes: z.number().positive().optional(),
        max_active_run_minutes: z.number().positive().optional(),
        on_limit: z.literal("pause").default("pause"),
      })
      .strict()
      .optional(),
    // Durable execution choices. Keys are a top-level stage id or a nested
    // unit id (`loop.child` / `foreach.step`). The compiler validates that
    // each key maps to a compatible generated workflow node.
    execution: z
      .object({
        stage_overrides: z.record(StageOverride).default({}),
      })
      .strict()
      .default({ stage_overrides: {} }),
    figures: z
      .object({
        quality_gates: z.object({
          min_figures: z.number().int().min(0).max(100).default(0),
          min_tables: z.number().int().min(0).max(100).default(0),
          min_comparative_tables: z.number().int().min(0).max(100).default(0),
          min_verified_metadata_plots: z.number().int().min(0).max(100).default(0),
          max_nanobanana_illustrations: z.number().int().min(0).max(100).default(1),
          require_insight_statements: z.boolean().default(false),
        }).strict().default({ min_figures: 0, min_tables: 0, min_comparative_tables: 0, min_verified_metadata_plots: 0, max_nanobanana_illustrations: 1, require_insight_statements: false }),
        backends: z
          .object({
            // Deterministic SVG/tables always run; mermaid/python run when
            // their tools exist. Nano Banana is the only paid backend and is
            // budget-gated + approval-gated by default.
            nanobanana: z
              .object({
                enabled: z.boolean().default(false),
                budget_usd: z.number().positive().default(2.0),
                requires_approval: z.boolean().default(true),
                model: z.string().min(1).optional(),
              })
              .strict()
              .default({ enabled: false, budget_usd: 2.0, requires_approval: true }),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    writing: z
      .object({
        language: z.string().min(1).optional(),
        // For CJK-dominant manuscripts this is interpreted as characters
        // (字数): CJK has no whitespace word boundaries.
        target_length_words: z.number().int().positive().optional(),
        genre: z.string().min(1).optional(),
        audience: z.string().min(1).optional(),
        style_instructions: z.string().min(1).optional(),
        reference_instructions: z.string().min(1).max(10_000).optional(),
        reference_links: z.array(z.string().min(1)).default([]),
        reference_files: z.array(z.string().min(1)).default([]),
        output_formats: z.array(OutputFormat).default(["markdown"]),
      })
      .strict()
      .default({ reference_links: [], reference_files: [], output_formats: ["markdown"] }),
    /** Packaging and layout constraints are explicit so a generic manuscript
     * cannot accidentally claim compliance with a named venue. */
    publication: z
      .object({
        target: SubmissionTarget.default("arxiv"),
        anonymous: z.boolean().default(false),
        min_pages: z.number().int().positive().optional(),
        page_limit: z.number().int().positive().optional(),
        required_sections: z.array(z.string().min(1)).max(30).default([]),
        /** Workspace-relative directory containing the official custom class assets. */
        template_dir: z.string().min(1).optional(),
        /** Class name without .cls, for example neurips_2025. */
        document_class: z.string().regex(/^[A-Za-z0-9._-]+$/).optional(),
        document_class_options: z.array(z.string().min(1)).max(20).default([]),
        presentation: z.object({
          citation_style: z.enum(["numeric", "author_year"]).default("numeric"),
          show_production_statistics: z.boolean().default(false),
          disclosure: z.object({
            enabled: z.boolean().default(false),
            ai_use: z.string().min(1).max(2_000).optional(),
            authorship: z.string().min(1).max(2_000).optional(),
            correspondence: z.string().min(1).max(500).optional(),
            last_updated: z.string().min(1).max(80).optional(),
            version: z.string().min(1).max(80).optional(),
            provenance: z.object({
              enabled: z.boolean().default(false),
              include_longwrite: z.boolean().default(true),
              include_malaclaw: z.boolean().default(true),
              include_runtime_models: z.boolean().default(true),
            }).strict().default({ enabled: false, include_longwrite: true, include_malaclaw: true, include_runtime_models: true }),
          }).strict().default({ enabled: false }),
        }).strict().default({ citation_style: "numeric", show_production_statistics: false, disclosure: { enabled: false } }),
      })
      .strict()
      .superRefine((value, ctx) => {
        if (value.target === "custom" && !value.template_dir) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["template_dir"], message: "is required when publication.target is custom" });
        }
        if (value.target === "custom" && !value.document_class) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["document_class"], message: "is required when publication.target is custom" });
        }
      })
      .default({ target: "arxiv", anonymous: false, required_sections: [], document_class_options: [], presentation: { citation_style: "numeric", show_production_statistics: false, disclosure: { enabled: false } } }),
    review: z
      .object({
        cadence: z.enum(["manual", "daily", "interval"]).default("manual"),
        time: TimeOfDay.default("08:00"),
        interval_hours: z.number().int().positive().default(4),
        batch_approvals: z.boolean().default(false),
      })
      .strict()
      .default({ cadence: "manual", time: "08:00", interval_hours: 4, batch_approvals: false }),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (paperProfile(config.research.paper_profile).requiresCodebase && config.research.codebases.length === 0 && !config.research.codebase_discovery.enabled) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["research", "codebases"], message: `${config.research.paper_profile} requires at least one codebase or enabled codebase_discovery` });
    }
    if (config.publication.anonymous && config.publication.presentation.disclosure.enabled) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["publication", "presentation", "disclosure", "enabled"], message: "anonymous publication cannot include an AI-use, authorship, correspondence, version, or provenance disclosure; disable disclosure or set publication.anonymous: false" });
    }
  });

export type LongWriteProjectConfig = z.infer<typeof LongWriteProjectConfig>;

export function parseProjectConfig(raw: unknown): LongWriteProjectConfig {
  return LongWriteProjectConfig.parse(raw);
}

async function readTextIfExists(absPath: string): Promise<string | null> {
  try {
    return await fs.readFile(absPath, "utf-8");
  } catch {
    return null;
  }
}

export async function loadProjectConfig(workspaceDir: string): Promise<LongWriteProjectConfig> {
  const raw = await fs.readFile(path.join(workspaceDir, "longwrite.yaml"), "utf-8");
  return parseProjectConfig(parseYaml(raw));
}

export async function loadProjectConfigIfExists(workspaceDir: string): Promise<LongWriteProjectConfig | null> {
  const raw = await readTextIfExists(path.join(workspaceDir, "longwrite.yaml"));
  if (raw === null) return null;
  return parseProjectConfig(parseYaml(raw));
}

export function projectConfigErrorToFindings(error: unknown): string[] {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join(".") : "longwrite.yaml";
      return `${field}: ${issue.message}`;
    });
  }
  return [error instanceof Error ? error.message : String(error)];
}
