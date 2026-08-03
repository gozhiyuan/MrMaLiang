import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { parseJsonl } from "../research/jsonl.js";
import type { ClassifiedSource } from "../research/types.js";
import { cropPdfFile, detectPython, renderFigureBackends, renderMermaidFile } from "./figure-backends.js";
import { runNanobanana } from "./nanobanana.js";
import { AgenticArtifactPlan } from "../ops/artifact-plan.js";
import { loadProjectConfigIfExists } from "../project-config.js";
import { loadCodebaseManifest } from "../research/codebase-contract.js";

const Placement = z.object({
  section_id: z.string().min(1),
  discussion: z.string().min(1),
}).strict();

const ImportedArtifactProvenance = z.object({
  source_kind: z.enum(["longexperiment", "repository"]),
  source_path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  manifest_path: z.string().min(1).optional(),
  source_revision: z.string().min(1).optional(),
  codebase_id: z.string().min(1).optional(),
  license: z.string().min(1).optional(),
}).strict();

/** A survey-native, source-bound table. The model owns the comparison lens
 * and prose cells; the builder owns the durable CSV, Markdown, TeX, label,
 * caption, and placement artifacts. This is intentionally not a general TeX
 * escape hatch. */
const TableSpec = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{1,60}$/),
  /** Agent-chosen reader purpose. This is descriptive rather than a fixed
   * table menu; the renderer still owns the safe source-bound layout. */
  kind: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{1,60}$/),
  comparative: z.boolean().optional(),
  title: z.string().min(1).max(180),
  caption: z.string().min(1).max(500),
  insight: z.string().min(24).max(800),
  placement: Placement,
  headers: z.array(z.string().min(1).max(48)).min(2).max(6),
  rows: z.array(z.object({
    cells: z.array(z.string().min(1).max(180)).min(2).max(6),
    source_ids: z.array(z.string().min(1)).min(1).max(8),
  }).strict()).min(1).max(30),
}).strict();

/** A declarative, source-bound survey timeline.  The model chooses the
 * milestone set and reader-facing story; the renderer derives every date and
 * label from classified metadata rather than accepting plot coordinates. */
const TimelineSpec = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{1,60}$/),
  title: z.string().min(1).max(180),
  caption: z.string().min(1).max(500),
  insight: z.string().min(24).max(800),
  placement: Placement,
  source_ids: z.array(z.string().min(1)).min(3).max(16),
}).strict();

/** A source-grounded explanatory diagram. The agent chooses its subject and
 * relationship (taxonomy, feedback loop, causal map, process, etc.); the
 * renderer owns the bounded diagram grammar and publication layout. */
const DiagramSpec = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{1,60}$/),
  title: z.string().min(1).max(180),
  caption: z.string().min(1).max(500),
  insight: z.string().min(24).max(800),
  placement: Placement,
  source_ids: z.array(z.string().min(1)).min(1).max(12),
  nodes: z.array(z.object({ id: z.string().min(1).max(40), label: z.string().min(1).max(48) }).strict()).min(3).max(10),
  edges: z.array(z.object({ from: z.string().min(1).max(40), to: z.string().min(1).max(40), label: z.string().max(36).optional() }).strict()).max(12),
}).strict();

const PlacementPlan = z.object({
  version: z.literal(1),
  placements: z.array(z.object({ id: z.string().min(1), placement: Placement }).strict()),
  // The model plans the semantic content of this diagram. LongWrite owns the
  // rendering, placement, caption, and stable figure label so a manuscript
  // never depends on an unrendered prose "Figure N" placeholder.
  concept_map: z.object({
    title: z.string().min(1).max(180),
    caption: z.string().min(1).max(500),
    /** Why this map earns space. Optional only so an existing plan still
     * parses; without it the artifact fails `require_insight_statements`
     * rather than borrowing a sentence the renderer wrote. */
    insight: z.string().min(24).max(800).optional(),
    placement: Placement,
    // The deterministic fallback renderer uses a bounded publication grid.
    // Short labels are a layout contract, not merely a stylistic preference.
    nodes: z.array(z.object({ id: z.string().min(1).max(40), label: z.string().min(1).max(48) }).strict()).min(3).max(10),
    edges: z.array(z.object({ from: z.string().min(1).max(40), to: z.string().min(1).max(40), label: z.string().max(36).optional() }).strict()).max(10),
  }).strict().optional(),
  /** Additional long-form tables declared by the artifact planner. Their
   * values must be traceable to classified source IDs; they cannot carry raw
   * LaTeX, chart code, or unverified numeric data. */
  table_specs: z.array(TableSpec).max(10).optional(),
  /** Reader-facing framing for a verified metadata plot. The renderer derives
   * the plot from verified corpus metadata and may label its axes factually,
   * but only the planner may say why the distribution is worth a reader's
   * attention, so `insight` is supplied here rather than canned downstream. */
  metadata_plots: z.array(z.object({
    metric: z.enum(["publication_year", "citation_depth", "venue"]),
    insight: z.string().min(24).max(800),
    title: z.string().min(1).max(180).optional(),
    caption: z.string().min(1).max(500).optional(),
  }).strict()).max(3).optional(),
  timelines: z.array(TimelineSpec).max(3).optional(),
  diagrams: z.array(DiagramSpec).max(3).optional(),
}).strict();

export const figureManifestSchema = z.object({
  version: z.literal(1),
  figures: z.array(z.object({
    id: z.string().min(1), title: z.string().min(1), caption: z.string().min(1),
    /** A reader-facing conclusion, distinct from a descriptive caption. */
    insight: z.string().default(""),
    path: z.string().min(1), latex_path: z.string().min(1), placement: Placement,
    backend: z.enum(["deterministic-svg", "python", "mermaid", "nanobanana", "experiment-import", "repository-import"]),
    data: z.array(z.string().min(1)).default([]),
    provenance: ImportedArtifactProvenance.optional(),
  }).strict()),
  tables: z.array(z.object({
    id: z.string().min(1), title: z.string().min(1), caption: z.string().min(1),
    /** A reader-facing conclusion, distinct from a descriptive caption. */
    insight: z.string().default(""),
    path: z.string().min(1), latex_path: z.string().min(1), placement: Placement,
    backend: z.enum(["deterministic-markdown", "csv", "experiment-summary", "repository-import"]),
    // A longtable owns its caption/label inside its generated TeX and can
    // break across pages. Ordinary tables remain compact floats.
    layout: z.enum(["table", "longtable"]).default("table"),
    comparative: z.boolean().default(false),
    data: z.array(z.string().min(1)).default([]),
    provenance: ImportedArtifactProvenance.optional(),
  }).strict()).default([]),
}).strict();

export type FigureManifest = z.infer<typeof figureManifestSchema>;

async function sourcesForWorkspace(workspaceDir: string): Promise<ClassifiedSource[]> {
  const rel = "sources/classified_sources.jsonl";
  const rows = parseJsonl<ClassifiedSource>(await fs.readFile(path.join(workspaceDir, rel), "utf-8"));
  if (rows.length === 0) throw new Error(`${rel} has no sources`);
  return rows;
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }

type ExperimentPacket = {
  manifest_path: string; hypothesis: string; provenance: { source_revision?: string; input_revisions?: Record<string, string> };
  comparisons: Array<{ id: string; metric: string; baseline_condition: string; treatment_condition: string; estimate: number; confidence_interval: { level: number; lower: number; upper: number }; paired_seeds: number[] }>;
  artifacts: Array<{ id: string; kind: "figure" | "table"; source_path: string; imported_path: string; sha256: string }>;
};

async function experimentPacket(workspaceDir: string): Promise<ExperimentPacket | null> {
  try { return JSON.parse(await fs.readFile(path.join(workspaceDir, "evidence", "experiment-packets.json"), "utf8")) as ExperimentPacket; }
  catch { return null; }
}

