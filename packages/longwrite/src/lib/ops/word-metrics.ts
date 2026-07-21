import fs from "node:fs/promises";
import path from "node:path";
import { loadProjectConfigIfExists } from "../project-config.js";

export type WordMetricEntry = {
  path: string;
  words: number;
};

export type WordMetrics = {
  targetWords?: number;
  totalWords: number;
  percentOfTarget?: number;
  status: "no_target" | "short" | "on_track" | "long";
  manuscriptPath?: string;
  entries: WordMetricEntry[];
};

async function readIfExists(absPath: string): Promise<string | null> {
  try {
    return await fs.readFile(absPath, "utf-8");
  } catch {
    return null;
  }
}

function stripMarkup(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\\[a-zA-Z]+(?:\{[^}]*\})?/g, " ")
    .replace(/[#>*_\[\]{}()$\\|]/g, " ");
}

export function countWords(text: string): number {
  const stripped = stripMarkup(text);
  const latin = stripped.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g) ?? [];
  const cjk = stripped.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? [];
  return latin.length + cjk.length;
}

async function listFiles(dir: string, prefix: string, suffixes: string[]): Promise<WordMetricEntry[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const entries: WordMetricEntry[] = [];
  for (const name of names.sort()) {
    if (!suffixes.some((suffix) => name.endsWith(suffix))) continue;
    const abs = path.join(dir, name);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat?.isFile()) continue;
    const raw = await fs.readFile(abs, "utf-8");
    entries.push({ path: `${prefix}/${name}`, words: countWords(raw) });
  }
  return entries;
}

function status(totalWords: number, targetWords?: number): WordMetrics["status"] {
  if (!targetWords) return "no_target";
  if (totalWords < targetWords * 0.8) return "short";
  if (totalWords > targetWords * 1.2) return "long";
  return "on_track";
}

export async function computeWordMetrics(workspaceDir: string): Promise<WordMetrics> {
  const resolved = path.resolve(workspaceDir);
  const config = await loadProjectConfigIfExists(resolved);
  const targetWords = config?.writing.target_length_words;

  const manuscriptCandidates = [
    "build/manuscript.md",
    "build/manuscript.tex",
    "paper/main.tex",
  ];
  for (const rel of manuscriptCandidates) {
    const raw = await readIfExists(path.join(resolved, rel));
    if (raw !== null && raw.trim().length > 0) {
      const totalWords = countWords(raw);
      return {
        targetWords,
        totalWords,
        percentOfTarget: targetWords ? totalWords / targetWords : undefined,
        status: status(totalWords, targetWords),
        manuscriptPath: rel,
        entries: [{ path: rel, words: totalWords }],
      };
    }
  }

  const entries = [
    ...(await listFiles(path.join(resolved, "chapters"), "chapters", [".md", ".tex"])),
    ...(await listFiles(path.join(resolved, "paper", "sections"), "paper/sections", [".tex"])),
  ];
  const totalWords = entries.reduce((sum, entry) => sum + entry.words, 0);
  return {
    targetWords,
    totalWords,
    percentOfTarget: targetWords ? totalWords / targetWords : undefined,
    status: status(totalWords, targetWords),
    entries,
  };
}

export function wordMetricsToMarkdown(metrics: WordMetrics): string {
  const lines = [
    "# LongWrite Word Metrics",
    "",
    `Total words: ${metrics.totalWords}`,
    ...(metrics.targetWords ? [
      `Target words: ${metrics.targetWords}`,
      `Progress: ${Math.round((metrics.percentOfTarget ?? 0) * 100)}%`,
    ] : ["Target words: not configured"]),
    `Status: ${metrics.status}`,
    ...(metrics.manuscriptPath ? [`Manuscript source: ${metrics.manuscriptPath}`] : []),
    "",
    "## Files",
    "",
  ];
  if (metrics.entries.length === 0) {
    lines.push("- No manuscript, chapter, or section files found.");
  } else {
    for (const entry of metrics.entries) lines.push(`- ${entry.path}: ${entry.words} words`);
  }
  return `${lines.join("\n")}\n`;
}

export async function writeWordMetrics(workspaceDir: string): Promise<WordMetrics> {
  const resolved = path.resolve(workspaceDir);
  const metrics = await computeWordMetrics(resolved);
  await fs.mkdir(path.join(resolved, "reports"), { recursive: true });
  await fs.writeFile(path.join(resolved, "reports", "word-metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`, "utf-8");
  await fs.writeFile(path.join(resolved, "reports", "word-metrics.md"), wordMetricsToMarkdown(metrics), "utf-8");
  return metrics;
}
