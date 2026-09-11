import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgenticActionPlan, capabilityOf } from "../src/lib/ops/action-plan.js";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

async function sources(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await sources(full));
    else if (full.endsWith(".ts")) found.push(full);
  }
  return found;
}

const structured = {
  id: "f1", gate_id: "figure_references",
  artifact: { kind: "chapter_prose", path: "chapters/section-03.md" },
  objective_scope_key: "", required_effect: "add_explicit_artifact_reference",
  acceptance_metric: null, severity: "major",
  diagnostic: "Figure 1 is not named before its placement.",
};

describe("legacy router retirement", () => {
  it("no longer ships repair-routing.ts", async () => {
    await expect(fs.access(path.join(SRC, "lib/ops/repair-routing.ts"))).rejects.toThrow();
  });

  it("has no remaining consumer of the legacy router", async () => {
    // The registry could pass every test while production kept its old
    // default-routing behavior; this is the check that prevents that.
    const offenders: string[] = [];
    for (const file of await sources(SRC)) {
      const body = await fs.readFile(file, "utf-8");
      if (/repairRouteForGate|gateOwnedByTool/.test(body)) offenders.push(path.relative(SRC, file));
    }
    expect(offenders.sort(), `legacy router still used in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("takes structured findings as the plan input", () => {
    const plan = {
      version: 2,
      findings: [structured],
      actions: [{ id: "a1", finding_ids: ["f1"], rationale: "Name the figure in the preceding paragraph.",
                  acceptance_criteria: [{ metric: "figures", target: 1 }] }],
    };
    expect(AgenticActionPlan.safeParse(plan).success).toBe(true);
  });

  it("rejects a plan whose findings are prose summaries", () => {
    expect(AgenticActionPlan.safeParse({
      version: 2,
      findings: [{ id: "f1", severity: "major", summary: "the figures are weak" }],
      actions: [{ id: "a1", finding_ids: ["f1"], rationale: "x" }],
    }).success).toBe(false);
  });

  it("rejects an action that names a tool", () => {
    // The capability is resolved from the finding's triple; letting a planner
    // choose it is how a prose defect reached a figure generator.
    expect(AgenticActionPlan.safeParse({
      version: 2,
      findings: [structured],
      actions: [{ id: "a1", finding_ids: ["f1"], rationale: "x", tool: "revise_visual_plan" }],
    }).success).toBe(false);
  });

  it("rejects the v1 plan generation rather than reinterpreting it", () => {
    // v1 findings carry no triple, so nothing could route them; reading a v1
    // plan under v2 rules would silently route every finding to whichever
    // capability seemed closest.
    expect(AgenticActionPlan.safeParse({
      version: 1, findings: [], actions: [],
    }).success).toBe(false);
  });

  it("resolves the capability from the finding, not from the plan", () => {
    const plan = AgenticActionPlan.parse({
      version: 2,
      findings: [structured],
      actions: [{ id: "a1", finding_ids: ["f1"], rationale: "Name the figure.",
                  acceptance_criteria: [{ metric: "figures", target: 1 }] }],
    });
    expect(capabilityOf(plan, plan.actions[0]!)).toBe("revise_sections");
  });

  it("refuses an action whose findings resolve to different capabilities", () => {
    const plan = AgenticActionPlan.parse({
      version: 2,
      findings: [
        structured,
        { ...structured, id: "f2",
          artifact: { kind: "figure_spec", path: "figures/placement-plan.json" },
          required_effect: "repair_artifact_placement" },
      ],
      actions: [{ id: "a1", finding_ids: ["f1", "f2"], rationale: "Repair both.",
                  acceptance_criteria: [{ metric: "figures", target: 1 }] }],
    });
    // One action running as two capabilities would act outside its envelope
    // for half its findings.
    expect(() => capabilityOf(plan, plan.actions[0]!)).toThrow(/mixes capabilities/);
  });

  it("escalates an unroutable finding rather than defaulting", async () => {
    const { materializeAction } = await import("../src/lib/ops/action-instance.js");
    const os = await import("node:os");
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-unrouted-"));
    try {
      await expect(materializeAction(ws, {
        actionId: "a1",
        findings: [{ ...structured, gate_id: "core_sources",
          required_effect: "remove_redundant_prose" } as never],
        observations: new Map(),
      })).rejects.toThrow(/never declared/);
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });
});
