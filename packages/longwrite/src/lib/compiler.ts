import { stringify as stringifyYaml } from "yaml";
import path from "node:path";
import type { LongWriteModeDef } from "./mode-schema.js";
import { packageRoot } from "./paths.js";
import type { ResearchProviderId } from "./research/providers.js";
import type { RuntimeProfileDef } from "./runtime-profiles.js";
import { researchWorkflowProfileDef, type ResearchWorkflowProfile } from "./research/workflow-profiles.js";
import { paperProfile, type PaperProfileId } from "./paper-profiles.js";
import type { CodebaseConfig } from "./research/codebase-contract.js";

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

function longwriteCommand(args: string[]): { cmd: string; args: string[] } {
  return {
    cmd: process.execPath,
    args: [path.join(packageRoot(), "dist", "cli.js"), ...args],
  };
}

function draftSectionCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["draft", "section", "."]);
}

function draftNovelCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["draft", "novel", "."]);
}

function draftTechnicalBookCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["draft", "technical-book", "."]);
}

function validateResearchCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["validate", "research", "."]);
}

function validateResearchAdvisoryCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["validate", "research", ".", "--advisory"]);
}

function isResearchMode(mode: LongWriteModeDef): boolean {
  return mode.artifact_type === "research_paper";
}


function validateNovelCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["validate", "novel", "."]);
}

function validateTechnicalBookCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["validate", "technical-book", "."]);
}

function validateLatexCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["validate", "latex", "."]);
}

function validateFiguresCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["validate", "figures", "."]);
}

function validateVisualReviewCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["validate", "visual-review", "."]);
}

function validateScorecardCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["validate", "scorecard", "."]);
}

function reviewScoreCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["review", "score", "."]);
}

function reviewRouteCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["review", "route", "."]);
}

function buildResearchCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["build", "research", "."]);
}

function buildVisualReviewCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["build", "visual-review", "."]);
}

function assessResearchCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["research", "assess", "."]);
}

function packagePublicationCommand(): { cmd: string; args: string[] } {
  return longwriteCommand(["publication", "package", "."]);
}

/** Attach the deterministic scoring pipeline to a completed-manuscript review:
 *  worker must produce reviews/scorecard.json (validated fail-closed), and
 *  `longwrite review score` computes the official review_score into
 *  reports/metrics.json — overwriting anything the worker self-reported, so
 *  stop_when compares against the toolchain's number, not the model's. */
