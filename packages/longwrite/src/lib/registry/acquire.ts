import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { metricDefinition, type MetricDefinition } from "./metrics.js";
import { metricId } from "./ids.js";
import { declaredReadsDigest } from "malaclaw/sdk";
import { EVALUATOR_VERSION } from "./evaluators/index.js";
import { MeasurementEnvelopeSchema, type MeasurementEntry } from "./records.js";
import { MEASUREMENTS_PATH } from "./evaluate.js";
import { computeInputDigest, evaluatorDigest } from "./digests.js";

/** Acquisition is the other half of measurement.
 *
 * `metrics evaluate` marks every non-script metric `deferred` BY DESIGN: it
 * cannot run a model. A stage that invoked it for a model metric would defer
 * that metric forever, in the very stage meant to produce it. Acquisition runs
 * the metric's declared producer output, validates it against the declared
 * validator, applies the declared reducer, and emits a `measured` entry with a
 * populated judgment — or an `unavailable` entry saying why it could not. */

/** The rubric every persona scores on, and therefore the only range an
 * adjudication between them can land in. */
export const RUBRIC_RANGE = { min: 0, max: 10 } as const;

/** What an adjudication is ABOUT: the exact scorecard bytes it settles. */
export function scorecardDigest(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** A recorded adjudication.
 *
 * The verdict that RESOLVES a disagreement between independent judgments — not
 * a note that one occurred. `status` is the load-bearing field: an adjudicator
 * that examined the dispute and could not settle it has produced a real and
 * useful answer, and treating that as a resolution is how a contested score got
 * reported as agreed. `resolved_score` is what the acquisition then uses, so
 * the adjudication changes the number rather than only the flag beside it —
 * without it the acquired value stayed the original median however the
 * adjudicator ruled.
 *
 * Its absence remains the honest default. Reporting `adjudicated: true` because
 * the metric declares an adjudicated reducer was a claim about a step that
 * never ran. */
export const AdjudicationRecord = z.object({
  version: z.literal(1),
  by: z.string().min(1).max(200),
  at: z.string().min(1).optional(),
  status: z.enum(["resolved", "unresolved"]),
  /** The value the adjudicator settled on, on the reviewers' own rubric.
   *
   * Bounded, not merely finite. The prompt asks for a 0-10 score and the
   * schema accepted any number, so a 1000 would have satisfied a release
   * objective outright — an adjudication is a judgment between the readings on
   * the table, and a number outside the rubric is not one of them. */
  resolved_score: z.number().min(RUBRIC_RANGE.min).max(RUBRIC_RANGE.max).optional(),
  /** The digest of the SCORECARD this adjudication settles.
   *
   * An adjudication is about one specific dispute. Without this the file
   * outlived the disagreement that produced it: a later review round writes a
   * different scorecard — or agrees — and the stale `resolved_score` was still
   * accepted as the value of the new one. */
  scorecard_digest: z.string().regex(/^[0-9a-f]{64}$/),
  rationale: z.string().min(1).max(8_000),
}).strict().superRefine((record, ctx) => {
  if (record.status === "resolved" && record.resolved_score === undefined) {
    ctx.addIssue({ code: "custom", path: ["resolved_score"],
      message: "a resolved adjudication must state the score it resolved to" });
  }
  if (record.status === "unresolved" && record.resolved_score !== undefined) {
    ctx.addIssue({ code: "custom", path: ["resolved_score"],
      message: "an unresolved adjudication settled nothing and may not name a score" });
  }
});
export type AdjudicationRecord = z.infer<typeof AdjudicationRecord>;

/** A scorecard the persona review produced.
 *
 * Each persona scores every RUBRIC DIMENSION; there is no single number per
 * persona, and an earlier version of this schema asked for one. Nothing in
 * this product writes that shape, so every acquisition of review_score failed
 * validation and the metric was permanently unavailable — a contract judged on
 * it could never be satisfied. The shape here is the one
 * `lib/writing/scorecard.ts` defines and the review stage actually emits. */
const Scorecard = z.object({
  version: z.literal(1).optional(),
  personas: z.array(z.object({
    id: z.string().min(1),
    scores: z.record(z.number().min(0).max(10)),
    summary: z.string().min(1).optional(),
  }).passthrough()).min(1),
  rubric_version: z.string().min(1).optional(),
}).passthrough();

/** A persona's overall score: the mean of its dimension scores, as
 * `computeReviewScore` reduces it. */
function personaOverall(persona: { scores: Record<string, number> }): number {
  const values = Object.values(persona.scores);
  if (values.length === 0) throw new Error("scorecard_schema: a persona scored no dimension");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** One claim judgment per line. */
const ClaimJudgment = z.object({
  claim_id: z.string().min(1),
  supported: z.boolean(),
  rationale: z.string().min(1).optional(),
}).passthrough();

const VisualReview = z.object({
  version: z.literal(1).optional(),
  pass: z.boolean(),
  rubric_version: z.string().min(1).optional(),
  findings: z.array(z.unknown()).optional(),
}).passthrough();

export type Acquisition = {
  value: number;
  reasons: string[];
  rubricVersion: string;
  evidenceRefs: string[];
  /** How much the opinions this reduced agreed. Reported by the acquisition
   * itself, because only it knows what its producer's records mean: three
   * personas scoring a manuscript can disagree, while one verdict per claim
   * cannot. A constant here would be a number nobody measured attached to a
   * measurement the kernel is asked to trust. */
  confidence: number;
  disagreement: "none" | "within_tolerance" | "material" | "unresolved";
  /** Whether a recorded adjudication resolved a disagreement in the material
   * this reduced. Read from the producer's own record, never derived from the
   * metric's declared reducer: a declaration is what SHOULD happen, and using
   * it as evidence that it DID is how an unadjudicated number came to carry an
   * `adjudicated: true` the kernel was asked to trust. */
  adjudicated: boolean;
};

/** Agreement across competing opinions on ONE thing, judged against what the
 * metric already declares as an indifferent difference. */
function agreement(
  values: number[], tolerance: number, range: number,
): Pick<Acquisition, "confidence" | "disagreement"> {
  if (values.length < 2) {
    // Nothing disagreed because nothing else was asked. The reduction of a
    // single recorded verdict is exact; the uncertainty belongs to the
    // reviewer who wrote it, and is not this function's to invent.
    return { confidence: 1, disagreement: "none" };
  }
  const spread = Math.max(...values) - Math.min(...values);
  const confidence = Math.max(0, Math.min(1, 1 - spread / range));
  if (spread <= tolerance) return { confidence, disagreement: "within_tolerance" };
  return { confidence, disagreement: spread > range / 4 ? "material" : "within_tolerance" };
}

/** Reads and reduces one model metric's raw producer output.
 *
 * The reduction is the metric's declared `reducer`; the validator is its
 * declared `validator`. Both come from the registry rather than from this
 * function's own opinion, so a metric whose rubric changes changes here in one
 * place. */
const ACQUISITIONS: Record<string, (raw: string, adjudication?: unknown) => Acquisition> = {
  // `recorded` is the ADJUDICATOR's artifact and the only place an adjudication
  // is read from. The scorecard used to be allowed to carry its own, which let
  // the reviewed artifact settle a dispute about itself and skip the
  // independent adjudicator entirely.
  review_score: (raw, recorded) => {
    const scorecard = Scorecard.parse(JSON.parse(raw));
    const overalls = scorecard.personas.map(personaOverall);
    const scores = [...overalls].sort((a, b) => a - b);
    // Median, not mean: one enthusiastic persona should not carry a release.
    const middle = Math.floor(scores.length / 2);
    const reduced = scores.length % 2 === 0
      ? (scores[middle - 1]! + scores[middle]!) / 2
      : scores[middle]!;
    // A RESOLVED adjudication settles the number, not merely the flag beside
    // it. Reporting the original median while claiming the dispute was
    // adjudicated is a value nobody decided, dressed as one somebody did.
    const parsed = AdjudicationRecord.safeParse(recorded);
    const settled = parsed.success && parsed.data.status === "resolved"
      // Bound to THESE bytes. A resolution of a different scorecard is a
      // judgment about a dispute this measurement is not having.
      && parsed.data.scorecard_digest === scorecardDigest(raw)
      // And within the range the personas actually reported: settling a
      // disagreement between 3 and 9 at 10 is not adjudicating it.
      && parsed.data.resolved_score! >= Math.min(...overalls)
      && parsed.data.resolved_score! <= Math.max(...overalls)
      ? parsed.data : undefined;
    const value = settled?.resolved_score ?? reduced;
    return {
      value,
      reasons: [
        ...scorecard.personas.map((persona) =>
          `${persona.id}: ${personaOverall(persona).toFixed(1)}${persona.summary ? ` — ${persona.summary}` : ""}`),
        ...(settled === undefined ? []
          : [`adjudicated to ${settled.resolved_score} by ${settled.by} (reduction was ${reduced.toFixed(2)})`]),
      ],
      rubricVersion: scorecard.rubric_version ?? "scorecard-1",
      evidenceRefs: scorecard.personas.map((persona) => persona.id),
      // Personas score the same manuscript, so their spread IS the
      // disagreement, judged on the 0-10 rubric the scores are written in.
      ...agreement(overalls, 1, 10),
      // Median-of-means is a REDUCTION, not an adjudication. It stands in for
      // agreement; it does not create it. A real adjudication is a separate
      // judgment, made by the adjudication stage and written to its own file —
      // the persona review does not own the scorecard's verdict about itself.
      adjudicated: settled !== undefined,
    };
  },
  claim_support: (raw) => {
    const judgments = raw.split("\n").filter((line) => line.trim().length > 0)
      .map((line) => ClaimJudgment.parse(JSON.parse(line)));
    if (judgments.length === 0) throw new Error("claim_judgment_schema: no judgments recorded");
    const supported = judgments.filter((judgment) => judgment.supported).length;
    return {
      value: supported / judgments.length,
      reasons: [`${supported} of ${judgments.length} claims are supported by cited evidence`],
      rubricVersion: "claim-judgment-1",
      evidenceRefs: judgments.map((judgment) => judgment.claim_id).slice(0, 200),
      // One verdict per claim, so nothing disagreed with anything. What is
      // uncertain is the RATIO, and how uncertain follows from how many claims
      // were judged: the standard error of a proportion. Ten claims cannot
      // pin a support ratio as tightly as two hundred, and reporting 1 either
      // way was the fabrication.
      confidence: Math.max(0, Math.min(1, 1 - 2 * Math.sqrt(
        ((supported / judgments.length) * (1 - supported / judgments.length)) / judgments.length))),
      disagreement: "none" as const,
      // One verdict per claim: there was nothing to adjudicate.
      adjudicated: false,
    };
  },
  rendered_visual_review: (raw) => {
    const review = VisualReview.parse(JSON.parse(raw));
    return {
      // A boolean metric is measured as 1 or 0, never as "absent means false":
      // absence is unavailable, which this function never returns.
      value: review.pass ? 1 : 0,
      reasons: [review.pass ? "the rendered review found no blocking defect"
        : `the rendered review found ${(review.findings ?? []).length} blocking defect(s)`],
      rubricVersion: review.rubric_version ?? "visual-review-1",
      evidenceRefs: [],
      // A single recorded verdict, reduced exactly.
      ...agreement([review.pass ? 1 : 0], 0, 1),
      adjudicated: review.adjudication !== undefined,
    };
  },
};

/** Where the adjudicator writes its verdict for one metric.
 *
 * Its own file, owned by the adjudication stage. Folding it into the producer's
 * output would put two stages in the same envelope and let a persona review
 * overwrite the judgment made about it. */
export function ADJUDICATION_PATH(metric: string): string {
  return path.posix.join("reviews", "adjudication", `${metric}.json`);
}

export function acquisitionMetrics(): string[] {
  return Object.keys(ACQUISITIONS).sort();
}

function digest(value: string): string {
  // SHA-256, not a hand-rolled polynomial. The kernel uses this field to decide
  // whether a stored measurement still describes the workspace, so a collision
  // is a stale value accepted as current — and a 131-based rolling hash reduced
  // mod 2^256 has no collision resistance worth relying on for that.
  return createHash("sha256").update(value).digest("hex");
}

const ProducerReceipt = z.object({
  version: z.literal(2),
  producer_stage: z.string().min(1),
  producer_invocation_id: z.string().min(1),
  producer_input_digest: z.string().regex(/^[0-9a-f]{64}$/),
  producer_reads: z.array(z.string().min(1)),
  prompt_digest: z.string().regex(/^[0-9a-f]{64}$/),
  actual_runtime: z.string().min(1),
  actual_model: z.string().nullable(),
  actual_model_reasoning_effort: z.string().nullable(),
  output_digest: z.string().regex(/^[0-9a-f]{64}$/),
  completed_sequence: z.number().int().nonnegative(),
  outputs: z.array(z.object({ path: z.string().min(1), digest: z.string().regex(/^[0-9a-f]{64}$/) }).strict()),
}).passthrough();

const RECEIPT_ROOT = path.join(".malaclaw", "flow");

/** Verify the kernel-issued receipt copied into this isolated task workspace.
 *
 * State is deliberately not materialized into tasks.  Looking for state.json
 * here therefore made production acquisitions silently take their legacy path.
 * Receipts are a narrow, kernel-authored input: they bind the producer's
 * invocation, prompt/runtime configuration, input snapshot and exact output
 * bytes without exposing mutable control-plane state to the worker. */
async function verifyProducerFreshness(
  workspaceDir: string, rawPath: string,
): Promise<{ ok: true; receipt?: z.infer<typeof ProducerReceipt> } | { ok: false; reason: string }> {
  const index = await fs.readFile(path.join(workspaceDir, RECEIPT_ROOT, "producer-receipts.json"), "utf-8")
    .then(() => true).catch(() => false);
  // Keep direct library calls usable, but a kernel task always receives the
  // index (even with zero receipts) and therefore fails closed.
  if (!index) return { ok: true };
  const dir = path.join(workspaceDir, RECEIPT_ROOT, "artifacts");
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  const receipts = await Promise.all(files.filter((file) => file.endsWith(".json")).map(async (file) =>
    fs.readFile(path.join(dir, file), "utf-8").then((raw) => ProducerReceipt.safeParse(JSON.parse(raw))).catch(() => null)));
  const candidates = receipts.flatMap((receipt) => receipt?.success ? [receipt.data] : [])
    .filter((receipt) => receipt.outputs.some((output) => output.path === rawPath))
    .sort((a, b) => b.completed_sequence - a.completed_sequence);
  const receipt = candidates[0];
  if (!receipt) return { ok: false, reason: `${rawPath} has no successful kernel-issued producer receipt` };
  const recordedOutput = receipt.outputs.find((output) => output.path === rawPath)!;
  const currentOutput = await fs.readFile(path.join(workspaceDir, rawPath), "utf-8")
    .then((raw) => digest(raw)).catch(() => null);
  if (currentOutput !== recordedOutput.digest) {
    return { ok: false, reason: `${rawPath} no longer matches its kernel producer receipt` };
  }
  const currentReads = await declaredReadsDigest(workspaceDir, receipt.producer_reads);
  return currentReads === receipt.producer_input_digest
    ? { ok: true, receipt }
    : { ok: false, reason: `${rawPath} was produced from an earlier kernel input snapshot; rerun ${receipt.producer_stage} before acquiring its metric` };
}

/** Runs one model metric's acquisition and merges the result into the envelope.
 *
 * Merged, not overwritten: the envelope is the round's whole measurement
 * record, and an acquisition stage that replaced it would delete every script
 * metric measured moments earlier. */
export async function acquireModelMetric(
  workspaceDir: string, metric: string, asOfDate = new Date().toISOString(),
): Promise<{ status: MeasurementEntry["status"]; written: string }> {
  const definition: MetricDefinition = metricDefinition(metricId(metric));
  if (definition.measurement_kind !== "model") {
    throw new Error(`${metric} is a ${definition.measurement_kind} metric; acquisition is for model metrics`);
  }
  const acquire = ACQUISITIONS[metric];
  if (!acquire) {
    throw new Error(`no acquisition is registered for the model metric ${metric}`);
  }
  const rawPath = definition.raw_output?.[0];
  if (!rawPath) {
    throw new Error(`${metric} declares no raw_output for its producer ${definition.producer ?? "(none)"}`);
  }

  // What the measurement was taken FROM: the producer's output bytes and every
  // dependency the metric declares. The digest identified a path and a
  // timestamp, which made two measurements of different manuscripts compare
  // equal and every measurement of the SAME manuscript compare different —
  // exactly backwards for a field the kernel uses to decide whether a stored
  // result still describes the workspace.
  // Computed with the KERNEL's own arithmetic. Reading each declared path with
  // `readFile` treats a DIRECTORY as absent, and three of this metric's
  // dependencies — `chapters/`, `paper/`, `figures/` — are directories: they
  // hashed to the constant `<rel>:absent` on every run, so the digest the kernel
  // uses to decide whether a stored measurement still describes the workspace
  // never moved when the manuscript did.
  const inputDigest = await declaredReadsDigest(
    workspaceDir, [rawPath, ...(definition.dependencies ?? [])]);
  // A model measurement is identified by WHO produced it as well as by what it
  // read. The same chapters judged by a different producer at a different
  // rubric version are a different measurement, and a digest over bytes alone
  // cannot say so.
  const identityFor = (receipt?: z.infer<typeof ProducerReceipt>): string => createHash("sha256").update([
    metric,
    definition.producer ?? "(none)",
    definition.evaluator,
    EVALUATOR_VERSION,
    inputDigest,
    // The producer configuration is part of the observation's identity, not
    // decorative receipt metadata. Identical scorecard bytes from a changed
    // prompt/model/runtime must not be reused as the earlier judgment.
    typeof receipt?.workflow_hash === "string" ? receipt.workflow_hash : "legacy-no-workflow-hash",
    // The producer's INVOCATION id is deliberately absent. It is a fresh UUID
    // per attempt, so including it made every observation unique by
    // construction: an objective that moved A -> B -> A could never reuse the
    // judgment it already had, and the store filled with entries that differed
    // in nothing but a random field. What identifies a measurement is what it
    // read and how it was produced — dependency digest, prompt, runtime, model,
    // effort and rubric — all of which are below. Which attempt ran is
    // provenance, recorded on the receipt and checked for freshness there.
    receipt?.prompt_digest ?? "legacy-no-receipt",
    receipt?.actual_runtime ?? "legacy-no-receipt",
    receipt?.actual_model ?? "(default-model)",
    receipt?.actual_model_reasoning_effort ?? "(default-effort)",
  ].join("\n")).digest("hex");

  let common = {
    metric: definition.metric,
    scope_key: "",
    tolerance: definition.tolerance,
    direction: definition.direction,
    evaluator: definition.evaluator,
    evaluator_digest: digest(`${definition.evaluator}:${EVALUATOR_VERSION}`),
    input_digest: identityFor(),
    measurement_kind: "model" as const,
  };

  let entry: MeasurementEntry;
  try {
    const freshness = await verifyProducerFreshness(workspaceDir, rawPath);
    if (!freshness.ok) throw new Error(`producer_provenance: ${freshness.reason}`);
    common = { ...common, input_digest: identityFor(freshness.receipt) };
    const raw = await fs.readFile(path.join(workspaceDir, rawPath), "utf-8");
    // Read from the adjudicator's OWN artifact rather than from the producer's,
    // because the producer of a judgment is not the right author of the verdict
    // that resolves a disagreement about it.
    const recorded = await fs.readFile(path.join(workspaceDir, ADJUDICATION_PATH(metric)), "utf-8")
      .then((body) => JSON.parse(body) as unknown)
      .catch(() => undefined);
    const acquired = acquire(raw, recorded);
    entry = {
      ...common, status: "measured", value: acquired.value,
      judgment: {
        reasons: acquired.reasons.slice(0, 50),
        // Reported by the acquisition, from the opinions it actually reduced.
        confidence: acquired.confidence,
        rubric_version: acquired.rubricVersion,
        evidence_refs: acquired.evidenceRefs.slice(0, 200),
        adjudicated: acquired.adjudicated,
        disagreement: acquired.disagreement,
      },
    };
    // A metric that declares `adjudicated_consensus` promises a value only
    // where the judges agree or an adjudication resolved them. Material or
    // unresolved disagreement with no recorded adjudication is neither, and
    // reporting the reduction anyway would let an unsettled question be
    // released as a settled one.
    if (definition.reducer === "adjudicated_consensus" && !acquired.adjudicated
        && (acquired.disagreement === "material" || acquired.disagreement === "unresolved")) {
      // An adjudication that examined the dispute and could not settle it is a
      // real answer, and it is not this one: the metric stays unavailable, and
      // the reason says which of the two situations the operator is in.
      const attempted = await fs.readFile(path.join(workspaceDir, ADJUDICATION_PATH(metric)), "utf-8")
        .then((body) => AdjudicationRecord.safeParse(JSON.parse(body)))
        .catch(() => null);
      entry = { ...common, status: "unavailable",
        reason: `${metric} declares adjudicated_consensus and its judges disagree ` +
          `(${acquired.disagreement}); ` +
          (attempted?.success === true && attempted.data.status === "unresolved"
            ? `${attempted.data.by} examined it and could not resolve it: ${attempted.data.rationale}`
            : `no resolved adjudication is recorded at ${ADJUDICATION_PATH(metric)}`) };
    }
  } catch (error) {
    // Unavailable with a reason, never a value. A producer output that fails
    // its declared validator has not measured anything, and reporting zero
    // would be a claim about the manuscript rather than about our ability to
    // look at it.
    const reason = error instanceof z.ZodError
      ? `${definition.validator ?? "validator"}: ${error.issues.slice(0, 4).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`
      : `${definition.validator ?? "validator"}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
    entry = { ...common, status: "unavailable", reason };
  }

  return mergeMeasurement(workspaceDir, metric, entry, asOfDate);
}

/** Acquire an external observation from the toolchain report its producer
 * wrote.  The report bytes are the toolchain fingerprint: a later build under
 * a different engine, version, or fallback cannot reuse this observation. */
export async function acquireExternalMetric(
  workspaceDir: string, metric: string, asOfDate = new Date().toISOString(),
): Promise<{ status: MeasurementEntry["status"]; written: string }> {
  const definition = metricDefinition(metricId(metric));
  if (definition.measurement_kind !== "external") {
    throw new Error(`${metric} is a ${definition.measurement_kind} metric; external acquisition is required`);
  }
  const rawPath = definition.raw_output?.[0];
  if (!rawPath) throw new Error(`${metric} declares no toolchain report`);
  let entry: MeasurementEntry;
  try {
    const report = await fs.readFile(path.join(workspaceDir, rawPath), "utf-8");
    const engine = /^- Engine: (.+)$/m.exec(report)?.[1];
    if (!engine) throw new Error(`${rawPath} has no declared toolchain engine`);

    // The report is a producer OUTPUT, so it needs the same provenance as any
    // other: which invocation wrote it, against which inputs. Without the
    // receipt this reduced whatever bytes happened to be on disk — including a
    // report left by a build that predates the repair being judged.
    const freshness = await verifyProducerFreshness(workspaceDir, rawPath);
    if (!freshness.ok) {
      entry = {
        metric: definition.metric, scope_key: "", status: "unavailable",
        tolerance: definition.tolerance, direction: definition.direction,
        evaluator: definition.evaluator,
        evaluator_digest: evaluatorDigest(definition.evaluator, EVALUATOR_VERSION),
        input_digest: await computeInputDigest(workspaceDir, definition, {
          asOfDate, toolchainDigest: digest(report),
        }),
        measurement_kind: "external",
        reason: `${rawPath} ${freshness.reason}`,
      };
      return mergeMeasurement(workspaceDir, metric, entry, asOfDate);
    }

    // A PLACEHOLDER engine has not built the manuscript. Counting it as 1 —
    // which is what `|| engine === "placeholder"` did — let a repair be
    // accepted, and an invariant preserved, on the strength of a PDF nobody
    // could publish. It is not a build failure either: nothing was attempted,
    // so the honest answer is that the metric is unavailable, not that it is
    // zero.
    // Only the PLACEHOLDER engine means "no build was attempted". A real engine
    // reporting no PDF genuinely tried and failed, which is a measured zero —
    // conflating the two would hide every real build failure as unavailable.
    const placeholder = engine === "placeholder";
    const compiled = /^- Real PDF compiled: yes$/m.test(report);
    const inputDigest = await computeInputDigest(workspaceDir, definition, {
      asOfDate, toolchainDigest: digest(report),
    });
    entry = placeholder && !compiled
      ? {
          metric: definition.metric, scope_key: "", status: "unavailable",
          tolerance: definition.tolerance, direction: definition.direction,
          evaluator: definition.evaluator,
          evaluator_digest: evaluatorDigest(definition.evaluator, EVALUATOR_VERSION),
          input_digest: inputDigest, measurement_kind: "external",
          reason: `${engine} produced no real PDF, so the release build was never exercised`,
        }
      : {
          metric: definition.metric, scope_key: "", status: "measured", value: compiled ? 1 : 0,
          tolerance: definition.tolerance, direction: definition.direction,
          evaluator: definition.evaluator,
          evaluator_digest: evaluatorDigest(definition.evaluator, EVALUATOR_VERSION),
          input_digest: inputDigest, measurement_kind: "external",
          reason: compiled ? undefined : `${engine} did not produce a usable PDF`,
        };
  } catch (error) {
    entry = {
      metric: definition.metric, scope_key: "", status: "unavailable",
      tolerance: definition.tolerance, direction: definition.direction,
      evaluator: definition.evaluator,
      evaluator_digest: evaluatorDigest(definition.evaluator, EVALUATOR_VERSION),
      input_digest: digest(`${metric}:external-unavailable:${String(error)}`), measurement_kind: "external",
      reason: error instanceof Error ? error.message.split("\n")[0] : String(error),
    };
  }
  return mergeMeasurement(workspaceDir, metric, entry, asOfDate);
}

async function mergeMeasurement(
  workspaceDir: string, _metric: string, entry: MeasurementEntry, asOfDate: string,
): Promise<{ status: MeasurementEntry["status"]; written: string }> {
  const target = path.join(workspaceDir, MEASUREMENTS_PATH);
  // Only "there is no envelope yet" is an empty envelope. An unreadable or
  // malformed one read as empty DELETES every other metric this round measured
  // — the merge writes back what it read, so a swallowed parse error is a
  // silent data loss dressed as a successful acquisition.
  const raw = await fs.readFile(target, "utf-8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw new Error(
      `cannot read ${MEASUREMENTS_PATH} (${error.code ?? String(error)}); refusing to merge into ` +
      `an envelope that cannot be read, which would discard the metrics already in it`);
  });
  const existing = raw === null
    ? { version: 1 as const, as_of_date: asOfDate, measurements: [] as MeasurementEntry[] }
    : (() => {
        try {
          return MeasurementEnvelopeSchema.parse(JSON.parse(raw));
        } catch (error) {
          throw new Error(
            `${MEASUREMENTS_PATH} is not a valid measurement envelope ` +
            `(${error instanceof Error ? error.message.split("\n")[0] : String(error)}); ` +
            `refusing to overwrite it with one metric and lose the rest`);
        }
      })();
  const merged = MeasurementEnvelopeSchema.parse({
    version: 1,
    as_of_date: asOfDate,
    measurements: [...existing.measurements.filter((row) => String(row.metric) !== _metric), entry],
  });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
  return { status: entry.status, written: MEASUREMENTS_PATH };
}
