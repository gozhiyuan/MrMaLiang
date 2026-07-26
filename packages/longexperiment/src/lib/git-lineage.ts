import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

async function git(repo: string, args: string[]): Promise<string> {
  try { return (await execFile("git", ["-C", repo, ...args], { encoding: "utf8" })).stdout.trim(); }
  catch (error) { throw new Error(`git ${args.join(" ")} failed: ${error instanceof Error ? error.message : String(error)}`); }
}

function safeRelative(value: string): boolean { return value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]/).includes(".."); }

export type FrozenBaseline = { branch: string; commit_sha: string };
export type MaterializedCandidate = { branch: string; commit_sha: string; worktree_path: string; reused_branch: boolean };

/** A baseline is a resolved immutable commit, never a moving ref such as HEAD. */
export async function freezeBaseline(repo: string): Promise<FrozenBaseline> {
  const status = await git(repo, ["status", "--porcelain"]);
  if (status) throw new Error("cannot freeze a baseline with uncommitted changes");
  const commit_sha = await git(repo, ["rev-parse", "HEAD"]);
  const branch = await git(repo, ["branch", "--show-current"]);
  return { branch: branch || "DETACHED", commit_sha };
}

/**
 * Materialize a candidate branch from an immutable parent. Existing candidate
 * branches are never reset or rebased: an inspection worktree points at their
 * recorded commit instead.
 */
export async function materializeCandidateWorktree(
  repo: string,
  workspace: string,
  candidateId: string,
  branch: string,
  parentCommit: string,
): Promise<MaterializedCandidate> {
  if (!safeRelative(candidateId)) throw new Error("candidate id must be a safe relative path");
  if (!/^[a-f0-9]{7,64}$/i.test(parentCommit)) throw new Error("parent commit must be an immutable SHA");
  const target = path.join(workspace, "worktrees", candidateId);
  await fs.access(target).then(() => { throw new Error(`candidate worktree already exists: ${target}`); }).catch((error: NodeJS.ErrnoException) => {
    if (error.message.startsWith("candidate worktree")) throw error;
    if (error.code !== "ENOENT") throw error;
  });
  await fs.mkdir(path.dirname(target), { recursive: true });
  const ref = `refs/heads/${branch}`;
  const existing = await git(repo, ["show-ref", "--verify", "--hash", ref]).catch(() => "");
  if (existing) {
    await git(repo, ["worktree", "add", "--detach", target, existing]);
    return { branch, commit_sha: existing, worktree_path: path.relative(workspace, target), reused_branch: true };
  }
  const parent = await git(repo, ["rev-parse", parentCommit]);
  await git(repo, ["worktree", "add", "-b", branch, target, parent]);
  return { branch, commit_sha: await git(target, ["rev-parse", "HEAD"]), worktree_path: path.relative(workspace, target), reused_branch: false };
}
