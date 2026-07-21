import { describe, expect, it } from "vitest";
import { resolveResearchAxes, TEMPLATES, templateById } from "../src/templates.js";

describe("MrMaLiang template catalog", () => {
  it("contains the supported writing, experiment, and integrated workflows", () => {
    expect(TEMPLATES.map((template) => template.id)).toEqual(expect.arrayContaining([
      "writing.novel", "paper.survey", "experiment.standalone", "paper.empirical", "paper.empirical-import",
    ]));
    expect(TEMPLATES.map((template) => template.id)).not.toEqual(expect.arrayContaining([
      "paper.repository-survey", "paper.empirical-prescribed", "paper.repository-empirical", "paper.repository-empirical-prescribed", "paper.repository-empirical-import",
    ]));
  });

  it("resolves optional repositories and experiment authoring into internal axes", () => {
    expect(resolveResearchAxes(templateById("paper.survey"), { hasRepository: false })).toEqual({ paperKind: "survey", evidenceProfile: "literature", experimentSource: "none" });
    expect(resolveResearchAxes(templateById("paper.survey"), { hasRepository: true })).toEqual({ paperKind: "survey", evidenceProfile: "repository", experimentSource: "none" });
    expect(resolveResearchAxes(templateById("paper.empirical"), { hasRepository: true })).toEqual({ paperKind: "empirical", evidenceProfile: "repository", experimentSource: "run", experimentAuthoring: "agentic" });
    expect(resolveResearchAxes(templateById("paper.empirical"), { hasRepository: false, experimentAuthoring: "prescribed" })).toEqual({ paperKind: "empirical", evidenceProfile: "literature", experimentSource: "run", experimentAuthoring: "prescribed" });
    expect(resolveResearchAxes(templateById("paper.empirical-import"), { hasRepository: true })).toEqual({ paperKind: "empirical", evidenceProfile: "repository", experimentSource: "import" });
    expect(() => resolveResearchAxes(templateById("paper.survey"), { hasRepository: true, experimentAuthoring: "agentic" })).toThrow("only valid for paper.empirical");
  });

  it("fails clearly for unknown templates", () => {
    expect(() => templateById("unknown")).toThrow("Unknown template");
  });
});
