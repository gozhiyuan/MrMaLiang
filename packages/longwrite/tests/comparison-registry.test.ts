import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  EMPTY_REGISTRY,
  PROMOTION_THRESHOLD,
  dimensionId,
  foldObservations,
  refreshComparisonRegistry,
} from "../src/lib/research/comparison-registry.js";

const tempDirs: string[] = [];
afterEach(async () => {
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

describe("comparison-dimension registry", () => {
  it("holds a label proposed by a single source out of the vocabulary", async () => {
    const registry = foldObservations(EMPTY_REGISTRY, [{ label: "loop-closure degree", sourceId: "s1" }]);
    // One source naming an axis is that source's own framing, not a shared one.
    expect(registry.dimensions).toEqual([]);
    expect(registry.proposed).toEqual([{ label: "loop-closure degree", sources: ["s1"] }]);
  });

  it("promotes a label once independent sources converge on it", async () => {
    let registry = foldObservations(EMPTY_REGISTRY, [{ label: "loop-closure degree", sourceId: "s1" }]);
    registry = foldObservations(registry, [{ label: "Loop-Closure Degree", sourceId: "s2" }]);

    expect(registry.proposed).toEqual([]);
    expect(registry.dimensions).toHaveLength(1);
    expect(registry.dimensions[0].sources).toEqual(["s1", "s2"]);
    expect(registry.dimensions[0].sources).toHaveLength(PROMOTION_THRESHOLD);
  });

  it("treats casing and punctuation as the same axis but keeps the label readable", async () => {
    expect(dimensionId("Loop-Closure Degree")).toBe(dimensionId("loop closure degree"));
    const registry = foldObservations(EMPTY_REGISTRY, [
      { label: "Human involvement", sourceId: "s1" },
      { label: "human  involvement", sourceId: "s2" },
    ]);
    expect(registry.dimensions).toHaveLength(1);
    // The first spelling survives: the registry is meant to be read.
    expect(registry.dimensions[0].label).toBe("Human involvement");
  });

  it("does not let one source promote an axis by repeating itself", async () => {
    let registry = foldObservations(EMPTY_REGISTRY, [{ label: "retrieval quality", sourceId: "s1" }]);
    registry = foldObservations(registry, [{ label: "retrieval quality", sourceId: "s1" }]);
    expect(registry.dimensions).toEqual([]);
    expect(registry.proposed[0].sources).toEqual(["s1"]);
  });

  it("rebuilds the vocabulary from evidence already on disk", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-registry-"));
    tempDirs.push(dir);
    await fs.mkdir(path.join(dir, "evidence"), { recursive: true });
    const entry = (id: string, dimensions: string[]) => ({
      screening: { source_id: id },
      packet: { source_id: id, claims: [{ comparison_dimensions: dimensions, limitations: [] }] },
    });
    await fs.writeFile(path.join(dir, "evidence", "active-validated-source-evidence.json"), JSON.stringify({
      version: 1,
      entries: [
        entry("s1", ["loop-closure degree", "human involvement"]),
        entry("s2", ["loop-closure degree"]),
        entry("s3", ["retrieval quality"]),
      ],
    }));

    const { registry, written } = await refreshComparisonRegistry(dir);
    expect(registry.dimensions.map((entry) => entry.label)).toEqual(["loop-closure degree"]);
    expect(registry.proposed.map((entry) => entry.label).sort()).toEqual(["human involvement", "retrieval quality"]);

    const markdown = await fs.readFile(path.join(dir, written[1]), "utf-8");
    expect(markdown).toContain("Reuse a label from this");
    expect(markdown).toContain("loop-closure degree");
  });
});
