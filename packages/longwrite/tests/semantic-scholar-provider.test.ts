import { describe, expect, it, vi } from "vitest";
import {
  SemanticScholarProvider,
  buildSemanticScholarSearchUrl,
  normalizeSemanticScholarResponse,
} from "../src/lib/research/semantic-scholar.js";

const payload = {
  total: 1,
  offset: 0,
  data: [
    {
      paperId: "649def34f8be52c8b66281af98ae884c09aef38b",
      title: "Construction of the Literature Graph in Semantic Scholar",
      abstract: "We describe a deployed scalable system for organizing published scientific literature.",
      year: 2018,
      venue: "NAACL",
      url: "https://www.semanticscholar.org/paper/649def34f8be52c8b66281af98ae884c09aef38b",
      authors: [{ name: "Waleed Ammar" }, { name: "Dirk Groeneveld" }],
      externalIds: {
        DOI: "10.18653/v1/N18-3011",
        ArXiv: "1805.02262",
      },
      citationCount: 365,
      openAccessPdf: {
        url: "https://aclanthology.org/N18-3011.pdf",
      },
    },
  ],
};

describe("Semantic Scholar provider", () => {
  it("builds a paper search URL with requested fields and limit", () => {
    const url = new URL(buildSemanticScholarSearchUrl("long horizon agent memory", 15));
    expect(url.hostname).toBe("api.semanticscholar.org");
    expect(url.pathname).toBe("/graph/v1/paper/search");
    expect(url.searchParams.get("query")).toBe("long horizon agent memory");
    expect(url.searchParams.get("limit")).toBe("15");
    expect(url.searchParams.get("fields")).toContain("externalIds");
  });

  it("normalizes paper search JSON into LongWrite raw sources", () => {
    const [source] = normalizeSemanticScholarResponse(payload, "literature graph");
    expect(source.title).toBe("Construction of the Literature Graph in Semantic Scholar");
    expect(source.authors).toEqual(["Waleed Ammar", "Dirk Groeneveld"]);
    expect(source.year).toBe(2018);
    expect(source.venue).toBe("NAACL");
    expect(source.source).toBe("semantic_scholar");
    expect(source.identifiers).toEqual({
      doi: "10.18653/v1/n18-3011",
      arxiv_id: "1805.02262",
      semantic_scholar_id: "649def34f8be52c8b66281af98ae884c09aef38b",
    });
    expect(source.metrics?.citation_count).toBe(365);
    expect(source.links?.open_access_pdf).toBe("https://aclanthology.org/N18-3011.pdf");
  });

  it("uses an API key header when configured", async () => {
    vi.stubEnv("SEMANTIC_SCHOLAR_API_KEY", "test-key");
    const calls: RequestInit[] = [];
    const provider = new SemanticScholarProvider(async (_url, init) => {
      calls.push(init);
      return new Response(JSON.stringify(payload), { status: 200 });
    }, 1_000);

    const sources = await provider.search("literature graph", 1);
    expect(sources).toHaveLength(1);
    expect(calls[0].headers).toMatchObject({ "x-api-key": "test-key" });
    vi.unstubAllEnvs();
  });
});
