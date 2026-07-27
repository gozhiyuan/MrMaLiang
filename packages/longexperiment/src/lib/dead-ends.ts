import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const DeadEndEvidence = z.object({
  candidate_node_id: z.string().min(1),
  hypothesis_family: z.string().min(3),
  outcome: z.enum(["failed", "discarded", "crashed"]),
  reason: z.string().min(8),
  recorded_at: z.string().datetime(),
}).strict();
export type DeadEndEvidence = z.infer<typeof DeadEndEvidence>;
export const DeadEndMemory = z.object({ version: z.literal(1), evidence: z.array(DeadEndEvidence), closed_families: z.array(z.object({ family: z.string().min(3), evidence_count: z.number().int().positive(), closed_at: z.string().datetime(), reason: z.string().min(8) }).strict()) }).strict();
export type DeadEndMemory = z.infer<typeof DeadEndMemory>;
const memoryPath = (workspace: string) => path.join(workspace, "runs", "dead-ends.json");

async function writeAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try { await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8"); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
}
export async function readDeadEndMemory(workspace: string): Promise<DeadEndMemory> {
  try { return DeadEndMemory.parse(JSON.parse(await fs.readFile(memoryPath(workspace), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, evidence: [], closed_families: [] }; throw error; }
}
/** Retain every negative observation; close a family only after independent candidate evidence. */
export async function recordDeadEndEvidence(workspace: string, input: Omit<DeadEndEvidence, "recorded_at">, minimumEvidence = 2): Promise<DeadEndMemory> {
  if (!Number.isInteger(minimumEvidence) || minimumEvidence < 2) throw new Error("minimum dead-end evidence must be at least two candidates");
  const current = await readDeadEndMemory(workspace);
  const evidence = [...current.evidence, DeadEndEvidence.parse({ ...input, recorded_at: new Date().toISOString() })];
  const sameFamily = evidence.filter((item) => item.hypothesis_family.trim().toLowerCase() === input.hypothesis_family.trim().toLowerCase());
  const distinctCandidates = new Set(sameFamily.map((item) => item.candidate_node_id));
  const alreadyClosed = current.closed_families.some((item) => item.family.trim().toLowerCase() === input.hypothesis_family.trim().toLowerCase());
  const closed_families = !alreadyClosed && distinctCandidates.size >= minimumEvidence
    ? [...current.closed_families, { family: input.hypothesis_family, evidence_count: distinctCandidates.size, closed_at: new Date().toISOString(), reason: `${distinctCandidates.size} independent candidates produced retained negative evidence` }]
    : current.closed_families;
  const next = DeadEndMemory.parse({ version: 1, evidence, closed_families });
  await writeAtomic(memoryPath(workspace), next);
  return next;
}
