import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const RoundArchive = z.object({
  version: z.literal(1),
  round_id: z.string().regex(/^round-[1-9][0-9]*$/),
  archived_at: z.string().datetime(),
  state: z.record(z.unknown()),
}).strict();
export type RoundArchive = z.infer<typeof RoundArchive>;

const activePath = (workspace: string) => path.join(workspace, "runs", "rounds", "active.json");
const archivePath = (workspace: string, roundId: string) => path.join(workspace, "runs", "rounds", "archive", `${roundId}.json`);

async function replaceAtomically(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try { await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8"); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
}

/** Start a new active-round document only when no prior active work remains. */
export async function startActiveRound(workspace: string, roundId: string, state: Record<string, unknown>): Promise<void> {
  if (!/^round-[1-9][0-9]*$/.test(roundId)) throw new Error("round id must be round-<positive integer>");
  try { await fs.access(activePath(workspace)); throw new Error("an active round must be archived before starting another"); }
  catch (error) { if (error instanceof Error && error.message.includes("must be archived")) throw error; }
  await replaceAtomically(activePath(workspace), { version: 1, round_id: roundId, state });
}

/** Archive the active state by an atomic rename; it can never be half-reused. */
export async function archiveActiveRound(workspace: string): Promise<RoundArchive> {
  const source = activePath(workspace);
  const raw = JSON.parse(await fs.readFile(source, "utf8")) as { version?: unknown; round_id?: unknown; state?: unknown };
  if (raw.version !== 1 || typeof raw.round_id !== "string" || !/^round-[1-9][0-9]*$/.test(raw.round_id) || !raw.state || typeof raw.state !== "object" || Array.isArray(raw.state)) throw new Error("active round state is invalid");
  const archive = RoundArchive.parse({ version: 1, round_id: raw.round_id, archived_at: new Date().toISOString(), state: raw.state });
  const target = archivePath(workspace, archive.round_id);
  try { await fs.access(target); throw new Error(`round ${archive.round_id} is already archived`); }
  catch (error) { if (error instanceof Error && error.message.includes("already archived")) throw error; }
  const temp = path.join(path.dirname(source), `.archive-${crypto.randomUUID()}.json`);
  await fs.writeFile(temp, `${JSON.stringify(archive, null, 2)}\n`, "utf8");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rename(temp, target);
  await fs.rm(source, { force: true });
  return archive;
}
