import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ExperimentPilot } from "./schema.js";

export const ResearchState = z.object({
  version: z.literal(1),
  pilot: ExperimentPilot,
  status: z.enum(["planned", "running", "paused", "completed", "blocked"]),
  current_round: z.number().int().nonnegative(),
  champion_node_id: z.string().min(1),
  stagnation_rounds: z.number().int().nonnegative().default(0),
  stop_reason: z.string().min(1).optional(),
  updated_at: z.string().datetime(),
}).strict();
export type ResearchState = z.infer<typeof ResearchState>;
export const RESEARCH_STATE_PATH = path.join("runs", "research-state.json");

async function writeAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try { await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8"); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
}
function statePath(workspace: string): string { return path.join(workspace, RESEARCH_STATE_PATH); }
export async function readResearchState(workspace: string): Promise<ResearchState> { return ResearchState.parse(JSON.parse(await fs.readFile(statePath(workspace), "utf8"))); }
export async function initializeResearchState(workspace: string, input: Pick<ResearchState, "pilot" | "champion_node_id">): Promise<ResearchState> {
  const state = ResearchState.parse({ version: 1, ...input, status: "planned", current_round: 0, stagnation_rounds: 0, updated_at: new Date().toISOString() });
  await writeAtomic(statePath(workspace), state); return state;
}
export async function updateResearchState(workspace: string, update: Partial<Omit<ResearchState, "version" | "pilot" | "updated_at">>): Promise<ResearchState> {
  const state = ResearchState.parse({ ...(await readResearchState(workspace)), ...update, updated_at: new Date().toISOString() });
  await writeAtomic(statePath(workspace), state); return state;
}
