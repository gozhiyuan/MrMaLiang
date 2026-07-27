import { describe, expect, it } from "vitest";
import { assessFeasibility } from "../src/lib/feasibility.js";

const intent = { version: 1, id: "small-api-eval", research_question: "Does a concise retrieval prompt improve calibrated factual answers on the heldout set?", hypothesis: "The retrieval prompt improves heldout factual accuracy without increasing refusal errors.", evidence_role: "survey_validation", study_kind: "api_evaluation", rationale: "The paper needs a bounded empirical check of its retrieval recommendation on an explicit heldout dataset.", metrics: { primary: "accuracy", direction: "maximize" }, replication: { seeds: [11, 23, 47], minimum_repeats: 3 }, maximum_budget: { api_calls: 300, wall_minutes: 30 } };

describe("experiment feasibility", () => {
  it("disqualifies missing verification, inputs, budget, unbounded conditions, and irrelevant requests", () => {
    const assessment = assessFeasibility(intent, { reliableVerifier: false, inputsAvailable: false, lease: { api_calls: 100 }, conditions: 0, usefulToPaper: false });
    expect(assessment.feasible).toBe(false);
    expect(assessment.reasons).toEqual(expect.arrayContaining(["no reliable verifier is available", "required model or data input is unavailable", "the requested result is not useful to the paper claim", "conditions must be bounded between 1 and 20", "estimated api_calls exceeds the authorized lease"]));
  });
  it("accepts a bounded, useful, verified request under its lease", () => {
    expect(assessFeasibility(intent, { reliableVerifier: true, inputsAvailable: true, lease: { api_calls: 400, wall_minutes: 60 }, conditions: 2, usefulToPaper: true })).toMatchObject({ feasible: true, estimated: { api_calls: 300 } });
  });
});