async function importedExperimentFigures(workspaceDir: string, placement: z.infer<typeof Placement>): Promise<Array<z.infer<typeof figureManifestSchema>["figures"][number]>> {
  const packet = await experimentPacket(workspaceDir);
  if (!packet) return [];
  const figures = packet.artifacts.filter((artifact) => artifact.kind === "figure" && /\.(?:png|jpe?g|pdf|svg)$/i.test(artifact.imported_path));
  const imported: Array<z.infer<typeof figureManifestSchema>["figures"][number]> = [];
  for (const artifact of figures) {
    const input = path.join(workspaceDir, artifact.imported_path);
    const bytes = await fs.readFile(input).catch(() => null);
    if (!bytes || sha256(bytes) !== artifact.sha256) throw new Error(`experiment figure checksum mismatch: ${artifact.imported_path}`);
    const extension = path.extname(artifact.imported_path).toLowerCase();
    const id = `experiment-${artifact.id.replace(/[^A-Za-z0-9-]/g, "-")}`;
    const target = `figures/${id}${extension}`;
    await fs.mkdir(path.dirname(path.join(workspaceDir, target)), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "paper", "figures"), { recursive: true });
    await fs.copyFile(input, path.join(workspaceDir, target));
    await fs.writeFile(path.join(workspaceDir, "paper", "figures", `${id}.tex`), ["\\begin{center}", `\\includegraphics[width=0.92\\linewidth]{assets/${path.basename(target)}}`, "\\end{center}", ""].join("\n"), "utf8");
    imported.push({
      id, title: `Verified experiment result: ${artifact.id}`,
      caption: `Imported LongExperiment artifact from ${artifact.source_path}; its experiment manifest, trial records, and artifact checksum were verified before paper assembly.`,
      insight: "This figure is reused as the canonical experiment artifact; empirical interpretation remains limited to the paired comparison and confidence interval recorded in the verified experiment packet.",
      path: target, latex_path: `paper/figures/${id}.tex`, placement, backend: "experiment-import", data: ["evidence/experiment-packets.json", artifact.imported_path],
      provenance: { source_kind: "longexperiment", source_path: artifact.source_path, sha256: artifact.sha256, manifest_path: packet.manifest_path, source_revision: packet.provenance.source_revision ?? Object.values(packet.provenance.input_revisions ?? {})[0] ?? "unknown-pinned-input" },
    });
  }
  return imported;
}

async function importedRepositoryFigures(
  workspaceDir: string,
  configured: Array<{ id: string; codebase_id: string; path: string; title: string; caption: string; insight: string; license: string }>,
  placement: z.infer<typeof Placement>,
): Promise<Array<z.infer<typeof figureManifestSchema>["figures"][number]>> {
  if (configured.length === 0) return [];
  const manifest = await loadCodebaseManifest(workspaceDir);
  if (!manifest) throw new Error("repository_figures require codebases/manifest.json; prepare pinned codebase evidence first");
  const figures: Array<z.infer<typeof figureManifestSchema>["figures"][number]> = [];
  for (const item of configured) {
    if (!safeRepositoryPath(item.path) || !/\.(?:png|jpe?g|pdf|svg)$/i.test(item.path)) throw new Error(`repository_figures.${item.id} must name a safe image/PDF path inside a codebase snapshot`);
    const codebase = manifest.codebases.find((entry) => entry.id === item.codebase_id);
    if (!codebase?.resolved_commit) throw new Error(`repository_figures.${item.id} references unknown/unpinned codebase ${item.codebase_id}`);
    const source = path.join(workspaceDir, "codebases", item.codebase_id, "snapshot", item.path);
    const bytes = await fs.readFile(source).catch(() => null);
    if (!bytes || bytes.length === 0) throw new Error(`repository_figures.${item.id} source is missing: ${item.path}`);
    const extension = path.extname(item.path).toLowerCase();
    const target = `figures/repository-${item.id}${extension}`;
    await fs.mkdir(path.dirname(path.join(workspaceDir, target)), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "paper", "figures"), { recursive: true });
    await fs.copyFile(source, path.join(workspaceDir, target));
    await fs.writeFile(path.join(workspaceDir, "paper", "figures", `repository-${item.id}.tex`), ["\\begin{center}", `\\includegraphics[width=0.92\\linewidth]{assets/${path.basename(target)}}`, "\\end{center}", ""].join("\n"), "utf8");
    figures.push({
      id: `repository-${item.id}`, title: item.title, caption: `${item.caption} Reused from pinned repository ${item.codebase_id} at ${codebase.resolved_commit}; license: ${item.license}.`, insight: item.insight,
      path: target, latex_path: `paper/figures/repository-${item.id}.tex`, placement, backend: "repository-import", data: [`codebases/${item.codebase_id}/manifest.json`],
      provenance: { source_kind: "repository", source_path: item.path, sha256: sha256(bytes), source_revision: codebase.resolved_commit, codebase_id: item.codebase_id, license: item.license },
    });
  }
  return figures;
}

function safeRepositoryPath(value: string): boolean { return value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]/).includes(".."); }

function markdownTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    "",
  ].join("\n");
}

function yearCounts(sources: ClassifiedSource[]): Array<{ year: number; count: number }> {
  const counts = new Map<number, number>();
  for (const source of sources) counts.set(source.year, (counts.get(source.year) ?? 0) + 1);
  return [...counts].map(([year, count]) => ({ year, count })).sort((a, b) => a.year - b.year);
}

function depthCounts(sources: ClassifiedSource[]): Array<{ depth: string; count: number; share: number }> {
  return ["A", "B", "C", "D"].map((depth) => {
    const count = sources.filter((source) => source.citation_depth === depth).length;
    return { depth, count, share: sources.length === 0 ? 0 : count / sources.length };
  });
}

function sourceYearsSvg(rows: Array<{ year: number; count: number }>): string {
  const max = Math.max(1, ...rows.map((row) => row.count));
  const bars = rows.map((row, index) => {
    const height = Math.round((row.count / max) * 220);
    const x = 72 + index * 92;
    return `<rect x="${x}" y="${280 - height}" width="54" height="${height}" fill="#2563eb"/><text x="${x + 27}" y="310" text-anchor="middle" font-size="12">${row.year}</text><text x="${x + 27}" y="${270 - height}" text-anchor="middle" font-size="12">${row.count}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="340" viewBox="0 0 720 340"><rect width="100%" height="100%" fill="white"/><text x="56" y="34" font-size="20" font-weight="700">Sources by publication year</text><line x1="56" y1="280" x2="680" y2="280" stroke="#64748b"/>${bars}</svg>\n`;
}

function sourceYearsLatex(rows: Array<{ year: number; count: number }>): string {
  return [
    "\\begin{tikzpicture}",
    "\\begin{axis}[width=0.88\\linewidth,height=0.42\\linewidth,ybar,bar width=13pt,xlabel={Publication year},ylabel={Classified sources},ymajorgrids=true,grid style={dashed,gray!30},enlargelimits=0.15]",
    `\\addplot+[fill=blue!65] coordinates {${rows.map((row) => `(${row.year},${row.count})`).join(" ")}};`,
    "\\end{axis}",
    "\\end{tikzpicture}",
    "",
  ].join("\n");
}

function timelineSvg(title: string, rows: Array<{ id: string; title: string; year: number }>): string {
  const width = 1040;
  const years = rows.map((row) => row.year);
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);
  const axisStart = 100;
  const axisEnd = 960;
  const xFor = (year: number) => minYear === maxYear ? (axisStart + axisEnd) / 2 : axisStart + ((year - minYear) / (maxYear - minYear)) * (axisEnd - axisStart);
  const labels = rows.map((row, index) => {
    const x = Math.round(xFor(row.year));
    const above = index % 2 === 0;
    const y = above ? 104 : 274;
    const stemEnd = above ? 145 : 215;
    const label = compactText(row.title, 34).replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char] ?? char);
    return `<line x1="${x}" y1="180" x2="${x}" y2="${stemEnd}" stroke="#2563eb" stroke-width="2"/><circle cx="${x}" cy="180" r="6" fill="#f97316" stroke="#ffffff" stroke-width="2"/><text x="${x}" y="${y}" text-anchor="middle" font-size="13" font-weight="600">${label}</text><text x="${x}" y="${above ? y + 18 : y + 18}" text-anchor="middle" font-size="12" fill="#475569">${row.year}</text>`;
  }).join("");
  const ticks = [...new Set(years)].sort((a, b) => a - b).map((year) => `<text x="${Math.round(xFor(year))}" y="205" text-anchor="middle" font-size="12" fill="#475569">${year}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="360" viewBox="0 0 ${width} 360"><rect width="100%" height="100%" fill="white"/><text x="70" y="48" font-size="24" font-weight="700" font-family="Arial, sans-serif">${title.replace(/[&<>]/g, "")}</text><line x1="${axisStart}" y1="180" x2="${axisEnd}" y2="180" stroke="#334155" stroke-width="3"/>${ticks}${labels}</svg>\n`;
}

