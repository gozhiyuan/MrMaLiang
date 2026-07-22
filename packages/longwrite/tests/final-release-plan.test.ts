import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runResearchRepairFinalReleasePlan } from "../src/commands/research.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

async function workspace(validation: unknown, plan: unknown): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-final-release-"));
  dirs.push(root);
  await fs.mkdir(path.join(root, "reports"), { recursive: true });
  await fs.mkdir(path.join(root, "reviews"), { recursive: true });
  await fs.writeFile(path.join(root, "reports", "longwrite-validation.json"), JSON.stringify(validation), "utf-8");
  await fs.writeFile(path.join(root, "reviews", "action-plan.json"), JSON.stringify(plan), "utf-8");
  return root;
}

describe("final-release action-plan contract", () => {
  it("requires the plan to cover every currently failed release check", async () => {
    const root = await workspace(
      { pass: false, checks: [{ id: "claim_support", pass: false }, { id: "review_target", pass: false }] },
      {
        version: 1,
        findings: [
          { id: "claim_support", severity: "major", summary: "Revise claims that the deterministic sample found only partially supported." },
          { id: "review_target", severity: "major", summary: "Repair the reviewed manuscript weakness before publication." },
        ],
        actions: [{
          id: "repair-prose", tool: "revise_sections", finding_ids: ["claim_support", "review_target"],
          rationale: "Use only validated evidence packets to revise the affected prose.",
          acceptance_criteria: [{ metric: "citation_depth_per_section", target: 1, scope: "B" }],
        }],
      },
    );
    await expect(runResearchRepairFinalReleasePlan(root)).resolves.toBeUndefined();
    await expect(fs.readFile(path.join(root, "reports", "final-release-plan-repair.md"), "utf-8"))
      .resolves.toContain("Status: pass");
  });

  it("rejects a plan that silently ignores a failed gate", async () => {
    const root = await workspace(
      { pass: false, checks: [{ id: "claim_support", pass: false }, { id: "review_target", pass: false }] },
      {
        version: 1,
        findings: [{ id: "claim_support", severity: "major", summary: "Revise unsupported prose." }],
        actions: [{
          id: "repair-prose", tool: "revise_sections", finding_ids: ["claim_support"],
          rationale: "Use only validated evidence packets to revise the affected prose.",
          acceptance_criteria: [{ metric: "citation_depth_per_section", target: 1, scope: "B" }],
        }],
      },
    );
    await expect(runResearchRepairFinalReleasePlan(root)).rejects.toThrow("invalid final-release recovery plan");
    await expect(fs.readFile(path.join(root, "reports", "final-release-plan-repair.md"), "utf-8"))
      .resolves.toContain("does not address failed checks");
  });
});
