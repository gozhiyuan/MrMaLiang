import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { validateResearchWorkspace } from "../src/lib/validation/research.js";
import { FindingSchema } from "../src/lib/registry/records.js";
import { REGISTRY } from "../src/lib/registry/producers.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});
const AS_OF = "2026-09-01T00:00:00.000Z";

type Options = {
  words?: number;
  targetWords?: number;
  danglingPlanEntry?: boolean;
  danglingBibEntry?: boolean;
  noArtifacts?: boolean;
};

async function workspace(options: Options = {}): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-research-structured-"));
  roots.push(ws);
  if (options.noArtifacts) {
    await fs.mkdir(path.join(ws, "chapters"), { recursive: true });
    await fs.writeFile(path.join(ws, "longwrite.yaml"), stringify({
      version: 1, project: { id: "s", artifact_type: "research_paper", mode: "auto_research_agentic" },
      research: { provider: "multi", topic: "t" }, writing: { target_length_words: 1_000 },
    }), "utf-8");
    return ws;
  }
  await fs.mkdir(path.join(ws, "sources"), { recursive: true });
  await fs.mkdir(path.join(ws, "chapters"), { recursive: true });
  await fs.writeFile(path.join(ws, "longwrite.yaml"), stringify({
    version: 1, project: { id: "s", artifact_type: "research_paper", mode: "auto_research_agentic" },
    research: { provider: "multi", topic: "t" },
    writing: { target_length_words: options.targetWords ?? 1_000 },
  }), "utf-8");
  await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"),
    JSON.stringify({ id: "s1", citation_depth: "A", source: "arxiv", title: "T", abstract: "a",
      year: 2025, authors: ["Ada Lovelace"], venue: "ICML", identifiers: { doi: "10.1/x" } }), "utf-8");
  await fs.writeFile(path.join(ws, "sources", "citation_plan.jsonl"),
    JSON.stringify({ section_id: "section-01", section_title: "One",
      source_ids: options.danglingPlanEntry ? ["ghost-source"] : ["s1"] }), "utf-8");
  await fs.writeFile(path.join(ws, "outline.json"), JSON.stringify({ sections: [
    { id: "section-01", title: "One", keywords: ["evidence"] },
  ] }), "utf-8");
  await fs.writeFile(path.join(ws, "sources", "bibliography.bib"),
    options.danglingBibEntry ? "@article{other, title={Other}}\n" : "@article{lovelace2025s1, title={T}}\n", "utf-8");
  const words = options.words ?? 20;
  await fs.writeFile(path.join(ws, "chapters", "section-01.md"),
    `[source:s1:p1] ${"word ".repeat(Math.max(0, words - 1))}\n`, "utf-8");
  return ws;
}

const checkFor = async (ws: string, gate: string) =>
  (await validateResearchWorkspace(ws, AS_OF)).checks.find((check) => String(check.id) === gate);
const findingsFor = async (ws: string, gate: string) => (await checkFor(ws, gate))?.findings ?? [];

describe("research validator structured output", () => {
  it("emits schema-valid findings from every check", async () => {
    const report = await validateResearchWorkspace(await workspace({ danglingBibEntry: true }), AS_OF);
    for (const check of report.checks) {
      for (const finding of check.findings) expect(FindingSchema.safeParse(finding).success).toBe(true);
    }
  });

  it("routes an unresolved citation-plan source to citation-plan repair, not metadata repair", async () => {
    // The citation plan names a record that was never classified: the prose is
    // not wrong, the record behind it does not exist.
    const findings = await findingsFor(await workspace({ danglingPlanEntry: true }), "citation_plan_consistent");
    expect(findings[0]?.required_effect).toBe("repair_citation_plan");
  });

  it("routes an unresolved bibliography entry to bibliography repair", async () => {
    const findings = await findingsFor(await workspace({ danglingBibEntry: true }), "bibliography_consistent");
    expect(findings.some((f) => f.artifact.kind === "bibliography"
      && f.required_effect === "repair_bibliography_consistency")).toBe(true);
  });

  it("asks to expand an under-length manuscript rather than trim it", async () => {
    // The previous table offered only remove_redundant_prose, leaving an
    // under-length manuscript unrepairable.
    const findings = await findingsFor(await workspace({ words: 20, targetWords: 5_000 }), "target_length");
    expect(findings[0].required_effect).toBe("expand_argument");
  });

  it("routes missing research artifacts to evidence acquisition, not a figure spec", async () => {
    const findings = await findingsFor(await workspace({ noArtifacts: true }), "research_artifacts_present");
    expect(findings[0].artifact.kind).toBe("evidence_packet");
    expect(findings[0].required_effect).toBe("acquire_additional_evidence");
  });

  it("emits findings that all resolve to a capability", async () => {
    for (const options of [{ danglingBibEntry: true }, { danglingPlanEntry: true }, { noArtifacts: true }]) {
      const report = await validateResearchWorkspace(await workspace(options), AS_OF);
      for (const check of report.checks) {
        for (const finding of check.findings) {
          expect(() => REGISTRY.resolveCapability({
            gate: finding.gate_id, kind: finding.artifact.kind, effect: finding.required_effect,
          }), String(finding.id)).not.toThrow();
        }
      }
    }
  });

  it("leaves no failing check without something to act on", async () => {
    const report = await validateResearchWorkspace(await workspace({ noArtifacts: true }), AS_OF);
    // citation_verification is a diagnostic aggregate. When a component
    // already emitted the exact finding, the aggregate deliberately does not
    // trigger duplicate diagnosis before ordinary dispatch.
    for (const check of report.checks.filter((item) => !item.pass && item.id !== "citation_verification")) {
      expect(check.findings.length > 0 || check.requires_diagnosis, String(check.id)).toBeTruthy();
    }
  });

  it("no longer emits review_no_regressions", async () => {
    const report = await validateResearchWorkspace(await workspace(), AS_OF);
    expect(report.checks.map((check) => String(check.id))).not.toContain("review_no_regressions");
  });

  it("is reproducible because the as-of date is explicit", async () => {
    const ws = await workspace();
    const first = await validateResearchWorkspace(ws, AS_OF);
    const second = await validateResearchWorkspace(ws, AS_OF);
    expect(first.checks.map((c) => c.pass)).toEqual(second.checks.map((c) => c.pass));
  });
});