function withScorecardContract(stage: Record<string, unknown>): Record<string, unknown> {
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

function withResearchScriptStages(
  mode: LongWriteModeDef,
  topic?: string,
  provider: ResearchProviderId = "seed",
  policy?: CompileResearchPolicy,
): Record<string, unknown> {
  const workflow = structuredClone(mode.workflow) as { stages: Array<Record<string, unknown>> };
  if (!topic || !isResearchMode(mode)) return workflow;

  const mapStage = (stage: Record<string, unknown>, insideLoop = false): Record<string, unknown> => {
    if (String(stage.type) === "loop" && Array.isArray(stage.stages)) {
      return {
        ...stage,
        stages: stage.stages.map((child) => mapStage(child as Record<string, unknown>, true)),
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
          ? { ...(step as Record<string, unknown>), runtime: "script", command: draftSectionCommand() }
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

/** Convert only the remediation segment of the base research skeleton into an
 * adaptive dispatcher. Retrieval, provenance, scoring, claim checks, build,
 * and release validation remain explicit deterministic contracts. */
function withAgenticResearchStages(workflow: Record<string, unknown>, policy?: CompileResearchPolicy, provider: ResearchProviderId = "seed"): Record<string, unknown> {
  const next = structuredClone(workflow) as { stages: Array<Record<string, unknown>> } & Record<string, unknown>;
  const selectedPaperProfile = paperProfile(policy?.paperProfile);
  const architectureSourceRequirement = selectedPaperProfile.architectureDiagram.requiresPinnedCodebaseSource
    ? "An architecture_diagram requires a target section and at least one pinned `codebase:<id>` source from codebases/manifest.json."
    : `An architecture_diagram requires a target section and at least ${selectedPaperProfile.architectureDiagram.minSources} classified scholarly source IDs.`;
  const codebaseDiscoveryEnabled = policy?.codebaseDiscovery?.enabled === true;
  const hasCodebases = (policy?.codebases?.length ?? 0) > 0 || codebaseDiscoveryEnabled;
  // A newly scaffolded empirical workspace deliberately has no manifest yet.
  // It remains scaffoldable; sync after importing the audited bundle enables
  // the evidence stage and its downstream packet injection.
  const hasExperiment = policy?.experiment?.enabled === true && Boolean(policy.experiment.manifestPath);
  if (hasCodebases) {
    const searchPlanIndex = next.stages.findIndex((stage) => stage.id === "search_planner");
    if (searchPlanIndex < 0) throw new Error("auto_research_agentic requires search_planner before codebase preparation");
    const codebaseStages: Array<Record<string, unknown>> = [];
    if (codebaseDiscoveryEnabled) {
      codebaseStages.push(
        {
          id: "github_codebase_recall",
          title: "Recall bounded GitHub codebase candidates",
          owner: "source-curator",
          inputs: ["sources/search-plan.json"],
          outputs: ["codebases/github-candidates.json"],
          validators: ["required_output_exists"], runtime: "script",
          command: longwriteCommand(["research", "github-codebase-recall", "."]),
        },
        {
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
        },
      );
    }
    codebaseStages.push(
      {
        id: "codebase_prepare",
        title: "Snapshot configured codebase evidence",
        owner: "source-curator",
        inputs: ["project_brief.md", "sources/search-plan.json", ...(codebaseDiscoveryEnabled ? ["codebases/github-selection.json"] : [])],
        outputs: ["codebases/manifest.json", "codebases/mentioned-repositories.json", "evidence/codebase-chunks.jsonl", "evidence/codebase-context.md", "sources/codebases.bib"],
        validators: ["required_output_exists"],
        runtime: "script",
        command: longwriteCommand(["research", "codebases", "."]),
      },
      {
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
      },
      {
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
      },
    );
    next.stages.splice(searchPlanIndex + 1, 0, ...codebaseStages);
  }
  if (hasExperiment) {
    const outlineIndex = next.stages.findIndex((stage) => stage.id === "outline");
    if (outlineIndex < 0) throw new Error("empirical LongWrite mode requires an outline stage");
    next.stages.splice(outlineIndex, 0, {
      id: "experiment_evidence_prepare", title: "Verify audited experiment evidence", owner: "result-auditor",
      inputs: [policy.experiment!.manifestPath!, "experiments/artifact-bundle.json"],
      optional_inputs: hasCodebases ? ["codebases/manifest.json"] : [],
      outputs: ["experiments/verification.json", "evidence/experiment-packets.json"], validators: ["required_output_exists"], runtime: "script",
      command: longwriteCommand(["research", "prepare-experiment", "."]),
      instructions: ["Verify the full LongExperiment result contract, trial records, result and imported-artifact checksums, and any configured repository revision binding before exposing empirical evidence to writers or reviewers."],
    });
  }
  // New workspaces opt in through longwrite.yaml. Existing alpha workspaces
  // keep their prior semantics until the operator explicitly enables it.
  // Seed is an offline metadata fixture, not a paper corpus. Do not pretend
  // it can satisfy a full-text semantic contract during a free dry run.
  if (policy?.semanticScreenEnabled && provider !== "seed") {
    const classifyIndex = next.stages.findIndex((stage) => stage.id === "classify");
    const evidenceIndex = next.stages.findIndex((stage) => stage.id === "evidence_index");
    if (classifyIndex < 0 || evidenceIndex < 0) throw new Error("auto_research_agentic requires classify and evidence_index stages for semantic screening");
    const semanticStages: Array<Record<string, unknown>> = [
      {
        id: "semantic_candidate_select",
        title: "Select bounded abstract-screening candidates",
        owner: "analyst",
        inputs: ["sources/classified_sources.jsonl", "sources/search-plan.json"],
        outputs: ["sources/semantic-screening-candidates.json", "sources/metadata-classified_sources.jsonl"],
        validators: ["required_output_exists"], runtime: "script",
        command: longwriteCommand(["research", "select-semantic-candidates", "."]),
      },
      {
        id: "semantic_screen",
        title: "Screen bounded candidates from titles and abstracts",
        owner: "analyst",
        inputs: ["sources/semantic-screening-candidates.json"],
        skills: ["sources/semantic-screening-candidates.json"],
        instructions: [
          "Read only the bounded candidate metadata in sources/semantic-screening-candidates.json. Write ONLY sources/semantic-screening.json as {version:1,screenings:[{source_id,taxonomy_cells,chapter_role,semantic_relevance,rationale,recommended_depth,fulltext_priority}]}.",
          "This is abstract-level semantic triage, not a claim-evidence judgment. Assess every candidate; source_id and taxonomy_cells must come from the supplied artifact/configuration. Do not invent findings, quotes, pages, venues, acceptance status, or source IDs.",
          "Use these exact enums: chapter_role is protagonist, comparison, background, or exclude; semantic_relevance is high, medium, or low; recommended_depth is A, B, C, or D (use D—not none—for excluded material); fulltext_priority is the JSON boolean true or false (never high, medium, low, null, or a string). An excluded source must set fulltext_priority false. Use A/B only when the abstract indicates a central/comparative role; final A/B still requires validated full-text evidence.",
        ],
        outputs: ["sources/semantic-screening.json", "reports/semantic-screen-repair.md"], validators: ["required_output_exists"],
        validator_commands: [longwriteCommand(["research", "repair-semantic-screen", "."])],
        retry: { max_attempts: 2 },
      },
    ];
    next.stages.splice(classifyIndex + 1, 0, ...semanticStages);
    // Core-source count is meaningful only after provisional metadata A/B has
    // been reconciled with the evidence packet contract. Keep all broad
    // retrieval stages ahead of screening, but measure corpus gates on the
    // final classification that the manuscript will actually use.
    const corpusGateIndex = next.stages.findIndex((stage) => stage.id === "corpus_gates");
    const corpusGate = corpusGateIndex >= 0 ? next.stages.splice(corpusGateIndex, 1)[0] : undefined;
    const refreshedEvidenceIndex = next.stages.findIndex((stage) => stage.id === "evidence_index");
    next.stages.splice(refreshedEvidenceIndex + 1, 0,
      {
        id: "source_evidence_candidate_select",
        title: "Select approved full-text sources for claim extraction",
        owner: "source-curator", inputs: ["sources/semantic-screening.json", "fulltext/manifest.json", "sources/classified_sources.jsonl"],
        outputs: ["sources/source-evidence-candidates.json"], validators: ["required_output_exists"], runtime: "script",
        command: longwriteCommand(["research", "select-source-evidence-candidates", "."]),
      },
      {
        id: "source_evidence_extract",
        title: "Extract source-level evidence from retrieved full text",
        owner: "analyst",
        inputs: ["sources/source-evidence-candidates.json", "evidence/chunks.jsonl"],
        optional_inputs: ["fulltext/*.md"],
        skills: ["sources/source-evidence-candidates.json", "evidence/chunks.jsonl", "fulltext/*.md"],
        instructions: [
          "Read only the approved candidates and their retrieved full-text evidence. Write ONLY evidence/source-packets.json as {version:1,packets:[{source_id,recommended_depth,claims:[{claim,supporting_excerpt,locator,comparison_dimensions,limitations}]}]}.",
          "Create packets only for sources listed in sources/source-evidence-candidates.json. supporting_excerpt must copy an exact contiguous run of at least four normalized words from the local retrieved full text; locator identifies its section/paragraph. Faithfully summarize supported claims, comparison dimensions, and limitations. Do not invent findings, quotes, page numbers, experiments, or sources.",
          "A-level recommendation needs at least two independently useful supported claims; B needs at least one. Omit a source rather than fabricate support. The validator checks every excerpt against the retrieved text before accepting this attempt and controls final A/B depth.",
        ],
        outputs: ["evidence/source-packets.json", "reports/source-evidence-repair.md"], validators: ["required_output_exists"],
        validator_commands: [longwriteCommand(["research", "repair-source-evidence", "."])], retry: { max_attempts: 2 },
      },
      {
        id: "finalize_evidence_depth",
        title: "Finalize citation depth from semantic and full-text evidence",
        owner: "analyst", inputs: ["sources/metadata-classified_sources.jsonl", "sources/semantic-screening.json", "evidence/source-packets.json"],
        outputs: ["sources/classified_sources.jsonl", "sources/bibliography.bib", "sources/citation_plan.jsonl", "reports/evidence-depth-finalization.md"],
        validators: ["required_output_exists", "jsonl_parseable"], runtime: "script",
        command: longwriteCommand(["research", "finalize-evidence-depth", "."]),
      },
      {
        id: "corpus_gate_assessment",
        title: "Measure final evidence-backed corpus coverage before recovery",
        owner: "source-curator", inputs: ["sources/classified_sources.jsonl", "sources/search-plan.json"],
        outputs: ["reports/corpus-gates.json", "reports/corpus-gates.md", "reports/metrics.json"], validators: ["required_output_exists"], runtime: "script",
        command: longwriteCommand(["research", "corpus-gates", ".", "--advisory"]),
      },
      {
        type: "loop",
        id: "corpus_evidence_recovery_loop",
        title: "Recover missing validated core evidence before outlining",
        max_rounds: 2,
        stop_when: "corpus_gate_pass >= 1",
        on_exhaustion: "fail",
        stages: [
          {
            id: "corpus_recovery_plan",
            title: "Plan one bounded evidence recovery from failed corpus gates",
            owner: "analyst", when: "corpus_gate_pass < 1",
            inputs: ["reports/corpus-gates.json", "reports/corpus-gates.md", "sources/semantic-screening.json", "fulltext/manifest.json", "reports/evidence-depth-finalization.md"],
            skills: ["reports/corpus-gates.md", "sources/semantic-screening.json", "sources/source-evidence-candidates.json", "fulltext/manifest.json", "reports/evidence-depth-finalization.md"],
            instructions: [
              "Read the failed deterministic corpus-gate report and the current semantic/full-text evidence records. Write ONLY reports/corpus-recovery-plan.json as an AgenticActionPlan object: {version:1,findings:[{id,severity,summary}],actions:[{id,tool,finding_ids,rationale,acceptance_criteria:[{metric,target,scope?}]}]}.",
              "Select exactly one action: tool=targeted_research_expansion. Its finding_ids may name only failed IDs from reports/corpus-gates.json. It must include core_sources with target at least the configured gate. Diagnose why potential A/B sources failed to become evidence-backed (taxonomy coverage, semantic triage, open full-text availability, or insufficient support), and name focused retrieval terms/venues/source types in the finding summary so the bounded deterministic expansion can derive queries.",
              "Do not lower any gate, widen scope into generic bibliography growth, invent sources/claims/URLs, or select outline/prose/visual actions. This is a two-round evidence recovery, not a request to draft the paper.",
            ],
            outputs: ["reports/corpus-recovery-plan.json"], validators: ["required_output_exists"],
            validator_commands: [longwriteCommand(["research", "repair-corpus-recovery-plan", "."])], retry: { max_attempts: 2 },
          },
          {
            id: "corpus_recovery_expand",
            title: "Expand research through the validated recovery plan",
            owner: "source-curator", when: "corpus_gate_pass < 1",
            inputs: ["reports/corpus-recovery-plan.json"], outputs: ["reports/research-expansion.md", "sources/semantic-screening-candidates.json"], validators: ["required_output_exists"], runtime: "script",
            command: longwriteCommand(["research", "expand", ".", "--action-plan", "reports/corpus-recovery-plan.json"]),
          },
          {
            id: "corpus_recovery_semantic_screen",
            title: "Re-screen expanded candidates for evidence recovery",
            owner: "analyst", when: "corpus_gate_pass < 1",
            inputs: ["sources/semantic-screening-candidates.json"], skills: ["sources/semantic-screening-candidates.json", "reports/corpus-gates.md"],
            instructions: [
              "Read only the bounded candidate metadata and current corpus-gate report. Write ONLY sources/semantic-screening.json as {version:1,screenings:[{source_id,taxonomy_cells,chapter_role,semantic_relevance,rationale,recommended_depth,fulltext_priority}]}. Reassess every supplied candidate using title/abstract evidence.",
              "Use exactly: chapter_role protagonist|comparison|background|exclude; semantic_relevance high|medium|low; recommended_depth A|B|C|D; fulltext_priority true|false. Prioritize open, directly relevant sources that can close the named gate, but do not promote a source without abstract support. Final A/B still requires validated full-text evidence.",
            ],
            outputs: ["sources/semantic-screening.json", "reports/semantic-screen-repair.md"], validators: ["required_output_exists"],
            validator_commands: [longwriteCommand(["research", "repair-semantic-screen", "."])], retry: { max_attempts: 2 },
          },
          {
            id: "corpus_recovery_fulltext",
            title: "Ingest full text selected by recovered semantic screening",
            owner: "source-curator", when: "corpus_gate_pass < 1",
            inputs: ["sources/semantic-screening.json", "sources/classified_sources.jsonl"], outputs: ["fulltext/manifest.json"], validators: ["required_output_exists"], runtime: "script",
            command: longwriteCommand(["research", "fulltext", ".", "--max-sources", String(policy.fulltextMaxSources), ...(policy.allowPdfDownload === false ? ["--no-pdf-download"] : [])]),
          },
          {
            id: "corpus_recovery_evidence_index",
            title: "Rebuild the evidence index after corpus recovery",
            owner: "source-curator", when: "corpus_gate_pass < 1",
            inputs: ["fulltext/manifest.json"], outputs: ["evidence/chunks.jsonl", "evidence/index.sqlite"], validators: ["required_output_exists"], runtime: "script",
            command: longwriteCommand(["evidence", "index", "."]),
          },
          {
            id: "corpus_recovery_source_candidate_select",
            title: "Select recovered full-text sources for claim extraction",
            owner: "source-curator", when: "corpus_gate_pass < 1",
            inputs: ["sources/semantic-screening.json", "fulltext/manifest.json", "sources/classified_sources.jsonl"], outputs: ["sources/source-evidence-candidates.json"], validators: ["required_output_exists"], runtime: "script",
            command: longwriteCommand(["research", "select-source-evidence-candidates", "."]),
          },
          {
            id: "corpus_recovery_source_evidence_extract",
            title: "Extract validated evidence from recovered full text",
            owner: "analyst", when: "corpus_gate_pass < 1",
            inputs: ["sources/source-evidence-candidates.json", "evidence/chunks.jsonl"], optional_inputs: ["fulltext/*.md"], skills: ["sources/source-evidence-candidates.json", "evidence/chunks.jsonl", "fulltext/*.md"],
            instructions: [
              "Write ONLY evidence/source-packets.json as {version:1,packets:[{source_id,recommended_depth,claims:[{claim,supporting_excerpt,locator,comparison_dimensions,limitations}]}]}. Use only supplied candidate IDs and exact contiguous excerpts of at least four normalized words from local retrieved full text. Omit unsupported sources; do not invent claims, pages, results, or citations.",
              "A-level recommendation needs at least two independently useful supported claims; B needs at least one. Explain comparison dimensions and limitations faithfully so the deterministic validator can finalize citation depth.",
            ],
            outputs: ["evidence/source-packets.json", "reports/source-evidence-repair.md"], validators: ["required_output_exists"],
            validator_commands: [longwriteCommand(["research", "repair-source-evidence", "."])], retry: { max_attempts: 2 },
          },
          {
            id: "corpus_recovery_finalize_evidence_depth",
            title: "Finalize recovered citation depth from validated evidence",
            owner: "analyst", when: "corpus_gate_pass < 1",
            inputs: ["sources/metadata-classified_sources.jsonl", "sources/semantic-screening.json", "evidence/source-packets.json"],
            outputs: ["sources/classified_sources.jsonl", "sources/bibliography.bib", "sources/citation_plan.jsonl", "reports/evidence-depth-finalization.md"], validators: ["required_output_exists", "jsonl_parseable"], runtime: "script",
            command: longwriteCommand(["research", "finalize-evidence-depth", "."]),
          },
          {
            id: "corpus_recovery_assessment",
            title: "Re-measure corpus gates after evidence recovery",
            owner: "source-curator", inputs: ["sources/classified_sources.jsonl", "sources/search-plan.json"],
            outputs: ["reports/corpus-gates.json", "reports/corpus-gates.md", "reports/metrics.json"], validators: ["required_output_exists"], runtime: "script",
            command: longwriteCommand(["research", "corpus-gates", ".", "--advisory"]),
          },
        ],
      },
      ...(corpusGate ? [corpusGate] : []),
    );
  }
  if (policy?.outlineReviewEnabled && policy?.semanticScreenEnabled && provider !== "seed") {
    const outline = next.stages.find((stage) => stage.id === "outline");
    const surveyContract = next.stages.find((stage) => stage.id === "survey_contract");
    const structureAudit = next.stages.find((stage) => stage.id === "structure_audit");
    if (!outline || !surveyContract || !structureAudit) throw new Error("agentic outline review requires outline, survey_contract, and structure_audit stages");
    // The original outline approval occurs too early for an evidence-aware
    // critique. The final approval gate below is the only human pause.
    outline.requires_human_approval = false;
    outline.inputs = [...new Set([...(outline.inputs as string[]), "evidence/source-packets.json", "reports/corpus-gates.md"])];
    outline.optional_inputs = [...new Set([...((outline.optional_inputs as string[] | undefined) ?? []), "sources/semantic-screening.json", "reports/evidence-depth-finalization.md"])];
    outline.skills = [...new Set([...((outline.skills as string[] | undefined) ?? []), "evidence/source-packets.json", "reports/corpus-gates.md", "sources/semantic-screening.json"])];
    outline.instructions = [
      ...((outline.instructions as string[] | undefined) ?? []),
      "Use evidence/source-packets.json as the compact deep-reading dossier: organize sections around supported contributions, comparisons, tensions, and limitations rather than bibliography order. Do not claim to have read or synthesize a source beyond its supplied packet.",
      "For every substantive outline section, select source_ids that can support its intended argument and make the section purpose state the comparative or analytical question it resolves. Preserve explicit taxonomy coverage and leave unresolved evidence gaps visible rather than papering them over.",
    ];
    // Replace the one-shot audits with loop children that overwrite the same
    // durable reports each round. Downstream stages therefore consume only the
    // re-audited, approved outline.
    next.stages = next.stages.filter((stage) => stage.id !== "survey_contract" && stage.id !== "structure_audit");
    const outlineIndex = next.stages.findIndex((stage) => stage.id === "outline");
    const outlineLoop = {
      type: "loop",
      id: "outline_quality_loop",
      title: "Review and revise the evidence-aware outline",
      max_rounds: policy.outlineReviewMaxRounds ?? 2,
      stop_when: "outline_readiness >= 1",
      on_exhaustion: "fail",
      stages: [
        {
          ...surveyContract,
          id: "outline_survey_contract",
          title: "Audit outline survey contract",
          runtime: "script",
          command: longwriteCommand(["research", "survey-contract", "."]),
        },
        {
          ...structureAudit,
          id: "outline_structure_audit",
          title: "Audit outline structure",
          runtime: "script",
          command: longwriteCommand(["review", "structure", "."]),
        },
        {
          id: "outline_review",
          title: "Critique outline against source evidence",
          owner: "skeptical-reviewer",
          inputs: ["outline.md", "outline.json", "reports/survey-contract.md", "reports/structure-audit.md", "evidence/source-packets.json", "sources/classified_sources.jsonl"],
          optional_inputs: ["sources/semantic-screening.json", "reports/corpus-gates.md", "feedback/outline-revision.md"],
          skills: ["outline.json", "reports/survey-contract.md", "reports/structure-audit.md", "evidence/source-packets.json", "sources/classified_sources.jsonl", "reports/corpus-gates.md"],
          instructions: [
            "Write ONLY reviews/outline-review.json as {version:1,summary,strengths,findings:[{id,severity,category,summary,section_ids,source_ids}]}. severity is minor, major, or critical; category is scope, taxonomy, evidence, comparison, sequence, gap, or clarity.",
            "Review the outline as a research argument, not a table of contents. Check whether its taxonomy is mutually useful rather than a list, whether comparisons and limitations have a home, whether the sequence supports the stated contribution, and whether the chosen section source_ids have packet-backed support. Ground every named section/source in the supplied artifacts; do not invent papers, claims, sections, or experimental evidence.",
            "Use major or critical for a problem that blocks evidence-grounded drafting. Use no major/critical findings only when the deterministic audits pass and the outline can proceed to human approval.",
          ],
          outputs: ["reviews/outline-review.json", "reports/outline-review-repair.md"], validators: ["required_output_exists"],
          validator_commands: [longwriteCommand(["review", "repair-outline-review", "."])], retry: { max_attempts: 2 },
        },
        {
          id: "outline_readiness_score",
          title: "Score deterministic outline readiness",
          owner: "analyst", inputs: ["reviews/outline-review.json", "reports/survey-contract.json", "reports/structure-audit.json"],
          outputs: ["reports/outline-readiness.md", "reports/metrics.json"], validators: ["required_output_exists"], runtime: "script",
          command: longwriteCommand(["review", "score-outline-readiness", "."]),
        },
        {
          id: "outline_revise",
          title: "Revise outline from evidence-aware critique",
          owner: "outline-architect",
          inputs: ["project_brief.md", "outline.md", "outline.json", "reviews/outline-review.json", "reports/outline-readiness.md", "evidence/source-packets.json", "sources/classified_sources.jsonl"],
          optional_inputs: ["feedback/outline-revision.md", "sources/semantic-screening.json", "reports/corpus-gates.md"],
          skills: ["outline.json", "reviews/outline-review.json", "reports/survey-contract.md", "reports/structure-audit.md", "evidence/source-packets.json", "sources/classified_sources.jsonl"],
          instructions: [
            "Rewrite outline.md and outline.json to address every major/critical review finding with the smallest evidence-grounded structural change. Preserve valid sections when there are no blocking findings; do not add generic filler or a revision log to reader-facing outline artifacts.",
            "Every outline.json section must retain id, title, role, target_words, purpose, at least two keywords, and source_ids. Use only current classified source IDs. Keep the paper's organizing argument explicit: taxonomy, comparisons, limitations, and evidence gaps must be structurally visible before drafting begins.",
          ],
          outputs: ["outline.md", "outline.json"], validators: ["required_output_exists", "non_empty_markdown"], retry: { max_attempts: 2 },
        },
      ],
    };
    const approval = {
      id: "outline_approval_gate",
      title: "Human approval of re-audited outline",
      owner: "outline-architect",
      inputs: ["outline.md", "outline.json", "reports/outline-readiness.md", "reports/metrics.json"],
      outputs: ["reports/outline-approval.md"], validators: ["required_output_exists"], runtime: "script",
      command: longwriteCommand(["review", "outline-approval", "."]), requires_human_approval: policy.outlineApprovalMode === "human",
    };
    next.stages.splice(outlineIndex + 1, 0, outlineLoop, approval);
  }
  const qualityLoop = next.stages.find((stage) => stage.id === "quality_loop");
  if (!qualityLoop || !Array.isArray(qualityLoop.stages)) {
    throw new Error("auto_research_agentic requires the base research quality_loop");
  }
  const children = qualityLoop.stages as Array<Record<string, unknown>>;
  const expand = children.find((stage) => stage.id === "expand_research");
  const revise = children.find((stage) => stage.id === "revise");
  const visualPlan = next.stages.find((stage) => stage.id === "visual_plan");
  if (!expand || !revise || !visualPlan) throw new Error("auto_research_agentic requires expand_research, revise, and visual_plan stages");

  // Decide analytical artifacts before any chapter is drafted. This gives the
  // LLM room to choose an evidence-backed formalization, comparison matrix,
  // timeline, or architecture diagram as an intellectual move; deterministic
  // builders later verify and render the chosen bounded form.
  if (policy?.semanticScreenEnabled && provider !== "seed") {
    const initialArtifactPlanner = {
      id: "initial_artifact_plan",
      title: "Choose evidence-aware artifacts before drafting",
      owner: "analyst",
      inputs: ["project_brief.md", "outline.md", "outline.json", "evidence/source-packets.json", "sources/classified_sources.jsonl", "evidence/coverage.json"],
      optional_inputs: ["sources/semantic-screening.json", "reports/corpus-gates.md", "reports/outline-readiness.md"],
      skills: ["project_brief.md", "outline.json", "evidence/source-packets.json", "sources/classified_sources.jsonl", "evidence/coverage.json"],
      instructions: [
        "Write ONLY reviews/artifact-plan.json as {version:1,intents:[{id,kind,rationale,section_id?,source_ids?,taxonomy_cell?,plot_metric?,experiment_hypothesis?,control?,acceptance_criteria:[{metric,target,scope?]}]}. It is a creative strategy record, not a request to write TeX, code, coordinates, dates, or results.",
        `Choose only source-grounded artifacts that materially improve the approved outline. kind is formalization, comparison_matrix, metadata_plot, timeline, architecture_diagram, taxonomy_recall, or empirical_pilot. A formalization must clarify a sourced definition, objective, comparison, or analytical claim; it is never decorative mathematics. A comparison_matrix or timeline requires a target section and at least three representative classified source IDs. ${architectureSourceRequirement} A metadata_plot uses publication_year, citation_depth, or venue and derives values from verified workspace metadata.`,
        "For a long survey, use the configured visual quality targets as an artifact budget: select enough independent comparison/table, metadata, timeline, or diagram intents for the visual planner to meet them, but do not duplicate weak inventory tables. The visual planner will turn these intents into a strict source-bound figure-spec contract.",
        "empirical_pilot is legal only when research.paper_kind is empirical. It creates a preregistration request with hypothesis, control, and trial acceptance criterion; it never invents findings and does not render an empirical result plot until LongExperiment provides verified result data.",
        "Choose at most five intents. Do not invent source IDs, sections, taxonomy cells, numerical values, experimental results, or unsupported equations. Use an empty intents array when no artifact is justified.",
        ...selectedPaperProfile.promptOverlays.artifact,
      ],
      outputs: ["reviews/artifact-plan.json", "reports/artifact-plan-repair.md"], validators: ["required_output_exists"],
      validator_commands: [longwriteCommand(["review", "repair-artifact-plan", "."])], retry: { max_attempts: 2 },
    };
    const visualIndex = next.stages.findIndex((stage) => stage.id === "visual_plan");
    next.stages.splice(visualIndex, 0, initialArtifactPlanner);
    visualPlan.inputs = [...new Set([...(visualPlan.inputs as string[]), "reviews/artifact-plan.json"])];
    visualPlan.optional_inputs = [...new Set([...((visualPlan.optional_inputs as string[] | undefined) ?? []), "reports/artifact-plan-repair.md"])];
    visualPlan.skills = [...new Set([...((visualPlan.skills as string[] | undefined) ?? []), "reviews/artifact-plan.json", "evidence/source-packets.json"])];
    visualPlan.instructions = [
      ...((visualPlan.instructions as string[] | undefined) ?? []),
      "Read the validated pre-draft reviews/artifact-plan.json. Realize compatible intents in the declarative figure-spec contract: formalizations inform the named chapter writer; comparison_matrix becomes a source-bound table_specs entry; timeline becomes a source-bound timelines entry with dates derived from classified metadata; architecture_diagram informs concept_map. Do not claim an empirical result plot without a verified LongExperiment result artifact.",
      "Keep every rendered text field within its cap so the build never rejects the plan: title at most 180 characters, caption at most 500, insight at most 800; concept_map node labels at most 48 and edge labels at most 36. Captions are one or two sentences, not a paragraph.",
    ];
    const draftSections = next.stages.find((stage) => stage.id === "draft_sections");
    if (draftSections && Array.isArray(draftSections.steps)) {
      draftSections.steps = draftSections.steps.map((raw) => {
        const step = raw as Record<string, unknown>;
        if (step.id !== "draft") return step;
        return {
          ...step,
          inputs: [...new Set([...(step.inputs as string[]), "reviews/artifact-plan.json"])],
          optional_inputs: [...new Set([...((step.optional_inputs as string[] | undefined) ?? []), "reports/artifact-plan-repair.md"])],
          skills: [...new Set([...((step.skills as string[] | undefined) ?? []), "reviews/artifact-plan.json", "evidence/source-packets.json"])],
          instructions: [
            ...((step.instructions as string[] | undefined) ?? []),
            "Read only the pre-draft artifact intents that name this section. If a validated formalization is selected, decide its exact source-grounded notation from the evidence packet, define every symbol nearby, and omit it if a useful formalization cannot be supported. Do not add arbitrary mathematics. Explain nearby planned figures/tables in prose, but leave their labels, captions, data, and placement to the artifact builder.",
          ],
        };
      });
    }
  }

  const artifactPlanner = {
    id: "artifact_plan",
    title: "Choose source-grounded analytical artifacts",
    owner: "analyst",
    inputs: ["reviews/scorecard.json", "reports/evidence-audit.md", "outline.json", "sources/classified_sources.jsonl"],
    optional_inputs: ["reports/metrics.json", "evidence/coverage.json", "feedback/user-feedback.md"],
    skills: ["reviews/scorecard.json", "reports/evidence-audit.md", "outline.json", "sources/classified_sources.jsonl", "evidence/coverage.json"],
    instructions: [
      "Read the review evidence and decide whether an additional analytical artifact would materially improve this paper. Write ONLY reviews/artifact-plan.json; use an empty intents array when no artifact is justified.",
      `The current artifact-plan contract additionally permits timeline and architecture_diagram intents. A timeline needs a target section and at least three classified source IDs; an architecture diagram follows this profile's requirement: ${architectureSourceRequirement} The visual renderer derives dates from metadata and never accepts handwritten coordinates or result values.`,
      "Schema: {version:1,intents:[{id,kind,rationale,section_id?,source_ids?,taxonomy_cell?,plot_metric?,experiment_hypothesis?,control?,acceptance_criteria:[{metric,target,scope?}]}]}. kind is formalization, comparison_matrix, metadata_plot, timeline, architecture_diagram, taxonomy_recall, or empirical_pilot.",
      "Formalization is a request for the chapter writer to introduce a compact definition/objective with locally defined symbols; it requires a target section and supporting classified source ids. Do not request decorative mathematics.",
      `comparison_matrix requires representative source ids. metadata_plot must select publication_year, citation_depth, or venue and a target section; its renderer derives values only from verified workspace metadata. timeline requires a target section and at least three classified source ids; its renderer derives dates and labels only from verified workspace metadata. ${architectureSourceRequirement} taxonomy_recall must name one configured taxonomy cell and target woven A/B evidence.`,
      "empirical_pilot is legal only when research.paper_kind is empirical. It must state a hypothesis, control, and trial acceptance criterion. It creates a preregistration request only; LongWrite does not execute an experiment until the configured LongExperiment integration is available.",
      "Choose at most five intents. Do not invent source ids, sections, taxonomy cells, commands, experimental results, or plot values.",
      ...selectedPaperProfile.promptOverlays.artifact,
    ],
    outputs: ["reviews/artifact-plan.json", "reports/artifact-plan-repair.md"],
    validators: ["required_output_exists"],
    validator_commands: [longwriteCommand(["review", "repair-artifact-plan", "."])],
    retry: { max_attempts: 2 },
  };
  const planner = {
    id: "action_plan",
    title: "Plan bounded remediation actions",
    owner: "analyst",
    inputs: ["reviews/scorecard.json", "reports/evidence-audit.md", "reviews/artifact-plan.json"],
    optional_inputs: ["reports/metrics.json", "feedback/user-feedback.md", "reports/claim-gate.md", "reports/artifact-plan-repair.md"],
    skills: ["reviews/scorecard.json", "reports/metrics.json", "reports/evidence-audit.md", "feedback/user-feedback.md", "reports/claim-gate.md", "reviews/artifact-plan.json"],
    instructions: [
      "Read the review evidence and write ONLY reviews/action-plan.json. Do not wrap it in Markdown or an array.",
      "reviews/artifact-plan.json is the validated creative strategy. Route every selected intent to the smallest compatible action; do not discard a validated formalization, comparison, metadata plot, timeline, architecture diagram, or taxonomy recall merely because it is not a fixed stage.",
      "Schema: {version:1,findings:[{id,severity,summary}],actions:[{id,tool,finding_ids,rationale,acceptance_criteria:[{metric,target,scope?}]}]}. severity is minor, major, or critical. Every action needs at least one measurable criterion. Use cited_sources, cited_within_one_year_ratio, accepted_cited_ratio, cited_arxiv_only_ratio, citations_per_page, citation_depth_per_section (scope=A|B|C or a named section), taxonomy_cell_ab_sources (scope=taxonomy cell), comparative_tables, verified_metadata_plots, figures, tables, rendered_visual_review, or empirical_trials. Map weak comparative synthesis to a source-grounded method matrix; map taxonomy gaps to targeted recall plus woven A/B sources; map visual weakness to rendered_visual_review >= 1 plus the smallest necessary figure/table repair. Never use an empirical_trials action unless research.paper_kind is empirical and a preregistered, controlled result artifact is in scope.",
      "Allowed tools: targeted_research_expansion (only for an evidence/coverage gap), reopen_outline (only for a major/critical structural, scope, or taxonomy defect requiring a changed organizing argument), revise_sections (for prose, structure, citation, or length repair), revise_visual_plan (for a figure/table placement, caption, conceptual-diagram, generated-table, bibliography-presentation, or rendered-PDF defect), and request_operator_clarification (only when a human decision is genuinely required).",
      "Select reopen_outline only when incremental chapter revision cannot address the review finding. Its rationale must name the defective organizing claim and evidence-backed replacement. It may co-occur with targeted_research_expansion: the dispatcher refreshes and validates the literature before it reopens the outline in the same bounded round.",
      "Output ownership is strict: revise_sections may change only chapters/*.md, paper/abstract.md, and reviews/revision-report.md. Never assign it a generated table/figure, placement, caption, rendered-PDF, bibliography-presentation, TeX, or build defect. Assign those findings to revise_visual_plan so the artifact builder can write the durable placement contract before the normal rebuild.",
      "If one finding spans prose and an artifact, split it into two findings (or attach the same finding id to both actions) and keep each action rationale within that action's declared outputs. Do not ask a prose action to hand off uneditable work as a blocker.",
      "Select each tool at most once per plan. Combine all findings owned by the same tool into that tool's single action; its output contract is shared across those findings.",
      "Every action must name at least one finding id and at least one quantitative acceptance criterion. Select the smallest sufficient set; do not invent commands, paths, tool ids, or model settings.",
      "If a finding requires an operator decision, select request_operator_clarification as the ONLY action. Put the exact question in its rationale; never guess the answer.",
    ],
    outputs: ["reviews/action-plan.json", "reports/action-plan-repair.md"],
    validators: ["required_output_exists"],
    validator_commands: [longwriteCommand(["review", "repair-action-plan", "."])],
    retry: { max_attempts: 2 },
  };
  const splitActionPlan = {
    id: "action_plan_split",
    title: "Order remediation actions by evidence dependency",
    owner: "analyst",
    inputs: ["reviews/action-plan.json"],
    outputs: ["reviews/research-action-plan.json", "reviews/outline-action-plan.json", "reviews/revision-action-plan.json", "reports/action-plan-split.md"],
    validators: ["required_output_exists"], runtime: "script",
    command: longwriteCommand(["review", "split-action-plan", "."]),
  };
  const researchDispatch = {
    type: "action_dispatch",
    id: "research_action_dispatch",
    title: "Execute evidence-expansion actions before revision",
    owner: "analyst",
    plan_path: "reviews/research-action-plan.json",
    allowed_actions: ["targeted_research_expansion"],
    max_actions: 1,
    outputs: ["reports/action-dispatch-research.json"],
  };
  const outlineDispatch = {
    type: "action_dispatch",
    id: "outline_action_dispatch",
    title: "Execute structural outline-reopen actions after evidence refresh",
    owner: "analyst",
    plan_path: "reviews/outline-action-plan.json",
    allowed_actions: ["reopen_outline"],
    max_actions: 1,
    outputs: ["reports/action-dispatch-outline.json"],
  };
  const revisionDispatch = {
    type: "action_dispatch",
    id: "action_dispatch",
    title: "Execute prose and visual repair actions from refreshed evidence",
    owner: "analyst",
    plan_path: "reviews/revision-action-plan.json",
    allowed_actions: ["revise_sections", "revise_visual_plan", "request_operator_clarification"],
    max_actions: 3,
    outputs: ["reports/action-dispatch.json"],
  };
  // Records whether a targeted_research_expansion was actually dispatched this
  // round, as the numeric metric `research_expansion_dispatched`. The evidence
  // refresh block below is gated on it so the runtime SKIPS those stages when
  // no expansion ran — instead of asking a model to "preserve" an unchanged
  // declared output, which the freshness check rejects as stale and which
  // wastes a full model turn per round before self-healing on retry.
  const dispatchMetrics = {
    id: "quality_dispatch_metrics",
    title: "Record whether an evidence expansion was dispatched this round",
    owner: "source-curator",
    inputs: ["reports/action-dispatch-research.json"],
    outputs: ["reports/metrics.json"],
    validators: ["required_output_exists"],
    runtime: "script",
    command: longwriteCommand(["research", "dispatch-metrics", "."]),
  };
  // A selected expansion changes the candidate corpus after the initial
  // semantic/full-text bridge has completed.  Replay that bridge inside each
  // bounded quality round so review-driven recall cannot leave new sources
  // metadata-only.  Every stage is gated on research_expansion_dispatched: when
  // no expansion was dispatched the whole block is skipped, so the LLM stages
  // only ever run when they genuinely must produce a fresh artifact.
  const evidenceRefreshStages: Array<Record<string, unknown>> = (policy?.semanticScreenEnabled && provider !== "seed" ? [
    {
      id: "quality_semantic_screen",
      title: "Refresh abstract screening after a selected evidence expansion",
      owner: "analyst",
      inputs: ["reports/action-dispatch-research.json", "sources/semantic-screening-candidates.json"],
      optional_inputs: ["sources/semantic-screening.json", "reports/research-expansion.md"],
      skills: ["reports/action-dispatch-research.json", "sources/semantic-screening-candidates.json", "sources/semantic-screening.json", "reports/research-expansion.md"],
      instructions: [
        "A targeted_research_expansion was dispatched this round (this stage runs only then). Re-screen every current bounded candidate from titles and abstracts and write ONLY sources/semantic-screening.json as {version:1,screenings:[{source_id,taxonomy_cells,chapter_role,semantic_relevance,rationale,recommended_depth,fulltext_priority}]}.",
        "This is abstract-level semantic triage, not a claim-evidence judgment. Assess only supplied candidate source IDs and configured taxonomy cells. Do not invent claims, quotations, pages, venues, acceptance status, or source IDs. Use exactly: chapter_role protagonist|comparison|background|exclude; semantic_relevance high|medium|low; recommended_depth A|B|C|D (D, never none); and fulltext_priority true|false as a JSON boolean. Final A/B depth still requires retrieved full text and validated source evidence.",
      ],
      outputs: ["sources/semantic-screening.json", "reports/semantic-screen-repair.md"], validators: ["required_output_exists"],
      validator_commands: [longwriteCommand(["research", "repair-semantic-screen", "."])],
      retry: { max_attempts: 2 },
    },
    {
      id: "quality_fulltext_refresh",
      title: "Ingest full text selected by refreshed semantic screening",
      owner: "source-curator", inputs: ["sources/semantic-screening.json", "sources/classified_sources.jsonl"],
      outputs: ["fulltext/manifest.json"], validators: ["required_output_exists"], runtime: "script",
      command: longwriteCommand(["research", "fulltext", ".", "--max-sources", String(policy.fulltextMaxSources), ...(policy.allowPdfDownload === false ? ["--no-pdf-download"] : [])]),
    },
    {
      id: "quality_evidence_index_refresh",
      title: "Rebuild local evidence index from refreshed full text",
      owner: "source-curator", inputs: ["fulltext/manifest.json"],
      outputs: ["evidence/chunks.jsonl", "evidence/index.sqlite"], validators: ["required_output_exists"], runtime: "script",
      command: longwriteCommand(["evidence", "index", "."]),
    },
    {
      id: "quality_source_evidence_candidate_select",
      title: "Select refreshed full-text sources for claim extraction",
      owner: "source-curator", inputs: ["sources/semantic-screening.json", "fulltext/manifest.json", "sources/classified_sources.jsonl"],
      outputs: ["sources/source-evidence-candidates.json"], validators: ["required_output_exists"], runtime: "script",
      command: longwriteCommand(["research", "select-source-evidence-candidates", "."]),
    },
    {
      id: "quality_source_evidence_extract",
      title: "Refresh source-level evidence packets after an expansion",
      owner: "analyst",
      inputs: ["reports/action-dispatch-research.json", "sources/source-evidence-candidates.json", "evidence/chunks.jsonl"],
      optional_inputs: ["evidence/source-packets.json", "fulltext/*.md"],
      skills: ["reports/action-dispatch-research.json", "sources/source-evidence-candidates.json", "evidence/chunks.jsonl", "evidence/source-packets.json", "fulltext/*.md"],
      instructions: [
        "A targeted_research_expansion was dispatched this round (this stage runs only then). Write ONLY evidence/source-packets.json as {version:1,packets:[{source_id,recommended_depth,claims:[{claim,supporting_excerpt,locator,comparison_dimensions,limitations}]}]} for the current approved full-text candidates.",
        "Every supporting_excerpt must be an exact contiguous excerpt of at least four normalized words from local retrieved full text. Create packets only for the supplied candidate IDs, faithfully state limitations, and omit unsupported sources rather than fabricating support. A-level recommendation needs at least two independently useful claims; B needs at least one.",
      ],
      outputs: ["evidence/source-packets.json", "reports/source-evidence-repair.md"], validators: ["required_output_exists"],
      validator_commands: [longwriteCommand(["research", "repair-source-evidence", "."])], retry: { max_attempts: 2 },
    },
    {
      id: "quality_finalize_evidence_depth",
      title: "Finalize refreshed citation depth from source evidence",
      owner: "analyst", inputs: ["sources/metadata-classified_sources.jsonl", "sources/semantic-screening.json", "evidence/source-packets.json"],
      outputs: ["sources/classified_sources.jsonl", "sources/bibliography.bib", "sources/citation_plan.jsonl", "reports/evidence-depth-finalization.md"], validators: ["required_output_exists", "jsonl_parseable"], runtime: "script",
      command: longwriteCommand(["research", "finalize-evidence-depth", "."]),
    },
    {
      id: "quality_corpus_gates",
      title: "Re-evaluate corpus gates on refreshed citation depth",
      owner: "source-curator", inputs: ["sources/classified_sources.jsonl", "sources/search-plan.json"],
      outputs: ["reports/corpus-gates.json", "reports/corpus-gates.md"], validators: ["required_output_exists"], runtime: "script",
      command: longwriteCommand(["research", "corpus-gates", "."]),
    },
    {
      id: "quality_allocate_evidence",
      title: "Reallocate section evidence from refreshed corpus",
      owner: "source-curator", inputs: ["outline.json", "evidence/chunks.jsonl", "sources/classified_sources.jsonl"],
      outputs: ["evidence/coverage.json"], validators: ["required_output_exists"], runtime: "script",
      command: longwriteCommand(["evidence", "allocate", "."]),
    },
  ] : []).map((stage) => ({ ...stage, when: "research_expansion_dispatched >= 1" }));
  const outlineReopenStages: Array<Record<string, unknown>> = policy?.outlineReviewEnabled && policy?.semanticScreenEnabled && provider !== "seed" ? [
    {
      id: "quality_outline_survey_contract",
      title: "Audit a reopened outline against the survey contract",
      owner: "analyst", inputs: ["outline.json", "reports/action-dispatch-outline.json"],
      outputs: ["reports/survey-contract.json", "reports/survey-contract.md"], validators: ["required_output_exists"], runtime: "script",
      command: longwriteCommand(["research", "survey-contract", "."]),
    },
    {
      id: "quality_outline_structure_audit",
      title: "Audit a reopened outline for structural coherence",
      owner: "analyst", inputs: ["outline.json", "reports/action-dispatch-outline.json"],
      outputs: ["reports/structure-audit.json", "reports/structure-audit.md"], validators: ["required_output_exists"], runtime: "script",
      command: longwriteCommand(["review", "structure", "."]),
    },
    {
      id: "quality_outline_reopen_validate",
      title: "Validate an outline reopening before downstream revision",
      owner: "analyst", inputs: ["reviews/action-plan.json", "reports/survey-contract.json", "reports/structure-audit.json"],
      outputs: ["reports/outline-reopen.md"], validators: ["required_output_exists"], runtime: "script",
      command: longwriteCommand(["review", "validate-outline-reopen", ".", "--action-plan", "reviews/action-plan.json"]),
    },
    {
      id: "quality_reallocate_outline_evidence",
      title: "Reallocate evidence after a validated outline reopening",
      owner: "source-curator", inputs: ["outline.json", "evidence/chunks.jsonl", "sources/classified_sources.jsonl", "reports/outline-reopen.md"],
      outputs: ["evidence/coverage.json"], validators: ["required_output_exists"], runtime: "script",
      command: longwriteCommand(["evidence", "allocate", "."]),
    },
  ] : [];
  const adaptiveChildren: Array<Record<string, unknown>> = [
    artifactPlanner,
    planner,
    splitActionPlan,
    researchDispatch,
    ...(evidenceRefreshStages.length ? [dispatchMetrics] : []),
    ...evidenceRefreshStages,
    outlineDispatch,
    ...outlineReopenStages,
    revisionDispatch,
    ...children.filter((stage) => !["route", "expand_research", "revise"].includes(String(stage.id))),
  ];
  qualityLoop.stages = adaptiveChildren;
  for (const stage of adaptiveChildren) {
    if (stage.id !== "review") continue;
    stage.optional_inputs = [...((stage.optional_inputs as string[] | undefined) ?? []), "reviews/action-plan.json", "reviews/artifact-plan.json"];
    stage.skills = [...((stage.skills as string[] | undefined) ?? []), "reviews/action-plan.json", "reviews/artifact-plan.json"];
    stage.instructions = [
      ...((stage.instructions as string[] | undefined) ?? []),
      "When reviews/action-plan.json and reviews/artifact-plan.json exist, independently check every selected action and artifact intent against its quantitative acceptance_criteria. Report each unmet criterion as an unresolved finding; do not award credit for a claimed fix without its stated observable result.",
    ];
  }
  // A final release validation has stricter, manuscript-wide checks than a
  // peer-review score alone (for example live URLs and woven A/B depth).  Do
  // not leave those findings as a dead-end after the normal quality budget:
  // write them as an advisory report, then run at most two explicit recovery
  // rounds through the same trusted dispatcher and deterministic rebuild.
  // The final hard validator still decides publication eligibility.
  if (policy?.semanticScreenEnabled && provider !== "seed") {
    const releaseAssessment = {
      id: "final_release_assessment",
      title: "Assess final release gates for bounded recovery",
      owner: "artifact-builder",
      inputs: ["chapters/*.md", "sources/classified_sources.jsonl", "sources/bibliography.bib", "reviews/scorecard.json"],
      outputs: ["reports/longwrite-validation.json", "reports/longwrite-validation.md", "reports/release-gates.json", "reports/metrics.json"],
      validators: ["required_output_exists"], runtime: "script",
      command: validateResearchAdvisoryCommand(),
    };
    const finalReleasePlanner = {
      ...planner,
      id: "final_release_plan",
      title: "Plan corrective actions for failed final release gates",
      inputs: [...new Set([...(planner.inputs as string[]), "reports/longwrite-validation.json", "reports/longwrite-validation.md"])],
      optional_inputs: [...new Set([...(planner.optional_inputs as string[]), "reports/source-verification.md", "reports/research-assessment.md"])],
      skills: [...new Set([...(planner.skills as string[]), "reports/longwrite-validation.json", "reports/longwrite-validation.md", "reports/source-verification.md", "reports/research-assessment.md"])],
      instructions: [
        "This is a final-release recovery round. Read reports/longwrite-validation.json first. Its failed check IDs are authoritative: create one finding with the exact ID for every currently failed check, and select allowlisted corrective action(s) that cover every one. Never lower a target, waive a URL/claim/evidence gate, or claim a pass without a new deterministic assessment.",
        "For a dead cited URL, revise the prose to remove or replace the citation with a currently evidence-backed source, or perform targeted research to obtain such a source; do not edit verification records or invent a replacement URL. For citation-depth quotas, weave a validated B-depth source into each named chapter rather than weakening the quota. For claim support or review score, repair the evidence-backed prose and/or placed artifact that the report and reviewer identify.",
        "For rendered_visual_review, select revise_visual_plan with rendered_visual_review >= 1, then let the normal rebuild → PNG rendering → Codex visual-review path produce a fresh verdict. Never mark the visual QA JSON as passing by hand or waive a page-specific legibility finding.",
        ...((planner.instructions as string[]) ?? []),
      ],
      outputs: ["reviews/action-plan.json", "reports/action-plan-repair.md", "reports/final-release-plan-repair.md"],
      validator_commands: [
        ...((planner.validator_commands as Array<Record<string, unknown>>) ?? []),
        longwriteCommand(["research", "repair-final-release-plan", "."]),
      ],
    };
    const recoveryWhen = (stage: Record<string, unknown>): Record<string, unknown> => ({
      ...stage,
      when: "final_release_gate_pass < 1",
    });
    const finalReleaseRecoveryChildren: Array<Record<string, unknown>> = [
      recoveryWhen(finalReleasePlanner),
      recoveryWhen(splitActionPlan),
      recoveryWhen(researchDispatch),
      // dispatchMetrics is gated by the recovery predicate, but the refresh
      // stages keep their own research_expansion_dispatched gate (recoveryWhen
      // must not clobber it) so a no-op recovery round still skips them.
      ...(evidenceRefreshStages.length ? [recoveryWhen(dispatchMetrics)] : []),
      ...evidenceRefreshStages,
      recoveryWhen(outlineDispatch),
      ...outlineReopenStages.map(recoveryWhen),
      recoveryWhen(revisionDispatch),
      ...children
        .filter((stage) => !["route", "expand_research", "revise"].includes(String(stage.id)))
        .map(recoveryWhen),
      {
        id: "final_release_verify_citations",
        title: "Re-verify cited URLs after final-release recovery",
        owner: "source-curator",
        inputs: ["chapters/*.md", "sources/classified_sources.jsonl"],
        outputs: ["sources/citation-verification.jsonl", "reports/source-verification.md"],
        validators: ["required_output_exists", "jsonl_parseable"], runtime: "script",
        command: longwriteCommand(["research", "verify", "."]),
      },
      {
        id: "final_release_assess_research",
        title: "Reassess literature and citation quality after recovery",
        owner: "analyst",
        inputs: ["sources/classified_sources.jsonl", "sources/citation_plan.jsonl", "chapters/*.md", "sources/bibliography.bib"],
        outputs: ["reports/research-assessment.json", "reports/research-assessment.md", "sources/source_upgrade_plan.jsonl"],
        validators: ["required_output_exists"], runtime: "script",
        command: assessResearchCommand(),
      },
      releaseAssessment,
    ];
    const finalValidateIndex = next.stages.findIndex((stage) => stage.id === "final_validate");
    if (finalValidateIndex < 0) throw new Error("auto_research_agentic requires final_validate for final-release recovery");
    next.stages.splice(finalValidateIndex, 0,
      releaseAssessment,
      {
        type: "loop",
        id: "final_release_recovery_loop",
        title: "Recover failed final release gates",
        max_rounds: 2,
        stop_when: "final_release_gate_pass >= 1",
        on_exhaustion: "succeed",
        stages: finalReleaseRecoveryChildren,
      },
    );
  }
  next.tool_catalog = [
    {
      ...expand,
      id: "targeted_research_expansion",
      title: "Expand research evidence for an identified coverage gap",
      inputs: [
        ...((expand.inputs as string[] | undefined) ?? []).filter((input) => input !== "reports/remediation-plan.json"),
        "reviews/action-plan.json",
        "reviews/artifact-plan.json",
      ],
      // The adaptive adapter reads reviews/action-plan.json; the fixed v2
      // command continues to read reports/remediation-plan.json.
      command: longwriteCommand(["research", "expand", ".", "--action-plan", "reviews/action-plan.json"]),
      max_invocations: 1,
    },
    {
      id: "reopen_outline",
      title: "Reopen the approved outline for a structural correction",
      owner: "outline-architect",
      inputs: ["reviews/action-plan.json", "reviews/artifact-plan.json", "outline.md", "outline.json", "sources/classified_sources.jsonl", "evidence/source-packets.json", "reports/corpus-gates.md"],
      optional_inputs: ["sources/semantic-screening.json", "reports/evidence-depth-finalization.md", "reviews/scorecard.json"],
      skills: ["reviews/action-plan.json", "outline.json", "sources/classified_sources.jsonl", "evidence/source-packets.json", "reports/corpus-gates.md"],
      instructions: [
        "This action is authorized only because the validated plan selected reopen_outline. Rewrite outline.md and outline.json to repair the named major/critical structural, scope, or taxonomy defect. Use only current classified source IDs and source-packet-backed contributions; make the replacement organizing argument, comparison logic, limitations, and section purposes explicit.",
        "Write feedback/outline-revision.md with the exact action-plan findings addressed, the structural change, and any remaining evidence limitation. Do not draft chapters, alter figures, fabricate sources, or turn an unresolved empirical question into a result. The following scripts re-audit the outline before downstream evidence allocation.",
      ],
      outputs: ["outline.md", "outline.json", "feedback/outline-revision.md"], validators: ["required_output_exists", "non_empty_markdown"],
      requires_human_approval: policy?.outlineApprovalMode === "human",
      max_invocations: 1,
    },
    {
      ...revise,
      id: "revise_sections",
      title: "Revise evidence-backed prose and structure",
      inputs: [
        ...((revise.inputs as string[] | undefined) ?? []).filter((input) => input !== "reports/routing.md"),
        "reviews/action-plan.json",
        "reviews/artifact-plan.json",
      ],
      optional_inputs: [
        ...((revise.optional_inputs as string[] | undefined) ?? []),
        "reports/action-dispatch.json",
      ],
      instructions: [
        ...((revise.instructions as string[] | undefined) ?? []),
        "Use reviews/artifact-plan.json when it selects a formalization. Decide the exact notation and wording from the cited evidence, define every symbol nearby, and omit the formula if the evidence cannot support a useful formalization. Never fabricate an equation, theorem, or experimental result.",
      ],
      max_invocations: 1,
    },
    {
      ...visualPlan,
      id: "revise_visual_plan",
      title: "Repair the placed visual plan from review findings",
      inputs: [
        ...((visualPlan.inputs as string[] | undefined) ?? []),
        "reviews/action-plan.json",
        "reviews/artifact-plan.json",
      ],
      optional_inputs: [
        ...((visualPlan.optional_inputs as string[] | undefined) ?? []),
        "reviews/scorecard.json",
        "reports/action-dispatch.json",
      ],
      instructions: [
        ...((visualPlan.instructions as string[] | undefined) ?? []),
        "Use reviews/action-plan.json, reviews/artifact-plan.json, and reviews/scorecard.json to repair only selected artifact findings. Preserve valid placements. Write a strict figures/placement-plan.json; do not edit manuscript prose, build outputs, or undeclared artifacts. For a substantive method or benchmark table repair, use table_overrides only for method-comparison or benchmark-metadata: each row must have exactly one cell per header and cite one or more existing classified source IDs in source_ids. A validated metadata_plot intent is rendered from verified metadata by the normal artifact builder; do not invent plot values or use Nano Banana as evidence.",
        "For new survey-native artifacts, use table_specs for source-bound comparison/taxonomy/evidence matrices and timelines for source-selected milestones. The builder validates all source IDs and derives timeline years; do not insert raw TeX, chart code, coordinates, or unsupported numerical results.",
      ],
      max_invocations: 1,
    },
    {
      id: "request_operator_clarification",
      title: "Request an operator decision",
      owner: "analyst",
      inputs: ["reviews/action-plan.json"],
      outputs: ["reviews/clarification-request.md"],
      instructions: ["Write the requested operator question from the validated action plan; do not resolve it or change the manuscript."],
      validators: ["required_output_exists", "non_empty_markdown"],
      runtime: "script",
      command: longwriteCommand(["review", "request-clarification", ".", "--action-plan", "reviews/action-plan.json"]),
      requires_operator_response: true,
      max_invocations: 1,
    },
  ];
  if (hasCodebases) {
    const codebaseInputs = ["codebases/manifest.json", "evidence/codebase-context.md", "evidence/codebase-analysis.json", "evidence/codebase-comparison.json"];
    const codebaseInstruction = "Configured repositories are pinned codebase evidence, not scholarly literature. Use evidence/codebase-analysis.json as the validated architecture dossier and inspect its exact file/line locators before making a repository claim. Cite `[codebase:<id>]` or `[codebase:<id>:path#Lx-Ly]`; never claim execution results unless a verified empirical result artifact is supplied.";
    const architectureReviewInstruction = "Evaluate whether the manuscript's architecture, entrypoint, interface, data/control-flow, configuration, trust-boundary, and limitation claims agree with evidence/codebase-analysis.json and its exact locators. Treat missing or contradictory repository grounding as a measurable evidence/structure defect; do not award credit for merely mentioning the repository.";
    const extendCodebaseEvidence = (stage: Record<string, unknown>, instructions: string[] = [codebaseInstruction]): void => {
      stage.optional_inputs = [...new Set([...((stage.optional_inputs as string[] | undefined) ?? []), ...codebaseInputs])];
      stage.skills = [...new Set([...((stage.skills as string[] | undefined) ?? []), ...codebaseInputs])];
      stage.instructions = [...((stage.instructions as string[] | undefined) ?? []), ...instructions];
    };
    const findNestedStage = (id: string, stages: Array<Record<string, unknown>> = next.stages): Record<string, unknown> | undefined => {
      for (const stage of stages) {
        if (stage.id === id) return stage;
        if (Array.isArray(stage.stages)) {
          const found = findNestedStage(id, stage.stages as Array<Record<string, unknown>>);
          if (found) return found;
        }
      }
      return undefined;
    };
    const outline = next.stages.find((stage) => stage.id === "outline");
    if (outline) {
      extendCodebaseEvidence(outline, [codebaseInstruction, ...selectedPaperProfile.promptOverlays.outline]);
    }
    const draftSections = next.stages.find((stage) => stage.id === "draft_sections");
    if (draftSections && Array.isArray(draftSections.steps)) {
      draftSections.steps = draftSections.steps.map((raw) => {
        const step = raw as Record<string, unknown>;
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
      const stage = findNestedStage(id);
      if (stage) extendCodebaseEvidence(stage, [codebaseInstruction, architectureReviewInstruction]);
    }
    for (const id of ["initial_artifact_plan", "baseline_review", "artifact_plan", "action_plan", "review"]) {
      const stage = findNestedStage(id);
      if (stage) extendCodebaseEvidence(stage, [codebaseInstruction, architectureReviewInstruction]);
    }
    for (const id of ["reopen_outline", "revise_sections", "revise_visual_plan"]) {
      const stage = (next.tool_catalog as Array<Record<string, unknown>> | undefined)?.find((candidate) => candidate.id === id);
      if (stage) extendCodebaseEvidence(stage, [codebaseInstruction, architectureReviewInstruction]);
    }
  }
  if (hasExperiment) {
    const experimentInputs = ["evidence/experiment-packets.json", "experiments/verification.json"];
    const experimentInstruction = "The supplied experiment packet is the only empirical-result evidence. Tie an empirical claim to its named comparison, metric, paired seeds, confidence interval, and checksummed artifact. Do not infer results from repository code, runner logs, screenshots, or uncited prose. If the packet lacks support, state the limitation rather than inventing an outcome.";
    const extend = (stage: Record<string, unknown>): Record<string, unknown> => ({
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
        const step = raw as Record<string, unknown>;
        return step.id === "draft" ? extend(step) : step;
      });
    }
    // Review/revision children live inside the quality loop. Supply the same
    // bounded packet to their LLM stages so empirical validity is judged from
    // audited evidence, not from a manifest boolean.
    const loop = next.stages.find((stage) => stage.id === "quality_loop");
    if (loop && Array.isArray(loop.stages)) {
      loop.stages = loop.stages.map((raw) => {
        const stage = raw as Record<string, unknown>;
        return stage.runtime === "script" ? stage : extend(stage);
      });
    }
  }
  // Seed + dry-run is an offline control-plane rehearsal. It has no
  // multimodal worker, so retain visual stages as explicitly skipped rather
  // than pretending that a text fixture inspected rendered PNG pages.
  if (provider === "seed") {
    const disableVisualReview = (stages: Array<Record<string, unknown>>): Array<Record<string, unknown>> => stages.map((stage) => {
      if (Array.isArray(stage.stages)) return { ...stage, stages: disableVisualReview(stage.stages as Array<Record<string, unknown>>) };
      if (["render_visual_review", "visual_review"].includes(String(stage.id))) {
        return { ...stage, enabled: false, skippable: true, disabled_reason: "seed/dry-run rehearsal cannot attach rendered page images to a multimodal reviewer" };
      }
      return stage;
    });
    next.stages = disableVisualReview(next.stages);
  }
  return next;
}

/** Long-form stages that SHOULD be deterministic: assembly and extraction,
 *  never prose. Everything else runs on the LLM worker runtime — MalaClaw's
 *  script runtime is for tooling, not creative writing. */
const LONGFORM_SCRIPT_STAGES: Record<string, Set<string>> = {
  novel: new Set(["build"]),
  technical_book: new Set(["build_examples", "export"]),
};

function withLongformStages(mode: LongWriteModeDef): Record<string, unknown> {
  const workflow = structuredClone(mode.workflow) as { stages: Array<Record<string, unknown>> };
  const draftCommand = mode.id === "novel"
    ? draftNovelCommand()
    : mode.id === "technical_book"
      ? draftTechnicalBookCommand()
      : null;
  if (!draftCommand) return workflow;

  const finalValidator = mode.id === "novel" ? validateNovelCommand() : validateTechnicalBookCommand();
  const scriptStages = LONGFORM_SCRIPT_STAGES[mode.id];

  const mapStage = (stage: Record<string, unknown>): Record<string, unknown> => {
    if (String(stage.type) === "loop" && Array.isArray(stage.stages)) {
      return {
        ...stage,
        stages: stage.stages.map((child) => mapStage(child as Record<string, unknown>)),
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

function isScriptOwned(unit: Record<string, unknown>): boolean {
  return unit.runtime === "script" || typeof unit.command === "object";
}

function applyRuntimeProfile(workflow: Record<string, unknown>, profile?: RuntimeProfileDef): Record<string, unknown> {
  if (!profile) return workflow;
  const next = structuredClone(workflow) as { stages: Array<Record<string, unknown>> } & Record<string, unknown>;
  const profileWorkflow = profile.workflow;
  if (profileWorkflow.runtime_policy) {
    next.runtime_policy = {
      ...((typeof next.runtime_policy === "object" && next.runtime_policy !== null ? next.runtime_policy : {}) as Record<string, unknown>),
      ...profileWorkflow.runtime_policy,
    };
  }
  if (profileWorkflow.model_tiers) {
    next.model_tiers = {
      ...((typeof next.model_tiers === "object" && next.model_tiers !== null ? next.model_tiers : {}) as Record<string, unknown>),
      ...profileWorkflow.model_tiers,
    };
  }

  const applyUnit = (unit: Record<string, unknown>, tier?: string): Record<string, unknown> => {
    if (!tier || isScriptOwned(unit)) return unit;
    return { ...unit, model_tier: tier };
  };

  const mapStage = (stage: Record<string, unknown>): Record<string, unknown> => {
    if (String(stage.type) === "loop" && Array.isArray(stage.stages)) {
      return {
        ...stage,
        stages: stage.stages.map((child) => mapStage(child as Record<string, unknown>)),
      };
    }
    const stageId = String(stage.id);
    let mapped = applyUnit(stage, profileWorkflow.stage_model_tiers[stageId]);
    if (Array.isArray(mapped.steps)) {
      mapped = {
        ...mapped,
        steps: mapped.steps.map((step) => {
          const stepRecord = step as Record<string, unknown>;
          return applyUnit(stepRecord, profileWorkflow.step_model_tiers[String(stepRecord.id)]);
        }),
      };
    }
    return mapped;
  };

  next.stages = next.stages.map(mapStage);
  if (Array.isArray(next.tool_catalog)) {
    next.tool_catalog = next.tool_catalog.map((rawAction) => {
      const action = rawAction as Record<string, unknown>;
      const sourceId = action.id === "targeted_research_expansion"
        ? "expand_research"
        : action.id === "revise_sections"
          ? "revise"
          : action.id === "revise_visual_plan"
            ? "visual_plan"
            : action.id === "request_operator_clarification"
              ? "action_plan"
          : String(action.id);
      return applyUnit(action, profileWorkflow.stage_model_tiers[sourceId]);
    });
  }
  return next;
}

function executionFields(override: CompileStageOverride): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["runtime", "model", "model_tier", "requires_human_approval", "enabled"] as const) {
    if (override[key] !== undefined) out[key] = override[key];
  }
  if (override.enabled === false) out.disabled_reason = "disabled by execution.stage_overrides";
  return out;
}

function applyResearchWorkflowProfile(workflow: Record<string, unknown>, profile: ResearchWorkflowProfile): Record<string, unknown> {
  const definition = researchWorkflowProfileDef(profile);
  const disabled = new Set(definition.disabledStages);
  const mapStage = (stage: Record<string, unknown>): Record<string, unknown> => {
    if (String(stage.type) === "loop" && Array.isArray(stage.stages)) {
      return {
        ...stage,
        ...(String(stage.id) === "quality_loop" ? { max_rounds: definition.maxReviewRounds } : {}),
        stages: stage.stages.map((child) => mapStage(child as Record<string, unknown>)),
      };
    }
    const id = String(stage.id);
    if (!disabled.has(id)) return stage;
    return { ...stage, skippable: true, enabled: false, disabled_reason: `${profile} workflow profile` };
  };
  return { ...workflow, stages: (workflow.stages as Array<Record<string, unknown>>).map(mapStage) };
}

/** Apply persistent user overrides after the mode transforms and runtime
 * profile. This is deliberately structural: IDs must name real generated
 * units, and script/loop/foreach constraints are rejected before a manifest
 * reaches MalaClaw. */
function applyStageOverrides(
  workflow: Record<string, unknown>,
  overrides: Record<string, CompileStageOverride> | undefined,
): Record<string, unknown> {
  if (!overrides || Object.keys(overrides).length === 0) return workflow;
  const pending = new Set(Object.keys(overrides));

  const applyStandard = (stage: Record<string, unknown>, key: string): Record<string, unknown> => {
    const override = overrides[key];
    if (!override) return stage;
    pending.delete(key);
    if (isScriptOwned(stage) && (override.runtime || override.model || override.model_tier)) {
      throw new Error(`execution.stage_overrides.${key}: deterministic script stages cannot override runtime/model`);
    }
    if (override.max_parallel !== undefined) {
      throw new Error(`execution.stage_overrides.${key}: max_parallel is only valid on a foreach stage`);
    }
    return { ...stage, ...executionFields(override) };
  };

  const mapStage = (stage: Record<string, unknown>, parent?: string): Record<string, unknown> => {
    const id = String(stage.id);
    const key = parent ? `${parent}.${id}` : id;
    if (String(stage.type) === "loop" && Array.isArray(stage.stages)) {
      if (overrides[key]) {
        throw new Error(`execution.stage_overrides.${key}: loop groups are not executable; override their child stages`);
      }
      return { ...stage, stages: stage.stages.map((child) => mapStage(child as Record<string, unknown>, key)) };
    }
    if (Array.isArray(stage.steps)) {
      const groupOverride = overrides[key];
      if (groupOverride) {
        pending.delete(key);
        if (groupOverride.runtime || groupOverride.model || groupOverride.model_tier || groupOverride.requires_human_approval !== undefined) {
          throw new Error(`execution.stage_overrides.${key}: foreach execution settings belong to inner steps`);
        }
        stage = { ...stage, ...(groupOverride.max_parallel !== undefined ? { max_parallel: groupOverride.max_parallel } : {}) };
      }
      return {
        ...stage,
        steps: (stage.steps as Array<Record<string, unknown>>)
          .map((rawStep) => applyStandard(rawStep, `${key}.${String(rawStep.id)}`)),
      };
    }
    return applyStandard(stage, key);
  };

  const next = structuredClone(workflow) as { stages: Array<Record<string, unknown>> } & Record<string, unknown>;
  next.stages = next.stages.map((stage) => mapStage(stage));
  if (pending.size > 0) throw new Error(`Unknown execution.stage_overrides: ${[...pending].sort().join(", ")}`);
  return next;
}

/** Compile a writing mode into a MalaClaw manifest object.
 *  The workflow block passes through verbatim, plus mode/artifact metadata.
 *  MalaClaw validates workflow correctness. */
export function compileModeToManifest(
  mode: LongWriteModeDef,
  opts: CompileOptions,
): Record<string, unknown> {
  const baseWorkflow = isResearchMode(mode)
    ? withResearchScriptStages(mode, opts.topic, opts.researchProvider ?? "seed", opts.researchPolicy)
    : withLongformStages(mode);
  const profiledWorkflow = isResearchMode(mode)
    ? applyResearchWorkflowProfile(baseWorkflow, opts.researchPolicy?.workflowProfile ?? mode.default_workflow_profile ?? "standard")
    : baseWorkflow;
  const adaptiveWorkflow = isResearchMode(mode)
    ? withAgenticResearchStages(profiledWorkflow, opts.researchPolicy, opts.researchProvider ?? "seed")
    : profiledWorkflow;
  const workflow = applyStageOverrides(applyRuntimeProfile(adaptiveWorkflow, opts.runtimeProfile), opts.stageOverrides);
  return {
    version: 1,
    runtime: opts.runtimeProfile?.agent_runtime ?? mode.default_runtime.agent_runtime,
    project: {
      id: opts.projectId,
      name: opts.projectName ?? opts.projectId,
      description: opts.topic ? `${mode.name} project: ${opts.topic}` : mode.description,
      entry_team: mode.entry_team,
    },
    packs: [{ id: mode.pack }],
    workflow: {
      mode: mode.id,
      artifact_type: mode.artifact_type,
      ...(opts.runLimits ? { run_limits: opts.runLimits } : {}),
      ...workflow,
    },
  };
}

export function manifestToYaml(manifest: Record<string, unknown>): string {
  return stringifyYaml(manifest);
}
