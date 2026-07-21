import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { repairAgenticActionPlan } from "../src/lib/ops/action-plan.js";
import { writeOperatorClarificationRequest } from "../src/lib/ops/action-plan.js";
import { runInit } from "../src/commands/init.js";
import { runResearchExpand } from "../src/commands/research.js";

const dirs: string[] = [];

async function workspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-action-plan-"));
  dirs.push(dir);
  await fs.mkdir(path.join(dir, "reviews"));
  return dir;
}

afterEach(async () => {
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true });
});

describe("agentic action-plan contract", () => {
  it("normalizes a fenced action plan without changing its selected action", async () => {
    const dir = await workspace();
    await fs.writeFile(path.join(dir, "reviews", "action-plan.json"), `\`\`\`json
{"version":1,"findings":[{"id":"coverage-gap","severity":"major","summary":"Benchmark coverage is thin."}],"actions":[{"id":"expand-1","tool":"targeted_research_expansion","finding_ids":["coverage-gap"],"rationale":"Find benchmark sources.","acceptance_criteria":[{"metric":"cited_sources","target":80}]}]}
\`\`\`\n`);
    const result = await repairAgenticActionPlan(dir);
    expect(result.normalized).toBe(true);
    const plan = JSON.parse(await fs.readFile(path.join(dir, "reviews", "action-plan.json"), "utf-8"));
    expect(plan.actions[0].tool).toBe("targeted_research_expansion");
    await expect(fs.stat(path.join(dir, "reviews", "action-plan.json.pre-normalization.md"))).resolves.toBeDefined();
  });

  it("fails visibly instead of dropping an action with an unknown finding", async () => {
    const dir = await workspace();
    await fs.writeFile(path.join(dir, "reviews", "action-plan.json"), JSON.stringify({
      version: 1,
      findings: [],
      actions: [{ id: "revise-1", tool: "revise_sections", finding_ids: ["missing"], rationale: "Repair." }],
    }));
    await expect(repairAgenticActionPlan(dir)).rejects.toThrow(/invalid action-plan contract/);
    await expect(fs.readFile(path.join(dir, "reports", "action-plan-repair.md"), "utf-8")).resolves.toContain("Status: failed");
  });

  it("merges duplicate actions for one bounded output contract", async () => {
    const dir = await workspace();
    await fs.writeFile(path.join(dir, "reviews", "action-plan.json"), JSON.stringify({
      version: 1,
      findings: [
        { id: "table", severity: "critical", summary: "The table is clipped." },
        { id: "caption", severity: "major", summary: "The caption is incomplete." },
      ],
      actions: [
        { id: "visual-1", tool: "revise_visual_plan", finding_ids: ["table"], rationale: "Repair the table.", acceptance_criteria: [{ metric: "tables", target: 5 }] },
        { id: "visual-2", tool: "revise_visual_plan", finding_ids: ["caption"], rationale: "Repair the caption.", acceptance_criteria: [{ metric: "figures", target: 3 }] },
      ],
    }));
    await repairAgenticActionPlan(dir);
    const plan = JSON.parse(await fs.readFile(path.join(dir, "reviews", "action-plan.json"), "utf-8"));
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].finding_ids).toEqual(["table", "caption"]);
    expect(plan.actions[0].rationale).toContain("Repair the caption.");
    expect(plan.actions[0].acceptance_criteria).toHaveLength(2);
  });

  it("adapts an approved agentic expansion action to the bounded research tool", async () => {
    const root = await workspace();
    const dir = path.join(root, "workspace");
    await runInit(dir, { mode: "auto_research_agentic", topic: "Agent memory", researchProvider: "seed" });
    await fs.writeFile(path.join(dir, "reviews", "action-plan.json"), JSON.stringify({
      version: 1,
      findings: [{ id: "coverage", severity: "major", summary: "Benchmark coverage is thin." }],
      actions: [{ id: "expand-1", tool: "targeted_research_expansion", finding_ids: ["coverage"], rationale: "Find benchmark sources.", acceptance_criteria: [{ metric: "taxonomy_cell_ab_sources", scope: "benchmarks", target: 2 }] }],
    }));
    await runResearchExpand(dir, { actionPlan: "reviews/action-plan.json" });
    await expect(fs.readFile(path.join(dir, "reports", "research-expansion.md"), "utf-8")).resolves.toContain("seed provider");
  });

  it("writes a concrete operator request without allowing the plan to guess", async () => {
    const dir = await workspace();
    await fs.writeFile(path.join(dir, "reviews", "action-plan.json"), JSON.stringify({
      version: 1,
      findings: [{ id: "venue", severity: "critical", summary: "The publication target and anonymity rules conflict." }],
      actions: [{ id: "ask", tool: "request_operator_clarification", finding_ids: ["venue"], rationale: "Should this manuscript target an anonymous venue submission or a named arXiv release?", acceptance_criteria: [{ metric: "tables", target: 0 }] }],
    }));
    await writeOperatorClarificationRequest(dir);
    await expect(fs.readFile(path.join(dir, "reviews", "clarification-request.md"), "utf-8")).resolves.toContain("anonymous venue submission");
  });
});
