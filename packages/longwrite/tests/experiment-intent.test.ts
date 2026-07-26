import { describe, expect, it } from "vitest";
import { ExperimentIntent, EXPERIMENT_INTENT_ARTIFACT } from "../src/modules/experiment-intent/index.js";
describe("experiment intent boundary", () => {
  it("exports the shared request schema without an execution surface", () => {
    expect(EXPERIMENT_INTENT_ARTIFACT).toBe("experiments/intent.json");
    expect(ExperimentIntent.parse({ version: 1, id: "pilot", research_question: "Can a bounded test validate the manuscript's retrieval recommendation?", hypothesis: "The retrieval setting improves heldout accuracy under the fixed control.", evidence_role: "survey_validation", study_kind: "api_evaluation", rationale: "The paper needs a small controlled test before presenting this as empirical evidence.", metrics: { primary: "accuracy", direction: "maximize" }, replication: { seeds: [1], minimum_repeats: 1 }, maximum_budget: { api_calls: 10 } }).id).toBe("pilot");
  });
});
