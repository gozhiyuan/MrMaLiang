import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compileModeToManifest } from "../src/lib/compiler.js";
import { loadMode } from "../src/lib/modes.js";
import { runMaterializeAction, runReachabilityVerdict, runCostProbe } from "../src/commands/dispatch.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

type Stage = {
  id: string; type?: string; when?: string; stages?: Stage[];
  materializer?: { args: string[] }; verdict_inputs?: string[];
  cost_probe?: { args: string[] }; on_diagnose?: string;
};

/** Flattened: the dispatch stage lives inside the improve loop, and asserting
 * on top-level stages alone would silently find nothing. */
function flatten(stages: Stage[]): Stage[] {
  return stages.flatMap((stage) => [stage, ...flatten(stage.stages ?? [])]);
}

async function compiledStages(): Promise<Stage[]> {
  const mode = await loadMode("auto_research_agentic");
  const manifest = await compileModeToManifest(mode, {
    projectId: "dispatch-fixture", artifactType: "research_paper",
    topic: "dispatch", researchProvider: "seed",
  } as never) as { workflow: { stages: Stage[] } };
  return flatten(manifest.workflow.stages);
}

const revisionDispatch = async (): Promise<Stage> =>
  (await compiledStages()).find((s) => s.id === "action_dispatch")!;

async function workspace(): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-dispatch-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "chapters"), { recursive: true });
  await fs.mkdir(path.join(ws, "reports"), { recursive: true });
  await fs.writeFile(path.join(ws, "chapters", "section-03.md"), "Alpha.\n\nBeta.\n", "utf-8");
  return ws;
}

describe("kernel dispatch wiring", () => {
  it("declares a materializer on the dispatch stage", async () => {
    expect((await revisionDispatch()).materializer?.args)
      .toEqual(expect.arrayContaining(["materialize-action"]));
  });

  it("declares the reachability verdict as a dispatch input", async () => {
    expect((await revisionDispatch()).verdict_inputs).toContain("reports/reachability-verdict.json");
  });

  it("declares a cost probe the scheduler can compare to run limits", async () => {
    expect((await revisionDispatch()).cost_probe).toBeDefined();
    expect((await revisionDispatch()).cost_probe?.args).toEqual(expect.arrayContaining(["cost-probe"]));
  });

  it("declares the diagnosis stage as the diagnose target", async () => {
    const dispatch = await revisionDispatch();
    // `diagnose_requested` was never a kernel concept; the transition is
    // declared, not smuggled through a `when` expression.
    expect(dispatch.on_diagnose).toBe("diagnose_objective");
    for (const stage of await compiledStages()) {
      expect(stage.when ?? "", stage.id).not.toMatch(/diagnose_requested/);
      expect(stage.when ?? "", stage.id).not.toMatch(/unreachable_objectives/);
    }
  });
});

describe("the three commands the kernel drives", () => {
  it("writes a MaterializationResult to --output rather than stdout", async () => {
    const ws = await workspace();
    const request = path.join(ws, "repair", "a1", "request.json");
    await fs.mkdir(path.dirname(request), { recursive: true });
    await fs.writeFile(request, JSON.stringify({
      action_id: "a1",
      findings: [{
        id: "f1", gate_id: "figure_references",
        artifact: { kind: "chapter_prose", path: "chapters/section-03.md" },
        objective_scope_key: "", required_effect: "add_explicit_artifact_reference",
        acceptance_metric: null, severity: "major", diagnostic: "Figure 1 is not named.",
      }],
      observations: { "claim_support ": 0.94, "citation_verification_status ": 1, "cited_sources ": 18 },
    }), "utf-8");
    const output = path.join(ws, "repair", "a1", "instance.json");
    await runMaterializeAction(ws, { request, output });
    const instance = JSON.parse(await fs.readFile(output, "utf-8"));
    expect(instance.from_template).toBe("revise_sections");
    expect(instance.kind).toBe("action_instance");
  });

  it("refuses to run without the transport the kernel appends", async () => {
    const ws = await workspace();
    // A command that cannot accept --request/--output can be described in a
    // manifest and never executed.
    await expect(runMaterializeAction(ws, {})).rejects.toThrow(/--request/);
    await expect(runReachabilityVerdict(ws, {})).rejects.toThrow(/--output/);
    await expect(runCostProbe(ws, {})).rejects.toThrow(/--output/);
  });

  it("writes a verdict carrying both unreachable and unclassified failures", async () => {
    const ws = await workspace();
    await fs.writeFile(path.join(ws, "reports", "gate-reachability.json"), JSON.stringify({
      version: 1, evaluated: true,
      gates: [{ id: "landmark_coverage", reachable: false, required: 12, available: 3, detail: "only 3 of 12" }],
    }), "utf-8");
    await fs.writeFile(path.join(ws, "reports", "longwrite-validation.json"), JSON.stringify({
      pass: false,
      checks: [
        { id: "latex_build", pass: false, requires_diagnosis: true, diagnostic: "pdflatex exited 1 with no classified cause" },
        { id: "prose_redundancy", pass: false, requires_diagnosis: false },
      ],
    }), "utf-8");
    const output = path.join(ws, "reports", "reachability-verdict.json");
    await runReachabilityVerdict(ws, { output });
    const verdict = JSON.parse(await fs.readFile(output, "utf-8"));
    expect(verdict.unreachable[0].objective).toBe("landmark_coverage");
    // Without this, a check nothing could classify stalls the round on a red
    // gate with no next step.
    expect(verdict.requires_diagnosis[0].objective).toBe("latex_build");
    expect(verdict.requires_diagnosis).toHaveLength(1);
  });

  it("prices the round in the units the run limits use", async () => {
    const ws = await workspace();
    const request = path.join(ws, "reports", "round.json");
    await fs.writeFile(request, JSON.stringify({ metrics: ["review_score", "core_sources"] }), "utf-8");
    const output = path.join(ws, "reports", "cost.json");
    await runCostProbe(ws, { request, output });
    const cost = JSON.parse(await fs.readFile(output, "utf-8"));
    expect(cost.model_calls).toBe(5);
    expect(cost.renders).toBe(0);
  });

  it("prices the round tier when no request names metrics", async () => {
    const ws = await workspace();
    const output = path.join(ws, "reports", "cost.json");
    // Pricing nothing would report every round as free.
    await runCostProbe(ws, { output });
    const cost = JSON.parse(await fs.readFile(output, "utf-8"));
    expect(typeof cost.model_calls).toBe("number");
    expect(cost.version).toBe(1);
  });
});

describe("the verdict the kernel parses", () => {
  it("matches the kernel's PreDispatchVerdict schema", async () => {
    const { PreDispatchVerdict } = await import("malaclaw/sdk");
    const ws = await workspace();
    const output = path.join(ws, "reports", "reachability-verdict.json");
    await runReachabilityVerdict(ws, { output });
    // Parsed by the kernel's own schema: a shape only this repository accepted
    // would fail at the boundary, which is the one place it cannot be seen.
    expect(PreDispatchVerdict.safeParse(JSON.parse(await fs.readFile(output, "utf-8"))).success).toBe(true);
  });

  it("matches the kernel's CostEstimate schema", async () => {
    const { CostEstimate } = await import("malaclaw/sdk");
    const ws = await workspace();
    const output = path.join(ws, "reports", "cost.json");
    await runCostProbe(ws, { output });
    expect(CostEstimate.safeParse(JSON.parse(await fs.readFile(output, "utf-8"))).success).toBe(true);
  });
});
