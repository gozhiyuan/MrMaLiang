import fs from "node:fs/promises";
import path from "node:path";
import { marked } from "marked";
import { readFigureManifest, type FigureManifest } from "./figures.js";
import { compileLatex, writeLatexBuildReport } from "./latex-compile.js";
import { bibtexKey } from "../research/bibtex.js";
import { parseCitationMarker } from "../research/citation-markers.js";
import { parseJsonl } from "../research/jsonl.js";
import type { ClassifiedSource } from "../research/types.js";
import { loadProjectConfigIfExists } from "../project-config.js";
import { copyPublicationTemplateAssets, publicationDocumentClass } from "../publication.js";
import { publicationProvenanceSummary } from "../ops/workspace-lifecycle.js";
import { codebaseCitationKeys } from "../research/codebase.js";
import { CODEBASE_MARKER_RE } from "../research/codebase-contract.js";

type MarkdownToken = {
  type: string;
  text?: string;
  depth?: number;
  lang?: string;
  items?: MarkdownToken[];
  header?: MarkdownTableCell[];
  rows?: MarkdownTableCell[][];
};

// Marked v15 exposes table cells as token objects ({ text, tokens, ... }),
// while earlier releases exposed plain strings. Accept both so an LLM-written
// Markdown table cannot crash a later deterministic PDF rebuild.
type MarkdownTableCell = string | { text?: string };

type OutlineSection = { id: string; title: string };
type Chapter = { rel: string; id: string; content: string; title: string };
type CitationStyle = "numeric" | "author_year";

