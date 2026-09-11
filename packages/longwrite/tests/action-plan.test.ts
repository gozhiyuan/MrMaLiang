import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { capabilityOf, repairAgenticActionPlan, splitAgenticActionPlan } from "../src/lib/ops/action-plan.js";
import { writeOperatorClarificationRequest } from "../src/lib/ops/action-plan.js";
import { runInit } from "../src/commands/init.js";
import { buildExpansionQueries, buildExpansionSearchPlan, expansionIntentKey, runResearchExpand, type ExpansionAction } from "../src/commands/research.js";


/** Structured findings of the shape the producers emit.
 *
 * A finding carries its own (gate, artifact kind, required effect) triple, so
 * the registry resolves the capability and the plan never names a tool. These
 * factories keep each fixture readable while staying honest about what a real
 * producer emits. */
const prose = (id: string, over: Record<string, unknown> = {}) => ({
  id, gate_id: "cited_literature_release_gates",
  artifact: { kind: "chapter_prose", path: "chapters/section-01.md" },
  objective_scope_key: "", required_effect: "add_supporting_citation",
  acceptance_metric: "cited_sources", severity: "major",
  diagnostic: `Prose defect ${id}.`, ...over,
});
const corpus = (id: string, over: Record<string, unknown> = {}) => ({
  id, gate_id: "core_sources",
  artifact: { kind: "corpus", path: "sources/classified_sources.jsonl" },
  objective_scope_key: "", required_effect: "acquire_additional_evidence",
  acceptance_metric: "core_sources", severity: "major",
  diagnostic: `Corpus gap ${id}.`, ...over,
});
const visual = (id: string, over: Record<string, unknown> = {}) => ({
  id, gate_id: "figure_artifacts",
  artifact: { kind: "figure_spec", path: "figures/placement-plan.json" },
  objective_scope_key: "", required_effect: "repair_artifact_content",
  acceptance_metric: "figures", severity: "major",
  diagnostic: `Visual defect ${id}.`, ...over,
});
const operator = (id: string, over: Record<string, unknown> = {}) => ({
  id, gate_id: "cited_literature_release_gates",
  artifact: { kind: "toolchain", target: "pdflatex" },
  objective_scope_key: "", required_effect: "repair_toolchain",
  acceptance_metric: null, severity: "critical",
  diagnostic: `Operator decision required for ${id}.`, ...over,
});

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
${JSON.stringify({ version: 2, findings: [corpus("coverage-gap")], actions: [{ id: "expand-1", finding_ids: ["coverage-gap"], rationale: "Find benchmark sources.", acceptance_criteria: [{ metric: "cited_sources", target: 80 }] }] })}
\`\`\`\n`);
    const result = await repairAgenticActionPlan(dir);
    expect(result.normalized).toBe(true);
    const plan = JSON.parse(await fs.readFile(path.join(dir, "reviews", "action-plan.json"), "utf-8"));
    // The capability is resolved from the finding, never carried on the action.
    expect(plan.actions[0].tool).toBeUndefined();
    expect(capabilityOf(plan, plan.actions[0])).toBe("targeted_research_expansion");
    await expect(fs.stat(path.join(dir, "reviews", "action-plan.json.pre-normalization.md"))).resolves.toBeDefined();
  });

  it("migrates missing directional operators in an in-flight action plan", async () => {
    const dir = await workspace();
    await fs.writeFile(path.join(dir, "reviews", "action-plan.json"), JSON.stringify({
      version: 2,
      findings: [
        prose("duplicates", { gate_id: "prose_redundancy", required_effect: "remove_redundant_prose", acceptance_metric: null }),
        prose("landmarks"),
      ],
      actions: [{
        id: "repair", finding_ids: ["duplicates", "landmarks"], rationale: "Repair both findings.",
        acceptance_criteria: [{ metric: "prose_redundancy", target: 0 }, { metric: "landmark_citation_coverage_ratio", target: 0.6 }],
      }],
    }));
    await expect(repairAgenticActionPlan(dir)).resolves.toBeDefined();
    const plan = JSON.parse(await fs.readFile(path.join(dir, "reviews", "action-plan.json"), "utf-8"));
    expect(plan.actions[0].acceptance_criteria).toEqual([
      expect.objectContaining({ metric: "prose_redundancy", operator: "at_most" }),
      expect.objectContaining({ metric: "landmark_citation_coverage_ratio", operator: "at_least" }),
    ]);
  });

  it("fails visibly instead of dropping an action with an unknown finding", async () => {
    const dir = await workspace();
    await fs.writeFile(path.join(dir, "reviews", "action-plan.json"), JSON.stringify({
      version: 2,
      findings: [],
      actions: [{ id: "revise-1", finding_ids: ["missing"], rationale: "Repair." }],
    }));
    await expect(repairAgenticActionPlan(dir)).rejects.toThrow(/invalid action-plan contract/);
    await expect(fs.readFile(path.join(dir, "reports", "action-plan-repair.md"), "utf-8")).resolves.toContain("Status: failed");
  });

  it("merges duplicate actions for one bounded output contract", async () => {
    const dir = await workspace();
    await fs.writeFile(path.join(dir, "reviews", "action-plan.json"), JSON.stringify({
      version: 2,
      findings: [
        visual("table", { severity: "critical", diagnostic: "The table is clipped." }),
        visual("caption", { diagnostic: "The caption is incomplete." }),
      ],
      actions: [
        { id: "visual-1", finding_ids: ["table"], rationale: "Repair the table.", acceptance_criteria: [{ metric: "tables", target: 5 }] },
        { id: "visual-2", finding_ids: ["caption"], rationale: "Repair the caption.", acceptance_criteria: [{ metric: "figures", target: 3 }] },
      ],
    }));
    await repairAgenticActionPlan(dir);
    const plan = JSON.parse(await fs.readFile(path.join(dir, "reviews", "action-plan.json"), "utf-8"));
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].finding_ids).toEqual(["table", "caption"]);
    expect(plan.actions[0].rationale).toContain("Repair the caption.");
    expect(plan.actions[0].acceptance_criteria).toHaveLength(2);
  });

  it("splits same-capability repairs by objective and scope before dispatch", async () => {
    const dir = await workspace();
    await fs.writeFile(path.join(dir, "reviews", "action-plan.json"), JSON.stringify({
      version: 2,
      findings: [
        corpus("cell-a", { gate_id: "evidence_coverage", objective_scope_key: "taxonomy_cell:a", acceptance_metric: "taxonomy_cell_ab_sources" }),
        corpus("cell-b", { gate_id: "evidence_coverage", objective_scope_key: "taxonomy_cell:b", acceptance_metric: "taxonomy_cell_ab_sources" }),
        corpus("freshness", { gate_id: "research_policy", required_effect: "upgrade_source_quality", acceptance_metric: "recent_source_ratio" }),
      ],
      actions: [{ id: "expand", finding_ids: ["cell-a", "cell-b", "freshness"],
        rationale: "Repair the observed corpus deficits.", acceptance_criteria: [{ metric: "core_sources", target: 1 }] }],
    }));

    await repairAgenticActionPlan(dir);
    const plan = JSON.parse(await fs.readFile(path.join(dir, "reviews", "action-plan.json"), "utf-8"));
    expect(plan.actions).toHaveLength(3);
    expect(plan.actions.map((action: { finding_ids: string[] }) => action.finding_ids))
      .toEqual(expect.arrayContaining([["cell-a"], ["cell-b"], ["freshness"]]));
  });

  it("keeps a routed merged action within the five-criterion contract", async () => {
    const dir = await workspace();
    await fs.writeFile(path.join(dir, "reviews", "action-plan.json"), JSON.stringify({
      version: 2,
      findings: [prose("one"), prose("two")],
      actions: [
        { id: "first", finding_ids: ["one"], rationale: "First.", acceptance_criteria: ["cited_sources", "accepted_cited_ratio", "citations_per_page"].map((metric, index) => ({ metric, target: index + 1 })) },
        { id: "second", finding_ids: ["two"], rationale: "Second.", acceptance_criteria: ["citation_depth_per_section", "taxonomy_cell_ab_sources", "core_sources"].map((metric, index) => ({ metric, target: index + 1 })) },
      ],
    }), "utf-8");
    await repairAgenticActionPlan(dir);
    const plan = JSON.parse(await fs.readFile(path.join(dir, "reviews", "action-plan.json"), "utf-8"));
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].acceptance_criteria.length).toBeLessThanOrEqual(5);
  });

  it("adapts an approved agentic expansion action to the bounded research tool", async () => {
    const root = await workspace();
    const dir = path.join(root, "workspace");
    await runInit(dir, { mode: "auto_research_agentic", topic: "Agent memory", researchProvider: "seed" });
    await fs.writeFile(path.join(dir, "reviews", "action-plan.json"), JSON.stringify({
      version: 2,
      findings: [corpus("coverage", { diagnostic: "Benchmark coverage is thin." })],
      actions: [{ id: "expand-1", finding_ids: ["coverage"], rationale: "Find benchmark sources.", acceptance_criteria: [{ metric: "taxonomy_cell_ab_sources", scope: "benchmarks", target: 2 }] }],
    }));
    await runResearchExpand(dir, { actionPlan: "reviews/action-plan.json" });
    await expect(fs.readFile(path.join(dir, "reports", "research-expansion.md"), "utf-8")).resolves.toContain("seed provider");
  });

  it("preserves taxonomy query groups when generating a recovery search plan", () => {
    const plan = buildExpansionSearchPlan("agent memory", ["agent memory benchmark"], ["memory safety"], {
      version: 1,
      topic: "agent memory",
      query_variants: ["agent memory planning"],
      taxonomy_cells: [{ cell: "memory safety", query_variants: ["agent memory safety", "memory retention risk", "long-term memory safety"] }],
      exclusion_terms: ["medical"],
      venue_priorities: ["ICLR"],
      source_types: ["paper"],
    });
    expect(plan.taxonomy_cells).toHaveLength(1);
    expect(plan.taxonomy_cells[0]?.query_variants).toContain("agent memory safety");
    expect(plan.query_variants).toEqual(expect.arrayContaining(["agent memory planning", "agent memory benchmark"]));
  });

  it("retains measurable deficit details in expansion queries and checkpoint identity", () => {
    const action: ExpansionAction = {
      id: "research_expansion",
      source_action_id: "accepted-memory-capacity",
      weaknesses: [{ category: "critical", detail: "The accepted-source floor is unmet in the memory safety section." }],
      rationale: "Section section-04-memory-safety needs packet-backed published work from systems venues.",
      acceptance_criteria: [
        { metric: "cited_sources", target: 30 },
        { metric: "accepted_cited_ratio", target: 0.8 },
      ],
    };
    const queries = buildExpansionQueries(
      "Agent memory",
      [action],
      ["persistent memory safety", "agent evaluation"],
      ["ICLR", "USENIX Security"],
      24,
    );

    expect(queries).toContain("Agent memory peer reviewed conference journal proceedings");
    expect(queries).toContain("Agent memory persistent memory safety peer reviewed");
    expect(queries).toContain("Agent memory ICLR proceedings");
    expect(queries.some((query) => query.includes("memory safety published systems"))).toBe(true);
    expect(queries).not.toContain("Agent memory");

    const original = expansionIntentKey("Agent memory", [action]);
    const changed = expansionIntentKey("Agent memory", [{ ...action, acceptance_criteria: [{ metric: "accepted_cited_ratio", target: 0.3 }] }]);
    expect(changed).not.toBe(original);
  });

  it("prioritizes exact missing landmark titles ahead of generic recovery queries", () => {
    const action: ExpansionAction = {
      id: "landmark-expansion",
      source_action_id: "landmark_coverage",
      weaknesses: [{ category: "major", detail: "Canonical coverage is incomplete." }],
      rationale: "Retrieve the exact missing canonical works.",
      acceptance_criteria: [{ metric: "landmark_coverage_ratio", operator: "at_least", target: 0.75 }],
    };
    const queries = buildExpansionQueries(
      "Harness engineering",
      [action],
      ["agent optimization"],
      [],
      8,
      ["Promptbreeder: Self-Referential Self-Improvement Via Prompt Evolution", "AFlow"],
    );
    expect(queries.slice(0, 2)).toEqual([
      "Promptbreeder: Self-Referential Self-Improvement Via Prompt Evolution",
      "AFlow",
    ]);
  });

  it("routes citation weaving to revision when deterministic corpus gates already pass", async () => {
    const dir = await workspace();
    await fs.mkdir(path.join(dir, "reports"), { recursive: true });
    await fs.writeFile(path.join(dir, "reports", "corpus-gates.json"), JSON.stringify({ pass: true }), "utf-8");
    await fs.writeFile(path.join(dir, "reviews", "action-plan.json"), JSON.stringify({
      version: 2,
      findings: [prose("coverage", { severity: "critical", diagnostic: "Only 24 sources are cited." })],
      actions: [{ id: "weave", finding_ids: ["coverage"], rationale: "Add citations.", acceptance_criteria: [{ metric: "cited_sources", target: 80 }] }],
    }), "utf-8");
    await splitAgenticActionPlan(dir);
    const research = JSON.parse(await fs.readFile(path.join(dir, "reviews", "research-action-plan.json"), "utf-8"));
    const revision = JSON.parse(await fs.readFile(path.join(dir, "reviews", "revision-action-plan.json"), "utf-8"));
    expect(research.actions).toHaveLength(0);
    // The split writes the KERNEL's dispatch format, where the resolved
    // capability appears as the tool the engine dispatches on.
    expect(revision.actions[0].tool).toBe("revise_sections");
  });

  it("pairs bounded research expansion with the required downstream citation revision", async () => {
    const dir = await workspace();
    await fs.mkdir(path.join(dir, "reports"), { recursive: true });
    await fs.mkdir(path.join(dir, "evidence"), { recursive: true });
    await fs.writeFile(path.join(dir, "reports", "corpus-gates.json"), JSON.stringify({ pass: true }), "utf-8");
    await fs.writeFile(path.join(dir, "longwrite.yaml"), [
      "version: 1",
      "project:",
      "  id: capacity-test",
      "  artifact_type: research_paper",
      "  mode: auto_research_agentic",
      "research:",
      "  release_gates:",
      "    min_cited_sources: 90",
    ].join("\n"), "utf-8");
    await fs.writeFile(path.join(dir, "reviews", "action-plan.json"), JSON.stringify({
      version: 2,
      // The corpus genuinely lacks the sources, so the capability that
      // owns this finding is evidence expansion, not prose weaving.
      findings: [corpus("cited_literature_release_gates", { severity: "critical", diagnostic: "The cited-source target is not met." })],
      actions: [{ id: "expand", finding_ids: ["cited_literature_release_gates"], rationale: "Acquire the missing evidence.", acceptance_criteria: [{ metric: "cited_sources", target: 90 }] }],
    }), "utf-8");

    await splitAgenticActionPlan(dir);
    const research = JSON.parse(await fs.readFile(path.join(dir, "reviews", "research-action-plan.json"), "utf-8"));
    const revision = JSON.parse(await fs.readFile(path.join(dir, "reviews", "revision-action-plan.json"), "utf-8"));
    expect(research.actions.map((action: { tool: string }) => action.tool)).toContain("targeted_research_expansion");
    expect(revision.actions.map((action: { tool: string }) => action.tool)).toContain("revise_sections");
  });

  it("does not reroute an accepted-source-ratio deficit into prose-only work", async () => {
    const dir = await workspace();
    await fs.mkdir(path.join(dir, "reports"), { recursive: true });
    await fs.mkdir(path.join(dir, "evidence"), { recursive: true });
    await fs.mkdir(path.join(dir, "sources"), { recursive: true });
    await fs.writeFile(path.join(dir, "reports", "corpus-gates.json"), JSON.stringify({ pass: true }), "utf-8");
    await fs.writeFile(path.join(dir, "longwrite.yaml"), [
      "version: 1",
      "project:",
      "  id: acceptance-capacity-test",
      "  artifact_type: research_paper",
      "  mode: auto_research_agentic",
      "research:",
      "  release_gates:",
      "    min_cited_sources: 3",
      "    min_accepted_cited_ratio: 0.8",
    ].join("\n"), "utf-8");
    await fs.writeFile(path.join(dir, "evidence", "section-sec-01.json"), JSON.stringify({
      section_id: "sec-01",
      chunks: [{ source_id: "accepted" }, { source_id: "preprint" }],
    }), "utf-8");
    await fs.writeFile(path.join(dir, "sources", "classified_sources.jsonl"), [
      JSON.stringify({ id: "accepted", venue: "Proceedings of TestConf", identifiers: { doi: "10.1/test" }, citation_depth: "B" }),
      JSON.stringify({ id: "preprint", venue: "arXiv", identifiers: { arxiv_id: "1234.5678" }, citation_depth: "B" }),
    ].join("\n"), "utf-8");
    await fs.writeFile(path.join(dir, "reviews", "action-plan.json"), JSON.stringify({
      version: 2,
      // An acquisition finding: a prose-only revision cannot make more
      // cited records accepted.
      findings: [corpus("cited_literature_release_gates", { severity: "critical", diagnostic: "The accepted-source ratio is below the approved target." })],
      actions: [{ id: "expand", finding_ids: ["cited_literature_release_gates"], rationale: "Acquire packet-backed accepted sources.", acceptance_criteria: [{ metric: "accepted_cited_ratio", target: 0.8 }] }],
    }), "utf-8");

    await splitAgenticActionPlan(dir);
    const research = JSON.parse(await fs.readFile(path.join(dir, "reviews", "research-action-plan.json"), "utf-8"));
    const revision = JSON.parse(await fs.readFile(path.join(dir, "reviews", "revision-action-plan.json"), "utf-8"));
    expect(research.actions.map((action: { tool: string }) => action.tool)).toContain("targeted_research_expansion");
    expect(revision.actions.map((action: { tool: string }) => action.tool)).toContain("revise_sections");
  });

  it("requires prose and visual repair for corpus-backed final-release failures", async () => {
    const dir = await workspace();
    await fs.mkdir(path.join(dir, "reports"), { recursive: true });
    await fs.writeFile(path.join(dir, "reports", "corpus-gates.json"), JSON.stringify({ pass: true }), "utf-8");
    await fs.writeFile(path.join(dir, "reviews", "action-plan.json"), JSON.stringify({
      version: 2,
      findings: [
        corpus("citation_evidence_ledger", { diagnostic: "Cited claims lack packet locators." }),
        visual("rendered_visual_review", {
          gate_id: "figure_references", required_effect: "repair_artifact_placement",
          acceptance_metric: null,
          diagnostic: "The comparison table is clipped in the rendered PDF.",
        }),
      ],
      actions: [{
        id: "expand", finding_ids: ["citation_evidence_ledger"], rationale: "Find more evidence.",
        acceptance_criteria: [{ metric: "citations_per_page", target: 3 }],
      }],
    }), "utf-8");

    await splitAgenticActionPlan(dir);
    const research = JSON.parse(await fs.readFile(path.join(dir, "reviews", "research-action-plan.json"), "utf-8"));
    const revision = JSON.parse(await fs.readFile(path.join(dir, "reviews", "revision-action-plan.json"), "utf-8"));

    expect(research.actions).toHaveLength(0);
    expect(revision.actions.map((action: { tool: string }) => action.tool))
      .toEqual(expect.arrayContaining(["revise_sections", "revise_visual_plan"]));
  });

  it("injects visual repair from the deterministic release report even when the planner omits it", async () => {
    const dir = await workspace();
    await fs.mkdir(path.join(dir, "reports"), { recursive: true });
    await fs.writeFile(path.join(dir, "reports", "corpus-gates.json"), JSON.stringify({ pass: true }), "utf-8");
    // A real release report carries the producer's structured findings; the
    // injection reads those rather than inferring a repair from a gate id.
    await fs.writeFile(path.join(dir, "reports", "release-gates.json"), JSON.stringify({
      gates: [{
        id: "rendered_visual_review", pass: false,
        findings: [visual("clipped-table", {
          gate_id: "figure_references", required_effect: "repair_artifact_placement",
          acceptance_metric: null, diagnostic: "The comparison table is clipped in the rendered PDF.",
        })],
      }],
    }), "utf-8");
    await fs.writeFile(path.join(dir, "reviews", "action-plan.json"), JSON.stringify({
      version: 2,
      findings: [prose("writing", { diagnostic: "Tighten the prose." })],
      actions: [{ id: "revise", finding_ids: ["writing"], rationale: "Tighten the prose.", acceptance_criteria: [{ metric: "cited_sources", target: 1 }] }],
    }), "utf-8");

    await splitAgenticActionPlan(dir);
    const revision = JSON.parse(await fs.readFile(path.join(dir, "reviews", "revision-action-plan.json"), "utf-8"));
    expect(revision.actions.map((action: { tool: string }) => action.tool)).toContain("revise_visual_plan");
  });

  it("writes a concrete operator request without allowing the plan to guess", async () => {
    const dir = await workspace();
    await fs.writeFile(path.join(dir, "reviews", "action-plan.json"), JSON.stringify({
      version: 2,
      findings: [operator("venue", { diagnostic: "The publication target and anonymity rules conflict." })],
      actions: [{ id: "ask", finding_ids: ["venue"], rationale: "Should this manuscript target an anonymous venue submission or a named arXiv release?", acceptance_criteria: [{ metric: "tables", target: 0 }] }],
    }));
    await writeOperatorClarificationRequest(dir);
    await expect(fs.readFile(path.join(dir, "reviews", "clarification-request.md"), "utf-8")).resolves.toContain("anonymous venue submission");
  });
});
