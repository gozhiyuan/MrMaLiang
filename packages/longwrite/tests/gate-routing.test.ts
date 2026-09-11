import { describe, expect, it } from "vitest";
import { capabilitiesForGate, gateOwnedByCapability } from "../src/lib/ops/gate-routing.js";
import { REGISTRY } from "../src/lib/registry/producers.js";

describe("registry-derived gate ownership", () => {
  it("derives a gate's owning capabilities from the routing table itself", () => {
    // No second list to drift: the owners are exactly what the declared
    // triples resolve to.
    expect(capabilitiesForGate("figure_artifacts")).toContain("revise_visual_plan");
    expect(capabilitiesForGate("landmark_coverage")).toContain("targeted_research_expansion");
  });

  it("returns nothing for a gate the registry does not route", () => {
    // The legacy table answered this with a prose default, so an unclassified
    // gate was handed to a chapter editor that could not act on it. Empty is
    // the honest answer, and it fails closed at the caller.
    expect([...capabilitiesForGate("no_such_gate_at_all")]).toEqual([]);
    expect(gateOwnedByCapability("no_such_gate_at_all", "revise_sections")).toBe(false);
  });

  it("agrees with the registry for every manuscript gate", () => {
    for (const gate of REGISTRY.gatesOfClass("manuscript")) {
      for (const triple of REGISTRY.legalTriples(gate)) {
        const capability = String(REGISTRY.resolveCapability({
          gate, kind: triple.kind, effect: triple.effect,
        }));
        expect(gateOwnedByCapability(String(gate), capability), `${gate} -> ${capability}`).toBe(true);
      }
    }
  });
});
