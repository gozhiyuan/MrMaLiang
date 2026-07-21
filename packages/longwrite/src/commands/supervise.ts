import path from "node:path";
import { runMalaClaw } from "../lib/malaclaw.js";
import { loadWorkspaceEnv } from "../lib/workspace-env.js";

export type SuperviseCommandOptions = {
  runtime?: string;
  retryMinutes?: string;
  maxHours?: string;
  detach?: boolean;
};

/** Run MalaClaw's long-lived supervisor with the workspace-local environment. */
export async function runSupervise(workspaceDir: string, opts: SuperviseCommandOptions): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  await loadWorkspaceEnv(resolved);
  const args = ["flow", "supervise"];
  if (opts.runtime) args.push("--runtime", opts.runtime);
  if (opts.retryMinutes) args.push("--retry-minutes", opts.retryMinutes);
  if (opts.maxHours) args.push("--max-hours", opts.maxHours);
  if (opts.detach) args.push("--detach");
  console.log(`Supervising LongWrite workflow in ${resolved}`);
  await runMalaClaw(resolved, args, { stream: true });
}
