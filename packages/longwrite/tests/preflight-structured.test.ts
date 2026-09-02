import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { collectPreflightChecks } from "../src/commands/preflight.js";
import { PRODUCERS, REGISTRY } from "../src/lib/registry/producers.js";
import { gateId } from "../src/lib/registry/ids.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

/** No LaTeX compiler configured, no review topology, no token guardrail: every
 * preflight check that can fail does. */
async function bareWorkspace(): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-preflight-structured-"));
  roots.push(ws);
  await fs.writeFile(path.join(ws, "longwrite.yaml"), stringify({
    version: 1,
    project: { id: "s", artifact_type: "research_paper", mode: "auto_research_agentic" },
    research: { provider: "multi", topic: "t", writing_strategy: "llm_sections" },
    writing: { output_formats: ["pdf"] },
  }), "utf-8");
  await fs.writeFile(path.join(ws, "malaclaw.yaml"), stringify({
    version: 1,
    workflow: { stages: [{ id: "draft_sections", max_parallel: 8, steps: [{ id: "draft", runtime: "script" }] }] },
  }), "utf-8");
  return ws;
}

describe("preflight structured output", () => {
  it("emits no findings, because an environment gate is not repairable", async () => {
    const checks = await collectPreflightChecks(await bareWorkspace());
    expect(checks.length).toBeGreaterThan(0);
    for (const check of checks) {
      expect(check.findings, `${check.id} emitted a finding`).toEqual([]);
    }
  });

  it("still reports failure with an operator diagnostic", async () => {
    const checks = await collectPreflightChecks(await bareWorkspace());
    const drafting = checks.find((check) => String(check.id) === "direct_llm_drafting")!;
    expect(drafting.pass).toBe(false);
    expect(drafting.diagnostic).toMatch(/script-owned/i);
    // A failure with no finding must still be actionable, so it requests
    // diagnosis rather than reaching the kernel as an unexplained closed gate.
    expect(drafting.requires_diagnosis).toBe(true);
  });

  it("declares every one of its gates as environment class", () => {
    const preflight = PRODUCERS.find((producer) => producer.module === "preflight")!;
    for (const gate of preflight.gates) expect(REGISTRY.gateClass(gate.id)).toBe("environment");
  });

  it("has no legal triples, so nothing can route to a repair", () => {
    const preflight = PRODUCERS.find((producer) => producer.module === "preflight")!;
    for (const gate of preflight.gates) {
      expect(REGISTRY.legalTriples(gate.id), String(gate.id)).toEqual([]);
    }
  });

  it("routes a missing compiler nowhere at all", () => {
    // Nothing this product owns installs a LaTeX engine, so there is no
    // capability to route to and inventing one would send a repair unit at a
    // problem it cannot touch.
    expect(REGISTRY.legalTriples(gateId("pdf_compiler"))).toEqual([]);
    expect(() => REGISTRY.resolveCapability({
      gate: gateId("pdf_compiler"), kind: "toolchain", effect: "repair_toolchain",
    })).toThrow(/no capability owns/);
  });
});
