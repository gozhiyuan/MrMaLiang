import { describe, expect, it } from "vitest";
import {
  ARTIFACT_KINDS, REQUIRED_EFFECTS, GATE_CLASSES,
  ArtifactKindSchema, RequiredEffectSchema, GateIdSchema,
  gateId, metricId, gateFamily, isParameterized, taxonomyGateId, slugify,
  EDITABLE_KIND_PATHS, OPERATOR_TARGET_KINDS, GENERATED_KINDS,
} from "../src/lib/registry/ids.js";

describe("registry ids", () => {
  it("exposes closed, duplicate-free vocabularies", () => {
    expect(new Set(ARTIFACT_KINDS).size).toBe(ARTIFACT_KINDS.length);
    expect(new Set(REQUIRED_EFFECTS).size).toBe(REQUIRED_EFFECTS.length);
    expect([...GATE_CLASSES].sort()).toEqual(["environment", "manuscript", "measurement"]);
  });

  it("names an effect for every repair the routing review found unrepresentable", () => {
    // An under-length manuscript, a broken publication template and a missing
    // compiler each had no legal effect before.
    for (const effect of ["expand_argument", "repair_template", "repair_toolchain"]) {
      expect(REQUIRED_EFFECTS).toContain(effect);
    }
  });

  it("rejects values outside a closed vocabulary", () => {
    expect(ArtifactKindSchema.safeParse("prose").success).toBe(false);
    expect(RequiredEffectSchema.safeParse("make_it_better").success).toBe(false);
  });

  it("builds a parameterized gate id through one helper", () => {
    // Every call site uses taxonomyGateId; hand-writing `taxonomy:<cell>`
    // is what produced ids the grammar rejects.
    const id = taxonomyGateId("agent memory");
    expect(GateIdSchema.safeParse(id).success).toBe(true);
    expect(gateFamily(id)).toBe("taxonomy");
    expect(isParameterized(id)).toBe(true);
  });

  it("builds the same gate id for the same cell and different ones otherwise", () => {
    expect(taxonomyGateId("agent memory")).toBe(taxonomyGateId("agent memory"));
    expect(taxonomyGateId("RL/control")).not.toBe(taxonomyGateId("RL control"));
  });

  it("accepts every realistic taxonomy cell", () => {
    for (const cell of ["agent memory", "long-horizon planning", "RL / control", "内存"]) {
      expect(GateIdSchema.safeParse(taxonomyGateId(cell)).success, cell).toBe(true);
    }
  });

  it("slugifies a label deterministically and collision-resistantly", () => {
    expect(slugify("agent memory")).toBe(slugify("agent memory"));
    expect(slugify("RL/control")).not.toBe(slugify("RL control"));
  });

  it("treats a plain gate id as its own family", () => {
    expect(gateFamily(gateId("figure_references"))).toBe("figure_references");
    expect(isParameterized(gateId("figure_references"))).toBe(false);
  });

  it("rejects a malformed identifier and a multi-segment parameter", () => {
    expect(GateIdSchema.safeParse("Figure References").success).toBe(false);
    expect(GateIdSchema.safeParse("taxonomy:a:b").success).toBe(false);
    expect(() => gateId("Figure References")).toThrow();
  });

  it("gives the publication template a real editable path", () => {
    // The first draft left it empty, then declared a repair_template route —
    // a route the shape validator would have rejected.
    expect(EDITABLE_KIND_PATHS.publication_template).toContain("paper/template/");
  });

  it("records a generated kind as having no editable path of its own", () => {
    expect(EDITABLE_KIND_PATHS.latex_layout).toEqual([]);
    expect(GENERATED_KINDS).toContain("latex_layout");
    expect(EDITABLE_KIND_PATHS.figure_spec).toContain("figures/placement-plan.json");
  });

  it("separates operator targets from generated artifacts", () => {
    // A missing compiler is a real target with no editable path — it is not a
    // generated artifact, and a finding about it routes to an operator.
    expect(OPERATOR_TARGET_KINDS).toContain("toolchain");
    expect(OPERATOR_TARGET_KINDS).toContain("experiment_manifest");
    expect(OPERATOR_TARGET_KINDS).not.toContain("latex_layout");
  });

  it("keeps gate and metric ids as distinct brands", () => {
    expect(String(gateId("rendered_visual_review"))).toBe(String(metricId("rendered_visual_review")));
  });
});
