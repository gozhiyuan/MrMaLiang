import { describe, expect, it } from "vitest";
import { METRIC_REGISTRY } from "../src/lib/registry/metrics.js";
import { SCRIPT_EVALUATORS } from "../src/lib/registry/evaluators/index.js";

describe("evaluator coverage", () => {
  it("registers exactly one evaluator for every script metric", () => {
    const missing = [...METRIC_REGISTRY.values()]
      .filter((d) => d.measurement_kind === "script")
      .filter((d) => typeof SCRIPT_EVALUATORS[String(d.metric)] !== "function")
      .map((d) => String(d.metric)).sort();
    expect(missing, `script metrics with no evaluator: ${missing.join(", ")}`).toEqual([]);
  });

  it("registers no evaluator for a model or external metric", () => {
    const extra = [...METRIC_REGISTRY.values()]
      .filter((d) => d.measurement_kind !== "script")
      .filter((d) => typeof SCRIPT_EVALUATORS[String(d.metric)] === "function")
      .map((d) => String(d.metric)).sort();
    expect(extra, `non-script metrics with a script evaluator: ${extra.join(", ")}`).toEqual([]);
  });

  it("registers no evaluator for an unregistered metric", () => {
    const orphans = Object.keys(SCRIPT_EVALUATORS)
      .filter((name) => ![...METRIC_REGISTRY.keys()].map(String).includes(name)).sort();
    expect(orphans, `evaluators with no registered metric: ${orphans.join(", ")}`).toEqual([]);
  });
});
