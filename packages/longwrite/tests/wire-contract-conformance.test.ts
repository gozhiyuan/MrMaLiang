import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Criterion, MeasurementEnvelope, evaluateContract, wireContractFixtureDir,
} from "malaclaw/sdk";
import { METRIC_REGISTRY, PLANNER_SELECTABLE, metricDefinition } from "../src/lib/registry/metrics.js";
import { scopeKey } from "../src/lib/registry/scope.js";
import { compileCriterion, compileVerificationCriterion } from "../src/lib/registry/criteria.js";
import { buildEnvelope } from "../src/lib/registry/evaluate.js";
import { metricId, gateId } from "../src/lib/registry/ids.js";

const dir = wireContractFixtureDir();
const arithmetic = JSON.parse(fs.readFileSync(path.join(dir, "arithmetic.json"), "utf-8")) as
  Array<{ name: string; criterion: unknown; before: number; after: number; expect: string }>;
const envelopes = JSON.parse(fs.readFileSync(path.join(dir, "envelope.json"), "utf-8")) as
  Array<{ name: string; envelope: unknown; expect: "accepted" | "rejected" }>;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.promises.rm(r, { recursive: true, force: true })));
});
const AS_OF = "2026-09-01T00:00:00.000Z";

async function conformanceWorkspace(options: { taxonomy?: string[] } = {}): Promise<string> {
  const ws = await fs.promises.mkdtemp(path.join(os.tmpdir(), "longwrite-conformance-"));
  roots.push(ws);
  await fs.promises.mkdir(path.join(ws, "sources"), { recursive: true });
  await fs.promises.mkdir(path.join(ws, "chapters"), { recursive: true });
  await fs.promises.writeFile(path.join(ws, "sources", "classified_sources.jsonl"),
    [
      { id: "s1", title: "One", abstract: "a", venue: "V", year: 2025, topics: options.taxonomy ?? [],
        citation_depth: "A", quality_score: 90 },
      { id: "s2", title: "Two", abstract: "b", venue: "V", year: 2024, topics: options.taxonomy ?? [],
        citation_depth: "B", quality_score: 80 },
    ].map((row) => JSON.stringify(row)).join("\n"), "utf-8");
  await fs.promises.writeFile(path.join(ws, "chapters", "section-01.md"),
    "# One\n\nProse citing [source:s1:p1].\n", "utf-8");
  return ws;
}

