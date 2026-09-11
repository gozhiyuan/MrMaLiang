import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { metricsOfTier, metricDefinition } from "../src/lib/registry/metrics.js";
import { metricId } from "../src/lib/registry/ids.js";
import { acquireExternalMetric, acquireModelMetric } from "../src/lib/registry/acquire.js";
import { compileModeToManifest } from "../src/lib/compiler.js";
import { loadMode } from "../src/lib/modes.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

type Stage = {
  id: string; kind?: string; owns?: string[]; writes_observations?: string[];
  outputs?: string[]; command?: { args: string[] };
};

async function compiledManifest(): Promise<{ workflow: { stages: Stage[] } }> {
  const mode = await loadMode("auto_research_agentic");
  return await compileModeToManifest(mode, {
    projectId: "measurement-fixture", artifactType: "research_paper",
    topic: "measurement", researchProvider: "seed",
  } as never) as never;
}

describe("measurement stages", () => {
  it("declares a script measurement stage for the unit and round tiers only", async () => {
    const manifest = await compiledManifest();
    for (const id of ["measure_unit_metrics", "measure_round_metrics"]) {
      expect(manifest.workflow.stages.some((stage) => stage.id === id), id).toBe(true);
    }
    // There is no measure_release_metrics: `metrics evaluate` defers every
    // model metric by design, so such a stage could never produce one.
    expect(manifest.workflow.stages.some((stage) => stage.id === "measure_release_metrics")).toBe(false);
  });

  it("declares exactly the metrics each script tier owns", async () => {
    const manifest = await compiledManifest();
    for (const [id, tier] of [["measure_unit_metrics", "unit"], ["measure_round_metrics", "round"]] as const) {
      const stage = manifest.workflow.stages.find((entry) => entry.id === id)!;
      expect((stage.writes_observations ?? []).sort()).toEqual(metricsOfTier(tier)
        .filter((metric) => metricDefinition(metric).measurement_kind === "script").map(String).sort());
    }
  });

  it("gives every non-script metric exactly one acquisition stage", async () => {
    const manifest = await compiledManifest();
    const acquiredMetrics = [...metricsOfTier("release"), ...metricsOfTier("round")].map(String)
      .filter((metric) => metricDefinition(metricId(metric)).measurement_kind !== "script");
    for (const metric of acquiredMetrics) {
      const stages = manifest.workflow.stages.filter((s) => (s.writes_observations ?? []).includes(metric));
      expect(stages.map((s) => s.id), `${metric} must have exactly one producer`).toHaveLength(1);
      expect(stages[0].id).toBe(`acquire_${metric}`);
      expect(stages[0].writes_observations).toEqual([metric]);
    }
  });

  it("invokes each script stage with its own tier flag", async () => {
    const manifest = await compiledManifest();
    const round = manifest.workflow.stages.find((s) => s.id === "measure_round_metrics")!;
    expect(round.command?.args).toEqual(expect.arrayContaining(["--tier", "round"]));
  });

  it("never routes a model metric through metrics evaluate", async () => {
    // `metrics evaluate` marks every non-script metric deferred by design, so a
    // release-tier invocation of it would defer forever.
    const manifest = await compiledManifest();
    for (const stage of manifest.workflow.stages) {
      const args = stage.command?.args ?? [];
      if (args.includes("evaluate") && args.includes("--tier")) {
        expect(args).not.toContain("release");
      }
    }
  });

  it("declares every measurement stage as kind measurement with no envelope", async () => {
    const manifest = await compiledManifest();
    const measurement = manifest.workflow.stages.filter(
      (s) => s.id.startsWith("measure_") || s.id.startsWith("acquire_"));
    expect(measurement.length).toBeGreaterThan(0);
    for (const stage of measurement) {
      expect(stage.kind, stage.id).toBe("measurement");
      expect(stage.owns ?? [], stage.id).toEqual([]);
    }
  });

  it("outputs the measurement envelope the engine ingests", async () => {
    const manifest = await compiledManifest();
    const unit = manifest.workflow.stages.find((s) => s.id === "measure_unit_metrics")!;
    expect(unit.outputs).toContain("reports/measurements.json");
  });

  it("names only registered metrics", async () => {
    const manifest = await compiledManifest();
    const registered = new Set([...metricsOfTier("unit"), ...metricsOfTier("round"), ...metricsOfTier("release")].map(String));
    for (const stage of manifest.workflow.stages) {
      for (const metric of stage.writes_observations ?? []) expect(registered.has(metric), metric).toBe(true);
    }
  });
});