function escapeLatex(value: string): string {
  return value
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([#$%&_{}])/g, "\\$1")
    .replace(/\^/g, "\\textasciicircum{}")
    .replace(/~/g, "\\textasciitilde{}");
}

function latexPath(rel: string): string {
  return rel.replace(/^paper\//, "");
}

async function paperAbstract(workspaceDir: string): Promise<string> {
  const fallback = "This evidence-backed survey synthesizes the retrieved literature and distinguishes supported findings, inferences, and open questions.";
  try {
    const raw = await fs.readFile(path.join(workspaceDir, "paper", "abstract.md"), "utf-8");
    const body = raw.replace(/^\s*#\s*abstract\s*$/im, "").trim();
    return body || fallback;
  } catch {
    // Legacy workspaces predate the LLM abstract stage. They remain buildable,
    // but new research workflows require paper/abstract.md before a build.
    return fallback;
  }
}

/** Preserve mathematical notation only through conventional `$...$` or
 * `$$...$$` delimiters. The block renderer below handles display math; this
 * helper protects inline notation while escaping ordinary Markdown prose. */
function safeMath(value: string): string {
  return value.trim().replace(/\\(?:input|include|write|openout|read|catcode|usepackage|documentclass)\b/gi, "\\text{[unsafe command removed]}");
}

/** Citation conversion happens before escaping, then uses opaque tokens so
 * markdown punctuation cannot corrupt LaTeX commands. */
function inlineLatex(markdown: string, citeKeys: Map<string, string>, cited: Set<string>, citationStyle: CitationStyle = "numeric"): string {
  const replacements = new Map<string, string>();
  let index = 0;
  const sourceMarked = markdown.replace(/\[source:([^\]\s]+)\]/g, (whole, raw: string) => {
    const { sourceId } = parseCitationMarker(raw);
    const key = citeKeys.get(sourceId);
    if (!key) return whole;
    cited.add(sourceId);
    const token = `@@CITE${index++}@@`;
    replacements.set(token, citationStyle === "author_year" ? `\\citep{${key}}` : `\\cite{${key}}`);
    return token;
  });
  const marked = sourceMarked.replace(CODEBASE_MARKER_RE, (whole, id: string) => {
    const citationId = `codebase:${id}`;
    const key = citeKeys.get(citationId);
    if (!key) return whole;
    cited.add(citationId);
    const token = `@@CITE${index++}@@`;
    replacements.set(token, citationStyle === "author_year" ? `\\citep{${key}}` : `\\cite{${key}}`);
    return token;
  });
  const math = marked.replace(/\$([^$\n]+?)\$/g, (_, value: string) => {
    const token = `@@MATH${index++}@@`;
    replacements.set(token, `$${safeMath(value)}$`);
    return token;
  });
  let latex = escapeLatex(math)
    .replace(/`([^`]+)`/g, (_, code: string) => `\\texttt{${escapeLatex(code)}}`)
    .replace(/\*\*([^*]+)\*\*/g, "\\textbf{$1}")
    .replace(/\*([^*]+)\*/g, "\\emph{$1}");
  for (const [token, replacement] of replacements) latex = latex.replaceAll(token, replacement);
  return latex;
}

function tableCellText(cell: MarkdownTableCell): string {
  return typeof cell === "string" ? cell : cell.text ?? "";
}

type MarkdownTableContext = { sectionId: string; sectionTitle: string; ordinal: number };

/** LLM-authored Markdown tables must remain reader-sized in a PDF. They are
 * converted to independently captioned longtables instead of being shrunk to
 * fit one line, and manual Table N wording is neutralized in the prose so it
 * cannot conflict with LaTeX's real table numbering. */
function renderTable(
  header: MarkdownTableCell[],
  rows: MarkdownTableCell[][],
  citeKeys: Map<string, string>,
  cited: Set<string>,
  context: MarkdownTableContext,
  citationStyle: CitationStyle,
): string {
  // Account for tabular's internal padding as well as the declared p-column
  // widths. This prevents reader-authored six-column tables from overflowing
  // even when they need to span multiple pages.
  const width = Math.max(0.12, Math.min(0.45, 0.94 / Math.max(1, header.length))).toFixed(3);
  const columns = `@{}${Array.from({ length: Math.max(1, header.length) }, () => `>{\\raggedright\\arraybackslash}p{${width}\\linewidth}`).join("")}@{}`;
  const row = (cells: MarkdownTableCell[]) => `${cells.map((cell) => inlineLatex(tableCellText(cell), citeKeys, cited, citationStyle)).join(" & ")} \\\\`;
  return [
    "{\\small\\setlength{\\tabcolsep}{2pt}",
    `\\begin{longtable}{${columns}}`,
    `\\caption{Comparison in ${escapeLatex(context.sectionTitle)}}\\label{tab:${escapeLatex(context.sectionId)}-${context.ordinal}}\\\\`,
    "\\toprule", row(header), "\\midrule", "\\endfirsthead",
    `\\multicolumn{${Math.max(1, header.length)}}{l}{\\small\\itshape Table \\thetable\\ continued from previous page}\\\\`,
    "\\toprule", row(header), "\\midrule", "\\endhead",
    ...rows.map(row),
    "\\bottomrule", "\\end{longtable}", "}",
    "",
  ].join("\n");
}

function normalizeManualArtifactReferences(text: string): string {
  return text
    .replace(/\*\*Figure\s+\d+\.\s*[^*]+\*\*/gi, "")
    .replace(/\bTable\s+\d+\b/gi, "the accompanying table")
    .replace(/\bFigure\s+\d+\b/gi, "the accompanying figure");
}

/** A revision worker sometimes puts delivery directions intended for the
 * artifact builder into reader prose. They are neither manuscript content nor
 * a valid way to place an artifact, so omit the whole paragraph at render
 * time. This protects an otherwise valid rebuild while the next review asks
 * the writer for a reader-facing replacement. */
function isArtifactHandoffInstruction(text: string): boolean {
  return /\bplace this (?:completed|generated)\b[\s\S]*\bartifact\b/i.test(text)
    || /\brender a visible caption\b/i.test(text)
    || /\bkeep the caption and table together\b/i.test(text);
}

/** Render block Markdown through Marked's token tree rather than treating
 * pipes and headings as arbitrary lines. The outer chapter title is owned by
 * outline.json, so the first Markdown heading is intentionally discarded. */
function markdownToLatex(markdown: string, citeKeys: Map<string, string>, section: Pick<Chapter, "id" | "title">, citationStyle: CitationStyle): { latex: string; cited: Set<string> } {
  const cited = new Set<string>();
  const tokens = marked.lexer(markdown) as unknown as MarkdownToken[];
  const output: string[] = [];
  let consumedTitle = false;
  let tableOrdinal = 0;
  for (const token of tokens) {
    if (token.type === "heading") {
      if (!consumedTitle) {
        consumedTitle = true;
        continue;
      }
      const command = (token.depth ?? 2) <= 2 ? "subsection" : "subsubsection";
      output.push(`\\${command}{${inlineLatex(token.text ?? "", citeKeys, cited, citationStyle)}}`, "");
      continue;
    }
    if (token.type === "paragraph") {
      const paragraph = token.text ?? "";
      const displayMath = paragraph.match(/^\s*\$\$([\s\S]+?)\$\$\s*$/);
      if (displayMath) {
        output.push("\\[", safeMath(displayMath[1]!), "\\]", "");
      } else if (!isArtifactHandoffInstruction(paragraph)) {
        output.push(inlineLatex(normalizeManualArtifactReferences(paragraph), citeKeys, cited, citationStyle), "");
      }
      continue;
    }
    if (token.type === "list") {
      output.push("\\begin{itemize}");
      for (const item of token.items ?? []) output.push(`\\item ${inlineLatex(item.text ?? "", citeKeys, cited, citationStyle)}`);
      output.push("\\end{itemize}", "");
      continue;
    }
    if (token.type === "blockquote") {
      output.push("\\begin{quote}", inlineLatex(token.text ?? "", citeKeys, cited, citationStyle), "\\end{quote}", "");
      continue;
    }
    if (token.type === "code") {
      if (token.lang?.trim().toLowerCase() === "mermaid") {
        // visual_plan (or the legacy promotion bridge) owns the rendered,
        // captioned artifact. Never print Mermaid source in a reader PDF.
        continue;
      }
      output.push("\\begin{verbatim}", token.text ?? "", "\\end{verbatim}", "");
      continue;
    }
    if (token.type === "table") {
      tableOrdinal += 1;
      output.push(renderTable(token.header ?? [], token.rows ?? [], citeKeys, cited, { sectionId: section.id, sectionTitle: section.title, ordinal: tableOrdinal }, citationStyle));
    }
  }
  return { latex: output.join("\n"), cited };
}

async function loadCiteKeys(workspaceDir: string): Promise<Map<string, string>> {
  const keys = new Map<string, string>();
  try {
    const raw = await fs.readFile(path.join(workspaceDir, "sources", "classified_sources.jsonl"), "utf-8");
    for (const source of parseJsonl<ClassifiedSource>(raw)) keys.set(source.id, bibtexKey(source));
  } catch {
    // No sources (novel/book modes): retain normal prose without citations.
  }
  for (const [id, key] of await codebaseCitationKeys(workspaceDir)) keys.set(`codebase:${id}`, key);
  return keys;
}

function bibtexEntries(bibliography: string): Map<string, string> {
  const matches = [...bibliography.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)];
  const entries = new Map<string, string>();
  for (let index = 0; index < matches.length; index += 1) {
    const start = matches[index].index ?? 0;
    const end = matches[index + 1]?.index ?? bibliography.length;
    entries.set(matches[index][1], bibliography.slice(start, end).trim());
  }
  return entries;
}

/** `plain` is deliberately widely available, but it does not consistently
 * print DOI/URL fields.  Keep that portable style and promote a persistent
 * identifier to a normal BibTeX note so the reader PDF has a usable route
 * back to the evidence record. */
function withReaderVisibleIdentifier(entry: string): string {
  if (/\bnote\s*=\s*[{"']/i.test(entry)) return entry;
  const doi = entry.match(/\bdoi\s*=\s*[{"]([^}"]+)[}"]/i)?.[1]?.trim();
  const url = entry.match(/\burl\s*=\s*[{"]([^}"]+)[}"]/i)?.[1]?.trim();
  const identifier = doi
    ? `DOI: \\url{https://doi.org/${doi.replace(/^https?:\/\/doi\.org\//i, "")}}`
    : url
      ? `Available at: \\url{${url}}`
      : null;
  if (!identifier) return entry;
  const close = entry.lastIndexOf("}");
  return close < 0
    ? entry
    : `${entry.slice(0, close).trimEnd()},\n  note = {${identifier}}\n${entry.slice(close)}`;
}

function titleFromMarkdown(content: string, fallback: string): string {
  const token = (marked.lexer(content) as unknown as MarkdownToken[]).find((item) => item.type === "heading");
  return token?.text?.trim() || fallback;
}

async function readOutlineSections(workspaceDir: string): Promise<OutlineSection[]> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(workspaceDir, "outline.json"), "utf-8")) as { sections?: unknown };
    if (!Array.isArray(raw.sections)) return [];
    return raw.sections.flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const section = item as { id?: unknown; title?: unknown };
      return typeof section.id === "string" && typeof section.title === "string"
        ? [{ id: section.id, title: section.title }]
        : [];
    });
  } catch {
    return [];
  }
}

