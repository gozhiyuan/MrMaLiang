export const RESEARCH_WORKFLOW_PROFILES = ["fast", "standard", "deep"] as const;
export type ResearchWorkflowProfile = (typeof RESEARCH_WORKFLOW_PROFILES)[number];

export type ResearchWorkflowProfileDef = {
  id: ResearchWorkflowProfile;
  targetCandidates: number;
  queryBudget: number;
  fulltextMaxSources: number;
  maxReviewRounds: number;
  disabledStages: string[];
  description: string;
};

/** Profiles constrain breadth/cost, never provenance: all retain evidence
 * packets, citation validation, LaTeX build, and final validation. */
export const RESEARCH_WORKFLOW_PROFILE_DEFS: Record<ResearchWorkflowProfile, ResearchWorkflowProfileDef> = {
  fast: {
    id: "fast", targetCandidates: 80, queryBudget: 10, fulltextMaxSources: 12, maxReviewRounds: 2,
    disabledStages: ["snowball_recall", "venue_upgrade", "structure_audit"],
    description: "Exploratory, bounded survey pass without optional corpus expansion or venue upgrades.",
  },
  standard: {
    id: "standard", targetCandidates: 240, queryBudget: 30, fulltextMaxSources: 40, maxReviewRounds: 5,
    disabledStages: ["snowball_recall", "venue_upgrade"],
    description: "Default evidence-backed survey workflow with full-text review and publication gates.",
  },
  deep: {
    id: "deep", targetCandidates: 400, queryBudget: 50, fulltextMaxSources: 100, maxReviewRounds: 5,
    disabledStages: [],
    description: "Flagship/release workflow with citation-network expansion, venue upgrades, and structure audit.",
  },
};

export function researchWorkflowProfile(value: string | undefined): ResearchWorkflowProfile {
  return value === "fast" || value === "deep" || value === "standard" ? value : "standard";
}

export function researchWorkflowProfileDef(value: string | undefined): ResearchWorkflowProfileDef {
  return RESEARCH_WORKFLOW_PROFILE_DEFS[researchWorkflowProfile(value)];
}
