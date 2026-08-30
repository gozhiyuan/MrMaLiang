import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectContradictions, type ClaimJudgment } from "../src/lib/research/contradiction.js";
import { validateResearchWorkspace } from "../src/lib/validation/research.js";

const j = (over: Partial<ClaimJudgment>): ClaimJudgment => ({
  sample_id: "claim-001", reviewer_id: "reviewer_a", source_id: "s1", chapter: "chapters/section-05.md",
  claim: "example claim", verdict: "entailed", ...over,
});

describe("detectContradictions", () => {
  it("flags the same subject affirmed in one section and denied in another", () => {
    const judgments = [
      j({ chapter: "chapters/section-05.md", claim: "The stale constraint is withdrawn by a newer authoritative record.", subject_key: "stale-constraint-provenance-mechanism", polarity: "affirms" }),
      j({ chapter: "chapters/section-08.md", claim: "Provenance linking substantially improved current-record-consistent decisions.", subject_key: "stale-constraint-provenance-mechanism", polarity: "affirms" }),
      j({ chapter: "chapters/section-09.md", claim: "The supplied evidence does not establish a withdrawn constraint or provenance-preserved origin.", subject_key: "stale-constraint-provenance-mechanism", polarity: "denies" }),
    ];
    const contradictions = detectContradictions(judgments);
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]!.subject_key).toBe("stale-constraint-provenance-mechanism");
    expect(contradictions[0]!.chapters.sort()).toEqual(["chapters/section-05.md", "chapters/section-08.md", "chapters/section-09.md"]);
  });

  it("does not flag two qualifications of the same subject as a contradiction", () => {
    const judgments = [
      j({ chapter: "chapters/section-03.md", subject_key: "memory-persistence", polarity: "qualifies" }),
      j({ chapter: "chapters/section-06.md", subject_key: "memory-persistence", polarity: "qualifies" }),
    ];
    expect(detectContradictions(judgments)).toEqual([]);
  });

  it("does not flag an affirm/deny pair confined to a single section", () => {
    const judgments = [
      j({ chapter: "chapters/section-03.md", subject_key: "x", polarity: "affirms" }),
      j({ chapter: "chapters/section-03.md", subject_key: "x", polarity: "denies" }),
    ];
    expect(detectContradictions(judgments)).toEqual([]);
  });

  it("ignores judgments missing subject_key or polarity", () => {
    const judgments = [j({ subject_key: undefined, polarity: undefined })];
    expect(detectContradictions(judgments)).toEqual([]);
  });
});

const tempDirs: string[] = [];
afterEach(async () => { while (tempDirs.length) await fs.rm(tempDirs.pop()!, { recursive: true, force: true }); });

describe("claim_contradictions release gate", () => {
  it("fails when reviews/claim-judgments.jsonl records an affirm/deny pair across sections", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "contradiction-gate-"));
    tempDirs.push(ws);
    await fs.mkdir(path.join(ws, "reviews"), { recursive: true });
    await fs.writeFile(path.join(ws, "reviews", "claim-judgments.jsonl"), [
      JSON.stringify({ sample_id: "claim-001", reviewer_id: "reviewer_a", source_id: "s1", chapter: "chapters/section-05.md", claim: "affirms it", verdict: "entailed", subject_key: "stale-constraint", polarity: "affirms" }),
      JSON.stringify({ sample_id: "claim-002", reviewer_id: "reviewer_a", source_id: "s2", chapter: "chapters/section-09.md", claim: "denies it", verdict: "unsupported", subject_key: "stale-constraint", polarity: "denies" }),
    ].join("\n"));
    const report = await validateResearchWorkspace(ws);
    const check = report.checks.find((c) => c.id === "claim_contradictions");
    expect(check?.pass).toBe(false);
    expect(check?.findings[0]).toContain("stale-constraint");
  });
});
