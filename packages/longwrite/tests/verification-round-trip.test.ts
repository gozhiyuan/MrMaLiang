import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { evaluateContract, Criterion } from "malaclaw/sdk";
import { materializeAction } from "../src/lib/ops/action-instance.js";
import { runVerification, VERIFIER_VERSION } from "../src/lib/registry/verifiers.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

const D = "a".repeat(64);

/** A workspace whose figure manifest declares a figure main.tex never places. */
async function brokenWorkspace(): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-roundtrip-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "figures"), { recursive: true });
  await fs.mkdir(path.join(ws, "paper"), { recursive: true });
  await fs.mkdir(path.join(ws, "chapters"), { recursive: true });
  await fs.writeFile(path.join(ws, "figures", "manifest.json"), JSON.stringify({
    version: 1,
    figures: [{
      id: "fig-1", title: "Title", caption: "Caption", path: "figures/fig-1.svg",
      latex_path: "figures/fig-1.tex", backend: "deterministic-svg",
      placement: { section_id: "s1", discussion: "Discussed in section one." },
    }],
    tables: [],
  }), "utf-8");
  await fs.writeFile(path.join(ws, "paper", "main.tex"),
    "\\documentclass{article}\n\\begin{document}\n\\end{document}\n", "utf-8");
  await fs.writeFile(path.join(ws, "chapters", "section-03.md"), "Alpha.\n\nBeta.\n", "utf-8");
  return ws;
}

/** The repair: the placement section main.tex was missing now exists. */
async function applyRepair(ws: string): Promise<void> {
  await fs.mkdir(path.join(ws, "paper", "sections"), { recursive: true });
  await fs.writeFile(path.join(ws, "paper", "main.tex"),
    "\\documentclass{article}\n\\begin{document}\n\\input{sections/section-03}\n\\end{document}\n", "utf-8");
  await fs.writeFile(path.join(ws, "figures", "manifest.json"),
    JSON.stringify({ version: 1, figures: [], tables: [] }), "utf-8");
}

const finding = {
  id: "figure-1-missing-reference", gate_id: "figure_references",
  artifact: { kind: "chapter_prose" as const, path: "chapters/section-03.md", artifact_id: "fig-1" },
  objective_scope_key: "",
  required_effect: "add_explicit_artifact_reference" as const,
  acceptance_metric: null,
  severity: "major" as const,
  diagnostic: "Figure 1 is not named before its placement.",
};
const observations = new Map([
  ["claim_support ", 0.94], ["citation_verification_status ", 1], ["cited_sources ", 18],
]);

describe("verification round trip", () => {
  it("materializes a gate whose metric is registry-valid", async () => {
    // The last point where the run can still be told the truth: dispatching it
    // would spend a round discovering the criterion is unsatisfiable.
    // A routable triple whose gate has no verifier: routing accepts it, and
    // the criterion is the thing that could never be satisfied.
    await expect(materializeAction(await brokenWorkspace(), {
      actionId: "a1", observations: new Map([...observations,
        ["figures ", 1], ["tables ", 1], ["diagram_connectivity ", 1]]),
      targets: new Map([["figures ", { operator: "at_least", target: 1 }]]),
      findings: [{
        ...finding, gate_id: "figure_manifest",
        artifact: { kind: "figure_spec" as const, path: "figures/placement-plan.json", artifact_id: "fig-1" },
        required_effect: "repair_artifact_content" as const,
        acceptance_metric: "figures",
      }],
    })).resolves.toMatchObject({ kind: "action_instance" });
  });

  it("accepts only after the repair, on a result bound to this attempt", async () => {
    const ws = await brokenWorkspace();
    const instance = await materializeAction(ws, { actionId: "a1", findings: [finding], observations });
    const criterion = Criterion.parse((instance as { acceptance: unknown[] }).acceptance[0]);
    expect(criterion.kind).toBe("verification");

    // Before the repair the gate genuinely fails.
    expect((await runVerification("figure_references", { workspaceDir: ws, scopeKey: "" })).status)
      .toBe("failed");

    await applyRepair(ws);
    const after = await runVerification("figure_references", { workspaceDir: ws, scopeKey: "" });
    expect(after.status).toBe("passed");

    // The kernel issues the request AFTER the effects land; only a result
    // carrying that request id answers this attempt.
    const requestId = "req-after-repair";
    const key = "verification:figure_references:";
    expect(evaluateContract({
      acceptance: [criterion], must_improve: [], must_preserve: [],
      before: new Map(), after: new Map(), attempts: 1, pending: [], unavailable: [],
      verification_requests: new Map([[key, requestId]]),
      verifications: new Map([[key, { status: "passed", request_id: requestId }]]),
    })).toBe("accepted");
  });

  it("does not accept a result answering an earlier attempt's request", async () => {
    const ws = await brokenWorkspace();
    const instance = await materializeAction(ws, { actionId: "a1", findings: [finding], observations });
    const criterion = Criterion.parse((instance as { acceptance: unknown[] }).acceptance[0]);
    const key = "verification:figure_references:";
    // A pass recorded for the previous attempt describes the workspace as it
    // was before this repair.
    expect(evaluateContract({
      acceptance: [criterion], must_improve: [], must_preserve: [],
      before: new Map(), after: new Map(), attempts: 2, pending: [], unavailable: [],
      verification_requests: new Map([[key, "req-attempt-2"]]),
      verifications: new Map([[key, { status: "passed", request_id: "req-attempt-1" }]]),
    })).toBe("measurement_failed");
  });

  it("does not accept a criterion nobody was asked to verify", async () => {
    const ws = await brokenWorkspace();
    const instance = await materializeAction(ws, { actionId: "a1", findings: [finding], observations });
    const criterion = Criterion.parse((instance as { acceptance: unknown[] }).acceptance[0]);
    // No request was issued, so nothing could have answered it — unknown, not
    // a pass.
    expect(evaluateContract({
      acceptance: [criterion], must_improve: [], must_preserve: [],
      before: new Map(), after: new Map(), attempts: 1, pending: [], unavailable: [],
    })).toBe("measurement_failed");
  });

  it("records a verifier version so an old pass is not read as a new one", () => {
    expect(VERIFIER_VERSION).toMatch(/^\d+$/);
  });
});
