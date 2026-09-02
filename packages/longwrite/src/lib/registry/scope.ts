import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { slugify } from "./ids.js";

export type ScopeKind = "global" | "section" | "taxonomy_cell";
export const GLOBAL_SCOPE = "";

/** A machine-safe key for a human label the operator configured. Reuses the
 * same `slugify` as `taxonomyGateId`, so a cell's gate id and its observation
 * scope are derived from one function and cannot disagree. */
export function scopeKey(kind: ScopeKind, label: string): string {
  if (kind === "global") return GLOBAL_SCOPE;
  return `${kind.replace(/_/g, "-")}-${slugify(label)}`;
}

export const ScopeRecord = z.object({
  key: z.string().min(1),
  kind: z.enum(["section", "taxonomy_cell"]),
  label: z.string().min(1),
}).strict();

const INDEX = path.join("reports", "scope-index.json");

export async function writeScopeIndex(workspaceDir: string, records: unknown[]): Promise<string> {
  const parsed = records.map((record) => ScopeRecord.parse(record));
  const target = path.join(workspaceDir, INDEX);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify({ version: 1, scopes: parsed }, null, 2)}\n`, "utf-8");
  return INDEX;
}

/** The key is what the kernel stores; the label is what an operator reads. */
export async function scopeLabel(workspaceDir: string, key: string): Promise<string> {
  const raw = await fs.readFile(path.join(workspaceDir, INDEX), "utf-8").catch(() => null);
  if (raw === null) return key;
  const parsed = z.object({ version: z.literal(1), scopes: z.array(ScopeRecord) }).safeParse(JSON.parse(raw));
  return parsed.success ? (parsed.data.scopes.find((r) => r.key === key)?.label ?? key) : key;
}
