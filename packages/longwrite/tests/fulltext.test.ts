import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ingestFulltext, htmlToText } from "../src/lib/research/fulltext.js";

const tempDirs: string[] = [];
async function makeWorkspace(sources: object[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-fulltext-"));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, "sources"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "sources", "classified_sources.jsonl"),
    sources.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf-8",
  );
  return dir;
}
afterEach(async () => {
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

const source = (id: string, depth: string, arxivId?: string, openAccessPdf?: string) => ({
  id, title: `Paper ${id}`, authors: ["A"], year: 2026, venue: "arXiv", url: "https://x",
  abstract: "a", source: "arxiv", topics: [], quality_score: 0.9, score_rationale: "r",
  citation_depth: depth, identifiers: arxivId ? { arxiv_id: arxivId } : {},
  ...(openAccessPdf ? { links: { open_access_pdf: openAccessPdf } } : {}),
});

const paperHtml = `<html><body><nav>skip</nav><h1>Title</h1>${"<p>Real paper prose. </p>".repeat(200)}</body></html>`;

describe("fulltext ingestion", () => {
  it("creates explicitly labelled local evidence documents for the seed provider only", async () => {
    const ws = await makeWorkspace([{
      ...source("seed-demo", "A"),
      source: "seed",
      abstract: "A deterministic seed abstract about memory and planning. ".repeat(4),
    }]);
    const { results } = await ingestFulltext(ws, async () => {
      throw new Error("seed ingestion must not make network requests");
    });
    expect(results[0]).toMatchObject({ sourceId: "seed-demo", status: "ingested" });
    const text = await fs.readFile(path.join(ws, "fulltext", "seed-demo.md"), "utf-8");
    expect(text).toContain("development fixture; not an external publication");
    expect(text).toContain("Synthetic metadata-grounded excerpt");
  });

  it("ingests core sources via arXiv HTML, skips no-id, records failures", async () => {
    const ws = await makeWorkspace([
      source("core-a", "A", "2601.00001v1"),
      source("core-noid", "A"),
      source("core-dead", "B", "2601.00002v1"),
      source("shallow-d", "D", "2601.00003v1"), // ineligible depth
    ]);
    const fetchImpl = (async (url: string) => {
      if (url.includes("2601.00001")) return new Response(paperHtml, { status: 200 });
      return new Response("nope", { status: 404 });
    }) as typeof fetch;

    const { results } = await ingestFulltext(ws, fetchImpl);
    const byId = Object.fromEntries(results.map((r) => [r.sourceId, r]));
    expect(byId["core-a"].status).toBe("ingested");
    expect(byId["core-noid"].status).toBe("skipped");
    expect(byId["core-dead"].status).toBe("failed");
    expect(byId["shallow-d"]).toBeUndefined();

    const text = await fs.readFile(path.join(ws, "fulltext", "core-a.md"), "utf-8");
    expect(text).toContain("Real paper prose.");
    expect(text).not.toContain("<p>");
    const report = await fs.readFile(path.join(ws, "reports", "fulltext.md"), "utf-8");
    expect(report).toContain("Ingested: 1 · skipped: 1 · failed: 1");
    expect(report).toContain("verified arXiv endpoints first");
    const manifest = JSON.parse(await fs.readFile(path.join(ws, "fulltext", "manifest.json"), "utf-8"));
    expect(manifest.results).toHaveLength(3);
  });

  it("never throws on total failure and rejects short abs-page shells", async () => {
    const ws = await makeWorkspace([source("core-a", "A", "2601.00001v1")]);
    const fetchImpl = (async () => new Response("<html>abs page</html>", { status: 200 })) as typeof fetch;
    const { results } = await ingestFulltext(ws, fetchImpl);
    expect(results[0].status).toBe("failed");
    expect(htmlToText("<b>x</b>").length).toBeLessThan(2000);
  });

  it("uses ranked C candidates when a live-style corpus has no A/B sources", async () => {
    const ws = await makeWorkspace([
      source("candidate-c", "C", "2601.00001v1"),
      source("background-d", "D", "2601.00002v1"),
    ]);
    const fetchImpl = (async (url: string) => new Response(
      url.includes("2601.00001") ? paperHtml : "not found",
      { status: url.includes("2601.00001") ? 200 : 404 },
    )) as typeof fetch;
    const { results } = await ingestFulltext(ws, fetchImpl, undefined, { maxSources: 1 });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ sourceId: "candidate-c", status: "ingested" });
  });

  it("prioritizes an accessible arXiv record over an inaccessible higher-depth record", async () => {
    const ws = await makeWorkspace([
      source("publisher-b", "A"),
      source("arxiv-c", "C", "2601.00001v1"),
    ]);
    const fetchImpl = (async (url: string) => new Response(
      url.includes("2601.00001") ? paperHtml : "not found",
      { status: url.includes("2601.00001") ? 200 : 404 },
    )) as typeof fetch;
    const { results } = await ingestFulltext(ws, fetchImpl, undefined, { maxSources: 1 });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ sourceId: "arxiv-c", status: "ingested" });
  });

  it("prioritizes a verified arXiv endpoint over an open-access metadata link", async () => {
    const ws = await makeWorkspace([
      source("landing-page-b", "B", undefined, "https://publisher.example.test/article/123"),
      source("arxiv-c", "C", "2601.00001v1"),
    ]);
    const fetchImpl = (async (url: string) => new Response(
      url.includes("2601.00001") ? paperHtml : "not found",
      { status: url.includes("2601.00001") ? 200 : 404 },
    )) as typeof fetch;
    const { results } = await ingestFulltext(ws, fetchImpl, undefined, { maxSources: 1 });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ sourceId: "arxiv-c", status: "ingested" });
  });

  it("uses a linked open-access PDF when HTML is unavailable and an extractor exists", async () => {
    const ws = await makeWorkspace([source("pdf-only", "A", undefined, "https://example.test/paper.pdf")]);
    const fetchImpl = (async (url: string) => new Response(new Uint8Array([1, 2, 3]), {
      status: url.endsWith(".pdf") ? 200 : 404,
    })) as typeof fetch;
    const extractor = async () => "Extracted PDF evidence. ".repeat(150);
    const { results } = await ingestFulltext(ws, fetchImpl, extractor);
    expect(results[0]).toMatchObject({ sourceId: "pdf-only", status: "ingested", detail: "https://example.test/paper.pdf" });
    await expect(fs.readFile(path.join(ws, "fulltext", "pdf-only.md"), "utf-8")).resolves.toContain("Format: pdf");
  });
});
