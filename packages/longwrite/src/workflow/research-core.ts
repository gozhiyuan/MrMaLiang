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
    if (String(stage.id) === "landmark_scout") {
      return {
        ...stage,
        instructions: [
          ...((stage.instructions as string[] | undefined) ?? []),
          `The release-gated canonical set is paper-scale: output at most ${policy?.maxLandmarkCandidates ?? 20} candidates, ordered by genuine canonical importance. Reserve high confidence for works that this exact paper would be academically deficient not to discuss; adjacent examples and general benchmarks are medium or low rather than automatically high.`,
        ],
        validator_commands: [
          ...((stage.validator_commands as Array<Record<string, unknown>> | undefined) ?? []),
          longwriteCommand(["validate", "landmarks", "."]),
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
      const envelope = [
        "sources/deduped_sources.jsonl", "sources/venue-upgrades.jsonl", "reports/venue-upgrade.md",
        // The enrichment pass this command reuses writes its own two artifacts
        // and then copies them to the venue-named ones. Nothing downstream
        // requires them, so they are part of the ENVELOPE rather than of the
        // outputs a validator enforces — but they are written, and isolation
        // caught them the moment this stage stopped running straight in the
        // canonical workspace.
        "sources/metadata-upgrades.jsonl", "reports/metadata-enrichment.md",
      ];
      return {
        ...stage, runtime: "script", command: longwriteCommand(["research", "venue-upgrade", "."]),
        kind: "mutation", owns: envelope, writes: envelope,
        corrective_capability: "operator",
        reads: [...new Set([
          ...((stage.reads as string[] | undefined) ?? []),
          ...((stage.inputs as string[] | undefined) ?? []),
          "sources/deduped_sources.jsonl", "longwrite.yaml",
        ])].sort(),
      };
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
        // A captionless intermediate PDF has no fresh visual input. The
        // renderer records this as a repairable release failure; skipping the
        // multimodal worker avoids reviewing stale PNGs and pointless retries.
        when: "visual_reviewable_pages >= 1",
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

  // The target ledger has to be POPULATED before any selector reserves against
  // it. `research reconcile-targets` existed and no stage ran it, so in a real
  // run the ledger was empty: every selector reserved nothing, found nothing
  // eligible, and ranked whatever it happened to see — which is precisely the
  // displacement reserve-before-rank exists to prevent. It runs immediately
  // after identity reconciliation, the last point at which the corpus is
  // settled and before the first selector (`fulltext`) reads it.
  const anchor = workflow.stages.findIndex((stage) => String(stage.id) === "identity_reconcile");
  if (anchor >= 0 && !workflow.stages.some((stage) => String(stage.id) === "reconcile_targets")) {
    workflow.stages.splice(anchor + 1, 0, {
      id: "reconcile_targets",
      title: "Reserve landmark targets and publish what is still unretrieved",
      owner: "source-curator",
      phase: String((workflow.stages[anchor] as StageRecord).phase ?? "research"),
      // Optional, deliberately: a mode with no landmark contract has no
      // candidates file, and the ledger is then empty rather than the stage
      // being a failure.
      optional_inputs: ["research/landmark-candidates.json", "sources/classified_sources.jsonl"],
      outputs: ["research/target-ledger.json", "research/retrieval-brief.json"],
      validators: ["required_output_exists"],
      runtime: "script",
      command: longwriteCommand(["research", "reconcile-targets", "."]),
    } as StageRecord);
  }
  return workflow;
}
