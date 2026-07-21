import path from "node:path";
import { runMalaClaw } from "../lib/malaclaw.js";

export type RuntimesCommandOptions = {
  runtime?: string;
};

export async function runRuntimes(workspaceDir: string, opts: RuntimesCommandOptions): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const args = ["flow", "runtimes"];
  if (opts.runtime) args.push("--runtime", opts.runtime);
  console.log(`Checking MalaClaw worker runtimes in ${resolved}`);
  await runMalaClaw(resolved, args, { stream: true });
}
