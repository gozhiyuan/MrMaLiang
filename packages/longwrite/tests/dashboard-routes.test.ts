import { describe, expect, it } from "vitest";
import { updateManifestStage } from "../dashboard-extension/server/routes.js";

function manifest() {
  return {
    workflow: {
      model_tiers: { cheap: { runtime: "codex" } },
      stages: [
        { id: "outline", owner: "lead", outputs: ["outline.md"] },
        {
          type: "foreach", id: "draft_sections", foreach: "outline.sections", max_parallel: 2,
          steps: [{ id: "draft", owner: "writer", outputs: ["chapters/{{item.id}}.md"] }],
        },
        { type: "loop", id: "quality", max_rounds: 2, stages: [{ id: "review", owner: "reviewer", outputs: ["review.md"] }] },
      ],
    },
  };
}

describe("dashboard workflow stage patches", () => {
  it("rejects execution edits on foreach and loop parents", () => {
    expect(() => updateManifestStage(manifest(), { stageId: "draft_sections", runtime: "codex" }))
      .toThrow(/foreach group/);
    expect(() => updateManifestStage(manifest(), { stageId: "quality", modelTier: "cheap" }))
      .toThrow(/loop group/);
  });

  it("allows only a valid foreach max_parallel patch", () => {
    const value = manifest();
    updateManifestStage(value, { stageId: "draft_sections", maxParallel: 4 });
    expect((value.workflow.stages[1] as { max_parallel: number }).max_parallel).toBe(4);
  });
});
