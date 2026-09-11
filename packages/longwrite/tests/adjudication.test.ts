import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { acquireModelMetric, ADJUDICATION_PATH, scorecardDigest } from "../src/lib/registry/acquire.js";
import { assessReviewDisagreement, validateAdjudication } from "../src/lib/ops/adjudication.js";
import { AdjudicationRecord } from "../src/lib/registry/acquire.js";
import { metricDefinition } from "../src/lib/registry/metrics.js";
import { metricId } from "../src/lib/registry/ids.js";
import { compileModeToManifest } from "../src/lib/compiler.js";
import { loadMode } from "../src/lib/modes.js";
import { declaredReadsDigest } from "malaclaw/sdk";

/** The adjudication branch, end to end.
 *
 * `review_score` is the one metric with competing judges, and the acquisition
 * refuses to report a contested value. That refusal is only useful if something
 * can actually resolve the contest — and for a while nothing could: no stage
 * produced an adjudication, the acquisition ran in an isolated workspace that
 * did not contain the file it was waiting for, and any note at all set
 * `adjudicated: true` while the reported number stayed the untouched median. */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

/** Personas whose overall scores are `scores` apart on the 0-10 rubric. */
async function workspace(overalls: number[]): Promise<string> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-adjudicate-"));
  roots.push(ws);
  await fs.mkdir(path.join(ws, "reviews"), { recursive: true });
  await fs.mkdir(path.join(ws, "chapters"), { recursive: true });
  await fs.writeFile(path.join(ws, "chapters", "section-01.md"), "# One\n", "utf-8");
  await fs.writeFile(path.join(ws, "reviews", "scorecard.json"), JSON.stringify({
    version: 1,
    rubric_version: "scorecard-1",
    personas: overalls.map((value, index) => ({
      id: `persona-${index + 1}`,
      scores: { rigor: value, clarity: value },
      summary: `persona ${index + 1}`,
    })),
  }), "utf-8");
  return ws;
}