async function chapterFiles(workspaceDir: string): Promise<Chapter[]> {
  const chapterDir = path.join(workspaceDir, "chapters");
  let entries: string[];
  try {
    entries = await fs.readdir(chapterDir);
  } catch {
    return [];
  }
  const outline = new Map((await readOutlineSections(workspaceDir)).map((section) => [section.id, section.title]));
  const chapters: Chapter[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".md")).sort()) {
    const id = path.basename(entry, ".md");
    const content = await fs.readFile(path.join(chapterDir, entry), "utf-8");
    chapters.push({
      rel: path.join("chapters", entry),
      id,
      content,
      title: outline.get(id) ?? titleFromMarkdown(content, id.replace(/[-_]+/g, " ")),
    });
  }
  return chapters;
}

async function latexTitleAndAuthor(workspaceDir: string): Promise<{ title: string; author: string }> {
  const config = await loadProjectConfigIfExists(workspaceDir);
  const title = config?.research.topic ?? config?.project.name ?? "LongWrite Manuscript";
  if (config?.publication.anonymous) return { title, author: "Anonymous" };
  const authors = config?.project.authors ?? [];
  if (authors.length === 0) return { title, author: "LongWrite Agent" };
  const names = authors.map((author) => escapeLatex(author.name)).join(" \\and ");
  const emails = authors
    .map((author) => author.email)
    .filter((email): email is string => Boolean(email))
    .map((email) => `\\texttt{${escapeLatex(email)}}`)
    .join(" \\and ");
  return { title, author: emails ? `${names}\\\\${emails}` : names };
}

