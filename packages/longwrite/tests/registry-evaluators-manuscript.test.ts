import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { MeasurementUnavailable } from "../src/lib/registry/evaluators/corpus.js";
import { MANUSCRIPT_EVALUATORS } from "../src/lib/registry/evaluators/manuscript.js";
import { ARTIFACT_EVALUATORS } from "../src/lib/registry/evaluators/artifacts.js";
import { sectionDepthScope } from "../src/lib/registry/scope.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});
const AS_OF = "2026-09-01T00:00:00.000Z";
const ctx = (workspaceDir: string) => ({ workspaceDir, asOfDate: AS_OF });
const only = (values: Array<{ scope_key: string; value: number }>) => {
  expect(values).toHaveLength(1);
  expect(values[0].scope_key).toBe("");
  return values[0].value;
};

type Fixture = {
  chapters?: Record<string, string>;
  sources?: unknown[];
  manifest?: unknown;
  files?: Record<string, string>;
};

async function workspace(fixture: Fixture = {}): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-eval-ms-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "chapters"), { recursive: true });
  await fs.mkdir(path.join(ws, "sources"), { recursive: true });
  await fs.writeFile(path.join(ws, "longwrite.yaml"), stringify({
    version: 1, project: { id: "s", artifact_type: "research_paper", mode: "auto_research_agentic" },
    research: { provider: "seed", topic: "t" },
  }), "utf-8");
  await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"),
    (fixture.sources ?? []).map((s) => JSON.stringify(s)).join("\n"), "utf-8");
  for (const [name, body] of Object.entries(fixture.chapters ?? {})) {
    await fs.writeFile(path.join(ws, "chapters", name), body, "utf-8");
  }
  if (fixture.manifest !== undefined) {
    await fs.mkdir(path.join(ws, "figures"), { recursive: true });
    await fs.writeFile(path.join(ws, "figures", "manifest.json"),
      JSON.stringify(fixture.manifest), "utf-8");
  }
  for (const [rel, body] of Object.entries(fixture.files ?? {})) {
    await fs.mkdir(path.join(ws, path.dirname(rel)), { recursive: true });
    await fs.writeFile(path.join(ws, rel), body, "utf-8");
  }
  return ws;
}

const figure = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: id, caption: id, insight: "", path: `figures/${id}.svg`,
  latex_path: `paper/figures/${id}.tex`, backend: "deterministic-svg",
  placement: { section_id: "section-01", discussion: "discussed in prose" },
  data: [], ...over,
});
const table = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: id, caption: id, insight: "", path: `figures/${id}.md`,
  latex_path: `paper/tables/${id}.tex`, backend: "deterministic-markdown",
  placement: { section_id: "section-01", discussion: "discussed in prose" },
  layout: "table", comparative: false, data: [], ...over,
});

