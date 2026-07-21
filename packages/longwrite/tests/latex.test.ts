import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildLatexWorkspace } from "../src/lib/writing/latex.js";
import { validateLatexWorkspace } from "../src/lib/validation/latex.js";

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-latex-"));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, "chapters"), { recursive: true });
  await fs.mkdir(path.join(dir, "sources"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "chapters", "section-1.md"),
    "# Background\n\nAgents need grounded memory [source:source-1].\n",
    "utf-8",
  );
  await fs.writeFile(
    path.join(dir, "sources", "bibliography.bib"),
    "@misc{source1,\n  title = {Grounded Memory}\n}\n",
    "utf-8",
  );
  await fs.writeFile(
    path.join(dir, "longwrite.yaml"),
    "version: 1\nproject:\n  id: paper\n  name: Grounded Agent Memory\n  artifact_type: research_paper\n  mode: auto_research_agentic\n  authors:\n    - name: Ada Lovelace\n      email: ada@example.com\n",
    "utf-8",
  );
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

// Keep these unit tests deterministic and fast; real compilation is covered
// in latex-compile.test.ts.
let previousEngine: string | undefined;
beforeAll(() => {
  previousEngine = process.env.LONGWRITE_LATEX_ENGINE;
  process.env.LONGWRITE_LATEX_ENGINE = "none";
});
afterAll(() => {
  if (previousEngine === undefined) delete process.env.LONGWRITE_LATEX_ENGINE;
  else process.env.LONGWRITE_LATEX_ENGINE = previousEngine;
});

