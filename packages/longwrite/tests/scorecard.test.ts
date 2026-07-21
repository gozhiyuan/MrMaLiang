import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  Scorecard,
  computeReviewScore,
  routeWeaknesses,
  SCORE_DIMENSIONS,
} from "../src/lib/writing/scorecard.js";
import { loadScorecard, scoreWorkspace, routeWorkspace } from "../src/lib/ops/scorecard.js";
import { loadMode } from "../src/lib/modes.js";
import { compileModeToManifest } from "../src/lib/compiler.js";

const tempDirs: string[] = [];
async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-scorecard-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

function persona(id: string, score: number, weaknesses: Array<{ category: string; detail: string; severity?: "minor" | "major" | "critical" }> = []) {
  return {
    id,
    scores: Object.fromEntries(SCORE_DIMENSIONS.map((d) => [d, score])),
    weaknesses,
  };
}

function scorecard(scores: number[]): Scorecard {
  return Scorecard.parse({
    personas: scores.map((s, i) => persona(`p${i}`, s)),
  });
}

describe("computeReviewScore", () => {
  it("takes the median of persona overalls", () => {
    const result = computeReviewScore(scorecard([4, 6, 5]), []);
    expect(result.rawMedian).toBe(5);
    expect(result.reviewScore).toBe(5);
    expect(result.round).toBe(1);
    expect(result.capsApplied).toHaveLength(0);
  });

  it("caps round 1 at 7.0 even when personas are enthusiastic", () => {
    const result = computeReviewScore(scorecard([9, 9.5, 9]), []);
    expect(result.rawMedian).toBe(9);
    expect(result.reviewScore).toBe(7);
    expect(result.capsApplied[0]).toContain("round-1 cap");
  });

  it("caps per-round gains at +1.5 over the previous official score", () => {
    const result = computeReviewScore(scorecard([9.5, 9.5, 9.5]), [6.0]);
    expect(result.round).toBe(2);
    expect(result.reviewScore).toBe(7.5);
    expect(result.capsApplied[0]).toContain("gain cap");
  });

  it("does not throttle recovery from a low scaffold baseline", () => {
    // Flagship-run lesson: an honest 0.9 on scaffold drafts must not force
    // +1.5 ladder steps once real prose exists. Ceiling floors at the
    // round-1 cap (7.0).
    const result = computeReviewScore(scorecard([5.9, 5.9, 5.9]), [0.9]);
    expect(result.reviewScore).toBe(5.9);
    expect(result.capsApplied).toHaveLength(0);
    // But the cap still binds above 7.0 for low-baseline histories.
    const high = computeReviewScore(scorecard([9, 9, 9]), [0.9]);
    expect(high.reviewScore).toBe(7);
    expect(high.capsApplied[0]).toContain("gain cap");
  });

  it("does not inflate an honest low score", () => {
    const result = computeReviewScore(scorecard([5, 5, 5]), [6.5]);
    expect(result.reviewScore).toBe(5);
    expect(result.capsApplied).toHaveLength(0);
  });

  it("rejects scorecards with fewer than 3 personas", () => {
    expect(() => scorecard([8, 8])).toThrow(/3/);
  });
});

describe("routeWeaknesses", () => {
  it("routes categories to fixing stages and sorts by severity", () => {
    const card = Scorecard.parse({
      personas: [
        persona("a", 6, [{ category: "citation coverage", detail: "missing refs", severity: "minor" }]),
        persona("b", 6, [{ category: "structure", detail: "sections disordered", severity: "critical" }]),
        persona("c", 6, [{ category: "prose style", detail: "wordy", severity: "major" }]),
      ],
    });
    const routed = routeWeaknesses(card);
    expect(routed[0].category).toBe("structure");
    expect(routed[0].targets[0].stage).toBe("outline");
    expect(routed.find((w) => w.category === "citation coverage")!.targets[0].stage).toBe("recall");
    // Unknown categories fall through to revise.
    expect(routed.find((w) => w.category === "prose style")!.targets[0].stage).toBe("revise");
  });
});

