import { describe, expect, it } from "vitest";
import {
  FindingSchema, MeasurementEntrySchema, MeasurementEnvelopeSchema, StructuredCheckSchema,
  validateFindingAgainstRegistry,
} from "../src/lib/registry/records.js";
import { REGISTRY } from "../src/lib/registry/producers.js";

const finding = {
  id: "figure-1-missing-reference",
  gate_id: "figure_references",
  artifact: { kind: "chapter_prose", path: "chapters/section-03.md", artifact_id: "figure-1" },
  location: "paragraph preceding the float generated at paper/sections/section-03.tex",
  objective_scope_key: "",
  required_effect: "add_explicit_artifact_reference",
  acceptance_metric: null,
  severity: "major",
  diagnostic: "Figure 1 is not named before its placement.",
};

const entry = {
  metric: "core_sources", scope_key: "", status: "measured", value: 2,
  target: 5, operator: "at_least", tolerance: 0, direction: "maximize",
  evaluator: "core_sources", evaluator_digest: "a".repeat(64), input_digest: "b".repeat(64),
  measurement_kind: "script",
};

describe("structured records", () => {
  it("accepts a well-formed finding", () => {
    expect(FindingSchema.safeParse(finding).success).toBe(true);
  });

  it("rejects an effect outside the vocabulary and an unknown extra field", () => {
    expect(FindingSchema.safeParse({ ...finding, required_effect: "make_it_better" }).success).toBe(false);
    expect(FindingSchema.safeParse({ ...finding, hint: "try harder" }).success).toBe(false);
  });

  it("accepts an operator target naming a tool rather than a path", () => {
    // A missing LaTeX compiler is a real finding subject with no editable path.
    expect(FindingSchema.safeParse({
      ...finding, gate_id: "latex_build",
      artifact: { kind: "toolchain", target: "pdflatex" },
      required_effect: "repair_toolchain",
    }).success).toBe(true);
  });

  it("rejects an operator target that names a path", () => {
    expect(FindingSchema.safeParse({
      ...finding, gate_id: "latex_build",
      artifact: { kind: "toolchain", path: "bin/pdflatex" },
      required_effect: "repair_toolchain",
    }).success).toBe(false);
  });

  it("rejects an editable kind that uses the target form", () => {
    expect(FindingSchema.safeParse({
      ...finding, artifact: { kind: "chapter_prose", target: "section-03" },
    }).success).toBe(false);
  });

  it("rejects a kind that does not match the path it names", () => {
    // Generated TeX is not a figure spec. The producing surface must be named,
    // with the TeX location carried in `location`.
    expect(FindingSchema.safeParse({
      ...finding, artifact: { kind: "figure_spec", path: "paper/sections/section-03.tex" },
    }).success).toBe(false);
  });

  it("rejects a triple its gate never declared, at the registry boundary", () => {
    // The shape schema stays registry-free so producers can import it without
    // creating records -> producers -> validation -> records.
    const parsed = FindingSchema.parse({ ...finding, gate_id: "core_sources" });
    expect(() => validateFindingAgainstRegistry(parsed, REGISTRY)).toThrow(/never declared/);
  });

  it("accepts a script measurement entry with no judgment", () => {
    expect(MeasurementEntrySchema.safeParse(entry).success).toBe(true);
  });

  it("requires a value on a measured entry and forbids one otherwise", () => {
    expect(MeasurementEntrySchema.safeParse({ ...entry, value: undefined }).success).toBe(false);
    expect(MeasurementEntrySchema.safeParse({
      ...entry, status: "unavailable", value: undefined, reason: "corpus missing",
    }).success).toBe(true);
  });

  it("requires a reason on an unavailable entry", () => {
    expect(MeasurementEntrySchema.safeParse({
      ...entry, status: "unavailable", value: undefined,
    }).success).toBe(false);
  });

  it("requires judgment on a model entry and forbids it on a script entry", () => {
    const judgment = {
      reasons: ["comparative synthesis is thin in section 4"], confidence: 0.62,
      rubric_version: "2", evidence_refs: ["reviews/scorecard.json#persona/theorist"],
      adjudicated: false, disagreement: "none",
    };
    expect(MeasurementEntrySchema.safeParse({ ...entry, measurement_kind: "model" }).success).toBe(false);
    expect(MeasurementEntrySchema.safeParse({
      ...entry, metric: "review_score", measurement_kind: "model", judgment,
    }).success).toBe(true);
    expect(MeasurementEntrySchema.safeParse({ ...entry, judgment }).success).toBe(false);
  });

  it("rejects a confidence outside zero to one", () => {
    expect(MeasurementEntrySchema.safeParse({
      ...entry, measurement_kind: "model",
      judgment: { reasons: [], confidence: 1.4, rubric_version: "2", evidence_refs: [], adjudicated: false, disagreement: "none" },
    }).success).toBe(false);
  });

  it("accepts an envelope of scoped entries", () => {
    expect(MeasurementEnvelopeSchema.safeParse({
      version: 1, as_of_date: "2026-09-01T00:00:00.000Z",
      measurements: [
        { ...entry, metric: "citation_depth_per_section", scope_key: "section-03", value: 2 },
        { ...entry, metric: "citation_depth_per_section", scope_key: "section-06", value: 5 },
      ],
    }).success).toBe(true);
  });

  it("requires an objective scope rather than inferring one", () => {
    const { objective_scope_key, ...without } = finding;
    expect(FindingSchema.safeParse(without).success).toBe(false);
  });

  it("accepts a global objective scope on a section artifact", () => {
    // A prose defect in section 3 can belong to a workspace-global
    // rendered-PDF objective; inferring scope from the path would split one
    // objective into per-section ones that each look separately unmet.
    expect(FindingSchema.safeParse({ ...finding, objective_scope_key: "" }).success).toBe(true);
  });

  it("keeps prose only as an unparsed diagnostic on the check", () => {
    expect(StructuredCheckSchema.safeParse({
      id: "figure_references", pass: false, measurements: [entry], findings: [finding],
      diagnostic: "figure-1 is not embedded in paper/sections/section-03.tex",
    }).success).toBe(true);
    // A finding travelling inside a check that names a different gate would be
    // routed against a gate that never declared it.
    expect(StructuredCheckSchema.safeParse({
      id: "figure_manifest", pass: false, findings: [finding],
    }).success).toBe(false);
  });

  it("rejects a failed check that nothing could act on", () => {
    // A failure with no finding and no diagnosis request would stall the round:
    // the kernel would see a gate closed against it and no move to make.
    expect(StructuredCheckSchema.safeParse({
      id: "figure_references", pass: false, diagnostic: "something is wrong",
    }).success).toBe(false);
    expect(StructuredCheckSchema.safeParse({
      id: "figure_references", pass: false, requires_diagnosis: true, diagnostic: "something is wrong",
    }).success).toBe(true);
  });
});
