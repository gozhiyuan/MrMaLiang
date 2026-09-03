import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { buildEnvelope } from "../src/lib/registry/evaluate.js";
import { metricId } from "../src/lib/registry/ids.js";
import { MANUSCRIPT_EVALUATORS } from "../src/lib/registry/evaluators/manuscript.js";
import { CORPUS_EVALUATORS } from "../src/lib/registry/evaluators/corpus.js";
import { sectionDepthScope, scopeKey } from "../src/lib/registry/scope.js";
import { validateResearchWorkspace } from "../src/lib/validation/research.js";
import { pdfPageCount } from "../src/lib/registry/evaluators/manuscript.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});
const AS_OF = "2026-09-01T00:00:00.000Z";

async function workspace(over: Record<string, unknown> = {}, chapters: Record<string, string> = {}): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-c3-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "sources"), { recursive: true });
  await fs.mkdir(path.join(ws, "chapters"), { recursive: true });
  await fs.writeFile(path.join(ws, "longwrite.yaml"), stringify({
    version: 1, project: { id: "s", artifact_type: "research_paper", mode: "auto_research_agentic" },
    research: {
      provider: "multi", topic: "t", taxonomy: ["memory"],
      release_gates: {
        min_cited_sources: 0, min_citations_per_page: 0, min_cited_within_one_year_ratio: 0,
        min_accepted_cited_ratio: 0, max_cited_arxiv_only_ratio: 1,
        min_citation_depths_per_section: { A: 2, B: 1, C: 0 },
        min_cited_ab_sources_per_taxonomy_cell: 3, ...over,
      },
    },
  }), "utf-8");
  await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"),
    JSON.stringify({ id: "a1", citation_depth: "A", source: "arxiv", title: "Agent memory", abstract: "memory",
      year: 2025, venue: "arXiv", authors: ["Ada Lovelace"], identifiers: { arxiv_id: "2401.1" } }), "utf-8");
  for (const [name, body] of Object.entries({ "section-01.md": "[source:a1:p1]\n", ...chapters })) {
    await fs.writeFile(path.join(ws, "chapters", name), body, "utf-8");
  }
  return ws;
}

describe("scoped criterion targets", () => {
  it("carries the configured per-depth target on each section-depth observation", async () => {
    const ws = await workspace();
    const values = await MANUSCRIPT_EVALUATORS.citation_depth_per_section({ workspaceDir: ws, asOfDate: AS_OF });
    const a = values.find((v) => v.scope_key === sectionDepthScope("section-01", "A"))!;
    const b = values.find((v) => v.scope_key === sectionDepthScope("section-01", "B"))!;
    // A, B and C have different configured minima, so one metric-wide target
    // cannot serve them; the target travels with the scope.
    expect(a.target).toBe(2);
    expect(b.target).toBe(1);
    expect(a.operator).toBe("at_least");
  });

  it("carries the cited-taxonomy target on each cell observation", async () => {
    const ws = await workspace();
    const values = await CORPUS_EVALUATORS.cited_taxonomy_cell_ab_sources({ workspaceDir: ws, asOfDate: AS_OF });
    expect(values.find((v) => v.scope_key === scopeKey("taxonomy_cell", "memory"))?.target).toBe(3);
  });

  it("compiles the scoped target onto the envelope entry", async () => {
    const ws = await workspace();
    const envelope = await buildEnvelope(ws, { metrics: [metricId("citation_depth_per_section")], asOfDate: AS_OF });
    const a = envelope.measurements.find((m) => m.scope_key === sectionDepthScope("section-01", "A"))!;
    expect(a.target).toBe(2);
    expect(a.operator).toBe("at_least");
  });

  it("leaves no scoped entry without a target for materialization to trust", async () => {
    const ws = await workspace();
    const envelope = await buildEnvelope(ws, { tier: "round", asOfDate: AS_OF });
    const scoped = envelope.measurements.filter((m) => m.scope_key !== "" && m.status === "measured");
    expect(scoped.length).toBeGreaterThan(0);
    for (const entry of scoped) {
      expect(entry.target, `${entry.metric}/${entry.scope_key}`).toBeTypeOf("number");
      expect(entry.operator, `${entry.metric}/${entry.scope_key}`).toBeTruthy();
    }
  });
});

