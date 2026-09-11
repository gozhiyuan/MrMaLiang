import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { metricDefinition } from "../registry/metrics.js";
import { metricId } from "../registry/ids.js";
import {
  ADJUDICATION_PATH, AdjudicationRecord as Record_, scorecardDigest,
} from "../registry/acquire.js";

export { AdjudicationRecord } from "../registry/acquire.js";

export const DISAGREEMENT_PATH = path.join("reports", "review-disagreement.json");
const SCORECARD_PATH = path.join("reviews", "scorecard.json");
const METRICS_PATH = path.join("reports", "metrics.json");

const Scorecard = z.object({
  personas: z.array(z.object({
    id: z.string().min(1),
    scores: z.record(z.number()),
  }).passthrough()).min(1),
}).passthrough();

function overall(persona: { scores: Record<string, number> }): number {
  const values = Object.values(persona.scores);
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Measures how far the persona reviews disagree, and publishes it where a
 * stage guard can read it.
 *
 * Deterministic arithmetic, deliberately separated from the judgment that
 * resolves it: deciding whether to spend a high-tier call is not itself a
 * high-tier decision, and a guard that needed a model call to evaluate would
 * cost the very thing it exists to avoid.
 *
 * `review_score_disagreement` goes into reports/metrics.json because that is
 * the file the kernel's `when:` guard falls back to. It is a stage guard, not
 * an observation: nothing is judged on it and no contract names it. */
export async function assessReviewDisagreement(
  workspaceDir: string,
): Promise<{ material: boolean; spread: number; reportPath: string }> {
  const definition = metricDefinition(metricId("review_score"));
  const raw = await fs.readFile(path.join(workspaceDir, SCORECARD_PATH), "utf-8").catch(() => null);
  // No scorecard is not agreement. It is nothing to adjudicate, and the
  // acquisition will report the metric unavailable for its own reasons.
  const personas = raw === null ? [] : Scorecard.parse(JSON.parse(raw)).personas;
  const overalls = personas.map(overall);
  const spread = overalls.length < 2 ? 0 : Math.max(...overalls) - Math.min(...overalls);
  // The same threshold the acquisition judges disagreement on, read from the
  // metric rather than chosen here: a guard that used its own number would send
  // the adjudicator at spreads the acquisition tolerates, and skip it at
  // spreads the acquisition refuses.
  const material = spread > 10 / 4 && spread > definition.tolerance;

  const report = {
    version: 1,
    metric: "review_score",
    // The adjudicator copies this into its record, and the acquisition checks
    // it: an adjudication is about ONE dispute, and a file that outlived the
    // scorecard that produced it is settling an argument nobody is having.
    scorecard_digest: raw === null ? null : scorecardDigest(raw),
    spread: Number(spread.toFixed(4)),
    material,
    tolerance: definition.tolerance,
    personas: personas.map((persona, index) => ({
      id: persona.id, overall: Number((overalls[index] ?? 0).toFixed(4)),
    })).sort((a, b) => b.overall - a.overall),
  };
  const target = path.join(workspaceDir, DISAGREEMENT_PATH);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

  // Merged, never overwritten: reports/metrics.json is shared by every stage
  // guard in the workflow, and replacing it would delete the numbers the other
  // guards read.
  const metricsFile = path.join(workspaceDir, METRICS_PATH);
  const existing = await fs.readFile(metricsFile, "utf-8")
    .then((body) => JSON.parse(body) as Record<string, unknown>)
    .catch(() => ({} as Record<string, unknown>));
  await fs.mkdir(path.dirname(metricsFile), { recursive: true });
  await fs.writeFile(metricsFile,
    `${JSON.stringify({ ...existing, review_score_disagreement: material ? 1 : 0 }, null, 2)}\n`,
    "utf-8");

  return { material, spread, reportPath: DISAGREEMENT_PATH };
}

/** Validates what the adjudicator wrote.
 *
 * A validator rather than a schema reference, for the same reason diagnosis has
 * one: the contract has to be enforced by something that actually runs. */
export async function validateAdjudication(
  workspaceDir: string, metric: string,
): Promise<z.infer<typeof Record_>> {
  const rel = ADJUDICATION_PATH(metric);
  const parsed = Record_.safeParse(
    JSON.parse(await fs.readFile(path.join(workspaceDir, rel), "utf-8")));
  if (!parsed.success) {
    throw new Error(`${rel}: invalid adjudication; ` + parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; "));
  }
  // Checked at the validator too, not only at acquisition. A stale record is a
  // defect in the adjudication the operator can be told about now, rather than
  // a metric that silently reports unavailable two stages later.
  const scorecard = await fs.readFile(path.join(workspaceDir, SCORECARD_PATH), "utf-8").catch(() => null);
  if (scorecard === null) {
    throw new Error(`${rel}: there is no ${SCORECARD_PATH} for this adjudication to be about`);
  }
  if (parsed.data.scorecard_digest !== scorecardDigest(scorecard)) {
    throw new Error(
      `${rel}: adjudicates a different scorecard than the one on disk; ` +
      `re-read ${SCORECARD_PATH} and adjudicate the dispute it actually records`);
  }
  return parsed.data;
}
