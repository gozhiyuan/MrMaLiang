import { describe, expect, it } from "vitest";
import { ExperimentIntent, PublicationExperimentManifest, ReproductionClaim, ReproductionVerdict } from "../src/index.js";

describe("publication experiment manifest", () => {
  it("rejects a result that is not publication eligible", () => {
    expect(() => PublicationExperimentManifest.parse({
      version: 1, project_id: "demo", hypothesis: "h", status: "completed", trial_count: 2, statistical_test: "paired bootstrap",
      metrics: { score: 1 }, trials: [{ id: "a", seed: 1, condition: "control", status: "completed", metrics: { score: 1 } }],
      comparisons: [], artifacts: { results_json: "results/raw.json" },
      provenance: { runner_kind: "command", input_revisions: {}, input_locks_sha256: "a".repeat(64), result_sha256: "b".repeat(64), generated_at: "2026-01-01T00:00:00.000Z" }, publication_eligible: false,
    })).toThrow();
  });
});

describe("generalized experiment contracts", () => {
  it("accepts a bounded experiment intent", () => {
    const intent = ExperimentIntent.parse({
      version: 1, id: "latency-ablation",
      research_question: "Does bounded retrieval improve long-context answer accuracy?",
      hypothesis: "A bounded retrieval pass improves answer accuracy at a fixed latency budget.",
      evidence_role: "survey_validation", study_kind: "api_evaluation",
      rationale: "The survey identifies conflicting claims and needs a controlled, small pilot to distinguish them.",
      metrics: { primary: "accuracy", direction: "maximize" },
      replication: { seeds: [11, 23] }, maximum_budget: { api_calls: 20 },
    });
    expect(intent.replication.minimum_repeats).toBe(1);
  });

  it("requires an exact paper anchor and a labelled verdict", () => {
    const claim = ReproductionClaim.parse({
      id: "claim-1", statement: "The proposed method improves the reported held-out accuracy by five points.",
      anchor: { section: "Results", quote: "Our method improves held-out accuracy by five points." },
      claim_type: "quantitative", metric: "accuracy", reported_value: 0.05, tolerance: 0.01,
      feasibility: "reduced_scale", feasibility_reason: "The original training corpus is unavailable.",
    });
    expect(ReproductionVerdict.parse({
      claim_id: claim.id, verdict: "blocked_missing_artifacts", rationale: "Training corpus was not released.",
    }).trial_ids).toEqual([]);
  });
});
