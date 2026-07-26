import { findNestedStage, longwriteCommand, type AgenticContext, type StageRecord, type Workflow } from "./base.js";
import { agentStage, foreachStage, loopStage, scriptStage } from "malaclaw/sdk";

/**
 * Repository evidence.
 *
 * Non-negotiable across this module: a pinned repository is *software*
 * evidence, never a substitute for scholarly literature; the Git revision is
 * immutable; and a merely mentioned repository stays an operator candidate
 * rather than becoming evidence. Every prompt below restates that boundary
 * because the boundary is enforced by the prompt, not by a downstream schema.
 */

/** Insert snapshot/analysis/comparison stages right after the search planner. */
export function insertCodebaseStages(next: Workflow, ctx: AgenticContext): void {
  const { policy, codebaseDiscoveryEnabled, paperProfile: selectedPaperProfile } = ctx;
  const searchPlanIndex = next.stages.findIndex((stage) => stage.id === "search_planner");
  if (searchPlanIndex < 0) throw new Error("auto_research_agentic requires search_planner before codebase preparation");
  const codebaseStages: StageRecord[] = [];
  if (codebaseDiscoveryEnabled) {
    codebaseStages.push(
      scriptStage({
        id: "github_codebase_recall",
        title: "Recall bounded GitHub codebase candidates",
        owner: "source-curator",
        inputs: ["sources/search-plan.json"],
        outputs: ["codebases/github-candidates.json"],
        validators: ["required_output_exists"], runtime: "script",
        command: longwriteCommand(["research", "github-codebase-recall", "."]),
      }),
      agentStage({
        id: "github_codebase_screen",
        title: "Screen GitHub candidates as software artifacts",
        owner: "analyst",
        inputs: ["codebases/github-candidates.json"],
        skills: ["codebases/github-candidates.json"],
        instructions: [
          "Read only codebases/github-candidates.json. Write ONLY codebases/github-selection.json as {version:1,selections:[{candidate_id,role,rationale}]}, where role is primary_artifact or supplementary_artifact.",
          "Select only repositories that materially support the paper's stated scope and taxonomy. Assess metadata, topics, and bounded README excerpts for relevance; do not infer implementation behavior, evaluation results, maintenance quality, or scientific validity from stars, forks, or a repository description.",
          selectedPaperProfile.requiresCodebase && (policy?.codebases?.length ?? 0) === 0
            ? "Select at least one and at most the configured maximum. This repository-study profile has no explicit codebase, so an empty selection is invalid. If no candidate is suitable, do not invent one: the run will stop with a repair report requiring a pinned research.codebases entry or a changed paper profile. A selected repository will later be pinned with Git and cited as software; it never substitutes for scholarly evidence."
            : "Select at most the configured maximum. Select no repository when none is relevant. A selected repository will later be pinned with Git and cited as software; it never substitutes for scholarly evidence.",
        ],
        outputs: ["codebases/github-selection.json", "reports/github-codebase-selection-repair.md"], validators: ["required_output_exists"],
        validator_commands: [longwriteCommand(["research", "repair-github-codebase-selection", "."])], retry: { max_attempts: 2 },
      }),
    );
  }
  codebaseStages.push(
    scriptStage({
      id: "codebase_prepare",
      title: "Snapshot configured codebase evidence",
      owner: "source-curator",
      inputs: ["project_brief.md", "sources/search-plan.json", ...(codebaseDiscoveryEnabled ? ["codebases/github-selection.json"] : [])],
      outputs: ["codebases/manifest.json", "codebases/mentioned-repositories.json", "evidence/codebase-chunks.jsonl", "evidence/codebase-context.md", "sources/codebases.bib"],
      validators: ["required_output_exists"],
      runtime: "script",
      command: longwriteCommand(["research", "codebases", "."]),
    }),
    agentStage({
      id: "codebase_architecture_analysis",
      title: "Analyze the pinned repository architecture",
      owner: "analyst",
      inputs: ["project_brief.md", "codebases/manifest.json", "evidence/codebase-context.md"],
      optional_inputs: ["evidence/codebase-chunks.jsonl"],
      skills: ["project_brief.md", "codebases/manifest.json", "evidence/codebase-context.md"],
      instructions: [
        "Read the pinned repository context as software evidence and write ONLY evidence/codebase-analysis.raw.json. Cover every codebase in codebases/manifest.json; do not execute code, infer benchmark results, or treat repository claims as independently validated scientific evidence.",
        "Schema: {version:1,codebases:[{codebase_id,summary,summary_locators,components:[{id,name,summary,locators}],entrypoints:[{id,name,summary,locators}],interfaces:[{from,to,relationship,summary,locators}],data_control_flows:[{summary,locators}],configuration_extension_points:[{id,name,summary,locators}],trust_boundaries:[{summary,locators}],operational_limitations:[{summary,locators}]}]}. All arrays are required; use [] when the bounded snapshot does not support that category. Include at least one component per codebase.",
        "Every summary, component, entrypoint, interface, flow, extension point, trust boundary, and limitation must cite one or more exact markers copied verbatim from evidence/codebase-context.md, for example `[codebase:repo:path/file.ts#L1-L40]`. A limitation must be an observed constraint in the supplied code/config/docs, not an argument from missing evidence. Preserve uncertainty and do not invent files, line ranges, components, relationships, or behavior.",
      ],
      outputs: ["evidence/codebase-analysis.raw.json", "evidence/codebase-analysis.json", "reports/codebase-analysis-repair.md"],
      validators: ["required_output_exists"],
      validator_commands: [longwriteCommand(["research", "repair-codebase-analysis", "."])],
      retry: { max_attempts: 2 },
    }),
    agentStage({
      id: "codebase_comparison_analysis",
      title: "Compare pinned repositories as software evidence",
      owner: "analyst",
      inputs: ["codebases/manifest.json", "evidence/codebase-analysis.json", "evidence/codebase-context.md"],
      optional_inputs: ["codebases/mentioned-repositories.json"],
      skills: ["codebases/manifest.json", "evidence/codebase-analysis.json", "evidence/codebase-context.md"],
      instructions: [
        "Write ONLY evidence/codebase-comparison.raw.json as {version:1,codebases:[{codebase_id,purpose,architecture_summary,license,extension_points,limitations,locators}],comparisons:[{dimension,codebase_ids,synthesis,locators}]}. Cover every pinned codebase exactly once. Use license:null when the pinned evidence does not establish a license.",
        "Every row must use exact locators copied from the validated architecture dossier/context. When two or more codebases are pinned, add at least one comparison that names all compared IDs and includes at least one exact locator from each. Compare purpose, component boundaries, interfaces, extension model, trust boundaries, or documented operational limitations—not stars, popularity, or inferred benchmark quality.",
        "codebases/mentioned-repositories.json is a bounded operator candidate list only. Do not treat an unpinned mentioned repository as evidence, add it to the comparison, recursively fetch it, or cite it.",
      ],
      outputs: ["evidence/codebase-comparison.raw.json", "evidence/codebase-comparison.json", "reports/codebase-comparison-repair.md"], validators: ["required_output_exists"],
      validator_commands: [longwriteCommand(["research", "repair-codebase-comparison", "."])], retry: { max_attempts: 2 },
    }),
  );
  next.stages.splice(searchPlanIndex + 1, 0, ...codebaseStages);
}