describe("scorecard ops", () => {
  it("loadScorecard fails closed with a shape hint", async () => {
    const ws = await makeWorkspace();
    const missing = await loadScorecard(ws);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.findings.join("\n")).toContain("personas");
  });

  it("scoreWorkspace writes capped metrics and accumulates round history", async () => {
    const ws = await makeWorkspace();
    await fs.mkdir(path.join(ws, "reviews"), { recursive: true });
    await fs.mkdir(path.join(ws, "reports"), { recursive: true });
    await fs.writeFile(
      path.join(ws, "reports", "metrics.json"),
      JSON.stringify({ chapter_word_count_total: 7000, review_score: 9.9 }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(ws, "reviews", "scorecard.json"),
      JSON.stringify({ personas: [persona("a", 9), persona("b", 9), persona("c", 9)] }),
      "utf-8",
    );

    const round1 = await scoreWorkspace(ws);
    expect(round1.reviewScore).toBe(7); // round-1 cap beats the worker's 9.9
    const metrics = JSON.parse(await fs.readFile(path.join(ws, "reports", "metrics.json"), "utf-8"));
    expect(metrics.review_score).toBe(7);
    expect(metrics.chapter_word_count_total).toBe(7000); // merged, not clobbered
    expect(metrics.review_novelty).toBe(9);

    const replay = await scoreWorkspace(ws);
    expect(replay.round).toBe(1);
    expect(replay.reviewScore).toBe(7);
    const replayMetrics = JSON.parse(await fs.readFile(path.join(ws, "reports", "metrics.json"), "utf-8"));
    expect(replayMetrics.review_score).toBe(7);

    await fs.writeFile(
      path.join(ws, "reports", "metrics.json"),
      JSON.stringify({ chapter_word_count_total: 7000, review_score: 10 }),
      "utf-8",
    );
    await scoreWorkspace(ws);
    const restoredMetrics = JSON.parse(await fs.readFile(path.join(ws, "reports", "metrics.json"), "utf-8"));
    expect(restoredMetrics.review_score).toBe(7);
    expect(restoredMetrics.review_round).toBe(1);

    await fs.writeFile(
      path.join(ws, "reviews", "scorecard.json"),
      JSON.stringify({ personas: [persona("a", 9.5), persona("b", 9.5), persona("c", 9.5)] }),
      "utf-8",
    );

    const round2 = await scoreWorkspace(ws);
    expect(round2.round).toBe(2);
    expect(round2.reviewScore).toBe(8.5); // 7.0 + 1.5 gain cap
  });

  it("routeWorkspace writes reports/routing.md", async () => {
    const ws = await makeWorkspace();
    await fs.mkdir(path.join(ws, "reviews"), { recursive: true });
    await fs.writeFile(
      path.join(ws, "reviews", "scorecard.json"),
      JSON.stringify({
        personas: [
          persona("a", 6, [{ category: "sources", detail: "too arXiv-heavy" }]),
          persona("b", 6),
          persona("c", 6),
        ],
      }),
      "utf-8",
    );
    const { routed, actions } = await routeWorkspace(ws);
    expect(routed).toHaveLength(1);
    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "evidence_repair", stage: "recall" }),
    ]));
    const md = await fs.readFile(path.join(ws, "reports", "routing.md"), "utf-8");
    expect(md).toContain("recall");
    expect(md).toContain("too arXiv-heavy");
    const plan = JSON.parse(await fs.readFile(path.join(ws, "reports", "remediation-plan.json"), "utf-8"));
    expect(plan.actions[0].id).toBe("evidence_repair");
  });
});

describe("compiler scorecard injection", () => {
  it("scores the baseline and rebuilt-manuscript reviews, not the intermediate revision", async () => {
    const mode = await loadMode("auto_research_agentic");
    const manifest = compileModeToManifest(mode, {
      projectId: "t",
      topic: "test topic",
      researchProvider: "seed",
    }) as { workflow: { stages: Array<Record<string, unknown>> } };
    const baseline = manifest.workflow.stages.find((s) => s.id === "baseline_review")!;
    const loop = manifest.workflow.stages.find((s) => s.id === "quality_loop") as
      | { stages?: Array<Record<string, unknown>> }
      | undefined;
    for (const stage of [baseline, loop?.stages?.find((s) => s.id === "review")!]) {
      expect(stage.outputs).toContain("reviews/scorecard.json");
      const commands = (stage.validator_commands as Array<{ args: string[] }>).map((c) => c.args.join(" "));
      expect(commands.some((c) => c.includes("validate scorecard"))).toBe(true);
      expect(commands.some((c) => c.includes("review score"))).toBe(true);
    }
    // No intermediate loop stage may emit the official scorecard: the
    // post-rebuild review is the only in-loop scoring unit.
    const scoringChildren = (loop?.stages ?? [])
      .filter((s) => Array.isArray(s.outputs) && (s.outputs as string[]).includes("reviews/scorecard.json"))
      .map((s) => s.id);
    expect(scoringChildren).toEqual(["review"]);
  });
});

describe("review regression detection", () => {
  it("flags a resolved weakness category that reappears in a later round", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { scoreWorkspace } = await import("../src/lib/ops/scorecard.js");

    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "regress-"));
    await fs.mkdir(path.join(ws, "reviews"), { recursive: true });
    await fs.mkdir(path.join(ws, "reports"), { recursive: true });
    await fs.writeFile(path.join(ws, "longwrite.yaml"),
      "version: 1\nproject:\n  id: r\n  artifact_type: research_paper\n  mode: auto_research_agentic\nresearch:\n  paper_kind: survey\n  provider: seed\n", "utf-8");

    const card = (cats: string[]) => JSON.stringify({
      version: 1,
      personas: ["a", "b", "c"].map((id) => ({
        id,
        scores: { scope_coverage: 6, evidence_fidelity: 6, comparative_synthesis: 6, literature_quality: 6, clarity: 6 },
        weaknesses: cats.map((c) => ({ category: c, detail: `${c} issue`, severity: "major" })),
      })),
    });

    // Round 1: has "coverage". Round 2: fixed (absent). Round 3: reappears.
    await fs.writeFile(path.join(ws, "reviews", "scorecard.json"), card(["coverage"]), "utf-8");
    await scoreWorkspace(ws);
    await fs.writeFile(path.join(ws, "reviews", "scorecard.json"), card(["clarity"]), "utf-8");
    await scoreWorkspace(ws);
    await fs.writeFile(path.join(ws, "reviews", "scorecard.json"), card(["coverage"]), "utf-8");
    await scoreWorkspace(ws);

    const metrics = JSON.parse(await fs.readFile(path.join(ws, "reports", "metrics.json"), "utf-8"));
    expect(metrics.review_regressions).toBe(1);
    const report = await fs.readFile(path.join(ws, "reports", "regressions.md"), "utf-8");
    expect(report).toContain("coverage");
    await fs.rm(ws, { recursive: true, force: true });
  });
});
