import fs from "node:fs/promises";
import path from "node:path";
import { CrossrefProvider } from "./crossref.js";
import { toJsonl } from "./jsonl.js";
import type { ResearchProvider } from "./providers.js";
import type { RawSource } from "./types.js";

export type MetadataUpgrade = {
  version: 1;
  source_id: string;
  status: "upgraded" | "no_match" | "skipped" | "failed";
  match_score?: number;
  fields?: string[];
  detail?: string;
};

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2));
}

function titleSimilarity(left: string, right: string): number {
  const a = tokens(left);
  const b = tokens(right);
  const intersection = [...a].filter((term) => b.has(term)).length;
  return intersection / Math.max(1, new Set([...a, ...b]).size);
}

function needsUpgrade(source: RawSource): boolean {
  return !source.identifiers?.doi || !source.metrics?.citation_count || /^(arxiv|preprint|unknown)$/i.test(source.venue);
}

function mergeUpgrade(source: RawSource, candidate: RawSource): { source: RawSource; fields: string[] } {
  const fields: string[] = [];
  const identifiers = { ...source.identifiers, ...candidate.identifiers };
  if (candidate.identifiers?.doi && !source.identifiers?.doi) fields.push("doi");
  const metrics = { ...source.metrics, ...candidate.metrics };
  if (candidate.metrics?.citation_count !== undefined && source.metrics?.citation_count === undefined) fields.push("citation_count");
  const venue = /^(arxiv|preprint|unknown)$/i.test(source.venue) && candidate.venue ? candidate.venue : source.venue;
  if (venue !== source.venue) fields.push("venue");
  const links = { ...source.links, ...candidate.links };
  if (candidate.links?.open_access_pdf && !source.links?.open_access_pdf) fields.push("open_access_pdf");
  return {
    source: {
      ...source,
      // Preserve provider identity and arXiv URL so full-text acquisition
      // remains stable; Crossref only fills missing bibliographic metadata.
      identifiers,
      ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
      ...(Object.keys(links).length > 0 ? { links } : {}),
      venue,
      abstract: source.abstract.length >= candidate.abstract.length ? source.abstract : candidate.abstract,
      authors: source.authors.length >= candidate.authors.length ? source.authors : candidate.authors,
    },
    fields,
  };
}

export async function enrichSourceMetadata(
  workspaceDir: string,
  opts: { maxSources?: number; provider?: ResearchProvider; enabled?: boolean } = {},
): Promise<{ upgrades: MetadataUpgrade[]; written: string[] }> {
  const raw = await fs.readFile(path.join(workspaceDir, "sources", "deduped_sources.jsonl"), "utf-8");
  const sources = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as RawSource);
  const upgrades: MetadataUpgrade[] = [];
  if (opts.enabled === false) {
    upgrades.push(...sources.map((source) => ({ version: 1 as const, source_id: source.id, status: "skipped" as const, detail: "metadata enrichment disabled for this provider" })));
  } else {
    const provider = opts.provider ?? new CrossrefProvider();
    let attempted = 0;
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index];
      if (!needsUpgrade(source)) {
        upgrades.push({ version: 1, source_id: source.id, status: "skipped", detail: "metadata already sufficiently complete" });
        continue;
      }
      if (attempted >= (opts.maxSources ?? 20)) {
        upgrades.push({ version: 1, source_id: source.id, status: "skipped", detail: "enrichment budget reached" });
        continue;
      }
      attempted += 1;
      try {
        const candidates = await provider.search(source.title, 5);
        const best = candidates
          .map((candidate) => ({ candidate, score: titleSimilarity(source.title, candidate.title) }))
          .sort((a, b) => b.score - a.score)[0];
        if (!best || best.score < 0.72) {
          upgrades.push({ version: 1, source_id: source.id, status: "no_match", match_score: best?.score });
          continue;
        }
        const merged = mergeUpgrade(source, best.candidate);
        sources[index] = merged.source;
        upgrades.push({ version: 1, source_id: source.id, status: "upgraded", match_score: best.score, fields: merged.fields });
      } catch (error) {
        upgrades.push({ version: 1, source_id: source.id, status: "failed", detail: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  const report = [
    "# Metadata Enrichment",
    "",
    `Upgraded: ${upgrades.filter((entry) => entry.status === "upgraded").length} · no match: ${upgrades.filter((entry) => entry.status === "no_match").length} · failed: ${upgrades.filter((entry) => entry.status === "failed").length} · skipped: ${upgrades.filter((entry) => entry.status === "skipped").length}`,
    "",
    ...upgrades.map((entry) => `- [${entry.status}] ${entry.source_id}${entry.fields?.length ? `: ${entry.fields.join(", ")}` : ""}${entry.detail ? `: ${entry.detail}` : ""}`),
    "",
  ].join("\n");
  await fs.mkdir(path.join(workspaceDir, "reports"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "sources", "deduped_sources.jsonl"), toJsonl(sources), "utf-8");
  await fs.writeFile(path.join(workspaceDir, "sources", "metadata-upgrades.jsonl"), toJsonl(upgrades), "utf-8");
  await fs.writeFile(path.join(workspaceDir, "reports", "metadata-enrichment.md"), report, "utf-8");
  return { upgrades, written: ["sources/deduped_sources.jsonl", "sources/metadata-upgrades.jsonl", "reports/metadata-enrichment.md"] };
}

