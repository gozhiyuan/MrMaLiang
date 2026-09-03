import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { buildEnvelope } from "../src/lib/registry/evaluate.js";
import { metricId } from "../src/lib/registry/ids.js";
import { METRIC_REGISTRY, metricDefinition } from "../src/lib/registry/metrics.js";
import { MANUSCRIPT_EVALUATORS } from "../src/lib/registry/evaluators/manuscript.js";
import { CORPUS_EVALUATORS } from "../src/lib/registry/evaluators/corpus.js";
import { sectionDepthScope, scopeKey } from "../src/lib/registry/scope.js";
import { validateResearchWorkspace } from "../src/lib/validation/research.js";
import { isRecentSource } from "../src/lib/research/corpus-gates.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});
const AS_OF = "2026-09-01T00:00:00.000Z";

async function scratch(prefix: string): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), `longwrite-${prefix}-`));
  roots.push(ws);
  return ws;
}

type Source = Record<string, unknown>;
async function citedWorkspace(sources: Source[], chapters: Record<string, string>, gates: Record<string, unknown> = {}): Promise<string> {
  const ws = await scratch("cited2");
  await fs.mkdir(path.join(ws, "sources"), { recursive: true });
  await fs.mkdir(path.join(ws, "chapters"), { recursive: true });
  await fs.writeFile(path.join(ws, "longwrite.yaml"), stringify({
    version: 1, project: { id: "s", artifact_type: "research_paper", mode: "auto_research_agentic" },
    research: {
      provider: "multi", topic: "t", taxonomy: [],
      release_gates: {
        min_cited_sources: 0, min_citations_per_page: 0, min_cited_within_one_year_ratio: 0,
        min_accepted_cited_ratio: 0, max_cited_arxiv_only_ratio: 1,
        min_citation_depths_per_section: { A: 0, B: 0, C: 0 },
        min_cited_ab_sources_per_taxonomy_cell: 0, ...gates,
      },
    },
  }), "utf-8");
  await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"),
    sources.map((s) => JSON.stringify(s)).join("\n"), "utf-8");
  for (const [name, body] of Object.entries(chapters)) {
    await fs.writeFile(path.join(ws, "chapters", name), body, "utf-8");
  }
  return ws;
}
const source = (id: string, depth: string, over: Source = {}): Source => ({
  id, citation_depth: depth, source: "arxiv", title: `T-${id}`, abstract: "a", year: 2025,
  venue: "arXiv", authors: ["Ada Lovelace"], identifiers: { arxiv_id: `2401.${id}` }, ...over,
});
const findingsOf = async (ws: string, gate: string) =>
  (await validateResearchWorkspace(ws, AS_OF)).checks.find((c) => String(c.id) === gate)?.findings ?? [];

describe("external measurement deferral", () => {
  it("marks an external metric deferred instead of throwing on a missing toolchain digest", async () => {
    const ws = await scratch("external-deferred");
    const envelope = await buildEnvelope(ws, { metrics: [metricId("latex_build_status")], asOfDate: AS_OF });
    expect(envelope.measurements[0].status).toBe("deferred");
  });

  it("keeps a deferred external identity distinct from a real one", async () => {
    const ws = await scratch("external-identity");
    const { computeInputDigest } = await import("../src/lib/registry/digests.js");
    const deferred = (await buildEnvelope(ws, { metrics: [metricId("latex_build_status")], asOfDate: AS_OF }))
      .measurements[0].input_digest;
    const real = await computeInputDigest(ws, metricDefinition(metricId("latex_build_status")),
      { asOfDate: AS_OF, toolchainDigest: "f".repeat(64) });
    expect(deferred).not.toBe(real);
  });

  it("still emits every tier entry rather than failing the whole envelope", async () => {
    const ws = await scratch("external-tier");
    const envelope = await buildEnvelope(ws, { tier: "round", asOfDate: AS_OF });
    expect(envelope.measurements.length).toBeGreaterThan(0);
  });
});

describe("citation depth observation", () => {
  it("distinguishes depth mixes that share a total", async () => {
    // A=0,B=4 and A=2,B=2 both have four cited sources. A metric that reports
    // only the total cannot tell a repair which depth is short.
    const chapters = { "section-01.md": "[source:a1:p1] [source:a2:p2] [source:b1:p3] [source:b2:p4]\n" };
    const mixed = await citedWorkspace(
      [source("a1", "A"), source("a2", "A"), source("b1", "B"), source("b2", "B")], chapters);
    const shallow = await citedWorkspace(
      [source("a1", "B"), source("a2", "B"), source("b1", "B"), source("b2", "B")], chapters);
    const depthA = async (ws: string) => (await MANUSCRIPT_EVALUATORS.citation_depth_per_section({ workspaceDir: ws, asOfDate: AS_OF }))
      .find((entry) => entry.scope_key === sectionDepthScope("section-01", "A"))?.value;
    expect(await depthA(mixed)).toBe(2);
    expect(await depthA(shallow)).toBe(0);
  });

  it("scopes the finding the same way the evaluator scopes the observation", async () => {
    const ws = await citedWorkspace([source("b1", "B")], { "section-01.md": "[source:b1:p1]\n" },
      { min_citation_depths_per_section: { A: 1, B: 0, C: 0 } });
    const finding = (await findingsOf(ws, "cited_literature_release_gates"))
      .find((f) => f.acceptance_metric === "citation_depth_per_section");
    // A global finding against a section-scoped observation can never be
    // matched to the measurement that would satisfy it.
    expect(finding?.objective_scope_key).toBe(sectionDepthScope("section-01", "A"));
  });

  it("declares the metric as depth-scoped", () => {
    expect(metricDefinition(metricId("citation_depth_per_section")).scope_kind).toBe("section_depth");
  });
});

