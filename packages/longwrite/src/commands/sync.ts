import path from "node:path";
import { syncWorkspace } from "../lib/sync.js";

export async function runSync(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const result = await syncWorkspace(resolved);
  console.log(`Synced LongWrite derived files in ${resolved}`);
  for (const file of result.written) console.log(`  + ${file}`);
}