function timelineLatex(rows: Array<{ id: string; title: string; year: number }>): string {
  const minYear = Math.min(...rows.map((row) => row.year));
  const maxYear = Math.max(...rows.map((row) => row.year));
  const span = Math.max(1, maxYear - minYear);
  const events = rows.map((row, index) => {
    const x = (((row.year - minYear) / span) * 13).toFixed(2);
    const y = index % 2 === 0 ? "1.7" : "-1.7";
    const anchor = index % 2 === 0 ? "south" : "north";
    return `\\draw[blue!65, thick] (${x},0) -- (${x},${y});\\filldraw[fill=orange!80,draw=white] (${x},0) circle (2.2pt);\\node[${anchor}, align=center, text width=2.2cm, font=\\scriptsize] at (${x},${y}) {${latexCell(compactText(row.title, 42))}\\\\{\\color{gray}${row.year}}};`;
  });
  return ["\\begin{tikzpicture}[baseline]", "\\draw[thick, draw=black!70] (0,0) -- (13,0);", ...events, "\\end{tikzpicture}", ""].join("\n");
}

function categoryCounts(sources: ClassifiedSource[], kind: "citation_depth" | "venue"): Array<{ label: string; count: number }> {
  const values = kind === "citation_depth"
    ? sources.map((source) => source.citation_depth)
    : sources.map((source) => source.venue || "Unknown venue");
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, kind === "venue" ? 10 : 4);
}

function categoryPlotSvg(title: string, rows: Array<{ label: string; count: number }>): string {
  const max = Math.max(1, ...rows.map((row) => row.count));
  const bars = rows.map((row, index) => {
    const width = Math.round((row.count / max) * 430);
    const y = 72 + index * 42;
    return `<text x="34" y="${y + 16}" font-size="13">${row.label.replace(/[<&]/g, "")}</text><rect x="210" y="${y}" width="${width}" height="24" fill="#2563eb"/><text x="${220 + width}" y="${y + 17}" font-size="12">${row.count}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="${Math.max(260, rows.length * 42 + 100)}" viewBox="0 0 720 ${Math.max(260, rows.length * 42 + 100)}"><rect width="100%" height="100%" fill="white"/><text x="34" y="34" font-size="20" font-weight="700">${title}</text>${bars}</svg>\n`;
}

function categoryPlotLatex(rows: Array<{ label: string; count: number }>, xlabel: string): string {
  // pgfplots uses commas both to separate symbolic categories and to separate
  // an x label from its y value in a coordinate.  Escape a literal comma in
  // exactly the same way in the declared category list and the coordinates;
  // otherwise a venue such as "arXiv:gr-qc,astro-ph.HE" compiles as a
  // different (truncated) category than the one declared on the axis.
  const category = (label: string) => latexCell(label).replace(/,/g, "{,}");
  const labels = rows.map((row) => category(row.label)).join(",");
  return [
    "\\begin{tikzpicture}",
    `\\begin{axis}[width=0.88\\linewidth,height=0.42\\linewidth,ybar,bar width=18pt,symbolic x coords={${labels}},xtick=data,x tick label style={rotate=30,anchor=east},ylabel={${xlabel}},ymajorgrids=true,grid style={dashed,gray!30},enlargelimits=0.15]`,
    `\\addplot+[fill=blue!65] coordinates {${rows.map((row) => `(${category(row.label)},${row.count})`).join(" ")}};`,
    "\\end{axis}", "\\end{tikzpicture}", "",
  ].join("\n");
}

async function metadataPlotIntents(workspaceDir: string): Promise<Array<{ id: string; metric: "publication_year" | "citation_depth" | "venue"; placement: z.infer<typeof Placement>; rationale: string }>> {
  try {
    const plan = AgenticArtifactPlan.parse(JSON.parse(await fs.readFile(path.join(workspaceDir, "reviews", "artifact-plan.json"), "utf-8")));
    return plan.intents
      .filter((intent) => intent.kind === "metadata_plot" && intent.section_id && intent.plot_metric)
      .map((intent) => ({ id: `metadata-${intent.plot_metric}`, metric: intent.plot_metric!, placement: { section_id: intent.section_id!, discussion: intent.rationale }, rationale: intent.rationale }));
  } catch {
    return [];
  }
}

function depthTableLatex(rows: Array<{ depth: string; count: number; share: number }>): string {
  return [
    "\\begin{tabular}{lrr}", "\\toprule", "Citation depth & Sources & Share \\\\", "\\midrule",
    ...rows.map((row) => `${row.depth} & ${row.count} & ${(row.share * 100).toFixed(1)}\\% ` + String.fromCharCode(92, 92)),
    "\\bottomrule", "\\end{tabular}", "",
  ].join("\n");
}

function latexCell(value: string): string {
  const urls: string[] = [];
  const shielded = value.replace(/https?:\/\/[^\s<>{}]+/g, (url) => {
    urls.push(url);
    return `@@LONGWRITEURL${urls.length - 1}@@`;
  });
  const escaped = shielded.replace(/([#$%&_{}])/g, "\\$1");
  return escaped.replace(/@@LONGWRITEURL(\d+)@@/g, (_, index: string) => `\\url{${urls[Number(index)]}}`);
}

async function taxonomyCoverage(workspaceDir: string): Promise<Array<{ cell: string; sourceCount: number; directCount: number }>> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(workspaceDir, "evidence", "coverage.json"), "utf-8")) as {
      taxonomy?: Array<{ cell?: unknown; source_count?: unknown; direct_source_count?: unknown }>;
    };
    return (raw.taxonomy ?? []).flatMap((row) => typeof row.cell === "string"
      ? [{ cell: row.cell, sourceCount: typeof row.source_count === "number" ? row.source_count : 0, directCount: typeof row.direct_source_count === "number" ? row.direct_source_count : 0 }]
      : []);
  } catch {
    return [];
  }
}

function taxonomyCoverageLatex(rows: Array<{ cell: string; sourceCount: number; directCount: number }>): string {
  return [
    "\\begin{tabular}{lrr}", "\\toprule", "Taxonomy cell & Sources & A/B-depth \\\\", "\\midrule",
    ...rows.map((row) => `${latexCell(row.cell)} & ${row.sourceCount} & ${row.directCount} ` + String.fromCharCode(92, 92)),
    "\\bottomrule", "\\end{tabular}", "",
  ].join("\n");
}

function compactTopic(source: ClassifiedSource): string {
  return source.topics.slice(0, 3).join(", ") || "unclassified";
}

function compactText(value: string, max = 54): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, Math.max(1, max - 1)).trimEnd()}…` : normalized;
}

function methodComparisonRows(sources: ClassifiedSource[]): string[][] {
  return sources
    .filter((source) => source.citation_depth === "A" || source.citation_depth === "B")
    .slice()
    .sort((a, b) => b.quality_score - a.quality_score)
    .slice(0, 16)
    .map((source) => [
      compactText(source.title),
      compactText(compactTopic(source), 38),
      source.citation_depth,
      source.metrics?.citation_count !== undefined ? String(source.metrics.citation_count) : "n/a",
      source.identifiers?.doi ? "DOI" : source.identifiers?.arxiv_id ? "arXiv" : source.identifiers?.semantic_scholar_id ? "S2" : "metadata",
    ]);
}

function benchmarkMetadataRows(sources: ClassifiedSource[]): string[][] {
  return sources
    .filter((source) => /benchmark|evaluation|dataset|leaderboard|metric/i.test(`${source.title} ${source.abstract} ${source.topics.join(" ")}`))
    .slice(0, 18)
    .map((source) => [
      compactText(source.title),
      String(source.year),
      compactText(source.venue, 28),
      source.identifiers?.doi ?? source.identifiers?.arxiv_id ?? source.identifiers?.semantic_scholar_id ?? "unresolved",
    ]);
}

function longTableLatex(headers: string[], rows: string[][], caption: string, id: string): string {
  // `p{...}` widths exclude the inter-column padding.  Keep it small inside
  // the local group so a six-column publication table fits the text block
  // without the overfull boxes caused by the default 6pt tabcolsep.
  const width = Math.max(0.12, Math.min(0.42, 0.94 / Math.max(1, headers.length))).toFixed(3);
  const columnSpec = `@{}${Array.from({ length: Math.max(1, headers.length) }, () => `>{\\raggedright\\arraybackslash}p{${width}\\linewidth}`).join("")}@{}`;
  const header = headers.map((value) => `\\textbf{${latexCell(value)}}`).join(" & ");
  const normalizedCaption = caption.replace(/^\s*Table\s+\d+\.\s*/i, "");
  return [
    "{\\small\\setlength{\\tabcolsep}{2pt}",
    `\\begin{longtable}{${columnSpec}}`,
    `\\caption{${latexCell(normalizedCaption)}}\\label{tab:${id}}\\\\`,
    "\\toprule", `${header} \\\\`, "\\midrule", "\\endfirsthead",
    `\\multicolumn{${Math.max(1, headers.length)}}{l}{\\small\\itshape Table \\thetable\\ continued from previous page}\\\\`,
    "\\toprule", `${header} \\\\`, "\\midrule", "\\endhead",
    ...rows.map((row) => `${row.map((cell) => latexCell(String(cell))).join(" & ")} \\\\`),
    "\\bottomrule", "\\end{longtable}", "}", "",
  ].join("\n");
}

type ConceptMap = NonNullable<z.infer<typeof PlacementPlan>["concept_map"]>;

function svgEscaped(value: string): string {
  return value.replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char] ?? char);
}

function svgLines(value: string, maxChars = 24): string[] {
  const words = value.trim().split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && `${line} ${word}`.length > maxChars) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

function conceptMapSvg(map: ConceptMap): string {
  const width = 980;
  const margin = 40;
  const gapX = 30;
  const gapY = 42;
  const columns = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(map.nodes.length))));
  const rows = Math.ceil(map.nodes.length / columns);
  const boxWidth = Math.floor((width - margin * 2 - gapX * (columns - 1)) / columns);
  const boxHeight = 88;
  const top = 94;
  const height = top + rows * boxHeight + Math.max(0, rows - 1) * gapY + 32;
  const positions = new Map(map.nodes.map((node, index) => [node.id, {
    x: margin + (index % columns) * (boxWidth + gapX),
    y: top + Math.floor(index / columns) * (boxHeight + gapY),
  }]));
  const arrows = map.edges.flatMap((edge) => {
    const from = positions.get(edge.from); const to = positions.get(edge.to);
    if (!from || !to) return [];
    const sx = from.x + boxWidth / 2; const sy = from.y + boxHeight / 2;
    const tx = to.x + boxWidth / 2; const ty = to.y + boxHeight / 2;
    return [`<path d="M ${sx} ${sy} L ${tx} ${ty}" stroke="#334155" stroke-width="2" marker-end="url(#arrow)"/>`];
  }).join("");
  const nodes = map.nodes.map((node) => {
    const position = positions.get(node.id)!;
    const lines = svgLines(node.label).map((line, index) => `<tspan x="${position.x + boxWidth / 2}" dy="${index === 0 ? 0 : 18}">${svgEscaped(line)}</tspan>`).join("");
    const firstBaseline = position.y + boxHeight / 2 - (svgLines(node.label).length - 1) * 9;
    return `<rect x="${position.x}" y="${position.y}" width="${boxWidth}" height="${boxHeight}" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/><text x="${position.x + boxWidth / 2}" y="${firstBaseline}" text-anchor="middle" font-size="15" font-family="Arial, sans-serif">${lines}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#334155"/></marker></defs><rect width="100%" height="100%" fill="white"/><text x="${margin}" y="42" font-size="24" font-weight="700" font-family="Arial, sans-serif">${svgEscaped(compactText(map.title, 78))}</text>${arrows}${nodes}</svg>\n`;
}

