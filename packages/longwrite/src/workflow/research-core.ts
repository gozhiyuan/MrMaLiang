import type { LongWriteModeDef } from "../lib/mode-schema.js";
import type { ResearchProviderId } from "../lib/research/providers.js";
import {
  assessResearchCommand,
  buildResearchCommand,
  buildVisualReviewCommand,
  draftSectionCommand,
  isResearchMode,
  longwriteCommand,
  packagePublicationCommand,
  reviewRouteCommand,
  validateFiguresCommand,
  validateLatexCommand,
  validateResearchCommand,
  validateVisualReviewCommand,
  withScorecardContract,
  type CompileResearchPolicy,
  type StageRecord,
  type Workflow,
} from "./base.js";

/**
 * The deterministic research skeleton.
 *
 * Retrieval, provenance, scoring, claim checks, build and release validation
 * are script-owned contracts: each stage owns exactly its own artifacts and is
 * idempotent. Prose and judgment stay on the LLM worker runtime. Nothing here
 * depends on the agentic dispatcher — this is the layer that still compiles
 * when every adaptive feature is switched off.
 */
export function withResearchScriptStages(
  mode: LongWriteModeDef,
  topic?: string,
  provider: ResearchProviderId = "seed",
  policy?: CompileResearchPolicy,
): Workflow {
  const workflow = structuredClone(mode.workflow) as Workflow;
  if (!topic || !isResearchMode(mode)) return workflow;

  const mapStage = (stage: StageRecord, insideLoop = false): StageRecord => {
    if (String(stage.type) === "loop" && Array.isArray(stage.stages)) {
      return {
        ...stage,
        stages: stage.stages.map((child) => mapStage(child as StageRecord, true)),
      };
    }
    // Each research stage owns exactly its own artifacts (idempotent):
    // recall queries providers; score reads deduped; classify reads scored.
    if (String(stage.id) === "search_planner") {
      return {
        ...stage,
        validator_commands: [
          ...((stage.validator_commands as Array<Record<string, unknown>> | undefined) ?? []),
          longwriteCommand(["validate", "search-plan", "."]),
        ],
      };
    }
    if (String(stage.id) === "recall") {
      return {
        ...stage,
        runtime: "script",
        command: longwriteCommand([
          "research", "recall", ".", "--topic", topic, "--provider", provider,
          "--target-candidates", String(policy?.targetCandidates ?? 240),
          "--query-budget", String(policy?.queryBudget ?? 30),
        ]),
      };
    }
    if (String(stage.id) === "snowball_recall") {
      return { ...stage, runtime: "script", command: longwriteCommand(["research", "snowball", "."]) };
    }
    if (String(stage.id) === "venue_upgrade") {
      return { ...stage, runtime: "script", command: longwriteCommand(["research", "venue-upgrade", "."]) };
    }
    if (String(stage.id) === "structure_audit") {
      return { ...stage, runtime: "script", command: longwriteCommand(["review", "structure", "."]) };
    }
    if (String(stage.id) === "survey_contract") {
      return { ...stage, runtime: "script", command: longwriteCommand(["research", "survey-contract", "."]) };
    }
    if (String(stage.id) === "fulltext") {
      return {
        ...stage,
        runtime: "script",
        command: longwriteCommand([
          "research", "fulltext", ".",
          "--max-sources", String(policy?.fulltextMaxSources ?? 40),
          ...(policy?.allowPdfDownload === false ? ["--no-pdf-download"] : []),
        ]),
      };
    }
    if (String(stage.id) === "evidence_index") {
      return { ...stage, runtime: "script", command: longwriteCommand(["evidence", "index", "."]) };
    }
    if (String(stage.id) === "allocate_evidence") {
      return { ...stage, runtime: "script", command: longwriteCommand(["evidence", "allocate", "."]) };
    }
    if (String(stage.id) === "score") {
      return { ...stage, runtime: "script", command: longwriteCommand(["research", "score", "."]) };
    }
    if (String(stage.id) === "enrich") {
      return {
        ...stage,
        runtime: "script",
        command: longwriteCommand(["research", "enrich", ".", "--max-sources", "20", ...(provider === "seed" ? ["--disabled"] : [])]),
      };
    }
    if (String(stage.id) === "classify") {
      return {
        ...stage,
        runtime: "script",
        command: longwriteCommand(["research", "classify", ".", "--topic", topic]),
      };
    }
    if (String(stage.id) === "identity_reconcile") {
      return { ...stage, runtime: "script", command: longwriteCommand(["research", "reconcile-identities", "."]) };
    }
    if (String(stage.id) === "corpus_gates") {
      return { ...stage, runtime: "script", command: longwriteCommand(["research", "corpus-gates", "."]) };
    }
    if (String(stage.id) === "draft_sections" && Array.isArray(stage.steps)) {
      return {
        ...stage,
        steps: stage.steps.map((step) => String((step as { id?: unknown }).id) === "draft" && policy?.writingStrategy !== "llm_sections"
          ? { ...(step as StageRecord), runtime: "script", command: draftSectionCommand() }
          : step),
      };
    }
    if (["citation_ledger", "consolidate_citations"].includes(String(stage.id))) {
      return { ...stage, runtime: "script", command: longwriteCommand(["evidence", "consolidate", "."]) };
    }
    if (String(stage.id) === "evidence_audit") {
      return { ...stage, runtime: "script", command: longwriteCommand(["evidence", "audit", "."]) };
    }
    if (String(stage.id) === "verify_citations") {
      return {
        ...stage,
        runtime: "script",
        command: longwriteCommand(["research", "verify", ".", "--max-sources", String(policy?.verificationMaxSources ?? 30)]),
      };
    }
    if (["baseline_review", "review"].includes(String(stage.id))) {
      return withScorecardContract(stage);
    }
    if (String(stage.id) === "route") {
      return {
        ...stage,
        runtime: "script",
        command: reviewRouteCommand(),
      };
    }
    if (String(stage.id) === "claim_score") {
      return {
        ...stage,
        runtime: "script",
        command: longwriteCommand(["review", "claims", "."]),
      };
    }
    if (String(stage.id) === "claim_judge") {
      return {
        ...stage,
        validator_commands: [
          ...((stage.validator_commands as Array<Record<string, unknown>> | undefined) ?? []),
          longwriteCommand(["review", "repair-claims", "."]),
        ],
      };
    }
    if (String(stage.id) === "expand_research") {
      return {
        ...stage,
        runtime: "script",
        command: longwriteCommand(["research", "expand", "."]),
      };
    }
    if (["build", "initial_build", "rebuild"].includes(String(stage.id))) {
      return {
        ...stage,
        runtime: "script",
        command: buildResearchCommand(),
        validator_commands: [
          ...((stage.validator_commands as Array<Record<string, unknown>> | undefined) ?? []),
          // A loop rebuild is an intermediate artifact. Its citation ledger is
          // current, but URL verification intentionally occurs after the loop.
          // Full research validation therefore belongs to final_validate.
          ...(insideLoop || String(stage.id) === "initial_build" ? [] : [validateResearchCommand()]),
          validateFiguresCommand(),
          validateLatexCommand(),
        ],
      };
    }
    if (String(stage.id) === "render_visual_review") {
      return { ...stage, runtime: "script", command: buildVisualReviewCommand() };
    }
    if (String(stage.id) === "visual_review") {
      return {
        ...stage,
        validator_commands: [
          ...((stage.validator_commands as Array<Record<string, unknown>> | undefined) ?? []),
          validateVisualReviewCommand(),
        ],
      };
    }
    if (String(stage.id) === "assess") {
      return {
        ...stage,
        runtime: "script",
        command: assessResearchCommand(),
      };
    }
    if (String(stage.id) === "final_validate") {
      return {
        ...stage,
        runtime: "script",
        command: validateResearchCommand(),
      };
    }
    if (String(stage.id) === "package_submission") {
      return {
        ...stage,
        runtime: "script",
        command: packagePublicationCommand(),
      };
    }
    return stage;
  };
  workflow.stages = workflow.stages.map((stage) => mapStage(stage));
  return workflow;
}