type PresentationConfig = {
  citation_style: CitationStyle;
  show_production_statistics: boolean;
  disclosure: {
    enabled: boolean;
    ai_use?: string;
    authorship?: string;
    correspondence?: string;
    last_updated?: string;
    version?: string;
    provenance: {
      enabled: boolean;
      include_longwrite: boolean;
      include_malaclaw: boolean;
      include_runtime_models: boolean;
    };
  };
};

async function disclosureLatex(presentation: PresentationConfig, workspaceDir: string, anonymous: boolean): Promise<string> {
  if (anonymous || !presentation.disclosure.enabled) return "";
  const provenance = presentation.disclosure.provenance.enabled
    ? await publicationProvenanceSummary(workspaceDir)
    : undefined;
  const provenanceParts = [
    ...(presentation.disclosure.provenance.include_longwrite && provenance?.maliang ? [provenance.maliang] : []),
    ...(presentation.disclosure.provenance.include_longwrite && provenance?.longwrite ? [`Writing component: ${provenance.longwrite}`] : []),
    ...(presentation.disclosure.provenance.include_malaclaw && provenance?.malaclaw ? [provenance.malaclaw] : []),
    ...(presentation.disclosure.provenance.include_runtime_models && provenance?.runtime_models.length ? [`Runtime/model units: ${provenance.runtime_models.join("; ")}`] : []),
  ];
  const note = [
    presentation.disclosure.ai_use ? `AI tools used: ${presentation.disclosure.ai_use}` : "",
    presentation.disclosure.authorship ? `Authorship note: ${presentation.disclosure.authorship}` : "",
    presentation.disclosure.correspondence ? `Correspondence: ${presentation.disclosure.correspondence}` : "",
    presentation.disclosure.last_updated ? `Last updated: ${presentation.disclosure.last_updated}` : "",
    presentation.disclosure.version ? `Version: ${presentation.disclosure.version}` : "",
    ...(provenanceParts.length ? [`Execution provenance: ${provenanceParts.join("; ")}`] : []),
  ].filter(Boolean).join(" ");
  return note ? ["\\begin{center}", "\\footnotesize\\textit{" + escapeLatex(note) + "}", "\\end{center}", ""].join("\n") : "";
}