async function recordAdjudication(
  ws: string, record: Record<string, unknown>, digest?: string,
): Promise<void> {
  const target = path.join(ws, ADJUDICATION_PATH("review_score"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  const scorecard = await fs.readFile(path.join(ws, "reviews", "scorecard.json"), "utf-8");
  await fs.writeFile(target, `${JSON.stringify({
    scorecard_digest: digest ?? scorecardDigest(scorecard), ...record,
  }, null, 2)}\n`, "utf-8");
}

async function acquired(ws: string): Promise<Record<string, unknown>> {
  await acquireModelMetric(ws, "review_score");
  const envelope = JSON.parse(await fs.readFile(path.join(ws, "reports", "measurements.json"), "utf-8"));
  return envelope.measurements.find((entry: { metric: string }) => entry.metric === "review_score");
}

describe("the adjudication branch", () => {
  it("puts the adjudication in the acquisition's declared reads and input digest", async () => {
    // The acquisition runs in an isolated measurement workspace built from its
    // declared reads. An adjudication that is not declared is not copied, so
    // the stage that refuses to proceed without one could never see one.
    const definition = metricDefinition(metricId("review_score"));
    expect(definition.dependencies).toContain("reviews/adjudication/review_score.json");

    const mode = await loadMode("auto_research_agentic");
    const manifest = await compileModeToManifest(mode, {
      projectId: "adjudication-fixture", artifactType: "research_paper",
      topic: "adjudication", researchProvider: "seed",
    } as never) as { workflow: { stages: Array<{ id: string; reads?: string[]; when?: string; owns?: string[] }> } };
    const stages = manifest.workflow.stages;
    const acquire = stages.find((stage) => stage.id === "acquire_review_score");
    expect(acquire?.reads).toContain("reviews/adjudication/review_score.json");

    // And the branch that produces it runs first, guarded on the measured
    // disagreement rather than on a model call of its own.
    const ids = stages.map((stage) => stage.id);
    expect(ids.indexOf("assess_review_disagreement")).toBeLessThan(ids.indexOf("adjudicate_review_score"));
    expect(ids.indexOf("adjudicate_review_score")).toBeLessThan(ids.indexOf("acquire_review_score"));
    const adjudicate = stages.find((stage) => stage.id === "adjudicate_review_score");
    expect(adjudicate?.when).toBe("review_score_disagreement >= 1");
    // It writes into the shared guard file, and it declares that it does.
    const assess = stages.find((stage) => stage.id === "assess_review_disagreement");
    expect(assess?.owns).toContain("reports/metrics.json");
  });

  it("reports the metric when the judges agree, with no adjudication at all", async () => {
    const ws = await workspace([7.0, 7.4]);
    const entry = await acquired(ws);
    expect(entry.status).toBe("measured");
    expect(entry.value).toBe(7.2);
    // Nothing adjudicated anything, and the record says so rather than
    // inheriting `true` from the metric's declared reducer.
    expect((entry.judgment as { adjudicated: boolean }).adjudicated).toBe(false);
  });

  it("rejects a scorecard whose kernel-bound producer snapshot predates the manuscript", async () => {
    const ws = await workspace([7.0, 7.4]);
    const reads = ["chapters/**"];
    const readDigest = await declaredReadsDigest(ws, reads);
    const raw = await fs.readFile(path.join(ws, "reviews", "scorecard.json"), "utf8");
    const rawDigest = createHash("sha256").update(raw).digest("hex");
    await fs.mkdir(path.join(ws, ".malaclaw", "flow", "artifacts"), { recursive: true });
    await fs.writeFile(path.join(ws, ".malaclaw", "flow", "producer-receipts.json"),
      JSON.stringify({ version: 1, receipts: ["baseline_review.json"] }), "utf8");
    await fs.writeFile(path.join(ws, ".malaclaw", "flow", "artifacts", "baseline_review.json"), JSON.stringify({
      version: 2, producer_stage: "improve-r1-baseline_review", producer_invocation_id: "review-1",
      producer_input_digest: readDigest, producer_reads: reads, prompt_digest: "a".repeat(64),
      actual_runtime: "codex", actual_model: "review-model", actual_model_reasoning_effort: "high",
      output_digest: rawDigest, completed_sequence: 1,
      outputs: [{ path: "reviews/scorecard.json", digest: rawDigest }],
    }), "utf8");
    await fs.writeFile(path.join(ws, "chapters", "section-01.md"), "# Revised\nNew manuscript bytes.\n", "utf8");

    const entry = await acquired(ws);
    expect(entry.status).toBe("unavailable");
    expect(entry.reason).toContain("producer_provenance");
    expect(entry.reason).toContain("earlier kernel input snapshot");
  });

  it("binds a model observation to its producer prompt and runtime identity", async () => {
    const ws = await workspace([7.0, 7.4]);
    const reads = ["chapters/**"];
    const readDigest = await declaredReadsDigest(ws, reads);
    const raw = await fs.readFile(path.join(ws, "reviews", "scorecard.json"), "utf8");
    const rawDigest = createHash("sha256").update(raw).digest("hex");
    const receipt = async (prompt: string, runtime: string) => {
      await fs.mkdir(path.join(ws, ".malaclaw", "flow", "artifacts"), { recursive: true });
      await fs.writeFile(path.join(ws, ".malaclaw", "flow", "producer-receipts.json"),
        JSON.stringify({ version: 1, receipts: ["baseline_review.json"] }), "utf8");
      await fs.writeFile(path.join(ws, ".malaclaw", "flow", "artifacts", "baseline_review.json"), JSON.stringify({
        version: 2, workflow_hash: "w".repeat(64), producer_stage: "improve-r1-baseline_review",
        producer_invocation_id: "review-1", producer_input_digest: readDigest, producer_reads: reads,
        prompt_digest: prompt, actual_runtime: runtime, actual_model: "review-model",
        actual_model_reasoning_effort: "high", output_digest: rawDigest, completed_sequence: 1,
        outputs: [{ path: "reviews/scorecard.json", digest: rawDigest }],
      }), "utf8");
    };
    await receipt("a".repeat(64), "codex");
    const first = await acquired(ws);
    await receipt("b".repeat(64), "other-runtime");
    const second = await acquired(ws);
    expect(first.status).toBe("measured");
    expect(second.status).toBe("measured");
    expect(second.input_digest).not.toBe(first.input_digest);
  });

  it("refuses a contested score until something resolves it", async () => {
    const ws = await workspace([3.0, 9.0]);
    const entry = await acquired(ws);
    expect(entry.status).toBe("unavailable");
    expect(entry.reason).toContain("no resolved adjudication");
  });

  it("keeps refusing when the adjudicator examined it and could not resolve it", async () => {
    const ws = await workspace([3.0, 9.0]);
    await recordAdjudication(ws, {
      version: 1, by: "editor", status: "unresolved",
      rationale: "the two readings rest on evidence this manuscript does not contain",
    });
    const entry = await acquired(ws);
    // An adjudicator who looked and could not decide has produced a real
    // answer, and it is not a resolution. Accepting it would report a contested
    // number as settled on the strength of a file existing.
    expect(entry.status).toBe("unavailable");
    expect(entry.reason).toContain("could not resolve it");
    expect(entry.reason).toContain("editor");
  });

  it("reports the RESOLVED score, not the reduction, once it is settled", async () => {
    const ws = await workspace([3.0, 9.0]);
    await recordAdjudication(ws, {
      version: 1, by: "editor", status: "resolved", resolved_score: 4.5,
      rationale: "the low reading is better supported; the evidence for the high one is not in the text",
    });
    const entry = await acquired(ws);
    expect(entry.status).toBe("measured");
    // 6.0 is the median of the two; the adjudicator settled on 4.5, and the
    // adjudication has to change the NUMBER or it changed nothing.
    expect(entry.value).toBe(4.5);
    const judgment = entry.judgment as { adjudicated: boolean; reasons: string[] };
    expect(judgment.adjudicated).toBe(true);
    expect(judgment.reasons.join(" ")).toContain("adjudicated to 4.5 by editor");
  });

  it("refuses a resolution of a scorecard other than the one on disk", async () => {
    const ws = await workspace([3.0, 9.0]);
    await recordAdjudication(ws, {
      version: 1, by: "editor", status: "resolved", resolved_score: 4.5,
      rationale: "settled against an earlier review round",
    }, "f".repeat(64));
    // A later round writes a different scorecard, and the ruling about the
    // previous one is not a ruling about this one.
    const entry = await acquired(ws);
    expect(entry.status).toBe("unavailable");
    await expect(validateAdjudication(ws, "review_score"))
      .rejects.toThrow(/adjudicates a different scorecard/);
  });

  it("refuses a score outside the readings it was choosing between", async () => {
    const ws = await workspace([3.0, 9.0]);
    await recordAdjudication(ws, {
      version: 1, by: "editor", status: "resolved", resolved_score: 10,
      rationale: "settled above both readings",
    });
    // The schema bounds it to the rubric; the acquisition bounds it to the
    // dispute. Settling a disagreement between 3 and 9 at 10 answers a
    // different question, and an unbounded field would have let 1000 satisfy a
    // release objective outright.
    expect((await acquired(ws)).status).toBe("unavailable");
  });

  it("refuses a score outside the rubric at all", () => {
    expect(AdjudicationRecord.safeParse({
      version: 1, by: "editor", status: "resolved", resolved_score: 1000,
      scorecard_digest: "a".repeat(64), rationale: "nonsense",
    }).success).toBe(false);
  });

  it("ignores an adjudication the reviewed artifact carries about itself", async () => {
    const ws = await workspace([3.0, 9.0]);
    const scorecardPath = path.join(ws, "reviews", "scorecard.json");
    const scorecard = JSON.parse(await fs.readFile(scorecardPath, "utf-8"));
    await fs.writeFile(scorecardPath, JSON.stringify({
      ...scorecard,
      adjudication: { version: 1, by: "the reviewers", status: "resolved", resolved_score: 6,
                      scorecard_digest: "b".repeat(64), rationale: "we agree with ourselves" },
    }), "utf-8");
    // The reviewed artifact settling a dispute about itself is exactly the
    // independent judgment the adjudication stage exists to provide.
    expect((await acquired(ws)).status).toBe("unavailable");
  });

  it("refuses a resolution that names no score, and one that is not a resolution", async () => {
    const ws = await workspace([3.0, 9.0]);
    await recordAdjudication(ws, { version: 1, by: "editor", status: "resolved", rationale: "settled" });
    await expect(validateAdjudication(ws, "review_score"))
      .rejects.toThrow(/must state the score it resolved to/);
    await recordAdjudication(ws, {
      version: 1, by: "editor", status: "unresolved", resolved_score: 4.5, rationale: "unclear",
    });
    await expect(validateAdjudication(ws, "review_score"))
      .rejects.toThrow(/settled nothing and may not name a score/);
  });

  it("gates the adjudication stage on the measured spread", async () => {
    const agreed = await workspace([7.0, 7.4]);
    expect((await assessReviewDisagreement(agreed)).material).toBe(false);
    expect(JSON.parse(await fs.readFile(path.join(agreed, "reports", "metrics.json"), "utf-8"))
      .review_score_disagreement).toBe(0);

    const contested = await workspace([3.0, 9.0]);
    expect((await assessReviewDisagreement(contested)).material).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(contested, "reports", "metrics.json"), "utf-8"))
      .review_score_disagreement).toBe(1);
  });

  it("merges into the shared guard file rather than replacing it", async () => {
    const ws = await workspace([3.0, 9.0]);
    await fs.mkdir(path.join(ws, "reports"), { recursive: true });
    await fs.writeFile(path.join(ws, "reports", "metrics.json"),
      JSON.stringify({ visual_reviewable_pages: 4 }), "utf-8");
    await assessReviewDisagreement(ws);
    const metrics = JSON.parse(await fs.readFile(path.join(ws, "reports", "metrics.json"), "utf-8"));
    // Every stage guard in the workflow reads this file; replacing it would
    // delete the numbers the other guards depend on.
    expect(metrics.visual_reviewable_pages).toBe(4);
    expect(metrics.review_score_disagreement).toBe(1);
  });
});
