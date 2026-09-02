import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { metricId } from "../src/lib/registry/ids.js";
import { buildEnvelope } from "../src/lib/registry/evaluate.js";
import { MeasurementEnvelopeSchema } from "../src/lib/registry/records.js";
import { scopeKey } from "../src/lib/registry/scope.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});
const AS_OF = "2026-09-01T00:00:00.000Z";

async function workspace(taxonomy: string[] = []): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-evaluate-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "sources"), { recursive: true });
  await fs.mkdir(path.join(ws, "chapters"), { recursive: true });
  await fs.writeFile(path.join(ws, "longwrite.yaml"), stringify({
    version: 1, project: { id: "s", artifact_type: "research_paper", mode: "auto_research_agentic" },
    research: { provider: "seed", topic: "t", taxonomy, corpus_gates: { min_core_sources: 5 } },
  }), "utf-8");
  await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"), [
    { id: "s1", citation_depth: "A", title: "Agent memory systems", abstract: "memory" },
    { id: "s2", citation_depth: "B", title: "Planning under uncertainty", abstract: "planning" },
    { id: "s3", citation_depth: "C", title: "Other", abstract: "other" },
  ].map((s) => JSON.stringify(s)).join("\n"), "utf-8");
  await fs.writeFile(path.join(ws, "chapters", "section-01.md"), "[source:s1:p1]\n", "utf-8");
  return ws;
}

describe("metrics evaluate", () => {
  it("emits a schema-valid envelope", async () => {
    const ws = await workspace();
    const envelope = await buildEnvelope(ws, { metrics: [metricId("core_sources")], asOfDate: AS_OF });
    expect(MeasurementEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(envelope.measurements[0].value).toBe(2);
  });

  it("never writes to the observation store", async () => {
    const ws = await workspace();
    await buildEnvelope(ws, { metrics: [metricId("core_sources")], asOfDate: AS_OF });
    // The kernel owns storage and sequencing; MrMaLiang emits and stops.
    await expect(fs.access(path.join(ws, ".malaclaw"))).rejects.toThrow();
  });

  it("emits no sequence, because the kernel allocates them", async () => {
    const ws = await workspace();
    const envelope = await buildEnvelope(ws, { metrics: [metricId("core_sources")], asOfDate: AS_OF });
    expect("sequence" in envelope.measurements[0]).toBe(false);
  });

  it("emits one canonically-keyed entry per scope for a scoped metric", async () => {
    const ws = await workspace(["memory", "planning"]);
    const envelope = await buildEnvelope(ws, { metrics: [metricId("taxonomy_cell_ab_sources")], asOfDate: AS_OF });
    expect(envelope.measurements.map((m) => m.scope_key).sort())
      .toEqual([scopeKey("taxonomy_cell", "memory"), scopeKey("taxonomy_cell", "planning")].sort());
  });

  it("marks a model metric deferred, not failed", async () => {
    const ws = await workspace();
    const envelope = await buildEnvelope(ws, { metrics: [metricId("review_score")], asOfDate: AS_OF });
    expect(envelope.measurements[0].status).toBe("deferred");
  });

  it("marks an unavailable required input failed, with a reason", async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-evaluate-bare-"));
    roots.push(bare);
    const envelope = await buildEnvelope(bare, { metrics: [metricId("core_sources")], asOfDate: AS_OF });
    expect(envelope.measurements[0].status).toBe("unavailable");
    expect(envelope.measurements[0].reason).toMatch(/missing/);
  });

  it("reports an unimplemented script evaluator as unavailable, never deferred", async () => {
    // "Produced by its own measurement unit" is false for a missing evaluator
    // and would hide the gap.
    const ws = await workspace();
    const envelope = await buildEnvelope(ws, {
      metrics: [metricId("core_sources")], asOfDate: AS_OF, forceMissingEvaluator: true,
    });
    expect(envelope.measurements[0].status).toBe("unavailable");
    expect(envelope.measurements[0].reason).toMatch(/no evaluator/);
  });

  it("selects only the metrics on the requested tier", async () => {
    const ws = await workspace();
    const envelope = await buildEnvelope(ws, { tier: "release", asOfDate: AS_OF });
    expect(envelope.measurements.map((m) => String(m.metric)).sort())
      .toEqual(["claim_support", "rendered_visual_review", "review_score"]);
    expect(envelope.measurements.every((m) => m.status === "deferred")).toBe(true);
  });

  it("compiles the configured target onto the entry", async () => {
    const ws = await workspace();
    const envelope = await buildEnvelope(ws, { metrics: [metricId("core_sources")], asOfDate: AS_OF });
    expect(envelope.measurements[0].target).toBe(5);
    expect(envelope.measurements[0].operator).toBe("at_least");
  });

  it("throws rather than measuring nothing when an unregistered metric is named", async () => {
    const ws = await workspace();
    await expect(buildEnvelope(ws, { metrics: [metricId("invented_metric")], asOfDate: AS_OF }))
      .rejects.toThrow(/unknown metric/);
  });
});
