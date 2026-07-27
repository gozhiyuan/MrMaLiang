import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compileExperimentToManifest } from "../src/lib/compiler.js";
import { ExperimentConfig } from "../src/lib/schema.js";
import { addCandidateNode, initializeLineage, readLineage } from "../src/lib/lineage.js";
import { initializeResearchState, readResearchState } from "../src/lib/research-state.js";
import { readDeadEndMemory } from "../src/lib/dead-ends.js";
import { auditRoundCandidate, promoteRound, validateRoundPlan } from "../src/lib/research-round.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

function config(overrides: Record<string, unknown> = {}): ExperimentConfig {
  return ExperimentConfig.parse({
    version: 1, project: { id: "autoresearch-poc" }, pilot: "repository_optimization",
    hypothesis: "A bounded search finds a better training configuration than the frozen baseline.",
    inputs: { code: [{ id: "autoresearch", source: "https://github.com/karpathy/autoresearch", revision: "a".repeat(40), materialize: "git" }] },
    evaluation: {
      primary_metric: "val_bpb", direction: "minimize", baseline_id: "baseline",
      control: "fixed five-minute evaluator", seeds: [0, 1], statistical_test: "strict metric comparison",
    },
    suite: {
      id: "suite", max_rounds: 2,
      studies: [{ id: "primary", kind: "training_ablation", conditions: ["baseline", "candidate"], acceptance_criteria: ["metric improves"] }],
    },
    runner: { kind: "command", command: "true" },
    execution: { max_trials: 20, max_active_run_minutes: 60, max_parallel_trials: 2, requires_design_approval: true, requires_revision_approval: true },
    research: { max_rounds: 8, max_candidates_per_round: 3, max_stagnant_rounds: 2, minimum_improvement: 0 },
    ...overrides,
  });
}

function proposal(id: string, family: string, changedPaths = ["train.py"]): Record<string, unknown> {
  return {
    version: 1, id, author_id: "analyst-a", parent_champion_id: "baseline", hypothesis_family: family,
    mechanism: "Widening the residual stream increases capacity per step.",
    prediction: "Validation bits-per-byte decreases by at least 0.01.",
    falsification: "No decrease outside the confirmation seed interval.",
    requested_change: "Increase model width and rebalance the learning rate.",
    changed_paths: changedPaths, estimated_cost: { trials: 1, gpu_hours: 0.5, wall_minutes: 20 },
  };
}
function critique(proposalId: string): Record<string, unknown> {
  return { version: 1, proposal_id: proposalId, author_id: "analyst-b", verdict: "accept", findings: ["Mechanism is plausible and testable within budget."] };
}

async function seedWorkspace(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "longexperiment-loop-")); dirs.push(workspace);
  await initializeLineage(workspace, { id: "baseline", round_id: "baseline", branch: "main", commit_sha: "a".repeat(40), status: "completed", primary_metric: 1.2 });
  await initializeResearchState(workspace, { pilot: "repository_optimization", champion_node_id: "baseline" });
  return workspace;
}

async function writeProposals(workspace: string, payload: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.join(workspace, "runs", "active-round"), { recursive: true });
  await fs.writeFile(path.join(workspace, "runs", "active-round", "proposals.raw.json"), JSON.stringify(payload), "utf8");
}

async function writeRawResults(workspace: string, candidateId: string, metric: number | null): Promise<void> {
  const dir = path.join(workspace, "results", "studies", candidateId);
  await fs.mkdir(dir, { recursive: true });
  const body = metric === null
    ? { status: "failed", trials: [] }
    : { status: "completed", trials: [0, 1].map((seed) => ({ condition: "candidate", seed, metrics: { val_bpb: metric } })) };
  await fs.writeFile(path.join(dir, "raw-results.json"), JSON.stringify(body), "utf8");
}

