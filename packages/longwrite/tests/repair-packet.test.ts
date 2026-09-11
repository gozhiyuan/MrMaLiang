import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  RepairPacket, buildRepairPacket, writeRepairPacket, OperatorTargetFinding, acceptanceForFindings,
} from "../src/lib/ops/repair-packet.js";
import { templateFor } from "../src/lib/registry/capabilities.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-packet-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "chapters"), { recursive: true });
  await fs.writeFile(path.join(ws, "chapters", "section-03.md"),
    ["# Three", "", "Alpha paragraph.", "", "Beta paragraph mentioning the plot.", "",
     "Gamma paragraph.", "", "Delta paragraph."].join("\n"), "utf-8");
  return ws;
}

const finding = {
  id: "figure-1-missing-reference",
  gate_id: "figure_references",
  artifact: { kind: "chapter_prose" as const, path: "chapters/section-03.md", artifact_id: "figure-1" },
  location: "paragraph preceding the float generated at paper/sections/section-03.tex",
  objective_scope_key: "",
  required_effect: "add_explicit_artifact_reference" as const,
  acceptance_metric: null,
  severity: "major" as const,
  diagnostic: "Figure 1 is not named before its placement.",
};

const request = {
  actionId: "a1",
  findings: [finding],
  observations: new Map([
    ["claim_support ", 0.94],
    ["citation_verification_status ", 1],
    ["cited_sources ", 18],
    ["rendered_visual_review ", 0],
  ]),
  priorAttempts: [],
};

describe("repair packets", () => {
  it("resolves the capability from the finding rather than being told", async () => {
    const packet = await buildRepairPacket(await workspace(), request);
    expect(packet.capability).toBe("revise_sections");
  });

  it("derives protected metrics from the resolved capability's template", async () => {
    const packet = await buildRepairPacket(await workspace(), request);
    // The request carries no protected-metric list at all, so a caller cannot
    // produce a packet with no invariants by omitting one.
    expect(packet.protect.map((entry) => entry.metric))
      .toEqual(templateFor("revise_sections").must_preserve_template.map(String));
    expect(packet.protect[0].value).toBeCloseTo(0.94, 6);
  });

  it("rejects a request that tries to supply its own protected metrics", async () => {
    await expect(buildRepairPacket(await workspace(),
      { ...request, templateMustPreserve: ["nothing"] } as never)).rejects.toThrow();
  });

  it("fails when a protected metric has no current observation", async () => {
    await expect(buildRepairPacket(await workspace(), {
      ...request, observations: new Map([["rendered_visual_review ", 0]]),
    })).rejects.toThrow(/claim_support.*no current observation/);
  });

  it("carries a bounded excerpt, not the whole file", async () => {
    const packet = await buildRepairPacket(await workspace(), request);
    expect(packet.artifacts[0].excerpt).toContain("Beta paragraph");
    expect(packet.artifacts[0].excerpt).not.toContain("Delta paragraph");
  });

  it("truncates an excerpt that exceeds the byte limit", async () => {
    const ws = await workspace();
    await fs.writeFile(path.join(ws, "chapters", "section-03.md"), "x".repeat(200_000), "utf-8");
    const packet = await buildRepairPacket(ws, { ...request, limits: { excerpt_bytes: 4_000 } });
    expect(Buffer.byteLength(packet.artifacts[0].excerpt, "utf-8")).toBeLessThanOrEqual(4_000);
    expect(packet.artifacts[0].truncated).toBe(true);
  });

  it("carries prior attempts so the worker sees what already failed", async () => {
    const packet = await buildRepairPacket(await workspace(), {
      ...request,
      priorAttempts: [{ fingerprint: "f1", capability: "revise_visual_plan",
                        effect: "repair_artifact_content", outcome: "unmet" }],
    });
    expect(packet.prior_attempts[0].outcome).toBe("unmet");
  });

  it("rejects an action id that would escape the repair directory", async () => {
    await expect(buildRepairPacket(await workspace(), { ...request, actionId: "../../etc" }))
      .rejects.toThrow(/unsafe/i);
  });

  it("rejects a finding path outside the workspace", async () => {
    await expect(buildRepairPacket(await workspace(), {
      ...request,
      findings: [{ ...finding, artifact: { ...finding.artifact, path: "../../../etc/passwd" } }],
    })).rejects.toThrow();
  });

  it("writes the packet under a safe stem of its action id", async () => {
    const ws = await workspace();
    const packet = await buildRepairPacket(ws, request);
    const written = await writeRepairPacket(ws, "a1", packet);
    expect(written).toBe(path.join("repair", "a1", "packet.json"));
    expect(RepairPacket.safeParse(JSON.parse(await fs.readFile(path.join(ws, written), "utf-8"))).success).toBe(true);
  });

  it("refuses to build a packet for an operator target", async () => {
    // A missing compiler has no path to excerpt and nothing to edit; the
    // artifact union has no `path` on that branch at all.
    await expect(buildRepairPacket(await workspace(), {
      ...request,
      findings: [{ ...finding, gate_id: "latex_build",
        artifact: { kind: "toolchain" as const, target: "pdflatex" },
        required_effect: "repair_toolchain" as const }],
    })).rejects.toThrow(OperatorTargetFinding);
  });

  it("throws rather than building a packet for an unrouted finding", async () => {
    await expect(buildRepairPacket(await workspace(), {
      ...request,
      findings: [{ ...finding, artifact: { ...finding.artifact, kind: "corpus" as const, path: "sources/" } }],
    })).rejects.toThrow();
  });

  it("refuses to mix capabilities in one action", async () => {
    await expect(buildRepairPacket(await workspace(), {
      ...request,
      findings: [finding, { ...finding, id: "fig-content",
        artifact: { kind: "figure_spec" as const, path: "figures/placement-plan.json", artifact_id: "figure-1" },
        required_effect: "repair_artifact_content" as const }],
    })).rejects.toThrow(/mixes capabilities/);
  });
});

describe("acceptance criteria derived from findings", () => {
  const metricFinding = {
    ...finding, id: "low-support", gate_id: "cited_literature_release_gates",
    acceptance_metric: "cited_sources" as const, required_effect: "add_supporting_citation" as const,
  };

  it("compiles a verification criterion for a null-metric finding", () => {
    const [criterion] = acceptanceForFindings([finding]);
    // verification_id IS the gate id: the thing being re-verified is precisely
    // the gate that emitted the finding.
    expect(criterion).toMatchObject({ kind: "verification", verification_id: "figure_references" });
  });

  it("refuses to invent a target for a metric finding", () => {
    // A criterion with a made-up target judges the action against a number
    // nobody chose.
    expect(() => acceptanceForFindings([metricFinding])).toThrow(/no recorded operator\/target/);
  });

  it("compiles one criterion per metric and scope, never one per gate", () => {
    const targets = new Map([
      ["cited_sources ", { operator: "at_least" as const, target: 20 }],
      ["citations_per_page ", { operator: "at_least" as const, target: 2 }],
    ]);
    const criteria = acceptanceForFindings([
      metricFinding,
      { ...metricFinding, id: "thin-pages", acceptance_metric: "citations_per_page" as const },
    ], targets);
    // One gate, two metrics: collapsing them would let a repair that fixed one
    // claim to have fixed the other.
    expect(criteria).toHaveLength(2);
    expect(criteria.map((c) => (c as { metric?: string }).metric).sort())
      .toEqual(["citations_per_page", "cited_sources"]);
  });
});
