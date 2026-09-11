import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { unreachableObjectives, writeReachabilityVerdict } from "../src/lib/research/gate-reachability.js";
import { compileModeToManifest } from "../src/lib/compiler.js";
import { loadMode } from "../src/lib/modes.js";
import { PreDispatchVerdict } from "malaclaw/sdk";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

async function workspace(gates: unknown[], evaluated = true): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-reach-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "reports"), { recursive: true });
  await fs.writeFile(path.join(ws, "reports", "gate-reachability.json"),
    JSON.stringify({ version: 1, evaluated, gates }), "utf-8");
  return ws;
}

type Stage = { id: string; when?: string; outputs?: string[] };
async function compiledStages(): Promise<Stage[]> {
  const mode = await loadMode("auto_research_agentic");
  const manifest = await compileModeToManifest(mode, {
    projectId: "reach-fixture", artifactType: "research_paper",
    topic: "reach", researchProvider: "seed",
  } as never) as { workflow: { stages: Stage[] } };
  return manifest.workflow.stages;
}

describe("reachability verdict", () => {
  it("reports an unreachable objective with its capacity shortfall", async () => {
    const ws = await workspace([
      { id: "landmark_coverage", reachable: false, required: 12, available: 3,
        detail: "only 3 of 12 landmarks have open full text" },
      { id: "prose_redundancy", reachable: true, required: 0, available: 0, detail: "" },
    ]);
    const unreachable = await unreachableObjectives(ws);
    expect(unreachable).toHaveLength(1);
    expect(unreachable[0].gate).toBe("landmark_coverage");
    expect(unreachable[0].detail).toContain("3 of 12");
  });

  it("returns nothing when every objective is reachable", async () => {
    expect(await unreachableObjectives(await workspace([
      { id: "prose_redundancy", reachable: true, required: 0, available: 0, detail: "" },
    ]))).toEqual([]);
  });

  it("returns nothing when reachability has not been evaluated", async () => {
    // Absence of analysis is not proof of infeasibility.
    expect(await unreachableObjectives(await workspace([], false))).toEqual([]);
  });

  it("returns nothing when no report exists at all", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-reach-none-"));
    roots.push(ws);
    expect(await unreachableObjectives(ws)).toEqual([]);
  });

  it("writes a verdict the kernel can actually read before dispatch", async () => {
    const ws = await workspace([
      { id: "landmark_coverage", reachable: false, required: 12, available: 3, detail: "only 3 of 12" },
    ]);
    const written = await writeReachabilityVerdict(ws);
    // Parsed with the KERNEL's schema, which is the only reader that matters.
    // This file used to carry `evaluated_at`, a `verdict` string and
    // `gate`/`required`/`available` entries; `PreDispatchVerdict` is strict, so
    // every read of it failed and the engine treated the control as absent. It
    // was declared, produced, and never once enforced.
    const verdict = PreDispatchVerdict.parse(
      JSON.parse(await fs.readFile(path.join(ws, written), "utf-8")));
    expect(verdict.unreachable).toHaveLength(1);
    expect(verdict.unreachable[0]!.objective).toBe("landmark_coverage");
    expect(verdict.unreachable[0]!.detail).toContain("3 of 12");
    expect(verdict.requires_diagnosis).toEqual([]);
  });

  it("writes an empty verdict the kernel reads as proceed", async () => {
    const ws = await workspace([{ id: "prose_redundancy", reachable: true, required: 0, available: 0, detail: "" }]);
    const verdict = PreDispatchVerdict.parse(
      JSON.parse(await fs.readFile(path.join(ws, await writeReachabilityVerdict(ws)), "utf-8")));
    expect(verdict.unreachable).toEqual([]);
  });

  it("compiles a pre-dispatch reachability stage, not a when guard", async () => {
    const stages = await compiledStages();
    const stage = stages.find((s) => s.id === "assess_reachability")!;
    expect(stage).toBeDefined();
    expect(stage.outputs).toContain("reports/reachability-verdict.json");
    // A `when` guard would make an unreachable phase read as skipped rather
    // than paused on a named, actionable objective.
    for (const entry of stages.filter((s) => s.id.startsWith("improve"))) {
      expect(entry.when ?? "").not.toMatch(/unreachable/);
    }
  });
});