function conceptMapLatex(map: ConceptMap): string {
  const nodeNames = new Map(map.nodes.map((node, index) => [node.id, `conceptnode${index + 1}`]));
  // A bounded three-column grid preserves readable node widths even when an
  // LLM proposes a dense map. The old rank layout compressed seven nodes into
  // 2cm boxes and placed arrow labels directly over them.
  const columns = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(map.nodes.length))));
  const positions = new Map(map.nodes.map((node, index) => [node.id, {
    column: index % columns,
    row: Math.floor(index / columns),
  }]));
  const horizontalStep = 4.55;
  const verticalStep = 3.45;
  const nodeLines = map.nodes.map((node) => {
    const position = positions.get(node.id) ?? { column: 0, row: 0 };
    const x = (position.column * horizontalStep).toFixed(2);
    const y = (-position.row * verticalStep).toFixed(2);
    return `\\node[draw=blue!65, rounded corners=3pt, fill=blue!5, align=center, text width=3.15cm, minimum height=16mm] (${nodeNames.get(node.id)}) at (${x}cm,${y}cm) {${latexCell(compactText(node.label, 48))}};`;
  });
  const edgeLines = map.edges.flatMap((edge) => {
    const from = nodeNames.get(edge.from);
    const to = nodeNames.get(edge.to);
    if (!from || !to || from === to) return [];
    const label = edge.label ? ` node[midway, fill=white, inner sep=1pt, font=\\tiny, align=center, text width=1.45cm] {${latexCell(compactText(edge.label, 36))}}` : "";
    const source = positions.get(edge.from)!;
    const target = positions.get(edge.to)!;
    if (target.row === source.row && target.column > source.column) return [`\\draw[-{Latex[length=2mm]}, thick, draw=blue!65] (${from}.east) --${label} (${to}.west);`];
    if (target.row > source.row) return [`\\draw[-{Latex[length=2mm]}, thick, draw=blue!65] (${from}.south) to[out=-90,in=90,looseness=1.05]${label} (${to}.north);`];
    return [`\\draw[-{Latex[length=2mm]}, thick, draw=blue!65] (${from}.north) to[out=90,in=-90,looseness=1.05]${label} (${to}.south);`];
  });
  return [
    "\\begin{tikzpicture}[node distance=3mm, baseline]",
    ...edgeLines,
    ...nodeLines,
    "\\end{tikzpicture}",
    "",
  ].join("\n");
}

