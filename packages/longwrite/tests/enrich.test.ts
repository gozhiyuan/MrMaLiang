import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { enrichSourceMetadata } from "../src/lib/research/enrich.js";

const tempDirs: string[] = [];

async function workspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-enrich-"));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, "sources"), { recursive: true });
  await fs.writeFile(path.join(dir, "sources", "deduped_sources.jsonl"), JSON.stringify({
    id: "memory-paper", title: "Reliable Memory for Agents", authors: ["A"], year: 2025,
    venue: "arXiv", url: "https://arxiv.org/abs/2501.00001", abstract: "short",
    source: "arxiv", topics: ["memory"], identifiers: { arxiv_id: "2501.00001" },
  }) + "\n", "utf-8");
  return dir;
}

afterEach(async () => {
  while (tempDirs.length) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

describe("metadata enrichment", () => {
  it("merges a strong Crossref title match without replacing the source URL", async () => {
    const dir = await workspace();
    const provider = {
      id: "crossref" as const,
      search: async () => [{
        id: "crossref-record", title: "Reliable Memory for Agents", authors: ["A", "B"], year: 2025,
        venue: "ICLR", url: "https://doi.org/10.1000/memory", abstract: "longer abstract",
        source: "crossref" as const, topics: [], identifiers: { doi: "10.1000/memory" }, metrics: { citation_count: 12 },
      }],
    };
    const { upgrades } = await enrichSourceMetadata(dir, { provider });
    expect(upgrades[0]).toMatchObject({ status: "upgraded", fields: expect.arrayContaining(["doi", "venue", "citation_count"]) });
    const enriched = JSON.parse((await fs.readFile(path.join(dir, "sources", "deduped_sources.jsonl"), "utf-8")).trim());
    expect(enriched.url).toBe("https://arxiv.org/abs/2501.00001");
    expect(enriched.identifiers.doi).toBe("10.1000/memory");
    expect(enriched.venue).toBe("ICLR");
  });
});
