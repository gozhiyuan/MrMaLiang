import { describe, expect, it } from "vitest";
import { CrossrefProvider, buildCrossrefSearchUrl, normalizeCrossrefResponse } from "../src/lib/research/crossref.js";

const payload = {
  status: "ok",
  message: {
    items: [{
      DOI: "10.1007/978-3-031-92285-5_8",
      type: "book-chapter",
      title: ["Large Language Model Agents"],
      author: [
        { given: "Jerin George", family: "Mathew" },
        { given: "Jacopo", family: "Rossi" },
      ],
      issued: { "date-parts": [[2025, 7, 30]] },
      "container-title": ["Artificial Intelligence for Software Engineering"],
      publisher: "Springer Nature Switzerland",
      URL: "https://doi.org/10.1007/978-3-031-92285-5_8",
      abstract: "<jats:p>Large language model agents combine planning and tool use.</jats:p>",
      "is-referenced-by-count": 3,
      resource: {
        primary: {
          URL: "https://link.springer.com/chapter/10.1007/978-3-031-92285-5_8",
        },
      },
    }],
  },
};

describe("Crossref provider", () => {
  it("builds a works search URL", () => {
    const url = new URL(buildCrossrefSearchUrl("large language model agents", 12));
    expect(url.hostname).toBe("api.crossref.org");
    expect(url.pathname).toBe("/works");
    expect(url.searchParams.get("query.bibliographic")).toBe("large language model agents");
    expect(url.searchParams.get("rows")).toBe("24"); // over-fetch for type filtering
    expect(url.searchParams.get("filter")).toContain("type:journal-article");
  });

  it("normalizes work JSON into LongWrite raw sources", () => {
    const [source] = normalizeCrossrefResponse(payload, "large language model agents");
    expect(source.title).toBe("Large Language Model Agents");
    expect(source.authors).toEqual(["Jerin George Mathew", "Jacopo Rossi"]);
    expect(source.year).toBe(2025);
    expect(source.venue).toBe("Artificial Intelligence for Software Engineering");
    expect(source.source).toBe("crossref");
    expect(source.identifiers).toEqual({ doi: "10.1007/978-3-031-92285-5_8" });
    expect(source.metrics?.citation_count).toBe(3);
    expect(source.links?.open_access_pdf).toBe("https://link.springer.com/chapter/10.1007/978-3-031-92285-5_8");
    expect(source.abstract).toBe("Large language model agents combine planning and tool use.");
  });

  it("fetches and normalizes through the provider interface", async () => {
    const provider = new CrossrefProvider(async () => new Response(JSON.stringify(payload), { status: 200 }), 1_000);
    const sources = await provider.search("large language model agents", 1);
    expect(sources).toHaveLength(1);
    expect(sources[0].id).toContain("large-language-model-agents");
  });
});