function mermaidLabel(value: string): string {
  return value.replace(/"/g, "'").replace(/[\r\n]+/g, " ").trim();
}

function conceptMapMermaid(map: ConceptMap): string {
  const nodeLines = map.nodes.map((node) => `  ${node.id}[\"${mermaidLabel(node.label)}\"]`);
  const edgeLines = map.edges.flatMap((edge) => {
    if (!map.nodes.some((node) => node.id === edge.from) || !map.nodes.some((node) => node.id === edge.to)) return [];
    return [`  ${edge.from} -->${edge.label ? `|${mermaidLabel(edge.label)}|` : ""} ${edge.to}`];
  });
  return ["flowchart LR", ...nodeLines, ...edgeLines, ""].join("\n");
}

function conceptMapPdfLatex(asset = "concept-map.pdf"): string {
  return [
    "\\begin{center}",
    `\\includegraphics[width=\\linewidth]{assets/${asset}}`,
    "\\end{center}",
    "",
  ].join("\n");
}

function sourceYearsPngLatex(): string {
  return [
    "\\begin{center}",
    "\\includegraphics[width=0.88\\linewidth]{assets/source-years-plot.png}",
    "\\end{center}",
    "",
  ].join("\n");
}

function nanobananaLatex(imagePath: string): string {
  return [
    "\\begin{center}",
    `\\includegraphics[width=0.78\\linewidth]{assets/${path.basename(imagePath)}}`,
    "\\end{center}",
    "",
  ].join("\n");
}

async function placement(workspaceDir: string): Promise<z.infer<typeof Placement>> {
  try {
    const outline = JSON.parse(await fs.readFile(path.join(workspaceDir, "outline.json"), "utf-8")) as { sections?: Array<{ id?: unknown; title?: unknown }> };
    const target = outline.sections?.find((section) => typeof section.id === "string" && /taxonomy|evidence|literature|background/i.test(String(section.title)))
      ?? outline.sections?.find((section) => typeof section.id === "string");
    if (target?.id && typeof target.id === "string") {
      return { section_id: target.id, discussion: "The corpus profile makes the evidence base and its recency distribution explicit." };
    }
  } catch {
    // Build can run before an LLM outline in fixture workspaces.
  }
  try {
    const chapter = (await fs.readdir(path.join(workspaceDir, "chapters"))).filter((file) => file.endsWith(".md")).sort()[0];
    if (chapter) return { section_id: path.basename(chapter, ".md"), discussion: "The corpus profile makes the evidence base and its recency distribution explicit." };
  } catch {
    // The validator will catch an unplaceable artifact later.
  }
  return { section_id: "section-1", discussion: "The corpus profile makes the evidence base and its recency distribution explicit." };
}

async function placementOverrides(workspaceDir: string): Promise<Map<string, z.infer<typeof Placement>>> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(workspaceDir, "figures", "placement-plan.json"), "utf-8");
  } catch {
    return new Map();
  }
  const plan = PlacementPlan.parse(JSON.parse(raw));
  return new Map(plan.placements.map((item) => [item.id, item.placement]));
}

type MetadataPlotProse = { insight: string; title?: string; caption?: string };

/** Planner-authored framing for verified metadata plots, keyed by metric. */
async function metadataPlotProse(workspaceDir: string): Promise<Map<string, MetadataPlotProse>> {
  try {
    const raw = await fs.readFile(path.join(workspaceDir, "figures", "placement-plan.json"), "utf-8");
    const plan = PlacementPlan.parse(JSON.parse(raw));
    return new Map((plan.metadata_plots ?? []).map((spec) => [spec.metric, spec]));
  } catch {
    return new Map();
  }
}

type TableSpecContract = z.infer<typeof TableSpec>;
type TimelineSpecContract = z.infer<typeof TimelineSpec>;
type DiagramSpecContract = z.infer<typeof DiagramSpec>;

/** Validate that every declarative table is source-bound before the renderer
 * writes any artifact. This lets the LLM choose a useful comparison question
 * without granting it arbitrary document-generation privileges. */
async function tableSpecs(workspaceDir: string, sources: ClassifiedSource[]): Promise<TableSpecContract[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(workspaceDir, "figures", "placement-plan.json"), "utf-8");
  } catch {
    return [];
  }
  const plan = PlacementPlan.parse(JSON.parse(raw));
  const knownSourceIds = new Set(sources.map((source) => source.id));
  const ids = new Set<string>();
  for (const spec of plan.table_specs ?? []) {
    if (ids.has(spec.id)) throw new Error(`table_specs contains duplicate or reserved id ${spec.id}`);
    ids.add(spec.id);
    if (spec.rows.some((row) => row.cells.length !== spec.headers.length)) {
      throw new Error(`table_specs.${spec.id} has a row with a different number of cells than headers`);
    }
    for (const row of spec.rows) {
      const unknown = row.source_ids.filter((id) => !knownSourceIds.has(id));
      if (unknown.length > 0) throw new Error(`table_specs.${spec.id} names unknown source IDs: ${unknown.join(", ")}`);
    }
  }
  return plan.table_specs ?? [];
}

/** Timeline coordinates are derived only from classified publication years.
 * The declaration supplies the analytical selection and narration, never
 * handwritten axes or dates. */
async function timelineSpecs(workspaceDir: string, sources: ClassifiedSource[]): Promise<Array<{ spec: TimelineSpecContract; rows: Array<{ id: string; title: string; year: number }> }>> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(workspaceDir, "figures", "placement-plan.json"), "utf-8");
  } catch {
    return [];
  }
  const plan = PlacementPlan.parse(JSON.parse(raw));
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const ids = new Set<string>(["source-years", "concept-map", "concept-illustration"]);
  return (plan.timelines ?? []).map((spec) => {
    if (ids.has(spec.id)) throw new Error(`timelines contains duplicate or reserved id ${spec.id}`);
    ids.add(spec.id);
    const sourceIds = [...new Set(spec.source_ids)];
    if (sourceIds.length < 3) throw new Error(`timelines.${spec.id} requires at least three distinct source_ids`);
    const rows = sourceIds.map((id) => {
      const source = sourceById.get(id);
      if (!source) throw new Error(`timelines.${spec.id} names unknown source ID ${id}`);
      return { id: source.id, title: source.title, year: source.year };
    }).sort((left, right) => left.year - right.year || left.title.localeCompare(right.title));
    return { spec, rows };
  });
}

/** The agent may choose any explanatory relationship, but every diagram must
 * name the evidence records that constrain its labels and connections. */
async function diagramSpecs(workspaceDir: string, sources: ClassifiedSource[]): Promise<DiagramSpecContract[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(workspaceDir, "figures", "placement-plan.json"), "utf-8");
  } catch {
    return [];
  }
  const plan = PlacementPlan.parse(JSON.parse(raw));
  const knownSourceIds = new Set(sources.map((source) => source.id));
  const ids = new Set(["source-years", "concept-map", "concept-illustration"]);
  for (const spec of plan.diagrams ?? []) {
    if (ids.has(spec.id)) throw new Error(`diagrams contains duplicate or reserved id ${spec.id}`);
    ids.add(spec.id);
    const unknown = spec.source_ids.filter((id) => !knownSourceIds.has(id));
    if (unknown.length > 0) throw new Error(`diagrams.${spec.id} names unknown source IDs: ${unknown.join(", ")}`);
    const nodeIds = new Set(spec.nodes.map((node) => node.id));
    for (const edge of spec.edges) {
      if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) throw new Error(`diagrams.${spec.id} has an edge that names an unknown node`);
    }
  }
  return plan.diagrams ?? [];
}

/** Read the small Mermaid diagrams produced by older workspaces and promote
 * them to a real figure contract. This is intentionally narrow: new runs use
 * visual_plan.concept_map, while this bridge prevents an existing expensive
 * run from printing raw diagram source in its manuscript. */
