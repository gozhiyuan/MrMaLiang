import { longwriteCommand, type AgenticContext, type StageRecord, type Workflow } from "./base.js";
import { agentStage, foreachStage, loopStage, scriptStage } from "malaclaw/sdk";

/**
 * Empirical handoff into the manuscript.
 *
 * LongWrite never runs an experiment and never owns the manifest schema — that
 * stays in `@mr-maliang/research-protocol`. What it owns is the boundary: no
 * empirical claim may reach prose except through a verified packet, so the
 * verification stage is script-owned and lands *before* the outline.
 */

/** Verify the audited bundle before any writer or reviewer can see it. */
export function insertExperimentEvidenceStage(next: Workflow, ctx: AgenticContext): void {
  const { policy, hasCodebases } = ctx;
  const outlineIndex = next.stages.findIndex((stage) => stage.id === "outline");
  if (outlineIndex < 0) throw new Error("empirical LongWrite mode requires an outline stage");
  next.stages.splice(outlineIndex, 0, scriptStage({
    id: "experiment_evidence_prepare", title: "Verify audited experiment evidence", owner: "result-auditor",
    inputs: [policy!.experiment!.manifestPath!, "experiments/artifact-bundle.json"],
    optional_inputs: hasCodebases ? ["codebases/manifest.json"] : [],
    outputs: ["experiments/verification.json", "evidence/experiment-packets.json"], validators: ["required_output_exists"], runtime: "script",
    command: longwriteCommand(["research", "prepare-experiment", "."]),
    instructions: ["Verify the full LongExperiment result contract, trial records, result and imported-artifact checksums, and any configured repository revision binding before exposing empirical evidence to writers or reviewers."],
  }));
}

/**
 * Supply the verified packet to every stage that may state an empirical result.
 *
 * Script stages inside the quality loop are skipped deliberately: they already
 * read the packet from disk, and rewriting their prompts would be inert.
 */
export function applyExperimentEvidence(next: Workflow): void {
  const experimentInputs = ["evidence/experiment-packets.json", "experiments/verification.json"];
  const experimentInstruction = "The supplied experiment packet is the only empirical-result evidence. Tie an empirical claim to its named comparison, metric, paired seeds, confidence interval, and checksummed artifact. Do not infer results from repository code, runner logs, screenshots, or uncited prose. If the packet lacks support, state the limitation rather than inventing an outcome.";
  const extend = (stage: StageRecord): StageRecord => ({
    ...stage,
    optional_inputs: [...new Set([...((stage.optional_inputs as string[] | undefined) ?? []), ...experimentInputs])],
    skills: [...new Set([...((stage.skills as string[] | undefined) ?? []), ...experimentInputs])],
    instructions: [...((stage.instructions as string[] | undefined) ?? []), experimentInstruction],
  });
  for (const id of ["outline", "visual_plan", "baseline_review"]) {
    const stage = next.stages.find((candidate) => candidate.id === id);
    if (stage) Object.assign(stage, extend(stage));
  }
  const draftSections = next.stages.find((stage) => stage.id === "draft_sections");
  if (draftSections && Array.isArray(draftSections.steps)) {
    draftSections.steps = draftSections.steps.map((raw) => {
      const step = raw as StageRecord;
      return step.id === "draft" ? extend(step) : step;
    });
  }
  // Review/revision children live inside the quality loop. Supply the same
  // bounded packet to their LLM stages so empirical validity is judged from
  // audited evidence, not from a manifest boolean.
  const loop = next.stages.find((stage) => stage.id === "quality_loop");
  if (loop && Array.isArray(loop.stages)) {
    loop.stages = loop.stages.map((raw) => {
      const stage = raw as StageRecord;
      return stage.runtime === "script" ? stage : extend(stage);
    });
  }
}
