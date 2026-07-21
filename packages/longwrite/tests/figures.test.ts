import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareResearchWorkspace } from "../src/lib/research/pipeline.js";
import { buildFigureWorkspace } from "../src/lib/writing/figures.js";
import { buildLatexWorkspace } from "../src/lib/writing/latex.js";
import { validateFigureWorkspace } from "../src/lib/validation/figures.js";
import { runBuildResearch } from "../src/commands/build.js";
import { onePixelPng } from "./helpers/png.js";

const tempDirs: string[] = [];

async function addPublicationFigure(workspaceDir: string): Promise<void> {
  await fs.writeFile(path.join(workspaceDir, "figures", "source-years-plot.png"), onePixelPng());
}

async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-figures-"));
  tempDirs.push(dir);
  await prepareResearchWorkspace({
    workspaceDir: dir,
    topic: "Long-horizon agent memory",
    count: 5,
    provider: "seed",
  });
  await fs.mkdir(path.join(dir, "chapters"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "chapters", "section-1.md"),
    "# Background\n\nLong-horizon agents need durable plans [source:source-1].\n",
    "utf-8",
  );
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

let previousEngine: string | undefined;
beforeAll(() => {
  previousEngine = process.env.LONGWRITE_LATEX_ENGINE;
  process.env.LONGWRITE_LATEX_ENGINE = "none";
});
afterAll(() => {
  if (previousEngine === undefined) delete process.env.LONGWRITE_LATEX_ENGINE;
  else process.env.LONGWRITE_LATEX_ENGINE = previousEngine;
});

