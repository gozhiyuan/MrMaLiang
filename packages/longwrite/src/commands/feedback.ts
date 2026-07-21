import path from "node:path";
import { addUserFeedback } from "../lib/ops/feedback.js";

export type FeedbackAddCommandOptions = {
  message?: string;
  file?: string;
};

export async function runFeedbackAdd(workspaceDir: string, opts: FeedbackAddCommandOptions): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const written = await addUserFeedback(resolved, opts);
  console.log(`Recorded LongWrite feedback in ${resolved}`);
  for (const file of written) console.log(`  + ${file}`);
}
