import { describe, expect, it } from "vitest";
import { compileModeToManifest } from "../src/lib/compiler.js";
import { loadMode } from "../src/lib/modes.js";
import { CAPABILITY_TEMPLATES } from "../src/lib/registry/capabilities.js";
import { METRIC_REGISTRY, metricDefinition, metricsOfTier } from "../src/lib/registry/metrics.js";
import { metricId } from "../src/lib/registry/ids.js";

type Stage = {
  id: string; kind?: string; type?: string; owns?: string[]; writes?: string[];
  writes_observations?: string[]; evaluate_with?: string[]; acceptance?: unknown[];
  stages?: Stage[]; steps?: Stage[];
};

function flatten(stages: Stage[]): Stage[] {
  return stages.flatMap((stage) => [stage, ...flatten(stage.stages ?? []), ...flatten(stage.steps ?? [])]);
}

async function compiled(): Promise<{ workflow: { ir_version?: number; stages: Stage[]; tool_catalog?: Stage[] } }> {
  const mode = await loadMode("auto_research_agentic");
  return await compileModeToManifest(mode, {
    projectId: "topology-fixture", artifactType: "research_paper",
    topic: "topology", researchProvider: "seed",
  } as never) as never;
}

describe("compiled contract topology", () => {
  it("gives every mutation unit an owns envelope", async () => {
    const manifest = await compiled();
    const units = [...flatten(manifest.workflow.stages), ...(manifest.workflow.tool_catalog ?? [])];
    for (const unit of units.filter((stage) => stage.kind === "mutation")) {
      // A mutation with no envelope may change anything, which is the same as
      // declaring nothing at all.
      expect((unit.owns ?? []).length, `${unit.id} declares no owns envelope`).toBeGreaterThan(0);
    }
  });

  it("never lets a mutation unit write its own observations", async () => {
    const manifest = await compiled();
    for (const unit of flatten(manifest.workflow.stages).filter((stage) => stage.kind === "mutation")) {
      // A unit that grades its own change is not measured, it is asserted.
      expect(unit.writes_observations ?? [], unit.id).toEqual([]);
    }
  });

  it("declares no acceptance on a catalog template", async () => {
    const manifest = await compiled();
    for (const entry of manifest.workflow.tool_catalog ?? []) {
      // The gate and scope are known only at dispatch; a baked-in criterion
      // would be one criterion pretending to cover every dispatch.
      expect("acceptance" in entry, `${entry.id} bakes in acceptance`).toBe(false);
    }
  });

  it("emits ir_version 2", async () => {
    expect((await compiled()).workflow.ir_version).toBe(2);
  });

  it("declares a measurement stage for every name referenced by evaluate_with", async () => {
    const manifest = await compiled();
    const declared = new Set(flatten(manifest.workflow.stages).map((stage) => stage.id));
    const referenced = [
      ...flatten(manifest.workflow.stages).flatMap((stage) => stage.evaluate_with ?? []),
      ...(manifest.workflow.tool_catalog ?? []).flatMap((entry) => entry.evaluate_with ?? []),
    ];
    expect(referenced.length).toBeGreaterThan(0);
    for (const name of referenced) {
      // A name that resolves to nothing reports the OBJECTIVE as unmeasurable
      // when the defect is in the manifest.
      expect(declared.has(name), `evaluate_with names ${name}, which no stage declares`).toBe(true);
    }
  });

  it("declares every measurement unit as kind measurement with no envelope", async () => {
    const manifest = await compiled();
    const measurements = flatten(manifest.workflow.stages)
      .filter((stage) => (stage.writes_observations ?? []).length > 0);
    expect(measurements.length).toBeGreaterThan(0);
    for (const stage of measurements) {
      expect(stage.kind, stage.id).toBe("measurement");
      expect(stage.owns ?? [], stage.id).toEqual([]);
    }
  });

  it("protects only registered metrics on every template", async () => {
    for (const template of CAPABILITY_TEMPLATES.values()) {
      for (const metric of template.must_preserve_template) {
        expect(METRIC_REGISTRY.has(metricId(String(metric))), `${template.id} protects ${metric}`).toBe(true);
      }
    }
  });

  it("gives every registered metric exactly one producing unit", async () => {
    const manifest = await compiled();
    const producers = new Map<string, string[]>();
    for (const stage of flatten(manifest.workflow.stages)) {
      for (const metric of stage.writes_observations ?? []) {
        producers.set(metric, [...(producers.get(metric) ?? []), stage.id]);
      }
    }
    for (const tier of ["unit", "round"] as const) {
      for (const metric of metricsOfTier(tier)
        .filter((metric) => metricDefinition(metric).measurement_kind === "script").map(String)) {
        // Two producers for one metric is two answers to the same question,
        // and nothing decides which one the contract was judged on.
        expect(producers.get(metric)?.length ?? 0, `${metric} producers: ${producers.get(metric)?.join(", ") ?? "none"}`).toBe(1);
      }
    }
    for (const metric of metricsOfTier("round")
      .filter((metric) => metricDefinition(metric).measurement_kind === "external").map(String)) {
      expect(producers.get(metric)?.length ?? 0, `${metric} producers: ${producers.get(metric)?.join(", ") ?? "none"}`).toBe(1);
    }
  });
});
