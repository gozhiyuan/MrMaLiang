import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sanitizePlacementPlanFile } from "../src/lib/writing/figures.js";

const tempDirs: string[] = [];

async function makeWorkspace(plan?: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-placement-"));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, "figures"), { recursive: true });
  if (plan !== undefined) {
    await fs.writeFile(path.join(dir, "figures", "placement-plan.json"), typeof plan === "string" ? plan : JSON.stringify(plan), "utf-8");
  }
  return dir;
}

async function readPlan(dir: string): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await fs.readFile(path.join(dir, "figures", "placement-plan.json"), "utf-8")); } catch { return null; }
}

const validConceptMap = {
  version: 1,
  placements: [],
  concept_map: {
    title: "Concept map",
    caption: "short caption",
    placement: { section_id: "s1", discussion: "d" },
    nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }],
    edges: [{ from: "a", to: "b" }],
  },
};

afterEach(async () => {
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

describe("sanitizePlacementPlanFile", () => {
  it("is a no-op when the plan is absent", async () => {
    const dir = await makeWorkspace();
    await expect(sanitizePlacementPlanFile(dir)).resolves.toBeUndefined();
    expect(await readPlan(dir)).toBeNull();
  });

  it("clamps an over-long caption in place instead of crashing the build", async () => {
    const longCaption = "word ".repeat(200).trim(); // ~999 chars, over the 500 cap
    const dir = await makeWorkspace({ ...validConceptMap, concept_map: { ...validConceptMap.concept_map, caption: longCaption } });
    await sanitizePlacementPlanFile(dir);
    const plan = await readPlan(dir);
    const caption = (plan?.concept_map as { caption: string }).caption;
    expect(caption.length).toBeLessThanOrEqual(500);
    expect(caption.endsWith("…")).toBe(true);
    const repair = await fs.readFile(path.join(dir, "reports", "visual-plan-repair.md"), "utf-8");
    expect(repair).toContain("concept_map.caption");
  });

  it("leaves a valid, in-cap plan untouched", async () => {
    const dir = await makeWorkspace(validConceptMap);
    await sanitizePlacementPlanFile(dir);
    expect((await readPlan(dir))?.concept_map).toMatchObject({ caption: "short caption" });
    await expect(fs.access(path.join(dir, "reports", "visual-plan-repair.md"))).rejects.toThrow();
  });

  it("sets aside a structurally invalid plan so the build falls back to defaults", async () => {
    // Two nodes violates the min(3) node contract — not a clampable text field.
    const dir = await makeWorkspace({ ...validConceptMap, concept_map: { ...validConceptMap.concept_map, nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }] } });
    await sanitizePlacementPlanFile(dir);
    expect(await readPlan(dir)).toBeNull(); // removed → renderer degrades to defaults
    await expect(fs.access(path.join(dir, "figures", "placement-plan.rejected.json"))).resolves.toBeUndefined();
    const repair = await fs.readFile(path.join(dir, "reports", "visual-plan-repair.md"), "utf-8");
    expect(repair).toContain("Rejected an invalid");
  });

  it("sets aside a plan that is not valid JSON", async () => {
    const dir = await makeWorkspace("{ not json");
    await sanitizePlacementPlanFile(dir);
    expect(await readPlan(dir)).toBeNull();
    await expect(fs.access(path.join(dir, "figures", "placement-plan.rejected.json"))).resolves.toBeUndefined();
  });
});
