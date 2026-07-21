import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildResearchArtifacts, buildResearchArtifactsWithProvider, prepareResearchWorkspace } from "../src/lib/research/pipeline.js";
import { classifySources } from "../src/lib/research/classify.js";
import { dedupeSources, duplicateKeys } from "../src/lib/research/dedupe.js";
import { parseJsonl } from "../src/lib/research/jsonl.js";
import type { CitationPlanEntry, ClassifiedSource, RawSource, ScoredSource } from "../src/lib/research/types.js";

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-research-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

describe("research artifact pipeline", () => {
  it("builds raw, scored, classified, BibTeX, and citation-plan artifacts", () => {
    const artifacts = buildResearchArtifacts("Long-horizon agent memory", 6);
    expect(artifacts.raw).toHaveLength(6);
    expect(artifacts.deduped).toHaveLength(6);
    expect(artifacts.scored).toHaveLength(6);
    expect(artifacts.classified).toHaveLength(6);
    expect(artifacts.citationPlan.length).toBeGreaterThan(0);
    expect(artifacts.bibliographyBibtex).toContain("@misc");
    expect(artifacts.reportMarkdown).toContain("Long-horizon agent memory");

    const sourceIds = new Set(artifacts.classified.map((source) => source.id));
    for (const entry of artifacts.citationPlan) {
      expect(entry.section_id).toMatch(/^section-/);
      expect(entry.source_ids.every((id) => sourceIds.has(id))).toBe(true);
    }
  });

  it("assigns scores and citation depth deterministically", () => {
    const first = buildResearchArtifacts("Long-horizon agent memory", 4);
    const second = buildResearchArtifacts("Long-horizon agent memory", 4);
    expect(second.scored.map((source) => source.quality_score))
      .toEqual(first.scored.map((source) => source.quality_score));
    expect(first.classified.every((source) => ["A", "B", "C", "D"].includes(source.citation_depth))).toBe(true);
  });

  it("keeps a relevant but metadata-incomplete source as a C retrieval candidate", () => {
    const classified = classifySources([{
      id: "arxiv-candidate", title: "Relevant preprint", authors: ["A"], year: 2026,
      venue: "arXiv", url: "https://arxiv.org/abs/2601.00001", abstract: "agent memory planning",
      source: "arxiv", topics: ["agent", "memory"], identifiers: { arxiv_id: "2601.00001v1" },
      quality_score: 0.6, score_rationale: "LQS=6.0/10",
    }]);
    expect(classified[0].citation_depth).toBe("C");
  });

  it("supports the provider-backed artifact path with seed data", async () => {
    const artifacts = await buildResearchArtifactsWithProvider({
      topic: "Long-horizon agent memory",
      count: 3,
      provider: "seed",
    });
    expect(artifacts.raw).toHaveLength(3);
    expect(artifacts.deduped).toHaveLength(3);
    expect(artifacts.reportMarkdown).toContain("Provider: seed");
  });
});

describe("source deduplication", () => {
  const baseSource: RawSource = {
    id: "paper-a",
    title: "Long-Horizon Agent Memory",
    authors: ["Ada Lovelace"],
    year: 2024,
    venue: "arXiv",
    url: "https://arxiv.org/abs/2401.12345v1",
    abstract: "Short abstract.",
    source: "arxiv",
    topics: ["agent", "memory"],
    identifiers: { arxiv_id: "2401.12345v1" },
  };

  it("creates conservative duplicate keys from identifiers, URL, and title/year", () => {
    expect(duplicateKeys(baseSource)).toEqual([
      "arxiv:2401.12345v1",
      "url:https://arxiv.org/abs/2401.12345v1",
      "title-year:long horizon agent memory:2024",
    ]);
  });

  it("uses Semantic Scholar identifiers as duplicate keys", () => {
    expect(duplicateKeys({
      ...baseSource,
      identifiers: {
        ...baseSource.identifiers,
        semantic_scholar_id: "649def34f8be52c8b66281af98ae884c09aef38b",
      },
    })).toContain("semantic-scholar:649def34f8be52c8b66281af98ae884c09aef38b");
  });

  it("merges duplicate sources and preserves provenance ids", () => {
    const sources = dedupeSources([
      baseSource,
      {
        ...baseSource,
        id: "paper-b",
        authors: ["Grace Hopper"],
        url: "https://example.org/copy",
        abstract: "Longer abstract about long-horizon agent memory and planning.",
        identifiers: { doi: "10.1234/example" },
      },
    ]);

    expect(sources).toHaveLength(1);
    expect(sources[0].authors).toEqual(["Ada Lovelace", "Grace Hopper"]);
    expect(sources[0].abstract).toContain("Longer abstract");
    expect(sources[0].identifiers?.doi).toBe("10.1234/example");
    expect(sources[0].merged_from).toEqual(["paper-a", "paper-b"]);
  });
});

describe("prepareResearchWorkspace", () => {
  it("writes parseable workspace artifacts", async () => {
    const ws = await makeWorkspace();
    const written = await prepareResearchWorkspace({
      workspaceDir: ws,
      topic: "Long-horizon agent memory",
      count: 5,
    });

    expect(written).toEqual([
      "sources/raw_results.jsonl",
      "sources/deduped_sources.jsonl",
      "sources/scored_sources.jsonl",
      "sources/classified_sources.jsonl",
      "sources/bibliography.bib",
      "sources/citation_plan.jsonl",
      "reports/research-tooling.md",
    ]);

    const raw = parseJsonl<RawSource>(await fs.readFile(path.join(ws, "sources/raw_results.jsonl"), "utf-8"));
    const deduped = parseJsonl<RawSource>(await fs.readFile(path.join(ws, "sources/deduped_sources.jsonl"), "utf-8"));
    const scored = parseJsonl<ScoredSource>(await fs.readFile(path.join(ws, "sources/scored_sources.jsonl"), "utf-8"));
    const classified = parseJsonl<ClassifiedSource>(await fs.readFile(path.join(ws, "sources/classified_sources.jsonl"), "utf-8"));
    const citationPlan = parseJsonl<CitationPlanEntry>(await fs.readFile(path.join(ws, "sources/citation_plan.jsonl"), "utf-8"));
    const bib = await fs.readFile(path.join(ws, "sources/bibliography.bib"), "utf-8");

    expect(raw).toHaveLength(5);
    expect(deduped).toHaveLength(5);
    expect(scored[0].quality_score).toBeGreaterThan(0);
    expect(classified[0].citation_depth).toBeTruthy();
    expect(citationPlan[0].source_ids.length).toBeGreaterThan(0);
    expect(bib).toContain("@misc");
  });
});

describe("seed source id hygiene", () => {
  it("generates only [source:id]-citable ids (no whitespace)", async () => {
    const { generateSeedSources } = await import("../src/lib/research/seed.js");
    const sources = generateSeedSources("clean install smoke", 8);
    for (const source of sources) {
      expect(source.id, source.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    }
    // The 5th theme ("Human Review") is the one that used to break.
    expect(sources[4].id).toContain("human-review");
  });
});
