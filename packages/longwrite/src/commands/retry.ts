import path from "node:path";
import { runMalaClaw } from "../lib/malaclaw.js";
import { loadWorkspaceEnv } from "../lib/workspace-env.js";

/** Clear failed MalaClaw units while preserving every completed unit and artifact. */
export async function retryWorkflow(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  await loadWorkspaceEnv(resolved);
  console.log(`Clearing failed LongWrite units in ${resolved}`);
  await runMalaClaw(resolved, ["flow", "retry"], { stream: true });
}