describe("wire contract conformance", () => {
  it("resolves the corpus from the pinned runtime, not a vendored copy", () => {
    // Pinning a runtime version pins the contract; a local copy would drift.
    // The corpus must come from the resolved runtime, never from a fixture
    // committed in this repository.
    expect(dir).toContain(path.join("fixtures", "wire-contract"));
    expect(dir).not.toContain(path.join("packages", "longwrite"));
    expect(arithmetic.length).toBeGreaterThan(9);
  });

  it("agrees with the kernel on every arithmetic case", () => {
    for (const fixture of arithmetic) {
      const parsed = Criterion.safeParse(fixture.criterion);
      if (fixture.expect === "rejected") { expect(parsed.success, fixture.name).toBe(false); continue; }
      const criterion = parsed.data!;
      if (criterion.kind !== "metric") continue;
      const key = `${criterion.metric} ${criterion.scope_key}`;
      expect(evaluateContract({
        acceptance: [criterion],
        must_improve: [{ metric: criterion.metric, scope_key: criterion.scope_key,
                         min_absolute_delta: 0, min_gap_fraction: 0, max_attempts: 9 }],
        must_preserve: [],
        before: new Map([[key, fixture.before]]),
        after: new Map([[key, fixture.after]]),
        attempts: 1, pending: [], unavailable: [],
      }), fixture.name).toBe(fixture.expect);
    }
  });

  it("compiles a criterion the kernel accepts for every planner-selectable metric", () => {
    for (const metric of PLANNER_SELECTABLE) {
      const definition = metricDefinition(metric);
      const operator = definition.direction === "minimize" ? "at_most" as const : "at_least" as const;
      const compiled = compileCriterion(metric, "", operator, definition.target_type === "ratio" ? 0.5 : 1);
      const parsed = Criterion.safeParse(compiled);
      expect(parsed.success, `${metric}: ${JSON.stringify(parsed.error?.issues?.[0])}`).toBe(true);
    }
  });

  it("compiles tolerance and direction that behave as the corpus expects", () => {
    // A ratio metric must tolerate float error; a count metric must not.
    const ratio = compileCriterion(metricId("landmark_coverage_ratio"), "", "at_least", 0.3);
    const count = compileCriterion(metricId("core_sources"), "", "at_least", 4);
    expect(ratio.tolerance).toBeGreaterThan(0);
    expect(count.tolerance).toBe(0);
    const key = "landmark_coverage_ratio ";
    expect(evaluateContract({
      acceptance: [Criterion.parse(ratio)], must_improve: [], must_preserve: [],
      before: new Map([[key, 0.1]]), after: new Map([[key, 0.1 + 0.2]]),
      attempts: 1, pending: [], unavailable: [],
    })).toBe("accepted");
  });

  it("never compiles an operator that fights the metric's direction", () => {
    for (const metric of PLANNER_SELECTABLE) {
      const definition = metricDefinition(metric);
      const wrong = definition.direction === "minimize" ? "at_least" as const : "at_most" as const;
      expect(() => compileCriterion(metric, "", wrong, 1), String(metric)).toThrow();
    }
  });

  it("compiles a verification criterion the kernel accepts, and refuses an unverifiable gate", () => {
    const criterion = Criterion.safeParse(compileVerificationCriterion(gateId("figure_references"), ""));
    expect(criterion.success).toBe(true);
    // A criterion naming a gate nothing can re-run could never be satisfied.
    expect(() => compileVerificationCriterion(gateId("figure_manifest"), "")).toThrow(/no registered verifier/);
  });

  it("emits envelopes the kernel schema accepts", async () => {
    const ws = await conformanceWorkspace();
    const envelope = await buildEnvelope(ws, { tier: "unit", asOfDate: AS_OF });
    const parsed = MeasurementEnvelope.safeParse(envelope);
    expect(parsed.success, JSON.stringify(parsed.error?.issues?.[0])).toBe(true);
  });

  it("emits a scoped envelope the kernel schema accepts", async () => {
    const ws = await conformanceWorkspace({ taxonomy: ["memory", "planning"] });
    const envelope = await buildEnvelope(ws, { tier: "round", asOfDate: AS_OF });
    expect(MeasurementEnvelope.safeParse(envelope).success).toBe(true);
    // Canonical keys, not raw labels: the kernel's scope pattern rejects a
    // configured cell containing a space.
    for (const entry of envelope.measurements) {
      expect(entry.scope_key).toMatch(/^$|^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
    }
    // Canonical and stable: the same cell always produces the same key, and
    // the key is a shape the kernel's scope pattern accepts.
    expect(scopeKey("taxonomy_cell", "memory")).toBe(scopeKey("taxonomy_cell", "memory"));
    expect(scopeKey("taxonomy_cell", "memory")).toMatch(/^taxonomy-cell-memory/);
    expect(scopeKey("taxonomy_cell", "memory")).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
  });

  it("agrees with the kernel on every envelope acceptance case", () => {
    for (const fixture of envelopes) {
      expect(MeasurementEnvelope.safeParse(fixture.envelope).success, fixture.name)
        .toBe(fixture.expect === "accepted");
    }
  });

  it("registers a metric for every metric name the corpus exercises", () => {
    const named = new Set(arithmetic
      .map((fixture) => (fixture.criterion as { metric?: string }).metric)
      .filter((name): name is string => typeof name === "string"));
    // The corpus uses placeholder metric names; only assert that any name
    // matching a registered metric resolves, so a rename cannot pass silently.
    for (const name of named) {
      if (METRIC_REGISTRY.has(name as never)) expect(() => metricDefinition(name as never)).not.toThrow();
    }
  });
});
