import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { evaluateCorpusGates } from "../src/lib/research/corpus-gates.js";
import { MeasurementEntrySchema } from "../src/lib/registry/records.js";
import { METRIC_REGISTRY } from "../src/lib/registry/metrics.js";
import { metricId, taxonomyGateId } from "../src/lib/registry/ids.js";
import { scopeKey } from "../src/lib/registry/scope.js";
import { REGISTRY } from "../src/lib/registry/producers.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});
const AS_OF = "2026-09-01T00:00:00.000Z";

async function workspace(): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-corpus-structured-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "sources"), { recursive: true });
  await fs.writeFile(path.join(ws, "longwrite.yaml"), stringify({
    version: 1, project: { id: "s", artifact_type: "research_paper", mode: "auto_research_agentic" },
    research: {
      provider: "multi", topic: "agent memory", taxonomy: ["memory", "planning"],
      corpus_gates: {
        min_candidates: 1, min_sources_per_taxonomy_cell: 2, min_core_sources: 5,
        min_recent_ratio: 0, min_source_type_diversity: 1,
      },
    },
  }), "utf-8");
  await fs.writeFile(path.join(ws, "sources", "classified_sources.jsonl"),
    [{ id: "s1", citation_depth: "A", source: "arxiv", title: "Agent memory", abstract: "memory", year: 2025 },
     { id: "s2", citation_depth: "B", source: "arxiv", title: "Episodic memory", abstract: "memory", year: 2025 },
     { id: "s3", citation_depth: "B", source: "arxiv", title: "Planning agents", abstract: "planning", year: 2025 }]
      .map((s) => JSON.stringify(s)).join("\n"), "utf-8");
  return ws;
}

describe("corpus gate structured output", () => {
  it("emits entries only for registered metrics", async () => {
    const report = await evaluateCorpusGates(await workspace(), { asOfDate: AS_OF });
    expect(report.measurements.length).toBeGreaterThan(0);
    for (const entry of report.measurements) {
      expect(MeasurementEntrySchema.safeParse(entry).success).toBe(true);
      expect(METRIC_REGISTRY.has(metricId(entry.metric)), `${entry.metric} unregistered`).toBe(true);
    }
  });

  it("maps the core_sources gate to its metric with value, target and operator", async () => {
    const report = await evaluateCorpusGates(await workspace(), { asOfDate: AS_OF });
    const core = report.measurements.find((entry) => entry.metric === "core_sources");
    expect(core?.value).toBe(3);
    expect(core?.target).toBe(5);
    expect(core?.operator).toBe("at_least");
  });

  it("maps the total_candidates gate to candidate_count", async () => {
    const report = await evaluateCorpusGates(await workspace(), { asOfDate: AS_OF });
    expect(report.measurements.find((entry) => entry.metric === "candidate_count")?.value).toBe(3);
  });

  it("emits one taxonomy entry per cell, never an aggregate", async () => {
    const report = await evaluateCorpusGates(await workspace(), { asOfDate: AS_OF });
    const cells = report.measurements.filter((entry) => entry.metric === "taxonomy_cell_ab_sources");
    const byKey = Object.fromEntries(cells.map((entry) => [entry.scope_key, entry.value]));
    expect(byKey[scopeKey("taxonomy_cell", "memory")]).toBe(2);
    expect(byKey[scopeKey("taxonomy_cell", "planning")]).toBe(1);
  });

  it("emits no sequence, because the kernel allocates them", async () => {
    const report = await evaluateCorpusGates(await workspace(), { asOfDate: AS_OF });
    for (const entry of report.measurements) expect("sequence" in entry).toBe(false);
  });

  it("emits a routable structured check per failing gate", async () => {
    const report = await evaluateCorpusGates(await workspace(), { asOfDate: AS_OF });
    const core = report.checks.find((check) => String(check.id) === "core_sources")!;
    expect(core.pass).toBe(false);
    expect(core.findings[0].artifact.kind).toBe("corpus");
    // A corpus short on depth needs better sources, not merely more of them.
    expect(core.findings[0].required_effect).toBe("upgrade_source_quality");
    expect(core.findings[0].objective_scope_key).toBe("");
  });

  it("scopes a taxonomy check to its cell, with gate id and scope agreeing", async () => {
    const report = await evaluateCorpusGates(await workspace(), { asOfDate: AS_OF });
    const cell = report.checks.find((check) => String(check.id) === taxonomyGateId("planning"))!;
    // Both derive from one slugify, so a gate and its scope cannot disagree.
    expect(cell.findings[0].objective_scope_key).toBe(scopeKey("taxonomy_cell", "planning"));
  });

  it("routes every finding it emits to a capability", async () => {
    const report = await evaluateCorpusGates(await workspace(), { asOfDate: AS_OF });
    for (const check of report.checks) {
      for (const finding of check.findings) {
        expect(() => REGISTRY.resolveCapability({
          gate: finding.gate_id, kind: finding.artifact.kind, effect: finding.required_effect,
        }), String(finding.id)).not.toThrow();
      }
    }
  });

  it("agrees with the gate decision because both read one evaluator result", async () => {
    const report = await evaluateCorpusGates(await workspace(), { asOfDate: AS_OF });
    const core = report.measurements.find((entry) => entry.metric === "core_sources")!;
    const check = report.checks.find((entry) => String(entry.id) === "core_sources")!;
    expect(check.pass).toBe(core.value! >= core.target!);
  });

  it("derives the operator summaries from the structured checks", async () => {
    const report = await evaluateCorpusGates(await workspace(), { asOfDate: AS_OF });
    // Prose survives for operators, derived from the routable output rather
    // than being a second, unroutable source of truth.
    expect(report.findings.find((entry) => entry.id === "core_sources")?.detail).toContain("required 5");
    expect(report.findings.map((entry) => entry.id).sort())
      .toEqual(report.checks.map((check) => String(check.id)).sort());
  });
});
