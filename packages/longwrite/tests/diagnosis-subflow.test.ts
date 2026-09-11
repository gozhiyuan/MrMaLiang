import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildDiagnosisPacket, ATTEMPTS_PATH, type AttemptRecord } from "../src/lib/ops/diagnosis-packet.js";
import { compileModeToManifest } from "../src/lib/compiler.js";
import { loadMode } from "../src/lib/modes.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

type CompiledStage = { id: string; phase?: string; model_tier?: string; owns?: string[]; kind?: string; when?: string };

async function compiledStages(): Promise<CompiledStage[]> {
  const mode = await loadMode("auto_research_agentic");
  const manifest = await compileModeToManifest(mode, {
    projectId: "diagnosis-fixture", artifactType: "research_paper",
    topic: "diagnosis", researchProvider: "seed",
  } as never);
  return (manifest.workflow.stages as CompiledStage[]);
}

async function workspaceWithHistory(objective: string, attempts: Array<Partial<AttemptRecord>>): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-diagnosis-packet-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "repair"), { recursive: true });
  await fs.writeFile(path.join(ws, ATTEMPTS_PATH),
    attempts.map((attempt) => JSON.stringify({
      objective, metric: "cited_sources", ...attempt,
    })).join("\n"), "utf-8");
  // One recorded observation for the metric those attempts moved.
  const store = path.join(ws, ".malaclaw", "observations", encodeURIComponent("cited_sources"), "_global");
  await fs.mkdir(store, { recursive: true });
  await fs.writeFile(path.join(store, "obs1.json"), JSON.stringify({
    metric: "cited_sources", scope_key: "", value: 12, sequence: 1,
    measured_at: new Date().toISOString(),
  }), "utf-8");
  return ws;
}

describe("diagnosis subflow", () => {
  it("compiles a diagnose_objective stage into the improve phase", async () => {
    const stage = (await compiledStages()).find((entry) => entry.id === "diagnose_objective");
    expect(stage).toBeDefined();
    expect(stage?.phase).toBe("improve");
  });

  it("never names a model tier the manifest does not declare", async () => {
    const mode = await loadMode("auto_research_agentic");
    const manifest = await compileModeToManifest(mode, {
      projectId: "diagnosis-fixture", artifactType: "research_paper",
      topic: "diagnosis", researchProvider: "seed",
    } as never) as { workflow: { model_tiers?: Record<string, unknown>; stages: CompiledStage[] } };
    const declared = new Set(Object.keys(manifest.workflow.model_tiers ?? {}));
    const tier = manifest.workflow.stages.find((s) => s.id === "diagnose_objective")?.model_tier;
    // Diagnosis wants the highest tier available, and a tier the manifest
    // never defined is rejected by the engine before the flow starts — so it
    // runs at "high" where one exists and at the default where none does.
    if (declared.has("high")) expect(tier).toBe("high");
    else expect(tier).toBeUndefined();
  });

  it("declares the diagnosis stage as owning only its decision artifact", async () => {
    const stage = (await compiledStages()).find((s) => s.id === "diagnose_objective")!;
    // Diagnosis produces a decision, never a manuscript edit.
    expect(stage.owns).toEqual(["reviews/diagnosis.json"]);
    expect(stage.kind).toBe("mutation");
  });

  it("is reached by the kernel's declared diagnose transition, not a guard", async () => {
    const stages = await compiledStages();
    const flatten = (list: CompiledStage[]): CompiledStage[] =>
      list.flatMap((stage) => [stage, ...flatten((stage as { stages?: CompiledStage[] }).stages ?? [])]);
    // `diagnose_requested` was a domain variable the kernel never defined, so
    // a guard on it could only ever make the stage look skipped. The dispatch
    // stage names this stage in `on_diagnose` instead.
    expect(stages.find((s) => s.id === "diagnose_objective")?.when).toBeUndefined();
    const dispatch = flatten(stages).find((s) => s.id === "action_dispatch") as
      { on_diagnose?: string } | undefined;
    expect(dispatch?.on_diagnose).toBe("diagnose_objective");
  });

  it("carries the full attempt history for the objective", async () => {
    const ws = await workspaceWithHistory("obj1", [
      { fingerprint: "f1", capability: "revise_visual_plan", effect: "repair_artifact_content", outcome: "unmet" },
      { fingerprint: "f2", capability: "revise_visual_plan", effect: "repair_artifact_placement", outcome: "unmet" },
    ]);
    const packet = await buildDiagnosisPacket(ws, "obj1");
    // The one unit that sees everything already tried; that is why repeated
    // strategies can be rejected strictly everywhere else.
    expect(packet.prior_attempts).toHaveLength(2);
  });

  it("carries the observation history for the objective's metric", async () => {
    const ws = await workspaceWithHistory("obj1", [
      { fingerprint: "f1", capability: "targeted_research_expansion",
        effect: "acquire_additional_evidence", outcome: "unmet" },
    ]);
    expect((await buildDiagnosisPacket(ws, "obj1")).observations.length).toBeGreaterThan(0);
  });

  it("carries the reachability verdict, reporting unknown rather than assuming", async () => {
    const ws = await workspaceWithHistory("obj1", []);
    const packet = await buildDiagnosisPacket(ws, "obj1");
    // Answering "reachable" because nothing computed it would send another
    // round at a target nothing can hit.
    expect(packet.reachability).toBeDefined();
    expect(packet.reachability.status).toBe("unknown");
  });

  it("carries the packet the failed action received", async () => {
    const ws = await workspaceWithHistory("obj1", [
      { fingerprint: "f1", capability: "revise_sections", effect: "add_supporting_citation",
        outcome: "unmet", action_id: "a1" },
    ]);
    await fs.mkdir(path.join(ws, "repair", "a1"), { recursive: true });
    await fs.writeFile(path.join(ws, "repair", "a1", "packet.json"),
      JSON.stringify({ version: 1, action_id: "a1" }), "utf-8");
    expect((await buildDiagnosisPacket(ws, "obj1")).failed_packet).toBeDefined();
    expect((await buildDiagnosisPacket(ws, "obj1")).failed_packet).not.toBeNull();
  });
});
