import { describe, expect, it } from "vitest";
import { bibtexKey, bibtexKeys, escapeBibtex, writeBibtex } from "../src/lib/research/bibtex.js";

describe("BibTeX serialization", () => {
  it("normalizes HTML entities and escapes TeX-special metadata characters", () => {
    expect(escapeBibtex("Scholarly Q&amp;A: 50% & #1")).toBe("Scholarly Q\\&A: 50\\% \\& \\#1");
  });

  it("never writes a raw ampersand into bibliographic text fields", () => {
    const bib = writeBibtex([{
      id: "paper", title: "Claim &amp; Evidence", authors: ["A & B"], year: 2026,
      venue: "Research & Practice", url: "https://example.test/paper", abstract: "", source: "fixture",
      topics: [], identifiers: {}, quality_score: 1, score_rationale: "fixture", citation_depth: "C", citation_depth_rationale: "fixture",
    }]);
    expect(bib).toContain("Claim \\& Evidence");
    expect(bib).toContain("A \\& B");
    expect(bib).not.toMatch(/(?<!\\)&/);
    expect(bibtexKeys(bib)).toEqual(new Set([bibtexKey({ id: "paper", authors: ["A & B"], year: 2026 })]));
  });
});
