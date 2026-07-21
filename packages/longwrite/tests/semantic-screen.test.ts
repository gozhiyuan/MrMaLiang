import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInit } from "../src/commands/init.js";
import {
  finalizeEvidenceBackedDepth,
  repairSemanticScreen,
  repairSourceEvidencePackets,
  selectSemanticCandidates,
  selectSourceEvidenceCandidates,
} from "../src/lib/research/semantic-screen.js";

const dirs: string[] = [];
afterEach(async () => { while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true }); });

const source = (id: string, depth: "A" | "B") => ({
  id, title: `${id} memory architecture`, authors: ["Author"], year: 2026,
  venue: "ICLR", url: `https://example.test/${id}`,
  abstract: `${id} studies memory architecture and planning with evaluated retrieval methods.`,
  source: "arxiv", topics: ["memory architecture", "planning"],
  identifiers: { arxiv_id: "2601.00001" }, quality_score: depth === "A" ? 0.9 : 0.8,
  score_rationale: "fixture", citation_depth: depth, citation_depth_rationale: "metadata fixture",
});

describe("agentic semantic-screen contract", () => {
  it("keeps A/B only after bounded semantic and full-text evidence validation", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-semantic-screen-"));
    dirs.push(dir);
    await runInit(dir, {
      mode: "auto_research_agentic", topic: "Memory architecture", researchProvider: "multi",
      taxonomy: ["memory architecture"],
    });
    const sources = [source("paper-a", "A"), source("paper-b", "B")];
    await fs.writeFile(path.join(dir, "sources", "classified_sources.jsonl"), `${sources.map(JSON.stringify).join("\n")}\n`, "utf-8");
    await selectSemanticCandidates(dir);
    const candidates = JSON.parse(await fs.readFile(path.join(dir, "sources", "semantic-screening-candidates.json"), "utf-8"));
    expect(candidates.candidates.map((item: { id: string }) => item.id)).toEqual(["paper-a", "paper-b"]);

    await fs.writeFile(path.join(dir, "sources", "semantic-screening.json"), JSON.stringify({
      version: 1,
      screenings: [
        { source_id: "paper-a", taxonomy_cells: ["memory architecture"], chapter_role: "protagonist", semantic_relevance: "high", rationale: "It directly presents a memory architecture and evaluates its planning consequences.", recommended_depth: "A", fulltext_priority: true },
        { source_id: "paper-b", taxonomy_cells: ["memory architecture"], chapter_role: "comparison", semantic_relevance: "medium", rationale: "It supplies a useful comparison baseline for memory architecture choices.", recommended_depth: "B", fulltext_priority: true },
      ],
    }), "utf-8");
    await repairSemanticScreen(dir);

    await fs.mkdir(path.join(dir, "fulltext"), { recursive: true });
    await fs.writeFile(path.join(dir, "fulltext", "paper-a.md"), "Memory architecture stores episodic traces. Planning retrieves traces before tool use. The method reports a retrieval ablation.", "utf-8");
    await fs.writeFile(path.join(dir, "fulltext", "paper-b.md"), "The comparison baseline stores concise task summaries. It reports lower retrieval cost under the same planning setting.", "utf-8");
    await fs.writeFile(path.join(dir, "fulltext", "manifest.json"), JSON.stringify({ results: [
      { sourceId: "paper-a", status: "ingested", path: "fulltext/paper-a.md" },
      { sourceId: "paper-b", status: "ingested", path: "fulltext/paper-b.md" },
    ] }), "utf-8");
    await selectSourceEvidenceCandidates(dir);
    await fs.mkdir(path.join(dir, "evidence"), { recursive: true });
    await fs.writeFile(path.join(dir, "evidence", "source-packets.json"), JSON.stringify({
      version: 1,
      packets: [
        { source_id: "paper-a", recommended_depth: "A", claims: [
          { claim: "The method stores episodic traces.", supporting_excerpt: "Memory architecture stores episodic traces", locator: "opening", comparison_dimensions: ["memory representation"], limitations: [] },
          { claim: "Planning retrieves traces before tool use.", supporting_excerpt: "Planning retrieves traces before tool use", locator: "opening", comparison_dimensions: ["planning integration"], limitations: ["The excerpt reports one retrieval ablation."] },
        ] },
        { source_id: "paper-b", recommended_depth: "B", claims: [
          { claim: "The baseline stores concise summaries and reports lower retrieval cost.", supporting_excerpt: "The comparison baseline stores concise task summaries", locator: "opening", comparison_dimensions: ["retrieval cost"], limitations: [] },
        ] },
      ],
    }), "utf-8");
    await repairSourceEvidencePackets(dir);
    await finalizeEvidenceBackedDepth(dir);
    const finalized = (await fs.readFile(path.join(dir, "sources", "classified_sources.jsonl"), "utf-8")).trim().split("\n").map(JSON.parse);
    expect(finalized.map((item: { citation_depth: string }) => item.citation_depth)).toEqual(["A", "B"]);
  });

  it("fails a fabricated source-evidence excerpt instead of accepting an LLM assertion", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-semantic-screen-invalid-"));
    dirs.push(dir);
    await fs.mkdir(path.join(dir, "sources"), { recursive: true });
    await fs.mkdir(path.join(dir, "fulltext"), { recursive: true });
    await fs.mkdir(path.join(dir, "evidence"), { recursive: true });
    await fs.writeFile(path.join(dir, "longwrite.yaml"), `version: 1\nproject: { id: test, artifact_type: research_paper, mode: auto_research_agentic }\nresearch: { topic: test, taxonomy: [], semantic_screen: { enabled: true, max_candidates: 2, min_candidates_per_taxonomy_cell: 0, max_evidence_sources: 2, min_supported_claims_for_a: 2, min_supported_claims_for_b: 1 } }\nwriting: {}\npublication: {}\nfigures: {}\nreview: {}\nexecution: {}\n`);
    await fs.writeFile(path.join(dir, "sources", "source-evidence-candidates.json"), JSON.stringify({ version: 1, candidates: [{ id: "paper", fulltext_path: "fulltext/paper.md" }] }));
    await fs.writeFile(path.join(dir, "fulltext", "paper.md"), "This is retrieved text with a real supported statement.");
    await fs.writeFile(path.join(dir, "evidence", "source-packets.json"), JSON.stringify({ version: 1, packets: [{ source_id: "paper", recommended_depth: "B", claims: [{ claim: "Fabricated claim has no support.", supporting_excerpt: "invented text never appears", locator: "none" }] }] }));
    await expect(repairSourceEvidencePackets(dir)).rejects.toThrow(/invalid source-evidence contract/);
  });
});