describe("manuscript evaluators", () => {
  it("emits one citation-depth entry per section, never an aggregate", async () => {
    const ws = await workspace({
      sources: [{ id: "a", citation_depth: "A" }],
      chapters: { "section-03.md": "[source:a:p1]\n", "section-06.md": "" },
    });
    const values = await MANUSCRIPT_EVALUATORS.citation_depth_per_section(ctx(ws));
    const by = Object.fromEntries(values.map((v) => [v.scope_key, v.value]));
    // Aggregating hides which section is short, and lets a repair in one
    // section appear to satisfy another. Depth is part of the scope too,
    // because the gate reads a separate minimum for A, B and C.
    expect(by[sectionDepthScope("section-03", "A")]).toBe(1);
    expect(by[sectionDepthScope("section-03", "B")]).toBe(0);
    expect(by[sectionDepthScope("section-06", "A")]).toBe(0);
    expect(values).toHaveLength(6);
  });

  it("fails the measurement when a required build artifact is absent", async () => {
    const ws = await workspace({ chapters: { "section-01.md": "text\n" } });
    await expect(MANUSCRIPT_EVALUATORS.citations_per_page(ctx(ws))).rejects.toThrow(MeasurementUnavailable);
  });

  it("reports a boolean gate status as zero or one", async () => {
    const broken = await workspace({ chapters: { "section-01.md": "[source:ghost:p1]\n" } });
    expect(only(await MANUSCRIPT_EVALUATORS.citation_verification_status(ctx(broken)))).toBe(0);
    const sound = await workspace({
      sources: [{ id: "a", citation_depth: "A" }], chapters: { "section-01.md": "[source:a:p1]\n" },
    });
    expect(only(await MANUSCRIPT_EVALUATORS.citation_verification_status(ctx(sound)))).toBe(1);
  });

  it("scores prose redundancy as a ratio of repeated to total words", async () => {
    const clean = await workspace({ chapters: { "a.md": "Distinct sentences carry separate ideas here.\n" } });
    const repetitive = await workspace({
      chapters: {
        "a.md": "not specified in packet. not specified in packet. not specified in packet.\n",
        "b.md": "not specified in packet. not specified in packet.\n",
      },
    });
    expect(only(await MANUSCRIPT_EVALUATORS.prose_redundancy(ctx(repetitive))))
      .toBeGreaterThan(only(await MANUSCRIPT_EVALUATORS.prose_redundancy(ctx(clean))));
  });

  it("counts contradictions from recorded claim judgments", async () => {
    const ws = await workspace({
      chapters: { "a.md": "x\n" },
      files: {
        "reviews/claim-judgments.jsonl": [
          JSON.stringify({ sample_id: "c1", reviewer_id: "a", source_id: "s1", claim: "fast", chapter: "a.md", subject_key: "latency", verdict: "supported", polarity: "affirms" }),
          JSON.stringify({ sample_id: "c2", reviewer_id: "b", source_id: "s1", claim: "fast", chapter: "b.md", subject_key: "latency", verdict: "supported", polarity: "denies" }),
        ].join("\n"),
      },
    });
    expect(only(await MANUSCRIPT_EVALUATORS.claim_contradictions(ctx(ws)))).toBeGreaterThan(0);
  });

  it("treats an absent landmark candidate set as unavailable, not as zero coverage", async () => {
    // Zero coverage is a claim that landmarks were sought and missed.
    const ws = await workspace({ sources: [{ id: "a", citation_depth: "A" }] });
    await expect(MANUSCRIPT_EVALUATORS.landmark_coverage_ratio(ctx(ws)))
      .rejects.toThrow(MeasurementUnavailable);
  });

  it("measures landmark coverage against A and B evidence only", async () => {
    const ws = await workspace({
      sources: [
        { id: "a", citation_depth: "A", title: "Attention Is All You Need", identifiers: {} },
        { id: "b", citation_depth: "C", title: "Deep Residual Learning", identifiers: {} },
      ],
      chapters: { "a.md": "[source:a:p1]\n" },
      files: {
        "research/landmark-candidates.json": JSON.stringify({
          version: 1,
          candidates: [
            { name: "Attention Is All You Need", confidence: "high",
              why_canonical: "introduced the transformer architecture this survey builds on" },
            { name: "Deep Residual Learning", confidence: "high",
              why_canonical: "introduced residual connections used throughout the compared systems" },
          ],
        }),
      },
    });
    // Only the A-depth match counts; the C-depth record is not evidence.
    expect(only(await MANUSCRIPT_EVALUATORS.landmark_coverage_ratio(ctx(ws)))).toBeCloseTo(0.5, 5);
    expect(only(await MANUSCRIPT_EVALUATORS.landmark_citation_coverage_ratio(ctx(ws)))).toBeCloseTo(0.5, 5);
  });

  it("scores outline readiness from the recorded outline review", async () => {
    const ws = await workspace({ files: { "outline.md": "# Outline\n\n## One\n" } });
    expect(only(await MANUSCRIPT_EVALUATORS.outline_readiness(ctx(ws)))).toBeGreaterThanOrEqual(0);
  });
});

describe("artifact evaluators", () => {
  it("counts figures and tables from the manifest", async () => {
    const ws = await workspace({ manifest: { version: 1, figures: [figure("f1"), figure("f2")], tables: [table("t1")] } });
    expect(only(await ARTIFACT_EVALUATORS.figures(ctx(ws)))).toBe(2);
    expect(only(await ARTIFACT_EVALUATORS.tables(ctx(ws)))).toBe(1);
  });

  it("counts only tables flagged comparative", async () => {
    const ws = await workspace({ manifest: {
      version: 1, figures: [], tables: [table("t1", { comparative: true }), table("t2")],
    } });
    expect(only(await ARTIFACT_EVALUATORS.comparative_tables(ctx(ws)))).toBe(1);
  });

  it("counts only plots whose data came from verified provenance", async () => {
    const ws = await workspace({ manifest: { version: 1, tables: [], figures: [
      figure("p1", { backend: "python", provenance: { source_kind: "longexperiment", source_path: "x", sha256: "a".repeat(64) } }),
      figure("p2", { backend: "python" }),
    ] } });
    expect(only(await ARTIFACT_EVALUATORS.verified_metadata_plots(ctx(ws)))).toBe(1);
  });

  it("fails rather than reporting zero when the manifest is absent", async () => {
    const ws = await workspace();
    await expect(ARTIFACT_EVALUATORS.figures(ctx(ws))).rejects.toThrow(MeasurementUnavailable);
  });

  it("measures diagram connectivity as the share of connected nodes", async () => {
    const ws = await workspace({ files: {
      "figures/concept-map.mmd": "graph TD\n  a[A]\n  b[B]\n  c[C]\n  a --> b\n",
    } });
    // a and b are connected, c is stranded.
    expect(only(await ARTIFACT_EVALUATORS.diagram_connectivity(ctx(ws)))).toBeCloseTo(2 / 3, 5);
  });

  it("counts recorded empirical trials", async () => {
    const ws = await workspace({ files: {
      "evidence/experiment-packets.json": JSON.stringify({ trials: [{ id: "t1" }, { id: "t2" }] }),
    } });
    expect(only(await ARTIFACT_EVALUATORS.empirical_trials(ctx(ws)))).toBe(2);
  });
});
