import type { ResearchProvider } from "./providers.js";
import type { RawSource } from "./types.js";
import { ProviderRequestLimiter } from "./rate-limit.js";

const SEMANTIC_SCHOLAR_API = "https://api.semanticscholar.org/graph/v1/paper/search";
const FIELDS = [
  "paperId",
  "title",
  "abstract",
  "year",
  "venue",
  "url",
  "authors",
  "externalIds",
  "citationCount",
  "openAccessPdf",
].join(",");

type SemanticScholarAuthor = {
  name?: unknown;
};

type SemanticScholarPaper = {
  paperId?: unknown;
  title?: unknown;
  abstract?: unknown;
  year?: unknown;
  venue?: unknown;
  url?: unknown;
  authors?: unknown;
  externalIds?: unknown;
  citationCount?: unknown;
  openAccessPdf?: unknown;
};

type SemanticScholarResponse = {
  data?: unknown;
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function topicTerms(topic: string): string[] {
  return [...new Set(topic.toLowerCase().split(/\s+/).map((t) => t.replace(/[^a-z0-9-]/g, "")).filter(Boolean))];
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
}

function sourceId(title: string, year: number, paperId: string): string {
  return `${slug(title) || "semantic-scholar"}-${year}-${paperId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}`;
}

function normalizeExternalIds(value: unknown): RawSource["identifiers"] {
  if (!value || typeof value !== "object") return undefined;
  const ids = value as Record<string, unknown>;
  return {
    ...(asString(ids.DOI) ? { doi: asString(ids.DOI)!.toLowerCase() } : {}),
    ...(asString(ids.ArXiv) ? { arxiv_id: asString(ids.ArXiv) } : {}),
  };
}

function normalizeAuthors(value: unknown): string[] {
  if (!Array.isArray(value)) return ["Unknown Semantic Scholar Author"];
  const authors = value
    .map((author: SemanticScholarAuthor) => asString(author?.name))
    .filter((name): name is string => Boolean(name));
  return authors.length > 0 ? authors : ["Unknown Semantic Scholar Author"];
}

function normalizeOpenAccessPdf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  return asString((value as Record<string, unknown>).url);
}

export function normalizeSemanticScholarResponse(
  payload: SemanticScholarResponse,
  topic: string,
): RawSource[] {
  const papers = Array.isArray(payload.data) ? payload.data as SemanticScholarPaper[] : [];
  return papers.map((paper) => {
    const title = asString(paper.title) ?? "Untitled Semantic Scholar paper";
    const year = asNumber(paper.year) ?? new Date().getUTCFullYear();
    const semanticScholarId = asString(paper.paperId) ?? sourceId(title, year, title);
    const externalIds = normalizeExternalIds(paper.externalIds);
    const citationCount = asNumber(paper.citationCount);
    const openAccessPdf = normalizeOpenAccessPdf(paper.openAccessPdf);
    return {
      id: sourceId(title, year, semanticScholarId),
      title,
      authors: normalizeAuthors(paper.authors),
      year,
      venue: asString(paper.venue) ?? "Semantic Scholar",
      url: asString(paper.url) ?? `https://www.semanticscholar.org/paper/${semanticScholarId}`,
      abstract: asString(paper.abstract) ?? "",
      source: "semantic_scholar",
      topics: topicTerms(topic),
      identifiers: {
        ...externalIds,
        semantic_scholar_id: semanticScholarId,
      },
      ...(citationCount !== undefined ? { metrics: { citation_count: citationCount } } : {}),
      ...(openAccessPdf ? { links: { open_access_pdf: openAccessPdf } } : {}),
    };
  });
}

export function buildSemanticScholarSearchUrl(topic: string, limit: number): string {
  const url = new URL(SEMANTIC_SCHOLAR_API);
  url.searchParams.set("query", topic);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("fields", FIELDS);
  return url.toString();
}

export type SemanticScholarFetch = (url: string, init: RequestInit) => Promise<Response>;

export class SemanticScholarProvider implements ResearchProvider {
  readonly id = "semantic_scholar" as const;
  private readonly fetchImpl: SemanticScholarFetch;
  private readonly timeoutMs: number;
  private readonly limiter: ProviderRequestLimiter;

  constructor(fetchImpl: SemanticScholarFetch = fetch, timeoutMs = 15_000, limiter = new ProviderRequestLimiter({ minIntervalMs: 1_000 })) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.limiter = limiter;
  }

  async search(topic: string, limit: number): Promise<RawSource[]> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (process.env.SEMANTIC_SCHOLAR_API_KEY) {
      headers["x-api-key"] = process.env.SEMANTIC_SCHOLAR_API_KEY;
    }
    const response = await this.limiter.fetch(this.fetchImpl, buildSemanticScholarSearchUrl(topic, limit), {
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Semantic Scholar request failed: HTTP ${response.status}`);
    }
    const payload = await response.json() as SemanticScholarResponse;
    return normalizeSemanticScholarResponse(payload, topic).slice(0, limit);
  }
}
