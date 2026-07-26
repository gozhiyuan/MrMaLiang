import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { archiveActiveRound, startActiveRound } from "../src/lib/rounds.js";

const dirs: string[] = [];
async function workspace() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longexperiment-rounds-")); dirs.push(dir); return dir; }
afterEach(async () => { while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true }); });

describe("round archives", () => {
  it("requires active state to be archived before it can be reused", async () => {
    const dir = await workspace();
    await startActiveRound(dir, "round-1", { candidates: ["candidate-a"] });
    await expect(startActiveRound(dir, "round-2", {})).rejects.toThrow(/must be archived/);
    const archived = await archiveActiveRound(dir);
    expect(archived).toMatchObject({ round_id: "round-1", state: { candidates: ["candidate-a"] } });
    await expect(fs.access(path.join(dir, "runs", "rounds", "active.json"))).rejects.toThrow();
    await startActiveRound(dir, "round-2", { candidates: ["candidate-b"] });
  });
});
