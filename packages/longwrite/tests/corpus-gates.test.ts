import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { evaluateCorpusGates, writeCorpusGateReport } from "../src/lib/research/corpus-gates.js";
import { toJsonl } from "../src/lib/research/jsonl.js";
import type { ClassifiedSource } from "../src/lib/research/types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-corpus-gates-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "sources"), { recursive: true });
  await fs.writeFile(path.join(ws, "longwrite.yaml"), stringify({
    version: 1,
    project: { id: "survey", artifact_type: "research_paper", mode: "auto_research_agentic" },
    research: {
      provider: "multi",
      topic: "agent memory planning",
      taxonomy: ["memory", "planning"],
      corpus_gates: {
        min_candidates: 3,
        min_sources_per_taxonomy_cell: 1,
        min_core_sources: 2,
        min_recent_ratio: 0,
        min_source_type_diversity: 2,
      },
    },
  }), "utf-8");
  return ws;
}

function source(id: string, sourceProvider: ClassifiedSource["source"], abstract: string, depth: ClassifiedSource["citation_depth"], topics = ["memory", "planning"]): ClassifiedSource {
  return {
    id,
    title: `${id} title`,
    authors: ["A"],
    year: 2025,
    venue: "Venue",
    url: `https://example.test/${id}`,
    abstract,
    source: sourceProvider,
    topics,
    identifiers: sourceProvider === "openalex" ? { openalex_id: `W-${id}` } : { doi: `10.1/${id}` },
    quality_score: 8,
    score_rationale: "test",
    citation_depth: depth,
    citation_depth_rationale: "test",
  };
}

describe("corpus gates", () => {
  it("passes when full-mode breadth targets are met", async () => {
    const ws = await workspace();
    await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"), toJsonl([
      source("s1", "crossref", "memory planning", "A"),
      source("s2", "openalex", "planning", "B"),
      source("s3", "semantic_scholar", "memory", "C"),
    ]), "utf-8");
    const report = await evaluateCorpusGates(ws);
    expect(report.pass).toBe(true);
    await writeCorpusGateReport(ws, report);
    await expect(fs.readFile(path.join(ws, "reports", "corpus-gates.md"), "utf-8")).resolves.toContain("Status: pass");
  });

  it("fails when candidate and taxonomy coverage are too thin", async () => {
    const ws = await workspace();
    await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"), toJsonl([
      source("s1", "crossref", "memory only", "C", ["memory"]),
    ]), "utf-8");
    const report = await evaluateCorpusGates(ws);
    expect(report.pass).toBe(false);
    expect(report.findings.filter((finding) => !finding.pass).map((finding) => finding.id))
      .toEqual(expect.arrayContaining(["total_candidates", "core_sources", "taxonomy:planning"]));
  });

  it("uses planned-query provenance for an expanded taxonomy label", async () => {
    const ws = await workspace();
    await fs.writeFile(path.join(ws, "longwrite.yaml"), stringify({
      version: 1,
      project: { id: "survey", artifact_type: "research_paper", mode: "auto_research_agentic" },
      research: {
        provider: "multi",
        topic: "agent memory",
        taxonomy: ["memory architectures"],
        corpus_gates: { min_candidates: 1, min_sources_per_taxonomy_cell: 1, min_core_sources: 1, min_recent_ratio: 0, min_source_type_diversity: 1 },
      },
    }), "utf-8");
    await fs.writeFile(path.join(ws, "sources", "search-plan.json"), JSON.stringify({
      version: 1,
      topic: "agent memory",
      query_variants: ["agent memory overview"],
      taxonomy_cells: [{ cell: "Memory architectures and lifecycle", query_variants: ["agent memory storage architecture", "agent memory lifecycle", "agent memory consolidation"] }],
    }), "utf-8");
    await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"), toJsonl([
      { ...source("s1", "crossref", "Unrelated abstract", "A", []), provenance: { query: "agent memory storage architecture", provider: "multi", retrieved_at: "2026-01-01T00:00:00Z" } },
    ]), "utf-8");

    const report = await evaluateCorpusGates(ws);
    expect(report.pass).toBe(true);
    expect(report.taxonomy[0]).toMatchObject({ source_count: 1, coverage_method: "planned_query_provenance", pass: true });
  });
});
