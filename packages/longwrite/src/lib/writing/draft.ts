import fs from "node:fs/promises";
import path from "node:path";
import { parseJsonl } from "../research/jsonl.js";
import type { CitationPlanEntry, ClassifiedSource } from "../research/types.js";
import type { EvidencePacket } from "../research/evidence.js";

function sectionIdFromOutput(output: string): string {
  return path.basename(output, ".md");
}

function safeTitle(sectionId: string, plan?: CitationPlanEntry): string {
  return plan?.section_title ?? sectionId.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

async function readJsonl<T>(workspaceDir: string, rel: string): Promise<T[]> {
  const content = await fs.readFile(path.join(workspaceDir, rel), "utf-8");
  return parseJsonl<T>(content);
}

async function readEvidencePacket(workspaceDir: string, sectionId: string): Promise<EvidencePacket | null> {
  try {
    const safeId = sectionId.replace(/[^A-Za-z0-9._-]/g, "_");
    return JSON.parse(await fs.readFile(path.join(workspaceDir, "evidence", `section-${safeId}.json`), "utf-8")) as EvidencePacket;
  } catch {
    return null;
  }
}

export async function draftSectionWorkspace(workspaceDir: string, outputs: string[]): Promise<string[]> {
  const output = outputs.find((value) => value.startsWith("chapters/") && value.endsWith(".md"));
  if (!output) throw new Error("draft section command requires a concrete chapters/*.md output");

  const sectionId = sectionIdFromOutput(output);
  const [citationPlan, sources, evidence] = await Promise.all([
    readJsonl<CitationPlanEntry>(workspaceDir, "sources/citation_plan.jsonl"),
    readJsonl<ClassifiedSource>(workspaceDir, "sources/classified_sources.jsonl"),
    readEvidencePacket(workspaceDir, sectionId),
  ]);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const plan = citationPlan.find((entry) => entry.section_id === sectionId) ?? citationPlan[0];
  const chunks = evidence?.chunks.slice(0, 8) ?? [];
  if (chunks.length === 0) {
    throw new Error(`no evidence chunks available for ${sectionId}; run full-text indexing and evidence allocation before drafting`);
  }
  const selected = [...new Set(chunks.map((chunk) => chunk.source_id))]
    .filter((id) => sourceById.has(id));

  const lines = [
    `# ${safeTitle(sectionId, plan)}`,
    "",
    `This section summarizes the current evidence for ${safeTitle(sectionId, plan).toLowerCase()} ` +
      `using the prepared evidence packet [source:${chunks[0].id}].`,
    "",
    "## Source Notes",
    "",
    ...selected.flatMap((id) => {
      const source = sourceById.get(id)!;
      const chunk = chunks.find((candidate) => candidate.source_id === id)!;
      return [
        `- ${source.title} (${source.year}) supports this section's argument [source:${chunk.id}].`,
      ];
    }),
    "",
    "## Retrieved Evidence",
    "",
    ...chunks.slice(0, 6).map((chunk) =>
      `- [source:${chunk.id}] ${chunk.locator.heading ?? "source text"}, paragraph ${chunk.locator.paragraph}: ${chunk.text.slice(0, 360)}${chunk.text.length > 360 ? "..." : ""}`,
    ),
    "",
  ];

  const abs = path.join(workspaceDir, output);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, lines.join("\n"), "utf-8");
  return [output];
}
