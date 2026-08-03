import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { evaluateComparisonOpportunities, writeComparisonOpportunities } from "../src/lib/research/comparison-opportunities.js";

const tempDirs: string[] = [];
afterEach(async () => {
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-opportunities-"));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, "evidence"), { recursive: true });
  await fs.mkdir(path.join(dir, "figures"), { recursive: true });
  await fs.writeFile(path.join(dir, "outline.json"), JSON.stringify({
    sections: [
      { id: "section-1", title: "Served section", source_ids: ["s1", "s2"] },
      { id: "section-2", title: "Unserved section", source_ids: ["s2", "s3"] },
      { id: "section-3", title: "No validated evidence", source_ids: ["unknown"] },
    ],
  }));
  const entry = (id: string, cells: string[], dimensions: string[], limitations: string[]) => ({
    screening: { source_id: id, taxonomy_cells: cells },
    packet: { source_id: id, claims: [{ claim: "c", comparison_dimensions: dimensions, limitations }] },
  });
  await fs.writeFile(path.join(dir, "evidence", "active-validated-source-evidence.json"), JSON.stringify({
    version: 1,
    entries: [
      entry("s1", ["memory"], ["loop-closure degree"], ["single benchmark"]),
      entry("s2", ["memory", "evaluation"], ["human involvement"], ["no ablation", "small n"]),
      entry("s3", ["safety"], ["retrieval quality"], []),
    ],
  }));
  return dir;
}

describe("comparison opportunities", () => {
  it("summarizes validated evidence per section without inventing a target", async () => {
    const ws = await makeWorkspace();
    const report = await evaluateComparisonOpportunities(ws);

    const section2 = report.sections.find((section) => section.section_id === "section-2")!;
    expect(section2.packet_backed_sources).toBe(2);
    expect(section2.taxonomy_cells).toEqual(["evaluation", "memory", "safety"]);
    expect(section2.recorded_limitations).toBe(2);
    // Free-text dimensions pass through verbatim; deciding which name the same
    // axis is a judgment, not a string match.
    expect(section2.comparison_dimensions).toEqual(["human involvement", "retrieval quality"]);

    // A section whose sources carry no validated packet is reported as empty
    // rather than omitted, so the planner sees it was considered.
    expect(report.sections.find((section) => section.section_id === "section-3")!.packet_backed_sources).toBe(0);

    const markdown = await fs.readFile(path.join(ws, (await writeComparisonOpportunities(ws))[1]), "utf-8");
    expect(markdown).toContain("observation, not a target");
    expect(markdown).toContain("no required number of figures or tables");
    // The report must never restate a quota in prose; that is the thing it
    // replaces. It may only say a number is *not* required.
    expect(markdown).not.toMatch(/minimum|quota|at least \d|should have \d/i);
  });

  it("counts an artifact the manuscript carries, not one the plan merely requested", async () => {
    const ws = await makeWorkspace();
    await fs.writeFile(path.join(ws, "figures", "placement-plan.json"), JSON.stringify({
      version: 1,
      placements: [
        { id: "published-table", placement: { section_id: "section-1", discussion: "d" } },
        // A retired built-in: requested, never produced.
        { id: "evidence-profile", placement: { section_id: "section-2", discussion: "d" } },
      ],
    }));
    await fs.writeFile(path.join(ws, "figures", "manifest.json"), JSON.stringify({
      version: 1, figures: [], tables: [{ id: "published-table" }],
    }));

    const report = await evaluateComparisonOpportunities(ws);
    expect(report.sections.find((section) => section.section_id === "section-1")!.placed_artifacts).toEqual(["published-table"]);
    // Section 2 asked for an artifact that no reader will ever see, so it is
    // still an opportunity rather than a served section.
    expect(report.sections.find((section) => section.section_id === "section-2")!.placed_artifacts).toEqual([]);
  });

  it("falls back to the plan before a first build has produced a manifest", async () => {
    const ws = await makeWorkspace();
    await fs.writeFile(path.join(ws, "figures", "placement-plan.json"), JSON.stringify({
      version: 1,
      placements: [{ id: "planned-table", placement: { section_id: "section-1", discussion: "d" } }],
    }));
    const report = await evaluateComparisonOpportunities(ws);
    expect(report.sections.find((section) => section.section_id === "section-1")!.placed_artifacts).toEqual(["planned-table"]);
  });
});
