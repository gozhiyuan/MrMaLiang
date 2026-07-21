import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { repairAgenticArtifactPlan } from "../src/lib/ops/artifact-plan.js";

const tempDirs: string[] = [];

async function workspace(paperKind: "survey" | "empirical" = "survey"): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-artifact-plan-"));
  tempDirs.push(root);
  await fs.mkdir(path.join(root, "reviews"), { recursive: true });
  await fs.mkdir(path.join(root, "sources"), { recursive: true });
  await fs.writeFile(path.join(root, "longwrite.yaml"), [
    "version: 1", "project:", "  id: artifact-plan", "  artifact_type: research_paper", "  mode: auto_research_agentic", "research:", `  paper_kind: ${paperKind}`, "  taxonomy:", "    - evaluation and benchmarks", "",
  ].join("\n"), "utf-8");
  await fs.writeFile(path.join(root, "outline.json"), JSON.stringify({ sections: [{ id: "evaluation", title: "Evaluation" }] }), "utf-8");
  await fs.writeFile(path.join(root, "sources", "classified_sources.jsonl"), `${JSON.stringify({ id: "source-1" })}\n`, "utf-8");
  return root;
}

afterEach(async () => {
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

describe("agentic artifact plan", () => {
  it("accepts source-grounded formalization and metadata-plot choices", async () => {
    const ws = await workspace();
    await fs.writeFile(path.join(ws, "reviews", "artifact-plan.json"), [
      "```json",
      JSON.stringify({ version: 1, intents: [
        { id: "define-memory", kind: "formalization", rationale: "The evaluation section needs a compact, evidence-backed definition of retained utility before comparing measurements.", section_id: "evaluation", source_ids: ["source-1"], acceptance_criteria: [{ metric: "citation_depth_per_section", target: 1, scope: "evaluation" }] },
        { id: "plot-depth", kind: "metadata_plot", rationale: "A citation-depth distribution makes the evidence hierarchy inspectable without inventing a performance result.", section_id: "evaluation", plot_metric: "citation_depth", acceptance_criteria: [{ metric: "verified_metadata_plots", target: 1 }] },
      ] }),
      "```",
      "",
    ].join("\n"), "utf-8");
    const result = await repairAgenticArtifactPlan(ws);
    expect(result.normalized).toBe(true);
    expect(await fs.readFile(path.join(ws, "reports", "artifact-plan-repair.md"), "utf-8")).toContain("Selected intents: 2");
  });

  it("rejects an empirical pilot for a survey", async () => {
    const ws = await workspace("survey");
    await fs.writeFile(path.join(ws, "reviews", "artifact-plan.json"), JSON.stringify({ version: 1, intents: [
      { id: "pilot", kind: "empirical_pilot", rationale: "The paper needs controlled empirical validation before making a capability claim about the proposed method.", experiment_hypothesis: "The intervention improves retained utility.", control: "A matched no-intervention baseline.", acceptance_criteria: [{ metric: "empirical_trials", target: 3 }] },
    ] }), "utf-8");
    await expect(repairAgenticArtifactPlan(ws)).rejects.toThrow("invalid artifact-plan contract");
  });

  it("permits codebase evidence only for a repository architecture diagram", async () => {
    const ws = await workspace();
    await fs.mkdir(path.join(ws, "codebases"), { recursive: true });
    await fs.writeFile(path.join(ws, "codebases", "manifest.json"), JSON.stringify({
      version: 1, codebases: [{ version: 1, id: "repo", source: "https://github.com/example/repo.git", requested_ref: "main", resolved_commit: "a".repeat(40), title: "Repo", role: "primary_artifact", snapshot_path: "codebases/repo/snapshot", files: [], generated_at: "2026-07-19T00:00:00.000Z" }],
    }), "utf8");
    await fs.writeFile(path.join(ws, "reviews", "artifact-plan.json"), JSON.stringify({ version: 1, intents: [
      { id: "bad-formalization", kind: "formalization", rationale: "A repository marker must not stand in for scholarly support of a mathematical formalization.", section_id: "evaluation", source_ids: ["codebase:repo"], acceptance_criteria: [{ metric: "citation_depth_per_section", target: 1, scope: "evaluation" }] },
    ] }), "utf8");
    await expect(repairAgenticArtifactPlan(ws)).rejects.toThrow("invalid artifact-plan contract");
  });
});
