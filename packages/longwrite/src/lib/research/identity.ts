import fs from "node:fs/promises";
import path from "node:path";
import { parseJsonl } from "./jsonl.js";
import { toJsonl } from "./jsonl.js";
import type { ClassifiedSource, SourceIdentity } from "./types.js";

export type SourceIdentityRecord = SourceIdentity & {
  source_id: string;
  title: string;
  source_provider: string;
};

function canonicalUrl(source: ClassifiedSource): string {
  return source.links?.canonical_url
    ?? source.identity?.canonical_url
    ?? (source.identifiers?.doi ? `https://doi.org/${source.identifiers.doi}` : undefined)
    ?? (source.identifiers?.arxiv_id ? `https://arxiv.org/abs/${source.identifiers.arxiv_id.replace(/v\d+$/, "")}` : undefined)
    ?? source.url;
}

function arxivVersion(arxivId?: string): string | undefined {
  const match = arxivId?.match(/v(\d+)$/);
  return match ? `v${match[1]}` : undefined;
}

function provenance(field: string, provider: string, value: string, confidence: number): NonNullable<SourceIdentity["provenance"]>[number] {
  return { field, provider, value, confidence };
}

export function reconcileSourceIdentity(source: ClassifiedSource): SourceIdentityRecord {
  const doi = source.identifiers?.doi ?? source.identity?.doi;
  const arxivId = source.identifiers?.arxiv_id ?? source.identity?.arxiv_id;
  const canonical = canonicalUrl(source);
  const venue = source.identity?.venue ?? source.venue;
  const citationCount = source.metrics?.citation_count ?? source.identity?.citation_count;
  const provider = source.source;
  const identity: SourceIdentityRecord = {
    source_id: source.id,
    title: source.title,
    source_provider: provider,
    canonical_url: canonical,
    ...(doi ? { doi } : {}),
    ...(arxivId ? { arxiv_id: arxivId } : {}),
    ...(arxivVersion(arxivId) ? { arxiv_version: arxivVersion(arxivId) } : {}),
    ...(source.identifiers?.semantic_scholar_id ? { semantic_scholar_id: source.identifiers.semantic_scholar_id } : {}),
    ...(source.identifiers?.dblp_key ? { dblp_key: source.identifiers.dblp_key } : {}),
    ...(source.identifiers?.openalex_id ? { openalex_id: source.identifiers.openalex_id } : {}),
    ...(source.identifiers?.openreview_id ? { openreview_id: source.identifiers.openreview_id } : {}),
    ...(source.links?.publisher_url ? { publisher_url: source.links.publisher_url } : {}),
    ...(source.links?.accepted_version ? { accepted_version_url: source.links.accepted_version } : {}),
    venue,
    publication_status: source.source === "arxiv" && !doi ? "preprint" : "published_or_indexed",
    ...(citationCount !== undefined ? { citation_count: citationCount, citation_count_source: source.identity?.citation_count_source ?? provider } : {}),
    confidence: doi || arxivId || source.identifiers?.semantic_scholar_id || source.identifiers?.openalex_id ? 0.9 : 0.6,
    provenance: [
      ...(source.identity?.provenance ?? []),
      provenance("canonical_url", provider, canonical, 0.75),
      ...(doi ? [provenance("doi", provider, doi, 0.9)] : []),
      ...(arxivId ? [provenance("arxiv_id", provider, arxivId, 0.9)] : []),
      ...(venue ? [provenance("venue", provider, venue, 0.7)] : []),
    ],
  };
  return identity;
}

export async function reconcileWorkspaceSources(workspaceDir: string): Promise<{ records: SourceIdentityRecord[]; written: string[] }> {
  const raw = await fs.readFile(path.join(workspaceDir, "sources", "classified_sources.jsonl"), "utf-8");
  const sources = parseJsonl<ClassifiedSource>(raw);
  const records = sources.map(reconcileSourceIdentity);
  const missingStrongId = records.filter((record) => !record.doi && !record.arxiv_id && !record.semantic_scholar_id && !record.openalex_id);
  const byProvider = new Map<string, number>();
  for (const record of records) byProvider.set(record.source_provider, (byProvider.get(record.source_provider) ?? 0) + 1);
  await fs.mkdir(path.join(workspaceDir, "sources"), { recursive: true });
  await fs.mkdir(path.join(workspaceDir, "reports"), { recursive: true });
  const report = [
    "# Source Identity Reconciliation",
    "",
    `Sources: ${records.length}`,
    `Missing DOI/arXiv/S2/OpenAlex strong id: ${missingStrongId.length}`,
    "",
    "## Provider Coverage",
    "",
    ...[...byProvider.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([provider, count]) => `- ${provider}: ${count}`),
    "",
  ].join("\n");
  const written = ["sources/source-identities.jsonl", "reports/source-identities.md"];
  await Promise.all([
    fs.writeFile(path.join(workspaceDir, written[0]), toJsonl(records), "utf-8"),
    fs.writeFile(path.join(workspaceDir, written[1]), report, "utf-8"),
  ]);
  return { records, written };
}
