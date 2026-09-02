import { describe, expect, it } from "vitest";
import { metricId } from "../src/lib/registry/ids.js";
import {
  METRIC_REGISTRY, PLANNER_SELECTABLE, metricDefinition, metricsOfTier,
} from "../src/lib/registry/metrics.js";

describe("metric registry", () => {
  it("registers every observable metric, not only planner-selectable ones", () => {
    for (const id of ["candidate_count", "recent_source_ratio", "source_type_diversity_count"]) {
      expect(METRIC_REGISTRY.has(metricId(id)), `${id} is unregistered`).toBe(true);
    }
    expect(METRIC_REGISTRY.size).toBeGreaterThan(22);
  });

  it("registers a metric for every gate a capability may protect", () => {
    // citation_verification is a GATE id; its protected form must exist as a
    // registered metric under its own name.
    expect(METRIC_REGISTRY.has(metricId("citation_verification_status"))).toBe(true);
  });

  it("allows the planner to select exactly the 22 acceptance metrics", () => {
    expect(PLANNER_SELECTABLE.size).toBe(22);
    expect(PLANNER_SELECTABLE.has(metricId("core_sources"))).toBe(true);
    expect(PLANNER_SELECTABLE.has(metricId("candidate_count"))).toBe(false);
    for (const id of PLANNER_SELECTABLE) expect(METRIC_REGISTRY.has(id)).toBe(true);
  });

  it("declares a scope kind so scoped metrics emit one entry per scope", () => {
    expect(metricDefinition(metricId("citation_depth_per_section")).scope_kind).toBe("section");
    expect(metricDefinition(metricId("taxonomy_cell_ab_sources")).scope_kind).toBe("taxonomy_cell");
    expect(metricDefinition(metricId("core_sources")).scope_kind).toBe("global");
  });

  it("marks only genuinely time-dependent metrics", () => {
    // Folding a date into every digest would invalidate every static
    // measurement daily and destroy reuse.
    expect(metricDefinition(metricId("cited_within_one_year_ratio")).time_dependent).toBe(true);
    expect(metricDefinition(metricId("recent_source_ratio")).time_dependent).toBe(true);
    expect(metricDefinition(metricId("core_sources")).time_dependent).toBe(false);
    expect(metricDefinition(metricId("prose_redundancy")).time_dependent).toBe(false);
  });

  it("marks the three expensive metrics as release tier", () => {
    expect(metricsOfTier("release").map(String).sort())
      .toEqual(["claim_support", "rendered_visual_review", "review_score"]);
  });

  it("declares producer, validator and reducer for every model pipeline", () => {
    for (const definition of METRIC_REGISTRY.values()) {
      if (definition.measurement_kind !== "model") continue;
      expect(definition.producer, `${definition.metric}`).toBeTruthy();
      expect(definition.validator, `${definition.metric}`).toBeTruthy();
      expect(definition.reducer, `${definition.metric}`).toBeTruthy();
    }
  });

  it("never lists a producer's own output as a dependency", () => {
    for (const definition of METRIC_REGISTRY.values()) {
      for (const output of definition.raw_output) {
        expect(definition.dependencies, `${definition.metric} depends on its own output`)
          .not.toContain(output);
      }
    }
  });

  it("includes chapters in the dependencies of every cited-source metric", () => {
    for (const id of ["cited_sources", "cited_within_one_year_ratio",
                      "accepted_cited_ratio", "cited_arxiv_only_ratio"]) {
      expect(metricDefinition(metricId(id)).dependencies.some((d) => d.startsWith("chapters/")),
        `${id} omits chapters`).toBe(true);
    }
  });

  it("includes validated evidence and config where a metric reads them", () => {
    expect(metricDefinition(metricId("landmark_coverage_ratio")).dependencies)
      .toContain("evidence/active-validated-source-evidence.json");
    expect(metricDefinition(metricId("taxonomy_cell_ab_sources")).dependencies)
      .toContain("longwrite.yaml");
  });

  it("records direction and tolerance so progress can be normalized", () => {
    expect(metricDefinition(metricId("prose_redundancy")).direction).toBe("minimize");
    expect(metricDefinition(metricId("core_sources")).tolerance).toBe(0);
    expect(metricDefinition(metricId("landmark_coverage_ratio")).tolerance).toBeGreaterThan(0);
  });

  it("throws rather than defaulting for an unknown metric", () => {
    expect(() => metricDefinition(metricId("invented_metric"))).toThrow(/unknown metric/);
  });
});
