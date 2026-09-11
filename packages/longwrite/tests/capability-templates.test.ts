import { describe, expect, it } from "vitest";
import { CAPABILITY_TEMPLATES, templateFor } from "../src/lib/registry/capabilities.js";
import { METRIC_REGISTRY } from "../src/lib/registry/metrics.js";
import { metricId } from "../src/lib/registry/ids.js";
import { REGISTRY } from "../src/lib/registry/producers.js";

describe("capability templates", () => {
  it("declares a template for every capability any route names", () => {
    const missing = [...REGISTRY.capabilities()].map(String)
      .filter((capability) => !CAPABILITY_TEMPLATES.has(capability)).sort();
    expect(missing, `capabilities with no template: ${missing.join(", ")}`).toEqual([]);
  });

  it("declares no acceptance, because a gate is unknown at compile time", () => {
    for (const template of CAPABILITY_TEMPLATES.values()) {
      expect("acceptance" in template, `${template.id} bakes in acceptance`).toBe(false);
    }
  });

  it("declares the triples a capability handles", () => {
    const revise = templateFor("revise_sections");
    expect(revise.handles.some((t) => t.kind === "chapter_prose"
      && t.effect === "add_explicit_artifact_reference")).toBe(true);
  });

  it("declares an envelope that is the maximum a capability may ever touch", () => {
    expect(templateFor("revise_sections").owns).toEqual(
      expect.arrayContaining(["chapters/**", "paper/abstract.md"]));
    expect(templateFor("revise_sections").owns).not.toContain("figures/**");
  });

  it("protects only registered metrics", () => {
    // citation_verification is a GATE id; the protected metric is registered
    // under its own name.
    for (const template of CAPABILITY_TEMPLATES.values()) {
      for (const metric of template.must_preserve_template) {
        expect(METRIC_REGISTRY.has(metricId(metric)), `${template.id} protects unregistered ${metric}`).toBe(true);
      }
    }
  });

  it("handles every triple its routes assign to it", () => {
    const unhandled: string[] = [];
    for (const gate of REGISTRY.gatesOfClass("manuscript")) {
      for (const triple of REGISTRY.legalTriples(gate)) {
        const capability = String(REGISTRY.resolveCapability({ gate, kind: triple.kind, effect: triple.effect }));
        const template = CAPABILITY_TEMPLATES.get(capability);
        if (!template?.handles.some((h) => h.kind === triple.kind && h.effect === triple.effect)) {
          unhandled.push(`${capability} <- ${gate}/${triple.kind}/${triple.effect}`);
        }
      }
    }
    expect(unhandled.sort(), `templates missing a handled triple: ${unhandled.join(", ")}`).toEqual([]);
  });

  it("assigns a logical model tier to every template", () => {
    for (const template of CAPABILITY_TEMPLATES.values()) {
      expect(["high", "quality_drafting", "medium", "script"]).toContain(template.model_tier);
    }
  });

  it("refuses to invent a template for an unknown capability", () => {
    // Returning an empty envelope would let a dispatched action run with no
    // ownership and no invariants at all.
    expect(() => templateFor("no_such_capability")).toThrow(/no capability template/);
  });
});
