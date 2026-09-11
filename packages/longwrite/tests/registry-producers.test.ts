import { describe, expect, it } from "vitest";
import { PRODUCERS, REGISTRY } from "../src/lib/registry/producers.js";
import { gateId, taxonomyGateId } from "../src/lib/registry/ids.js";

const effectsFor = (gate: string) =>
  REGISTRY.legalTriples(gateId(gate)).map((t) => `${t.kind}/${t.effect}`).sort();

describe("producer declarations", () => {
  it("registers all nine gate-producing modules", () => {
    expect(PRODUCERS.map((p) => p.module).sort()).toEqual([
      "corpus-gates", "figures", "latex", "longform", "preflight",
      "publication", "research", "survey-contract", "visual-review",
    ]);
  });

  it("captures the parameterized taxonomy family a text scan cannot see", () => {
    expect(REGISTRY.gateClass(gateId("taxonomy"))).toBe("manuscript");
    expect(REGISTRY.gateClass(taxonomyGateId("agent memory"))).toBe("manuscript");
  });

  it("makes an under-length manuscript repairable", () => {
    expect(effectsFor("target_length")).toContain("chapter_prose/expand_argument");
    expect(effectsFor("target_length")).toContain("chapter_prose/remove_redundant_prose");
  });

  it("routes missing research artifacts to evidence, not to a figure spec", () => {
    expect(effectsFor("research_artifacts_present")).toEqual(["evidence_packet/acquire_additional_evidence"]);
  });

  it("does not claim bibliography repair can directly satisfy a build metric", () => {
    const effects = effectsFor("manuscript_build");
    expect(effects).not.toContain("bibliography/repair_bibliography_consistency");
    expect(effects).toContain("toolchain/repair_toolchain");
  });

  it("routes a template defect to a template repair", () => {
    expect(effectsFor("publication_custom_template")).toEqual(["publication_template/repair_template"]);
  });

  it("keeps aggregate citation verification diagnostic-only", () => {
    const effects = effectsFor("citation_verification");
    expect(effects).toEqual([]);
  });

  it("lets a related-work matrix defect reach the table spec", () => {
    expect(effectsFor("related_work_matrix")).toContain("table_spec/repair_artifact_content");
  });

  it("classifies every preflight gate as environment with no findings", () => {
    const preflight = PRODUCERS.find((p) => p.module === "preflight")!;
    expect(preflight.gates.length).toBe(11);
    for (const gate of preflight.gates) {
      expect(gate.class, String(gate.id)).toBe("environment");
      expect(gate.findings).toEqual([]);
    }
  });

  it("does not declare review_no_regressions, which must_preserve subsumes", () => {
    expect(() => REGISTRY.gateClass(gateId("review_no_regressions"))).toThrow(/unclassified/);
  });

  it("classifies empirical_experiment as environment, outside LongWrite's reach", () => {
    expect(REGISTRY.gateClass(gateId("empirical_experiment"))).toBe("environment");
  });

  it("classifies re-runnable checks as measurement, never repairable", () => {
    for (const id of ["full_claim_double_review", "visual_review_contract"]) {
      expect(REGISTRY.gateClass(gateId(id)), id).toBe("measurement");
      expect(REGISTRY.legalTriples(gateId(id)), id).toEqual([]);
    }
  });

  it("routes every legal triple it declares", () => {
    const routed = REGISTRY.routedTripleKeys();
    const unrouted: string[] = [];
    for (const gate of REGISTRY.gatesOfClass("manuscript")) {
      const triples = REGISTRY.legalTriples(gate);
      if (triples.length === 0) { unrouted.push(`${gate} (no findings declared)`); continue; }
      for (const triple of triples) {
        if (!routed.has(`${gate} ${triple.kind} ${triple.effect}`)) {
          unrouted.push(`${gate}/${triple.kind}/${triple.effect}`);
        }
      }
    }
    expect(unrouted.sort(), `unrouted: ${unrouted.join(", ")}`).toEqual([]);
  });

  it("names only capabilities the templates will later have to own", () => {
    expect([...REGISTRY.capabilities()].map(String).sort()).toEqual([
      "reopen_outline", "repair_bibliography", "repair_citation_plan", "repair_source_metadata",
      "request_operator_clarification", "revise_sections", "revise_visual_plan",
      "targeted_research_expansion",
    ]);
  });
});
