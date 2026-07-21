import type { RawSource } from "./types.js";
import type { ResearchProvider } from "./providers.js";
import { ProviderRequestLimiter } from "./rate-limit.js";

const ARXIV_API = "https://export.arxiv.org/api/query";

function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'");
}

function textBetween(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? decodeXml(match[1].replace(/\s+/g, " ").trim()) : undefined;
}

function entryBlocks(xml: string): string[] {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((match) => match[1]);
}

function arxivIdFromUrl(url: string): string {
  return url.replace(/^https?:\/\/arxiv\.org\/abs\//, "").replace(/[^a-zA-Z0-9._-]/g, "-");
}

function sourceId(title: string, year: number, arxivId: string): string {
  const titleSlug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${titleSlug || "arxiv"}-${year}-${arxivId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}`;
}

function terms(topic: string): string[] {
  return [...new Set(topic.toLowerCase().split(/\s+/).map((t) => t.replace(/[^a-z0-9-]/g, "")).filter(Boolean))];
}

export function normalizeArxivAtom(xml: string, topic: string): RawSource[] {
  return entryBlocks(xml).map((entry) => {
    const title = textBetween(entry, "title") ?? "Untitled arXiv paper";
    const abstract = textBetween(entry, "summary") ?? "";
    const published = textBetween(entry, "published") ?? "";
    const year = Number.parseInt(published.slice(0, 4), 10) || new Date().getUTCFullYear();
    const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)]
      .map((match) => decodeXml(match[1].replace(/\s+/g, " ").trim()))
      .filter(Boolean);
    const categories = [...entry.matchAll(/<category[^>]*term="([^"]+)"/gi)].map((match) => decodeXml(match[1]));
    const url = textBetween(entry, "id") ?? "";
    const arxivId = arxivIdFromUrl(url);
    const doi = textBetween(entry, "arxiv:doi");
    return {
      id: sourceId(title, year, arxivId),
      title,
      authors: authors.length > 0 ? authors : ["Unknown arXiv Author"],
      year,
      venue: categories.length > 0 ? `arXiv:${categories.join(",")}` : "arXiv",
      url,
      abstract,
      source: "arxiv",
      topics: terms(topic),
      identifiers: {
        arxiv_id: arxivId,
        ...(doi ? { doi: doi.toLowerCase() } : {}),
      },
    };
  });
}

export function buildArxivSearchUrl(topic: string, limit: number): string {
  const url = new URL(ARXIV_API);
  url.searchParams.set("search_query", `all:${topic}`);
  url.searchParams.set("start", "0");
  url.searchParams.set("max_results", String(limit));
  url.searchParams.set("sortBy", "relevance");
  url.searchParams.set("sortOrder", "descending");
  return url.toString();
}

export type ArxivFetch = (url: string, init: RequestInit) => Promise<Response>;

export class ArxivProvider implements ResearchProvider {
  readonly id = "arxiv" as const;
  private readonly fetchImpl: ArxivFetch;
  private readonly timeoutMs: number;
  private readonly limiter: ProviderRequestLimiter;

  constructor(fetchImpl: ArxivFetch = fetch, timeoutMs = 15_000, limiter = new ProviderRequestLimiter({ minIntervalMs: 3_000 })) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.limiter = limiter;
  }

  async search(topic: string, limit: number): Promise<RawSource[]> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const response = await this.limiter.fetch(this.fetchImpl, buildArxivSearchUrl(topic, limit), { signal });
    if (!response.ok) {
      throw new Error(`arXiv request failed: HTTP ${response.status}`);
    }
    const xml = await response.text();
    return normalizeArxivAtom(xml, topic).slice(0, limit);
  }
}
