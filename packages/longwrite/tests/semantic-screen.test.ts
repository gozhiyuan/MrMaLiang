import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInit } from "../src/commands/init.js";
import {
  backfillValidatedEvidenceHistory,
  finalizeEvidenceBackedDepth,
  repairSemanticScreen,
  repairSourceEvidencePackets,
  selectSemanticCandidates,
  selectSourceEvidenceCandidates,
  ACTIVE_VALIDATED_SOURCE_EVIDENCE_PATH,
  VALIDATED_SOURCE_EVIDENCE_HISTORY_PATH,
} from "../src/lib/research/semantic-screen.js";

const dirs: string[] = [];
afterEach(async () => { while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true }); });

const source = (id: string, depth: "A" | "B" | "C") => ({
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
    const history = JSON.parse(await fs.readFile(path.join(dir, VALIDATED_SOURCE_EVIDENCE_HISTORY_PATH), "utf-8"));
    expect(history.entries.map((entry: { packet: { source_id: string } }) => entry.packet.source_id)).toEqual(["paper-a", "paper-b"]);
    await finalizeEvidenceBackedDepth(dir);
    const active = JSON.parse(await fs.readFile(path.join(dir, ACTIVE_VALIDATED_SOURCE_EVIDENCE_PATH), "utf-8"));
    expect(active.entries.map((entry: { packet: { source_id: string } }) => entry.packet.source_id)).toEqual(["paper-a", "paper-b"]);
    const finalized = (await fs.readFile(path.join(dir, "sources", "classified_sources.jsonl"), "utf-8")).trim().split("\n").map(JSON.parse);
    expect(finalized.map((item: { citation_depth: string }) => item.citation_depth)).toEqual(["A", "B"]);
  });

  it("normalizes lossless locator and limitation shapes before exact-excerpt validation", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-semantic-loose-packet-"));
    dirs.push(dir);
    await runInit(dir, { mode: "auto_research_agentic", topic: "Memory architecture", researchProvider: "multi", taxonomy: ["memory architecture"] });
    await fs.writeFile(path.join(dir, "sources", "classified_sources.jsonl"), `${JSON.stringify(source("paper", "B"))}\n`, "utf-8");
    await fs.writeFile(path.join(dir, "sources", "semantic-screening.json"), JSON.stringify({ version: 1, screenings: [{ source_id: "paper", taxonomy_cells: ["memory architecture"], chapter_role: "comparison", semantic_relevance: "high", rationale: "It supplies an evidence-backed comparison for the configured memory architecture topic.", recommended_depth: "B", fulltext_priority: true }] }), "utf-8");
    await fs.mkdir(path.join(dir, "fulltext"), { recursive: true });
    await fs.writeFile(path.join(dir, "fulltext", "paper.md"), "Memory architecture stores episodic traces for planning and tool use.", "utf-8");
    await fs.writeFile(path.join(dir, "fulltext", "manifest.json"), JSON.stringify({ results: [{ sourceId: "paper", status: "ingested", path: "fulltext/paper.md" }] }), "utf-8");
    await selectSourceEvidenceCandidates(dir);
    await fs.mkdir(path.join(dir, "evidence"), { recursive: true });
    await fs.writeFile(path.join(dir, "evidence", "source-packets.json"), JSON.stringify({ version: 1, packets: [{ source_id: "paper", recommended_depth: "B", claims: [{ claim: "The architecture stores episodic traces for planning.", supporting_excerpt: "Memory architecture stores episodic traces for planning and tool use", locator: { paragraph: 1 }, comparison_dimensions: [], limitations: "The excerpt does not measure every planning setting." }] }] }), "utf-8");
    await repairSourceEvidencePackets(dir);
    const repaired = JSON.parse(await fs.readFile(path.join(dir, "evidence", "source-packets.json"), "utf8"));
    expect(repaired.packets[0].claims[0]).toMatchObject({ locator: "paragraph: 1", limitations: ["The excerpt does not measure every planning setting."] });
  });

  it("retains earlier validated evidence and can promote a later C-level source", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-semantic-history-"));
    dirs.push(dir);
    await runInit(dir, {
      mode: "auto_research_agentic", topic: "Memory architecture", researchProvider: "multi",
      taxonomy: ["memory architecture"],
    });
    const sources = [source("earlier-a", "A"), source("later-c", "C")];
    await fs.writeFile(path.join(dir, "sources", "metadata-classified_sources.jsonl"), `${sources.map(JSON.stringify).join("\n")}\n`, "utf-8");
    await fs.mkdir(path.join(dir, "evidence"), { recursive: true });
    const screening = (source_id: string, recommended_depth: "A" | "B") => ({
      source_id, taxonomy_cells: ["memory architecture"], chapter_role: "protagonist",
      semantic_relevance: "high", rationale: "It directly evaluates a memory architecture with a reproducible planning comparison.",
      recommended_depth, fulltext_priority: true,
    });
    const packet = (source_id: string, recommended_depth: "A" | "B", claims: number) => ({
      source_id, recommended_depth,
      claims: Array.from({ length: claims }, (_, index) => ({
        claim: `Supported claim ${index + 1} describes the source's evaluated memory architecture.`,
        supporting_excerpt: "This exact excerpt is retained as validated evidence",
        locator: `section ${index + 1}`,
      })),
    });
    await fs.writeFile(path.join(dir, VALIDATED_SOURCE_EVIDENCE_HISTORY_PATH), JSON.stringify({
      version: 1,
      entries: [
        { screening: screening("earlier-a", "A"), packet: packet("earlier-a", "A", 2) },
        { screening: screening("later-c", "B"), packet: packet("later-c", "B", 1) },
        // This is retained as audit history but deliberately absent from the
        // current classified corpus, so it must never leak into the
        // citation-ready dossier given to the outline/review stages.
        { screening: screening("archived-source", "B"), packet: packet("archived-source", "B", 1) },
      ],
    }), "utf-8");
    // The new recovery round carries only the newly recovered source. The
    // retained history must still keep earlier-a at A while later-c is allowed
    // to graduate from metadata C to evidence-backed B.
    await fs.writeFile(path.join(dir, "sources", "semantic-screening.json"), JSON.stringify({
      version: 1, screenings: [screening("later-c", "B")],
    }), "utf-8");
    await fs.writeFile(path.join(dir, "evidence", "source-packets.json"), JSON.stringify({
      version: 1, packets: [packet("later-c", "B", 1)],
    }), "utf-8");
    await finalizeEvidenceBackedDepth(dir);
    const finalized = (await fs.readFile(path.join(dir, "sources", "classified_sources.jsonl"), "utf-8")).trim().split("\n").map(JSON.parse);
    expect(finalized.map((item: { citation_depth: string }) => item.citation_depth)).toEqual(["A", "B"]);
    const active = JSON.parse(await fs.readFile(path.join(dir, ACTIVE_VALIDATED_SOURCE_EVIDENCE_PATH), "utf-8"));
    expect(active.entries.map((entry: { packet: { source_id: string } }) => entry.packet.source_id)).toEqual(["earlier-a", "later-c"]);
  });

  it("backfills validated evidence from quality and final-release checkpoints", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-semantic-checkpoint-history-"));
    dirs.push(dir);
    const checkpoints = path.join(dir, ".malaclaw", "flow", "checkpoints");
    const screenCheckpoint = path.join(checkpoints, "2026-08-11T05-00-00-000Z-final_release_recovery_loop-r2-quality_semantic_screen");
    const packetCheckpoint = path.join(checkpoints, "2026-08-11T05-01-00-000Z-final_release_recovery_loop-r2-quality_source_evidence_extract");
    await fs.mkdir(path.join(screenCheckpoint, "sources"), { recursive: true });
    await fs.mkdir(path.join(packetCheckpoint, "evidence"), { recursive: true });
    const screening = {
      source_id: "retained-a", taxonomy_cells: ["memory architecture"], chapter_role: "protagonist",
      semantic_relevance: "high", rationale: "It directly evaluates a memory architecture with a reproducible planning comparison.",
      recommended_depth: "A", fulltext_priority: true,
    };
    const packet = {
      source_id: "retained-a", recommended_depth: "A", claims: [
        { claim: "One supported claim describes the source's evaluated memory architecture.", supporting_excerpt: "This exact excerpt is retained as validated evidence", locator: "one" },
        { claim: "A second supported claim independently describes the planning comparison.", supporting_excerpt: "This exact excerpt is retained as validated evidence", locator: "two" },
      ],
    };
    await fs.writeFile(path.join(screenCheckpoint, "sources", "semantic-screening.json"), JSON.stringify({ version: 1, screenings: [screening] }), "utf-8");
    await fs.writeFile(path.join(packetCheckpoint, "evidence", "source-packets.json"), JSON.stringify({ version: 1, packets: [packet] }), "utf-8");

    const result = await backfillValidatedEvidenceHistory(dir);
    expect(result.recovered).toBe(1);
    const history = JSON.parse(await fs.readFile(path.join(dir, VALIDATED_SOURCE_EVIDENCE_HISTORY_PATH), "utf-8"));
    expect(history.entries.map((entry: { packet: { source_id: string } }) => entry.packet.source_id)).toEqual(["retained-a"]);
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

  it("rejects exact provider metadata as non-claim evidence", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-semantic-screen-metadata-"));
    dirs.push(dir);
    await Promise.all(["sources", "fulltext", "evidence"].map((name) => fs.mkdir(path.join(dir, name), { recursive: true })));
    await fs.writeFile(path.join(dir, "longwrite.yaml"), `version: 1\nproject: { id: test, artifact_type: research_paper, mode: auto_research_agentic }\nresearch: { topic: test, taxonomy: [], semantic_screen: { enabled: true, max_candidates: 2, min_candidates_per_taxonomy_cell: 0, max_evidence_sources: 2, min_supported_claims_for_a: 2, min_supported_claims_for_b: 1 } }\nwriting: {}\npublication: {}\nfigures: {}\nreview: {}\nexecution: {}\n`);
    const title = "The Agent Operating System";
    const metadata = "[Submitted on 4 Aug 2026] Title: The Agent Operating System Authors: A. Author View a PDF of the paper";
    await fs.writeFile(path.join(dir, "sources", "source-evidence-candidates.json"), JSON.stringify({ version: 1, candidates: [{ id: "paper", title, fulltext_path: "fulltext/paper.md" }] }));
    await fs.writeFile(path.join(dir, "fulltext", "paper.md"), metadata);
    await fs.writeFile(path.join(dir, "evidence", "source-packets.json"), JSON.stringify({ version: 1, packets: [{ source_id: "paper", recommended_depth: "B", claims: [{ claim: "The source presents an operating architecture.", supporting_excerpt: metadata, locator: "paragraph: 1" }] }] }));
    await expect(repairSourceEvidencePackets(dir)).rejects.toThrow(/invalid source-evidence contract/);
    await expect(fs.readFile(path.join(dir, "reports", "source-evidence-repair.md"), "utf8")).resolves.toContain("bibliographic/provider metadata");
  });

  it("reports a too-short exact excerpt as a repairable contract error", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-semantic-screen-short-excerpt-"));
    dirs.push(dir);
    await fs.mkdir(path.join(dir, "sources"), { recursive: true });
    await fs.mkdir(path.join(dir, "fulltext"), { recursive: true });
    await fs.mkdir(path.join(dir, "evidence"), { recursive: true });
    await fs.writeFile(path.join(dir, "longwrite.yaml"), `version: 1\nproject: { id: test, artifact_type: research_paper, mode: auto_research_agentic }\nresearch: { topic: test, taxonomy: [], semantic_screen: { enabled: true, max_candidates: 2, min_candidates_per_taxonomy_cell: 0, max_evidence_sources: 2, min_supported_claims_for_a: 2, min_supported_claims_for_b: 1 } }\nwriting: {}\npublication: {}\nfigures: {}\nreview: {}\nexecution: {}\n`);
    await fs.writeFile(path.join(dir, "sources", "source-evidence-candidates.json"), JSON.stringify({ version: 1, candidates: [{ id: "paper", fulltext_path: "fulltext/paper.md" }] }));
    await fs.writeFile(path.join(dir, "fulltext", "paper.md"), "This text contains five perspectives on the tested system.");
    await fs.writeFile(path.join(dir, "evidence", "source-packets.json"), JSON.stringify({ version: 1, packets: [{ source_id: "paper", recommended_depth: "B", claims: [{ claim: "The paper names perspectives.", supporting_excerpt: "five perspectives", locator: "opening" }] }] }));
    await expect(repairSourceEvidencePackets(dir)).rejects.toThrow(/invalid source-evidence contract/);
    const report = await fs.readFile(path.join(dir, "reports", "source-evidence-repair.md"), "utf8");
    expect(report).toContain("2 normalized words");
    expect(report).toContain("at least 4 words");
  });
});
