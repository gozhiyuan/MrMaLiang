import { describe, expect, it } from "vitest";
import { PLANNER_SELECTABLE, METRIC_REGISTRY } from "../src/lib/registry/metrics.js";
import { REGISTRY } from "../src/lib/registry/producers.js";
import { renderMetricVocabulary, renderRoutingPolicy, renderPlannerInstructions } from "../src/lib/registry/render.js";

describe("registry-rendered prompts", () => {
  it("names every planner-selectable metric", () => {
    const rendered = renderMetricVocabulary();
    for (const metric of PLANNER_SELECTABLE) expect(rendered).toContain(String(metric));
  });

  it("does not offer a metric the planner may not select", () => {
    const rendered = renderMetricVocabulary();
    for (const metric of METRIC_REGISTRY.keys()) {
      if (!PLANNER_SELECTABLE.has(metric)) expect(rendered).not.toContain(`- ${String(metric)} `);
    }
  });

  it("cannot drift from the registry, because it is generated from it", () => {
    // The old failure mode was a prompt restating policy a registry also
    // encoded, kept in sync by a dedicated test. Generation removes the
    // possibility rather than policing it.
    const rendered = renderMetricVocabulary();
    const named = (rendered.match(/^- ([a-z][a-z0-9_]*)/gm) ?? []).map((line) => line.slice(2));
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) expect(PLANNER_SELECTABLE.has(name as never)).toBe(true);
  });

  it("renders routing as gate, kind and effect triples", () => {
    const rendered = renderRoutingPolicy();
    const gate = REGISTRY.gatesOfClass("manuscript")[0];
    const triple = REGISTRY.legalTriples(gate)[0];
    expect(rendered).toContain(String(gate));
    expect(rendered).toContain(triple.kind);
  });

  it("states that routing fails closed", () => {
    expect(renderRoutingPolicy()).toMatch(/no default|fails closed/i);
  });

  it("renders each capability's envelope from its template", () => {
    // The prompt used to state one capability's ownership in prose; a template
    // change would have left the sentence behind.
    expect(renderRoutingPolicy()).toMatch(/revise_sections owns .*chapters/);
  });

  it("produces non-empty planner instructions", () => {
    const instructions = renderPlannerInstructions();
    expect(instructions.length).toBeGreaterThan(0);
    expect(instructions.every((line) => line.trim().length > 0)).toBe(true);
  });
});
