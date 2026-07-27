import { describe, expect, it } from "vitest";
import { createTaskProfileRegistry } from "../src/profiles/index.js";

describe("generalized task profiles", () => {
  it("registers the three declared pilots with bounded mutation policies", () => {
    const registry = createTaskProfileRegistry();
    expect(registry.ids()).toEqual(["paper_reproduction", "repository_optimization", "survey_pilot_study"]);
    const profile = registry.resolve({ pilot: "repository_optimization" } as any);
    expect(profile.mutationPolicy({} as any).protected_paths).toContain("prepare.py");
    expect(profile.buildRound({ round: 1, parentNodeId: "base", maxRounds: 3 })).toMatchObject({ parent_node_id: "base", max_candidates: 4 });
  });
});
