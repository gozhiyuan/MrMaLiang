import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runResearchDispatchMetrics } from "../src/commands/research.js";

const tempDirs: string[] = [];

async function makeWorkspace(dispatch?: unknown, metrics?: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-dispatch-metrics-"));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, "reports"), { recursive: true });
  if (dispatch !== undefined) {
    await fs.writeFile(path.join(dir, "reports", "action-dispatch-research.json"), JSON.stringify(dispatch), "utf-8");
  }
  if (metrics !== undefined) {
    await fs.writeFile(path.join(dir, "reports", "metrics.json"), JSON.stringify(metrics), "utf-8");
  }
  return dir;
}

async function readMetrics(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(dir, "reports", "metrics.json"), "utf-8"));
}

async function writeRevisionPlan(dir: string, tools: string[]): Promise<void> {
  await fs.mkdir(path.join(dir, "reviews"), { recursive: true });
  await fs.writeFile(path.join(dir, "reviews", "revision-action-plan.json"), JSON.stringify({
    version: 1,
    findings: tools.map((tool, index) => ({ id: `finding-${index}`, severity: "major", summary: tool })),
    actions: tools.map((tool, index) => ({
      id: `action-${index}`, tool, finding_ids: [`finding-${index}`], rationale: tool,
      acceptance_criteria: [{ metric: tool === "revise_visual_plan" ? "rendered_visual_review" : "review_score", target: tool === "revise_visual_plan" ? 1 : 8 }],
    })),
  }), "utf-8");
}

afterEach(async () => {
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

describe("research dispatch-metrics", () => {
  it("records 0 when no expansion was dispatched", async () => {
    const dir = await makeWorkspace({ version: 1, status: "completed", executions: [] });
    await runResearchDispatchMetrics(dir);
    expect((await readMetrics(dir)).research_expansion_dispatched).toBe(0);
  });

  it("records 1 when an expansion succeeded", async () => {
    const dir = await makeWorkspace({ version: 1, status: "completed", executions: [{ id: "research_expansion", status: "succeeded" }] });
    await runResearchDispatchMetrics(dir);
    expect((await readMetrics(dir)).research_expansion_dispatched).toBe(1);
  });

  it("records 0 after a continued recoverable expansion failure", async () => {
    const dir = await makeWorkspace({ version: 1, status: "partial_failure", executions: [{ id: "research_expansion", status: "failed_recoverable" }] });
    await runResearchDispatchMetrics(dir);
    expect((await readMetrics(dir)).research_expansion_dispatched).toBe(0);
  });

  it("skips fresh claim judging for a visual-only revision plan", async () => {
    const dir = await makeWorkspace({ version: 1, executions: [] });
    await writeRevisionPlan(dir, ["revise_visual_plan"]);
    await runResearchDispatchMetrics(dir);
    expect((await readMetrics(dir)).manuscript_revision_planned).toBe(0);
  });

  it("requires fresh claim judging when prose revision is selected", async () => {
    const dir = await makeWorkspace({ version: 1, executions: [] });
    await writeRevisionPlan(dir, ["revise_sections", "revise_visual_plan"]);
    await runResearchDispatchMetrics(dir);
    expect((await readMetrics(dir)).manuscript_revision_planned).toBe(1);
  });

  it("preserves existing metrics while merging the gate metric", async () => {
    const dir = await makeWorkspace({ version: 1, executions: [] }, { review_score: 7.5, corpus_gate_pass: 1 });
    await runResearchDispatchMetrics(dir);
    const metrics = await readMetrics(dir);
    expect(metrics.research_expansion_dispatched).toBe(0);
    expect(metrics.review_score).toBe(7.5);
    expect(metrics.corpus_gate_pass).toBe(1);
  });

  it("fails open to 1 when the dispatch record is missing or malformed", async () => {
    const missing = await makeWorkspace();
    await runResearchDispatchMetrics(missing);
    expect((await readMetrics(missing)).research_expansion_dispatched).toBe(1);

    const malformed = await makeWorkspace({ version: 1, executions: "not-an-array" });
    await runResearchDispatchMetrics(malformed);
    expect((await readMetrics(malformed)).research_expansion_dispatched).toBe(1);
    expect((await readMetrics(malformed)).manuscript_revision_planned).toBe(1);
  });
});
