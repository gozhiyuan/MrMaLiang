import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareResearchWorkspace } from "../src/lib/research/pipeline.js";
import { buildFigureWorkspace } from "../src/lib/writing/figures.js";
import { detectPython } from "../src/lib/writing/figure-backends.js";
import { buildLatexWorkspace } from "../src/lib/writing/latex.js";
import { validateFigureWorkspace } from "../src/lib/validation/figures.js";
import { runBuildResearch } from "../src/commands/build.js";
import { onePixelPng } from "./helpers/png.js";

const tempDirs: string[] = [];

async function addPublicationFigure(workspaceDir: string): Promise<void> {
  await fs.writeFile(path.join(workspaceDir, "figures", "source-years-plot.png"), onePixelPng());
}

async function selectConceptMap(workspaceDir: string): Promise<void> {
  await fs.mkdir(path.join(workspaceDir, "figures"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "figures", "placement-plan.json"), JSON.stringify({
    version: 1,
    placements: [],
    concept_map: {
      title: "Memory-agent evidence map",
      caption: "The map distinguishes memory design, evaluation, and safety evidence.",
      placement: { section_id: "section-1", discussion: "The map anchors the background synthesis." },
      nodes: [
        { id: "memory", label: "Memory design" },
        { id: "evaluation", label: "Evaluation" },
        { id: "safety", label: "Safety" },
      ],
      edges: [{ from: "memory", to: "evaluation" }, { from: "evaluation", to: "safety" }],
    },
  }, null, 2));
}

/** The full-mode visual contract (and with it the insight gate) only applies
 * to an `auto_research_agentic` workspace, so a gate test has to declare one. */
