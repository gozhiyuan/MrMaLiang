import { describe, expect, it } from "vitest";
import { parseProjectConfig } from "../src/lib/project-config.js";

describe("quality_control redundancy thresholds", () => {
  it("defaults new redundancy thresholds to disabled (-1)", () => {
    const config = parseProjectConfig({
      version: 1,
      project: { id: "t", artifact_type: "research_paper", mode: "auto_research_agentic" },
    });
    expect(config.research.quality_control.max_tracked_phrase_occurrences).toBe(-1);
    expect(config.research.quality_control.max_repeated_ngram_occurrences).toBe(-1);
    expect(config.research.quality_control.tracked_phrases).toEqual(["packet"]);
  });

  it("accepts explicit redundancy thresholds", () => {
    const config = parseProjectConfig({
      version: 1,
      project: { id: "t", artifact_type: "research_paper", mode: "auto_research_agentic" },
      research: { quality_control: { max_tracked_phrase_occurrences: 15, max_repeated_ngram_occurrences: 3 } },
    });
    expect(config.research.quality_control.max_tracked_phrase_occurrences).toBe(15);
    expect(config.research.quality_control.max_repeated_ngram_occurrences).toBe(3);
  });
});
