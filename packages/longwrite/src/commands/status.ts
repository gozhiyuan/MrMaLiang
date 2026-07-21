import { readWorkspaceStatus, statusToMarkdown } from "../lib/ops/status.js";

export async function runStatus(workspaceDir: string): Promise<void> {
  const status = await readWorkspaceStatus(workspaceDir);
  console.log(statusToMarkdown(status));
}