function productionStatisticsLatex(
  presentation: PresentationConfig,
  stats: { citedSources: number; figures: number; tables: number; taxonomyCells: number; paperKind: string },
): string {
  if (!presentation.show_production_statistics) return "";
  const citationStyle = presentation.citation_style === "author_year" ? "author-year" : "numeric";
  return [
    "\\begin{center}", "\\small", "\\renewcommand{\\arraystretch}{1.12}",
    "\\begin{tabular}{lr|lr}", "\\toprule",
    "Metric & Value & Metric & Value \\\\", "\\midrule",
    `Cited sources & ${stats.citedSources} & Figures & ${stats.figures} \\\\`,
    `Tables & ${stats.tables} & Taxonomy cells & ${stats.taxonomyCells} \\\\`,
    `Paper kind & ${escapeLatex(stats.paperKind)} & Citation style & ${citationStyle} \\\\`,
    "\\bottomrule", "\\end{tabular}", "\\end{center}", "",
  ].join("\n");
}

function minimalPdf(): Buffer {
  return Buffer.from(
    "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R >> endobj\n4 0 obj << /Length 44 >> stream\nBT /F1 12 Tf 40 120 Td (LongWrite manuscript) Tj ET\nendstream endobj\nxref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000203 00000 n \ntrailer << /Root 1 0 R /Size 5 >>\nstartxref\n296\n%%EOF\n",
    "utf-8",
  );
}

function figureLatex(figure: FigureManifest["figures"][number]): string {
  return [
    "\\begin{figure}[htbp]",
    "\\centering",
    `\\input{${latexPath(figure.latex_path)}}`,
    `\\caption{${escapeLatex(readerCaption(figure.caption))}}`,
    // Labels and references are identifiers, not reader-facing text. Escaping
    // an underscore here changes the identifier and breaks the validator's
    // manifest-to-manuscript contract.
    `\\label{fig:${figure.id}}`,
    "\\end{figure}",
    "",
  ].join("\n");
}

function tableLatex(table: FigureManifest["tables"][number]): string {
  if (table.layout === "longtable") {
    // The generated longtable owns its caption and label so it can break
    // across pages at its declared in-section location; it cannot be nested
    // in a floating `table` environment.
    return [`\\input{${latexPath(table.latex_path)}}`, ""].join("\n");
  }
  return [
    "\\begin{table}[htbp]",
    "\\centering",
    `\\input{${latexPath(table.latex_path)}}`,
    `\\caption{${escapeLatex(readerCaption(table.caption))}}`,
    `\\label{tab:${table.id}}`,
    "\\end{table}",
    "",
  ].join("\n");
}

