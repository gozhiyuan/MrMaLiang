import { describe, expect, it } from "vitest";
import { PAPER_PROFILE_IDS, paperProfile } from "../src/lib/paper-profiles.js";

describe("paper profile registry", () => {
  it("exposes the literature flagship defaults", () => {
    const profile = paperProfile("literature_survey");
    expect(PAPER_PROFILE_IDS).toContain(profile.id);
    expect(profile.defaultWorkflowProfile).toBe("deep");
    expect(profile.targetWords).toBe(24_000);
    expect(profile.minPages).toBe(60);
    expect(profile.requiresCodebase).toBe(false);
    expect(profile.architectureDiagram).toEqual({ minSources: 3, requiresPinnedCodebaseSource: false });
  });

  it("keeps repository-specific rules in the profile contract", () => {
    const profile = paperProfile("repository_study");
    expect(profile.defaultWorkflowProfile).toBe("standard");
    expect(profile.targetWords).toBe(10_000);
    expect(profile.minPages).toBeUndefined();
    expect(profile.requiresCodebase).toBe(true);
    expect(profile.requiredVisualIds).toEqual(["concept-map"]);
    expect(profile.architectureDiagram).toEqual({ minSources: 1, requiresPinnedCodebaseSource: true });
    expect(profile.promptOverlays.outline).not.toHaveLength(0);
  });
});
