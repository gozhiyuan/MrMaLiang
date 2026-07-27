import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

/**
 * Phase MM-0.3: freeze the non-negotiable metrics.
 *
 * These metric names are the contract between the deterministic commands that
 * WRITE reports/metrics.json and the compiled `when:` / `stop_when:` conditions
 * that READ it. Renaming one on either side silently disables a release gate:
 * a missing metric reads as "condition not met", so the gate does not fail —
 * it just stops running. That is the failure mode this test exists to prevent.
 *
 * MM-1 and MM-2 move this code between modules; MM-5.3 forbids collapsing the
 * gates themselves.
 */

const here = path.dirname(url.fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const compiledDir = path.join(here, "fixtures", "compiled");
const experimentCompiledDir = path.resolve(packageRoot, "..", "longexperiment", "tests", "fixtures", "compiled");

/** Metrics that must appear as a compiled gate condition in some manifest. */
const COMPILED_GATE_METRICS = [
  "research_expansion_dispatched",
  "corpus_gate_pass",
  "outline_readiness",
  "review_score",
  "final_release_gate_pass",
] as const;

/** Metrics produced at runtime into reports/metrics.json rather than compiled
 *  into a condition. Frozen by their producing source file. */
const RUNTIME_METRICS: Array<{ metric: string; producedBy: string }> = [
  { metric: "claim_support_rate", producedBy: "src/lib/ops/claim-gate.ts" },
];

/** Experiment-side metrics, frozen against the LongExperiment goldens. */
const EXPERIMENT_METRICS = ["experiment_readiness", "proposal_readiness"] as const;

async function readAll(dir: string): Promise<Array<{ file: string; text: string }>> {
  const names = (await fs.readdir(dir)).filter((n) => n.endsWith(".json")).sort();
  return Promise.all(names.map(async (file) => ({
    file,
    text: await fs.readFile(path.join(dir, file), "utf-8"),
  })));
}

describe("frozen gate metrics", () => {
  it("keeps every compiled gate metric present in at least one golden manifest", async () => {
    const goldens = await readAll(compiledDir);
    expect(goldens.length).toBeGreaterThan(0);

    const missing = COMPILED_GATE_METRICS.filter(
      (metric) => !goldens.some((g) => g.text.includes(metric)),
    );
    expect(missing, `no golden manifest exercises these gates: ${missing.join(", ")}`).toEqual([]);
  });

  it("uses each gate metric in a real when/stop_when condition, not just as text", async () => {
    const goldens = await readAll(compiledDir);
    for (const metric of COMPILED_GATE_METRICS) {
      const used = goldens.some((g) => {
        const manifest = JSON.parse(g.text) as unknown;
        return JSON.stringify(manifest).match(
          new RegExp(`"(when|stop_when)":"${metric}\\s*(>=|<=|==|>|<)`),
        ) !== null;
      });
      expect(used, `${metric} appears in no when/stop_when condition`).toBe(true);
    }
  });

  it("keeps runtime-produced metrics emitted by their owning module", async () => {
    for (const { metric, producedBy } of RUNTIME_METRICS) {
      const source = await fs.readFile(path.join(packageRoot, producedBy), "utf-8");
      // Written as an object key, e.g. `claim_support_rate: supportRate`.
      expect(source, `${producedBy} no longer writes ${metric}`).toMatch(
        new RegExp(`${metric}\\s*:`),
      );
    }
  });

  it("keeps the claim-support release threshold enforced", async () => {
    // MM-5.3: claim judgment and support scoring may not be collapsed away.
    const validation = await fs.readFile(path.join(packageRoot, "src/lib/validation/research.ts"), "utf-8");
    expect(validation).toContain("claim_support_rate");
    expect(validation).toMatch(/must contain claim_support_rate/);
  });

  it("keeps experiment-side metrics present in the LongExperiment goldens", async () => {
    const goldens = await readAll(experimentCompiledDir);
    const missing = EXPERIMENT_METRICS.filter(
      (metric) => !goldens.some((g) => g.text.includes(metric)),
    );
    expect(missing, `no experiment golden exercises: ${missing.join(", ")}`).toEqual([]);
  });

  it("documents the full frozen set so a rename is a deliberate edit", () => {
    // The plan's list, verbatim. Changing this array is the explicit signal
    // that a non-negotiable metric was renamed or retired.
    expect([...COMPILED_GATE_METRICS, ...RUNTIME_METRICS.map((m) => m.metric), ...EXPERIMENT_METRICS].sort())
      .toEqual([
        "claim_support_rate",
        "corpus_gate_pass",
        "experiment_readiness",
        "final_release_gate_pass",
        "outline_readiness",
        "proposal_readiness",
        "research_expansion_dispatched",
        "review_score",
      ]);
  });
});
