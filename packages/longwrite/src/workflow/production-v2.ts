import type { StageRecord, Workflow } from "./base.js";

export const AUTO_RESEARCH_V2_PHASES = [
  "specify",
  "research",
  "synthesize",
  "write",
  "improve",
  "release",
] as const;

export type AutoResearchV2Phase = typeof AUTO_RESEARCH_V2_PHASES[number];

function withPhase(stage: StageRecord, phase: AutoResearchV2Phase): StageRecord {
  const next: StageRecord = { ...stage, phase };
  if (Array.isArray(stage.stages)) {
    next.stages = (stage.stages as StageRecord[]).map((child) => withPhase(child, phase));
  }
  if (Array.isArray(stage.steps)) {
    next.steps = (stage.steps as StageRecord[]).map((step) => ({ ...step, phase }));
  }
  return next;
}

function phaseForTopLevel(stageId: string, position: number, boundaries: {
  research: number;
  synthesize: number;
  write: number;
  improve: number;
  release: number;
}): AutoResearchV2Phase {
  if (stageId === "intake" || stageId === "search_planner") return "specify";
  if (stageId === "improve") return "improve";
  if (position < boundaries.synthesize) return "research";
  if (position < boundaries.write) return "synthesize";
  if (position < boundaries.improve) return "write";
  if (position < boundaries.release) return "improve";
  return "release";
}

/**
 * Compile Auto Research v2 into a production-oriented execution topology.
 *
 * The former graph ran a broad manuscript quality loop and then cloned most
 * of it into a second final-release recovery loop. That duplicated model
 * spend, reviews, builds, and failure surfaces. V2 retains one deterministic
 * release assessment followed by one bounded, targeted improvement loop.
 * Models still own research, synthesis, prose, and repair judgment; this
 * transform changes only durable control flow.
 */
export function withProductionAutoResearchV2(
  workflow: Workflow,
  opts: { offlineRehearsal?: boolean } = {},
): Workflow {
  const next = structuredClone(workflow) as Workflow;
  const legacyQualityIndex = next.stages.findIndex((stage) => stage.id === "quality_loop");
  const recoveryIndex = next.stages.findIndex((stage) => stage.id === "final_release_recovery_loop");
  const releaseIndex = next.stages.findIndex((stage) => stage.id === "final_validate");

  if (legacyQualityIndex < 0 || recoveryIndex < 0 || releaseIndex < 0) {
    throw new Error(
      "Auto Research v2 requires quality_loop, final_release_recovery_loop, and final_validate before production compilation",
    );
  }

  // The final-release loop already consumes deterministic gate findings and
  // dispatches only allowlisted repair capabilities. It is the correct single
  // improvement controller; the earlier whole-manuscript loop is redundant.
  next.stages.splice(legacyQualityIndex, 1);
  const recovery = next.stages.find((stage) => stage.id === "final_release_recovery_loop");
  if (!recovery || !Array.isArray(recovery.stages)) {
    throw new Error("Auto Research v2 improvement controller is malformed");
  }
  recovery.id = "improve";
  recovery.title = opts.offlineRehearsal
    ? "Rehearse targeted manuscript improvement"
    : "Targeted manuscript improvement from deterministic release findings";
  // Seed cannot satisfy live-source, length, or provenance release gates by
  // construction. It rehearses the identical controller and succeeds only
  // after its deterministic review fixture reaches the configured score.
  // Live workflows remain fail-closed on the actual publication gate.
  recovery.stop_when = opts.offlineRehearsal
    ? "review_score_raw_median >= 8"
    : "final_release_gate_pass >= 1";
  recovery.on_exhaustion = "fail";

  // IR v2 intentionally rejects in-place migration from the experimental
  // duplicated-loop topology. POC workspaces are regenerated from source.
  next.ir_version = 2;
  next.phase_catalog = [
    { id: "specify", title: "Specify", description: "Define scope, audience, and research strategy." },
    { id: "research", title: "Research", description: "Retrieve, screen, reconcile, and extract evidence." },
    { id: "synthesize", title: "Synthesize", description: "Build the taxonomy, outline, evidence allocation, and artifact plan." },
    { id: "write", title: "Write", description: "Draft and assemble the complete manuscript." },
    { id: "improve", title: "Improve", description: "Route measured quality findings to bounded targeted repairs." },
    { id: "release", title: "Release", description: "Validate publication gates and package passing artifacts." },
  ];

  const indexOf = (id: string): number => next.stages.findIndex((stage) => stage.id === id);
  const boundaries = {
    research: indexOf("recall"),
    synthesize: indexOf("outline"),
    write: indexOf("draft_sections"),
    improve: indexOf("verify_citations"),
    release: indexOf("final_validate"),
  };
  for (const [name, value] of Object.entries(boundaries)) {
    if (value < 0) throw new Error(`Auto Research v2 phase boundary is missing: ${name}`);
  }

  next.stages = next.stages.map((stage, position) =>
    withPhase(stage, phaseForTopLevel(String(stage.id), position, boundaries))
  );
  if (Array.isArray(next.tool_catalog)) {
    next.tool_catalog = (next.tool_catalog as StageRecord[]).map((action) => withPhase(action, "improve"));
  }
  return next;
}
