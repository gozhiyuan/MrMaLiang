import type { ResearchProvider } from "./providers.js";
import type { RawSource } from "./types.js";
import { ProviderRequestLimiter } from "./rate-limit.js";

const OPENALEX_WORKS_API = "https://api.openalex.org/works";

type OpenAlexAuthor = {
  author?: { display_name?: unknown };
};

type OpenAlexLocation = {
  landing_page_url?: unknown;
  pdf_url?: unknown;
};

type OpenAlexWork = {
  id?: unknown;
  doi?: unknown;
  display_name?: unknown;
  publication_year?: unknown;
  primary_location?: OpenAlexLocation | null;
  open_access?: { oa_url?: unknown };
  authorships?: unknown;
  primary_topic?: { display_name?: unknown };
  topics?: unknown;
  cited_by_count?: unknown;
  abstract_inverted_index?: unknown;
  primary_location_source?: unknown;
  host_venue?: unknown;
};

type OpenAlexResponse = {
  results?: unknown;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
}

function topicTerms(topic: string): string[] {
  return [...new Set(topic.toLowerCase().split(/\s+/).map((t) => t.replace(/[^a-z0-9-]/g, "")).filter(Boolean))];
}

function normalizeDoi(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  return raw.replace(/^https?:\/\/doi\.org\//i, "").toLowerCase();
}

function sourceId(title: string, year: number, openalexId?: string): string {
  return `${slug(title) || "openalex"}-${year}-${slug(openalexId ?? title).slice(0, 16) || "record"}`;
}

function invertedIndexToText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const entries = Object.entries(value as Record<string, unknown>)
    .flatMap(([word, positions]) => Array.isArray(positions) ? positions.map((pos) => ({ word, pos })) : [])
    .filter((entry): entry is { word: string; pos: number } => typeof entry.pos === "number")
    .sort((a, b) => a.pos - b.pos);
  return entries.map((entry) => entry.word).join(" ");
}

function normalizeAuthors(value: unknown): string[] {
  if (!Array.isArray(value)) return ["Unknown OpenAlex Author"];
  const authors = value
    .map((authorship: OpenAlexAuthor) => asString(authorship.author?.display_name))
    .filter((author): author is string => Boolean(author));
  return authors.length > 0 ? authors : ["Unknown OpenAlex Author"];
}

function sourceDisplayName(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  return asString((value as Record<string, unknown>).display_name);
}

function normalizeTopics(work: OpenAlexWork, query: string): string[] {
  const topics = Array.isArray(work.topics)
    ? work.topics.map((topic) => topic && typeof topic === "object" ? asString((topic as Record<string, unknown>).display_name) : undefined)
    : [];
  return [...new Set([...topicTerms(query), ...topics.filter((topic): topic is string => Boolean(topic))])];
}

export function normalizeOpenAlexResponse(payload: OpenAlexResponse, query: string): RawSource[] {
  const works = Array.isArray(payload.results) ? payload.results as OpenAlexWork[] : [];
  return works.map((work) => {
    const title = asString(work.display_name) ?? "Untitled OpenAlex work";
    const year = asNumber(work.publication_year) ?? new Date().getUTCFullYear();
    const openalexId = asString(work.id);
    const doi = normalizeDoi(work.doi);
    const landing = asString(work.primary_location?.landing_page_url);
    const pdf = asString(work.primary_location?.pdf_url) ?? asString(work.open_access?.oa_url);
    const venue = sourceDisplayName(work.primary_location_source)
      ?? sourceDisplayName(work.host_venue)
      ?? "OpenAlex";
    const citationCount = asNumber(work.cited_by_count);
    const canonicalUrl = openalexId ?? (doi ? `https://doi.org/${doi}` : landing);
    return {
      id: sourceId(title, year, openalexId),
      title,
      authors: normalizeAuthors(work.authorships),
      year,
      venue,
      url: landing ?? canonicalUrl ?? "https://openalex.org",
      abstract: invertedIndexToText(work.abstract_inverted_index),
      source: "openalex",
      topics: normalizeTopics(work, query),
      identifiers: {
        ...(doi ? { doi } : {}),
        ...(openalexId ? { openalex_id: openalexId } : {}),
      },
      ...(citationCount !== undefined ? { metrics: { citation_count: citationCount } } : {}),
      links: {
        ...(pdf ? { open_access_pdf: pdf } : {}),
        ...(canonicalUrl ? { canonical_url: canonicalUrl } : {}),
        ...(landing ? { publisher_url: landing } : {}),
      },
      identity: {
        ...(canonicalUrl ? { canonical_url: canonicalUrl } : {}),
        ...(doi ? { doi } : {}),
        ...(openalexId ? { openalex_id: openalexId } : {}),
        venue,
        ...(citationCount !== undefined ? { citation_count: citationCount, citation_count_source: "openalex" } : {}),
        confidence: doi || openalexId ? 0.9 : 0.65,
        provenance: [
          ...(doi ? [{ field: "doi", provider: "openalex", value: doi, confidence: 0.9 }] : []),
          ...(openalexId ? [{ field: "openalex_id", provider: "openalex", value: openalexId, confidence: 0.9 }] : []),
          ...(venue ? [{ field: "venue", provider: "openalex", value: venue, confidence: 0.75 }] : []),
        ],
      },
    };
  });
}

export function buildOpenAlexSearchUrl(query: string, limit: number, apiKey = process.env.OPENALEX_API_KEY): string {
  const url = new URL(OPENALEX_WORKS_API);
  url.searchParams.set("search", query);
  url.searchParams.set("per-page", String(Math.min(Math.max(limit, 1), 200)));
  // Basic requests work without a key. A free authenticated key gives a deep
  // multi-provider run a substantially larger daily OpenAlex allowance.
  if (apiKey?.trim()) url.searchParams.set("api_key", apiKey.trim());
  return url.toString();
}

export type OpenAlexFetch = (url: string, init: RequestInit) => Promise<Response>;

export class OpenAlexProvider implements ResearchProvider {
  readonly id = "openalex" as const;
  private readonly fetchImpl: OpenAlexFetch;
  private readonly timeoutMs: number;
  private readonly limiter: ProviderRequestLimiter;

  constructor(fetchImpl: OpenAlexFetch = fetch, timeoutMs = 15_000, limiter = new ProviderRequestLimiter({ minIntervalMs: 1_000 })) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.limiter = limiter;
  }

  async search(query: string, limit: number): Promise<RawSource[]> {
    const response = await this.limiter.fetch(this.fetchImpl, buildOpenAlexSearchUrl(query, limit), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`OpenAlex request failed: HTTP ${response.status}`);
    return normalizeOpenAlexResponse(await response.json() as OpenAlexResponse, query).slice(0, limit);
  }
}
