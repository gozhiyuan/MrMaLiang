import type { LongWriteModeDef } from "../lib/mode-schema.js";
import {
  draftNovelCommand,
  draftTechnicalBookCommand,
  validateNovelCommand,
  validateTechnicalBookCommand,
  withScorecardContract,
  type StageRecord,
  type Workflow,
} from "./base.js";

/** Long-form stages that SHOULD be deterministic: assembly and extraction,
 *  never prose. Everything else runs on the LLM worker runtime — MalaClaw's
 *  script runtime is for tooling, not creative writing. */
const LONGFORM_SCRIPT_STAGES: Record<string, Set<string>> = {
  novel: new Set(["build"]),
  technical_book: new Set(["build_examples", "export"]),
};

/**
 * The non-research drafting path (novel, technical book).
 *
 * This mode never reaches the agentic dispatcher: there is no evidence corpus
 * to expand and no release gate to recover, so the whole compile is this one
 * transform plus the shared runtime-profile and override passes.
 */
export function withLongformStages(mode: LongWriteModeDef): Workflow {
  const workflow = structuredClone(mode.workflow) as Workflow;
  const draftCommand = mode.id === "novel"
    ? draftNovelCommand()
    : mode.id === "technical_book"
      ? draftTechnicalBookCommand()
      : null;
  if (!draftCommand) return workflow;

  const finalValidator = mode.id === "novel" ? validateNovelCommand() : validateTechnicalBookCommand();
  const scriptStages = LONGFORM_SCRIPT_STAGES[mode.id];

  const mapStage = (stage: StageRecord): StageRecord => {
    if (String(stage.type) === "loop" && Array.isArray(stage.stages)) {
      return {
        ...stage,
        stages: stage.stages.map((child) => mapStage(child as StageRecord)),
      };
    }
    // Dispatch is engine-owned: a runtime/model tier belongs to the selected
    // catalog action, never to the non-executable dispatcher itself.
    if (String(stage.type) === "action_dispatch") return stage;
    // Foreach drafting/continuity steps are creative: LLM runtime.
    if (Array.isArray(stage.steps)) return stage;

    if (scriptStages.has(String(stage.id))) {
      // Deterministic assembly/extraction only. The full-workspace validator
      // does NOT run here: these stages execute before the quality loop, and
      // the validator requires the loop's feedback/revision artifacts.
      return { ...stage, runtime: "script", command: draftCommand };
    }
    // Loop review/revise stages get the deterministic scoring contract; the
    // reviser additionally re-runs the structural validators.
    if (String(stage.id) === "feedback_review") {
      return withScorecardContract(stage);
    }
    if (String(stage.id) === "revise") {
      const scored = withScorecardContract(stage);
      return {
        ...scored,
        validator_commands: [
          ...(scored.validator_commands as Array<Record<string, unknown>>),
          finalValidator,
        ],
      };
    }
    // Everything else (premise, bibles, outlines, reviews, edits) is
    // creative work for the LLM worker runtime.
    return stage;
  };
  workflow.stages = workflow.stages.map(mapStage);
  return workflow;
}
