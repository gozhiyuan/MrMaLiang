import { describe, expect, it } from "vitest";
import { normalizeCrossrefResponse, crossrefTypeRank } from "../src/lib/research/crossref.js";
import { normalizeDblpResponse, dblpTypeRank } from "../src/lib/research/dblp.js";
import { dedupeSources } from "../src/lib/research/dedupe.js";
import { scoreSources } from "../src/lib/research/score.js";
import type { RawSource } from "../src/lib/research/types.js";

function crossrefWork(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    DOI: "10.1000/x",
    title: ["A Paper"],
    author: [{ given: "A", family: "B" }],
    issued: { "date-parts": [[2026, 1, 1]] },
    "container-title": ["Venue"],
    URL: "https://doi.org/10.1000/x",
    ...overrides,
  };
}

describe("Crossref type hardening", () => {
  it("drops component/dataset/peer-review records", () => {
    const sources = normalizeCrossrefResponse({
      message: {
        items: [
          crossrefWork({ DOI: "10.1/a", type: "component", title: ["Supplement 1"] }),
          crossrefWork({ DOI: "10.1/b", type: "journal-article", title: ["Real Paper"] }),
          crossrefWork({ DOI: "10.1/c", type: "dataset", title: ["Some Data"] }),
          crossrefWork({ DOI: "10.1/d", type: "peer-review", title: ["Review of X"] }),
        ],
      },
    }, "topic");
    expect(sources.map((s) => s.title)).toEqual(["Real Paper"]);
  });

  it("ranks journal articles and proceedings ahead of preprints and unknowns", () => {
    const sources = normalizeCrossrefResponse({
      message: {
        items: [
          crossrefWork({ DOI: "10.1/pre", type: "posted-content", title: ["Preprint"] }),
          crossrefWork({ DOI: "10.1/conf", type: "proceedings-article", title: ["Conf Paper"] }),
          crossrefWork({ DOI: "10.1/j", type: "journal-article", title: ["Journal Paper"] }),
          crossrefWork({ DOI: "10.1/ch", type: "book-chapter", title: ["Chapter"] }),
        ],
      },
    }, "topic");
    expect(sources.map((s) => s.title)).toEqual(["Journal Paper", "Conf Paper", "Chapter", "Preprint"]);
    expect(crossrefTypeRank("journal-article")).toBeLessThan(crossrefTypeRank("posted-content"));
    expect(crossrefTypeRank(undefined)).toBe(5);
  });
});

describe("DBLP type hardening", () => {
  const hit = (type: string, title: string, key: string) => ({
    info: { title, type, key, year: "2026", venue: "V", authors: { author: [{ text: "A" }] } },
  });

  it("drops editorships and ranks journal/conference records first", () => {
    const sources = normalizeDblpResponse({
      result: {
        hits: {
          hit: [
            hit("Editorship", "Proceedings of X", "conf/x/2026"),
            hit("Informal and Other Publications", "Arxiv Version", "corr/abs-1"),
            hit("Conference and Workshop Papers", "Conf Paper", "conf/y/1"),
            hit("Journal Articles", "Journal Paper", "journals/z/1"),
          ],
        },
      },
    }, "topic");
    expect(sources.map((s) => s.title)).toEqual(["Journal Paper", "Conf Paper", "Arxiv Version"]);
    expect(dblpTypeRank("Journal Articles")).toBeLessThan(dblpTypeRank("Informal and Other Publications"));
  });
});

describe("cross-provider dedupe and ranking", () => {
  const base = {
    authors: ["Ada Lovelace"],
    year: 2026,
    topics: ["agents"],
  };
  const samePaper: RawSource[] = [
    {
      ...base,
      id: "arxiv-1",
      title: "Long-Horizon Agent Memory",
      venue: "arXiv",
      url: "https://arxiv.org/abs/2601.00001",
      abstract: "A long abstract about agent memory systems and planning.",
      source: "arxiv",
      identifiers: { arxiv_id: "2601.00001" },
    },
    {
      ...base,
      id: "crossref-1",
      title: "Long-Horizon Agent Memory",
      venue: "NeurIPS",
      url: "https://doi.org/10.5555/agents",
      abstract: "",
      source: "crossref",
      identifiers: { doi: "10.5555/agents" },
      metrics: { citation_count: 42 },
    },
    {
      ...base,
      id: "dblp-1",
      title: "Long-Horizon Agent Memory",
      venue: "NeurIPS 2026",
      url: "https://dblp.org/rec/conf/neurips/x",
      abstract: "",
      source: "dblp",
      identifiers: { doi: "10.5555/agents" },
    },
  ];

  it("merges the same paper across arXiv, Crossref, and DBLP into one record", () => {
    const deduped = dedupeSources(samePaper);
    expect(deduped).toHaveLength(1);
    const [merged] = deduped;
    // Identifiers from every provider survive the merge.
    expect(merged.identifiers?.arxiv_id).toBe("2601.00001");
    expect(merged.identifiers?.doi).toBe("10.5555/agents");
    expect(merged.metrics?.citation_count).toBe(42);
    expect(merged.merged_from).toHaveLength(3);
    // The abstract-bearing record's text is kept.
    expect(merged.abstract).toContain("agent memory");
  });

  it("scores merged sources without losing provider metadata", () => {
    const [scored] = scoreSources(dedupeSources(samePaper));
    expect(scored.quality_score).toBeGreaterThan(0);
    expect(scored.title).toBe("Long-Horizon Agent Memory");
  });
});

describe("multi provider", () => {
  it("concatenates provider results and tolerates partial failures", async () => {
    const { multiProvider } = await import("../src/lib/research/providers.js");
    const ok = (id: string, n: number) => ({
      id: id as never,
      search: async () => Array.from({ length: n }, (_, i) => ({
        id: `${id}-${i}`, title: `${id} ${i}`, authors: ["A"], year: 2026, topics: [],
        venue: "V", url: `https://${id}/${i}`,
        abstract: "", source: id as never, identifiers: {},
      })),
    });
    const failing = { id: "crossref" as never, search: async () => { throw new Error("down"); } };
    const sources = await multiProvider([ok("arxiv", 2), ok("dblp", 3), failing]).search("t", 5);
    expect(sources).toHaveLength(5);

    await expect(multiProvider([failing]).search("t", 5)).rejects.toThrow(/All multi-providers failed/);
  });
});
