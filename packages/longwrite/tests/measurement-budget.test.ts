import { describe, expect, it } from "vitest";
import { metricId } from "../src/lib/registry/ids.js";
import { projectedRoundCost, affordable, planRoundMeasurements } from "../src/lib/ops/measurement-budget.js";

describe("measurement budget", () => {
  it("projects zero model cost for script metrics", () => {
    expect(projectedRoundCost([metricId("core_sources"), metricId("prose_redundancy")]))
      .toEqual({ model_calls: 0, renders: 0 });
  });

  it("projects the real cost of a persona review", () => {
    // Four persona calls plus the adjudication its reducer performs: the
    // metric is not measured until the judges' disagreement is resolved.
    expect(projectedRoundCost([metricId("review_score")]).model_calls).toBe(5);
  });

  it("counts a render for the multimodal visual review", () => {
    expect(projectedRoundCost([metricId("rendered_visual_review")]).renders).toBe(1);
  });

  it("refuses a round whose projection exceeds the remaining budget", () => {
    expect(affordable({ model_calls: 8, renders: 1 }, { model_calls: 4, renders: 5 })).toBe(false);
  });

  it("schedules cheap metrics and defers expensive ones under a tight budget", () => {
    // Cheapest first, so a tight budget still yields the deterministic signals.
    const plan = planRoundMeasurements(
      [metricId("core_sources"), metricId("review_score"), metricId("rendered_visual_review")],
      { model_calls: 1, renders: 0 });
    expect(plan.scheduled.map(String)).toContain("core_sources");
    expect(plan.deferred.map(String)).toEqual(expect.arrayContaining(["review_score", "rendered_visual_review"]));
  });

  it("schedules everything when the budget allows", () => {
    expect(planRoundMeasurements([metricId("core_sources"), metricId("review_score")],
      { model_calls: 20, renders: 5 }).deferred).toEqual([]);
  });

  it("throws rather than pricing an unregistered metric at zero", () => {
    expect(() => projectedRoundCost([metricId("invented_metric")])).toThrow(/unknown metric/);
  });
});
