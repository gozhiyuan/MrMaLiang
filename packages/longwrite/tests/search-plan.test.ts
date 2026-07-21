import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SearchPlan, loadSearchPlan, applyExclusions } from "../src/lib/research/search-plan.js";
import { recallSources } from "../src/lib/research/pipeline.js";

const tempDirs: string[] = [];
async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-plan-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

const validPlan = {
  version: 1,
  topic: "tool use in LLM agents",
  query_variants: ["LLM agent tool use", "environment feedback language agents"],
  taxonomy_cells: [{
    cell: "planning",
    query_variants: ["agent planning survey", "LLM planning benchmarks", "tool-use planning agents"],
  }],
  exclusion_terms: ["climate model"],
  venue_priorities: ["NeurIPS", "ICLR"],
};

describe("SearchPlan schema", () => {
  it("accepts a valid plan and rejects shape violations", async () => {
    expect(SearchPlan.parse(validPlan).query_variants).toHaveLength(2);
    expect(SearchPlan.safeParse({ ...validPlan, query_variants: [] }).success).toBe(false);
    expect(SearchPlan.safeParse({ ...validPlan, taxonomy_cells: [{ cell: "planning", query_variants: ["one", "two"] }] }).success).toBe(false);
    expect(SearchPlan.safeParse({ ...validPlan, extra_field: 1 }).success).toBe(false);
    const ws = await makeWorkspace();
    expect(await loadSearchPlan(ws)).toEqual({ present: false });
  });

  it("filters sources by exclusion terms", () => {
    const { kept, dropped } = applyExclusions(
      [
        { title: "Tool use in agents", abstract: "..." },
        { title: "AIRCC climate model emulator", abstract: "climate model tooling" },
      ],
      ["climate model"],
    );
    expect(kept).toHaveLength(1);
    expect(dropped).toBe(1);
  });
});

describe("plan-driven recall", () => {
  it("executes every query variant, applies exclusions, and records per-query provenance", async () => {
    const ws = await makeWorkspace();
    await fs.mkdir(path.join(ws, "sources"), { recursive: true });
    await fs.writeFile(path.join(ws, "sources", "search-plan.json"), JSON.stringify(validPlan), "utf-8");
    // Seed provider is deterministic; with a plan it runs once per variant.
    await recallSources({ workspaceDir: ws, topic: "tool use in LLM agents", provider: "seed", count: 3 });

    const raw = (await fs.readFile(path.join(ws, "sources", "raw_results.jsonl"), "utf-8"))
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const queries = new Set(raw.map((s) => s.provenance.query));
    expect(queries).toEqual(new Set([...validPlan.query_variants, ...validPlan.taxonomy_cells[0].query_variants]));
    const report = await fs.readFile(path.join(ws, "reports", "recall-plan.md"), "utf-8");
    expect(report).toContain("5 query variants");
    expect(report).toContain("planning (3)");
    expect(report).toContain("NeurIPS");
  });

  it("fails loudly on an invalid plan instead of degrading to topic-only", async () => {
    const ws = await makeWorkspace();
    await fs.mkdir(path.join(ws, "sources"), { recursive: true });
    await fs.writeFile(path.join(ws, "sources", "search-plan.json"), JSON.stringify({ version: 1 }), "utf-8");
    await expect(recallSources({ workspaceDir: ws, topic: "t", provider: "seed" }))
      .rejects.toThrow(/invalid sources\/search-plan.json/);
  });

  it("without a plan, retrieval is topic-only (unchanged behavior)", async () => {
    const ws = await makeWorkspace();
    await recallSources({ workspaceDir: ws, topic: "plain topic", provider: "seed", count: 2 });
    const raw = (await fs.readFile(path.join(ws, "sources", "raw_results.jsonl"), "utf-8"))
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(new Set(raw.map((s) => s.provenance.query))).toEqual(new Set(["plain topic"]));
    await expect(fs.access(path.join(ws, "reports", "recall-plan.md"))).rejects.toThrow();
  });

  it("fails closed for a live provider unless seed fallback is explicitly allowed", async () => {
    const failingProvider = () => ({
      id: "arxiv" as const,
      search: async () => { throw new Error("network unavailable"); },
    });
    const strict = await makeWorkspace();
    await expect(recallSources({
      workspaceDir: strict, topic: "agent memory", provider: "arxiv", providerFactory: failingProvider,
    })).rejects.toThrow("network unavailable");

    const development = await makeWorkspace();
    await recallSources({
      workspaceDir: development, topic: "agent memory", provider: "arxiv",
      fallbackToSeed: true, providerFactory: failingProvider,
    });
    await expect(fs.readFile(path.join(development, "reports", "recall-fallback.md"), "utf-8"))
      .resolves.toContain("SEED data");
  });
});
