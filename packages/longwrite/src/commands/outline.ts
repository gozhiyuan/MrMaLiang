import fs from "node:fs/promises";
import path from "node:path";
import { runMalaClaw } from "../lib/malaclaw.js";
import { syncWorkspace } from "../lib/sync.js";
import { loadWorkspaceEnv } from "../lib/workspace-env.js";

export type OutlineRevisionOptions = { message?: string };

/** Record human outline feedback, then reopen only outline and downstream work.
 * Research, full-text, and evidence-index stages remain complete. */
export async function requestOutlineRevision(workspaceDir: string, opts: OutlineRevisionOptions): Promise<void> {
  const message = opts.message?.trim();
  if (!message) throw new Error("outline revision requires a non-empty --message");
  const resolved = path.resolve(workspaceDir);
  await loadWorkspaceEnv(resolved);

  const feedbackDir = path.join(resolved, "feedback");
  await fs.mkdir(feedbackDir, { recursive: true });
  const feedbackPath = path.join(feedbackDir, "outline-revision.md");
  const feedback = [
    "# Requested Outline Revision",
    "",
    "Apply this human feedback to the next outline. It supersedes prior outline-revision feedback.",
    "",
    message,
    "",
  ].join("\n");
  await fs.writeFile(feedbackPath, feedback, "utf-8");

  // Sync introduces the declared optional feedback input; migrate adopts that
  // manifest update without erasing earlier research artifacts or unit state.
  await syncWorkspace(resolved);
  await runMalaClaw(resolved, ["flow", "migrate"], { stream: true });
  await runMalaClaw(resolved, ["flow", "reopen", "outline"], { stream: true });
  console.log("Recorded feedback/outline-revision.md and reopened outline plus downstream stages. Run the flow to generate the revision.");
}
