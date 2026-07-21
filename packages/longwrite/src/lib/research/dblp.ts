import type { ResearchProvider } from "./providers.js";
import type { RawSource } from "./types.js";
import { ProviderRequestLimiter } from "./rate-limit.js";

const DBLP_API = "https://dblp.org/search/publ/api";

type DblpAuthor = {
  text?: unknown;
};

type DblpInfo = {
  authors?: unknown;
  title?: unknown;
  venue?: unknown;
  year?: unknown;
  type?: unknown;
  doi?: unknown;
  ee?: unknown;
  url?: unknown;
  key?: unknown;
};

type DblpHit = {
  info?: DblpInfo;
};

type DblpResponse = {
  result?: {
    hits?: {
      hit?: unknown;
    };
  };
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
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

function normalizeAuthors(value: unknown): string[] {
  if (!value || typeof value !== "object") return ["Unknown DBLP Author"];
  const authorValue = (value as Record<string, unknown>).author;
  const authors = (Array.isArray(authorValue) ? authorValue : [authorValue])
    .map((author: unknown) => {
      if (typeof author === "string") return author.trim();
      if (author && typeof author === "object") return asString((author as DblpAuthor).text);
      return undefined;
    })
    .filter((author): author is string => Boolean(author));
  return authors.length > 0 ? authors : ["Unknown DBLP Author"];
}

function normalizeVenue(value: unknown): string {
  if (Array.isArray(value)) {
    const venues = value.map(asString).filter((venue): venue is string => Boolean(venue));
    return venues.length > 0 ? venues.join(", ") : "DBLP";
  }
  return asString(value) ?? "DBLP";
}

function sourceId(title: string, year: number, key: string): string {
  return `${slug(title) || "dblp"}-${year}-${slug(key).slice(0, 16) || "record"}`;
}

function normalizeHits(value: unknown): DblpHit[] {
  if (Array.isArray(value)) return value as DblpHit[];
  if (value && typeof value === "object") return [value as DblpHit];
  return [];
}

/** Editorships are records about editing a venue, not citable research. */
const EXCLUDED_DBLP_TYPES = new Set(["Editorship"]);

const DBLP_TYPE_RANK: Record<string, number> = {
  "Journal Articles": 0,
  "Conference and Workshop Papers": 1,
  "Books and Theses": 2,
  "Parts in Books or Collections": 3,
  "Informal and Other Publications": 4, // mostly arXiv CoRR
};

export function dblpTypeRank(type?: string): number {
  return type !== undefined && type in DBLP_TYPE_RANK ? DBLP_TYPE_RANK[type] : 5;
}

export function normalizeDblpResponse(payload: DblpResponse, topic: string): RawSource[] {
  return normalizeHits(payload.result?.hits?.hit)
    .filter((hit) => {
      const type = asString(hit.info?.type);
      return type === undefined || !EXCLUDED_DBLP_TYPES.has(type);
    })
    // Stable rank: journal and conference papers before informal records.
    .map((hit, index) => ({ hit, index }))
    .sort((a, b) =>
      dblpTypeRank(asString(a.hit.info?.type)) - dblpTypeRank(asString(b.hit.info?.type)) || a.index - b.index)
    .map(({ hit }) => hit)
    .map((hit) => {
    const info = hit.info ?? {};
    const title = asString(info.title)?.replace(/\.$/, "") ?? "Untitled DBLP publication";
    const year = asNumber(info.year) ?? new Date().getUTCFullYear();
    const key = asString(info.key) ?? title;
    const doi = asString(info.doi)?.toLowerCase();
    return {
      id: sourceId(title, year, key),
      title,
      authors: normalizeAuthors(info.authors),
      year,
      venue: normalizeVenue(info.venue),
      url: asString(info.ee) ?? asString(info.url) ?? `https://dblp.org/rec/${key}`,
      abstract: asString(info.type) ? `DBLP publication type: ${asString(info.type)}` : "",
      source: "dblp",
      topics: topicTerms(topic),
      identifiers: {
        ...(doi ? { doi } : {}),
      },
    };
  });
}

export function buildDblpSearchUrl(topic: string, limit: number): string {
  const url = new URL(DBLP_API);
  url.searchParams.set("q", topic);
  url.searchParams.set("format", "json");
  // Over-fetch: editorships are filtered client-side.
  url.searchParams.set("h", String(Math.min(limit * 2, 100)));
  return url.toString();
}

export type DblpFetch = (url: string, init: RequestInit) => Promise<Response>;

const DBLP_STOPWORDS = new Set([
  "a", "an", "and", "as", "at", "by", "for", "from", "in", "into", "of",
  "on", "or", "the", "to", "with", "use", "using", "via",
]);

/** DBLP's search AND-matches every term, so long phrase-shaped topics often
 *  return nothing. The fallback keeps only the significant terms. */
export function dblpFallbackQuery(topic: string): string {
  return topic
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9-]/g, ""))
    .filter((t) => t.length > 2 && !DBLP_STOPWORDS.has(t))
    .slice(0, 4)
    .join(" ");
}

export class DblpProvider implements ResearchProvider {
  readonly id = "dblp" as const;
  private readonly fetchImpl: DblpFetch;
  private readonly timeoutMs: number;
  private readonly limiter: ProviderRequestLimiter;

  constructor(fetchImpl: DblpFetch = fetch, timeoutMs = 15_000, limiter = new ProviderRequestLimiter({ minIntervalMs: 2_000 })) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.limiter = limiter;
  }

  private async query(query: string, topic: string, limit: number): Promise<RawSource[]> {
    const response = await this.limiter.fetch(this.fetchImpl, buildDblpSearchUrl(query, limit), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`DBLP request failed: HTTP ${response.status}`);
    return normalizeDblpResponse(await response.json() as DblpResponse, topic).slice(0, limit);
  }

  async search(topic: string, limit: number): Promise<RawSource[]> {
    const exact = await this.query(topic, topic, limit);
    if (exact.length > 0) return exact;
    const fallback = dblpFallbackQuery(topic);
    if (!fallback || fallback === topic.toLowerCase()) return exact;
    return this.query(fallback, topic, limit);
  }
}
