import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deterministicBootstrap } from "../src/lib/stages.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function pythonBootstrap(deltas: number[], repeats: number): { lower: number; upper: number } {
  const output = execFileSync("python3", ["-m", "maliang_experiment_protocol.statistics"], { cwd: root, env: { ...process.env, PYTHONPATH: path.join(root, "python") }, input: JSON.stringify({ deltas, repeats }), encoding: "utf8" });
  return JSON.parse(output) as { lower: number; upper: number };
}

describe("Python statistical helper parity", () => {
  it("matches the TypeScript auditor for an explicit deterministic seed", () => {
    const deltas = [0.2, 0.1, -0.05, 0.3]; const repeats = 200;
    expect(pythonBootstrap(deltas, repeats)).toEqual(deterministicBootstrap(deltas, repeats));
  });

  // Exact equality is the contract, not a strictness accident. These deltas are
  // chosen so that naive and compensated summation genuinely disagree: in
  // Python, `sum([0.3, 0.3, 0.3, 0.2])` is 1.1 on >=3.12 but 1.0999999999999999
  // via a naive loop. If someone rewrites the Python `_mean` back to `sum()`,
  // the interpreter's compensated fast path silently re-diverges from the
  // TypeScript auditor and this case fails.
  it("stays bit-identical for deltas where compensated summation would diverge", () => {
    for (const repeats of [50, 200, 501]) {
      const deltas = [0.3, 0.3, 0.3, 0.2];
      expect(pythonBootstrap(deltas, repeats)).toEqual(deterministicBootstrap(deltas, repeats));
    }
  });
});
