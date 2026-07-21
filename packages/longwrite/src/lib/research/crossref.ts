import type { ResearchProvider } from "./providers.js";
import type { RawSource } from "./types.js";
import { ProviderRequestLimiter } from "./rate-limit.js";

const CROSSREF_API = "https://api.crossref.org/works";

type CrossrefAuthor = {
  given?: unknown;
  family?: unknown;
  name?: unknown;
};

type CrossrefWork = {
  DOI?: unknown;
  title?: unknown;
  abstract?: unknown;
  author?: unknown;
  issued?: unknown;
  "published-print"?: unknown;
  "published-online"?: unknown;
  "container-title"?: unknown;
  publisher?: unknown;
  type?: unknown;
  URL?: unknown;
  "is-referenced-by-count"?: unknown;
  resource?: unknown;
};

type CrossrefResponse = {
  message?: {
    items?: unknown;
  };
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.map(asString).find(Boolean);
  return asString(value);
}

function datePartsYear(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const parts = (value as Record<string, unknown>)["date-parts"];
  if (!Array.isArray(parts) || !Array.isArray(parts[0])) return undefined;
  const year = parts[0][0];
  return typeof year === "number" && Number.isFinite(year) ? year : undefined;
}

function workYear(work: CrossrefWork): number {
  return datePartsYear(work.issued)
    ?? datePartsYear(work["published-online"])
    ?? datePartsYear(work["published-print"])
    ?? new Date().getUTCFullYear();
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

function sourceId(title: string, year: number, doi?: string): string {
  return `${slug(title) || "crossref"}-${year}-${slug(doi ?? title).slice(0, 16) || "record"}`;
}

function normalizeAuthors(value: unknown): string[] {
  if (!Array.isArray(value)) return ["Unknown Crossref Author"];
  const authors = value.map((author: CrossrefAuthor) => {
    const name = asString(author.name);
    if (name) return name;
    const parts = [asString(author.given), asString(author.family)].filter(Boolean);
    return parts.length > 0 ? parts.join(" ") : undefined;
  }).filter((author): author is string => Boolean(author));
  return authors.length > 0 ? authors : ["Unknown Crossref Author"];
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeVenue(work: CrossrefWork): string {
  return firstString(work["container-title"]) ?? asString(work.publisher) ?? asString(work.type) ?? "Crossref";
}

function openAccessPdf(work: CrossrefWork): string | undefined {
  const resource = work.resource;
  if (!resource || typeof resource !== "object") return undefined;
  const primary = (resource as Record<string, unknown>).primary;
  if (!primary || typeof primary !== "object") return undefined;
  return asString((primary as Record<string, unknown>).URL);
}

/** Crossref record types we never want in a bibliography: supplemental
 *  components, datasets, review reports, and issue-level records show up in
 *  broad bibliographic queries but are not citable works. */
const EXCLUDED_CROSSREF_TYPES = new Set([
  "component",
  "dataset",
  "peer-review",
  "grant",
  "journal-issue",
  "journal-volume",
  "journal",
  "proceedings",
  "report-component",
]);

const CROSSREF_TYPE_RANK: Record<string, number> = {
  "journal-article": 0,
  "proceedings-article": 1,
  "book-chapter": 2,
  "posted-content": 3, // preprints
  book: 4,
  monograph: 4,
};

export function crossrefTypeRank(type?: string): number {
  return type !== undefined && type in CROSSREF_TYPE_RANK ? CROSSREF_TYPE_RANK[type] : 5;
}

export function normalizeCrossrefResponse(payload: CrossrefResponse, topic: string): RawSource[] {
  const works = (Array.isArray(payload.message?.items) ? payload.message.items as CrossrefWork[] : [])
    .filter((work) => {
      const type = asString(work.type);
      return type === undefined || !EXCLUDED_CROSSREF_TYPES.has(type);
    })
    // Stable rank: real publications before preprints before everything else.
    .map((work, index) => ({ work, index }))
    .sort((a, b) =>
      crossrefTypeRank(asString(a.work.type)) - crossrefTypeRank(asString(b.work.type)) || a.index - b.index)
    .map(({ work }) => work);
  return works.map((work) => {
    const title = firstString(work.title) ?? "Untitled Crossref work";
    const doi = asString(work.DOI)?.toLowerCase();
    const year = workYear(work);
    const citationCount = asNumber(work["is-referenced-by-count"]);
    const pdf = openAccessPdf(work);
    return {
      id: sourceId(title, year, doi),
      title,
      authors: normalizeAuthors(work.author),
      year,
      venue: normalizeVenue(work),
      url: asString(work.URL) ?? (doi ? `https://doi.org/${doi}` : "https://api.crossref.org"),
      abstract: asString(work.abstract) ? stripHtml(asString(work.abstract)!) : "",
      source: "crossref",
      topics: topicTerms(topic),
      identifiers: {
        ...(doi ? { doi } : {}),
      },
      ...(citationCount !== undefined ? { metrics: { citation_count: citationCount } } : {}),
      ...(pdf ? { links: { open_access_pdf: pdf } } : {}),
    };
  });
}

export function buildCrossrefSearchUrl(topic: string, limit: number): string {
  const url = new URL(CROSSREF_API);
  url.searchParams.set("query.bibliographic", topic);
  // Over-fetch: client-side type filtering may drop records. Same-field
  // filters are OR'd by the Crossref API.
  url.searchParams.set("rows", String(Math.min(limit * 2, 100)));
  url.searchParams.set(
    "filter",
    "type:journal-article,type:proceedings-article,type:book-chapter,type:posted-content,type:book,type:monograph",
  );
  return url.toString();
}

export type CrossrefFetch = (url: string, init: RequestInit) => Promise<Response>;

export class CrossrefProvider implements ResearchProvider {
  readonly id = "crossref" as const;
  private readonly fetchImpl: CrossrefFetch;
  private readonly timeoutMs: number;
  private readonly limiter: ProviderRequestLimiter;

  constructor(fetchImpl: CrossrefFetch = fetch, timeoutMs = 15_000, limiter = new ProviderRequestLimiter({ minIntervalMs: 1_000 })) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.limiter = limiter;
  }

  async search(topic: string, limit: number): Promise<RawSource[]> {
    const response = await this.limiter.fetch(this.fetchImpl, buildCrossrefSearchUrl(topic, limit), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`Crossref request failed: HTTP ${response.status}`);
    return normalizeCrossrefResponse(await response.json() as CrossrefResponse, topic).slice(0, limit);
  }
}
