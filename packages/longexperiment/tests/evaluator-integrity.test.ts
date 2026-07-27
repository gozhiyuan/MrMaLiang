import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyEvaluatorIntegrity } from "../src/lib/verifiers/evaluator-integrity.js";
const dirs: string[] = [];
afterEach(async () => { while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true }); });
describe("protected evaluator verifier", () => {
  it("rejects altered evaluators and traversal paths", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "evaluator-base-")); const candidate = await fs.mkdtemp(path.join(os.tmpdir(), "evaluator-candidate-")); dirs.push(base, candidate);
    await fs.mkdir(path.join(base, "evaluator"), { recursive: true }); await fs.mkdir(path.join(candidate, "evaluator"), { recursive: true });
    await fs.writeFile(path.join(base, "evaluator", "score.py"), "print('score')\n"); await fs.writeFile(path.join(candidate, "evaluator", "score.py"), "print('tampered')\n");
    const result = await verifyEvaluatorIntegrity(base, candidate, ["evaluator/score.py", "../outside.py"]);
    expect(result.ok).toBe(false); expect(result.findings).toContain("protected evaluator changed: evaluator/score.py"); expect(result.findings[1]).toMatch(/unsafe/);
  });
});
