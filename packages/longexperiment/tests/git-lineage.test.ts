import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { freezeBaseline, materializeCandidateWorktree } from "../src/lib/git-lineage.js";
import { writePinInputsStage, writeWorktreesStage } from "../src/lib/stages.js";
import { readLineage } from "../src/lib/lineage.js";

const exec = promisify(execFile); const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });
async function cmd(cwd: string, ...args: string[]): Promise<void> { await exec("git", args, { cwd }); }
async function repo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "git-lineage-")); dirs.push(dir);
  await cmd(dir, "init"); await cmd(dir, "config", "user.email", "test@example.com"); await cmd(dir, "config", "user.name", "Test");
  await fs.writeFile(path.join(dir, "train.py"), "print('base')\n"); await cmd(dir, "add", "."); await cmd(dir, "commit", "-m", "baseline"); return dir;
}
describe("git lineage", () => {
  it("freezes a clean baseline and creates candidates from its exact commit", async () => {
    const root = await repo(); const baseline = await freezeBaseline(root);
    const candidate = await materializeCandidateWorktree(root, root, "candidate-1", "experiments/candidate-1", baseline.commit_sha);
    expect(candidate).toMatchObject({ branch: "experiments/candidate-1", commit_sha: baseline.commit_sha, reused_branch: false });
    await fs.writeFile(path.join(root, candidate.worktree_path, "train.py"), "print('candidate')\n");
    await cmd(path.join(root, candidate.worktree_path), "add", "."); await cmd(path.join(root, candidate.worktree_path), "commit", "-m", "candidate");
    const repeat = await materializeCandidateWorktree(root, root, "candidate-1-inspect", "experiments/candidate-1", baseline.commit_sha);
    expect(repeat.reused_branch).toBe(true);
    expect(repeat.commit_sha).not.toBe(baseline.commit_sha);
  });
  it("refuses to freeze a dirty baseline", async () => {
    const root = await repo(); await fs.writeFile(path.join(root, "train.py"), "changed\n");
    await expect(freezeBaseline(root)).rejects.toThrow(/uncommitted changes/);
  });

  it("records pilot worktrees in the scientific lineage as they materialize", async () => {
    const source = await repo();
    const sha = (await exec("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim();
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "pilot-worktree-")); dirs.push(workspace);
    const config = {
      pilot: "repository_optimization", inputs: { code: [{ id: "repo", source: new URL(`file://${source}`).href, revision: sha, materialize: "git" }], benchmarks: [], models: [] },
      execution: { candidate_worktrees: [{ id: "candidate", input_id: "repo", revision: sha, role: "candidate" }] },
    } as any;
    await writePinInputsStage(workspace, config);
    await writeWorktreesStage(workspace, config);
    const graph = await readLineage(workspace);
    expect(graph.champion_node_id).toBe("baseline");
    expect(graph.nodes.find((node) => node.id === "candidate")).toMatchObject({ status: "materialized", branch: "experiments/candidate" });
  });
});