async function legacyMermaidConceptMap(workspaceDir: string): Promise<ConceptMap | null> {
  const chapterDir = path.join(workspaceDir, "chapters");
  let entries: string[];
  try {
    entries = (await fs.readdir(chapterDir)).filter((entry) => entry.endsWith(".md")).sort();
  } catch {
    return null;
  }
  for (const entry of entries) {
    const content = await fs.readFile(path.join(chapterDir, entry), "utf-8");
    const match = content.match(/```mermaid\s*\nflowchart\s+\w+\s*\n([\s\S]*?)```/i);
    if (!match) continue;
    const nodes = new Map<string, string>();
    for (const node of match[1].matchAll(/\b([A-Za-z][A-Za-z0-9_-]*)\[([^\]]+)\]/g)) {
      if (nodes.size >= 10) break;
      nodes.set(node[1], node[2].trim());
    }
    if (nodes.size < 3) continue;
    const edges: ConceptMap["edges"] = [];
    for (const line of match[1].split("\n")) {
      // Mermaid permits labels directly on node references (E[Evidence] -->
      // W[Write]). Remove only those brackets before reading the edge itself.
      const normalized = line.replace(/\[[^\]]*\]/g, "");
      const edge = normalized.match(/^\s*([A-Za-z][A-Za-z0-9_-]*)\s*-->(?:\|([^|]+)\|)?\s*([A-Za-z][A-Za-z0-9_-]*)/);
      if (!edge || !nodes.has(edge[1]) || !nodes.has(edge[3]) || edges.length >= 10) continue;
      edges.push({ from: edge[1], to: edge[3], ...(edge[2]?.trim() ? { label: edge[2].trim() } : {}) });
    }
    const before = content.slice(0, match.index ?? 0);
    const captionMatch = before.match(/\*\*Figure\s+\d+\.\s*([^*]+)\*\*\s*$/im);
    const title = (captionMatch?.[1].trim() || "Conceptual workflow").replace(/\.\s*$/, "");
    return {
      title,
      caption: `${title} The relationships are rendered from the chapter's evidence-grounded diagram contract.`,
      placement: {
        section_id: path.basename(entry, ".md"),
        discussion: "The accompanying figure makes the chapter's organizing relationship explicit.",
      },
      nodes: [...nodes].map(([id, label]) => ({ id, label })),
      edges,
    };
  }
  return null;
}

async function conceptMapForWorkspace(
  workspaceDir: string,
): Promise<ConceptMap | null> {
  try {
    const raw = await fs.readFile(path.join(workspaceDir, "figures", "placement-plan.json"), "utf-8");
    const plan = PlacementPlan.parse(JSON.parse(raw));
    if (plan.concept_map) return plan.concept_map;
  } catch {
    // A legacy inline Mermaid diagram is still an explicit authorial choice.
  }
  const legacy = await legacyMermaidConceptMap(workspaceDir);
  if (legacy) return legacy;
  return null;
}

function planMarkdown(sources: ClassifiedSource[], manifest: FigureManifest): string {
  const describe = (item: { id: string; title: string; path: string; latex_path: string; placement: { section_id: string }; caption: string; insight: string }) => [
    `### ${item.title}`, "", `- ID: ${item.id}`, `- Output: ${item.path}`, `- LaTeX: ${item.latex_path}`,
    `- Placement: ${item.placement.section_id}`, `- Caption: ${item.caption}`, `- Insight: ${item.insight || "not declared"}`, "",
  ];
  return [
    "# Figure Plan", "", "The manifest is a placement contract: every publication artifact is embedded in its assigned section and cited in nearby prose.", "",
    "## Figures", "", ...manifest.figures.flatMap(describe), "## Tables", "", ...manifest.tables.flatMap(describe),
    "## Coverage", "", `- Sources: ${sources.length}`, `- Years: ${yearCounts(sources).map((row) => row.year).join(", ")}`, "",
  ].join("\n");
}

export async function readFigureManifest(workspaceDir: string): Promise<FigureManifest | null> {
  try {
    return figureManifestSchema.parse(JSON.parse(await fs.readFile(path.join(workspaceDir, "figures", "manifest.json"), "utf-8")));
  } catch {
    return null;
  }
}

/** Truncate over-long descriptive text at a word boundary with an ellipsis so
 * the result fits within `max` (the ellipsis counts as one character). */
function clampText(value: unknown, max: number): { value: string; clamped: boolean } | null {
  if (typeof value !== "string") return null;
  if (value.length <= max) return { value, clamped: false };
  const slice = value.slice(0, max - 1);
  const lastSpace = slice.lastIndexOf(" ");
  const body = (lastSpace > Math.floor(max * 0.6) ? slice.slice(0, lastSpace) : slice).trimEnd();
  return { value: `${body}…`, clamped: true };
}

async function appendVisualPlanRepair(workspaceDir: string, message: string): Promise<void> {
  const reportPath = path.join(workspaceDir, "reports", "visual-plan-repair.md");
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.appendFile(reportPath, `- ${new Date().toISOString()}: ${message}\n`, "utf-8");
}

/** Set aside a placement plan the renderer cannot honor and let the build fall
 * back to default figures, exactly as it already does when the file is absent.
 * The original is preserved for inspection and the reason is recorded so the
 * next visual-plan round can re-emit a valid contract. */
async function rejectPlacementPlan(workspaceDir: string, planPath: string, raw: string, reason: string): Promise<void> {
  await fs.writeFile(path.join(workspaceDir, "figures", "placement-plan.rejected.json"), raw, "utf-8").catch(() => {});
  await fs.rm(planPath, { force: true });
  await appendVisualPlanRepair(workspaceDir, `Rejected an invalid figures/placement-plan.json (preserved as placement-plan.rejected.json) and rebuilt with default figures. Re-emit a corrected plan next round — ${reason}`);
}

/** The builder owns the rendered caption/title/insight text (see the spec
 * comments). Descriptive text that merely overflows a render cap must not crash
 * the whole manuscript build: clamp it deterministically and record the change.
 * If the plan is still invalid after clamping, set it aside so the renderer
 * degrades to defaults instead of throwing. On return, figures/placement-plan.
 * json is always valid against PlacementPlan or absent — never crash-inducing. */