describe("pdf page count failure categories", () => {
  /** A runner that fails the way a real one would, so each branch is exercised
   * on any machine rather than only where Poppler happens to be installed. */
  const failing = (code: string) => async () => {
    const error: NodeJS.ErrnoException = new Error(`pdfinfo ${code}`);
    error.code = code;
    throw error;
  };

  it("reports a build that has not run, before ever invoking the tool", async () => {
    const ws = await workspace();
    let invoked = false;
    const result = await pdfPageCount(ws, async () => { invoked = true; return ""; });
    expect(result.kind).toBe("not_built");
    // No point asking a tool about a file that is not there.
    expect(invoked).toBe(false);
  });

  it("classifies each tool failure distinctly", async () => {
    const ws = await workspace();
    await fs.mkdir(path.join(ws, "build"), { recursive: true });
    await fs.writeFile(path.join(ws, "build", "manuscript.pdf"), "not a pdf\n", "utf-8");
    expect((await pdfPageCount(ws, failing("ENOENT"))).kind).toBe("missing_tool");
    expect((await pdfPageCount(ws, failing("ETIMEDOUT"))).kind).toBe("error");
    // pdfinfo ran and refused the file: the PDF itself is the problem.
    expect((await pdfPageCount(ws, failing("EXIT1"))).kind).toBe("invalid");
    // Ran fine but said nothing useful.
    expect((await pdfPageCount(ws, async () => "Title: x\n")).kind).toBe("invalid");
    expect(await pdfPageCount(ws, async () => "Pages:  12\n")).toEqual({ kind: "ok", pages: 12 });
  });

  it("does not ask an operator to fix a build that has not run yet", async () => {
    const ws = await workspace({ min_citations_per_page: 3 });
    const check = (await validateResearchWorkspace(ws, AS_OF)).checks
      .find((c) => String(c.id) === "cited_literature_release_gates")!;
    const toolchain = check.findings.filter((f) => f.artifact.kind === "toolchain");
    // manuscript_build already owns "the PDF is missing"; re-reporting it here
    // as an operator problem would pause a run that can rebuild itself.
    expect(toolchain).toEqual([]);
    expect(check.diagnostic).toMatch(/not been rendered|has not run|build/i);
  });
});

describe("citation capacity policy", () => {
  it("says only what it checked", async () => {
    const ws = await workspace({ min_cited_sources: 5 });
    const check = (await validateResearchWorkspace(ws, AS_OF)).checks
      .find((c) => String(c.id) === "cited_literature_release_gates")!;
    const finding = check.findings.find((f) => f.acceptance_metric === "cited_sources");
    // One uncited source does not "satisfy" a shortfall of four. The
    // diagnostic must not promise more than the check established.
    expect(finding?.diagnostic ?? "").not.toMatch(/would satisfy this/);
  });

  it("routes to prose when enough uncited evidence exists to close the gap", async () => {
    const ws = await workspace({ min_cited_sources: 2 });
    await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"), [
      { id: "a1", citation_depth: "A", source: "arxiv", title: "Agent memory", abstract: "memory", year: 2025, venue: "arXiv", authors: ["A"], identifiers: {} },
      { id: "a2", citation_depth: "A", source: "arxiv", title: "More memory", abstract: "memory", year: 2025, venue: "arXiv", authors: ["B"], identifiers: {} },
    ].map((s) => JSON.stringify(s)).join("\n"), "utf-8");
    const check = (await validateResearchWorkspace(ws, AS_OF)).checks
      .find((c) => String(c.id) === "cited_literature_release_gates")!;
    const finding = check.findings.find((f) => f.acceptance_metric === "cited_sources");
    expect(finding?.artifact.kind).toBe("chapter_prose");
  });
});

describe("an unmeasured gate never passes", () => {
  it("does not report pass when a configured requirement was never measured", async () => {
    const ws = await workspace({ min_citations_per_page: 40 });
    const check = (await validateResearchWorkspace(ws, AS_OF)).checks
      .find((c) => String(c.id) === "cited_literature_release_gates")!;
    // Unknown is not satisfied. A configured density of 99 with no rendered
    // PDF must never read as a met contract.
    expect(check.pass).toBe(false);
    // Nothing here is repairable by editing an artifact, so it asks for
    // diagnosis rather than inventing a finding.
    expect(check.requires_diagnosis).toBe(true);
    expect(check.diagnostic).toMatch(/not measured|not been rendered/i);
  });

  it("still passes when the unmeasured gate was not configured", async () => {
    const ws = await workspace({ min_citations_per_page: 0 });
    const check = (await validateResearchWorkspace(ws, AS_OF)).checks
      .find((c) => String(c.id) === "cited_literature_release_gates")!;
    expect(check.requires_diagnosis).toBe(false);
  });
});

describe("corrupt PDF attribution", () => {
  it("does not blame figure placement for an unclassified bad PDF", async () => {
    const ws = await workspace({ min_citations_per_page: 3 });
    await fs.mkdir(path.join(ws, "build"), { recursive: true });
    await fs.writeFile(path.join(ws, "build", "manuscript.pdf"), "not a pdf at all\n", "utf-8");
    const check = (await validateResearchWorkspace(ws, AS_OF)).checks
      .find((c) => String(c.id) === "cited_literature_release_gates")!;
    // Malformed TeX, a broken template or a bibliography fault produce the
    // same symptom; naming the placement plan asserts a cause nobody measured.
    expect(check.findings.some((f) => f.artifact.kind === "figure_spec")).toBe(false);
    expect(check.pass).toBe(false);
    expect(check.requires_diagnosis).toBe(true);
  });
});

describe("filesystem errors are not a missing build", () => {
  it("reports an unreadable build directory as an error, not as not_built", async () => {
    const ws = await workspace();
    const build = path.join(ws, "build");
    await fs.mkdir(build, { recursive: true });
    await fs.writeFile(path.join(build, "manuscript.pdf"), "%PDF-1.4\n", "utf-8");
    await fs.chmod(build, 0o000);
    try {
      const result = await pdfPageCount(ws);
      // On a permission failure the honest answer is "we could not look",
      // which is a measurement error rather than a stage that has not run.
      if (result.kind !== "ok") expect(result.kind).not.toBe("not_built");
    } finally {
      await fs.chmod(build, 0o755);
    }
  });
});
