import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadCodebaseManifest } from "./codebase-contract.js";

export const CODEBASE_COMPARISON_RAW_PATH = "evidence/codebase-comparison.raw.json";
export const CODEBASE_COMPARISON_PATH = "evidence/codebase-comparison.json";

const ComparisonRow = z.object({
  codebase_id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  purpose: z.string().min(20).max(2_000),
  architecture_summary: z.string().min(20).max(3_000),
  license: z.string().min(1).max(300).nullable(),
  extension_points: z.array(z.string().min(8).max(800)).max(12),
  limitations: z.array(z.string().min(8).max(1_000)).max(12),
  locators: z.array(z.string().min(1).max(1_000)).min(1).max(20),
}).strict();

const Comparison = z.object({
  dimension: z.string().min(3).max(300),
  codebase_ids: z.array(z.string().regex(/^[a-z][a-z0-9_-]*$/)).min(2).max(10),
  synthesis: z.string().min(30).max(3_000),
  locators: z.array(z.string().min(1).max(1_000)).min(2).max(30),
}).strict();

export const CodebaseComparisonPacket = z.object({
  version: z.literal(1),
  codebases: z.array(ComparisonRow).min(1).max(10),
  comparisons: z.array(Comparison).max(20),
}).strict();

type Chunk = { codebase_id: string; path: string; start_line: number; end_line: number };
function locator(chunk: Chunk): string { return `[codebase:${chunk.codebase_id}:${chunk.path}#L${chunk.start_line}-L${chunk.end_line}]`; }
function unwrap(raw: string): { content: string; normalized: boolean } {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  return match ? { content: match[1]!.trim(), normalized: true } : { content: trimmed, normalized: false };
}

export async function validateCodebaseComparison(workspaceDir: string, packet: z.infer<typeof CodebaseComparisonPacket>): Promise<void> {
  const root = path.resolve(workspaceDir);
  const [manifest, chunkRaw] = await Promise.all([
    loadCodebaseManifest(root),
    fs.readFile(path.join(root, "evidence", "codebase-chunks.jsonl"), "utf8"),
  ]);
  if (!manifest) throw new Error("codebases/manifest.json is missing");
  const ids = new Set(manifest.codebases.map((item) => item.id));
  const rows = new Set(packet.codebases.map((item) => item.codebase_id));
  for (const id of ids) if (!rows.has(id)) throw new Error(`comparison packet omits pinned codebase ${id}`);
  for (const id of rows) if (!ids.has(id)) throw new Error(`comparison packet names unknown codebase ${id}`);
  const owners = new Map(chunkRaw.split(/\r?\n/).filter(Boolean).map((line) => {
    const chunk = JSON.parse(line) as Chunk;
    return [locator(chunk), chunk.codebase_id] as const;
  }));
  for (const row of packet.codebases) for (const value of row.locators) {
    if (owners.get(value) !== row.codebase_id) throw new Error(`row ${row.codebase_id} uses unknown or foreign locator ${value}`);
  }
  for (const comparison of packet.comparisons) {
    const compared = new Set(comparison.codebase_ids);
    if (compared.size !== comparison.codebase_ids.length) throw new Error(`comparison ${comparison.dimension} repeats a codebase id`);
    for (const id of compared) if (!ids.has(id)) throw new Error(`comparison ${comparison.dimension} names unknown codebase ${id}`);
    const locatorOwners = new Set(comparison.locators.map((value) => {
      const owner = owners.get(value);
      if (!owner) throw new Error(`comparison ${comparison.dimension} uses unknown locator ${value}`);
      return owner;
    }));
    for (const id of compared) if (!locatorOwners.has(id)) throw new Error(`comparison ${comparison.dimension} has no locator from ${id}`);
  }
  if (ids.size > 1 && packet.comparisons.length === 0) throw new Error("multiple pinned codebases require at least one source-grounded comparison");
}

export async function repairCodebaseComparison(workspaceDir: string): Promise<{ normalized: boolean; reportPath: string }> {
  const root = path.resolve(workspaceDir);
  const rawPath = path.join(root, CODEBASE_COMPARISON_RAW_PATH);
  const targetPath = path.join(root, CODEBASE_COMPARISON_PATH);
  const reportPath = path.join(root, "reports", "codebase-comparison-repair.md");
  const { content, normalized } = unwrap(await fs.readFile(rawPath, "utf8"));
  try {
    const packet = CodebaseComparisonPacket.parse(JSON.parse(content));
    await validateCodebaseComparison(root, packet);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(targetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
    await fs.writeFile(reportPath, ["# Codebase comparison repair", "", "- Status: pass", `- Codebases: ${packet.codebases.length}`, `- Comparative dimensions: ${packet.comparisons.length}`, `- Raw envelope normalized: ${normalized ? "yes" : "no"}`, ""].join("\n"), "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, ["# Codebase comparison repair", "", "- Status: failed", `- Detail: ${detail}`, "- Required repair: cover every pinned repository and ground each row/comparison in exact codebase locators; multi-repository packets require at least one true cross-repository comparison.", ""].join("\n"), "utf8");
    throw new Error(`${CODEBASE_COMPARISON_RAW_PATH}: invalid repository comparison packet; see reports/codebase-comparison-repair.md`);
  }
  return { normalized, reportPath: "reports/codebase-comparison-repair.md" };
}
