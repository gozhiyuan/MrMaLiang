import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { evaluateGateReachability, writeGateReachability } from "../src/lib/research/gate-reachability.js";

const tempDirs: string[] = [];
afterEach(async () => {
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function makeWorkspace(depths: string[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-reachability-"));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, "sources"), { recursive: true });
  await fs.writeFile(path.join(dir, "longwrite.yaml"), [
    "version: 1",
    "project:",
    "  id: reachability",
    "  artifact_type: research_paper",
    "  mode: auto_research_agentic",
    "research:",
    "  paper_kind: survey",
    "  paper_profile: literature_survey",
    "  taxonomy:",
    "    - memory architectures",
    "    - evaluation and benchmarks",
    "  release_gates:",
    "    min_cited_sources: 5",
    "    min_citation_depths_per_section:",
    "      A: 1",
    "      B: 2",
    "      C: 2",
    "    min_cited_ab_sources_per_taxonomy_cell: 2",
    "  semantic_screen:",
    "    enabled: true",
    "    max_evidence_sources: 32",
    "",
  ].join("\n"), "utf-8");
  await fs.writeFile(path.join(dir, "outline.json"), JSON.stringify({
    sections: [{ id: "section-1" }, { id: "section-2" }, { id: "section-3" }],
  }));
  await fs.writeFile(path.join(dir, "sources", "classified_sources.jsonl"),
    depths.map((depth, index) => JSON.stringify({
      id: `s${index}`, title: `t${index}`, authors: [], year: 2026, venue: "v", url: "u",
      abstract: "a", source: "arxiv", topics: [], quality_score: 1, score_rationale: "r",
      citation_depth: depth,
    })).join("\n") + "\n", "utf-8");
  return dir;
}

describe("release-gate reachability", () => {
  // The failure this exists to catch: a flagship drafted 14k words before its
  // per-section A requirement met a corpus holding zero A-level sources.
  it("reports a per-section depth gate as unreachable when no source has that depth", async () => {
    const ws = await makeWorkspace(["B", "B", "B", "C", "C", "C", "C"]);
    const report = await evaluateGateReachability(ws);

    const gateA = report.gates.find((gate) => gate.id === "min_citation_depths_per_section.A")!;
    expect(gateA.reachable).toBe(false);
    expect(gateA.available).toBe(0);
    expect(gateA.detail).toContain("max_evidence_sources");

    // B is supplied, so it must not be reported as blocked alongside it.
    expect(report.gates.find((gate) => gate.id === "min_citation_depths_per_section.B")!.reachable).toBe(true);
  });

  it("counts C-level sources toward a citation-count gate that does not require packets", async () => {
    const ws = await makeWorkspace(["B", "C", "C", "C", "C", "D"]);
    const report = await evaluateGateReachability(ws);
    const cited = report.gates.find((gate) => gate.id === "min_cited_sources")!;
    // D is dropped, not cited; A/B/C are citable.
    expect(cited.available).toBe(5);
    expect(cited.reachable).toBe(true);
  });

  it("reports rather than fails, and says so", async () => {
    const ws = await makeWorkspace(["C", "C"]);
    const { report, written } = await writeGateReachability(ws);
    expect(report.gates.some((gate) => !gate.reachable)).toBe(true);
    const markdown = await fs.readFile(path.join(ws, written[1]), "utf-8");
    expect(markdown).toContain("reports and never fails");
    expect(markdown).toContain("out of reach");
  });

  it("stays silent before a corpus exists rather than reporting everything as blocked", async () => {
    const ws = await makeWorkspace([]);
    await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"), "", "utf-8");
    const report = await evaluateGateReachability(ws);
    expect(report.evaluated).toBe(false);
    expect(report.gates).toEqual([]);
  });
});
