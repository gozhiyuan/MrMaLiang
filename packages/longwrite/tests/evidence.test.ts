import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  allocateSectionEvidence,
  auditCitationEvidence,
  buildEvidenceIndex,
  consolidateCitationLedger,
  searchEvidence,
  validateEvidenceLedger,
} from "../src/lib/research/evidence.js";

const roots: string[] = [];

const source = (id: string, title: string) => ({
  id,
  title,
  authors: ["Ada Lovelace"],
  year: 2025,
  venue: "ICLR",
  url: `https://example.test/${id}`,
  abstract: `${title} evaluates long-horizon planning and memory.`,
  source: "arxiv",
  topics: ["planning", "memory"],
  quality_score: 0.9,
  score_rationale: "test",
  citation_depth: "A",
  citation_depth_rationale: "test",
  identifiers: { arxiv_id: "2501.00001" },
});

async function workspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-evidence-"));
  roots.push(dir);
  await fs.mkdir(path.join(dir, "sources"), { recursive: true });
  await fs.mkdir(path.join(dir, "fulltext"), { recursive: true });
  await fs.writeFile(path.join(dir, "sources", "classified_sources.jsonl"), [
    source("paper-a", "Tool planning for agents"),
    source("paper-b", "Long-term memory systems for agents"),
  ].map(JSON.stringify).join("\n") + "\n", "utf-8");
  const prose = "Evidence about planning and memory in long-horizon agents. ".repeat(80);
  await fs.writeFile(path.join(dir, "fulltext", "paper-a.md"), `# Planning\n\nSource: https://example.test/a\n\n---\n\n## Hierarchical Planning\n\n${prose}`, "utf-8");
  await fs.writeFile(path.join(dir, "fulltext", "paper-b.md"), `# Memory\n\nSource: https://example.test/b\n\n---\n\n## Long-term Memory\n\n${prose}`, "utf-8");
  await fs.writeFile(path.join(dir, "outline.json"), JSON.stringify({
    sections: [
      { id: "section-1", title: "Hierarchical Planning", keywords: ["planning"] },
      { id: "section-2", title: "Long-term Memory", keywords: ["memory"] },
    ],
  }), "utf-8");
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function nodeAtLeast22(): boolean {
  return Number(process.versions.node.split(".")[0]) >= 22;
}

describe.skipIf(!nodeAtLeast22())("workspace evidence corpus", () => {
  it("builds a reproducible SQLite FTS index and retrieves attributable chunks", async () => {
    const ws = await workspace();
    const result = await buildEvidenceIndex(ws);
    expect(result.chunks).toBeGreaterThan(1);
    await expect(fs.access(path.join(ws, "evidence", "index.sqlite"))).resolves.toBeUndefined();
    const hits = await searchEvidence(ws, "hierarchical planning", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({ source_id: "paper-a", locator: { heading: "Hierarchical Planning" } });
  });

  it("allocates section packets and validates a citation ledger against them", async () => {
    const ws = await workspace();
    await buildEvidenceIndex(ws);
    const allocation = await allocateSectionEvidence(ws, ["planning", "memory"]);
    expect(allocation.sections).toBe(2);
    const packet = JSON.parse(await fs.readFile(path.join(ws, "evidence", "section-section-1.json"), "utf-8"));
    expect(packet.source_ids).toContain("paper-a");

    await fs.mkdir(path.join(ws, "chapters"), { recursive: true });
    await fs.writeFile(
      path.join(ws, "chapters", "section-1.md"),
      `A planning claim [source:${packet.chunks[0].id}].\n`,
      "utf-8",
    );
    const ledger = await consolidateCitationLedger(ws);
    expect(ledger.entries).toBe(1);
    const entry = JSON.parse(await fs.readFile(path.join(ws, "evidence", "citation-ledger.jsonl"), "utf-8"));
    expect(entry).toMatchObject({ source_id: "paper-a", status: "evidence_linked" });
    expect(entry.locator).toBeDefined();
    await expect(validateEvidenceLedger(ws)).resolves.toEqual({ pass: true, findings: [] });
  });

  it("falls back to chunks from selected sources when an outline id has no lexical match", async () => {
    const ws = await workspace();
    await buildEvidenceIndex(ws);
    await fs.writeFile(path.join(ws, "outline.json"), JSON.stringify({
      sections: [{ id: "section-1", title: "Section 1", keywords: [] }],
    }), "utf-8");
    await allocateSectionEvidence(ws);
    const packet = JSON.parse(await fs.readFile(path.join(ws, "evidence", "section-section-1.json"), "utf-8"));
    expect(packet.chunks.length).toBeGreaterThan(0);
    expect(packet.chunks[0].source_id).toMatch(/paper-[ab]/);
  });

  it("writes a concise evidence audit for generic or unsupported citations", async () => {
    const ws = await workspace();
    await buildEvidenceIndex(ws);
    await allocateSectionEvidence(ws, ["planning"]);
    await fs.mkdir(path.join(ws, "chapters"), { recursive: true });
    await fs.writeFile(path.join(ws, "chapters", "section-1.md"), "Claim [source:paper-a].\n", "utf-8");
    await consolidateCitationLedger(ws);
    const audit = await auditCitationEvidence(ws);
    expect(audit.pass).toBe(false);
    expect(audit.metadataLinked).toBe(1);
    await expect(fs.readFile(path.join(ws, "reports", "evidence-audit.md"), "utf-8"))
      .resolves.toContain("exact chunk id");
  });

  it("measures taxonomy coverage by meaningful label terms rather than exact phrases", async () => {
    const ws = await workspace();
    await buildEvidenceIndex(ws);
    const result = await allocateSectionEvidence(ws, ["tool-use planning", "long-term memory"]);
    const coverage = JSON.parse(await fs.readFile(path.join(ws, result.coveragePath), "utf-8"));
    expect(coverage.taxonomy).toEqual(expect.arrayContaining([
      expect.objectContaining({ cell: "tool-use planning", source_count: 1 }),
      expect.objectContaining({ cell: "long-term memory", source_count: 2 }),
    ]));
  });

  it("persists optional embedding vectors for hybrid retrieval", async () => {
    const ws = await workspace();
    const embeddingClient = {
      model: "test-embedding",
      embed: async (inputs: string[]) => inputs.map((input) => input.includes("Memory") ? [0, 1] : [1, 0]),
    };
    const result = await buildEvidenceIndex(ws, { backend: "hybrid_openai", embeddingClient });
    expect(result.written).toContain("evidence/embeddings.jsonl");
    const manifest = JSON.parse(await fs.readFile(path.join(ws, "evidence", "manifest.json"), "utf-8"));
    expect(manifest).toMatchObject({ backend: "hybrid_openai", embedding_model: "test-embedding" });
    const hits = await searchEvidence(ws, "long-term memory", 5, { embeddingClient });
    expect(hits.length).toBeGreaterThan(0);
  });
});
