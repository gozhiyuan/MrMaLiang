import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadCodebaseManifest } from "./codebase-contract.js";

export const CODEBASE_ANALYSIS_RAW_PATH = "evidence/codebase-analysis.raw.json";
export const CODEBASE_ANALYSIS_PATH = "evidence/codebase-analysis.json";

const LocatedStatement = z.object({
  summary: z.string().min(12).max(2_000),
  locators: z.array(z.string().min(1).max(1_000)).min(1).max(12),
}).strict();

const NamedLocatedStatement = LocatedStatement.extend({
  id: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  name: z.string().min(1).max(300),
}).strict();

const InterfaceStatement = LocatedStatement.extend({
  from: z.string().min(1).max(300),
  to: z.string().min(1).max(300),
  relationship: z.string().min(8).max(1_000),
}).strict();

const CodebaseArchitectureAnalysis = z.object({
  codebase_id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  summary: z.string().min(30).max(4_000),
  summary_locators: z.array(z.string().min(1).max(1_000)).min(1).max(12),
  components: z.array(NamedLocatedStatement).min(1).max(40),
  entrypoints: z.array(NamedLocatedStatement).max(30),
  interfaces: z.array(InterfaceStatement).max(50),
  data_control_flows: z.array(LocatedStatement).max(30),
  configuration_extension_points: z.array(NamedLocatedStatement).max(30),
  trust_boundaries: z.array(LocatedStatement).max(20),
  operational_limitations: z.array(LocatedStatement).max(30),
}).strict();

export const CodebaseAnalysisPacket = z.object({
  version: z.literal(1),
  codebases: z.array(CodebaseArchitectureAnalysis).min(1).max(10),
}).strict().superRefine((packet, ctx) => {
  const ids = new Set<string>();
  packet.codebases.forEach((codebase, index) => {
    if (ids.has(codebase.codebase_id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["codebases", index, "codebase_id"], message: `duplicate codebase_id ${codebase.codebase_id}` });
    }
    ids.add(codebase.codebase_id);
  });
});

export type CodebaseAnalysisPacket = z.infer<typeof CodebaseAnalysisPacket>;

const CodebaseChunk = z.object({
  id: z.string().min(1),
  codebase_id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  path: z.string().min(1),
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
  text: z.string(),
}).strict();

function unwrapFence(raw: string): { content: string; normalized: boolean } {
  const trimmed = raw.trim();
  const matched = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  return matched ? { content: matched[1]!.trim(), normalized: true } : { content: trimmed, normalized: false };
}

function locatorFor(chunk: z.infer<typeof CodebaseChunk>): string {
  return `[codebase:${chunk.codebase_id}:${chunk.path}#L${chunk.start_line}-L${chunk.end_line}]`;
}

function allLocators(codebase: z.infer<typeof CodebaseArchitectureAnalysis>): string[] {
  return [
    ...codebase.summary_locators,
    ...codebase.components.flatMap((item) => item.locators),
    ...codebase.entrypoints.flatMap((item) => item.locators),
    ...codebase.interfaces.flatMap((item) => item.locators),
    ...codebase.data_control_flows.flatMap((item) => item.locators),
    ...codebase.configuration_extension_points.flatMap((item) => item.locators),
    ...codebase.trust_boundaries.flatMap((item) => item.locators),
    ...codebase.operational_limitations.flatMap((item) => item.locators),
  ];
}

/** Validate the LLM-authored architecture dossier against the immutable Git
 * snapshot and its exact chunk locators. The script validates the model's
 * analytical move; it does not infer components or repair unsupported prose. */
export async function repairCodebaseAnalysis(workspaceDir: string): Promise<{ normalized: boolean; reportPath: string }> {
  const root = path.resolve(workspaceDir);
  const rawPath = path.join(root, CODEBASE_ANALYSIS_RAW_PATH);
  const targetPath = path.join(root, CODEBASE_ANALYSIS_PATH);
  const reportPath = path.join(root, "reports", "codebase-analysis-repair.md");
  const raw = await fs.readFile(rawPath, "utf8");
  const { content, normalized } = unwrapFence(raw);
  try {
    const [packet, manifest, chunkText] = await Promise.all([
      Promise.resolve(CodebaseAnalysisPacket.parse(JSON.parse(content))),
      loadCodebaseManifest(root),
      fs.readFile(path.join(root, "evidence", "codebase-chunks.jsonl"), "utf8"),
    ]);
    if (!manifest || manifest.codebases.length === 0) throw new Error("codebases/manifest.json contains no pinned codebases");
    const chunks = chunkText.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try { return CodebaseChunk.parse(JSON.parse(line)); }
      catch { throw new Error(`evidence/codebase-chunks.jsonl line ${index + 1} is invalid`); }
    });
    const manifestIds = new Set(manifest.codebases.map((entry) => entry.id));
    const packetIds = new Set(packet.codebases.map((entry) => entry.codebase_id));
    for (const id of manifestIds) if (!packetIds.has(id)) throw new Error(`analysis omits pinned codebase ${id}`);
    for (const id of packetIds) if (!manifestIds.has(id)) throw new Error(`analysis names unknown codebase ${id}`);
    const locatorOwners = new Map(chunks.map((chunk) => [locatorFor(chunk), chunk.codebase_id] as const));
    for (const codebase of packet.codebases) {
      for (const locator of allLocators(codebase)) {
        const owner = locatorOwners.get(locator);
        if (!owner) throw new Error(`codebase ${codebase.codebase_id} uses unknown or non-exact locator ${locator}`);
        if (owner !== codebase.codebase_id) throw new Error(`codebase ${codebase.codebase_id} uses locator owned by ${owner}: ${locator}`);
      }
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(targetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
    await fs.writeFile(reportPath, [
      "# Codebase architecture-analysis repair", "", "- Status: pass",
      `- Pinned codebases covered: ${packet.codebases.length}`,
      `- Components: ${packet.codebases.reduce((sum, item) => sum + item.components.length, 0)}`,
      `- Grounded locators: ${packet.codebases.reduce((sum, item) => sum + allLocators(item).length, 0)}`,
      `- Raw envelope normalized: ${normalized ? "yes" : "no"}`, "",
    ].join("\n"), "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, [
      "# Codebase architecture-analysis repair", "", "- Status: failed", `- Detail: ${detail}`,
      "- Required repair: produce one schema-valid architecture dossier covering every pinned codebase, with every statement grounded in an exact locator from evidence/codebase-chunks.jsonl.", "",
    ].join("\n"), "utf8");
    throw new Error(`${CODEBASE_ANALYSIS_RAW_PATH}: invalid codebase architecture analysis; see reports/codebase-analysis-repair.md`);
  }
  return { normalized, reportPath: "reports/codebase-analysis-repair.md" };
}
