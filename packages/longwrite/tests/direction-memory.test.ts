import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeDirectionMemory } from "../src/lib/research/direction-memory.js";

const tempDirs: string[] = [];
afterEach(async () => {
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-directions-"));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, "reviews"), { recursive: true });
  return dir;
}

async function plan(dir: string, intents: Array<{ id: string; kind: string; section_id?: string }>): Promise<void> {
  await fs.writeFile(path.join(dir, "reviews", "artifact-plan.json"), JSON.stringify({
    version: 1,
    intents: intents.map((intent) => ({ ...intent, rationale: `because of ${intent.id}`, acceptance_criteria: [] })),
  }));
}

describe("direction memory", () => {
  it("says nothing constrains the first round", async () => {
    const ws = await makeWorkspace();
    const { memory, written } = await writeDirectionMemory(ws);
    expect(memory.directions).toEqual([]);
    expect(await fs.readFile(path.join(ws, written[1]), "utf-8")).toContain("first planning round");
  });

  it("accumulates directions across rounds", async () => {
    const ws = await makeWorkspace();
    await plan(ws, [{ id: "regime-comparison", kind: "comparison_matrix", section_id: "section-1" }]);
    await writeDirectionMemory(ws);

    await plan(ws, [{ id: "adoption-timeline", kind: "timeline", section_id: "section-2" }]);
    const { memory } = await writeDirectionMemory(ws);

    expect(memory.rounds_recorded).toBe(2);
    expect(memory.directions.map((direction) => direction.id)).toEqual(["regime-comparison", "adoption-timeline"]);
    expect(memory.directions[0].round).toBe(1);
    expect(memory.directions[1].round).toBe(2);
  });

  it("stays a set of tried directions rather than a transcript", async () => {
    const ws = await makeWorkspace();
    await plan(ws, [{ id: "regime-comparison", kind: "comparison_matrix" }]);
    await writeDirectionMemory(ws);
    // A plan carried forward unchanged must not re-enter the history; the
    // planner needs to know a direction was tried, not how often.
    await writeDirectionMemory(ws);
    const { memory } = await writeDirectionMemory(ws);

    expect(memory.directions).toHaveLength(1);
    expect(memory.rounds_recorded).toBe(3);
  });

  it("permits a repeat but asks what changed, rather than forbidding it", async () => {
    const ws = await makeWorkspace();
    await plan(ws, [{ id: "regime-comparison", kind: "comparison_matrix" }]);
    const { written } = await writeDirectionMemory(ws);
    const markdown = await fs.readFile(path.join(ws, written[1]), "utf-8");
    expect(markdown).toContain("not forbidden");
    expect(markdown).toContain("what is different now");
  });
});
