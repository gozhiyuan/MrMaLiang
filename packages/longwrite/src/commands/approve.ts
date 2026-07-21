import path from "node:path";
import { runMalaClaw } from "../lib/malaclaw.js";

export type ApproveCommandOptions = {
  batch?: boolean;
};

export async function runApprove(workspaceDir: string, approvalId: string | undefined, opts: ApproveCommandOptions): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  if (opts.batch) {
    console.log(`Batch-reviewing pending approvals in ${resolved}`);
    await runMalaClaw(resolved, ["flow", "review", "--batch"], { stream: true });
    return;
  }
  if (!approvalId) {
    throw new Error("approval id is required unless --batch is set");
  }
  console.log(`Approving ${approvalId} in ${resolved}`);
  await runMalaClaw(resolved, ["flow", "approve", approvalId], { stream: true });
}
