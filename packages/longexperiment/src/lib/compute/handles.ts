import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ExperimentComputeAdapter, ExperimentRunHandle } from "./types.js";
import { ExperimentRunHandle as Handle } from "./types.js";

const StoredRemoteJob = z.object({ version: z.literal(1), study_id: z.string().min(1), handle: Handle, submitted_at: z.string().datetime() }).strict();
type StoredRemoteJob = z.infer<typeof StoredRemoteJob>;
function jobPath(workspace: string, studyId: string): string { return path.join(workspace, "runs", "remote-jobs", `${studyId}.json`); }
async function writeAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try { await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8"); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
}
export async function persistRemoteHandle(workspace: string, studyId: string, handle: ExperimentRunHandle): Promise<void> {
  await writeAtomic(jobPath(workspace, studyId), StoredRemoteJob.parse({ version: 1, study_id: studyId, handle, submitted_at: new Date().toISOString() }));
}
export async function readRemoteHandle(workspace: string, studyId: string): Promise<StoredRemoteJob> {
  return StoredRemoteJob.parse(JSON.parse(await fs.readFile(jobPath(workspace, studyId), "utf8")));
}
export async function collectPersistedRemoteJob(adapter: ExperimentComputeAdapter, workspace: string, studyId: string, targetDir: string) {
  const job = await readRemoteHandle(workspace, studyId);
  const status = await adapter.status(job.handle);
  if (status.state !== "succeeded") throw new Error(`remote job ${job.handle.job_id} is ${status.state}; cannot collect yet`);
  return adapter.collect(job.handle, targetDir);
}
export async function cancelPersistedRemoteJob(adapter: ExperimentComputeAdapter, workspace: string, studyId: string): Promise<void> {
  const job = await readRemoteHandle(workspace, studyId);
  await adapter.cancel(job.handle);
}