/** Numbering belongs to LaTeX labels. Planner captions often include an
 * advisory “Table 4.”/“Figure 2.” prefix, which becomes stale after any
 * placement change and is rejected by publication-layout validation. */
function readerCaption(value: string): string {
  return value.trim().replace(/^\s*(?:table|figure)\s+\d+\s*[.:]?\s*/i, "");
}

function placedArtifacts(sectionId: string, manifest: FigureManifest | null): string {
  if (!manifest) return "";
  const figures = manifest.figures.filter((figure) => figure.placement.section_id === sectionId);
  const tables = manifest.tables.filter((table) => table.placement.section_id === sectionId);
  return [
    ...figures.flatMap((figure) => [
      `The following figure supports this section's discussion of ${escapeLatex(readerCaption(figure.title).toLowerCase())}. Figure~\\ref{fig:${figure.id}} presents the visualization.`,
      "",
      figureLatex(figure),
    ]),
    ...tables.flatMap((table) => [
      `The following table supports this section's discussion of ${escapeLatex(readerCaption(table.title).toLowerCase())}. Table~\\ref{tab:${table.id}} summarizes the evidence.`,
      "",
      tableLatex(table),
    ]),
  ].join("\n");
}

export async function buildLatexWorkspace(workspaceDir: string): Promise<string[]> {
  const chapters = await chapterFiles(workspaceDir);
  if (chapters.length === 0) throw new Error("LaTeX build requires chapters/*.md");
  const figureManifest = await readFigureManifest(workspaceDir);
  const config = await loadProjectConfigIfExists(workspaceDir);
  const presentation: PresentationConfig = config?.publication.presentation ?? {
    citation_style: "numeric", show_production_statistics: false,
    disclosure: { enabled: false, provenance: { enabled: false, include_longwrite: true, include_malaclaw: true, include_runtime_models: true } },
  };
  const written: string[] = [];
  const paperDir = path.join(workspaceDir, "paper");
  await fs.mkdir(path.join(paperDir, "sections"), { recursive: true });
  await fs.mkdir(path.join(paperDir, "assets"), { recursive: true });
  await fs.mkdir(path.join(workspaceDir, "build"), { recursive: true });
  const templateAssets = await copyPublicationTemplateAssets(workspaceDir, paperDir);

  // Keep every placed binary asset alongside main.tex. This makes paper/ a
  // portable submission source tree rather than a source file that only works
  // from inside the LongWrite workspace.
  const copiedAssets: string[] = [];
  for (const figure of figureManifest?.figures ?? []) {
    const source = path.join(workspaceDir, figure.path);
    const target = path.join(paperDir, "assets", path.basename(figure.path));
    const exists = await fs.stat(source).catch(() => null);
    if (!exists?.isFile()) continue;
    await fs.copyFile(source, target);
    copiedAssets.push(path.relative(workspaceDir, target));
  }

  const citeKeys = await loadCiteKeys(workspaceDir);
  const citedIds = new Set<string>();
  for (const chapter of chapters) {
    const converted = markdownToLatex(chapter.content, citeKeys, chapter, presentation.citation_style);
    for (const id of converted.cited) citedIds.add(id);
    const rel = path.join("paper", "sections", `${chapter.id}.tex`);
    const body = [
      `\\section{${escapeLatex(chapter.title)}}`,
      "",
      converted.latex.trim(),
      "",
      placedArtifacts(chapter.id, figureManifest).trim(),
      "",
    ].join("\n");
    await fs.writeFile(path.join(workspaceDir, rel), body, "utf-8");
    written.push(rel);
  }

  const [scholarlyBibliography, codebaseBibliography] = await Promise.all([
    fs.readFile(path.join(workspaceDir, "sources", "bibliography.bib"), "utf-8").catch(() => ""),
    fs.readFile(path.join(workspaceDir, "sources", "codebases.bib"), "utf-8").catch(() => ""),
  ]);
  const bibliography = [scholarlyBibliography, codebaseBibliography].filter((value) => value.trim()).join("\n\n");
  const citedKeys = new Set([...citedIds].map((id) => citeKeys.get(id)).filter((key): key is string => Boolean(key)));
  const entries = bibtexEntries(bibliography);
  const selectedBibliography = citedKeys.size > 0 && [...citedKeys].every((key) => entries.has(key))
    ? [...citedKeys].sort().map((key) => entries.get(key)!).join("\n\n") + "\n"
    : bibliography;
  const renderedBibliography = [...bibtexEntries(selectedBibliography).values()]
    .map(withReaderVisibleIdentifier)
    .join("\n\n") + (selectedBibliography.trim() ? "\n" : "");
  await fs.writeFile(path.join(paperDir, "references.bib"), renderedBibliography, "utf-8");
  written.push("paper/references.bib");

  const metadata = await latexTitleAndAuthor(workspaceDir);
  const abstract = await paperAbstract(workspaceDir);
  const documentClass = await publicationDocumentClass(workspaceDir);
  const inputs = chapters.map((chapter) => `\\input{sections/${chapter.id}.tex}`).join("\n");
  const mainTex = [
    `\\documentclass${documentClass.options.length ? `[${documentClass.options.join(",")}]` : ""}{${documentClass.name}}`,
    "\\usepackage[margin=1in]{geometry}",
    ...(presentation.citation_style === "author_year" ? ["\\usepackage[round,authoryear]{natbib}"] : []),
    "\\usepackage{hyperref}",
    "\\hypersetup{hidelinks}",
    "\\usepackage{graphicx}",
    "\\usepackage{booktabs}",
    "\\usepackage{array}",
    "\\usepackage{longtable}",
    "\\usepackage{amsmath,amssymb}",
    "\\usepackage{pgfplots}",
    "\\pgfplotsset{compat=1.17}",
    "\\usetikzlibrary{arrows.meta,positioning}",
    "\\usepackage{placeins}",
    `\\title{${escapeLatex(metadata.title)}}`,
    `\\author{${metadata.author}}`,
    "\\date{}",
    "\\begin{document}",
    "\\maketitle",
    await disclosureLatex(presentation, workspaceDir, config?.publication.anonymous ?? false),
    "\\begin{abstract}",
    escapeLatex(abstract).replace(/\n{2,}/g, "\n\\par\n"),
    "\\end{abstract}",
    productionStatisticsLatex(presentation, {
      citedSources: citedIds.size,
      figures: figureManifest?.figures.length ?? 0,
      tables: figureManifest?.tables.length ?? 0,
      taxonomyCells: config?.research.taxonomy.length ?? 0,
      paperKind: config?.research.paper_kind ?? "survey",
    }),
    inputs,
    ...(citedIds.size > 0 ? [] : ["\\nocite{*}"]),
    presentation.citation_style === "author_year" ? "\\bibliographystyle{plainnat}" : "\\bibliographystyle{plain}",
    "\\bibliography{references}",
    "\\end{document}",
    "",
  ].join("\n");
  await fs.writeFile(path.join(paperDir, "main.tex"), mainTex, "utf-8");
  await fs.writeFile(path.join(workspaceDir, "build", "manuscript.tex"), mainTex, "utf-8");
  await fs.writeFile(path.join(workspaceDir, "build", "manuscript.pdf"), minimalPdf());
  written.push("paper/main.tex", "build/manuscript.tex", "build/manuscript.pdf", ...copiedAssets, ...templateAssets);

  const compileResult = await compileLatex(workspaceDir);
  written.push(await writeLatexBuildReport(workspaceDir, compileResult));
  return written;
}
