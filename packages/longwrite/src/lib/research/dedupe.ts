import type { RawSource } from "./types.js";

function normalizedTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function canonicalUrl(url: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return url.trim().replace(/\/$/, "").toLowerCase() || undefined;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function metadataCompleteness(source: RawSource): number {
  return [
    source.authors.length > 0,
    source.year > 0,
    source.venue.length > 0,
    source.url.length > 0,
    source.abstract.length > 0,
    Boolean(source.identifiers?.doi),
    Boolean(source.identifiers?.arxiv_id),
    Boolean(source.identifiers?.semantic_scholar_id),
  ].filter(Boolean).length;
}

export function duplicateKeys(source: RawSource): string[] {
  const keys: string[] = [];
  if (source.identifiers?.doi) keys.push(`doi:${source.identifiers.doi.toLowerCase()}`);
  if (source.identifiers?.arxiv_id) keys.push(`arxiv:${source.identifiers.arxiv_id.toLowerCase()}`);
  if (source.identifiers?.semantic_scholar_id) {
    keys.push(`semantic-scholar:${source.identifiers.semantic_scholar_id.toLowerCase()}`);
  }
  if (source.identifiers?.dblp_key) keys.push(`dblp:${source.identifiers.dblp_key.toLowerCase()}`);
  if (source.identifiers?.openalex_id) keys.push(`openalex:${source.identifiers.openalex_id.toLowerCase()}`);
  if (source.identifiers?.openreview_id) keys.push(`openreview:${source.identifiers.openreview_id.toLowerCase()}`);
  const url = canonicalUrl(source.url);
  if (url) keys.push(`url:${url}`);
  const title = normalizedTitle(source.title);
  if (title && source.year > 0) keys.push(`title-year:${title}:${source.year}`);
  return keys;
}

function mergeSource(current: RawSource, incoming: RawSource): RawSource {
  const primary = metadataCompleteness(incoming) > metadataCompleteness(current) ? incoming : current;
  const secondary = primary === incoming ? current : incoming;
  return {
    ...primary,
    authors: unique([...primary.authors, ...secondary.authors]),
    topics: unique([...primary.topics, ...secondary.topics]),
    abstract: primary.abstract.length >= secondary.abstract.length ? primary.abstract : secondary.abstract,
    identifiers: {
      ...secondary.identifiers,
      ...primary.identifiers,
    },
    metrics: {
      ...secondary.metrics,
      ...primary.metrics,
    },
    links: {
      ...secondary.links,
      ...primary.links,
    },
    identity: {
      ...secondary.identity,
      ...primary.identity,
      provenance: [
        ...(secondary.identity?.provenance ?? []),
        ...(primary.identity?.provenance ?? []),
      ],
    },
    merged_from: unique([
      ...(current.merged_from ?? [current.id]),
      ...(incoming.merged_from ?? [incoming.id]),
    ]),
  };
}

export function dedupeSources(sources: RawSource[]): RawSource[] {
  const deduped: RawSource[] = [];
  const seen = new Map<string, number>();

  for (const source of sources) {
    const keys = duplicateKeys(source);
    const existingIndex = keys.map((key) => seen.get(key)).find((index) => index !== undefined);
    if (existingIndex === undefined) {
      const index = deduped.push(source) - 1;
      for (const key of keys) seen.set(key, index);
      continue;
    }

    const merged = mergeSource(deduped[existingIndex], source);
    deduped[existingIndex] = merged;
    for (const key of duplicateKeys(merged)) seen.set(key, existingIndex);
  }

  return deduped;
}
