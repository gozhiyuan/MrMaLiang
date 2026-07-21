import { describe, expect, it } from "vitest";
import { OpenAlexProvider, buildOpenAlexSearchUrl, normalizeOpenAlexResponse } from "../src/lib/research/openalex.js";

const payload = {
  results: [{
    id: "https://openalex.org/W123",
    doi: "https://doi.org/10.1145/example",
    display_name: "Long-Horizon Memory for Agent Planning",
    publication_year: 2026,
    authorships: [{ author: { display_name: "Ada Researcher" } }],
    primary_location: {
      landing_page_url: "https://publisher.test/paper",
      pdf_url: "https://publisher.test/paper.pdf",
    },
    primary_location_source: { display_name: "ICLR" },
    cited_by_count: 42,
    topics: [{ display_name: "Language model agents" }],
    abstract_inverted_index: { Agent: [0], planning: [1], needs: [2], memory: [3] },
  }],
};

describe("OpenAlex provider", () => {
  it("builds a works search URL", () => {
    const url = new URL(buildOpenAlexSearchUrl("LLM agents", 25));
    expect(url.hostname).toBe("api.openalex.org");
    expect(url.pathname).toBe("/works");
    expect(url.searchParams.get("search")).toBe("LLM agents");
    expect(url.searchParams.get("per-page")).toBe("25");
  });

  it("adds an optional API key to a works search", () => {
    const url = new URL(buildOpenAlexSearchUrl("LLM agents", 25, "test-key"));
    expect(url.searchParams.get("api_key")).toBe("test-key");
  });

  it("normalizes OpenAlex works into provenance-rich sources", () => {
    const [source] = normalizeOpenAlexResponse(payload, "LLM agents");
    expect(source.source).toBe("openalex");
    expect(source.title).toBe("Long-Horizon Memory for Agent Planning");
    expect(source.identifiers?.doi).toBe("10.1145/example");
    expect(source.identifiers?.openalex_id).toBe("https://openalex.org/W123");
    expect(source.links?.canonical_url).toBe("https://openalex.org/W123");
    expect(source.identity?.citation_count_source).toBe("openalex");
    expect(source.abstract).toBe("Agent planning needs memory");
  });

  it("fetches through the provider interface", async () => {
    const provider = new OpenAlexProvider(async () => new Response(JSON.stringify(payload), { status: 200 }), 1_000);
    const sources = await provider.search("LLM agents", 1);
    expect(sources).toHaveLength(1);
    expect(sources[0].venue).toBe("ICLR");
  });
});
