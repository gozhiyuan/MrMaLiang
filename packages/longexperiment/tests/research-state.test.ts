import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initializeResearchState, readResearchState, updateResearchState } from "../src/lib/research-state.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });
describe("research state", () => {
  it("keeps the active round in an atomically replaceable portable record", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "research-state-")); dirs.push(dir);
    await initializeResearchState(dir, { pilot: "repository_optimization", champion_node_id: "base" });
    await updateResearchState(dir, { status: "running", current_round: 1, stagnation_rounds: 1 });
    await expect(readResearchState(dir)).resolves.toMatchObject({ status: "running", current_round: 1, champion_node_id: "base" });
  });

  it("rejects state updates that violate the portable state contract", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "research-state-")); dirs.push(dir);
    await initializeResearchState(dir, { pilot: "paper_reproduction", champion_node_id: "base" });
    await expect(updateResearchState(dir, { current_round: -1 })).rejects.toThrow();
    await expect(readResearchState(dir)).resolves.toMatchObject({ current_round: 0, champion_node_id: "base" });
  });
});