describe("LaTeX manuscript build", () => {
  it("builds deterministic LaTeX sources and validates them", async () => {
    const ws = await makeWorkspace();
    const written = await buildLatexWorkspace(ws);
    expect(written).toEqual(expect.arrayContaining([
      "paper/main.tex",
      "paper/references.bib",
      "paper/sections/section-1.tex",
      "build/manuscript.tex",
      "build/manuscript.pdf",
    ]));
    const main = await fs.readFile(path.join(ws, "paper", "main.tex"), "utf-8");
    expect(main).toContain("\\title{Grounded Agent Memory}");
    expect(main).toContain("Ada Lovelace");
    expect(main).toContain("\\texttt{ada@example.com}");
    expect(main).toContain("\\input{sections/section-1.tex}");
    expect(main).toContain("\\hypersetup{hidelinks}");
    expect(main).not.toContain("\\tableofcontents");
    expect(main).toContain("\\bibliography{references}");
    const report = await validateLatexWorkspace(ws);
    expect(report.pass).toBe(true);
  });

  it("keeps a DOI or URL visible with the portable plain bibliography style", async () => {
    const ws = await makeWorkspace();
    await fs.writeFile(
      path.join(ws, "sources", "bibliography.bib"),
      "@article{source1,\n  title = {Grounded Memory},\n  doi = {10.1000/example}\n}\n",
      "utf-8",
    );
    await buildLatexWorkspace(ws);
    const bibliography = await fs.readFile(path.join(ws, "paper", "references.bib"), "utf-8");
    expect(bibliography).toContain("note = {DOI: \\url{https://doi.org/10.1000/example}}");
  });

  it("renders pinned codebase citations as software references without treating them as papers", async () => {
    const ws = await makeWorkspace();
    await fs.mkdir(path.join(ws, "codebases"), { recursive: true });
    await fs.writeFile(
      path.join(ws, "codebases", "manifest.json"),
      JSON.stringify({ version: 1, codebases: [{
        version: 1, id: "longexperiment", source: "https://github.com/example/longexperiment.git", requested_ref: "main",
        resolved_commit: "a".repeat(40), title: "LongExperiment", role: "primary_artifact",
        snapshot_path: "codebases/longexperiment/snapshot", files: [], generated_at: "2026-07-19T00:00:00.000Z",
      }] }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(ws, "sources", "codebases.bib"),
      `@software{codebaselongexperiment,\n  title = {LongExperiment},\n  version = {${"a".repeat(40)}}\n}\n`,
      "utf-8",
    );
    await fs.writeFile(
      path.join(ws, "chapters", "section-1.md"),
      "# Background\n\nThe repository exposes the experiment contract [codebase:longexperiment:src/runner.ts#L10-L24].\n",
      "utf-8",
    );
    await buildLatexWorkspace(ws);
    const section = await fs.readFile(path.join(ws, "paper", "sections", "section-1.tex"), "utf-8");
    const bibliography = await fs.readFile(path.join(ws, "paper", "references.bib"), "utf-8");
    expect(section).toContain("\\cite{codebaselongexperiment}");
    expect(bibliography).toContain("@software{codebaselongexperiment");
  });

  it("omits artifact-builder handoff instructions from reader-facing LaTeX", async () => {
    const ws = await makeWorkspace();
    await fs.writeFile(
      path.join(ws, "chapters", "section-1.md"),
      "# Background\n\nPlace this completed comparison artifact in Section 1. Render a visible caption immediately above the table: ‘Table 4.’\n\nGrounded prose remains.\n",
      "utf-8",
    );
    await buildLatexWorkspace(ws);
    const section = await fs.readFile(path.join(ws, "paper", "sections", "section-1.tex"), "utf-8");
    expect(section).not.toContain("Place this completed");
    expect(section).not.toMatch(/\bTable\s+4\b/);
    expect(section).toContain("Grounded prose remains.");
  });

  it("does not render planner placement instructions or manual artifact numbers", async () => {
    const ws = await makeWorkspace();
    await fs.mkdir(path.join(ws, "figures"), { recursive: true });
    await fs.writeFile(path.join(ws, "figures", "manifest.json"), JSON.stringify({
      version: 1,
      figures: [{
        id: "source-years", title: "Figure 1. Sources by year", caption: "Figure 1. Corpus distribution.",
        path: "figures/source-years.svg", latex_path: "paper/figures/source-years.tex",
        placement: { section_id: "section-1", discussion: "Place Figure 1 after the scope statement." },
        backend: "deterministic-svg",
      }],
      tables: [{
        id: "evidence-profile", title: "Table 2. Evidence profile", caption: "Table 2. Source-depth profile.",
        path: "tables/evidence-profile.md", latex_path: "paper/tables/evidence-profile.tex",
        placement: { section_id: "section-1", discussion: "Place the visible Table 2 after the framing." },
        backend: "deterministic-markdown",
      }],
    }, null, 2), "utf-8");
    await buildLatexWorkspace(ws);
    const section = await fs.readFile(path.join(ws, "paper", "sections", "section-1.tex"), "utf-8");
    expect(section).not.toMatch(/\b(?:Table|Figure)\s+\d+\b/);
    expect(section).not.toContain("Place Figure");
  });

  it("reports missing LaTeX sources", async () => {
    const ws = await makeWorkspace();
    const report = await validateLatexWorkspace(ws);
    expect(report.pass).toBe(false);
    expect(report.checks.flatMap((check) => check.findings)).toEqual(expect.arrayContaining([
      expect.stringContaining("paper/main.tex is missing"),
      expect.stringContaining("build/manuscript.pdf is missing"),
    ]));
  });
});

describe("citation mapping", () => {
  async function seedSources(ws: string): Promise<void> {
    await fs.mkdir(path.join(ws, "sources"), { recursive: true });
    const source = {
      id: "grounded-memory-2026-abc123", title: "Grounded Memory",
      authors: ["Ada Lovelace"], year: 2026, venue: "arXiv", url: "https://x",
      abstract: "", source: "arxiv", topics: [], quality_score: 0.9,
      score_rationale: "r", citation_depth: "core",
    };
    await fs.writeFile(
      path.join(ws, "sources", "classified_sources.jsonl"),
      JSON.stringify(source) + "\n", "utf-8",
    );
  }

  it("converts [source:id] markers to \\cite{bibkey} and drops \\nocite", async () => {
    const ws = await makeWorkspace();
    await seedSources(ws);
    await fs.writeFile(
      path.join(ws, "chapters", "section-1.md"),
      "# Background\n\nAgents need grounded memory [source:grounded-memory-2026-abc123:p42].\n",
      "utf-8",
    );
    await buildLatexWorkspace(ws);
    const section = await fs.readFile(path.join(ws, "paper", "sections", "section-1.tex"), "utf-8");
    expect(section).toContain("\\cite{lovelace2026groundedmemo");
    expect(section).not.toContain("[source:");
    const main = await fs.readFile(path.join(ws, "paper", "main.tex"), "utf-8");
    expect(main).not.toContain("\\nocite{*}");
  });

  it("renders configured author--year citations, publication metadata, and Markdown math", async () => {
    const ws = await makeWorkspace();
    await seedSources(ws);
    await fs.appendFile(path.join(ws, "longwrite.yaml"), [
      "publication:", "  presentation:", "    citation_style: author_year", "    show_production_statistics: true",
      "    disclosure:", "      enabled: true", "      ai_use: LongWrite", "      version: V2",
      "      provenance:", "        enabled: true", "        include_longwrite: true", "        include_malaclaw: true", "        include_runtime_models: true", "",
    ].join("\n"), "utf-8");
    await fs.mkdir(path.join(ws, ".malaclaw", "flow"), { recursive: true });
    await fs.writeFile(path.join(ws, ".malaclaw", "flow", "state.json"), JSON.stringify({
      units: { draft: { status: "succeeded", requestedRuntime: "codex", actualRuntime: "codex", requestedModel: "gpt-5", actualModel: "gpt-5", attempts: 1 } },
    }), "utf8");
    await fs.writeFile(
      path.join(ws, "chapters", "section-1.md"),
      "# Background\n\nA state $m_t$ is retrieved [source:grounded-memory-2026-abc123].\n\n$$\\mathcal{M}_{t+1} = f(\\mathcal{M}_t, o_t)$$\n",
      "utf-8",
    );
    await buildLatexWorkspace(ws);
    const section = await fs.readFile(path.join(ws, "paper", "sections", "section-1.tex"), "utf-8");
    const main = await fs.readFile(path.join(ws, "paper", "main.tex"), "utf-8");
    expect(section).toContain("$m_t$");
    expect(section).toContain("\\[\n\\mathcal{M}_{t+1} = f(\\mathcal{M}_t, o_t)\n\\]");
    expect(section).toContain("\\citep{lovelace2026groundedmemo");
    expect(main).toContain("\\usepackage[round,authoryear]{natbib}");
    expect(main).toContain("\\bibliographystyle{plainnat}");
    expect(main).toContain("AI tools used: LongWrite");
    expect(main).toContain("Execution provenance: LongWrite 0.2.0");
    expect(main).toContain("codex | gpt-5 (1 unit)");
    expect(main).toContain("Cited sources & 1");
  });

  it("uses outline.json as the canonical top-level section hierarchy", async () => {
    const ws = await makeWorkspace();
    await fs.writeFile(path.join(ws, "outline.json"), JSON.stringify({
      sections: [{ id: "section-1", title: "Canonical Evidence Base" }],
    }), "utf-8");
    await fs.writeFile(path.join(ws, "chapters", "section-1.md"), "## Writer chose the wrong level\n\nBody text.\n", "utf-8");
    await buildLatexWorkspace(ws);
    const section = await fs.readFile(path.join(ws, "paper", "sections", "section-1.tex"), "utf-8");
    expect(section).toMatch(/^\\section\{Canonical Evidence Base\}/);
    expect(section).not.toContain("Writer chose the wrong level");
  });

  it("keeps unknown markers as text and \\nocite fallback without sources", async () => {
    const ws = await makeWorkspace();
    await fs.writeFile(
      path.join(ws, "chapters", "section-1.md"),
      "# Background\n\nClaim [source:not-a-known-id].\n",
      "utf-8",
    );
    await buildLatexWorkspace(ws);
    const section = await fs.readFile(path.join(ws, "paper", "sections", "section-1.tex"), "utf-8");
    expect(section).toContain("[source:not-a-known-id]");
    expect(section).not.toContain("\\cite{");
    const main = await fs.readFile(path.join(ws, "paper", "main.tex"), "utf-8");
    expect(main).toContain("\\nocite{*}");
  });

  it("renders tables emitted by the current Marked token shape", async () => {
    const ws = await makeWorkspace();
    await seedSources(ws);
    await fs.writeFile(
      path.join(ws, "chapters", "section-1.md"),
      "# Comparison\n\n| Method | Finding |\n| --- | --- |\n| Indexed memory | Keeps evidence addressable [source:grounded-memory-2026-abc123:p42] |\n",
      "utf-8",
    );
    await buildLatexWorkspace(ws);
    const section = await fs.readFile(path.join(ws, "paper", "sections", "section-1.tex"), "utf-8");
    expect(section).toContain("\\begin{longtable}");
    expect(section).toContain("\\caption{Comparison in Comparison}\\label{tab:section-1-1}");
    expect(section).not.toContain("\\resizebox{\\textwidth}{!}{%");
    expect(section).toContain("\\cite{lovelace2026groundedmemo");
  });
});
