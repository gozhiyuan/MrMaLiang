import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { selectSemanticCandidates } from "../src/lib/research/semantic-screen.js";
import { CapacityInfeasible } from "../src/lib/research/reservation.js";
import { TargetRecord, writeTargets, readTargets } from "../src/lib/research/targets.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

async function workspace(
  sourceIds: string[], reserved: Array<{ key: string; sourceId: string }>, maxCandidates = 2,
): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-selector-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "sources"), { recursive: true });
  await fs.writeFile(path.join(ws, "longwrite.yaml"), stringify({
    version: 1, project: { id: "s", artifact_type: "research_paper", mode: "auto_research_agentic" },
    research: {
      provider: "seed", topic: "t", taxonomy: [],
      semantic_screen: {
        enabled: true, max_candidates: maxCandidates, min_candidates_per_taxonomy_cell: 0,
        max_evidence_sources: 2, min_supported_claims_for_a: 1, min_supported_claims_for_b: 1,
      },
    },
  }), "utf-8");
  // Descending quality, so a reserved target listed last loses the ranking.
  await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"),
    sourceIds.map((id, index) => JSON.stringify({
      id, citation_depth: "C", title: `Paper ${id}`, abstract: "x", venue: "Venue",
      quality_score: 100 - index, year: 2025, topics: [],
    })).join("\n"), "utf-8");
  await writeTargets(ws, reserved.map((entry) => TargetRecord.parse({
    target_key: entry.key, source_id: entry.sourceId,
    status: "identity_verified", reserved: true, history: [],
  })));
  return ws;
}

describe("selector reservation", () => {
  it("returns selected ids alongside written paths", async () => {
    const ws = await workspace(["s1", "s2"], []);
    const result = await selectSemanticCandidates(ws);
    // The selector previously returned only written paths, so no test could
    // assert on what it actually selected.
    expect(result.selected.sort()).toEqual(["s1", "s2"]);
    expect(result.written.some((file) => file.endsWith(".json"))).toBe(true);
  });

  it("keeps a reserved target that would otherwise lose the ranking", async () => {
    // s3 ranks last and capacity is 2: without reservation it disappears.
    const ws = await workspace(["s1", "s2", "s3"], [{ key: "landmark:x", sourceId: "s3" }]);
    expect((await selectSemanticCandidates(ws)).selected).toContain("s3");
  });

  it("spends remaining capacity on rank after reserving", async () => {
    const ws = await workspace(["s1", "s2", "s3"], [{ key: "landmark:x", sourceId: "s3" }]);
    const selected = (await selectSemanticCandidates(ws)).selected;
    expect(selected).toHaveLength(2);
    expect(selected).toContain("s1");
  });

  it("pauses before any work when reservations exceed capacity", async () => {
    const ws = await workspace(["s1", "s2", "s3"], [
      { key: "landmark:a", sourceId: "s1" },
      { key: "landmark:b", sourceId: "s2" },
      { key: "landmark:c", sourceId: "s3" },
    ], 2);
    await expect(selectSemanticCandidates(ws)).rejects.toThrow(CapacityInfeasible);
    // Nothing was written, because the check runs before selection.
    await expect(fs.access(path.join(ws, "sources", "semantic-screening-candidates.json"))).rejects.toThrow();
  });

  it("accepts an explicit typed exclusion instead of a reservation", async () => {
    const ws = await workspace(["s1", "s2", "s3"], [{ key: "landmark:x", sourceId: "s3" }]);
    await fs.writeFile(path.join(ws, "sources", "selector-exclusions.json"), JSON.stringify({
      version: 1, exclusions: [{
        selector: "semantic_screen", source_id: "s3",
        reason: "outside_revised_scope", detail: "topic narrowed after the outline review",
      }],
    }), "utf-8");
    const result = await selectSemanticCandidates(ws);
    expect(result.selected).not.toContain("s3");
  });

  it("records the exclusion on the target ledger", async () => {
    const ws = await workspace(["s1", "s2", "s3"], [{ key: "landmark:x", sourceId: "s3" }]);
    await fs.writeFile(path.join(ws, "sources", "selector-exclusions.json"), JSON.stringify({
      version: 1, exclusions: [{
        selector: "semantic_screen", source_id: "s3",
        reason: "outside_revised_scope", detail: "topic narrowed",
      }],
    }), "utf-8");
    await selectSemanticCandidates(ws);
    expect((await readTargets(ws))[0].exclusion?.reason).toBe("outside_revised_scope");
  });

  it("is inert when nothing is reserved", async () => {
    const ws = await workspace(["s1", "s2", "s3"], []);
    expect((await selectSemanticCandidates(ws)).selected).toHaveLength(2);
  });
});