describe("compiled research loop", () => {
  it("orders validation before compute and promotion after audit", () => {
    const manifest = compileExperimentToManifest(config()) as { workflow: { stages: Array<Record<string, any>>; run_limits: Record<string, unknown> } };
    const stages = manifest.workflow.stages;
    const loop = stages.find((stage) => stage.id === "research_loop");

    expect(loop).toMatchObject({ type: "loop", max_rounds: 8, stop_when: "research_stop >= 1", on_exhaustion: "succeed" });
    // Run limits are engine policy and must survive the pilot branch.
    expect(manifest.workflow.run_limits).toMatchObject({ max_active_run_minutes: 60, on_limit: "pause" });

    const ids = loop!.stages.map((stage: Record<string, unknown>) => stage.id);
    expect(ids).toEqual(["propose", "validate_plan", "materialize_candidates", "execute_candidates", "promote"]);
    // Validation must precede any fan-out that spends compute.
    expect(ids.indexOf("validate_plan")).toBeLessThan(ids.indexOf("execute_candidates"));

    const fanout = loop!.stages.find((stage: Record<string, unknown>) => stage.id === "execute_candidates");
    expect(fanout).toMatchObject({ type: "foreach", foreach: "runs/active-round/candidates.items", item_name: "candidate" });
    // A proposal must become a real, policy-checked commit before it costs
    // anything: implement -> verify -> execute -> audit. Without implement the
    // loop re-measured the baseline for every candidate.
    expect(fanout.steps.map((step: Record<string, unknown>) => step.id)).toEqual(["implement", "verify", "execute", "audit"]);
    const stepIds = fanout.steps.map((step: Record<string, unknown>) => step.id);
    expect(stepIds.indexOf("verify")).toBeLessThan(stepIds.indexOf("execute"));
    // verify is deterministic; an agent never certifies its own diff.
    expect(fanout.steps[1]).toMatchObject({ id: "verify", runtime: "script" });

    // Only the promote stage may write champion state and the stop metric.
    const promote = loop!.stages.find((stage: Record<string, unknown>) => stage.id === "promote");
    expect(promote.outputs).toContain("reports/metrics.json");
    expect(promote.outputs).toContain("runs/lineage.json");
    const writesMetrics = loop!.stages.filter((stage: Record<string, any>) => (stage.outputs ?? []).includes("reports/metrics.json"));
    expect(writesMetrics).toHaveLength(1);

    // A baseline must be measured and audited before the search starts.
    expect(stages.map((stage) => stage.id).slice(0, 5)).toEqual(["pin_inputs", "research_init", "baseline_execute", "baseline_audit", "research_loop"]);
  });

  it("leaves workspaces that never opted in on the single-candidate pipeline", () => {
    // Declaring a pilot alone must not convert an existing experiment into a
    // search; only an explicit research: policy does.
    const manifest = compileExperimentToManifest(config({ research: undefined })) as { workflow: { stages: Array<{ id?: string }> } };
    expect(manifest.workflow.stages.some((stage) => stage.id === "research_loop")).toBe(false);
    expect(manifest.workflow.stages.some((stage) => stage.id === "suite_plan")).toBe(true);
  });
});

describe("round plan validation", () => {
  it("rejects uncritiqued, duplicate, and out-of-policy proposals before compute", async () => {
    const workspace = await seedWorkspace();
    await writeProposals(workspace, {
      version: 1,
      proposals: [
        proposal("widen-a", "capacity"),
        proposal("widen-b", "capacity"),                       // same family + path as widen-a
        proposal("touch-evaluator", "evaluator", ["prepare.py"]), // protected path
        proposal("uncritiqued", "schedule"),
      ],
      critiques: [critique("widen-a"), critique("widen-b"), critique("touch-evaluator")],
    });

    const plan = await validateRoundPlan(workspace, config());

    expect(plan.candidates.map((candidate) => candidate.id)).toEqual(["widen-a"]);
    const rejected = Object.fromEntries(plan.rejected.map((entry) => [entry.proposal_id, entry.reasons.join(" ")]));
    expect(rejected["widen-b"]).toMatch(/same hypothesis family/);
    expect(rejected["touch-evaluator"]).toMatch(/mutation policy/);
    expect(rejected["uncritiqued"]).toMatch(/non-author critique/);

    // The round is registered in lineage and the foreach source is written.
    expect((await readLineage(workspace)).rounds.map((round) => round.id)).toContain("round-1");
    // The foreach source is candidates.json's own `items` array; a sibling
    // candidates.items.json would never be opened by the engine.
    const document = JSON.parse(await fs.readFile(path.join(workspace, "runs", "active-round", "candidates.json"), "utf8"));
    expect(document.items).toEqual([{ id: "widen-a" }]);
  });

  it("fails the round when nothing survives validation", async () => {
    const workspace = await seedWorkspace();
    await writeProposals(workspace, { version: 1, proposals: [proposal("solo", "capacity")], critiques: [] });
    await expect(validateRoundPlan(workspace, config())).rejects.toThrow(/no proposal that survives/);
  });
});

