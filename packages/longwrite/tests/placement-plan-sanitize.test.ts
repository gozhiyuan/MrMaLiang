import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildFigureWorkspace, sanitizePlacementPlanFile } from "../src/lib/writing/figures.js";

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

  it("preserves a machine-verifiable two-column diagram layout", async () => {
    const dir = await makeWorkspace({
      version: 1,
      placements: [],
      diagrams: [{
        id: "review-boundary", title: "Review boundary", caption: "Four review dimensions.",
        insight: "The grid lets readers inspect four independently required review dimensions without conflating their roles.",
        placement: { section_id: "s1", discussion: "Use a 2x2 grid." }, source_ids: ["source-1"],
        layout: { kind: "grid", columns: 2 },
        nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }, { id: "d", label: "D" }],
        edges: [{ from: "a", to: "c" }, { from: "b", to: "d" }],
      }],
    });
    await sanitizePlacementPlanFile(dir);
    expect((((await readPlan(dir))?.diagrams as Array<{ layout: unknown }>)[0]?.layout)).toEqual({ kind: "grid", columns: 2 });
  });

  it("rejects a grid layout without a deterministic column count", async () => {
    const dir = await makeWorkspace({ ...validConceptMap, concept_map: { ...validConceptMap.concept_map, layout: { kind: "grid" } } });
    await sanitizePlacementPlanFile(dir);
    expect(await readPlan(dir)).toBeNull();
    await expect(fs.access(path.join(dir, "figures", "placement-plan.rejected.json"))).resolves.toBeUndefined();
  });

  it("declares deterministic grid nodes before drawing edges in TikZ", async () => {
    const dir = await makeWorkspace({
      version: 1, placements: [], diagrams: [{
        id: "ordered-grid", title: "Ordered grid", caption: "A deterministic grid.",
        insight: "The deterministic grid exposes the relationship without delegating publication geometry to a renderer heuristic.",
        placement: { section_id: "s1", discussion: "Use a two-column grid." }, source_ids: ["source-1"],
        layout: { kind: "grid", columns: 2 },
        nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }],
        edges: [{ from: "a", to: "c" }],
      }],
    });
    await fs.mkdir(path.join(dir, "sources"), { recursive: true });
    await fs.writeFile(path.join(dir, "sources", "classified_sources.jsonl"), `${JSON.stringify({ id: "source-1", title: "Source", authors: ["A"], year: 2025, venue: "Venue", url: "https://example.test/source", abstract: "", source: "test", topics: [], citation_depth: "B", quality_score: 0.8 })}\n`);
    await buildFigureWorkspace(dir);
    const tex = await fs.readFile(path.join(dir, "paper", "figures", "ordered-grid.tex"), "utf8");
    expect(tex).toContain("\\resizebox{\\linewidth}{!}");
    expect(tex.indexOf("\\node[")).toBeGreaterThanOrEqual(0);
    expect(tex.indexOf("\\draw[")).toBeGreaterThan(tex.indexOf("\\node["));
  });

  it("normalizes whitespace in a table kind instead of discarding an otherwise valid plan", async () => {
    const dir = await makeWorkspace({
      version: 1,
      placements: [],
      table_specs: [{
        id: "comparison-matrix",
        kind: "mechanism and evidence comparison",
        title: "Mechanism comparison",
        caption: "The comparison distinguishes mechanism and evidence.",
        insight: "The comparison prevents readers from treating distinct improvement mechanisms as interchangeable evidence.",
        placement: { section_id: "s1", discussion: "The table anchors the comparison." },
        headers: ["Mechanism", "Evidence"],
        rows: [{ cells: ["Reflection", "Task-specific result"], source_ids: ["source-1"] }],
      }],
    });
    await sanitizePlacementPlanFile(dir);
    expect(((await readPlan(dir))?.table_specs as Array<{ kind: string }>)[0]?.kind).toBe("mechanism-and-evidence-comparison");
    const repair = await fs.readFile(path.join(dir, "reports", "visual-plan-repair.md"), "utf-8");
    expect(repair).toContain("table_specs[0].kind (whitespace normalized)");
  });

  it("keeps complete source identifiers in a traceability table", async () => {
    const completeId = `source:${"durable-evidence-identifier-".repeat(12)}2026`;
    const dir = await makeWorkspace({
      version: 1,
      placements: [],
      table_specs: [{
        id: "traceability-aid",
        kind: "traceability_aid",
        title: "Evidence traceability",
        caption: "The aid preserves complete source identifiers for audit.",
        insight: "Complete identifiers let readers connect each boundary claim to its inspected evidence record.",
        placement: { section_id: "s1", discussion: "The aid makes the evidence boundary auditable." },
        headers: ["Claim", "Complete source IDs"],
        rows: [{ cells: ["Boundary", completeId], source_ids: ["source-1"] }],
      }],
    });
    await sanitizePlacementPlanFile(dir);
    expect(((await readPlan(dir))?.table_specs as Array<{ rows: Array<{ cells: string[] }> }>)[0]?.rows[0]?.cells[1]).toBe(completeId);
    await expect(fs.access(path.join(dir, "figures", "placement-plan.rejected.json"))).rejects.toThrow();
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
