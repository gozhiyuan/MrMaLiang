import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addCandidateNode, completeRound, initializeLineage, markDeadEnd, promoteChampion, readLineage, recordCandidateResult, recordRunStatus, startRound } from "../src/lib/lineage.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

async function workspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lineage-")); dirs.push(dir);
  await initializeLineage(dir, { id: "base", round_id: "baseline", branch: "main", commit_sha: "a".repeat(40), status: "completed" });
  return dir;
}

describe("experiment lineage", () => {
  it("records a candidate, its result, promotion, and an immutable portable graph", async () => {
    const dir = await workspace();
    await startRound(dir, { id: "round-1", parent_node_id: "base", proposal_ids: ["proposal-1"] });
    await addCandidateNode(dir, { id: "candidate-1", parent_id: "base", round_id: "round-1", branch: "experiments/candidate-1", commit_sha: "b".repeat(40), status: "planned" });
    await recordRunStatus(dir, "candidate-1", "running");
    await recordCandidateResult(dir, "candidate-1", { primary_metric: 0.81, confidence: { lower: 0.79, upper: 0.83, level: 0.95 }, complexity_score: 2, result_artifact: "results/candidate-1/audit.json" });
    await completeRound(dir, "round-1", "candidate-1");
    const graph = await promoteChampion(dir, "candidate-1", "confirmed improvement");
    expect(graph.champion_node_id).toBe("candidate-1");
    expect((await readLineage(dir)).nodes.find((node) => node.id === "candidate-1")).toMatchObject({ kind: "champion", status: "promoted" });
  });

  it("keeps failed candidates addressable as dead ends", async () => {
    const dir = await workspace();
    await startRound(dir, { id: "round-1", parent_node_id: "base", proposal_ids: [] });
    await addCandidateNode(dir, { id: "candidate-2", parent_id: "base", round_id: "round-1", branch: "experiments/candidate-2", commit_sha: "c".repeat(40), status: "planned" });
    const graph = await markDeadEnd(dir, "candidate-2", "crash", "evaluator crashed");
    expect(graph.nodes.find((node) => node.id === "candidate-2")).toMatchObject({ kind: "dead_end", status: "failed", decision: "crash" });
  });

  it("refuses a new round from anything except the current champion", async () => {
    const dir = await workspace();
    await expect(startRound(dir, { id: "bad", parent_node_id: "missing", proposal_ids: [] })).rejects.toThrow(/current champion/);
  });
});
