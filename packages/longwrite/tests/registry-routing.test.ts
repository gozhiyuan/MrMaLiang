import { describe, expect, it } from "vitest";
import { defineProducer } from "../src/lib/registry/producer-types.js";
import { gateId, taxonomyGateId } from "../src/lib/registry/ids.js";
import { registerProducers, UnroutedFindingError } from "../src/lib/registry/routing.js";

const sample = defineProducer({
  module: "sample",
  gates: [
    { id: "visual_review", class: "manuscript", findings: [
      { kind: "chapter_prose", effect: "add_explicit_artifact_reference", capability: "revise_sections" },
      { kind: "figure_spec", effect: "repair_artifact_content", capability: "revise_visual_plan" },
    ] },
    { id: "compiler_present", class: "environment", findings: [] },
    { id: "taxonomy", class: "manuscript", findings: [
      { kind: "corpus", effect: "acquire_additional_evidence", capability: "targeted_research_expansion" },
    ] },
  ],
});
const registry = registerProducers([sample]);

describe("generated routing", () => {
  it("routes one gate to different capabilities by artifact kind", () => {
    expect(String(registry.resolveCapability({
      gate: gateId("visual_review"), kind: "chapter_prose", effect: "add_explicit_artifact_reference",
    }))).toBe("revise_sections");
    expect(String(registry.resolveCapability({
      gate: gateId("visual_review"), kind: "figure_spec", effect: "repair_artifact_content",
    }))).toBe("revise_visual_plan");
  });

  it("resolves a parameterized gate through its family", () => {
    // Built through the helper, never hand-written.
    expect(String(registry.resolveCapability({
      gate: taxonomyGateId("agent memory"), kind: "corpus", effect: "acquire_additional_evidence",
    }))).toBe("targeted_research_expansion");
  });

  it("throws instead of defaulting when the triple is unrouted", () => {
    expect(() => registry.resolveCapability({
      gate: gateId("visual_review"), kind: "corpus", effect: "acquire_additional_evidence",
    })).toThrow(UnroutedFindingError);
  });

  it("carries the unresolved key on the error for the diagnosis unit", () => {
    try {
      registry.resolveCapability({
        gate: gateId("visual_review"), kind: "corpus", effect: "acquire_additional_evidence",
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UnroutedFindingError);
      expect((error as UnroutedFindingError).key.kind).toBe("corpus");
    }
  });

  it("derives the gate class from the producer definition", () => {
    expect(registry.gateClass(gateId("visual_review"))).toBe("manuscript");
    expect(registry.gateClass(gateId("compiler_present"))).toBe("environment");
  });

  it("throws rather than defaulting for an unknown gate", () => {
    expect(() => registry.gateClass(gateId("never_declared"))).toThrow(/unclassified gate/);
  });

  it("derives legal triples from declared findings, never a parallel list", () => {
    expect(registry.legalTriples(gateId("visual_review")).map((t) => t.effect).sort())
      .toEqual(["add_explicit_artifact_reference", "repair_artifact_content"]);
  });

  it("lists the gates of a class", () => {
    expect(registry.gatesOfClass("environment").map(String)).toEqual(["compiler_present"]);
    expect(registry.gatesOfClass("manuscript").map(String).sort()).toEqual(["taxonomy", "visual_review"]);
  });

  it("names the producer a gate came from", () => {
    expect(registry.producerOf(gateId("visual_review"))).toBe("sample");
  });

  it("rejects a manuscript gate that declares no findings", () => {
    expect(() => defineProducer({
      module: "bad", gates: [{ id: "orphan", class: "manuscript", findings: [] }],
    })).toThrow(/manuscript gate.*at least one finding/i);
  });

  it("rejects an environment or measurement gate that declares findings", () => {
    expect(() => defineProducer({
      module: "bad", gates: [{ id: "env", class: "environment", findings: [
        { kind: "corpus", effect: "acquire_additional_evidence", capability: "x" },
      ] }],
    })).toThrow(/environment.*must declare no findings/i);
  });

  it("rejects two producers declaring the same gate", () => {
    expect(() => registerProducers([sample, sample])).toThrow(/declared by more than one producer/i);
  });

  it("rejects a generated kind as a finding's artifact", () => {
    expect(() => defineProducer({
      module: "bad", gates: [{ id: "g", class: "manuscript", findings: [
        { kind: "latex_layout", effect: "repair_artifact_placement", capability: "revise_visual_plan" },
      ] }],
    })).toThrow(/generated/i);
  });

  it("accepts an operator-target kind when an operator capability owns it", () => {
    expect(() => defineProducer({
      module: "ok", gates: [{ id: "g", class: "manuscript", findings: [
        { kind: "toolchain", effect: "repair_toolchain", capability: "request_operator_clarification" },
      ] }],
    })).not.toThrow();
  });

  it("rejects an operator-target kind owned by a repair capability", () => {
    // Nothing this product owns can install a LaTeX compiler.
    expect(() => defineProducer({
      module: "bad", gates: [{ id: "g", class: "manuscript", findings: [
        { kind: "toolchain", effect: "repair_toolchain", capability: "revise_visual_plan" },
      ] }],
    })).toThrow(/only request_operator_clarification/i);
  });
});
