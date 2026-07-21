import { describe, expect, it } from "vitest";
import { ArxivProvider, buildArxivSearchUrl, normalizeArxivAtom } from "../src/lib/research/arxiv.js";

const arxivAtom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2401.12345v1</id>
    <updated>2024-01-30T12:00:00Z</updated>
    <published>2024-01-15T12:00:00Z</published>
    <title>Long-Horizon Agent Memory &amp; Planning</title>
    <summary>
      We study long-horizon agents that maintain memory across extended research and writing tasks.
    </summary>
    <author><name>Ada Lovelace</name></author>
    <author><name>Grace Hopper</name></author>
    <category term="cs.AI" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
    <arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.48550/arXiv.2401.12345</arxiv:doi>
  </entry>
</feed>`;

describe("arXiv provider", () => {
  it("builds a bounded relevance search URL", () => {
    const url = new URL(buildArxivSearchUrl("long horizon agent memory", 20));
    expect(url.hostname).toBe("export.arxiv.org");
    expect(url.searchParams.get("search_query")).toBe("all:long horizon agent memory");
    expect(url.searchParams.get("max_results")).toBe("20");
    expect(url.searchParams.get("sortBy")).toBe("relevance");
  });

  it("normalizes Atom entries into LongWrite raw sources", () => {
    const [source] = normalizeArxivAtom(arxivAtom, "long horizon agent memory");
    expect(source.title).toBe("Long-Horizon Agent Memory & Planning");
    expect(source.authors).toEqual(["Ada Lovelace", "Grace Hopper"]);
    expect(source.year).toBe(2024);
    expect(source.venue).toBe("arXiv:cs.AI,cs.CL");
    expect(source.url).toBe("http://arxiv.org/abs/2401.12345v1");
    expect(source.source).toBe("arxiv");
    expect(source.topics).toEqual(["long", "horizon", "agent", "memory"]);
    expect(source.identifiers).toEqual({
      arxiv_id: "2401.12345v1",
      doi: "10.48550/arxiv.2401.12345",
    });
  });

  it("fetches and normalizes through the provider interface", async () => {
    const provider = new ArxivProvider(async () => new Response(arxivAtom, { status: 200 }), 1_000);
    const sources = await provider.search("long horizon agent memory", 1);
    expect(sources).toHaveLength(1);
    expect(sources[0].id).toContain("long-horizon-agent-memory");
  });
});