/**
 * Hand the validated architecture dossier to every stage that may make a
 * repository claim.
 *
 * Runs after the tool catalog is built so catalog actions are extended
 * explicitly rather than inheriting a half-mutated stage.
 */
export function applyCodebaseEvidence(next: Workflow, ctx: AgenticContext): void {
  const { paperProfile: selectedPaperProfile } = ctx;
  const codebaseInputs = ["codebases/manifest.json", "evidence/codebase-context.md", "evidence/codebase-analysis.json", "evidence/codebase-comparison.json"];
  const codebaseInstruction = "Configured repositories are pinned codebase evidence, not scholarly literature. Use evidence/codebase-analysis.json as the validated architecture dossier and inspect its exact file/line locators before making a repository claim. Cite `[codebase:<id>]` or `[codebase:<id>:path#Lx-Ly]`; never claim execution results unless a verified empirical result artifact is supplied.";
  const architectureReviewInstruction = "Evaluate whether the manuscript's architecture, entrypoint, interface, data/control-flow, configuration, trust-boundary, and limitation claims agree with evidence/codebase-analysis.json and its exact locators. Treat missing or contradictory repository grounding as a measurable evidence/structure defect; do not award credit for merely mentioning the repository.";
  const extendCodebaseEvidence = (stage: StageRecord, instructions: string[] = [codebaseInstruction]): void => {
    stage.optional_inputs = [...new Set([...((stage.optional_inputs as string[] | undefined) ?? []), ...codebaseInputs])];
    stage.skills = [...new Set([...((stage.skills as string[] | undefined) ?? []), ...codebaseInputs])];
    stage.instructions = [...((stage.instructions as string[] | undefined) ?? []), ...instructions];
  };
  const outline = next.stages.find((stage) => stage.id === "outline");
  if (outline) {
    extendCodebaseEvidence(outline, [codebaseInstruction, ...selectedPaperProfile.promptOverlays.outline]);
  }
  const draftSections = next.stages.find((stage) => stage.id === "draft_sections");
  if (draftSections && Array.isArray(draftSections.steps)) {
    draftSections.steps = draftSections.steps.map((raw) => {
      const step = raw as StageRecord;
      if (step.id !== "draft") return step;
      return {
        ...step,
        optional_inputs: [...new Set([...((step.optional_inputs as string[] | undefined) ?? []), ...codebaseInputs])],
        skills: [...new Set([...((step.skills as string[] | undefined) ?? []), ...codebaseInputs])],
        instructions: [...((step.instructions as string[] | undefined) ?? []), codebaseInstruction, ...selectedPaperProfile.promptOverlays.draft],
      };
    });
  }
  const visualPlan = next.stages.find((stage) => stage.id === "visual_plan");
  if (visualPlan) {
    extendCodebaseEvidence(visualPlan, [codebaseInstruction, ...selectedPaperProfile.promptOverlays.visual]);
  }
  for (const id of ["outline_review", "outline_revise"]) {
    const stage = findNestedStage(id, next.stages);
    if (stage) extendCodebaseEvidence(stage, [codebaseInstruction, architectureReviewInstruction]);
  }
  for (const id of ["initial_artifact_plan", "baseline_review", "artifact_plan", "action_plan", "review"]) {
    const stage = findNestedStage(id, next.stages);
    if (stage) extendCodebaseEvidence(stage, [codebaseInstruction, architectureReviewInstruction]);
  }
  for (const id of ["reopen_outline", "revise_sections", "revise_visual_plan"]) {
    const stage = (next.tool_catalog as StageRecord[] | undefined)?.find((candidate) => candidate.id === id);
    if (stage) extendCodebaseEvidence(stage, [codebaseInstruction, architectureReviewInstruction]);
  }
}