describe("cited taxonomy coverage", () => {
  it("registers a metric that prose can actually move", () => {
    const definition = metricDefinition(metricId("cited_taxonomy_cell_ab_sources"));
    // The corpus-availability metric depends only on sources and config, so a
    // revise_sections action could never change it.
    expect(definition.dependencies.some((d) => d.startsWith("chapters/"))).toBe(true);
    expect(definition.dependencies).toContain("longwrite.yaml");
  });

  it("counts only cells whose A/B sources are cited in prose", async () => {
    const ws = await citedWorkspace(
      [source("m1", "A", { title: "Agent memory", abstract: "memory" }),
       source("m2", "A", { title: "Episodic memory", abstract: "memory" })],
      { "section-01.md": "[source:m1:p1]\n" });
    await fs.writeFile(path.join(ws, "longwrite.yaml"), stringify({
      version: 1, project: { id: "s", artifact_type: "research_paper", mode: "auto_research_agentic" },
      research: { provider: "multi", topic: "t", taxonomy: ["memory"] },
    }), "utf-8");
    const cited = await CORPUS_EVALUATORS.cited_taxonomy_cell_ab_sources({ workspaceDir: ws, asOfDate: AS_OF });
    const available = await CORPUS_EVALUATORS.taxonomy_cell_ab_sources({ workspaceDir: ws, asOfDate: AS_OF });
    expect(cited.find((e) => e.scope_key === scopeKey("taxonomy_cell", "memory"))?.value).toBe(1);
    expect(available.find((e) => e.scope_key === scopeKey("taxonomy_cell", "memory"))?.value).toBe(2);
  });

  it("binds the woven-coverage finding to the cited metric", async () => {
    const ws = await citedWorkspace(
      [source("m1", "A", { title: "Agent memory", abstract: "memory" })], { "section-01.md": "no markers\n" },
      { min_cited_ab_sources_per_taxonomy_cell: 1 });
    await fs.writeFile(path.join(ws, "longwrite.yaml"), stringify({
      version: 1, project: { id: "s", artifact_type: "research_paper", mode: "auto_research_agentic" },
      research: { provider: "multi", topic: "t", taxonomy: ["memory"],
        release_gates: { min_cited_sources: 0, min_citations_per_page: 0, min_cited_within_one_year_ratio: 0,
          min_accepted_cited_ratio: 0, max_cited_arxiv_only_ratio: 1,
          min_citation_depths_per_section: { A: 0, B: 0, C: 0 }, min_cited_ab_sources_per_taxonomy_cell: 1 } },
    }), "utf-8");
    const finding = (await findingsOf(ws, "cited_literature_release_gates"))
      .find((f) => f.id.includes("cell-"));
    expect(finding?.acceptance_metric).toBe("cited_taxonomy_cell_ab_sources");
  });
});

describe("routes select actions that can move their metric", () => {
  it("asks prose to cite evidence the corpus already holds", async () => {
    // Four uncited A-depth sources: adding more would not change what is cited.
    const ws = await citedWorkspace(
      [source("a1", "A"), source("a2", "A"), source("a3", "A"), source("c1", "C")],
      { "section-01.md": "[source:c1:p1]\n" }, { min_cited_sources: 3 });
    const finding = (await findingsOf(ws, "cited_literature_release_gates"))
      .find((f) => f.acceptance_metric === "cited_sources");
    expect(finding?.artifact.kind).toBe("chapter_prose");
    expect(finding?.required_effect).toBe("add_supporting_citation");
  });

  it("asks for retrieval when the corpus holds nothing better", async () => {
    const ws = await citedWorkspace(
      [source("c1", "C")], { "section-01.md": "[source:c1:p1]\n" }, { min_cited_sources: 3 });
    const finding = (await findingsOf(ws, "cited_literature_release_gates"))
      .find((f) => f.acceptance_metric === "cited_sources");
    expect(finding?.artifact.kind).toBe("corpus");
  });

  it("treats an unreadable PDF as a build concern, not a citation shortfall", async () => {
    const ws = await citedWorkspace([source("a1", "A")], { "section-01.md": "[source:a1:p1]\n" },
      { min_citations_per_page: 3 });
    const findings = await findingsOf(ws, "cited_literature_release_gates");
    // Adding citations cannot fix a manuscript that was never rendered — and
    // neither can an operator, when the build stage simply has not run yet.
    expect(findings.some((f) => f.acceptance_metric === "citations_per_page")).toBe(false);
    expect(findings.some((f) => f.artifact.kind === "toolchain")).toBe(false);
  });
});

describe("recency window", () => {
  it("uses the one-calendar-year window the plan specifies", () => {
    const asOf = "2026-09-01T00:00:00.000Z";
    expect(isRecentSource({ year: 2026 } as never, asOf)).toBe(true);
    expect(isRecentSource({ year: 2025 } as never, asOf)).toBe(true);
    // Two years back was the old implementation window and is not what the
    // frozen plan or the metric's own boundary tests describe.
    expect(isRecentSource({ year: 2024 } as never, asOf)).toBe(false);
  });

  it("agrees with the cited-recency helper on the same boundary", async () => {
    const { isWithinOneCalendarYear } = await import("../src/lib/validation/research.js");
    for (const year of [2024, 2025, 2026, 2027]) {
      expect(isRecentSource({ year } as never, "2026-09-01T00:00:00.000Z"))
        .toBe(isWithinOneCalendarYear({ year } as never, "2026-09-01T00:00:00.000Z"));
    }
  });
});

describe("registry completeness", () => {
  it("registers an evaluator for the new cited-taxonomy metric", () => {
    expect(METRIC_REGISTRY.has(metricId("cited_taxonomy_cell_ab_sources"))).toBe(true);
  });
});
