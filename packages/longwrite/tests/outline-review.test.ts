import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { repairOutlineReview, scoreOutlineReadiness, validateOutlineReopen, writeOutlineApprovalBrief } from "../src/lib/ops/outline-review.js";

const dirs: string[] = [];
afterEach(async () => { while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true }); });

async function workspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-outline-review-"));
  dirs.push(dir);
  await Promise.all(["reviews", "reports", "sources"].map((entry) => fs.mkdir(path.join(dir, entry), { recursive: true })));
  await fs.writeFile(path.join(dir, "outline.json"), JSON.stringify({ sections: [{ id: "taxonomy", title: "Taxonomy", keywords: ["memory", "evaluation"] }] }));
  await fs.writeFile(path.join(dir, "sources", "classified_sources.jsonl"), `${JSON.stringify({ id: "paper-a" })}\n`);
  await fs.writeFile(path.join(dir, "reports", "survey-contract.json"), JSON.stringify({ pass: true }));
  await fs.writeFile(path.join(dir, "reports", "structure-audit.json"), JSON.stringify({ pass: true }));
  return dir;
}

describe("outline review contract", () => {
  it("requires audits plus a grounded no-blocker review before approval", async () => {
    const dir = await workspace();
    await fs.writeFile(path.join(dir, "reviews", "outline-review.json"), JSON.stringify({
      version: 1,
      summary: "The taxonomy is source-grounded and the section sequence exposes the intended comparison.",
      strengths: ["The taxonomy section is linked to a verified source."],
      findings: [{ id: "minor-wording", severity: "minor", category: "clarity", summary: "The taxonomy section title could name the comparison axis more explicitly.", section_ids: ["taxonomy"], source_ids: ["paper-a"] }],
    }));
    await repairOutlineReview(dir);
    expect((await scoreOutlineReadiness(dir)).ready).toBe(true);
    await expect(writeOutlineApprovalBrief(dir)).resolves.toBe("reports/outline-approval.md");
  });

  it("fails closed when the reviewer invents a source or reports a blocking problem", async () => {
    const dir = await workspace();
    await fs.writeFile(path.join(dir, "reviews", "outline-review.json"), JSON.stringify({
      version: 1,
      summary: "The outline lacks an evidence-backed comparison section.", strengths: [],
      findings: [{ id: "gap", severity: "major", category: "comparison", summary: "A comparison section must be added before the outline can support the survey argument.", section_ids: ["taxonomy"], source_ids: ["paper-a"] }],
    }));
    await repairOutlineReview(dir);
    expect((await scoreOutlineReadiness(dir)).ready).toBe(false);
    await expect(writeOutlineApprovalBrief(dir)).rejects.toThrow(/outline_readiness/);

    await fs.writeFile(path.join(dir, "reviews", "outline-review.json"), JSON.stringify({
      version: 1, summary: "An unknown source is cited.", strengths: [],
      findings: [{ id: "bad-source", severity: "minor", category: "evidence", summary: "This finding incorrectly cites a source outside the workspace corpus.", section_ids: ["taxonomy"], source_ids: ["invented-paper"] }],
    }));
    await expect(repairOutlineReview(dir)).rejects.toThrow(/invalid outline-review contract/);
  });

  it("requires deterministic outline audits when an allowlisted reopen was selected", async () => {
    const dir = await workspace();
    await fs.writeFile(path.join(dir, "reviews", "action-plan.json"), JSON.stringify({
      version: 1,
      findings: [{ id: "taxonomy", severity: "critical", summary: "The organizing taxonomy collapses two incompatible method families." }],
      actions: [{ id: "reopen", tool: "reopen_outline", finding_ids: ["taxonomy"], rationale: "Replace the taxonomy with a source-backed multi-axis organization.", acceptance_criteria: [{ metric: "outline_readiness", target: 1 }] }],
    }));
    await expect(validateOutlineReopen(dir)).resolves.toMatchObject({ selected: true, ready: true });
    await expect(fs.readFile(path.join(dir, "reports", "outline-reopen.md"), "utf8")).resolves.toContain("Status: validated");
  });
});
