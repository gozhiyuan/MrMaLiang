/**
 * Paper profiles compose with `research.paper_kind`: kind decides whether a
 * manuscript is a survey or empirical report, while a profile decides which
 * evidence artifact organizes the paper. Keep all profile-owned defaults,
 * prompt overlays, and release expectations here so adding a new profile does
 * not fork the shared agentic research workflow.
 */
export const PAPER_PROFILE_IDS = [
  "flagship_short_paper",
  "flagship_long_paper",
  "flagship_short_github_paper",
  "flagship_long_github_paper",
] as const;
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
  /**
   * How much validated evidence this paper kind is allowed to collect.
   *
   * This was a flat constant: a 60-page survey and a 10k-word repository study
   * both got 32 evidence sources. A/B citation depth requires a validated
   * packet, so this cap is the ceiling on a manuscript's evidentiary depth —
   * and a flagship run hit it, ending with 24 packet-backed sources, zero at
   * A level, and a 37-page draft against a 60-page target. Evidence supply has
   * to scale with the manuscript it is meant to support.
   */
  evidenceBudget: { maxCandidates: number; maxEvidenceSources: number };
  /**
   * Bounded retrieval and verification work for this manuscript scope. This
   * belongs to the paper profile rather than the broad workflow label: a
   * short flagship still uses the deep workflow's quality loop, but it should
   * not retrieve and verify enough material for a 60-page survey.
   */
  researchBudget: {
    targetCandidates: number;
    queryBudget: number;
    fulltextMaxSources: number;
    verificationMaxSources: number;
  };
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

const flagshipLongPaper: PaperProfile = {
  id: "flagship_long_paper",
  defaultWorkflowProfile: "deep",
  targetWords: 24_000,
  minPages: 60,
  releaseGates: {
    min_cited_sources: 80, min_citations_per_page: 3, min_cited_within_one_year_ratio: 0.3,
    min_accepted_cited_ratio: 0.3, max_cited_arxiv_only_ratio: 0.5,
    // Section coverage is a depth requirement, not a request to sprinkle
    // every evidence tier through every chapter. B-depth records are the
    // packet-backed basis for prose; A/B coverage is separately required for
    // each taxonomy cell. Requiring A and C in every section can be
    // infeasible for a valid corpus (and C is not a higher-quality tier).
    min_citation_depths_per_section: { A: 0, B: 2, C: 0 }, min_cited_ab_sources_per_taxonomy_cell: 2,
  },
  corpusGates: { min_candidates: 200, min_sources_per_taxonomy_cell: 3, min_core_sources: 20, min_recent_ratio: 0.25, min_source_type_diversity: 4 },
  evidenceBudget: { maxCandidates: 200, maxEvidenceSources: 96 },
  researchBudget: { targetCandidates: 400, queryBudget: 50, fulltextMaxSources: 100, verificationMaxSources: 100 },
  // A publication-quality survey needs reader-relevant comparisons, not a
  // quota of corpus bookkeeping. The artifact plan is allowed to select none
  // when no figure/table advances the argument; selected artifacts still have
  // source-binding, caption, and rendered-visual-review gates.
  figureGates: { min_figures: 0, min_tables: 0, min_comparative_tables: 0, min_verified_metadata_plots: 0, max_nanobanana_illustrations: 1, require_insight_statements: true },
  requiresCodebase: false,
  requiredVisualIds: [],
  architectureTitleRequired: false,
  architectureDiagram: { minSources: 3, requiresPinnedCodebaseSource: false },
  promptOverlays: { outline: [], draft: [], visual: [], artifact: [] },
};

const flagshipLongGithubPaper: PaperProfile = {
  id: "flagship_long_github_paper",
  defaultWorkflowProfile: "deep",
  targetWords: 14_000,
  minPages: 35,
  releaseGates: {
    min_cited_sources: 40, min_citations_per_page: 2, min_cited_within_one_year_ratio: 0.25,
    min_accepted_cited_ratio: 0.25, max_cited_arxiv_only_ratio: 0.55,
    min_citation_depths_per_section: { A: 0, B: 1, C: 0 }, min_cited_ab_sources_per_taxonomy_cell: 0,
  },
  corpusGates: { min_candidates: 160, min_sources_per_taxonomy_cell: 0, min_core_sources: 14, min_recent_ratio: 0.2, min_source_type_diversity: 3 },
  evidenceBudget: { maxCandidates: 160, maxEvidenceSources: 68 },
  researchBudget: { targetCandidates: 240, queryBudget: 32, fulltextMaxSources: 68, verificationMaxSources: 68 },
  // No count target here either, for the same reason as the survey profile: a
  // quota makes the planner manufacture artifacts to satisfy it. The
  // architecture diagram below is a different thing — a domain requirement of
  // a repository study, not a quota — so it stays required by id.
  figureGates: { min_figures: 0, min_tables: 0, min_comparative_tables: 0, min_verified_metadata_plots: 0, max_nanobanana_illustrations: 1, require_insight_statements: true },
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

// Flagship presets deliberately share the same agentic workflow and release
// semantics. They only scale the amount of manuscript, corpus, and evidence
// work to the requested scope. In particular, short does not mean a weaker
// citation, rendering, visual-review, or recovery path.
const flagshipShortPaper: PaperProfile = {
  ...flagshipLongPaper,
  id: "flagship_short_paper",
  targetWords: 8_000,
  minPages: 20,
  releaseGates: {
    min_cited_sources: 30, min_citations_per_page: 2, min_cited_within_one_year_ratio: 0.3,
    min_accepted_cited_ratio: 0.3, max_cited_arxiv_only_ratio: 0.5,
    min_citation_depths_per_section: { A: 0, B: 1, C: 0 }, min_cited_ab_sources_per_taxonomy_cell: 1,
  },
  corpusGates: { min_candidates: 120, min_sources_per_taxonomy_cell: 2, min_core_sources: 12, min_recent_ratio: 0.25, min_source_type_diversity: 3 },
  evidenceBudget: { maxCandidates: 120, maxEvidenceSources: 56 },
  researchBudget: { targetCandidates: 160, queryBudget: 24, fulltextMaxSources: 56, verificationMaxSources: 56 },
};

const flagshipShortGithubPaper: PaperProfile = {
  ...flagshipLongGithubPaper,
  id: "flagship_short_github_paper",
  defaultWorkflowProfile: "deep",
  targetWords: 6_000,
  minPages: 15,
  releaseGates: {
    min_cited_sources: 18, min_citations_per_page: 1.5, min_cited_within_one_year_ratio: 0.2,
    min_accepted_cited_ratio: 0.2, max_cited_arxiv_only_ratio: 0.6,
    min_citation_depths_per_section: { A: 0, B: 1, C: 0 }, min_cited_ab_sources_per_taxonomy_cell: 0,
  },
  corpusGates: { min_candidates: 75, min_sources_per_taxonomy_cell: 0, min_core_sources: 8, min_recent_ratio: 0.15, min_source_type_diversity: 2 },
  evidenceBudget: { maxCandidates: 75, maxEvidenceSources: 36 },
  researchBudget: { targetCandidates: 120, queryBudget: 16, fulltextMaxSources: 36, verificationMaxSources: 36 },
};

const profiles: Record<PaperProfileId, PaperProfile> = {
  flagship_short_paper: flagshipShortPaper,
  flagship_long_paper: flagshipLongPaper,
  flagship_short_github_paper: flagshipShortGithubPaper,
  flagship_long_github_paper: flagshipLongGithubPaper,
};

export function paperProfile(id: PaperProfileId | undefined): PaperProfile {
  return profiles[id ?? "flagship_long_paper"];
}
