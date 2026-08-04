import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifyCitedSourceUrls } from "../src/lib/research/verify.js";

const dirs: string[] = [];
afterEach(async () => { while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true }); });

async function ws(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lw-verify-section-"));
  dirs.push(dir);
  await fs.mkdir(path.join(dir, "sources"), { recursive: true });
  await fs.mkdir(path.join(dir, "chapters"), { recursive: true });
  const src = (id: string) => JSON.stringify({ id, title: id, authors: [], year: 2026, venue: "v", url: `https://example.com/${id}`, abstract: "a", source: "arxiv", topics: [], quality_score: 1, score_rationale: "r", citation_depth: "B" });
  await fs.writeFile(path.join(dir, "sources", "classified_sources.jsonl"), [src("alpha"), src("beta")].join("\n") + "\n");
  await fs.writeFile(path.join(dir, "chapters", "section-1.md"), "Claim [source:alpha:p1].\n");
  await fs.writeFile(path.join(dir, "chapters", "section-2.md"), "Claim [source:beta:p1].\n");
  return dir;
}
const okFetch = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;

describe("section-scoped citation verification", () => {
  it("checks only the sources the named section cites", async () => {
    const dir = await ws();
    const { results, written } = await verifyCitedSourceUrls(dir, { section: "section-1", fetchImpl: okFetch });
    expect(results.map((r) => r.source_id)).toEqual(["alpha"]);
    expect(written[1]).toBe("reports/source-verification-section-1.md");
  });

  it("keeps a scoped run from clobbering the aggregate report", async () => {
    const dir = await ws();
    await verifyCitedSourceUrls(dir, { fetchImpl: okFetch });
    await verifyCitedSourceUrls(dir, { section: "section-1", fetchImpl: okFetch });
    const aggregate = await fs.readFile(path.join(dir, "reports", "source-verification.md"), "utf-8");
    expect(aggregate).toContain("alpha");
    expect(aggregate).toContain("beta");
  });

  it("still verifies every cited source when no section is named", async () => {
    const dir = await ws();
    const { results } = await verifyCitedSourceUrls(dir, { fetchImpl: okFetch });
    expect(results.map((r) => r.source_id).sort()).toEqual(["alpha", "beta"]);
  });
});
