import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A zero-spend end-to-end check for the agentic control plane. Its action-plan
// fixture selects a real catalog action, so this covers planner validation,
// the allowlisted dispatcher, and ordinary release gates together.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const longwrite = path.join(repoRoot, "dist", "cli.js");
const malaclawRoot = process.env.MALACLAW_SOURCE_DIR
  ? path.resolve(process.env.MALACLAW_SOURCE_DIR)
  : path.resolve(repoRoot, "..", "..", "..", "malaclaw");
const tmp = path.join(os.tmpdir(), `lw-agentic-dry-${Date.now()}`);

function nodeAtLeast22(): boolean {
  return Number(process.versions.node.split(".")[0]) >= 22;
}

afterAll(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

describe.skipIf(!nodeAtLeast22())("auto_research_agentic dry-run", () => {
  it("executes a validated allowlisted action and completes", async () => {
    const ws = path.join(tmp, "agentic");
    const node = process.execPath;
    const run = (args: string[]) => execFileSync(node, [longwrite, ...args], { cwd: repoRoot, stdio: "pipe" });
    const malaclaw = (args: string[]) =>
      execFileSync(node, [path.join(malaclawRoot, "dist", "cli.js"), ...args], { cwd: ws, stdio: "pipe" });

    run(["init", ws, "--mode", "auto_research_agentic", "--topic", "agentic dry-run plumbing", "--research-provider", "seed"]);
    const manifestPath = path.join(ws, "malaclaw.yaml");
    const manifest = (await fs.readFile(manifestPath, "utf-8")).replace(/cmd: \S*node\S*/g, `cmd: ${node}`);
    await fs.writeFile(manifestPath, manifest, "utf-8");

    for (let i = 0; i < 24; i++) {
      try { malaclaw(["flow", "run", "--runtime", "dry-run"]); } catch { /* approval pauses are expected */ }
      const state = JSON.parse(await fs.readFile(path.join(ws, ".malaclaw", "flow", "state.json"), "utf-8"));
      if (state.status === "completed" || state.status === "failed") break;
      if (state.status === "paused_for_approval") { try { malaclaw(["flow", "review", "--batch"]); } catch { /* no-op */ } }
    }

    const state = JSON.parse(await fs.readFile(path.join(ws, ".malaclaw", "flow", "state.json"), "utf-8"));
    // Full-workflow plumbing gate (merged from the retired v2 dry-run test):
    // every unit must reach a terminal success state, not merely the flow.
    const notDone = Object.entries(state.units)
      .filter(([, u]: [string, any]) => u.status !== "succeeded" && u.status !== "skipped")
      .map(([k, u]: [string, any]) => `${k}:${u.status}`);
    expect(notDone, `unfinished units: ${notDone.join(", ")}`).toEqual([]);
    expect(state.status).toBe("completed");
    expect(state.units["quality_loop-r1-action_dispatch"]).toMatchObject({ status: "succeeded" });
    const dispatched = Object.entries(state.units).find(([key]) => key.includes("action_dispatch.revise_sections[revise-fixture]"));
    expect(dispatched?.[1]).toMatchObject({ status: "succeeded" });
    expect(await fs.readFile(path.join(ws, "reports", "action-dispatch.json"), "utf-8")).toContain("revise_sections");
  }, 240_000);
});