export async function sanitizePlacementPlanFile(workspaceDir: string): Promise<void> {
  const planPath = path.join(workspaceDir, "figures", "placement-plan.json");
  let raw: string;
  try {
    raw = await fs.readFile(planPath, "utf-8");
  } catch {
    return; // absent: the renderer already degrades to default figures
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    await rejectPlacementPlan(workspaceDir, planPath, raw, `not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const clamps: string[] = [];
  const clampField = (owner: unknown, field: string, max: number, label: string): void => {
    if (!owner || typeof owner !== "object") return;
    const record = owner as Record<string, unknown>;
    const result = clampText(record[field], max);
    if (result?.clamped) { record[field] = result.value; clamps.push(`${label}.${field} (max ${max})`); }
  };
  const clampEntries = (list: unknown, label: string): void => {
    if (!Array.isArray(list)) return;
    list.forEach((item, index) => {
      clampField(item, "title", 180, `${label}[${index}]`);
      clampField(item, "caption", 500, `${label}[${index}]`);
      clampField(item, "insight", 800, `${label}[${index}]`);
    });
  };
  if (parsed && typeof parsed === "object") {
    const plan = parsed as Record<string, unknown>;
    clampField(plan.concept_map, "title", 180, "concept_map");
    clampField(plan.concept_map, "caption", 500, "concept_map");
    clampEntries(plan.table_specs, "table_specs");
    clampEntries(plan.timelines, "timelines");
    clampEntries(plan.diagrams, "diagrams");
    if (Array.isArray(plan.diagrams)) {
      plan.diagrams.forEach((diagram, index) => {
        if (!diagram || typeof diagram !== "object") return;
        const record = diagram as Record<string, unknown>;
        if (Array.isArray(record.nodes)) record.nodes.forEach((node, nodeIndex) => clampField(node, "label", 48, `diagrams[${index}].nodes[${nodeIndex}]`));
        if (Array.isArray(record.edges)) record.edges.forEach((edge, edgeIndex) => clampField(edge, "label", 36, `diagrams[${index}].edges[${edgeIndex}]`));
      });
    }
  }
  const result = PlacementPlan.safeParse(parsed);
  if (!result.success) {
    await rejectPlacementPlan(workspaceDir, planPath, raw, result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; "));
    return;
  }
  if (clamps.length > 0) {
    await fs.writeFile(planPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
    await appendVisualPlanRepair(workspaceDir, `Clamped over-long placement-plan text to render caps: ${clamps.join(", ")}.`);
  }
}

export async function buildFigureWorkspace(workspaceDir: string): Promise<string[]> {
  // Normalize/guard the model-authored placement plan first, so a merely
  // over-long caption cannot hard-fail the whole build with no repair path.
  await sanitizePlacementPlanFile(workspaceDir);
  const sources = await sourcesForWorkspace(workspaceDir);
  const years = yearCounts(sources);
  const depths = depthCounts(sources);
  const config = await loadProjectConfigIfExists(workspaceDir);
  // A full research release renders the readable Matplotlib PNG chart, which
  // preflight enforces. When Matplotlib is genuinely unavailable (a dry-run or
  // degraded environment), fall back to the deterministic pgfplots plot — the
  // same backend every other metadata plot already uses — so the manuscript
  // still compiles instead of referencing a PNG asset that was never rendered.
  const pythonPlotAvailable = await detectPython();
  const target = await placement(workspaceDir);
  const overrides = await placementOverrides(workspaceDir);
  const requestedMetadataIntents = await metadataPlotIntents(workspaceDir);
  const metadataProse = await metadataPlotProse(workspaceDir);
  const declaredTableSpecs = await tableSpecs(workspaceDir, sources);
  const declaredTimelines = await timelineSpecs(workspaceDir, sources);
  const declaredDiagrams = await diagramSpecs(workspaceDir, sources);
  const sourceYearsIntent = requestedMetadataIntents.find((intent) => intent.metric === "publication_year");
  const sourceYearsPlacement = overrides.get("source-years") ?? sourceYearsIntent?.placement ?? target;
  // Render only artifacts selected for an analytical purpose. Corpus depth,
  // venue, quality-score, and provider distributions are useful diagnostics in
  // the workspace, but are not paper figures unless the artifact planner
  // explicitly makes one part of the argument.
  const metadataIntents = requestedMetadataIntents;
  // A concept map is a reader-facing choice, not a fallback quota filler.
  // The visual planner must declare it (or an existing manuscript must carry
  // an explicit legacy Mermaid diagram) before it becomes a paper figure.
  const conceptMap = await conceptMapForWorkspace(workspaceDir);
  const plannedDiagrams = declaredDiagrams.map((spec) => ({
    id: spec.id,
    map: { title: spec.title, caption: spec.caption, placement: spec.placement, nodes: spec.nodes, edges: spec.edges } as ConceptMap,
    insight: spec.insight,
    sourceIds: spec.source_ids,
  }));
  const wantsNanobananaIllustration = overrides.has("concept-illustration");
  const empirical = await experimentPacket(workspaceDir);
  const experimentFigures = await importedExperimentFigures(workspaceDir, target);
  const repositoryFigures = await importedRepositoryFigures(workspaceDir, config?.research.repository_figures ?? [], target);
  const metadataFigures = metadataIntents.flatMap((intent) => {
    if (intent.metric === "publication_year") return [];
    const rows = categoryCounts(sources, intent.metric);
    const id = intent.id;
    const dataPath = intent.metric === "citation_depth" ? "data/source-depths.csv" : "data/source-venues.csv";
    const prose = metadataProse.get(intent.metric);
    return [{
      id,
      // A factual axis label is rendering vocabulary and may be supplied here.
      // The insight is the argument for the plot's presence, so it comes from
      // the planner or not at all — an empty one fails the insight gate rather
      // than passing on a sentence the renderer wrote.
      title: prose?.title ?? (intent.metric === "citation_depth" ? "Sources by citation depth" : "Top publication venues"),
      caption: prose?.caption ?? (intent.metric === "citation_depth"
        ? "Distribution of the classified corpus by citation depth, from verified source metadata."
        : "The most frequent publication venues in the classified corpus, from verified source metadata."),
      insight: prose?.insight ?? "",
      path: `figures/${id}.svg`, latex_path: `paper/figures/${id}.tex`, placement: overrides.get(id) ?? intent.placement,
      backend: "deterministic-svg" as const, data: [dataPath], rows, metric: intent.metric,
    }];
  });
  const manifest: FigureManifest = {
    version: 1,
    figures: [
      ...(sourceYearsIntent ? [{
        id: "source-years",
        title: metadataProse.get("publication_year")?.title ?? "Sources by publication year",
        caption: metadataProse.get("publication_year")?.caption ?? "Publication years of the classified source set, from verified source metadata.",
        insight: metadataProse.get("publication_year")?.insight ?? "",
        path: pythonPlotAvailable ? "figures/source-years-plot.png" : "figures/source-years.svg", latex_path: "paper/figures/source-years.tex", placement: sourceYearsPlacement,
        backend: (pythonPlotAvailable ? "python" : "deterministic-svg") as "python" | "deterministic-svg", data: ["data/source-years.csv"],
      }] : []),
      ...(conceptMap ? [{
        id: "concept-map", title: conceptMap.title, caption: conceptMap.caption,
        insight: conceptMap.insight ?? "",
        path: "figures/concept-map.svg", latex_path: "paper/figures/concept-map.tex", placement: conceptMap.placement,
        backend: "deterministic-svg" as const, data: ["data/concept-map.json"],
      }] : []),
      ...plannedDiagrams.map(({ id, map, insight }) => ({
        id, title: map.title, caption: map.caption, insight,
        path: `figures/${id}.svg`, latex_path: `paper/figures/${id}.tex`, placement: map.placement,
        backend: "deterministic-svg" as const, data: [`data/${id}.json`],
      })),
      ...metadataFigures.map(({ rows: _rows, metric: _metric, ...figure }) => figure),
      ...declaredTimelines.map(({ spec }) => ({
        id: spec.id, title: spec.title, caption: spec.caption, insight: spec.insight,
        path: `figures/${spec.id}.svg`, latex_path: `paper/figures/${spec.id}.tex`, placement: spec.placement,
        backend: "deterministic-svg" as const, data: [`data/${spec.id}.csv`],
      })),
      ...experimentFigures,
      ...repositoryFigures,
    ],
    tables: [
      ...declaredTableSpecs.map((spec) => ({
        id: spec.id, title: spec.title, caption: spec.caption, insight: spec.insight,
        path: `tables/${spec.id}.md`, latex_path: `paper/tables/${spec.id}.tex`, placement: spec.placement,
        backend: "deterministic-markdown" as const, layout: "longtable" as const,
        comparative: spec.comparative ?? /(?:comparison|matrix)/i.test(spec.kind), data: [`data/${spec.id}.csv`],
      })),
      ...(empirical ? [{
        id: "empirical-comparisons", title: "Verified empirical comparisons",
        caption: "Paired experimental comparisons are rendered directly from the audited LongExperiment packet; values are not transcribed from prose or a decorative chart.",
        insight: "The table exposes each treatment, baseline, effect estimate, confidence interval, and paired-seed count so the empirical claim can be audited independently.",
        path: "tables/empirical-comparisons.md", latex_path: "paper/tables/empirical-comparisons.tex", placement: target,
        backend: "experiment-summary" as const, layout: "longtable" as const, comparative: true, data: ["data/empirical-comparisons.csv", "evidence/experiment-packets.json"],
      }] : []),
    ],
  };
  const writes: Array<[string, string]> = [
    ["data/source-years.csv", csv([["year", "count"], ...years.map((row) => [row.year, row.count])])],
    ["data/source-depths.csv", csv([["citation_depth", "count", "share"], ...depths.map((row) => [row.depth, row.count, row.share.toFixed(4)])])],
    ["data/source-quality.csv", csv([["id", "title", "year", "citation_depth", "quality_score"], ...sources.map((source) => [source.id, source.title, source.year, source.citation_depth, source.quality_score.toFixed(2)])])],
    ["data/source-venues.csv", csv([["venue", "count"], ...categoryCounts(sources, "venue").map((row) => [row.label, row.count])])],
    ["figures/source-years.svg", sourceYearsSvg(years)],
    ...(conceptMap ? [
      ["data/concept-map.json", `${JSON.stringify(conceptMap, null, 2)}\n`] as [string, string],
      ["figures/concept-map.mmd", conceptMapMermaid(conceptMap)] as [string, string],
      ["figures/concept-map.svg", conceptMapSvg(conceptMap)] as [string, string],
      ["paper/figures/concept-map.tex", conceptMapLatex(conceptMap)] as [string, string],
    ] : []),
    ...plannedDiagrams.flatMap(({ id, map, sourceIds }) => [
      [`data/${id}.json`, `${JSON.stringify({ ...map, source_ids: sourceIds }, null, 2)}\n`] as [string, string],
      [`figures/${id}.mmd`, conceptMapMermaid(map)] as [string, string],
      [`figures/${id}.svg`, conceptMapSvg(map)] as [string, string],
      [`paper/figures/${id}.tex`, conceptMapLatex(map)] as [string, string],
    ]),
    ...(sourceYearsIntent ? [["paper/figures/source-years.tex", pythonPlotAvailable ? sourceYearsPngLatex() : sourceYearsLatex(years)] as [string, string]] : []),
    ...metadataFigures.flatMap((figure) => [
      [`figures/${figure.id}.svg`, categoryPlotSvg(figure.title, figure.rows)] as [string, string],
      [`paper/figures/${figure.id}.tex`, categoryPlotLatex(figure.rows, "Classified sources")] as [string, string],
    ]),
    ...declaredTimelines.flatMap(({ spec, rows }) => [
      [`data/${spec.id}.csv`, csv([["source_id", "title", "year"], ...rows.map((row) => [row.id, row.title, row.year])])] as [string, string],
      [`figures/${spec.id}.svg`, timelineSvg(spec.title, rows)] as [string, string],
      [`paper/figures/${spec.id}.tex`, timelineLatex(rows)] as [string, string],
    ]),
    ...(empirical ? (() => {
      const headers = ["Metric", "Treatment", "Baseline", "Delta", "95% CI", "Paired seeds"];
      const rows = empirical.comparisons.map((comparison) => [comparison.metric, comparison.treatment_condition, comparison.baseline_condition, comparison.estimate.toFixed(6), `[${comparison.confidence_interval.lower.toFixed(6)}, ${comparison.confidence_interval.upper.toFixed(6)}]`, String(comparison.paired_seeds.length)]);
      return [
        ["data/empirical-comparisons.csv", csv([headers, ...rows])] as [string, string],
        ["tables/empirical-comparisons.md", markdownTable(headers, rows)] as [string, string],
        ["paper/tables/empirical-comparisons.tex", longTableLatex(headers, rows, "Paired experimental comparisons derived from the verified LongExperiment result packet.", "empirical-comparisons")] as [string, string],
      ];
    })() : []),
    ...declaredTableSpecs.flatMap((spec) => {
      const rows = spec.rows.map((row) => row.cells);
      return [
        [`data/${spec.id}.csv`, csv([spec.headers, ...rows])] as [string, string],
        [`tables/${spec.id}.md`, markdownTable(spec.headers, rows)] as [string, string],
        [`paper/tables/${spec.id}.tex`, longTableLatex(spec.headers, rows, spec.caption, spec.id)] as [string, string],
      ];
    }),
    ["figures/manifest.json", `${JSON.stringify(manifest, null, 2)}\n`],
    ["figures/figure-plan.md", planMarkdown(sources, manifest)],
  ];
  const written: string[] = [];
  for (const [rel, content] of writes) {
    await fs.mkdir(path.dirname(path.join(workspaceDir, rel)), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, rel), content, "utf-8");
    written.push(rel);
  }
  // Mermaid is preferred when available because it preserves non-linear
  // lifecycle edges cleanly in the reader PDF. The deterministic TikZ/SVG
  // contract above remains the no-local-tool fallback.
  const mermaidDiagrams = [
    ...(conceptMap ? [{ id: "concept-map" }] : []),
    ...plannedDiagrams.map(({ id }) => ({ id })),
  ];
  for (const { id } of mermaidDiagrams) {
    if (!(await renderMermaidFile(workspaceDir, `figures/${id}.mmd`, `figures/${id}-untrimmed.pdf`)
      && await cropPdfFile(workspaceDir, `figures/${id}-untrimmed.pdf`, `figures/${id}.pdf`))) continue;
    const figure = manifest.figures.find((item) => item.id === id);
    if (!figure) continue;
    figure.path = `figures/${id}.pdf`;
    figure.backend = "mermaid";
    await fs.writeFile(path.join(workspaceDir, figure.latex_path), conceptMapPdfLatex(`${id}.pdf`), "utf-8");
    await fs.writeFile(path.join(workspaceDir, "figures", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    written.push(`figures/${id}-untrimmed.pdf`, `figures/${id}.pdf`, figure.latex_path, "figures/manifest.json");
  }
  // Mermaid/Python renderers still produce source assets and diagnostics. The
  // paid image backend joins the publication manifest only after it returns an
  // actual image plus provenance and we write a placement/LaTeX contract.
  const backends = await renderFigureBackends(workspaceDir);
  written.push(...backends.written);
  const nanobanana = wantsNanobananaIllustration
    ? await runNanobanana(workspaceDir)
    : { enabled: false, detail: "not selected by the visual plan", rendered: [], image: undefined };
  if (nanobanana.image) {
    const illustration = {
      id: "concept-illustration",
      title: "Conceptual illustration of the survey framing",
      caption: "Generated conceptual illustration used only as an orienting visual; the manuscript's evidence and quantitative claims are supported by the cited corpus and deterministic figures/tables.",
      insight: "The illustration is orienting only; it does not supply evidence or quantitative support for any manuscript claim.",
      path: nanobanana.image.path,
      latex_path: "paper/figures/concept-illustration.tex",
      placement: overrides.get("concept-illustration")!,
      backend: "nanobanana" as const,
      data: [nanobanana.image.provenancePath],
    };
    manifest.figures = manifest.figures.filter((figure) => figure.id !== illustration.id);
    manifest.figures.push(illustration);
    // The illustration is written outside the main artifact loop, which is
    // what creates `paper/figures/`. Now that no artifact is published unless
    // it was selected, an illustration can be the only one in the manuscript,
    // so this path can no longer assume an earlier figure made the directory.
    await fs.mkdir(path.dirname(path.join(workspaceDir, illustration.latex_path)), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, illustration.latex_path), nanobananaLatex(illustration.path), "utf-8");
    await fs.writeFile(path.join(workspaceDir, "figures", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    await fs.writeFile(path.join(workspaceDir, "figures", "figure-plan.md"), planMarkdown(sources, manifest), "utf-8");
    written.push(illustration.latex_path, "figures/manifest.json", "figures/figure-plan.md");
  }
  const reportPath = path.join(workspaceDir, "reports", "figures-build.md");
  await fs.appendFile(reportPath, `\n## nanobanana\n\n- Enabled: ${nanobanana.enabled ? "yes" : "no"}\n- ${nanobanana.detail}\n`, "utf-8").catch(() => {});
  // A placement naming an artifact that was never produced used to be dropped
  // in silence, so a planner asking for a retired built-in got no signal that
  // its request had been ignored. Name them instead: the plan is wrong, or the
  // artifact it depends on failed to render.
  const publishedIds = new Set([...manifest.figures, ...manifest.tables].map((item) => item.id));
  const unfulfilled = [...overrides.keys()].filter((id) => !publishedIds.has(id));
  if (unfulfilled.length > 0) {
    await appendVisualPlanRepair(workspaceDir, `placement-plan.json places ${unfulfilled.length} artifact(s) that were not produced and are absent from the manuscript: ${unfulfilled.join(", ")}. Either the id names no selectable artifact, or its renderer/backend did not run — see reports/figures-build.md.`);
  }
  return written;
}
