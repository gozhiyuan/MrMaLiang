import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { computeCitationVerification, computeLiteratureQuality, writeResearchAssessment } from "../src/lib/ops/research-quality.js";
import type { CitationPlanEntry, ClassifiedSource } from "../src/lib/research/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

const sources: ClassifiedSource[] = [
  {
    id: "s1",
    title: "Memory for Long-Horizon Agents",
    authors: ["A"],
    year: 2026,
    venue: "ICLR",
    url: "https://doi.org/10.1/s1",
    abstract: "long-horizon agent memory",
    source: "crossref",
    topics: ["memory"],
    identifiers: { doi: "10.1/s1" },
    metrics: { citation_count: 10 },
    quality_score: 0.9,
    score_rationale: "test",
    citation_depth: "A",
    citation_depth_rationale: "core",
  },
  {
    id: "s2",
    title: "Planning with Agents",
    authors: ["B"],
    year: 2025,
    venue: "arXiv",
    url: "https://arxiv.org/abs/2501.1",
    abstract: "planning",
    source: "arxiv",
    topics: ["planning"],
    identifiers: { arxiv_id: "2501.1" },
    quality_score: 0.8,
    score_rationale: "test",
    citation_depth: "B",
    citation_depth_rationale: "supporting",
  },
];

describe("research quality assessment", () => {
  it("computes an LQS and source upgrade candidates", () => {
    const report = computeLiteratureQuality(sources);
    expect(report.score).toBeGreaterThan(0);
    expect(report.dimensions.map((d) => d.id)).toContain("venue_upgrade");
    expect(report.upgradeCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: "s2", reason: expect.stringContaining("DOI") }),
    ]));
  });

  it("verifies cited markers against source records, plan, and bibliography", () => {
    const plan: CitationPlanEntry[] = [{ section_id: "section-1", section_title: "Intro", source_ids: ["s1", "s2"] }];
    const report = computeCitationVerification(
      sources,
      plan,
      [{ rel: "chapters/section-1.md", content: "Claim [source:s1:p7]." }],
      "@misc{s1, title = {Memory for Long-Horizon Agents}}\n@misc{s2, title = {Planning with Agents}}\n",
    );
    expect(report.pass).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.stringContaining("Planned source \"s2\" is not cited"),
    ]));
  });

  it("writes JSON, Markdown, and upgrade-plan artifacts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-research-quality-"));
    tempDirs.push(dir);
    const assessment = {
      literatureQuality: computeLiteratureQuality(sources),
      citationVerification: computeCitationVerification(
        sources,
        [{ section_id: "section-1", section_title: "Intro", source_ids: ["s1"] }],
        [{ rel: "chapters/section-1.md", content: "Claim [source:s1]." }],
        "@misc{s1, title = {Memory for Long-Horizon Agents}}\n@misc{s2, title = {Planning with Agents}}\n",
      ),
    };
    const written = await writeResearchAssessment(dir, assessment);
    expect(written).toEqual([
      "reports/research-assessment.json",
      "reports/research-assessment.md",
      "sources/source_upgrade_plan.jsonl",
    ]);
    expect(await fs.readFile(path.join(dir, "reports/research-assessment.md"), "utf-8"))
      .toContain("Literature quality score");
  });
});
