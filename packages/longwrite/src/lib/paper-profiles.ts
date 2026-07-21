/**
 * Paper profiles compose with `research.paper_kind`: kind decides whether a
 * manuscript is a survey or empirical report, while a profile decides which
 * evidence artifact organizes the paper. Keep all profile-owned defaults,
 * prompt overlays, and release expectations here so adding a new profile does
 * not fork the shared agentic research workflow.
 */
export const PAPER_PROFILE_IDS = ["literature_survey", "repository_study"] as const;
export type PaperProfileId = typeof PAPER_PROFILE_IDS[number];

type ReleaseGates = {
  min_cited_sources: number;
  min_citations_per_page: number;
  min_cited_within_one_year_ratio: number;
  min_accepted_cited_ratio: number;
  max_cited_arxiv_only_ratio: number;
  min_citation_depths_per_section: { A: number; B: number; C: number };
  min_cited_ab_sources_per_taxonomy_cell: number;
};

type CorpusGates = {
  min_candidates: number;
  min_sources_per_taxonomy_cell: number;
  min_core_sources: number;
  min_recent_ratio: number;
  min_source_type_diversity: number;
};

type FigureGates = {
  min_figures: number;
  min_tables: number;
  min_comparative_tables: number;
  min_verified_metadata_plots: number;
  max_nanobanana_illustrations: number;
  require_insight_statements: boolean;
};

export type PaperProfile = {
  id: PaperProfileId;
  defaultWorkflowProfile: "standard" | "deep";
  targetWords: number;
  minPages?: number;
  releaseGates: ReleaseGates;
  corpusGates: CorpusGates;
  figureGates: FigureGates;
  requiresCodebase: boolean;
  requiredVisualIds: string[];
  architectureTitleRequired: boolean;
  architectureDiagram: {
    minSources: number;
    requiresPinnedCodebaseSource: boolean;
  };
  promptOverlays: {
    outline: string[];
    draft: string[];
    visual: string[];
    artifact: string[];
  };
};

const literatureSurvey: PaperProfile = {
  id: "literature_survey",
  defaultWorkflowProfile: "deep",
  targetWords: 24_000,
  minPages: 60,
  releaseGates: {
    min_cited_sources: 80, min_citations_per_page: 3, min_cited_within_one_year_ratio: 0.3,
    min_accepted_cited_ratio: 0.3, max_cited_arxiv_only_ratio: 0.5,
    min_citation_depths_per_section: { A: 1, B: 2, C: 2 }, min_cited_ab_sources_per_taxonomy_cell: 2,
  },
  corpusGates: { min_candidates: 200, min_sources_per_taxonomy_cell: 3, min_core_sources: 20, min_recent_ratio: 0.25, min_source_type_diversity: 4 },
  figureGates: { min_figures: 6, min_tables: 12, min_comparative_tables: 3, min_verified_metadata_plots: 3, max_nanobanana_illustrations: 1, require_insight_statements: true },
  requiresCodebase: false,
  requiredVisualIds: ["source-years", "concept-map", "evidence-profile", "method-comparison", "benchmark-metadata"],
  architectureTitleRequired: false,
  architectureDiagram: { minSources: 3, requiresPinnedCodebaseSource: false },
  promptOverlays: { outline: [], draft: [], visual: [], artifact: [] },
};

const repositoryStudy: PaperProfile = {
  id: "repository_study",
  defaultWorkflowProfile: "standard",
  targetWords: 10_000,
  releaseGates: {
    min_cited_sources: 12, min_citations_per_page: 0, min_cited_within_one_year_ratio: 0,
    min_accepted_cited_ratio: 0, max_cited_arxiv_only_ratio: 1,
    min_citation_depths_per_section: { A: 0, B: 1, C: 1 }, min_cited_ab_sources_per_taxonomy_cell: 0,
  },
  corpusGates: { min_candidates: 50, min_sources_per_taxonomy_cell: 0, min_core_sources: 6, min_recent_ratio: 0.1, min_source_type_diversity: 1 },
  figureGates: { min_figures: 3, min_tables: 3, min_comparative_tables: 1, min_verified_metadata_plots: 1, max_nanobanana_illustrations: 1, require_insight_statements: true },
  requiresCodebase: true,
  requiredVisualIds: ["concept-map"],
  architectureTitleRequired: true,
  architectureDiagram: { minSources: 1, requiresPinnedCodebaseSource: true },
  promptOverlays: {
    outline: ["This is a repository-study paper: organize the argument around the pinned system's problem framing, architecture, component responsibilities, interfaces/workflows, design trade-offs, operational boundaries, and limitations. Explain the solution; do not turn the paper into a file-by-file inventory or infer behavior that the pinned evidence does not show."],
    draft: ["This is a repository-study paper: organize the argument around the pinned system's problem framing, architecture, component responsibilities, interfaces/workflows, design trade-offs, operational boundaries, and limitations. Explain the solution; do not turn the paper into a file-by-file inventory or infer behavior that the pinned evidence does not show."],
    visual: ["This is a repository-study paper. Write concept_map as a pinned-repository system architecture diagram: title/caption must say architecture or system architecture; nodes identify repository components/interfaces and edges identify data, control, or trust-boundary relationships. Ground labels in evidence/codebase-context.md, place it in the architecture section, and never depict inferred execution results. This architecture diagram is required for release."],
    artifact: ["This is a repository-study paper. Include exactly one architecture_diagram intent for the system-architecture section, grounded in at least one `codebase:<id>` source from codebases/manifest.json. It should explain components, data/control flow, and trust boundaries from the pinned snapshot—not claim runtime measurements."],
  },
};

const profiles: Record<PaperProfileId, PaperProfile> = {
  literature_survey: literatureSurvey,
  repository_study: repositoryStudy,
};

export function paperProfile(id: PaperProfileId | undefined): PaperProfile {
  return profiles[id ?? "literature_survey"];
}
