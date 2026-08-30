import { describe, expect, it } from "vitest";
import { computeRedundancy } from "../src/lib/research/redundancy.js";

describe("computeRedundancy", () => {
  it("flags a tracked phrase that exceeds its configured maximum across sections", () => {
    const chapters = [
      { rel: "chapters/section-05.md", content: "The available packet does not establish the mechanism. Not specified in packet." },
      { rel: "chapters/section-08.md", content: "The packet again does not establish transfer. Not specified in packet." },
      { rel: "chapters/section-09.md", content: "This packet does not establish provenance." },
    ];
    const report = computeRedundancy(chapters, {
      trackedPhrases: ["packet", "does not establish"],
      maxTrackedOccurrences: 3,
      maxNgramOccurrences: 100,
    });
    const packetFinding = report.trackedPhraseOveruse.find((item) => item.phrase === "packet");
    expect(packetFinding).toBeDefined();
    expect(packetFinding!.count).toBe(5);
    expect(packetFinding!.sections).toEqual(["chapters/section-05.md", "chapters/section-08.md", "chapters/section-09.md"]);
  });

  it("does not flag a phrase within its configured maximum", () => {
    const chapters = [{ rel: "chapters/section-01.md", content: "The packet supports this claim." }];
    const report = computeRedundancy(chapters, { trackedPhrases: ["packet"], maxTrackedOccurrences: 5, maxNgramOccurrences: 100 });
    expect(report.trackedPhraseOveruse).toEqual([]);
  });

  it("flags a repeated five-word phrase spanning multiple sections as a redundant n-gram", () => {
    const repeated = "this establishes a component but not the full loop";
    const chapters = [
      { rel: "chapters/section-a.md", content: repeated },
      { rel: "chapters/section-b.md", content: repeated },
      { rel: "chapters/section-c.md", content: repeated },
    ];
    const report = computeRedundancy(chapters, { maxTrackedOccurrences: 1000, maxNgramOccurrences: 2, ngramSize: 5 });
    expect(report.repeatedNgramOveruse.length).toBeGreaterThan(0);
    expect(report.repeatedNgramOveruse[0]!.sections.length).toBe(3);
  });

  it("does not flag a repeated n-gram confined to a single section", () => {
    const chapters = [{ rel: "chapters/section-a.md", content: "this establishes a component but not the full loop this establishes a component but not the full loop" }];
    const report = computeRedundancy(chapters, { maxTrackedOccurrences: 1000, maxNgramOccurrences: 1, ngramSize: 5 });
    expect(report.repeatedNgramOveruse).toEqual([]);
  });
});
