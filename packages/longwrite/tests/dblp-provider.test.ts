import { describe, expect, it } from "vitest";
import { DblpProvider, buildDblpSearchUrl, normalizeDblpResponse } from "../src/lib/research/dblp.js";

const payload = {
  result: {
    hits: {
      hit: [{
        info: {
          authors: {
            author: [
              { text: "Sadia Sultana Chowa" },
              { text: "Riasad Alvi" },
            ],
          },
          title: "From language to action: a review of large language models as autonomous agents and tool users.",
          venue: "Artif. Intell. Rev.",
          year: "2026",
          type: "Journal Articles",
          key: "journals/air/ChowaARRRIHA26",
          doi: "10.1007/S10462-025-11471-9",
          ee: "https://doi.org/10.1007/s10462-025-11471-9",
          url: "https://dblp.org/rec/journals/air/ChowaARRRIHA26",
        },
      }],
    },
  },
};

describe("DBLP provider", () => {
  it("builds a publication search URL", () => {
    const url = new URL(buildDblpSearchUrl("large language model agents", 10));
    expect(url.hostname).toBe("dblp.org");
    expect(url.pathname).toBe("/search/publ/api");
    expect(url.searchParams.get("q")).toBe("large language model agents");
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("h")).toBe("20"); // over-fetch for type filtering
  });

  it("normalizes publication search JSON into LongWrite raw sources", () => {
    const [source] = normalizeDblpResponse(payload, "large language model agents");
    expect(source.title).toBe("From language to action: a review of large language models as autonomous agents and tool users");
    expect(source.authors).toEqual(["Sadia Sultana Chowa", "Riasad Alvi"]);
    expect(source.year).toBe(2026);
    expect(source.venue).toBe("Artif. Intell. Rev.");
    expect(source.source).toBe("dblp");
    expect(source.url).toBe("https://doi.org/10.1007/s10462-025-11471-9");
    expect(source.identifiers).toEqual({ doi: "10.1007/s10462-025-11471-9" });
    expect(source.abstract).toContain("Journal Articles");
  });

  it("fetches and normalizes through the provider interface", async () => {
    const provider = new DblpProvider(async () => new Response(JSON.stringify(payload), { status: 200 }), 1_000);
    const sources = await provider.search("large language model agents", 1);
    expect(sources).toHaveLength(1);
    expect(sources[0].id).toContain("from-language-to-action");
  });
});

describe("DBLP fallback query", () => {
  it("keeps significant terms and drops stopwords", async () => {
    const { dblpFallbackQuery } = await import("../src/lib/research/dblp.js");
    expect(dblpFallbackQuery("Tool use and environment feedback in LLM agents"))
      .toBe("tool environment feedback llm");
  });

  it("retries with the fallback query when the exact phrase returns nothing", async () => {
    const { DblpProvider } = await import("../src/lib/research/dblp.js");
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(decodeURIComponent(new URL(url).searchParams.get("q") ?? ""));
      const empty = calls.length === 1;
      return new Response(JSON.stringify({
        result: { hits: { hit: empty ? [] : [{ info: { title: "Found Paper", type: "Conference and Workshop Papers", key: "conf/x/1", year: "2026", venue: "V" } }] } },
      }), { status: 200 });
    }) as never;
    const sources = await new DblpProvider(fetchImpl).search("Tool use and environment feedback in LLM agents", 5);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe("tool environment feedback llm");
    expect(sources[0].title).toBe("Found Paper");
  });
});
