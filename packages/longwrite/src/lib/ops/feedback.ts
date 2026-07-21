import fs from "node:fs/promises";
import path from "node:path";

export type FeedbackAddOptions = {
  message?: string;
  file?: string;
};

async function readFileIfRequested(file?: string): Promise<string> {
  if (!file) return "";
  return fs.readFile(path.resolve(file), "utf-8");
}

export async function addUserFeedback(workspaceDir: string, opts: FeedbackAddOptions): Promise<string[]> {
  const message = (opts.message ?? "").trim();
  const fileText = (await readFileIfRequested(opts.file)).trim();
  const body = [message, fileText].filter(Boolean).join("\n\n").trim();
  if (!body) throw new Error("feedback requires --message, --file, or both");

  const feedbackDir = path.join(workspaceDir, "feedback");
  await fs.mkdir(feedbackDir, { recursive: true });
  const rel = "feedback/user-feedback.md";
  const abs = path.join(workspaceDir, rel);
  const stamp = new Date().toISOString();
  const entry = [`## ${stamp}`, "", body, ""].join("\n");
  await fs.appendFile(abs, entry, "utf-8");
  return [rel];
}
