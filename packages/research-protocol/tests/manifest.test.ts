import { describe, expect, it } from "vitest";
import { PublicationExperimentManifest } from "../src/index.js";

describe("publication experiment manifest", () => {
  it("rejects a result that is not publication eligible", () => {
    expect(() => PublicationExperimentManifest.parse({
      version: 1, project_id: "demo", hypothesis: "h", status: "completed", trial_count: 2, statistical_test: "paired bootstrap",
      metrics: { score: 1 }, trials: [{ id: "a", seed: 1, condition: "control", status: "completed", metrics: { score: 1 } }],
      comparisons: [], artifacts: { results_json: "results/raw.json" },
      provenance: { runner_kind: "command", input_revisions: {}, input_locks_sha256: "a".repeat(64), result_sha256: "b".repeat(64), generated_at: "2026-01-01T00:00:00.000Z" }, publication_eligible: false,
    })).toThrow();
  });
});
