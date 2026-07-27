import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SubprocessComputeAdapter } from "../src/lib/compute/adapter.js";
import { collectPersistedRemoteJob, persistRemoteHandle } from "../src/lib/compute/handles.js";
import { addCandidateNode, completeRound, initializeLineage, markDeadEnd, promoteChampion, recordCandidateResult, recordRunStatus, startRound } from "../src/lib/lineage.js";
import { recordDeadEndEvidence } from "../src/lib/dead-ends.js";
import { verifyEvaluatorIntegrity } from "../src/lib/verifiers/evaluator-integrity.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

async function fakeGpuAdapter(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longexperiment-fake-gpu-")); dirs.push(dir);
  const file = path.join(dir, "adapter.mjs");
  await fs.writeFile(file, `let input=""; process.stdin.on("data", c => input += c); process.stdin.on("end", () => { const q=JSON.parse(input); if(q.operation==="submit") console.log(JSON.stringify({version:1,adapter_id:"fake-gpu",job_id:q.spec.candidate_id})); else if(q.operation==="status") console.log(JSON.stringify({state:"succeeded"})); else if(q.operation==="collect") console.log(JSON.stringify({result_path:"results/"+q.handle.job_id+".json",artifacts:["logs/"+q.handle.job_id+".log"]})); else console.log(JSON.stringify({available:true})); });`);
  return file;
}

describe("fake-GPU bounded research E2E", () => {
  it("persists resumable jobs, preserves the evaluator, promotes one winner, and retains a dead end", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "longexperiment-e2e-")); dirs.push(workspace);
    const base = path.join(workspace, "base"); const candidate = path.join(workspace, "candidate");
    await fs.mkdir(path.join(base, "evaluator"), { recursive: true }); await fs.mkdir(path.join(candidate, "evaluator"), { recursive: true });
    await fs.writeFile(path.join(base, "evaluator", "score.py"), "print('fixed evaluator')\n");
    await fs.writeFile(path.join(candidate, "evaluator", "score.py"), "print('fixed evaluator')\n");
    expect(await verifyEvaluatorIntegrity(base, candidate, ["evaluator/score.py"])).toMatchObject({ ok: true });

    await initializeLineage(workspace, { id: "baseline", round_id: "baseline", branch: "main", commit_sha: "a".repeat(40), status: "completed", primary_metric: 0.5 });
    await startRound(workspace, { id: "round-1", parent_node_id: "baseline", proposal_ids: ["proposal-1", "proposal-2"] });
    for (const id of ["candidate-good", "candidate-dead"]) {
      await addCandidateNode(workspace, { id, parent_id: "baseline", round_id: "round-1", branch: id, commit_sha: id === "candidate-good" ? "b".repeat(40) : "c".repeat(40), status: "materialized" });
    }

    const adapterFile = await fakeGpuAdapter();
    const adapter = new SubprocessComputeAdapter({ id: "fake-gpu", command: process.execPath, args: [adapterFile] });
    for (const id of ["candidate-good", "candidate-dead"]) {
      const handle = await adapter.submit({ version: 1, candidate_id: id, git: { source: "https://example.com/repo.git", revision: "a".repeat(40) }, image: "python:3.12", command: ["python", "run.py"], timeout_seconds: 30, resources: { gpu: "fake" }, evaluator: { protected_paths: ["evaluator/score.py"], result_path: "results/raw.json" } });
      await persistRemoteHandle(workspace, id, handle);
      await recordRunStatus(workspace, id, "submitted");
    }
    // A fresh adapter instance simulates resuming after the supervisor exits.
    const resumed = new SubprocessComputeAdapter({ id: "fake-gpu", command: process.execPath, args: [adapterFile] });
    await expect(collectPersistedRemoteJob(resumed, workspace, "candidate-good", "results")).resolves.toMatchObject({ result_path: "results/candidate-good.json" });
    await recordCandidateResult(workspace, "candidate-good", { primary_metric: 0.7, confidence: { lower: 0.1, upper: 0.3, level: 0.95 }, result_artifact: "results/candidate-good.json" });
    await recordCandidateResult(workspace, "candidate-dead", { primary_metric: 0.4, confidence: { lower: -0.2, upper: -0.05, level: 0.95 }, result_artifact: "results/candidate-dead.json" });
    await promoteChampion(workspace, "candidate-good", "fake-GPU audited improvement");
    await markDeadEnd(workspace, "candidate-dead", "discard", "fake-GPU audit showed a regression");
    await recordDeadEndEvidence(workspace, { candidate_node_id: "candidate-dead", hypothesis_family: "batch ordering", outcome: "discarded", reason: "fake-GPU audit showed a regression" });
    const graph = await completeRound(workspace, "round-1", "candidate-good");
    expect(graph.champion_node_id).toBe("candidate-good");
    expect(graph.nodes.find((node) => node.id === "candidate-dead")).toMatchObject({ kind: "dead_end", decision: "discard" });
  });
});
