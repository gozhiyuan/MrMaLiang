import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { CORPUS_EVALUATORS, MeasurementUnavailable } from "../src/lib/registry/evaluators/corpus.js";
import { scopeKey } from "../src/lib/registry/scope.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});
const AS_OF = "2026-09-01T00:00:00.000Z";
const ctx = (workspaceDir: string) => ({ workspaceDir, asOfDate: AS_OF });

async function workspace(
  sources: unknown[] | string, chapters: Record<string, string> = {}, taxonomy: string[] = [],
): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-eval-corpus-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "sources"), { recursive: true });
  await fs.mkdir(path.join(ws, "chapters"), { recursive: true });
  await fs.writeFile(path.join(ws, "longwrite.yaml"), stringify({
    version: 1, project: { id: "s", artifact_type: "research_paper", mode: "auto_research_agentic" },
    research: { provider: "seed", topic: "t", taxonomy },
  }), "utf-8");
  await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"),
    typeof sources === "string" ? sources : sources.map((s) => JSON.stringify(s)).join("\n"), "utf-8");
  for (const [name, body] of Object.entries(chapters)) {
    await fs.writeFile(path.join(ws, "chapters", name), body, "utf-8");
  }
  return ws;
}
const only = (values: Array<{ scope_key: string; value: number }>) => {
  expect(values).toHaveLength(1);
  expect(values[0].scope_key).toBe("");
  return values[0].value;
};

describe("corpus evaluators", () => {
  it("counts A and B depth sources as core, globally scoped", async () => {
    const ws = await workspace([
      { id: "s1", citation_depth: "A" }, { id: "s2", citation_depth: "B" }, { id: "s3", citation_depth: "C" },
    ]);
    expect(only(await CORPUS_EVALUATORS.core_sources(ctx(ws)))).toBe(2);
  });

  it("fails the measurement when the corpus is missing rather than reporting zero", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-eval-empty-"));
    roots.push(ws);
    // A measured zero is a claim about the corpus. An absent corpus is not.
    await expect(CORPUS_EVALUATORS.core_sources(ctx(ws))).rejects.toThrow(MeasurementUnavailable);
  });

  it("throws on a malformed corpus row rather than silently dropping it", async () => {
    const ws = await workspace(`{"id":"s1","citation_depth":"A"}\n{ not json`);
    await expect(CORPUS_EVALUATORS.core_sources(ctx(ws))).rejects.toThrow(/malformed source record/);
  });

  it("uses the canonical cited-source parser, including whole-source markers", async () => {
    const ws = await workspace(
      [{ id: "paper-a", citation_depth: "A" }, { id: "paper-b", citation_depth: "A" }],
      { "section-01.md": "Whole [source:paper-a] and located [source:paper-b:p3].\n" });
    expect(only(await CORPUS_EVALUATORS.cited_sources(ctx(ws)))).toBe(2);
  });

  it("does not treat arxiv-only as the complement of accepted", async () => {
    // A DOI-less, arXiv-id-less workshop page is neither.
    const ws = await workspace([
      { id: "s1", citation_depth: "A", identity: { publication_status: "published" }, identifiers: { doi: "10.1/x" }, venue: "ICML" },
      { id: "s2", citation_depth: "A", identity: { publication_status: "unknown" }, identifiers: {}, venue: "Workshop" },
      { id: "s3", citation_depth: "A", identity: { publication_status: "preprint" }, identifiers: { arxiv_id: "2401.1" }, venue: "arXiv" },
    ], { "section-01.md": "[source:s1:p1] [source:s2:p2] [source:s3:p3]\n" });
    const accepted = only(await CORPUS_EVALUATORS.accepted_cited_ratio(ctx(ws)));
    const arxivOnly = only(await CORPUS_EVALUATORS.cited_arxiv_only_ratio(ctx(ws)));
    expect(accepted).toBeCloseTo(1 / 3, 5);
    expect(arxivOnly).toBeCloseTo(1 / 3, 5);
    expect(accepted + arxivOnly).toBeLessThan(1);
  });

  it("returns a zero ratio rather than NaN when nothing is cited", async () => {
    const ws = await workspace([{ id: "s1", citation_depth: "A" }], { "section-01.md": "No markers.\n" });
    expect(only(await CORPUS_EVALUATORS.accepted_cited_ratio(ctx(ws)))).toBe(0);
  });

  it("emits one entry per taxonomy cell, never an aggregate minimum", async () => {
    const ws = await workspace([
      // The canonical matcher reads title and abstract, never `topics`:
      // `topics` carries the query terms a record was retrieved by, so counting
      // it would let every hit from a broad search fill the same cell.
      { id: "s1", citation_depth: "A", title: "Agent memory systems", abstract: "memory" },
      { id: "s2", citation_depth: "A", title: "Episodic memory", abstract: "memory recall" },
      { id: "s3", citation_depth: "B", title: "Planning under uncertainty", abstract: "planning" },
    ], {}, ["memory", "planning"]);
    const values = await CORPUS_EVALUATORS.taxonomy_cell_ab_sources(ctx(ws));
    // The previous design reported min(2, 1) = 1, which cannot tell a repair
    // which cell is short. The key is canonical, never the raw label: a real
    // cell may contain spaces the kernel's scope pattern rejects.
    const byKey = Object.fromEntries(values.map((v) => [v.scope_key, v.value]));
    expect(byKey[scopeKey("taxonomy_cell", "memory")]).toBe(2);
    expect(byKey[scopeKey("taxonomy_cell", "planning")]).toBe(1);
    expect(Object.keys(byKey)).toHaveLength(2);
  });

  it("is reproducible across a year boundary because the as-of date is explicit", async () => {
    const ws = await workspace([{ id: "s1", citation_depth: "A", year: 2025 }],
      { "section-01.md": "[source:s1:p1]\n" });
    expect(only(await CORPUS_EVALUATORS.cited_within_one_year_ratio({ workspaceDir: ws, asOfDate: "2026-06-01T00:00:00.000Z" }))).toBe(1);
    expect(only(await CORPUS_EVALUATORS.cited_within_one_year_ratio({ workspaceDir: ws, asOfDate: "2027-06-01T00:00:00.000Z" }))).toBe(0);
  });
});
