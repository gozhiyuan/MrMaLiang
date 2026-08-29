import { describe, expect, it } from "vitest";
import { PAPER_PROFILE_IDS, paperProfile } from "../src/lib/paper-profiles.js";

describe("paper profile registry", () => {
  it("exposes the long literature flagship defaults", () => {
    const profile = paperProfile("flagship_long_paper");
    expect(PAPER_PROFILE_IDS).toContain(profile.id);
    expect(profile.defaultWorkflowProfile).toBe("deep");
    expect(profile.targetWords).toBe(24_000);
    expect(profile.minPages).toBe(60);
    expect(profile.requiresCodebase).toBe(false);
    expect(profile.architectureDiagram).toEqual({ minSources: 3, requiresPinnedCodebaseSource: false });
  });

  it("keeps GitHub-specific rules in the long profile contract", () => {
    const profile = paperProfile("flagship_long_github_paper");
    expect(profile.defaultWorkflowProfile).toBe("deep");
    expect(profile.targetWords).toBe(14_000);
    expect(profile.minPages).toBe(35);
    expect(profile.requiresCodebase).toBe(true);
    expect(profile.requiredVisualIds).toEqual(["concept-map"]);
    expect(profile.architectureDiagram).toEqual({ minSources: 1, requiresPinnedCodebaseSource: true });
    expect(profile.promptOverlays.outline).not.toHaveLength(0);
  });

  it("scales short and long flagship papers without bypassing quality contracts", () => {
    const short = paperProfile("flagship_short_paper");
    const long = paperProfile("flagship_long_paper");
    expect(short.defaultWorkflowProfile).toBe("deep");
    expect(short.targetWords).toBe(8_000);
    expect(short.minPages).toBe(20);
    expect(short.releaseGates.min_cited_sources).toBe(30);
    expect(short.researchBudget.targetCandidates).toBe(160);
    expect(long.targetWords).toBe(24_000);
    expect(long.releaseGates).toEqual(paperProfile("flagship_long_paper").releaseGates);
  });

  it("keeps GitHub flagship papers codebase-grounded at both scopes", () => {
    const short = paperProfile("flagship_short_github_paper");
    const long = paperProfile("flagship_long_github_paper");
    expect(short.defaultWorkflowProfile).toBe("deep");
    expect(short.requiresCodebase).toBe(true);
    expect(short.requiredVisualIds).toEqual(["concept-map"]);
    expect(short.targetWords).toBe(6_000);
    expect(short.releaseGates.min_cited_sources).toBe(18);
    expect(long.targetWords).toBe(14_000);
    expect(long.releaseGates.min_cited_sources).toBe(40);
    expect(long.researchBudget.targetCandidates).toBe(240);
  });
});
