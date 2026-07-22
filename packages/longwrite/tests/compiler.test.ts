import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { compileModeToManifest, manifestToYaml } from "../src/lib/compiler.js";
import { loadMode } from "../src/lib/modes.js";
import { loadRuntimeProfile } from "../src/lib/runtime-profiles.js";

function childStage(
  stages: Array<Record<string, unknown>>,
  loopId: string,
  childId: string,
): Record<string, unknown> | undefined {
  const loop = stages.find((s) => s.id === loopId) as { stages?: Array<Record<string, unknown>> } | undefined;
  return loop?.stages?.find((s) => s.id === childId);
}

describe("compileModeToManifest", () => {
  it("compiles auto_research_agentic into a MalaClaw manifest", async () => {
    const mode = await loadMode("auto_research_agentic");
    const manifest = compileModeToManifest(mode, {
      projectId: "agent-memory-survey",
      projectName: "Agent Memory Survey",
      topic: "Long-horizon agent memory",
      researchProvider: "seed",
    });

    expect(manifest.runtime).toBe("codex");
    expect(manifest.packs).toEqual([{ id: "manuscript-writing" }]);
    expect((manifest.workflow as Record<string, unknown>).mode).toBe("auto_research_agentic");
    expect((manifest.workflow as Record<string, unknown>).artifact_type).toBe("research_paper");
    expect(((manifest.workflow as { stages: Array<{ id: string }> }).stages).map((s) => s.id))
      .toEqual(mode.workflow.stages.map((s: unknown) => (s as { id: string }).id));
    expect((manifest.project as { description: string }).description).toContain("Long-horizon agent memory");
    const stages = (manifest.workflow as { stages: Array<{ id: string; runtime?: string; command?: { cmd: string; args: string[] } }> }).stages;
    // The three research stages run SEPARATE idempotent subcommands — not
    // `research prepare` three times over.
    const expectedResearch: Record<string, string[]> = {
      recall: ["research", "recall", ".", "--topic", "Long-horizon agent memory", "--provider", "seed", "--target-candidates", "240", "--query-budget", "30"],
      score: ["research", "score", "."],
      classify: ["research", "classify", ".", "--topic", "Long-horizon agent memory"],
    };
    for (const [id, expectedArgs] of Object.entries(expectedResearch)) {
      const stage = stages.find((s) => s.id === id);
      expect(stage?.runtime).toBe("script");
      expect(stage?.command?.cmd).toBe(process.execPath);
      expect(stage?.command?.args.slice(1)).toEqual(expectedArgs);
    }
    const draft = stages.find((s) => s.id === "draft_sections") as
      | { steps: Array<{ id: string; runtime?: string; command?: { args: string[] } }> }
      | undefined;
    expect(draft?.steps.find((s) => s.id === "draft")?.runtime).toBe("script");
    expect(draft?.steps.find((s) => s.id === "draft")?.command?.args).toEqual(expect.arrayContaining(["draft", "section", "."]));

    const qualityLoop = stages.find((s) => s.id === "quality_loop") as
      | { type?: string; max_rounds?: number; stop_when?: string; stop_on_stagnation?: unknown; on_exhaustion?: string; stages?: Array<Record<string, unknown>> }
      | undefined;
    expect(qualityLoop?.type).toBe("loop");
    // The agentic mode defaults to the deep profile (5 bounded rounds).
    expect(qualityLoop?.max_rounds).toBe(5);
    expect(qualityLoop?.stop_when).toBe("review_score >= 8.0");
    expect(qualityLoop?.stop_on_stagnation).toBeUndefined();
    expect(qualityLoop?.on_exhaustion).toBe("succeed");

    // The fixed router/revise children are replaced by the validated
    // plan -> allowlisted dispatch chain. Contract repair runs as validator
    // feedback within the LLM attempt, rather than as a terminal child stage.
    expect(childStage(stages as unknown as Array<Record<string, unknown>>, "quality_loop", "route")).toBeUndefined();
    const actionPlan = childStage(stages as unknown as Array<Record<string, unknown>>, "quality_loop", "action_plan") as
      | { validator_commands?: Array<{ args: string[] }> }
      | undefined;
    expect(actionPlan?.validator_commands?.[0]?.args).toEqual(expect.arrayContaining(["review", "repair-action-plan", "."]));

    // The static expand_research child is replaced by the allowlisted
    // research dispatch, which materializes a targeted expansion on demand.
    expect(childStage(stages as unknown as Array<Record<string, unknown>>, "quality_loop", "expand_research")).toBeUndefined();
    const researchDispatch = childStage(stages as unknown as Array<Record<string, unknown>>, "quality_loop", "research_action_dispatch") as
      | { type?: string; allowed_actions?: string[] }
      | undefined;
    expect(researchDispatch?.type).toBe("action_dispatch");
    expect(researchDispatch?.allowed_actions).toEqual(["targeted_research_expansion"]);

    const claimScore = childStage(stages as unknown as Array<Record<string, unknown>>, "quality_loop", "claim_score") as
      | { runtime?: string; command?: { args: string[] } }
      | undefined;
    expect(claimScore?.runtime).toBe("script");
    expect(claimScore?.command?.args).toEqual(expect.arrayContaining(["review", "claims", "."]));

    const build = childStage(stages as unknown as Array<Record<string, unknown>>, "quality_loop", "rebuild") as
      | { runtime?: string; command?: { cmd: string; args: string[] }; validator_commands?: Array<{ cmd: string; args: string[] }> }
      | undefined;
    expect(build?.runtime).toBe("script");
    expect(build?.command?.args).toEqual(expect.arrayContaining(["build", "research", "."]));
    expect(build?.validator_commands).toHaveLength(2);
    expect(build?.validator_commands?.[0].args).toEqual(expect.arrayContaining(["validate", "figures", "."]));
    expect(build?.validator_commands?.[1].args).toEqual(expect.arrayContaining(["validate", "latex", "."]));

    const initialBuild = stages.find((s) => s.id === "initial_build") as
      | { runtime?: string; command?: { args: string[] }; validator_commands?: Array<{ args: string[] }> }
      | undefined;
    expect(initialBuild?.runtime).toBe("script");
    expect(initialBuild?.command?.args).toEqual(expect.arrayContaining(["build", "research", "."]));
    expect(initialBuild?.validator_commands).toHaveLength(2);

    const consolidate = childStage(stages as unknown as Array<Record<string, unknown>>, "quality_loop", "consolidate_citations") as
      | { runtime?: string; command?: { args: string[] } }
      | undefined;
    expect(consolidate?.runtime).toBe("script");
    expect(consolidate?.command?.args).toEqual(expect.arrayContaining(["evidence", "consolidate", "."]));

    const assess = stages.find((s) => s.id === "assess");
    expect(assess?.runtime).toBe("script");
    expect(assess?.command?.args).toEqual(expect.arrayContaining(["research", "assess", "."]));

    const verify = stages.find((s) => s.id === "verify_citations");
    expect(verify?.command?.args).toEqual(expect.arrayContaining(["research", "verify", "."]));

    const finalValidate = stages.find((s) => s.id === "final_validate") as
      | { runtime?: string; command?: { args: string[] } }
      | undefined;
    expect(finalValidate?.runtime).toBe("script");
    expect(finalValidate?.command?.args).toEqual(expect.arrayContaining(["validate", "research", "."]));

    const roundTrip = parseYaml(manifestToYaml(manifest));
    expect(roundTrip.workflow.stages).toHaveLength(mode.workflow.stages.length);
  });

  it("gates the LLM evidence-refresh stages on a dispatched expansion", async () => {
    const mode = await loadMode("auto_research_agentic");
    const manifest = compileModeToManifest(mode, {
      projectId: "survey",
      topic: "Long-horizon agent memory",
      researchProvider: "semantic_scholar",
      researchPolicy: {
        targetCandidates: 400, queryBudget: 50, taxonomy: ["memory", "planning"], fulltextMaxSources: 100,
        allowPdfDownload: true, semanticScreenEnabled: true, outlineReviewEnabled: true, outlineReviewMaxRounds: 2, verificationMaxSources: 100, writingStrategy: "llm_sections",
      },
    });
    const stages = (manifest.workflow as { stages: Array<Record<string, unknown>> }).stages;

    // A deterministic script step emits the gate metric right after dispatch.
    const dispatchMetrics = childStage(stages, "quality_loop", "quality_dispatch_metrics") as
      | { runtime?: string; command?: { args: string[] }; outputs?: string[] }
      | undefined;
    expect(dispatchMetrics?.runtime).toBe("script");
    expect(dispatchMetrics?.command?.args).toEqual(expect.arrayContaining(["research", "dispatch-metrics", "."]));
    expect(dispatchMetrics?.outputs).toContain("reports/metrics.json");

    // Every refresh stage is skipped unless an expansion was actually dispatched,
    // so the no-op "preserve" contradiction that produced stale_attempt_output is
    // gone. The two model stages must carry the gate and drop the preserve prompt.
    for (const id of ["quality_semantic_screen", "quality_source_evidence_extract"]) {
      const stage = childStage(stages, "quality_loop", id) as
        | { when?: string; instructions?: string[] }
        | undefined;
      expect(stage?.when).toBe("research_expansion_dispatched >= 1");
      expect((stage?.instructions ?? []).join(" ")).not.toContain("preserve");
    }

    // The same refresh stages are replayed in the final-release recovery loop.
    // recoveryWhen must NOT clobber their dispatch gate, or a no-op recovery
    // round would reintroduce the stale_attempt_output failure.
    const recovery = stages.find((s) => s.id === "final_release_recovery_loop") as
      | { stages?: Array<Record<string, unknown>> }
      | undefined;
    const recoveryStages = recovery?.stages ?? [];
    expect(recoveryStages.find((s) => s.id === "quality_dispatch_metrics")).toBeDefined();
    for (const id of ["quality_semantic_screen", "quality_source_evidence_extract"]) {
      const stage = recoveryStages.find((s) => s.id === id) as { when?: string } | undefined;
      expect(stage?.when).toBe("research_expansion_dispatched >= 1");
    }
  });

  it("does not inject research script commands without a topic", async () => {
    const mode = await loadMode("auto_research_agentic");
    const manifest = compileModeToManifest(mode, { projectId: "survey" });
    const stages = (manifest.workflow as { stages: Array<{ id: string; runtime?: string; command?: unknown }> }).stages;
    expect(stages.find((s) => s.id === "recall")?.command).toBeUndefined();
  });

  it("compiles the selected research provider into research script stages", async () => {
    const mode = await loadMode("auto_research_agentic");
    const manifest = compileModeToManifest(mode, {
      projectId: "survey",
      topic: "Long-horizon agent memory",
      researchProvider: "semantic_scholar",
    });
    const stages = (manifest.workflow as { stages: Array<{ id: string; command?: { args: string[] } }> }).stages;
    const recall = stages.find((s) => s.id === "recall");
    expect(recall?.command?.args).toEqual(expect.arrayContaining(["--provider", "semantic_scholar"]));
  });

  it("compiles safe fast/standard/deep workflow breadth profiles", async () => {
    const mode = await loadMode("auto_research_agentic");
    const compile = (workflowProfile: "fast" | "standard" | "deep") => compileModeToManifest(mode, {
      projectId: `survey-${workflowProfile}`,
      topic: "Long-horizon agent memory",
      researchPolicy: {
        workflowProfile, targetCandidates: 100, queryBudget: 12, taxonomy: [], fulltextMaxSources: 20,
        allowPdfDownload: true, verificationMaxSources: 30, writingStrategy: "scaffold_then_revise",
      },
    }).workflow as { stages: Array<Record<string, unknown>> };
    const fast = compile("fast");
    const standard = compile("standard");
    const deep = compile("deep");
    for (const workflow of [fast, standard]) {
      expect(workflow.stages.find((stage) => stage.id === "snowball_recall")).toMatchObject({ enabled: false, skippable: true });
      expect(workflow.stages.find((stage) => stage.id === "venue_upgrade")).toMatchObject({ enabled: false, skippable: true });
    }
    expect(fast.stages.find((stage) => stage.id === "structure_audit")).toMatchObject({ enabled: false, skippable: true });
    expect(deep.stages.find((stage) => stage.id === "snowball_recall")?.enabled).not.toBe(false);
    const deepLoop = deep.stages.find((stage) => stage.id === "quality_loop") as { max_rounds?: number };
    expect(deepLoop.max_rounds).toBe(5);
  });

  it("compiles full auto_research_agentic with mandatory breadth and provenance gates", async () => {
    const mode = await loadMode("auto_research_agentic");
    const manifest = compileModeToManifest(mode, {
      projectId: "full-survey",
      topic: "Long-horizon agent memory",
      researchProvider: "multi",
      researchPolicy: {
        targetCandidates: 400, queryBudget: 50, taxonomy: ["memory", "planning"], fulltextMaxSources: 100,
        allowPdfDownload: true, verificationMaxSources: 100, writingStrategy: "scaffold_then_revise", semanticScreenEnabled: true,
      },
    });
    const workflow = manifest.workflow as { mode: string; stages: Array<Record<string, unknown>> };
    expect(workflow.mode).toBe("auto_research_agentic");
    // Full mode defaults to the deep profile: all breadth stages enabled.
    expect(workflow.stages.find((stage) => stage.id === "snowball_recall")?.enabled).not.toBe(false);
    expect(workflow.stages.find((stage) => stage.id === "venue_upgrade")?.enabled).not.toBe(false);
    expect(workflow.stages.find((stage) => stage.id === "structure_audit")?.enabled).not.toBe(false);
    expect(workflow.stages.find((stage) => stage.id === "identity_reconcile")?.command).toMatchObject({
      args: expect.arrayContaining(["research", "reconcile-identities", "."]),
    });
    expect(workflow.stages.find((stage) => stage.id === "corpus_gates")?.command).toMatchObject({
      args: expect.arrayContaining(["research", "corpus-gates", "."]),
    });
    const recovery = workflow.stages.find((stage) => stage.id === "corpus_evidence_recovery_loop") as
      | { type?: string; max_rounds?: number; stop_when?: string; on_exhaustion?: string; stages?: Array<Record<string, unknown>> }
      | undefined;
    expect(recovery?.type).toBe("loop");
    expect(recovery?.max_rounds).toBe(2);
    expect(recovery?.stop_when).toBe("corpus_gate_pass >= 1");
    expect(recovery?.on_exhaustion).toBe("fail");
    const recoveryPlan = recovery?.stages?.find((stage) => stage.id === "corpus_recovery_plan") as
      | { when?: string; validator_commands?: Array<{ args: string[] }> }
      | undefined;
    expect(recoveryPlan?.when).toBe("corpus_gate_pass < 1");
    expect(recoveryPlan?.validator_commands?.[0]?.args).toEqual(expect.arrayContaining(["research", "repair-corpus-recovery-plan", "."]));
    expect(workflow.stages.find((stage) => stage.id === "survey_contract")?.command).toMatchObject({
      args: expect.arrayContaining(["research", "survey-contract", "."]),
    });
    const qualityLoop = workflow.stages.find((stage) => stage.id === "quality_loop") as { stages: Array<Record<string, unknown>> };
    expect(qualityLoop.stages.find((stage) => stage.id === "claim_judgment_repair")).toBeUndefined();
    expect(qualityLoop.stages.find((stage) => stage.id === "claim_judge")?.validator_commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ args: expect.arrayContaining(["review", "repair-claims", "."]) }),
    ]));
    const releaseAssessment = workflow.stages.find((stage) => stage.id === "final_release_assessment") as
      | { command?: { args: string[] } }
      | undefined;
    expect(releaseAssessment?.command?.args).toEqual(expect.arrayContaining(["validate", "research", ".", "--advisory"]));
    const releaseRecovery = workflow.stages.find((stage) => stage.id === "final_release_recovery_loop") as
      | { type?: string; max_rounds?: number; stop_when?: string; stages?: Array<Record<string, unknown>> }
      | undefined;
    expect(releaseRecovery).toMatchObject({ type: "loop", max_rounds: 2, stop_when: "final_release_gate_pass >= 1" });
    const releasePlan = releaseRecovery?.stages?.find((stage) => stage.id === "final_release_plan") as
      | { when?: string; validator_commands?: Array<{ args: string[] }> }
      | undefined;
    expect(releasePlan?.when).toBe("final_release_gate_pass < 1");
    expect(releasePlan?.validator_commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ args: expect.arrayContaining(["research", "repair-final-release-plan", "."]) }),
    ]));
  });

  it("adds a pinned codebase-evidence stage only when repositories are configured", async () => {
    const mode = await loadMode("auto_research_agentic");
    const manifest = compileModeToManifest(mode, {
      projectId: "codebase-survey",
      topic: "LongExperiment architecture",
      researchProvider: "multi",
      researchPolicy: {
        targetCandidates: 100, queryBudget: 12, taxonomy: [], fulltextMaxSources: 20,
        allowPdfDownload: true, verificationMaxSources: 30, writingStrategy: "llm_sections",
        codebases: [{ id: "longexperiment", source: "https://github.com/example/longexperiment.git", ref: "v0.1.0", role: "primary_artifact" }],
      },
    });
    const workflow = manifest.workflow as { stages: Array<Record<string, unknown>> };
    const stage = workflow.stages.find((item) => item.id === "codebase_prepare") as { command?: { args: string[] } } | undefined;
    expect(stage?.command?.args).toEqual(expect.arrayContaining(["research", "codebases", "."]));
    expect(workflow.stages.find((item) => item.id === "codebase_architecture_analysis")?.outputs)
      .toEqual(expect.arrayContaining(["evidence/codebase-analysis.raw.json"]));
    expect(workflow.stages.find((item) => item.id === "codebase_architecture_analysis_repair")).toBeUndefined();
    expect(workflow.stages.find((item) => item.id === "codebase_architecture_analysis")?.validator_commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ args: expect.arrayContaining(["research", "repair-codebase-analysis", "."]) }),
    ]));
    expect(workflow.stages.map((item) => item.id).indexOf("codebase_prepare"))
      .toBeGreaterThan(workflow.stages.map((item) => item.id).indexOf("search_planner"));
    const outline = workflow.stages.find((item) => item.id === "outline");
    expect(outline?.optional_inputs).toEqual(expect.arrayContaining(["codebases/manifest.json", "evidence/codebase-context.md", "evidence/codebase-analysis.json"]));
    const baseline = workflow.stages.find((item) => item.id === "baseline_review");
    expect(baseline?.optional_inputs).toEqual(expect.arrayContaining(["evidence/codebase-analysis.json"]));
    const qualityLoop = workflow.stages.find((item) => item.id === "quality_loop") as { stages: Array<Record<string, unknown>> };
    expect(qualityLoop.stages.find((item) => item.id === "artifact_plan")?.optional_inputs)
      .toEqual(expect.arrayContaining(["evidence/codebase-analysis.json"]));
    expect(qualityLoop.stages.find((item) => item.id === "review")?.instructions)
      .toEqual(expect.arrayContaining([expect.stringContaining("architecture, entrypoint, interface") ]));
    const toolCatalog = (workflow as { tool_catalog?: Array<Record<string, unknown>> }).tool_catalog ?? [];
    expect(toolCatalog.find((item) => item.id === "reopen_outline")?.optional_inputs)
      .toEqual(expect.arrayContaining(["evidence/codebase-analysis.json"]));
  });

  it("tailors the visual-plan contract for a repository-study paper", async () => {
    const mode = await loadMode("auto_research_agentic");
    const manifest = compileModeToManifest(mode, {
      projectId: "repo-study", topic: "System architecture", researchProvider: "multi",
      researchPolicy: {
        targetCandidates: 80, queryBudget: 12, taxonomy: [], paperProfile: "repository_study",
        codebases: [{ id: "repo-system", source: "https://github.com/example/system.git", ref: "HEAD", role: "primary_artifact" }],
        fulltextMaxSources: 20, allowPdfDownload: true, verificationMaxSources: 30, writingStrategy: "llm_sections",
      },
    });
    const stages = (manifest.workflow as { stages: Array<Record<string, unknown>> }).stages;
    const visualPlan = stages.find((stage) => stage.id === "visual_plan");
    expect(visualPlan?.optional_inputs).toEqual(expect.arrayContaining(["evidence/codebase-context.md"]));
    expect(visualPlan?.instructions).toEqual(expect.arrayContaining([expect.stringContaining("system architecture diagram")]));
  });

  it("adds GitHub discovery, bounded semantic screening, and selection repair when configured", async () => {
    const mode = await loadMode("auto_research_agentic");
    const manifest = compileModeToManifest(mode, {
      projectId: "github-discovery-survey",
      topic: "Agent memory repositories",
      researchProvider: "multi",
      researchPolicy: {
        targetCandidates: 100, queryBudget: 12, taxonomy: [], fulltextMaxSources: 20,
        allowPdfDownload: true, verificationMaxSources: 30, writingStrategy: "llm_sections",
        codebaseDiscovery: { enabled: true, queryBudget: 4, maxCandidates: 20, maxReadmeFetches: 8, maxSelected: 4, requireLicense: true, includeArchived: false, languages: ["TypeScript"] },
      },
    });
    const stages = (manifest.workflow as { stages: Array<Record<string, unknown>> }).stages;
    expect(stages.map((stage) => stage.id)).toEqual(expect.arrayContaining([
      "github_codebase_recall", "github_codebase_screen", "codebase_prepare",
      "codebase_architecture_analysis",
    ]));
    expect(stages.find((stage) => stage.id === "github_codebase_recall")?.command).toMatchObject({
      args: expect.arrayContaining(["research", "github-codebase-recall", "."]),
    });
    expect(stages.find((stage) => stage.id === "codebase_prepare")?.inputs).toEqual(expect.arrayContaining(["codebases/github-selection.json"]));
  });

  it("requires a GitHub selection in a discovery-only repository-study prompt", async () => {
    const mode = await loadMode("auto_research_agentic");
    const manifest = compileModeToManifest(mode, {
      projectId: "repo-discovery", topic: "Repository architecture", researchProvider: "multi",
      researchPolicy: {
        targetCandidates: 80, queryBudget: 12, taxonomy: [], paperProfile: "repository_study", fulltextMaxSources: 20,
        allowPdfDownload: true, verificationMaxSources: 30, writingStrategy: "llm_sections",
        codebaseDiscovery: { enabled: true, queryBudget: 4, maxCandidates: 20, maxReadmeFetches: 8, maxSelected: 4, requireLicense: true, includeArchived: false, languages: [] },
      },
    });
    const stages = (manifest.workflow as { stages: Array<Record<string, unknown>> }).stages;
    const screen = stages.find((stage) => stage.id === "github_codebase_screen") as { instructions?: string[] } | undefined;
    expect(screen?.instructions).toEqual(expect.arrayContaining([expect.stringContaining("empty selection is invalid")]));
  });

  it("compiles the agentic mode with a bounded remediation dispatcher", async () => {
    const mode = await loadMode("auto_research_agentic");
    const manifest = compileModeToManifest(mode, {
      projectId: "agentic-survey",
      topic: "Long-horizon agent memory",
      researchProvider: "multi",
      researchPolicy: {
        targetCandidates: 400, queryBudget: 50, taxonomy: ["memory", "planning"], fulltextMaxSources: 100,
        allowPdfDownload: true, semanticScreenEnabled: true, outlineReviewEnabled: true, outlineReviewMaxRounds: 2, verificationMaxSources: 100, writingStrategy: "llm_sections",
      },
    });
    const workflow = manifest.workflow as {
      mode: string;
      tool_catalog?: Array<Record<string, unknown>>;
      stages: Array<Record<string, unknown>>;
    };
    expect(workflow.mode).toBe("auto_research_agentic");
    const ids = workflow.stages.map((stage) => stage.id);
    expect(ids).toEqual(expect.arrayContaining([
      "semantic_candidate_select", "semantic_screen",
      "source_evidence_candidate_select", "source_evidence_extract", "finalize_evidence_depth",
    ]));
    expect(ids.indexOf("corpus_gates")).toBeGreaterThan(ids.indexOf("finalize_evidence_depth"));
    expect(workflow.stages.find((stage) => stage.id === "semantic_screen")?.outputs).toEqual(expect.arrayContaining([
      "sources/semantic-screening.json", "reports/semantic-screen-repair.md",
    ]));
    expect(workflow.stages.find((stage) => stage.id === "semantic_screen")?.validator_commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ args: expect.arrayContaining(["research", "repair-semantic-screen", "."]) }),
    ]));
    expect(workflow.stages.find((stage) => stage.id === "semantic_screen")?.instructions).toEqual(expect.arrayContaining([
      expect.stringContaining("chapter_role is protagonist, comparison, background, or exclude"),
    ]));
    expect(workflow.stages.find((stage) => stage.id === "source_evidence_extract")?.validator_commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ args: expect.arrayContaining(["research", "repair-source-evidence", "."]) }),
    ]));
    expect(workflow.stages.find((stage) => stage.id === "finalize_evidence_depth")?.command).toMatchObject({
      args: expect.arrayContaining(["research", "finalize-evidence-depth", "."]),
    });
    const outline = workflow.stages.find((stage) => stage.id === "outline");
    expect(outline?.requires_human_approval).toBe(false);
    expect((outline?.skills as string[])).toContain("evidence/source-packets.json");
    const outlineLoop = workflow.stages.find((stage) => stage.id === "outline_quality_loop") as { max_rounds: number; stages: Array<Record<string, unknown>> };
    expect(outlineLoop.max_rounds).toBe(2);
    expect(outlineLoop.stages.map((stage) => stage.id)).toEqual(["outline_survey_contract", "outline_structure_audit", "outline_review", "outline_readiness_score", "outline_revise"]);
    expect(workflow.stages.find((stage) => stage.id === "outline_approval_gate")).toMatchObject({ requires_human_approval: false });
    expect(ids.indexOf("initial_artifact_plan")).toBeLessThan(ids.indexOf("visual_plan"));
    expect(workflow.stages.find((stage) => stage.id === "initial_artifact_plan_repair")).toBeUndefined();
    expect(workflow.stages.find((stage) => stage.id === "initial_artifact_plan")?.validator_commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ args: expect.arrayContaining(["review", "repair-artifact-plan", "."]) }),
    ]));
    const initialDraft = workflow.stages.find((stage) => stage.id === "draft_sections") as { steps: Array<Record<string, unknown>> };
    expect(initialDraft.steps.find((step) => step.id === "draft")?.inputs).toEqual(expect.arrayContaining(["reviews/artifact-plan.json"]));
    const loop = workflow.stages.find((stage) => stage.id === "quality_loop") as { stages: Array<Record<string, unknown>> };
    expect(loop.stages.slice(0, 4).map((stage) => stage.id)).toEqual(["artifact_plan", "action_plan", "action_plan_split", "research_action_dispatch"]);
    expect(loop.stages.slice(4, 13).map((stage) => stage.id)).toEqual([
      "quality_dispatch_metrics", "quality_semantic_screen", "quality_fulltext_refresh",
      "quality_evidence_index_refresh", "quality_source_evidence_candidate_select", "quality_source_evidence_extract",
      "quality_finalize_evidence_depth", "quality_corpus_gates", "quality_allocate_evidence",
    ]);
    expect(loop.stages.slice(13, 18).map((stage) => stage.id)).toEqual([
      "outline_action_dispatch",
      "quality_outline_survey_contract", "quality_outline_structure_audit",
      "quality_outline_reopen_validate", "quality_reallocate_outline_evidence",
    ]);
    expect(loop.stages.find((stage) => stage.id === "quality_source_evidence_extract")?.instructions).toEqual(expect.arrayContaining([
      expect.stringContaining("dispatched this round"),
    ]));
    expect(loop.stages.find((stage) => stage.id === "quality_source_evidence_extract")?.validator_commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ args: expect.arrayContaining(["research", "repair-source-evidence", "."]) }),
    ]));
    expect(loop.stages.find((stage) => stage.id === "artifact_plan_repair")).toBeUndefined();
    expect(loop.stages.find((stage) => stage.id === "artifact_plan")?.validator_commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ args: expect.arrayContaining(["review", "repair-artifact-plan", "."]) }),
    ]));
    expect(loop.stages.find((stage) => stage.id === "artifact_plan")?.instructions).toEqual(expect.arrayContaining([
      expect.stringContaining("timeline, architecture_diagram"),
    ]));
    expect(loop.stages.find((stage) => stage.id === "action_plan")?.instructions).toEqual(expect.arrayContaining([
      expect.stringContaining("may co-occur with targeted_research_expansion"),
    ]));
    expect(loop.stages.find((stage) => stage.id === "action_plan_repair")).toBeUndefined();
    expect(loop.stages.find((stage) => stage.id === "action_plan")?.validator_commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ args: expect.arrayContaining(["review", "repair-action-plan", "."]) }),
    ]));
    expect(loop.stages.find((stage) => stage.id === "route")).toBeUndefined();
    expect(loop.stages.find((stage) => stage.id === "expand_research")).toBeUndefined();
    expect(loop.stages.find((stage) => stage.id === "revise")).toBeUndefined();
    expect(loop.stages.find((stage) => stage.id === "research_action_dispatch")).toMatchObject({
      type: "action_dispatch",
      max_actions: 1,
      allowed_actions: ["targeted_research_expansion"],
    });
    expect(loop.stages.find((stage) => stage.id === "action_dispatch")).toMatchObject({
      type: "action_dispatch",
      max_actions: 3,
      allowed_actions: ["revise_sections", "revise_visual_plan", "request_operator_clarification"],
    });
    const expansion = workflow.tool_catalog?.find((action) => action.id === "targeted_research_expansion");
    expect(expansion?.command).toMatchObject({ args: expect.arrayContaining(["research", "expand", ".", "--action-plan", "reviews/action-plan.json"]) });
    expect(expansion?.inputs).toEqual(expect.arrayContaining(["reviews/action-plan.json", "reviews/artifact-plan.json"]));
    const reopen = workflow.tool_catalog?.find((action) => action.id === "reopen_outline");
    expect(reopen?.outputs).toEqual(["outline.md", "outline.json", "feedback/outline-revision.md"]);
    expect(reopen?.requires_human_approval).toBe(false);
    expect(loop.stages.find((stage) => stage.id === "quality_outline_reopen_validate")?.command).toMatchObject({
      args: expect.arrayContaining(["review", "validate-outline-reopen", "."]),
    });
    const revise = workflow.tool_catalog?.find((action) => action.id === "revise_sections");
    expect(revise?.inputs).toEqual(expect.arrayContaining(["reviews/action-plan.json", "reviews/artifact-plan.json"]));
    expect(workflow.tool_catalog?.find((action) => action.id === "revise_visual_plan")?.outputs).toEqual(["figures/placement-plan.json"]);
    expect(workflow.tool_catalog?.find((action) => action.id === "request_operator_clarification")).toMatchObject({
      requires_operator_response: true,
      command: { args: expect.arrayContaining(["review", "request-clarification", "."]) },
    });
  });

  it("can promote evidence-backed foreach drafting to the selected LLM runtime", async () => {
    const mode = await loadMode("auto_research_agentic");
    const runtimeProfile = await loadRuntimeProfile("codex_first");
    const manifest = compileModeToManifest(mode, {
      projectId: "survey",
      topic: "Long-horizon agent memory",
      runtimeProfile,
      researchPolicy: {
        targetCandidates: 100, queryBudget: 24, taxonomy: [], fulltextMaxSources: 40,
        allowPdfDownload: true, verificationMaxSources: 30, writingStrategy: "llm_sections",
      },
    });
    const stages = (manifest.workflow as { stages: Array<Record<string, unknown>> }).stages;
    const draft = stages.find((stage) => stage.id === "draft_sections") as { steps: Array<Record<string, unknown>> };
    const writer = draft.steps.find((step) => step.id === "draft")!;
    expect(writer.runtime).toBeUndefined();
    expect(writer.command).toBeUndefined();
    expect(writer.inputs).toContain("project_brief.md");
    expect(writer.skills).toContain("project_brief.md");
    expect(writer.model_tier).toBe("executor");
    expect(writer.skills).toContain("evidence/section-{{section.id}}.json");
  });

  it("applies the codex_first runtime profile without overriding script-owned stages", async () => {
    const mode = await loadMode("auto_research_agentic");
    const runtimeProfile = await loadRuntimeProfile("codex_first");
    const manifest = compileModeToManifest(mode, {
      projectId: "survey",
      topic: "Long-horizon agent memory",
      researchProvider: "seed",
      runtimeProfile,
    });
    expect(manifest.runtime).toBe("codex");
    const workflow = manifest.workflow as { runtime_policy?: { primary?: string }; model_tiers?: Record<string, unknown>; stages: Array<Record<string, unknown>> };
    expect(workflow.runtime_policy?.primary).toBe("codex");
    expect(Object.keys(workflow.model_tiers ?? {})).toEqual(expect.arrayContaining(["advisor", "reviewer", "executor"]));
    expect(workflow.stages.find((s) => s.id === "intake")?.model_tier).toBe("advisor");
    expect(workflow.stages.find((s) => s.id === "outline")?.model_tier).toBe("advisor");
    expect(workflow.stages.find((s) => s.id === "recall")?.runtime).toBe("script");
    expect(workflow.stages.find((s) => s.id === "recall")?.model_tier).toBeUndefined();

    const loop = workflow.stages.find((s) => s.id === "quality_loop") as { stages: Array<Record<string, unknown>> };
    expect(loop.stages.find((s) => s.id === "review")?.model_tier).toBe("reviewer");
    // Static revise/route children are replaced by the agentic dispatch chain;
    // its contract repair stays attached to the LLM plan as validator feedback.
    expect(loop.stages.find((s) => s.id === "revise")).toBeUndefined();
    expect(loop.stages.find((s) => s.id === "route")).toBeUndefined();
    expect(loop.stages.find((s) => s.id === "action_plan")?.validator_commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ args: expect.arrayContaining(["review", "repair-action-plan", "."]) }),
    ]));
  });

  it("applies executor/reviewer tiers to longform foreach steps", async () => {
    const mode = await loadMode("novel");
    const runtimeProfile = await loadRuntimeProfile("claude_first");
    const manifest = compileModeToManifest(mode, {
      projectId: "story",
      topic: "A memory city",
      runtimeProfile,
    });
    expect(manifest.runtime).toBe("claude-code");
    const stages = (manifest.workflow as { runtime_policy?: { primary?: string }; stages: Array<Record<string, unknown>> }).stages;
    expect((manifest.workflow as { runtime_policy?: { primary?: string } }).runtime_policy?.primary).toBe("claude-code");
    expect(stages.find((s) => s.id === "premise")?.model_tier).toBe("advisor");
    const draft = stages.find((s) => s.id === "draft_chapters") as { steps: Array<Record<string, unknown>> };
    expect(draft.steps.find((s) => s.id === "draft")?.model_tier).toBe("executor");
    expect(draft.steps.find((s) => s.id === "continuity_check")?.model_tier).toBe("reviewer");
  });

  it("keeps claude_advisor_sonnet as a compatibility alias for claude_first", async () => {
    const [preferred, legacy] = await Promise.all([
      loadRuntimeProfile("claude_first"),
      loadRuntimeProfile("claude_advisor_sonnet"),
    ]);
    expect(legacy.agent_runtime).toBe(preferred.agent_runtime);
    expect(legacy.workflow).toEqual(preferred.workflow);
  });

  it("applies durable stage overrides after runtime profile compilation", async () => {
    const mode = await loadMode("auto_research_agentic");
    const runtimeProfile = await loadRuntimeProfile("codex_first");
    const manifest = compileModeToManifest(mode, {
      projectId: "survey",
      topic: "Long-horizon agent memory",
      runtimeProfile,
      stageOverrides: {
        outline: { model_tier: "reviewer", requires_human_approval: true },
        draft_sections: { max_parallel: 3 },
      },
    });
    const stages = (manifest.workflow as { stages: Array<Record<string, unknown>> }).stages;
    expect(stages.find((stage) => stage.id === "outline")).toMatchObject({
      model_tier: "reviewer", requires_human_approval: true,
    });
    expect(stages.find((stage) => stage.id === "draft_sections")).toMatchObject({ max_parallel: 3 });
  });

  it("rejects unsafe or unknown durable stage overrides", async () => {
    const mode = await loadMode("auto_research_agentic");
    expect(() => compileModeToManifest(mode, {
      projectId: "survey", topic: "agent memory",
      stageOverrides: { draft_sections: { runtime: "codex" } },
    })).toThrow(/foreach execution settings/);
    expect(() => compileModeToManifest(mode, {
      projectId: "survey", topic: "agent memory",
      stageOverrides: { missing_stage: { model: "x" } },
    })).toThrow(/Unknown execution.stage_overrides/);
  });

  it("routes novel creative stages to the LLM runtime, script only for assembly", async () => {
    const mode = await loadMode("novel");
    const manifest = compileModeToManifest(mode, {
      projectId: "story",
      topic: "A memory city",
    });
    const stages = (manifest.workflow as { stages: Array<Record<string, unknown>> }).stages;
    // Creative stages carry NO runtime override: the worker runtime
    // (claude-code/codex/dry-run) writes the prose.
    for (const id of ["premise", "world_bible", "character_bible", "plot_outline", "continuity_review", "style_pass"]) {
      const stage = stages.find((s) => s.id === id) as { runtime?: string };
      expect(stage.runtime, `${id} must not be script-routed`).toBeUndefined();
    }
    const draft = stages.find((s) => s.id === "draft_chapters") as { steps: Array<{ runtime?: string }> };
    expect(draft.steps.every((step) => step.runtime === undefined)).toBe(true);
    // Assembly is deterministic.
    const build = stages.find((s) => s.id === "build") as { runtime?: string; command?: { args: string[] }; validator_commands?: Array<{ args: string[] }> };
    expect(build.runtime).toBe("script");
    expect(build.command?.args).toEqual(expect.arrayContaining(["draft", "novel", "."]));
    expect(build.validator_commands ?? []).toEqual([]); // full validator only runs in-loop
    // Loop stages: LLM + deterministic scoring contract.
    const loop = stages.find((s) => s.id === "quality_loop") as { stages: Array<{ id: string; runtime?: string; outputs: string[]; validator_commands?: Array<{ args: string[] }> }> };
    for (const id of ["feedback_review", "revise"]) {
      const stage = loop.stages.find((s) => s.id === id)!;
      expect(stage.runtime).toBeUndefined();
      expect(stage.outputs).toContain("reviews/scorecard.json");
      const commands = (stage.validator_commands ?? []).map((c) => c.args.join(" "));
      expect(commands.some((c) => c.includes("validate scorecard"))).toBe(true);
      expect(commands.some((c) => c.includes("review score"))).toBe(true);
    }
    const revise = loop.stages.find((s) => s.id === "revise")!;
    expect((revise.validator_commands ?? []).some((c) => c.args.join(" ").includes("validate novel"))).toBe(true);
  });

  it("routes technical_book creative stages to the LLM runtime, script for extraction/export", async () => {
    const mode = await loadMode("technical_book");
    const manifest = compileModeToManifest(mode, {
      projectId: "book",
      topic: "Agent orchestration",
    });
    const stages = (manifest.workflow as { stages: Array<Record<string, unknown>> }).stages;
    for (const id of ["reader_profile", "table_of_contents", "chapter_contracts", "technical_review", "edit"]) {
      const stage = stages.find((s) => s.id === id) as { runtime?: string };
      expect(stage.runtime, `${id} must not be script-routed`).toBeUndefined();
    }
    for (const id of ["build_examples", "export"]) {
      const stage = stages.find((s) => s.id === id) as { runtime?: string; command?: { args: string[] }; validator_commands?: Array<{ args: string[] }> };
      expect(stage.runtime).toBe("script");
      expect(stage.command?.args).toEqual(expect.arrayContaining(["draft", "technical-book", "."]));
      expect(stage.validator_commands ?? []).toEqual([]); // full validator only runs in-loop
    }
    const loop = stages.find((s) => s.id === "quality_loop") as { stages: Array<{ id: string; runtime?: string; outputs: string[]; validator_commands?: Array<{ args: string[] }> }> };
    for (const id of ["feedback_review", "revise"]) {
      const stage = loop.stages.find((s) => s.id === id)!;
      expect(stage.runtime).toBeUndefined();
      expect(stage.outputs).toContain("reviews/scorecard.json");
    }
  });
});