async function enableFullModeGates(workspaceDir: string): Promise<void> {
  await fs.writeFile(path.join(workspaceDir, "longwrite.yaml"), [
    "version: 1",
    "project:",
    "  id: insight-gate",
    "  artifact_type: research_paper",
    "  mode: auto_research_agentic",
    "figures:",
    "  quality_gates:",
    "    min_figures: 0",
    "    min_tables: 0",
    "    min_comparative_tables: 0",
    "    min_verified_metadata_plots: 0",
    "    max_nanobanana_illustrations: 1",
    "    require_insight_statements: true",
    "",
  ].join("\n"), "utf-8");
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
let previousMmdc: string | undefined;
beforeAll(() => {
  previousEngine = process.env.LONGWRITE_LATEX_ENGINE;
  process.env.LONGWRITE_LATEX_ENGINE = "none";
  // Force the no-local-tool deterministic renderers so these assertions are
  // hermetic: without this, a machine that happens to have mmdc installed
  // renders the concept map to a PDF include instead of the deterministic
  // TikZ/SVG contract under test (green in CI, red on a dev laptop).
  previousMmdc = process.env.LONGWRITE_MMDC_BIN;
  process.env.LONGWRITE_MMDC_BIN = path.join(os.tmpdir(), "no-such-mmdc-binary");
});
afterAll(() => {
  if (previousEngine === undefined) delete process.env.LONGWRITE_LATEX_ENGINE;
  else process.env.LONGWRITE_LATEX_ENGINE = previousEngine;
  if (previousMmdc === undefined) delete process.env.LONGWRITE_MMDC_BIN;
  else process.env.LONGWRITE_MMDC_BIN = previousMmdc;
});

describe("research figures and tables", () => {
  it("does not publish unplanned corpus bookkeeping as paper artifacts", async () => {
    const ws = await makeWorkspace();
    const written = await buildFigureWorkspace(ws);
    expect(written).toEqual(expect.arrayContaining([
      "data/source-quality.csv",
      "figures/manifest.json",
      "figures/figure-plan.md",
      // Backend sources are always written even when mmdc/matplotlib are absent.
      "figures/workflow.mmd",
      "scripts/plot_source_years.py",
      "reports/figures-build.md",
    ]));

    const manifest = JSON.parse(await fs.readFile(path.join(ws, "figures", "manifest.json"), "utf-8"));
    expect(manifest.figures).toEqual([]);
    expect(manifest.tables).toEqual([]);
    expect(await fs.readFile(path.join(ws, "data", "source-years.csv"), "utf-8")).toContain("year,count");

    await addPublicationFigure(ws);
    const report = await validateFigureWorkspace(ws);
    expect(report.pass).toBe(true);
  });

  it("requires generated figures and tables when a manifest exists", async () => {
    const ws = await makeWorkspace();
    await selectConceptMap(ws);
    await buildFigureWorkspace(ws);
    await addPublicationFigure(ws);
    // Removing whichever artifact the manifest actually declares must fail the
    // gate, regardless of which figure backend the environment selected.
    const manifest = JSON.parse(await fs.readFile(path.join(ws, "figures", "manifest.json"), "utf-8"));
    const declaredPath = manifest.figures.find((figure: { id: string }) => figure.id === "concept-map").path as string;
    await fs.rm(path.join(ws, declaredPath));
    const report = await validateFigureWorkspace(ws);
    expect(report.pass).toBe(false);
    expect(report.checks.flatMap((check) => check.findings)).toEqual(expect.arrayContaining([
      expect.stringContaining(`${declaredPath} is missing or empty`),
    ]));
  }, 15_000);

  it("includes only selected figure references in generated LaTeX", async () => {
    const ws = await makeWorkspace();
    await selectConceptMap(ws);
    await buildFigureWorkspace(ws);
    await addPublicationFigure(ws);
    await buildLatexWorkspace(ws);
    const section = await fs.readFile(path.join(ws, "paper", "sections", "section-1.tex"), "utf-8");
    expect(section).toContain("\\label{fig:concept-map}");
    expect(section).toContain("\\input{figures/concept-map.tex}");
    expect(section).not.toContain("evidence-profile");
    expect((await validateFigureWorkspace(ws)).pass).toBe(true);
  });

  it("keeps taxonomy coverage as workspace evidence rather than a default paper table", async () => {
    const ws = await makeWorkspace();
    await fs.mkdir(path.join(ws, "evidence"), { recursive: true });
    await fs.writeFile(path.join(ws, "evidence", "coverage.json"), JSON.stringify({
      taxonomy: [{ cell: "tool-use planning", source_count: 8, direct_source_count: 4 }],
    }), "utf-8");
    await buildFigureWorkspace(ws);
    await addPublicationFigure(ws);
    await buildLatexWorkspace(ws);
    const manifest = JSON.parse(await fs.readFile(path.join(ws, "figures", "manifest.json"), "utf-8"));
    expect(manifest.tables).toEqual([]);
    const section = await fs.readFile(path.join(ws, "paper", "sections", "section-1.tex"), "utf-8");
    expect(section).not.toContain("taxonomy-coverage");
  });

  it("renders a source-grounded selected comparison table through the normal builder", async () => {
    const ws = await makeWorkspace();
    const sources = (await fs.readFile(path.join(ws, "sources", "classified_sources.jsonl"), "utf-8"))
      .trim().split("\n").map((line) => JSON.parse(line) as { id: string });
    await fs.mkdir(path.join(ws, "figures"), { recursive: true });
    await fs.writeFile(path.join(ws, "figures", "placement-plan.json"), JSON.stringify({
      version: 1,
      placements: [],
      table_specs: [{
        id: "conditional-memory-evidence",
        kind: "comparison_matrix",
        title: "Conditional memory evidence matrix",
        caption: "Table 4. The matrix distinguishes intervention, outcome, and limitation.",
        headers: ["Source", "Regime", "Intervention", "Outcome", "Confounder", "Safety"],
        rows: [{ cells: ["Evidence", "Long horizon", "External memory", "Longer context", "Retrieval quality varies", "No safety result"], source_ids: [sources[0].id] }],
        insight: "The matrix distinguishes intervention, outcome, and limitation.",
        placement: { section_id: "section-1", discussion: "The comparison anchors the memory discussion." },
      }],
    }, null, 2));
    await buildFigureWorkspace(ws);
    const table = await fs.readFile(path.join(ws, "paper", "tables", "conditional-memory-evidence.tex"), "utf-8");
    const manifest = JSON.parse(await fs.readFile(path.join(ws, "figures", "manifest.json"), "utf-8"));
    expect(table).toContain("Intervention");
    expect(table).toContain("Retrieval quality varies");
    expect(table).toContain("\\caption{The matrix distinguishes intervention, outcome, and limitation.}");
    expect(table).not.toContain("\\caption{Table 4.");
    expect(manifest.tables.find((table: { id: string }) => table.id === "conditional-memory-evidence")).toMatchObject({
      title: "Conditional memory evidence matrix",
    });
  });

  it("renders an agent-selected explanatory diagram without a fixed figure type", async () => {
    const ws = await makeWorkspace();
    const sources = (await fs.readFile(path.join(ws, "sources", "classified_sources.jsonl"), "utf-8"))
      .trim().split("\n").map((line) => JSON.parse(line) as { id: string });
    await fs.mkdir(path.join(ws, "figures"), { recursive: true });
    await fs.writeFile(path.join(ws, "figures", "placement-plan.json"), JSON.stringify({
      version: 1,
      placements: [],
      diagrams: [{
        id: "memory-feedback-loop",
        title: "Memory feedback loop for long-horizon agents",
        caption: "The diagram distinguishes retrieval, execution feedback, and memory revision.",
        insight: "Durable performance depends on closing the loop between outcome feedback and the retained memory state.",
        placement: { section_id: "section-1", discussion: "The loop makes the mechanism concrete." },
        source_ids: [sources[0].id, sources[1].id],
        nodes: [
          { id: "retrieve", label: "Retrieve context" },
          { id: "act", label: "Act in environment" },
          { id: "update", label: "Update retained memory" },
        ],
        edges: [
          { from: "retrieve", to: "act", label: "conditions action" },
          { from: "act", to: "update", label: "returns feedback" },
          { from: "update", to: "retrieve", label: "changes recall" },
        ],
      }],
    }, null, 2));
    await buildFigureWorkspace(ws);
    await buildLatexWorkspace(ws);
    const manifest = JSON.parse(await fs.readFile(path.join(ws, "figures", "manifest.json"), "utf-8"));
    expect(manifest.figures).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "memory-feedback-loop", title: "Memory feedback loop for long-horizon agents" }),
    ]));
    expect(await fs.readFile(path.join(ws, "figures", "memory-feedback-loop.svg"), "utf-8")).toContain("Retrieve context");
    const section = await fs.readFile(path.join(ws, "paper", "sections", "section-1.tex"), "utf-8");
    expect(section).toContain("\\label{fig:memory-feedback-loop}");
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

  it("keeps a dense long-label concept map inside non-overlapping deterministic bounds", async () => {
    const ws = await makeWorkspace();
    await fs.mkdir(path.join(ws, "figures"), { recursive: true });
    const nodes = [
      "Public CLI configuration and lifecycle",
      "LongWrite evidence and manuscript component",
      "LongExperiment audited trial component",
      "Shared research protocol contracts",
      "MalaClaw runtime and dashboard host",
      "Pinned repository source evidence",
      "Verified experiment manifest handoff",
    ].map((label, index) => ({ id: `node-${index + 1}`, label }));
    await fs.writeFile(path.join(ws, "figures", "placement-plan.json"), JSON.stringify({
      version: 1,
      placements: [],
      concept_map: {
        title: "Bounded architecture handoffs for a repository research workflow",
        caption: "The diagram distinguishes orchestration, evidence, runtime, and empirical handoff boundaries.",
        placement: { section_id: "section-1", discussion: "The architecture map anchors the component-boundary discussion." },
        nodes,
        edges: [
          { from: "node-1", to: "node-2", label: "writing configuration" },
          { from: "node-1", to: "node-3", label: "experiment configuration" },
          { from: "node-2", to: "node-4", label: "shared evidence schema" },
          { from: "node-3", to: "node-4", label: "audited result schema" },
          { from: "node-2", to: "node-5", label: "durable execution" },
          { from: "node-3", to: "node-5", label: "remote execution" },
          { from: "node-6", to: "node-2", label: "code locators" },
          { from: "node-7", to: "node-2", label: "verified results" },
        ],
      },
    }, null, 2));
    await buildFigureWorkspace(ws);

    const svg = await fs.readFile(path.join(ws, "figures", "concept-map.svg"), "utf-8");
    const boxes = [...svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/g)]
      .map((match) => ({ x: Number(match[1]), y: Number(match[2]), width: Number(match[3]), height: Number(match[4]) }));
    expect(boxes).toHaveLength(nodes.length);
    for (let left = 0; left < boxes.length; left += 1) {
      expect(boxes[left].x).toBeGreaterThanOrEqual(40);
      expect(boxes[left].x + boxes[left].width).toBeLessThanOrEqual(940);
      for (let right = left + 1; right < boxes.length; right += 1) {
        const overlapX = boxes[left].x < boxes[right].x + boxes[right].width && boxes[right].x < boxes[left].x + boxes[left].width;
        const overlapY = boxes[left].y < boxes[right].y + boxes[right].height && boxes[right].y < boxes[left].y + boxes[left].height;
        expect(overlapX && overlapY, `boxes ${left + 1} and ${right + 1} overlap`).toBe(false);
      }
    }
    const latex = await fs.readFile(path.join(ws, "paper", "figures", "concept-map.tex"), "utf-8");
    expect(latex.match(/\\node\[draw=blue!/g)).toHaveLength(nodes.length);
    expect(latex).toContain("text width=3.15cm");
    expect(latex).not.toContain("text width=2cm");
    expect(latex.indexOf("\\draw[-{Latex")).toBeLessThan(latex.indexOf("\\node[draw=blue!"));
  });

  it("fails when a manifest artifact is not embedded at its declared placement", async () => {
    const ws = await makeWorkspace();
    await selectConceptMap(ws);
    await buildFigureWorkspace(ws);
    await addPublicationFigure(ws);
    await buildLatexWorkspace(ws);
    await fs.writeFile(path.join(ws, "paper", "sections", "section-1.tex"), "\\section{Background}\n", "utf-8");
    const report = await validateFigureWorkspace(ws);
    expect(report.pass).toBe(false);
    expect(report.checks.flatMap((check) => check.findings)).toEqual(expect.arrayContaining([
      expect.stringContaining("concept-map is not labeled"),
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

  it("escapes comma-containing venue labels consistently in pgfplots coordinates", async () => {
    const ws = await makeWorkspace();
    const sourcePath = path.join(ws, "sources", "classified_sources.jsonl");
    const sources = (await fs.readFile(sourcePath, "utf-8")).trim().split("\n").map((line) => JSON.parse(line));
    sources[0].venue = "arXiv:gr-qc,astro-ph.HE";
    await fs.writeFile(sourcePath, `${sources.map(JSON.stringify).join("\n")}\n`, "utf-8");
    await fs.mkdir(path.join(ws, "reviews"), { recursive: true });
    await fs.writeFile(path.join(ws, "reviews", "artifact-plan.json"), JSON.stringify({
      version: 1,
      intents: [{
        id: "plot-venue", kind: "metadata_plot",
        rationale: "Venue distribution is verified metadata.",
        section_id: "section-1", plot_metric: "venue",
        acceptance_criteria: [{ metric: "verified_metadata_plots", target: 1 }],
      }],
    }), "utf-8");

    await buildFigureWorkspace(ws);
    const latex = await fs.readFile(path.join(ws, "paper", "figures", "metadata-venue.tex"), "utf-8");
    expect(latex).toContain("arXiv:gr-qc{,}astro-ph.HE");
    expect(latex).toContain("(arXiv:gr-qc{,}astro-ph.HE,1)");
  });
});

describe("the planner owns the argument, the renderer owns the rendering", () => {
  it("fails the insight gate rather than lending a built-in figure a canned rationale", async () => {
    const ws = await makeWorkspace();
    await enableFullModeGates(ws);
    await selectConceptMap(ws); // no `insight` on the concept map
    await buildFigureWorkspace(ws);
    await addPublicationFigure(ws);

    const manifest = JSON.parse(await fs.readFile(path.join(ws, "figures", "manifest.json"), "utf-8"));
    const conceptMap = manifest.figures.find((figure: { id: string }) => figure.id === "concept-map");
    // The renderer may label the artifact; it may not argue for it.
    expect(conceptMap.title).toBe("Memory-agent evidence map");
    expect(conceptMap.insight).toBe("");

    const report = await validateFigureWorkspace(ws);
    expect(report.pass).toBe(false);
    const findings = report.checks.flatMap((check) => check.findings).join(" ");
    expect(findings).toContain("concept-map requires a substantive insight statement");
  });

  it("accepts a planner-authored insight on the same figure", async () => {
    const ws = await makeWorkspace();
    await enableFullModeGates(ws);
    await fs.mkdir(path.join(ws, "figures"), { recursive: true });
    await fs.writeFile(path.join(ws, "figures", "placement-plan.json"), JSON.stringify({
      version: 1,
      placements: [],
      concept_map: {
        title: "Memory-agent evidence map",
        caption: "The map distinguishes memory design, evaluation, and safety evidence.",
        insight: "Separating design from evaluation evidence shows that durability claims rest on far thinner support than capability claims.",
        placement: { section_id: "section-1", discussion: "The map anchors the background synthesis." },
        nodes: [
          { id: "memory", label: "Memory design" },
          { id: "evaluation", label: "Evaluation" },
          { id: "safety", label: "Safety" },
        ],
        edges: [{ from: "memory", to: "evaluation" }, { from: "evaluation", to: "safety" }],
      },
    }, null, 2));
    await buildFigureWorkspace(ws);
    await addPublicationFigure(ws);

    const manifest = JSON.parse(await fs.readFile(path.join(ws, "figures", "manifest.json"), "utf-8"));
    const conceptMap = manifest.figures.find((figure: { id: string }) => figure.id === "concept-map");
    expect(conceptMap.insight).toContain("thinner support than capability claims");
    expect((await validateFigureWorkspace(ws)).pass).toBe(true);
  });

  it("names a placement whose artifact was never produced instead of dropping it silently", async () => {
    const ws = await makeWorkspace();
    await fs.mkdir(path.join(ws, "figures"), { recursive: true });
    await fs.writeFile(path.join(ws, "figures", "placement-plan.json"), JSON.stringify({
      version: 1,
      // `evidence-profile` and `method-comparison` were built-ins that no
      // longer exist. A planner asking for them must be told, not ignored.
      placements: [
        { id: "evidence-profile", placement: { section_id: "section-1", discussion: "Corpus depth overview." } },
        { id: "method-comparison", placement: { section_id: "section-1", discussion: "Method comparison." } },
      ],
    }, null, 2));
    await buildFigureWorkspace(ws);

    const repair = await fs.readFile(path.join(ws, "reports", "visual-plan-repair.md"), "utf-8");
    expect(repair).toContain("evidence-profile");
    expect(repair).toContain("method-comparison");
    expect(repair).toContain("not produced");
  });
});
