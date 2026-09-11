import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runResearchGenerateFinalReleasePlan, runResearchRepairFinalReleasePlan } from "../src/commands/research.js";


/** Structured findings, as the deterministic validators emit them. The
 * capability is resolved from each finding's triple, so a plan never names a
 * tool and a validation report carries what the producer actually found. */
const prose = (id: string, over: Record<string, unknown> = {}) => ({
  id, gate_id: "claim_support",
  artifact: { kind: "chapter_prose", path: "chapters/section-01.md" },
  objective_scope_key: "", required_effect: "remove_unsupported_claim",
  acceptance_metric: "claim_support", severity: "major",
  diagnostic: `Prose defect ${id}.`, ...over,
});
const visual = (id: string, over: Record<string, unknown> = {}) => ({
  id, gate_id: "figure_references",
  artifact: { kind: "figure_spec", path: "figures/placement-plan.json" },
  objective_scope_key: "", required_effect: "repair_artifact_placement",
  acceptance_metric: null, severity: "major",
  diagnostic: `Visual defect ${id}.`, ...over,
});
/** A question only an operator can answer: no capability this product owns can
 * act on a toolchain target. */
const operatorAsk = (id: string, over: Record<string, unknown> = {}) => ({
  id, gate_id: "cited_literature_release_gates",
  artifact: { kind: "toolchain", target: "operator" },
  objective_scope_key: "", required_effect: "repair_toolchain",
  acceptance_metric: null, severity: "critical",
  diagnostic: `Operator decision required for ${id}.`, ...over,
});
const corpus = (id: string, over: Record<string, unknown> = {}) => ({
  id, gate_id: "core_sources",
  artifact: { kind: "corpus", path: "sources/classified_sources.jsonl" },
  objective_scope_key: "", required_effect: "acquire_additional_evidence",
  acceptance_metric: "core_sources", severity: "critical",
  diagnostic: `Corpus gap ${id}.`, ...over,
});

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
      { pass: false, checks: [{ id: "claim_support", pass: false, findings: [prose("claim_support-f", { gate_id: "claim_support", required_effect: "remove_unsupported_claim", acceptance_metric: "claim_support" })] }, { id: "review_target", pass: false, findings: [prose("review_target-f", { gate_id: "review_target", required_effect: "remove_unsupported_claim", acceptance_metric: "claim_support" })] }] },
      {
        version: 2,
        findings: [
          prose("claim_support", { severity: "major", diagnostic: "Revise claims that the deterministic sample found only partially supported." }),
          prose("review_target", { severity: "major", diagnostic: "Repair the reviewed manuscript weakness before publication." }),
        ],
        actions: [{
          id: "repair-prose", finding_ids: ["claim_support", "review_target"],
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
      { pass: false, checks: [{ id: "claim_support", pass: false, findings: [prose("claim_support-f", { gate_id: "claim_support", required_effect: "remove_unsupported_claim", acceptance_metric: "claim_support" })] }, { id: "review_target", pass: false, findings: [prose("review_target-f", { gate_id: "review_target", required_effect: "remove_unsupported_claim", acceptance_metric: "claim_support" })] }] },
      {
        version: 2,
        findings: [prose("claim_support", { severity: "major", diagnostic: "Revise unsupported prose." })],
        actions: [{
          id: "repair-prose", finding_ids: ["claim_support"],
          rationale: "Use only validated evidence packets to revise the affected prose.",
          acceptance_criteria: [{ metric: "citation_depth_per_section", target: 1, scope: "B" }],
        }],
      },
    );
    // Enrichment ADDS the repair the planner omitted rather than failing the
    // round: the capability follows from the finding, so the missing work is
    // derivable. What must not happen is the ignored gate going unrepaired.
    await runResearchRepairFinalReleasePlan(root);
    const corrected = JSON.parse(await fs.readFile(path.join(root, "reviews", "action-plan.json"), "utf-8"));
    const covered = new Set(corrected.actions.flatMap((action: { finding_ids: string[] }) => action.finding_ids));
    expect(covered).toContain("review_target-f");
    expect(covered).toContain("claim_support-f");
    await expect(fs.readFile(path.join(root, "reports", "final-release-plan-repair.md"), "utf-8"))
      .resolves.toContain("Status: pass");
  });

  it("adds an executable section revision for acknowledged manuscript failures", async () => {
    const root = await workspace(
      { pass: false, checks: [{ id: "review_target", pass: false, findings: [prose("review_target-f", { gate_id: "review_target", required_effect: "remove_unsupported_claim", acceptance_metric: "claim_support" })] }, { id: "taxonomy_direct_evidence", pass: false, findings: [{ ...corpus("taxonomy_direct_evidence-f"), gate_id: "taxonomy_direct_evidence", artifact: { kind: "evidence_packet", path: "evidence/coverage.json" }, acceptance_metric: "taxonomy_cell_ab_sources" }] }] },
      {
        version: 2,
        findings: [
          prose("review_target", { severity: "critical", diagnostic: "The organizing synthesis needs an evidence-boundary repair." }),
          prose("taxonomy_direct_evidence", { severity: "major", diagnostic: "A taxonomy cell needs another direct source." }),
        ],
        actions: [
          { id: "outline", finding_ids: ["review_target"], rationale: "Refresh the comparison frame.", acceptance_criteria: [{ metric: "outline_readiness", target: 1 }] },
          { id: "expand", finding_ids: ["taxonomy_direct_evidence"], rationale: "Retrieve a missing source.", acceptance_criteria: [{ metric: "cited_sources", target: 1 }] },
        ],
      },
    );
    await expect(runResearchRepairFinalReleasePlan(root)).resolves.toBeUndefined();
    const repaired = JSON.parse(await fs.readFile(path.join(root, "reviews", "action-plan.json"), "utf-8"));
    expect(repaired.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ finding_ids: expect.arrayContaining(["review_target", "review_target-f"]) }),
      expect.objectContaining({ finding_ids: ["taxonomy_direct_evidence-f"] }),
    ]));
  });

  it("adds the mandatory visual repair when a planner incorrectly requests clarification only", async () => {
    const root = await workspace(
      { pass: false, checks: [{ id: "rendered_visual_review", pass: false, findings: [visual("rendered_visual_review-f", { gate_id: "rendered_visual_review", required_effect: "repair_artifact_placement", acceptance_metric: null })] }] },
      {
        version: 2,
        // The planner asked a question about a defect that has a routable
        // repair. The capability follows the finding, so the repair is what
        // gets dispatched — a clarification cannot waive it.
        findings: [operatorAsk("rendered_visual_review")],
        actions: [{ id: "clarify", finding_ids: ["rendered_visual_review"], rationale: "Ask whether to waive the failure.", acceptance_criteria: [{ metric: "rendered_visual_review", target: 1 }] }],
      },
    );
    await expect(runResearchRepairFinalReleasePlan(root)).resolves.toBeUndefined();
    const repaired = JSON.parse(await fs.readFile(path.join(root, "reviews", "action-plan.json"), "utf-8"));
    const covered = new Set(repaired.actions.flatMap((action: { finding_ids: string[] }) => action.finding_ids));
    expect(covered).toContain("rendered_visual_review-f");
  });

  it("generates a bounded executable plan directly from deterministic failed gates", async () => {
    const root = await workspace(
      { pass: false, checks: [{ id: "claim_support", pass: false, detail: "Claims need repair.", findings: [prose("claim_support-f", { gate_id: "claim_support", required_effect: "remove_unsupported_claim", acceptance_metric: "claim_support" })] }, { id: "rendered_visual_review", pass: false, detail: "Labels are unreadable.", findings: [visual("rendered_visual_review-f", { gate_id: "rendered_visual_review", required_effect: "repair_artifact_placement", acceptance_metric: null })] }] },
      { version: 2, findings: [], actions: [] },
    );
    await expect(runResearchGenerateFinalReleasePlan(root)).resolves.toBeUndefined();
    const generated = JSON.parse(await fs.readFile(path.join(root, "reviews", "action-plan.json"), "utf-8"));
    expect(generated.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ finding_ids: ["claim_support-f"],
        acceptance_criteria: expect.arrayContaining([expect.objectContaining({ metric: "claim_support", target: 0.9 })]),
      }),
      expect.objectContaining({ finding_ids: ["rendered_visual_review-f"] }),
    ]));
  });

  it("pauses for a typed operator decision after two wholly stalled rounds", async () => {
    const root = await workspace(
      { pass: false, checks: [{ id: "landmark_coverage", pass: false, findings: [corpus("landmark_coverage", { gate_id: "landmark_coverage" })] }] },
      { version: 2, findings: [], actions: [] },
    );
    await fs.writeFile(path.join(root, "reports", "metrics.json"), JSON.stringify({ repair_stalled_rounds: 2 }), "utf-8");
    await runResearchGenerateFinalReleasePlan(root);
    const generated = JSON.parse(await fs.readFile(path.join(root, "reviews", "action-plan.json"), "utf-8"));
    // The escalation names an OPERATOR target: no capability this product owns
    // can act on it, which is what "a human must decide" means. Reusing the
    // repair findings would route it to a repair capability and hide it.
    expect(generated.actions).toEqual([expect.objectContaining({
      id: "repair-stalled-operator-decision",
      finding_ids: ["operator-decision-required"],
    })]);
  });

  it("routes v3 gates to their owning repair capability with directional criteria", async () => {
    const root = await workspace(
      { pass: false, checks: [
        { id: "landmark_coverage", pass: false, findings: [corpus("landmark_coverage", { gate_id: "landmark_coverage", diagnostic: "missing: AFlow" })] },
        { id: "landmark_citation_coverage", pass: false, findings: [prose("landmark_citation_coverage", { gate_id: "landmark_citation_coverage", required_effect: "add_supporting_citation", acceptance_metric: "landmark_citation_coverage_ratio", diagnostic: "uncited: Promptbreeder" })] },
        { id: "claim_contradictions", pass: false, findings: [prose("claim_contradictions", { gate_id: "claim_contradictions", required_effect: "resolve_contradiction", acceptance_metric: "claim_contradictions", diagnostic: "Sections 5 and 9 conflict" })] },
        { id: "diagram_connectivity", pass: false, findings: [visual("diagram_connectivity", { gate_id: "diagram_connectivity", required_effect: "repair_artifact_content", acceptance_metric: "diagram_connectivity", diagnostic: "Figure 1 has two components" })] },
      ] },
      { version: 2, findings: [], actions: [] },
    );
    await fs.appendFile(path.join(root, "longwrite.yaml"), "\n" + [
      "  corpus_gates:", "    min_landmark_coverage_ratio: 0.75", "    min_landmark_citation_coverage_ratio: 0.6",
    ].join("\n") + "\n");
    await runResearchGenerateFinalReleasePlan(root);
    const generated = JSON.parse(await fs.readFile(path.join(root, "reviews", "action-plan.json"), "utf-8"));
    // Split by capability *and objective*: the two prose repairs share a
    // worker but must retain distinct acceptance/diagnosis lineages.
    expect(generated.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ finding_ids: ["landmark_coverage"], acceptance_criteria: [expect.objectContaining({ metric: "landmark_coverage_ratio", operator: "at_least", target: 0.75 })] }),
      expect.objectContaining({ finding_ids: ["landmark_citation_coverage"], acceptance_criteria: [expect.objectContaining({ metric: "landmark_citation_coverage_ratio", operator: "at_least", target: 0.6 })] }),
      expect.objectContaining({ finding_ids: ["claim_contradictions"], acceptance_criteria: [expect.objectContaining({ metric: "claim_contradictions", operator: "at_most", target: 0 })] }),
      // A connectivity ratio the registry declares as maximize, so the
      // criterion raises it rather than capping it.
      expect.objectContaining({ finding_ids: ["diagram_connectivity"], acceptance_criteria: [expect.objectContaining({ metric: "diagram_connectivity", operator: "at_least", target: 1 })] }),
    ]));
  });

  it("routes manuscript build failure to visual/build repair", async () => {
    const root = await workspace(
      { pass: false, checks: [{ id: "manuscript_build", pass: false, findings: [visual("manuscript_build", { gate_id: "manuscript_build", diagnostic: "build/manuscript.pdf is missing" })] }] },
      { version: 2, findings: [], actions: [] },
    );
    await runResearchGenerateFinalReleasePlan(root);
    const generated = JSON.parse(await fs.readFile(path.join(root, "reviews", "action-plan.json"), "utf-8"));
    expect(generated.actions).toEqual([expect.objectContaining({ finding_ids: ["manuscript_build"],
      acceptance_criteria: [expect.objectContaining({ metric: "rendered_visual_review", operator: "equals", target: 1 })],
    })]);
  });

  it("enriches claim support with the actual deterministic threshold", async () => {
    const root = await workspace(
      { pass: false, checks: [{ id: "claim_support", pass: false, findings: [prose("claim_support", { diagnostic: "claim support is 0.7" })] }] },
      {
        version: 2,
        findings: [prose("claim_support", { severity: "major", diagnostic: "Claim support is below threshold." })],
        actions: [{ id: "ask", finding_ids: ["claim_support"], rationale: "Ask what to do.", acceptance_criteria: [{ metric: "citation_depth_per_section", target: 1 }] }],
      },
    );
    await runResearchRepairFinalReleasePlan(root);
    const generated = JSON.parse(await fs.readFile(path.join(root, "reviews", "action-plan.json"), "utf-8"));
    expect(generated.actions).toEqual(expect.arrayContaining([expect.objectContaining({
      acceptance_criteria: expect.arrayContaining([expect.objectContaining({ metric: "claim_support", operator: "at_least", target: 0.9 })]),
    })]));
  });

  it("fails closed when a failed release check has a non-string id", async () => {
    const root = await workspace(
      { pass: false, checks: [{ id: 42, pass: false }] },
      { version: 2, findings: [], actions: [] },
    );
    await expect(runResearchRepairFinalReleasePlan(root)).rejects.toThrow("invalid final-release recovery plan");
    await expect(fs.readFile(path.join(root, "reports", "final-release-plan-repair.md"), "utf-8")).resolves.toContain("without a string id");
  });

  it("preserves exact cited-source and review targets and routes concrete table findings", async () => {
    const root = await workspace(
      { pass: false, checks: [
        { id: "cited_literature_release_gates", pass: false, findings: [prose("cited-sources-low", { gate_id: "cited_literature_release_gates", required_effect: "add_supporting_citation", acceptance_metric: "cited_sources", diagnostic: "cited sources 25 is below configured minimum 30" })] },
        { id: "rendered_visual_review", pass: false, findings: [visual("review-target-visual", { gate_id: "rendered_visual_review", required_effect: "repair_artifact_content", acceptance_metric: "rendered_visual_review", diagnostic: "Figure quality remains below the release review threshold." })] },
      ] },
      { version: 2, findings: [], actions: [] },
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
    // Grouped by the capability each finding resolves to, with the reviewer's
    // own weaknesses carried into the prose rationale.
    const proseAction = generated.actions.find((action: { finding_ids: string[] }) =>
      action.finding_ids.includes("cited-sources-low"));
    const visualAction = generated.actions.find((action: { finding_ids: string[] }) =>
      action.finding_ids.includes("review-target-visual"));
    expect(proseAction.acceptance_criteria).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "cited_sources", target: 30 }),
    ]));
    expect(proseAction.rationale).toContain("Add five distinct packet-backed sources");
    expect(visualAction).toBeDefined();
  });

  it("routes a visually caused review-target deficit without rewriting supported prose", async () => {
    const root = await workspace(
      { pass: false, checks: [
        { id: "rendered_visual_review", pass: false, findings: [visual("review-target-visual", { gate_id: "rendered_visual_review", required_effect: "repair_artifact_content", acceptance_metric: "rendered_visual_review", diagnostic: "Figure quality remains below the release review threshold." })] },
        { id: "rendered_visual_review", pass: false, findings: [visual("figure-width", { gate_id: "rendered_visual_review", diagnostic: "Figure 1 is not full width." })] },
      ] },
      { version: 2, findings: [], actions: [] },
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
    // Both repairs are visual and no prose rewrite is introduced, but their
    // figure-count and rendered-review objectives remain separate instances.
    expect(generated.actions).toHaveLength(2);
    expect(generated.actions.map((action: { finding_ids: string[] }) => action.finding_ids))
      .toEqual(expect.arrayContaining([["review-target-visual"], ["figure-width"]]));
  });
});
