import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { evaluateStall, writeStallStatus } from "../src/lib/research/stall.js";

const tempDirs: string[] = [];
afterEach(async () => {
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function makeWorkspace(scores: number[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-stall-"));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, "reports"), { recursive: true });
  await fs.writeFile(path.join(dir, "reports", "score-history.json"), JSON.stringify(
    scores.map((reviewScore, index) => ({ round: index + 1, reviewScore })),
  ));
  return dir;
}

describe("loop stall and action eligibility", () => {
  it("leaves every action eligible while the score is still climbing", async () => {
    const status = await evaluateStall(await makeWorkspace([3, 4, 5.5]));
    expect(status.posture).toBe("open");
    expect(status.stale_rounds).toBe(0);
    expect(status.eligible_tools).toContain("revise_sections");
  });

  // The live flagship's history: 3 → 2.6 → 1.4, with a fourth round queued to
  // run the same shape again.
  it("withholds tactical actions once rounds stop beating the best score", async () => {
    const status = await evaluateStall(await makeWorkspace([3, 2.6, 1.4]));
    expect(status.posture).toBe("structural");
    expect(status.stale_rounds).toBe(2);
    expect(status.eligible_tools).toEqual(["reopen_outline", "targeted_research_expansion"]);
    expect(status.eligible_tools).not.toContain("revise_sections");
  });

  // Matching the best is not progress; a loop that plateaus is still circling.
  it("treats a plateau as staleness, not improvement", async () => {
    const status = await evaluateStall(await makeWorkspace([6, 6, 6]));
    expect(status.stale_rounds).toBe(2);
    expect(status.posture).toBe("structural");
  });

  it("escalates when structural pivots have not rescued the loop either", async () => {
    const status = await evaluateStall(await makeWorkspace([7, 6, 6, 5, 6.5]));
    expect(status.stale_rounds).toBe(4);
    expect(status.posture).toBe("escalate");
    expect(status.detail).toContain("operator decision");
  });

  it("stays open before any round has been scored", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-stall-empty-"));
    tempDirs.push(dir);
    const { status, written } = await writeStallStatus(dir);
    expect(status.posture).toBe("open");
    expect(status.rounds).toBe(0);
    expect(await fs.readFile(path.join(dir, written[1]), "utf-8")).toContain("Posture: **open**");
  });

  it("says why tactical actions were withheld", async () => {
    const ws = await makeWorkspace([5, 4, 4]);
    const { written } = await writeStallStatus(ws);
    const markdown = await fs.readFile(path.join(ws, written[1]), "utf-8");
    expect(markdown).toContain("Pivot the structure, not the tactics");
    expect(markdown).toContain("reopen_outline");
  });
});