describe("promotion", () => {
  async function runRound(workspace: string, results: Record<string, number | null>): Promise<void> {
    await writeProposals(workspace, {
      version: 1,
      // Distinct hypothesis families so the novelty gate keeps all of them;
      // train.py is the only path this pilot's mutation policy permits.
      proposals: Object.keys(results).map((id, index) => proposal(id, `family-${index}`, ["train.py"])),
      critiques: Object.keys(results).map((id) => critique(id)),
    });
    const plan = await validateRoundPlan(workspace, config());
    // Stand in for materialize-candidates, which needs a real git repo. A node
    // only exists once a branch does, so promotion tests must create it here.
    const state = await readResearchState(workspace);
    for (const [index, candidate] of plan.candidates.entries()) {
      await addCandidateNode(workspace, {
        id: candidate.id, parent_id: state.champion_node_id, round_id: plan.round_id,
        hypothesis_id: candidate.hypothesis_family, branch: candidate.branch,
        commit_sha: String(index + 1).repeat(40).slice(0, 40), status: "materialized",
      });
    }
    for (const [id, metric] of Object.entries(results)) {
      await writeRawResults(workspace, id, metric);
      await auditRoundCandidate(workspace, config(), id);
    }
  }

  it("promotes the best audited candidate and records every loser as a dead end", async () => {
    const workspace = await seedWorkspace();
    // Metric is minimized: 0.9 beats the 1.2 baseline, 1.5 regresses, null crashes.
    await runRound(workspace, { "cand-win": 0.9, "cand-worse": 1.5, "cand-crash": null });

    const promotion = await promoteRound(workspace, config());

    expect(promotion.winner_node_id).toBe("cand-win");
    expect(promotion.champion_improvement).toBeCloseTo(0.3, 10);
    expect(promotion.stop).toBe(false);

    const graph = await readLineage(workspace);
    expect(graph.champion_node_id).toBe("cand-win");
    expect(graph.nodes.filter((node) => node.kind === "dead_end").map((node) => node.id).sort()).toEqual(["cand-crash", "cand-worse"]);
    expect(graph.rounds.find((round) => round.id === "round-1")?.winner_node_id).toBe("cand-win");

    const memory = await readDeadEndMemory(workspace);
    expect(memory.evidence.map((entry) => entry.outcome).sort()).toEqual(["crashed", "discarded"]);

    const metrics = JSON.parse(await fs.readFile(path.join(workspace, "reports", "metrics.json"), "utf8"));
    expect(metrics).toMatchObject({ research_stop: 0, consecutive_non_improving_rounds: 0, round: 1 });

    // The active round is archived so the next round cannot reuse it.
    await expect(fs.access(path.join(workspace, "runs", "rounds", "active.json"))).rejects.toThrow();
    await expect(fs.access(path.join(workspace, "runs", "rounds", "archive", "round-1.json"))).resolves.toBeUndefined();
  });

  it("stops the search after the configured stagnant rounds", async () => {
    const workspace = await seedWorkspace();
    const stagnant = config({ research: { max_rounds: 8, max_candidates_per_round: 3, max_stagnant_rounds: 2, minimum_improvement: 0 } });

    await runRound(workspace, { "round1-a": 1.5 });
    const first = await promoteRound(workspace, stagnant);
    expect(first).toMatchObject({ winner_node_id: null, stop: false });
    expect((await readResearchState(workspace)).stagnation_rounds).toBe(1);

    await runRound(workspace, { "round2-a": 1.6 });
    const second = await promoteRound(workspace, stagnant);

    expect(second).toMatchObject({ winner_node_id: null, stop: true });
    // The profile's own stopping rule is consulted first, so its reason wins
    // over the generic config ceiling when both would fire on the same round.
    expect(second.stop_reason).toMatch(/stagnant|without a promotion/);
    const state = await readResearchState(workspace);
    expect(state).toMatchObject({ status: "completed", champion_node_id: "baseline", current_round: 2 });
    const metrics = JSON.parse(await fs.readFile(path.join(workspace, "reports", "metrics.json"), "utf8"));
    expect(metrics.research_stop).toBe(1);
  });

  it("never promotes an improvement that sits inside measured noise", async () => {
    const workspace = await seedWorkspace();
    await runRound(workspace, { "noisy": 1.1 });
    // Overwrite the audit with an interval that straddles zero improvement.
    const auditPath = path.join(workspace, "results", "studies", "noisy", "audit.json");
    const audit = JSON.parse(await fs.readFile(auditPath, "utf8"));
    await fs.writeFile(auditPath, JSON.stringify({ ...audit, confidence: { lower: -0.4, upper: 0.2 } }), "utf8");

    const promotion = await promoteRound(workspace, config());

    expect(promotion.winner_node_id).toBeNull();
    expect((await readLineage(workspace)).champion_node_id).toBe("baseline");
  });
});