describe("model metric acquisition", () => {
  async function workspaceWithScorecard(scorecard: unknown): Promise<string> {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-acquire-"));
    roots.push(ws);
    await fs.mkdir(path.join(ws, "reviews"), { recursive: true });
    await fs.writeFile(path.join(ws, "reviews", "scorecard.json"), JSON.stringify(scorecard), "utf-8");
    return ws;
  }

  it("produces a measured model observation with judgment, not a deferral", async () => {
    // The shape the persona review actually writes: one score per rubric
    // dimension. A persona's overall is the mean of its dimensions, and the
    // metric is the median across personas — 7, 8 and 6 give 7.
    const ws = await workspaceWithScorecard({
      version: 1, rubric_version: "r7",
      personas: [
        { id: "methodologist", scores: { rigor: 6, clarity: 8 } },
        { id: "domain-expert", scores: { rigor: 8, clarity: 8 } },
        { id: "editor", scores: { rigor: 5, clarity: 7 } },
      ],
    });
    await acquireModelMetric(ws, "review_score");
    const envelope = JSON.parse(await fs.readFile(path.join(ws, "reports/measurements.json"), "utf-8"));
    const entry = envelope.measurements.find((m: { metric: string }) => m.metric === "review_score");
    // Asserting the stage exists proves nothing; assert it emits a value.
    expect(entry.status).toBe("measured");
    expect(typeof entry.value).toBe("number");
    expect(entry.value).toBe(7);
    expect(entry.judgment.rubric_version).toBe("r7");
  });

  it("reports unavailable with a reason when the producer output fails validation", async () => {
    const ws = await workspaceWithScorecard({ version: 1, personas: [] });
    await acquireModelMetric(ws, "review_score");
    const envelope = JSON.parse(await fs.readFile(path.join(ws, "reports/measurements.json"), "utf-8"));
    const entry = envelope.measurements.find((m: { metric: string }) => m.metric === "review_score");
    expect(entry.status).toBe("unavailable");
    expect(entry.reason).toMatch(/schema|validator/i);
  });

  it("reports unavailable rather than zero when the producer never ran", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-acquire-missing-"));
    roots.push(ws);
    await acquireModelMetric(ws, "review_score");
    const envelope = JSON.parse(await fs.readFile(path.join(ws, "reports/measurements.json"), "utf-8"));
    const entry = envelope.measurements.find((m: { metric: string }) => m.metric === "review_score");
    // Zero would be a claim about the manuscript; this is a claim about our
    // ability to look at it.
    expect(entry.status).toBe("unavailable");
    expect(entry.value).toBeUndefined();
  });

  it("merges into the envelope rather than replacing the round's other metrics", async () => {
    const ws = await workspaceWithScorecard({
      version: 1, personas: [{ id: "a", score: 5 }],
    });
    await fs.mkdir(path.join(ws, "reports"), { recursive: true });
    await fs.writeFile(path.join(ws, "reports", "measurements.json"), JSON.stringify({
      version: 1, as_of_date: new Date().toISOString(),
      measurements: [{
        metric: "cited_sources", scope_key: "", status: "measured", value: 18,
        evaluator: "cited_sources", evaluator_digest: "a".repeat(64),
        input_digest: "b".repeat(64), measurement_kind: "script",
      }],
    }), "utf-8");
    await acquireModelMetric(ws, "review_score");
    const envelope = JSON.parse(await fs.readFile(path.join(ws, "reports/measurements.json"), "utf-8"));
    // An acquisition stage that replaced the envelope would delete every
    // script metric measured moments earlier.
    expect(envelope.measurements.map((m: { metric: string }) => m.metric).sort())
      .toEqual(["cited_sources", "review_score"]);
  });

  it("refuses to acquire a script metric", async () => {
    const ws = await workspaceWithScorecard({ version: 1, personas: [{ id: "a", score: 5 }] });
    await expect(acquireModelMetric(ws, "cited_sources")).rejects.toThrow(/script metric/);
  });
});

describe("external metric acquisition", () => {
  it("refuses to certify a release build that a placeholder engine never made", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-latex-acquire-"));
    roots.push(ws);
    await fs.mkdir(path.join(ws, "reports"), { recursive: true });
    const read = async () =>
      JSON.parse(await fs.readFile(path.join(ws, "reports", "measurements.json"), "utf-8"))
        .measurements.find((m: { metric: string }) => m.metric === "latex_build_status");

    await fs.writeFile(path.join(ws, "reports", "latex-build.md"),
      "# LaTeX build\n\n- Engine: placeholder\n- Real PDF compiled: no\n", "utf-8");
    await acquireExternalMetric(ws, "latex_build_status", "2026-09-01T00:00:00.000Z");
    const placeholder = await read();
    // Scoring this 1 let a repair be accepted, and a build invariant preserved,
    // on the strength of a PDF nobody could publish. It is not a build failure
    // either — nothing was attempted — so the honest answer is that the metric
    // is unavailable, not that it is zero.
    expect(placeholder).toMatchObject({ status: "unavailable", measurement_kind: "external" });
    expect(placeholder.reason).toContain("no real PDF");
    expect(placeholder.value).toBeUndefined();

    // A real engine that failed IS a measured zero: the build was exercised and
    // it did not produce a usable PDF.
    await fs.writeFile(path.join(ws, "reports", "latex-build.md"),
      "# LaTeX build\n\n- Engine: pdflatex\n- Real PDF compiled: no\n", "utf-8");
    await acquireExternalMetric(ws, "latex_build_status", "2026-09-01T00:00:00.000Z");
    expect(await read()).toMatchObject({ status: "measured", value: 0, measurement_kind: "external" });

    // And a real engine that succeeded is the only 1.
    await fs.writeFile(path.join(ws, "reports", "latex-build.md"),
      "# LaTeX build\n\n- Engine: pdflatex\n- Real PDF compiled: yes\n", "utf-8");
    await acquireExternalMetric(ws, "latex_build_status", "2026-09-01T00:00:00.000Z");
    const compiled = await read();
    expect(compiled).toMatchObject({ status: "measured", value: 1 });
    // The report bytes are the toolchain fingerprint: a different build cannot
    // reuse this observation.
    expect(compiled.input_digest).not.toBe(placeholder.input_digest);
  });
});
