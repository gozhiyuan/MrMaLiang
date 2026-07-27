import path from "node:path";
import { packageRoot } from "../lib/paths.js";
import type { LongWriteModeDef } from "../lib/mode-schema.js";
import type { ResearchProviderId } from "../lib/research/providers.js";
import type { ResearchWorkflowProfile } from "../lib/research/workflow-profiles.js";
import { paperProfile, type PaperProfile, type PaperProfileId } from "../lib/paper-profiles.js";
import type { CodebaseConfig } from "../lib/research/codebase-contract.js";
import type { RuntimeProfileDef } from "../lib/runtime-profiles.js";

/**
 * MM-2.1 shared compiler vocabulary.
 *
 * Every workflow module composes plain manifest records. There is deliberately
 * no stage class or builder object here: the emitted IR is the contract, and a
 * richer intermediate representation would make byte-identical output harder to
 * prove rather than easier.
 */

/** A single compiled stage/step/action record. */
export type StageRecord = Record<string, unknown>;

/** A workflow block with its ordered stage list. */
export type Workflow = { stages: StageRecord[] } & Record<string, unknown>;

export type CompileRunLimits = {
  max_recorded_tokens?: number;
  max_unit_minutes?: number;
  max_active_run_minutes?: number;
  on_limit?: "pause";
};

export type CompileStageOverride = {
  runtime?: string;
  model?: string;
  model_tier?: string;
  enabled?: boolean;
  requires_human_approval?: boolean;
  max_parallel?: number;
};

export type CompileResearchPolicy = {
  workflowProfile?: ResearchWorkflowProfile;
  targetCandidates: number;
  queryBudget: number;
  taxonomy: string[];
  paperProfile?: PaperProfileId;
  codebases?: CodebaseConfig[];
  codebaseDiscovery?: { enabled: boolean; queryBudget: number; maxCandidates: number; maxReadmeFetches: number; maxSelected: number; requireLicense: boolean; includeArchived: boolean; languages: string[] };
  fulltextMaxSources: number;
  allowPdfDownload: boolean;
  semanticScreenEnabled?: boolean;
  outlineReviewEnabled?: boolean;
  outlineReviewMaxRounds?: number;
  outlineApprovalMode?: "auto" | "human";
  verificationMaxSources: number;
  writingStrategy: "scaffold_then_revise" | "llm_sections";
  experiment?: { enabled: boolean; manifestPath?: string; codebaseId?: string; inputId?: string };
};

export type CompileOptions = {
  projectId: string;
  projectName?: string;
  topic?: string;
  researchProvider?: ResearchProviderId;
  runtimeProfile?: RuntimeProfileDef;
  runLimits?: CompileRunLimits;
  stageOverrides?: Record<string, CompileStageOverride>;
  researchPolicy?: CompileResearchPolicy;
};

export function longwriteCommand(args: string[]): { cmd: string; args: string[] } {
  return {
    cmd: process.execPath,
    args: [path.join(packageRoot(), "dist", "cli.js"), ...args],
  };
}

export function draftSectionCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["draft", "section", "."]);
}

export function draftNovelCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["draft", "novel", "."]);
}

export function draftTechnicalBookCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["draft", "technical-book", "."]);
}

export function validateResearchCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["validate", "research", "."]);
}

export function validateResearchAdvisoryCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["validate", "research", ".", "--advisory"]);
}

export function isResearchMode(mode: LongWriteModeDef): boolean {
  return mode.artifact_type === "research_paper";
}

export function validateNovelCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["validate", "novel", "."]);
}

export function validateTechnicalBookCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["validate", "technical-book", "."]);
}

export function validateLatexCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["validate", "latex", "."]);
}

export function validateFiguresCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["validate", "figures", "."]);
}

export function validateVisualReviewCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["validate", "visual-review", "."]);
}

export function validateScorecardCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["validate", "scorecard", "."]);
}

export function reviewScoreCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["review", "score", "."]);
}

