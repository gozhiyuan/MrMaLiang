import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runResearchGenerateFinalReleasePlan, runResearchRepairFinalReleasePlan } from "../src/commands/research.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

async function workspace(validation: unknown, plan: unknown): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-final-release-"));
  dirs.push(root);
  await fs.mkdir(path.join(root, "reports"), { recursive: true });
  await fs.mkdir(path.join(root, "reviews"), { recursive: true });
  await fs.writeFile(path.join(root, "longwrite.yaml"), [
    "version: 1", "project:", "  id: final-release-test", "  artifact_type: research_paper", "  mode: auto_research_agentic",
    "research:", "  release_gates:", "    min_cited_sources: 30", "    min_accepted_cited_ratio: 0.3",
  ].join("\n"), "utf-8");
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
          acceptance_criteria: [{ metric: "review_score", target: 8, scope: "fresh independent multi-persona review" }],
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

  it("adds an executable section revision for acknowledged manuscript failures", async () => {
    const root = await workspace(
      { pass: false, checks: [{ id: "review_target", pass: false }, { id: "taxonomy_direct_evidence", pass: false }] },
      {
        version: 1,
        findings: [
          { id: "review_target", severity: "critical", summary: "The organizing synthesis needs an evidence-boundary repair." },
          { id: "taxonomy_direct_evidence", severity: "major", summary: "A taxonomy cell needs another direct source." },
        ],
        actions: [
          { id: "outline", tool: "reopen_outline", finding_ids: ["review_target"], rationale: "Refresh the comparison frame.", acceptance_criteria: [{ metric: "outline_readiness", target: 1 }] },
          { id: "expand", tool: "targeted_research_expansion", finding_ids: ["taxonomy_direct_evidence"], rationale: "Retrieve a missing source.", acceptance_criteria: [{ metric: "cited_sources", target: 1 }] },
        ],
      },
    );
    await expect(runResearchRepairFinalReleasePlan(root)).resolves.toBeUndefined();
    const repaired = JSON.parse(await fs.readFile(path.join(root, "reviews", "action-plan.json"), "utf-8"));
    expect(repaired.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: "revise_sections", finding_ids: expect.arrayContaining(["review_target", "taxonomy_direct_evidence"]) }),
    ]));
  });

  it("adds the mandatory visual repair when a planner incorrectly requests clarification only", async () => {
    const root = await workspace(
      { pass: false, checks: [{ id: "rendered_visual_review", pass: false }] },
      {
        version: 1,
        findings: [{ id: "rendered_visual_review", severity: "major", summary: "The rendered table is illegible." }],
        actions: [{ id: "clarify", tool: "request_operator_clarification", finding_ids: ["rendered_visual_review"], rationale: "Ask whether to waive the failure.", acceptance_criteria: [{ metric: "rendered_visual_review", target: 1 }] }],
      },
    );
    await expect(runResearchRepairFinalReleasePlan(root)).resolves.toBeUndefined();
    const repaired = JSON.parse(await fs.readFile(path.join(root, "reviews", "action-plan.json"), "utf-8"));
    expect(repaired.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: "revise_visual_plan",
        finding_ids: ["rendered_visual_review"],
        acceptance_criteria: [expect.objectContaining({ metric: "rendered_visual_review", target: 1 })],
      }),
    ]));
  });

  it("generates a bounded executable plan directly from deterministic failed gates", async () => {
    const root = await workspace(
      { pass: false, checks: [{ id: "claim_support", pass: false, detail: "Claims need repair." }, { id: "rendered_visual_review", pass: false, detail: "Labels are unreadable." }] },
      { version: 1, findings: [], actions: [] },
    );
    await expect(runResearchGenerateFinalReleasePlan(root)).resolves.toBeUndefined();
    const generated = JSON.parse(await fs.readFile(path.join(root, "reviews", "action-plan.json"), "utf-8"));
    expect(generated.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tool: "revise_sections", finding_ids: ["claim_support"],
        acceptance_criteria: expect.arrayContaining([expect.objectContaining({ metric: "claim_support", target: 0.9 })]),
      }),
      expect.objectContaining({ tool: "revise_visual_plan", finding_ids: ["rendered_visual_review"] }),
    ]));
  });

  it("preserves exact cited-source and review targets and routes concrete table findings", async () => {
    const root = await workspace(
      { pass: false, checks: [
        { id: "cited_literature_release_gates", pass: false, findings: ["cited=25", "cited sources 25 is below configured minimum 30"] },
        { id: "review_target", pass: false, findings: ["review_score 5.4 is below the research release target 8.0"] },
      ] },
      { version: 1, findings: [], actions: [] },
    );
    await fs.writeFile(path.join(root, "reviews", "scorecard.json"), JSON.stringify({
      version: 1,
      personas: [
        { id: "skeptic", scores: {}, weaknesses: [{ category: "table evidence", detail: "Table 2 contains one metadata-only mechanism cell.", severity: "major" }] },
        { id: "reader", scores: {}, weaknesses: [{ category: "evidence boundary", detail: "Add five distinct packet-backed sources to supported claims.", severity: "critical" }] },
        { id: "editor", scores: {}, weaknesses: [] },
      ],
    }), "utf-8");

    await runResearchGenerateFinalReleasePlan(root);
    const generated = JSON.parse(await fs.readFile(path.join(root, "reviews", "action-plan.json"), "utf-8"));
    const prose = generated.actions.find((action: { tool: string }) => action.tool === "revise_sections");
    const visual = generated.actions.find((action: { tool: string }) => action.tool === "revise_visual_plan");
    expect(prose.acceptance_criteria).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "cited_sources", target: 30 }),
      expect.objectContaining({ metric: "review_score", target: 8 }),
    ]));
    expect(prose.rationale).toContain("Add five distinct packet-backed sources");
    expect(visual.finding_ids).toContain("review_target");
    expect(visual.rationale).toContain("Table 2 contains one metadata-only mechanism cell");
  });

  it("routes a visually caused review-target deficit without rewriting supported prose", async () => {
    const root = await workspace(
      { pass: false, checks: [
        { id: "review_target", pass: false, findings: ["review_score 7.8 is below the research release target 8.0"] },
        { id: "rendered_visual_review", pass: false, findings: ["Figure 1 is not full width."] },
      ] },
      { version: 1, findings: [], actions: [] },
    );
    await fs.writeFile(path.join(root, "reviews", "scorecard.json"), JSON.stringify({
      version: 1,
      personas: [
        { id: "reader", scores: {}, weaknesses: [{ category: "figure layout", detail: "Figure 1 remains half width.", severity: "major" }] },
        { id: "skeptic", scores: {}, weaknesses: [{ category: "claim threshold margin", detail: "Keep the already passing claim support stable.", severity: "minor" }] },
      ],
    }), "utf-8");

    await runResearchGenerateFinalReleasePlan(root);
    const generated = JSON.parse(await fs.readFile(path.join(root, "reviews", "action-plan.json"), "utf-8"));
    expect(generated.actions.some((action: { tool: string }) => action.tool === "revise_sections")).toBe(false);
    expect(generated.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: "revise_visual_plan", finding_ids: expect.arrayContaining(["review_target", "rendered_visual_review"]) }),
    ]));
  });
});
