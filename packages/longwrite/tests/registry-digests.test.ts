import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalJson } from "../src/lib/registry/canonical.js";
import { computeInputDigest, evaluatorDigest } from "../src/lib/registry/digests.js";
import { metricDefinition } from "../src/lib/registry/metrics.js";
import { metricId } from "../src/lib/registry/ids.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});
async function workspace(): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-digests-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "chapters"), { recursive: true });
  await fs.writeFile(path.join(ws, "chapters", "section-01.md"), "# One\n", "utf-8");
  await fs.writeFile(path.join(ws, "longwrite.yaml"), "version: 1\n", "utf-8");
  await fs.mkdir(path.join(ws, "sources"), { recursive: true });
  await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"), "", "utf-8");
  return ws;
}
const AS_OF = "2026-09-01T00:00:00.000Z";
const LATER = "2027-06-01T00:00:00.000Z";

describe("canonical json", () => {
  it("sorts keys at every depth and preserves nested values", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    // JSON.stringify(value, keyArray) filters keys at EVERY depth and would
    // silently discard nested model configuration.
    expect(canonicalJson({ model: { name: "opus", params: { effort: "high" } } })).toContain("effort");
  });

  it("preserves array order and distinguishes null from missing", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
  });
});

describe("input digests", () => {
  it("changes when a declared dependency changes", async () => {
    const ws = await workspace();
    const definition = metricDefinition(metricId("prose_redundancy"));
    const before = await computeInputDigest(ws, definition, { asOfDate: AS_OF });
    await fs.writeFile(path.join(ws, "chapters", "section-01.md"), "# One, revised\n", "utf-8");
    expect(await computeInputDigest(ws, definition, { asOfDate: AS_OF })).not.toBe(before);
  });

  it("distinguishes a missing dependency from an empty one", async () => {
    const ws = await workspace();
    const definition = metricDefinition(metricId("taxonomy_cell_ab_sources"));
    await fs.rm(path.join(ws, "longwrite.yaml"));
    const missing = await computeInputDigest(ws, definition, { asOfDate: AS_OF });
    await fs.writeFile(path.join(ws, "longwrite.yaml"), "", "utf-8");
    expect(await computeInputDigest(ws, definition, { asOfDate: AS_OF })).not.toBe(missing);
  });

  it("includes the date only for a time-dependent metric", async () => {
    const ws = await workspace();
    const dated = metricDefinition(metricId("recent_source_ratio"));
    const static_ = metricDefinition(metricId("core_sources"));
    expect(await computeInputDigest(ws, dated, { asOfDate: AS_OF }))
      .not.toBe(await computeInputDigest(ws, dated, { asOfDate: LATER }));
    // A static metric must not invalidate merely because a day passed.
    expect(await computeInputDigest(ws, static_, { asOfDate: AS_OF }))
      .toBe(await computeInputDigest(ws, static_, { asOfDate: LATER }));
  });

  it("includes nested model configuration for a model pipeline", async () => {
    const ws = await workspace();
    const definition = metricDefinition(metricId("review_score"));
    const prompt = "c".repeat(64);
    expect(await computeInputDigest(ws, definition, { asOfDate: AS_OF, model: { name: "opus", effort: "high" }, promptDigest: prompt }))
      .not.toBe(await computeInputDigest(ws, definition, { asOfDate: AS_OF, model: { name: "opus", effort: "low" }, promptDigest: prompt }));
  });

  it("does not include the producer's raw output", async () => {
    const ws = await workspace();
    const definition = metricDefinition(metricId("review_score"));
    const context = { asOfDate: AS_OF, promptDigest: "c".repeat(64) };
    const before = await computeInputDigest(ws, definition, context);
    await fs.mkdir(path.join(ws, "reviews"), { recursive: true });
    await fs.writeFile(path.join(ws, "reviews", "scorecard.json"), "{}", "utf-8");
    expect(await computeInputDigest(ws, definition, context)).toBe(before);
  });

  it("changes the evaluator digest when its version changes", () => {
    expect(evaluatorDigest("core_sources", "1")).not.toBe(evaluatorDigest("core_sources", "2"));
  });
});
