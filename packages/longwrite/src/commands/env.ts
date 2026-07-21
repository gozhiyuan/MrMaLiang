import path from "node:path";
import { ensureWorkspaceEnvFiles } from "../lib/workspace-env.js";

/** Add the non-secret environment template to an existing workspace. */
export async function runEnvInit(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const written = await ensureWorkspaceEnvFiles(resolved);
  if (written.length === 0) {
    console.log(`Workspace environment template already present: ${resolved}`);
    return;
  }
  for (const file of written) console.log(`  + ${file}`);
  console.log(`Copy ${path.join(resolved, ".env.example")} to .env and add only the optional keys you need.`);
}
