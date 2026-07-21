import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifyCitedSourceUrls } from "../src/lib/research/verify.js";

const tempDirs: string[] = [];

async function workspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-verify-"));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, "sources"), { recursive: true });
  await fs.mkdir(path.join(dir, "chapters"), { recursive: true });
  await fs.writeFile(path.join(dir, "sources", "classified_sources.jsonl"), [
    { id: "live", title: "Live", authors: ["A"], year: 2025, venue: "V", url: "https://example.test/live", abstract: "x", source: "arxiv", topics: [], quality_score: 0.8, score_rationale: "x", citation_depth: "B", citation_depth_rationale: "x" },
    { id: "dead", title: "Dead", authors: ["B"], year: 2025, venue: "V", url: "https://example.test/dead", abstract: "x", source: "arxiv", topics: [], quality_score: 0.7, score_rationale: "x", citation_depth: "C", citation_depth_rationale: "x" },
  ].map(JSON.stringify).join("\n") + "\n", "utf-8");
  await fs.writeFile(path.join(dir, "chapters", "section.md"), "# Section\n[source:live:p12]\n[source:dead]\n", "utf-8");
  return dir;
}

afterEach(async () => {
  while (tempDirs.length) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

describe("citation URL verification", () => {
  it("checks only cited sources and records redirects/dead URLs", async () => {
    const dir = await workspace();
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/live")) return new Response("", { status: 200, headers: { "content-type": "text/plain" } });
      return new Response("gone", { status: 404 });
    }) as typeof fetch;
    const { results, written } = await verifyCitedSourceUrls(dir, { fetchImpl });
    expect(results.map((result) => result.status)).toEqual(["live", "dead"]);
    expect(written).toContain("sources/citation-verification.jsonl");
    expect(await fs.readFile(path.join(dir, "reports", "source-verification.md"), "utf-8")).toContain("dead: 1");
  });
});
