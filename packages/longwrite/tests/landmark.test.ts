import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LandmarkCandidates, matchLandmarksToCorpus, computeLandmarkCoverage } from "../src/lib/research/landmark.js";
import type { ClassifiedSource } from "../src/lib/research/types.js";
import { validateResearchWorkspace } from "../src/lib/validation/research.js";

const source = (over: Partial<ClassifiedSource>): ClassifiedSource => ({
  id: "s1", title: "Untitled", authors: [], year: 2025, venue: "arXiv", url: "https://example.com",
  abstract: "", source: "arxiv", topics: [], citation_depth: "B", citation_depth_rationale: "",
  ...over,
} as ClassifiedSource);

describe("landmark matching and coverage", () => {
  it("matches a landmark by exact arxiv_id", () => {
    const candidates = LandmarkCandidates.parse({
      version: 1,
      candidates: [{ name: "Darwin Godel Machine", why_canonical: "Iteratively modifies its own agent code and evaluates changes empirically.", expected_identifiers: { arxiv_id: "2505.22954" }, confidence: "high" }],
    }).candidates;
    const sources = [source({ id: "dgm", title: "The Darwin Godel Machine", identifiers: { arxiv_id: "2505.22954" } })];
    const matches = matchLandmarksToCorpus(candidates, sources);
    expect(matches[0]!.matchedSourceId).toBe("dgm");
    expect(matches[0]!.matchedBy).toBe("identifier");
  });

  it("matches a landmark by normalized title when no identifier is supplied", () => {
    const candidates = LandmarkCandidates.parse({
      version: 1,
      candidates: [{ name: "Promptbreeder", why_canonical: "Evolves both task prompts and the mutation prompts that improve them.", confidence: "medium" }],
    }).candidates;
    const sources = [source({ id: "pb", title: "Promptbreeder: Self-Referential Self-Improvement Via Prompt Evolution" })];
    const matches = matchLandmarksToCorpus(candidates, sources);
    expect(matches[0]!.matchedSourceId).toBe("pb");
    expect(matches[0]!.matchedBy).toBe("title");
  });

  it("leaves a landmark unmatched when absent from the corpus", () => {
    const candidates = LandmarkCandidates.parse({
      version: 1,
      candidates: [{ name: "AFlow", why_canonical: "Searches over code-represented agent workflows with execution feedback.", confidence: "high" }],
    }).candidates;
    const matches = matchLandmarksToCorpus(candidates, []);
    expect(matches[0]!.matchedSourceId).toBeNull();
  });

  it("computes coverage ratio and lists unmatched candidate names", () => {
    const matches = [
      { candidate: "A", matchedSourceId: "s1", matchedBy: "identifier" as const },
      { candidate: "B", matchedSourceId: null, matchedBy: null },
    ];
    const coverage = computeLandmarkCoverage(matches);
    expect(coverage.coverageRatio).toBe(0.5);
    expect(coverage.unmatched).toEqual(["B"]);
  });
});

const tempDirs: string[] = [];
afterEach(async () => { while (tempDirs.length) await fs.rm(tempDirs.pop()!, { recursive: true, force: true }); });

describe("landmark_coverage release gate", () => {
  it("fails when configured coverage is below threshold and reports missing candidates", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "landmark-gate-"));
    tempDirs.push(ws);
    await fs.mkdir(path.join(ws, "research"), { recursive: true });
    await fs.mkdir(path.join(ws, "sources"), { recursive: true });
    await fs.writeFile(path.join(ws, "longwrite.yaml"), [
      "version: 1",
      "project:", "  id: t", "  artifact_type: research_paper", "  mode: auto_research_agentic",
      "research:", "  corpus_gates:", "    min_landmark_coverage_ratio: 0.8",
    ].join("\n"));
    await fs.writeFile(path.join(ws, "research", "landmark-candidates.json"), JSON.stringify({
      version: 1,
      candidates: [
        { name: "Darwin Godel Machine", why_canonical: "Iteratively modifies its own agent code and evaluates changes empirically.", confidence: "high" },
        { name: "AFlow", why_canonical: "Searches over code-represented agent workflows with execution feedback.", confidence: "high" },
      ],
    }));
    await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"), "");
    const report = await validateResearchWorkspace(ws);
    const check = report.checks.find((c) => c.id === "landmark_coverage");
    expect(check?.pass).toBe(false);
    expect(check?.findings[0]).toContain("Darwin Godel Machine");
  });
});