export function reviewRouteCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["review", "route", "."]);
}

export function buildResearchCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["build", "research", "."]);
}

export function buildVisualReviewCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["build", "visual-review", "."]);
}

export function assessResearchCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["research", "assess", "."]);
}

export function packagePublicationCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["publication", "package", "."]);
}

/** Attach the deterministic scoring pipeline to a completed-manuscript review:
 *  worker must produce reviews/scorecard.json (validated fail-closed), and
 *  `longwrite review score` computes the official review_score into
 *  reports/metrics.json — overwriting anything the worker self-reported, so
 *  stop_when compares against the toolchain's number, not the model's. */
export function withScorecardContract(stage: StageRecord): StageRecord {
  const outputs = (stage.outputs as string[] | undefined) ?? [];
  return {
    ...stage,
    outputs: outputs.includes("reviews/scorecard.json") ? outputs : [...outputs, "reviews/scorecard.json"],
    validator_commands: [
      ...((stage.validator_commands as Array<Record<string, unknown>> | undefined) ?? []),
      validateScorecardCommand(),
      reviewScoreCommand(),
    ],
  };
}

export function isScriptOwned(unit: StageRecord): boolean {
  return unit.runtime === "script" || typeof unit.command === "object";
}

/** Depth-first lookup through nested loop groups. */
export function findNestedStage(id: string, stages: StageRecord[]): StageRecord | undefined {
  for (const stage of stages) {
    if (stage.id === id) return stage;
    if (Array.isArray(stage.stages)) {
      const found = findNestedStage(id, stage.stages as StageRecord[]);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Derived facts every agentic workflow module needs.
 *
 * These predicates are computed once and shared so the modules cannot drift
 * apart: the pre-draft artifact planner, the evidence refresh block, and the
 * final-release recovery loop must all agree on whether the semantic bridge is
 * live, or the compiled graph references artifacts that no stage produces.
 */
export type AgenticContext = {
  policy: CompileResearchPolicy | undefined;
  provider: ResearchProviderId;
  paperProfile: PaperProfile;
  architectureSourceRequirement: string;
  codebaseDiscoveryEnabled: boolean;
  hasCodebases: boolean;
  hasExperiment: boolean;
  /** Semantic screening only compiles on a live provider; seed is an offline
   *  metadata fixture and cannot satisfy a full-text contract. */
  semanticBridgeEnabled: boolean;
  outlineReviewEnabled: boolean;
};

export function agenticContext(policy: CompileResearchPolicy | undefined, provider: ResearchProviderId): AgenticContext {
  const selectedPaperProfile = paperProfile(policy?.paperProfile);
  const architectureSourceRequirement = selectedPaperProfile.architectureDiagram.requiresPinnedCodebaseSource
    ? "An architecture_diagram requires a target section and at least one pinned `codebase:<id>` source from codebases/manifest.json."
    : `An architecture_diagram requires a target section and at least ${selectedPaperProfile.architectureDiagram.minSources} classified scholarly source IDs.`;
  const codebaseDiscoveryEnabled = policy?.codebaseDiscovery?.enabled === true;
  const semanticBridgeEnabled = Boolean(policy?.semanticScreenEnabled) && provider !== "seed";
  return {
    policy,
    provider,
    paperProfile: selectedPaperProfile,
    architectureSourceRequirement,
    codebaseDiscoveryEnabled,
    hasCodebases: (policy?.codebases?.length ?? 0) > 0 || codebaseDiscoveryEnabled,
    // A newly scaffolded empirical workspace deliberately has no manifest yet.
    // It remains scaffoldable; sync after importing the audited bundle enables
    // the evidence stage and its downstream packet injection.
    hasExperiment: policy?.experiment?.enabled === true && Boolean(policy.experiment.manifestPath),
    semanticBridgeEnabled,
    outlineReviewEnabled: Boolean(policy?.outlineReviewEnabled) && semanticBridgeEnabled,
  };
}
