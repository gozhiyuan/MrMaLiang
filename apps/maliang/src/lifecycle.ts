import fs from "node:fs/promises";
import path from "node:path";

export type LifecyclePhase = "experiment" | "handoff" | "writing";
export type LifecycleStatus = "not_applicable" | "ready" | "running" | "awaiting_approval" | "completed" | "blocked";
export type LifecycleState = {
  version: 1;
  updated_at: string;
  phases: Record<LifecyclePhase, { status: LifecycleStatus; updated_at: string; detail?: string }>;
  events: Array<{ at: string; phase: LifecyclePhase; status: LifecycleStatus; detail?: string }>;
};

function statePath(workspace: string): string { return path.join(workspace, "runs", "lifecycle-state.json"); }
function now(): string { return new Date().toISOString(); }

export async function initializeLifecycle(workspace: string, components: { writing?: unknown; experiment?: unknown }, handoffMode: "none" | "run_then_import" | "import_existing"): Promise<void> {
  const time = now();
  const phases: LifecycleState["phases"] = {
    experiment: { status: components.experiment ? "ready" : "not_applicable", updated_at: time },
    handoff: { status: handoffMode === "none" ? "not_applicable" : handoffMode === "import_existing" ? "ready" : "not_applicable", updated_at: time },
    writing: { status: components.writing ? "ready" : "not_applicable", updated_at: time },
  };
  const state: LifecycleState = { version: 1, updated_at: time, phases, events: [] };
  await fs.mkdir(path.dirname(statePath(workspace)), { recursive: true });
  await fs.writeFile(statePath(workspace), `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

export async function readLifecycle(workspace: string): Promise<LifecycleState> {
  return JSON.parse(await fs.readFile(statePath(workspace), "utf8")) as LifecycleState;
}

export async function markLifecycle(workspace: string, phase: LifecyclePhase, status: LifecycleStatus, detail?: string): Promise<void> {
  const state = await readLifecycle(workspace);
  const time = now();
  state.updated_at = time;
  state.phases[phase] = { status, updated_at: time, ...(detail ? { detail } : {}) };
  state.events.push({ at: time, phase, status, ...(detail ? { detail } : {}) });
  await fs.writeFile(statePath(workspace), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
