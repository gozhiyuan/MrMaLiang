import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";

/** What a producer actually emitted when run.
 *
 * `findings` stays empty for a producer that still returns prose findings; the
 * gate-id assertions bite from the start, and each migration task makes the
 * finding assertions meaningful for its own module. */
export type ProbeResult = { gateIds: string[]; findings: Array<Record<string, unknown>> };

const created: string[] = [];

export async function cleanupProbeWorkspaces(): Promise<void> {
  await Promise.all(created.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
}

/** A workspace deliberately missing almost everything, so every check that can
 * fail does. A producer that throws on absent input is reported as emitting
 * nothing rather than failing the suite: the assertion is that whatever it DID
 * emit was declared. */
async function probeWorkspace(module: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `longwrite-probe-${module}-`));
  created.push(dir);
  for (const sub of ["sources", "chapters", "evidence", "reports", "reviews", "figures", "paper/sections"]) {
    await fs.mkdir(path.join(dir, sub), { recursive: true });
  }
  await fs.writeFile(path.join(dir, "longwrite.yaml"), stringify({
    version: 1,
    project: { id: "probe", artifact_type: "research_paper", mode: "auto_research_agentic" },
    research: {
      provider: "multi", topic: "agent memory", taxonomy: ["memory", "planning"],
      corpus_gates: {
        min_candidates: 5, min_sources_per_taxonomy_cell: 2, min_core_sources: 5,
        min_recent_ratio: 0.5, min_source_type_diversity: 3,
      },
    },
    writing: { target_length_words: 8000 },
  }), "utf-8");
  await fs.writeFile(path.join(dir, "sources", "classified_sources.jsonl"),
    JSON.stringify({ id: "s1", citation_depth: "C", source: "arxiv", title: "A", abstract: "x", year: 2020, topics: [] }), "utf-8");
  await fs.writeFile(path.join(dir, "chapters", "section-01.md"), "# One\n\nProse with no markers.\n", "utf-8");
  await fs.writeFile(path.join(dir, "paper", "main.tex"), "\\documentclass{article}\n", "utf-8");
  // A figure and a table that are declared but never rendered, labeled or
  // embedded, so the figures gates emit findings rather than passing on an
  // empty manifest. An empty manifest is legitimately valid, which made the
  // probe silent for this producer.
  await fs.writeFile(path.join(dir, "figures", "manifest.json"), JSON.stringify({
    version: 1,
    figures: [{
      id: "figure-1", title: "Overview", caption: "An overview", insight: "",
      path: "figures/figure-1.svg", latex_path: "paper/figures/figure-1.tex",
      placement: { section_id: "section-03", discussion: "introduced in the overview" },
      backend: "deterministic-svg", data: [],
    }],
    tables: [{
      id: "table-1", title: "Comparison", caption: "A comparison", insight: "",
      path: "figures/table-1.md", latex_path: "paper/tables/table-1.tex",
      placement: { section_id: "section-03", discussion: "compared in the overview" },
      backend: "deterministic-markdown", layout: "table", comparative: false, data: [],
    }],
  }), "utf-8");
  await fs.writeFile(path.join(dir, "paper", "sections", "section-03.tex"), "Prose with no float.\n", "utf-8");
  return dir;
}

function collect(value: unknown): ProbeResult {
  const gateIds: string[] = [];
  const findings: Array<Record<string, unknown>> = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record.id === "string" && typeof record.pass === "boolean") {
      gateIds.push(record.id);
      // A migrated producer returns structured findings; an unmigrated one
      // returns strings, which are skipped rather than misread.
      for (const entry of Array.isArray(record.findings) ? record.findings : []) {
        if (entry && typeof entry === "object" && "gate_id" in entry) {
          findings.push(entry as Record<string, unknown>);
        }
      }
    }
    for (const nested of Object.values(record)) visit(nested);
  };
  visit(value);
  return { gateIds, findings };
}

/** Runs one producer against a probe workspace and reports what it emitted. */
export async function probeProducer(module: string): Promise<ProbeResult> {
  const dir = await probeWorkspace(module);
  const run = async (): Promise<unknown> => {
    switch (module) {
      case "research":
        return (await import("../../src/lib/validation/research.js")).validateResearchWorkspace(dir);
      case "figures":
        return (await import("../../src/lib/validation/figures.js")).validateFigureWorkspace(dir);
      case "latex":
        return (await import("../../src/lib/validation/latex.js")).validateLatexWorkspace(dir);
      case "longform":
        return (await import("../../src/lib/validation/longform.js")).validateNovelWorkspace(dir);
      case "corpus-gates":
        return (await import("../../src/lib/research/corpus-gates.js")).evaluateCorpusGates(dir);
      case "survey-contract":
        return (await import("../../src/lib/research/survey-contract.js")).evaluateSurveyContract(dir);
      case "visual-review": {
        const mod = await import("../../src/lib/ops/visual-review.js");
        return [await mod.validateVisualReview(dir), await mod.checkVisualReviewReleaseGate(dir, true)];
      }
      case "publication":
        return (await import("../../src/lib/publication.js")).validatePublicationWorkspace(dir);
      case "preflight":
        return (await import("../../src/commands/preflight.js")).collectPreflightChecks(dir);
      default:
        throw new Error(`no probe adapter for producer ${module}`);
    }
  };
  try {
    return collect(await run());
  } catch {
    // Absent input is expected in a probe workspace. Emitting nothing is a
    // weaker signal than emitting something undeclared, and never a failure.
    return { gateIds: [], findings: [] };
  }
}
