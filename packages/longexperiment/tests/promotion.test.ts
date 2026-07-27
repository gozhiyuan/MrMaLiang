import { describe, expect, it } from "vitest";
import { decidePromotion } from "../src/lib/promotion.js";
describe("promotion decision", () => {
  it("handles maximize/minimize, noise, constraints, crashes, and complexity ties", () => {
    expect(decidePromotion({ direction: "maximize", incumbentMetric: 0.7, candidateMetric: 0.8, constraintsPassed: true })).toMatchObject({ decision: "promote" });
    expect(decidePromotion({ direction: "minimize", incumbentMetric: 2, candidateMetric: 1, constraintsPassed: true })).toMatchObject({ decision: "promote" });
    expect(decidePromotion({ direction: "maximize", incumbentMetric: 0.7, candidateMetric: 0.8, candidateConfidence: { lower: -0.01, upper: 0.2 }, constraintsPassed: true })).toMatchObject({ decision: "discard" });
    expect(decidePromotion({ direction: "maximize", incumbentMetric: 1, candidateMetric: 2, constraintsPassed: false })).toMatchObject({ decision: "discard" });
    expect(decidePromotion({ direction: "maximize", incumbentMetric: 1, constraintsPassed: true, crashed: true })).toMatchObject({ decision: "crash" });
    expect(decidePromotion({ direction: "maximize", incumbentMetric: 1, candidateMetric: 1, incumbentComplexity: 2, candidateComplexity: 3, constraintsPassed: true })).toMatchObject({ decision: "discard" });
  });

  // The confidence interval is always on the raw (candidate - incumbent) delta,
  // so the minimize branch has to flip the bound it checks. That sign flip is
  // the easiest thing to get backwards, and getting it backwards would promote
  // on noise for every minimized metric — the exact failure the gate prevents.
  it("applies the noise gate correctly when the metric is minimized", () => {
    const base = { direction: "minimize", incumbentMetric: 2, candidateMetric: 1, constraintsPassed: true } as const;

    // A real improvement: the whole interval sits below zero.
    expect(decidePromotion({ ...base, candidateConfidence: { lower: -1.4, upper: -0.6 } })).toMatchObject({ decision: "promote" });

    // Straddles zero — indistinguishable from noise despite the point estimate.
    expect(decidePromotion({ ...base, candidateConfidence: { lower: -1.4, upper: 0.2 } })).toMatchObject({ decision: "discard" });

    // Touching zero is not confirmation either.
    expect(decidePromotion({ ...base, candidateConfidence: { lower: -1.4, upper: 0 } })).toMatchObject({ decision: "discard" });
  });
});