describe("research figures and tables", () => {
  it("builds deterministic figure, table, data, and manifest artifacts", async () => {
    const ws = await makeWorkspace();
    const written = await buildFigureWorkspace(ws);
    expect(written).toEqual(expect.arrayContaining([
      "data/source-years.csv",
      "data/source-quality.csv",
      "figures/source-years.svg",
      "tables/source-quality.md",
      "figures/manifest.json",
      "figures/figure-plan.md",
      // Backend sources are always written even when mmdc/matplotlib are absent.
      "figures/workflow.mmd",
      "scripts/plot_source_years.py",
      "reports/figures-build.md",
    ]));

    const manifest = JSON.parse(await fs.readFile(path.join(ws, "figures", "manifest.json"), "utf-8"));
    expect(manifest.figures[0]).toMatchObject({
      id: "source-years",
      backend: "python",
      path: "figures/source-years-plot.png",
    });
    expect(await fs.readFile(path.join(ws, "data", "source-years.csv"), "utf-8")).toContain("year,count");
    expect(await fs.readFile(path.join(ws, "tables", "evidence-profile.md"), "utf-8")).toContain("| Citation depth | Sources | Share |");
    const methodTable = await fs.readFile(path.join(ws, "paper", "tables", "method-comparison.tex"), "utf-8");
    expect(methodTable).toContain("\\begin{longtable}");
    expect(methodTable).toContain("\\setlength{\\tabcolsep}{2pt}");

    await addPublicationFigure(ws);
    const report = await validateFigureWorkspace(ws);
    expect(report.pass).toBe(true);
  });

  it("requires generated figures and tables when a manifest exists", async () => {
    const ws = await makeWorkspace();
    await buildFigureWorkspace(ws);
    await addPublicationFigure(ws);
    await fs.rm(path.join(ws, "figures", "source-years-plot.png"));
    const report = await validateFigureWorkspace(ws);
    expect(report.pass).toBe(false);
    expect(report.checks.flatMap((check) => check.findings)).toEqual(expect.arrayContaining([
      expect.stringContaining("figures/source-years-plot.png is missing or empty"),
    ]));
  }, 15_000);

  it("includes figure and table references in generated LaTeX", async () => {
    const ws = await makeWorkspace();
    await buildFigureWorkspace(ws);
    await addPublicationFigure(ws);
    await buildLatexWorkspace(ws);
    const section = await fs.readFile(path.join(ws, "paper", "sections", "section-1.tex"), "utf-8");
    expect(section).toContain("\\label{fig:source-years}");
    expect(section).toContain("\\input{figures/source-years.tex}");
    expect(section).toContain("\\label{tab:evidence-profile}");
    expect(section).toContain("\\input{tables/evidence-profile.tex}");
    expect((await validateFigureWorkspace(ws)).pass).toBe(true);
  });

  it("publishes a placed taxonomy-coverage table when evidence coverage exists", async () => {
    const ws = await makeWorkspace();
    await fs.mkdir(path.join(ws, "evidence"), { recursive: true });
    await fs.writeFile(path.join(ws, "evidence", "coverage.json"), JSON.stringify({
      taxonomy: [{ cell: "tool-use planning", source_count: 8, direct_source_count: 4 }],
    }), "utf-8");
    await buildFigureWorkspace(ws);
    await addPublicationFigure(ws);
    await buildLatexWorkspace(ws);
    const manifest = JSON.parse(await fs.readFile(path.join(ws, "figures", "manifest.json"), "utf-8"));
    expect(manifest.tables).toEqual(expect.arrayContaining([expect.objectContaining({ id: "taxonomy-coverage" })]));
    const section = await fs.readFile(path.join(ws, "paper", "sections", "section-1.tex"), "utf-8");
    expect(section).toContain("\\input{tables/taxonomy-coverage.tex}");
  });

  it("applies a source-grounded agentic table override through the normal builder", async () => {
    const ws = await makeWorkspace();
    const sources = (await fs.readFile(path.join(ws, "sources", "classified_sources.jsonl"), "utf-8"))
      .trim().split("\n").map((line) => JSON.parse(line) as { id: string });
    await fs.mkdir(path.join(ws, "figures"), { recursive: true });
    await fs.writeFile(path.join(ws, "figures", "placement-plan.json"), JSON.stringify({
      version: 1,
      placements: [],
      table_overrides: [{
        id: "method-comparison",
        title: "Conditional memory evidence matrix",
        caption: "Table 4. The matrix distinguishes intervention, outcome, and limitation.",
        headers: ["Source", "Regime", "Intervention", "Outcome", "Confounder", "Safety"],
        rows: [{ cells: ["Evidence", "Long horizon", "External memory", "Longer context", "Retrieval quality varies", "No safety result"], source_ids: [sources[0].id] }],
      }],
    }, null, 2));
    await buildFigureWorkspace(ws);
    const table = await fs.readFile(path.join(ws, "paper", "tables", "method-comparison.tex"), "utf-8");
    const manifest = JSON.parse(await fs.readFile(path.join(ws, "figures", "manifest.json"), "utf-8"));
    expect(table).toContain("Intervention");
    expect(table).toContain("Retrieval quality varies");
    expect(table).toContain("\\caption{The matrix distinguishes intervention, outcome, and limitation.}");
    expect(table).not.toContain("\\caption{Table 4.");
    expect(manifest.tables.find((table: { id: string }) => table.id === "method-comparison")).toMatchObject({
      title: "Conditional memory evidence matrix",
    });
  });

  it("renders declarative survey timelines and comparison tables from verified source IDs", async () => {
    const ws = await makeWorkspace();
    const sources = (await fs.readFile(path.join(ws, "sources", "classified_sources.jsonl"), "utf-8"))
      .trim().split("\n").map((line) => JSON.parse(line) as { id: string });
    await fs.mkdir(path.join(ws, "figures"), { recursive: true });
    await fs.writeFile(path.join(ws, "figures", "placement-plan.json"), JSON.stringify({
      version: 1,
      placements: [],
      timelines: [{
        id: "memory-milestones", title: "Memory-agent milestones",
        caption: "Selected sources show the progression of memory-agent designs.",
        insight: "The timeline separates early retrieval work from later long-horizon agent designs.",
        placement: { section_id: "section-1", discussion: "The chronology motivates the background synthesis." },
        source_ids: sources.slice(0, 3).map((source) => source.id),
      }],
      table_specs: [{
        id: "comparison-regimes", kind: "comparison_matrix", title: "Memory-agent comparison regimes",
        caption: "The matrix compares the source-backed regimes used in the survey.",
        insight: "The comparison makes differing evidence regimes explicit instead of treating all systems as directly comparable.",
        placement: { section_id: "section-1", discussion: "The matrix anchors the section's comparison." },
        headers: ["Source", "Regime", "Limitation"],
        rows: [{ cells: ["Representative source", "Long horizon", "Evidence varies by task"], source_ids: [sources[0].id] }],
      }],
    }, null, 2));
    await buildFigureWorkspace(ws);
    const manifest = JSON.parse(await fs.readFile(path.join(ws, "figures", "manifest.json"), "utf-8"));
    expect(manifest.figures).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "memory-milestones", data: ["data/memory-milestones.csv"] }),
    ]));
    expect(manifest.tables).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "comparison-regimes", comparative: true, data: ["data/comparison-regimes.csv"] }),
    ]));
    expect(await fs.readFile(path.join(ws, "figures", "memory-milestones.svg"), "utf-8")).toContain("Memory-agent milestones");
    expect(await fs.readFile(path.join(ws, "paper", "tables", "comparison-regimes.tex"), "utf-8")).toContain("Evidence varies by task");
  });

  it("fails when a manifest artifact is not embedded at its declared placement", async () => {
    const ws = await makeWorkspace();
    await buildFigureWorkspace(ws);
    await addPublicationFigure(ws);
    await buildLatexWorkspace(ws);
    await fs.writeFile(path.join(ws, "paper", "sections", "section-1.tex"), "\\section{Background}\n", "utf-8");
    const report = await validateFigureWorkspace(ws);
    expect(report.pass).toBe(false);
    expect(report.checks.flatMap((check) => check.findings)).toEqual(expect.arrayContaining([
      expect.stringContaining("source-years is not labeled"),
      expect.stringContaining("evidence-profile is not labeled"),
    ]));
  });

  it("builds full research manuscript artifacts", async () => {
    const ws = await makeWorkspace();
    await runBuildResearch(ws);
    expect(await fs.stat(path.join(ws, "figures", "manifest.json"))).toBeTruthy();
    expect(await fs.stat(path.join(ws, "paper", "main.tex"))).toBeTruthy();
    expect(await fs.stat(path.join(ws, "build", "manuscript.pdf"))).toBeTruthy();
  }, 15_000);

  it("renders an LLM-selected metadata plot from verified corpus data", async () => {
    const ws = await makeWorkspace();
    await fs.mkdir(path.join(ws, "reviews"), { recursive: true });
    await fs.writeFile(path.join(ws, "reviews", "artifact-plan.json"), JSON.stringify({
      version: 1,
      intents: [{
        id: "plot-depth", kind: "metadata_plot",
        rationale: "A depth distribution makes the evidence hierarchy visible without claiming a benchmark result.",
        section_id: "section-1", plot_metric: "citation_depth",
        acceptance_criteria: [{ metric: "verified_metadata_plots", target: 1 }],
      }],
    }), "utf-8");
    await buildFigureWorkspace(ws);
    const manifest = JSON.parse(await fs.readFile(path.join(ws, "figures", "manifest.json"), "utf-8"));
    expect(manifest.figures).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "metadata-citation_depth", data: ["data/source-depths.csv"] }),
    ]));
    expect(await fs.readFile(path.join(ws, "paper", "figures", "metadata-citation_depth.tex"), "utf-8")).toContain("symbolic x coords");
  });
});
