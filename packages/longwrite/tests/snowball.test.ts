import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareResearchWorkspace } from "../src/lib/research/pipeline.js";
import { ProviderRequestLimiter } from "../src/lib/research/rate-limit.js";
import { snowballWorkspace } from "../src/lib/research/snowball.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("citation-network expansion", () => {
  it("writes an explicit no-network result for the deterministic seed provider", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-snowball-"));
    roots.push(ws);
    await prepareResearchWorkspace({ workspaceDir: ws, topic: "agent memory", provider: "seed", count: 4 });
    const { results, written } = await snowballWorkspace(ws, { fetchImpl: async () => { throw new Error("must not fetch seed"); } });
    expect(results).toHaveLength(8);
    expect(results.every((result) => result.status === "skipped")).toBe(true);
    expect(new Set(results.map((result) => result.direction))).toEqual(new Set(["references", "citations"]));
    expect(written).toContain("sources/snowball_results.jsonl");
    await expect(fs.readFile(path.join(ws, "reports", "snowball.md"), "utf-8")).resolves.toContain("Citation-Network Expansion");
  });

  it("merges normalized Semantic Scholar reference records into the corpus", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-snowball-live-"));
    roots.push(ws);
    await fs.mkdir(path.join(ws, "sources"), { recursive: true });
    await fs.writeFile(path.join(ws, "sources", "deduped_sources.jsonl"), `${JSON.stringify({
      id: "seed-paper", title: "Seed paper", authors: ["A"], year: 2025, venue: "arXiv", url: "https://arxiv.org/abs/2501.1",
      abstract: "Seed", source: "arxiv", topics: ["memory"], identifiers: { arxiv_id: "2501.00001" },
    })}\n`, "utf-8");
    const { results } = await snowballWorkspace(ws, {
      maxSeeds: 1,
      limiter: new ProviderRequestLimiter({ minIntervalMs: 0 }),
      fetchImpl: async (url) => new Response(JSON.stringify({ data: [url.includes("/citations") ? { citingPaper: {
        paperId: "paper-3", title: "Forward Citing Memory Paper", abstract: "A citing memory paper.", year: 2026,
        venue: "NeurIPS", url: "https://example.test/paper-3", authors: [{ name: "C" }], externalIds: { DOI: "10.1/forward" }, citationCount: 2,
      } } : { citedPaper: {
        paperId: "paper-2", title: "Referenced Memory Paper", abstract: "A grounded memory paper.", year: 2024,
        venue: "ICLR", url: "https://example.test/paper-2", authors: [{ name: "B" }], externalIds: { DOI: "10.1/example" }, citationCount: 12,
      } }] }), { status: 200 }),
    });
    expect(results[0]).toMatchObject({ status: "expanded", discovered: 1 });
    const merged = await fs.readFile(path.join(ws, "sources", "deduped_sources.jsonl"), "utf-8");
    expect(merged).toContain("Referenced Memory Paper");
    expect(merged).toContain("Forward Citing Memory Paper");
  });
});
