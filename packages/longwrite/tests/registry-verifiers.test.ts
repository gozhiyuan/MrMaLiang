import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PRODUCERS } from "../src/lib/registry/producers.js";
import { VERIFIERS, VERIFIER_VERSION, runVerification } from "../src/lib/registry/verifiers.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

async function bareWorkspace(): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-verifier-bare-"));
  roots.push(ws);
  return ws;
}

/** A workspace whose figure manifest and main.tex agree: the gate can run and
 * finds nothing wrong. */
async function cleanWorkspace(): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-verifier-clean-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "figures"), { recursive: true });
  await fs.mkdir(path.join(ws, "paper"), { recursive: true });
  await fs.writeFile(path.join(ws, "figures", "manifest.json"),
    JSON.stringify({ version: 1, figures: [], tables: [] }), "utf-8");
  await fs.writeFile(path.join(ws, "paper", "main.tex"), "\\documentclass{article}\n\\begin{document}\n\\end{document}\n", "utf-8");
  return ws;
}

describe("verifier registry", () => {
  it("registers exactly one verifier for every gate that can emit a null-metric finding", () => {
    const needsVerifier = new Set<string>();
    for (const producer of PRODUCERS) {
      for (const gate of producer.gates) {
        for (const shape of gate.findings) {
          if (shape.acceptance_metric === null) needsVerifier.add(String(gate.id));
        }
      }
    }
    const missing = [...needsVerifier].filter((gate) => typeof VERIFIERS[gate] !== "function").sort();
    // A null-metric finding with no verifier produces an action whose acceptance
    // nothing can ever satisfy.
    expect(missing, `gates with no verifier: ${missing.join(", ")}`).toEqual([]);
  });

  it("registers no verifier for a gate that never emits a null-metric finding", () => {
    // A verifier nobody can request is dead code that will drift.
    const declared = new Set(PRODUCERS.flatMap((p) => p.gates
      .filter((gate) => gate.findings.some((shape) => shape.acceptance_metric === null))
      .map((gate) => String(gate.id))));
    expect(Object.keys(VERIFIERS).filter((id) => !declared.has(id)).sort()).toEqual([]);
  });

  it("reports an unreachable verifier as unavailable, never as a pass", async () => {
    const bare = await bareWorkspace();
    const result = await runVerification("figure_references", { workspaceDir: bare, scopeKey: "" });
    expect(result.status).toBe("unavailable");
    expect(result.diagnostic).toBeTruthy();
  });

  it("reports an unregistered verification as unavailable rather than throwing", async () => {
    const result = await runVerification("no_such_gate", { workspaceDir: await bareWorkspace(), scopeKey: "" });
    expect(result.status).toBe("unavailable");
    expect(result.diagnostic).toMatch(/no verifier is registered/);
  });

  it("passes only when the gate it names actually passes", async () => {
    const clean = await cleanWorkspace();
    expect((await runVerification("figure_references", { workspaceDir: clean, scopeKey: "" })).status).toBe("passed");

    // The manifest declares a figure that main.tex never places: the gate the
    // finding came from now has something to find.
    const broken = await cleanWorkspace();
    await fs.writeFile(path.join(broken, "figures", "manifest.json"), JSON.stringify({
      version: 1,
      figures: [{
        id: "fig-1", title: "Title", caption: "Caption", path: "figures/fig-1.svg",
        latex_path: "figures/fig-1.tex", backend: "deterministic-svg",
        placement: { section_id: "s1", discussion: "Discussed in section one." },
      }],
      tables: [],
    }), "utf-8");
    const result = await runVerification("figure_references", { workspaceDir: broken, scopeKey: "" });
    expect(["failed", "unavailable"]).toContain(result.status);
    expect(result.status).toBe("failed");
  });

  it("records a verifier version so an old pass is not read as a new one", () => {
    expect(VERIFIER_VERSION).toMatch(/^\d+$/);
  });
});
