export type RepairTool = "targeted_research_expansion" | "reopen_outline" | "revise_sections" | "revise_visual_plan";

export type GateRepairRoute = {
  preferred: RepairTool;
  allowed: readonly RepairTool[];
};

/** Deterministic ownership for release-gate failures.
 *
 * The LLM still decides the intellectual repair inside the selected tool, but
 * it may not send an evidence-acquisition defect to a prose editor or a visual
 * defect to a chapter writer. Unknown legacy checks retain the historical
 * prose default until they receive an explicit owner here. */
const ROUTES: Record<string, GateRepairRoute> = {
  landmark_coverage: { preferred: "targeted_research_expansion", allowed: ["targeted_research_expansion"] },
  landmark_citation_coverage: { preferred: "revise_sections", allowed: ["revise_sections"] },
  claim_contradictions: { preferred: "revise_sections", allowed: ["revise_sections", "reopen_outline"] },
  prose_redundancy: { preferred: "revise_sections", allowed: ["revise_sections"] },
  diagram_connectivity: { preferred: "revise_visual_plan", allowed: ["revise_visual_plan"] },
  publication_figures: { preferred: "revise_visual_plan", allowed: ["revise_visual_plan"] },
  rendered_visual_review: { preferred: "revise_visual_plan", allowed: ["revise_visual_plan"] },
  publication_latex: { preferred: "revise_visual_plan", allowed: ["revise_visual_plan"] },
  publication_layout: { preferred: "revise_visual_plan", allowed: ["revise_visual_plan"] },
  figure_artifacts: { preferred: "revise_visual_plan", allowed: ["revise_visual_plan"] },
  figure_manifest: { preferred: "revise_visual_plan", allowed: ["revise_visual_plan"] },
  figure_references: { preferred: "revise_visual_plan", allowed: ["revise_visual_plan"] },
  full_mode_visual_contract: { preferred: "revise_visual_plan", allowed: ["revise_visual_plan"] },
  reader_facing_publication: { preferred: "revise_visual_plan", allowed: ["revise_visual_plan"] },
  latex_build: { preferred: "revise_visual_plan", allowed: ["revise_visual_plan"] },
  latex_outline_structure: { preferred: "revise_visual_plan", allowed: ["revise_visual_plan"] },
  latex_sources: { preferred: "revise_visual_plan", allowed: ["revise_visual_plan"] },
  manuscript_build: { preferred: "revise_visual_plan", allowed: ["revise_visual_plan"] },
  full_corpus_gates: { preferred: "targeted_research_expansion", allowed: ["targeted_research_expansion"] },
  evidence_coverage: { preferred: "targeted_research_expansion", allowed: ["targeted_research_expansion", "revise_sections"] },
  literature_quality_score: { preferred: "targeted_research_expansion", allowed: ["targeted_research_expansion"] },
  research_policy: { preferred: "targeted_research_expansion", allowed: ["targeted_research_expansion"] },
  full_source_identity: { preferred: "targeted_research_expansion", allowed: ["targeted_research_expansion"] },
  taxonomy_direct_evidence: { preferred: "revise_sections", allowed: ["revise_sections", "targeted_research_expansion"] },
  claim_support: { preferred: "revise_sections", allowed: ["revise_sections"] },
  review_target: { preferred: "revise_sections", allowed: ["revise_sections", "revise_visual_plan", "reopen_outline"] },
  cited_literature_release_gates: { preferred: "revise_sections", allowed: ["revise_sections", "targeted_research_expansion"] },
};

const DEFAULT_ROUTE: GateRepairRoute = { preferred: "revise_sections", allowed: ["revise_sections"] };

export function repairRouteForGate(gateId: string): GateRepairRoute {
  return ROUTES[gateId] ?? DEFAULT_ROUTE;
}

export function gateOwnedByTool(gateId: string, tool: string): boolean {
  return repairRouteForGate(gateId).allowed.includes(tool as RepairTool);
}
