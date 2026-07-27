import { describe, expect, it } from "vitest";
import { CliResearchProvider } from "../src/research-provider.js";

describe("research provider boundary", () => {
  it("reports a missing provider without resolving another package's dist path", async () => {
    const provider = new CliResearchProvider("definitely-not-a-research-provider-xyz");
    await expect(provider.run(["research", "recall", "."], { cwd: process.cwd() }))
      .rejects.toThrow(/LONGEXPERIMENT_RESEARCH_PROVIDER_BIN/);
  });
});
