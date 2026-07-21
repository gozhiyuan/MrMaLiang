import path from "node:path";
import { runMalaClaw } from "../lib/malaclaw.js";
import { writeRunProvenance } from "../lib/ops/workspace-lifecycle.js";
import { loadWorkspaceEnv } from "../lib/workspace-env.js";

export type RunCommandOptions = {
  runtime?: string;
  reset?: boolean;
  skipValidate?: boolean;
};

export async function runWorkflow(workspaceDir: string, opts: RunCommandOptions): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  await loadWorkspaceEnv(resolved);
  if (!opts.skipValidate) {
    console.log(`Validating MalaClaw workflow in ${resolved}`);
    await runMalaClaw(resolved, ["validate"], { stream: true });
  }

  const args = ["flow", "run"];
  if (opts.runtime) args.push("--runtime", opts.runtime);
  if (opts.reset) args.push("--reset");
  console.log(`Running LongWrite workflow in ${resolved}`);
  await runMalaClaw(resolved, args, { stream: true });
  try {
    const provenance = await writeRunProvenance(resolved, { runtime: opts.runtime });
    console.log(`Recorded run provenance: ${provenance}`);
  } catch (error) {
    // Keep the low-level delegate usable in an external MalaClaw fixture.
    // A real initialized LongWrite workspace has both config files, so any
    // provenance issue there remains visible rather than being swallowed.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    console.warn("Skipped run provenance: workspace does not contain both LongWrite config files.");
  }
}
