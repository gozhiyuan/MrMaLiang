import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { validatePublicationWorkspace } from "../src/lib/publication.js";
import { evaluateSurveyContract } from "../src/lib/research/survey-contract.js";
import { validateVisualReview, checkVisualReviewReleaseGate } from "../src/lib/ops/visual-review.js";
import { validateNovelWorkspace } from "../src/lib/validation/longform.js";
import { FindingSchema } from "../src/lib/registry/records.js";
import { REGISTRY } from "../src/lib/registry/producers.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

async function bare(prefix: string): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), `longwrite-${prefix}-`));
  roots.push(ws);
  return ws;
}

const routable = (findings: Array<{ gate_id: unknown; artifact: { kind: unknown }; required_effect: unknown; id: unknown }>) => {
  for (const finding of findings) {
    expect(FindingSchema.safeParse(finding).success, String(finding.id)).toBe(true);
    expect(() => REGISTRY.resolveCapability({
      gate: finding.gate_id as never, kind: finding.artifact.kind as never, effect: finding.required_effect as never,
    }), String(finding.id)).not.toThrow();
  }
};

describe("publication structured output", () => {
  it("routes a layout defect to the placement plan, never to generated TeX", async () => {
    const ws = await bare("pub-structured");
    await fs.writeFile(path.join(ws, "longwrite.yaml"), stringify({
      version: 1, project: { id: "s", artifact_type: "research_paper", mode: "manual" },
      research: { provider: "seed", topic: "t" },
    }), "utf-8");
    const report = await validatePublicationWorkspace(ws);
    const layout = report.checks.find((check) => String(check.id) === "publication_article_layout");
    expect(layout?.pass).toBe(false);
    expect(layout?.findings[0].artifact).toHaveProperty("path", "figures/placement-plan.json");
    routable(report.checks.flatMap((check) => check.findings));
  });

  it("routes a missing required section to the outline", async () => {
    const ws = await bare("pub-sections");
    await fs.writeFile(path.join(ws, "longwrite.yaml"), stringify({
      version: 1, project: { id: "s", artifact_type: "research_paper", mode: "manual" },
      research: { provider: "seed", topic: "t" },
      publication: { required_sections: ["Introduction", "Conclusion"] },
    }), "utf-8");
    const report = await validatePublicationWorkspace(ws);
    const sections = report.checks.find((check) => String(check.id) === "publication_required_sections");
    expect(sections?.pass).toBe(false);
    expect(sections?.findings[0].required_effect).toBe("replace_organizing_claim");
  });
});

describe("survey contract structured output", () => {
  it("emits a routable check per gate, derived from one evaluation", async () => {
    const ws = await bare("survey-structured");
    await fs.mkdir(path.join(ws, "sources"), { recursive: true });
    await fs.writeFile(path.join(ws, "longwrite.yaml"), stringify({
      version: 1, project: { id: "s", artifact_type: "research_paper", mode: "auto_research_agentic" },
      research: { provider: "seed", topic: "t" },
    }), "utf-8");
    await fs.writeFile(path.join(ws, "outline.json"), JSON.stringify({ sections: [{ id: "one", title: "One" }] }), "utf-8");
    await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"),
      JSON.stringify({ id: "s1", citation_depth: "A", title: "T", abstract: "a", year: 2025,
        venue: "ICML", topics: ["memory"], authors: ["Ada Lovelace"] }), "utf-8");
    const { report } = await evaluateSurveyContract(ws);
    expect(report.checks.length).toBe(report.findings.length);
    // Prose survives for operators, derived from the routable output rather
    // than standing beside it as a second source of truth.
    expect(report.checks.map((check) => String(check.id)).sort())
      .toEqual(report.findings.map((finding) => finding.id).sort());
    for (const check of report.checks) {
      expect(check.pass).toBe(report.findings.find((finding) => finding.id === String(check.id))?.pass);
    }
    routable(report.checks.flatMap((check) => check.findings));
  });
});

describe("visual review structured output", () => {
  it("asks for diagnosis when the reviewer output itself is unusable", async () => {
    // A measurement gate is satisfied by re-running the review, never by
    // editing an artifact, so it must not invent a finding.
    const ws = await bare("visual-structured");
    const contract = await validateVisualReview(ws);
    expect(contract.pass).toBe(false);
    expect(contract.findings).toEqual([]);
    expect(contract.requires_diagnosis).toBe(true);
    expect(contract.diagnostic).toBeTruthy();
  });

  it("leaves the release gate with something to act on when it fails", async () => {
    const ws = await bare("visual-gate");
    const gate = await checkVisualReviewReleaseGate(ws, true);
    expect(gate.pass).toBe(false);
    expect(gate.findings.length > 0 || gate.requires_diagnosis).toBe(true);
  });
});

describe("long-form structured output", () => {
  it("keeps an advisory gate passing without emitting a repair nobody asked for", async () => {
    const ws = await bare("longform-structured");
    await fs.mkdir(path.join(ws, "chapters"), { recursive: true });
    const report = await validateNovelWorkspace(ws);
    for (const gate of ["target_length", "style_drift"]) {
      const check = report.checks.find((item) => String(item.id) === gate);
      expect(check?.pass, gate).toBe(true);
      expect(check?.findings, gate).toEqual([]);
    }
    routable(report.checks.flatMap((check) => check.findings));
  });

  it("asks for diagnosis when a required artifact was never produced", async () => {
    const ws = await bare("longform-artifacts");
    await fs.mkdir(path.join(ws, "chapters"), { recursive: true });
    const report = await validateNovelWorkspace(ws);
    const required = report.checks.find((item) => String(item.id) === "required_artifacts");
    expect(required?.pass).toBe(false);
    expect(required?.findings).toEqual([]);
    expect(required?.requires_diagnosis).toBe(true);
  });
});
