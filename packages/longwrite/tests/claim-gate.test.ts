import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { repairClaimJudgments, scoreClaimGate } from "../src/lib/ops/claim-gate.js";

const tempDirs: string[] = [];
afterEach(async () => { while (tempDirs.length) await fs.rm(tempDirs.pop()!, { recursive: true, force: true }); });

const judgment = (verdict: string, i: number) =>
  JSON.stringify({ source_id: `s${i}`, chapter: "chapters/section-1.md", claim: `claim ${i}`, verdict });

describe("claim gate scorer", () => {
  it("computes weighted support rate, overwrites metrics, lists unsupported", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "claim-gate-"));
    tempDirs.push(ws);
    await fs.mkdir(path.join(ws, "reviews"), { recursive: true });
    await fs.mkdir(path.join(ws, "reports"), { recursive: true });
    await fs.writeFile(path.join(ws, "reports", "metrics.json"), JSON.stringify({ review_score: 8, claim_support_rate: 1.0 }), "utf-8");
    await fs.writeFile(path.join(ws, "reviews", "claim-judgments.jsonl"),
      [judgment("entailed", 1), judgment("entailed", 2), judgment("partial", 3), judgment("unsupported", 4), "not json"].join("\n"), "utf-8");

    const result = await scoreClaimGate(ws);
    expect(result.supportRate).toBe(0.625); // (2 + 0.5) / 4
    expect(result.findings).toHaveLength(1); // malformed line reported, not fatal
    const metrics = JSON.parse(await fs.readFile(path.join(ws, "reports", "metrics.json"), "utf-8"));
    expect(metrics.claim_support_rate).toBe(0.625); // judge's self-assertion overwritten
    expect(metrics.review_score).toBe(8); // merged, not clobbered
    const report = await fs.readFile(path.join(ws, "reports", "claim-gate.md"), "utf-8");
    expect(report).toContain("Unsupported claims");
  });

  it("throws when no valid judgments exist", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "claim-gate-"));
    tempDirs.push(ws);
    await fs.mkdir(path.join(ws, "reviews"), { recursive: true });
    await fs.writeFile(path.join(ws, "reviews", "claim-judgments.jsonl"), "nope\n", "utf-8");
    await expect(scoreClaimGate(ws)).rejects.toThrow(/no valid judgments/);
  });

  it("normalizes a model-produced JSON array into validated JSONL without losing provenance", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "claim-gate-"));
    tempDirs.push(ws);
    await fs.mkdir(path.join(ws, "reviews"), { recursive: true });
    await fs.writeFile(path.join(ws, "reviews", "claim-judgments.jsonl"), JSON.stringify([
      {
        source_id: "s1", chapter: "chapters/section-1.md", claim: "grounded claim", verdict: "entailed",
        evidence_locators: [{ packet: "evidence/section-1.json", locator: { paragraph: 3 } }],
      },
    ]), "utf-8");

    const repaired = await repairClaimJudgments(ws);
    expect(repaired).toMatchObject({ normalized: true, judgments: 1 });
    const normalized = await fs.readFile(path.join(ws, "reviews", "claim-judgments.jsonl"), "utf-8");
    expect(normalized.trim().startsWith("{")).toBe(true);
    await fs.access(path.join(ws, "reviews", "claim-judgments.jsonl.pre-normalization.json"));
    const scored = await scoreClaimGate(ws);
    expect(scored.supportRate).toBe(1);
  });

  it("fails visibly rather than discarding malformed judgment rows", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "claim-gate-"));
    tempDirs.push(ws);
    await fs.mkdir(path.join(ws, "reviews"), { recursive: true });
    await fs.writeFile(path.join(ws, "reviews", "claim-judgments.jsonl"), JSON.stringify([
      { source_id: "s1", verdict: "entailed" },
    ]), "utf-8");
    await expect(repairClaimJudgments(ws)).rejects.toThrow(/invalid judgment row/);
    const report = await fs.readFile(path.join(ws, "reports", "claim-judgment-repair.md"), "utf-8");
    expect(report).toContain("Status: failed");
    expect(report).toContain("chapter");
  });
});
