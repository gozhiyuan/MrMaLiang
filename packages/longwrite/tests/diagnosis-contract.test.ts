import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateDiagnosis } from "../src/lib/ops/diagnosis.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});
async function workspace(diagnosis: unknown): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-diagnosis-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "reviews"), { recursive: true });
  await fs.writeFile(path.join(ws, "reviews", "diagnosis.json"), JSON.stringify(diagnosis), "utf-8");
  return ws;
}
const base = { version: 1, objective: "obj1", detail: "The visual repair cannot alter prose." };

describe("diagnosis contract", () => {
  it("accepts a decision that changes the required effect", async () => {
    const ws = await workspace({ ...base, decision: "retry_with_different_effect",
      next_effect: "add_explicit_artifact_reference" });
    expect((await validateDiagnosis(ws)).decision).toBe("retry_with_different_effect");
  });

  it("requires a named effect when changing the effect", async () => {
    await expect(validateDiagnosis(await workspace({ ...base, decision: "retry_with_different_effect" })))
      .rejects.toThrow(/next_effect/);
  });

  it("rejects an effect outside the closed vocabulary", async () => {
    await expect(validateDiagnosis(await workspace({
      ...base, decision: "retry_with_different_effect", next_effect: "try_harder",
    }))).rejects.toThrow();
  });

  it("validates next_capability against the capability registry", async () => {
    // A capability nothing owns is not a strategy; it is a typo that would
    // dispatch nothing.
    await expect(validateDiagnosis(await workspace({
      ...base, decision: "escalate_capability", next_capability: "invented_capability",
    }))).rejects.toThrow(/not a registered capability/);
  });

  it("accepts a registered next_capability", async () => {
    const ws = await workspace({ ...base, decision: "escalate_capability", next_capability: "reopen_outline" });
    expect((await validateDiagnosis(ws)).next_capability).toBe("reopen_outline");
  });

  it("requires a question when an operator is needed", async () => {
    await expect(validateDiagnosis(await workspace({ ...base, decision: "operator_required" })))
      .rejects.toThrow(/operator_question/);
  });

  it("rejects a decision outside the closed vocabulary", async () => {
    await expect(validateDiagnosis(await workspace({ ...base, decision: "try_harder" }))).rejects.toThrow();
  });

  it("rejects any attempt to relax the contract", async () => {
    // Diagnosis chooses a strategy; it never lowers a target.
    await expect(validateDiagnosis(await workspace({ ...base, decision: "target_infeasible", new_target: 0.2 })))
      .rejects.toThrow();
  });

  it("accepts an infeasibility verdict without a next strategy", async () => {
    const ws = await workspace({ ...base, decision: "target_infeasible" });
    expect((await validateDiagnosis(ws)).decision).toBe("target_infeasible");
  });
});
