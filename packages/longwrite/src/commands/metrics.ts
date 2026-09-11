import path from "node:path";
import { writeWordMetrics } from "../lib/ops/word-metrics.js";
import { metricId } from "../lib/registry/ids.js";
import { metricDefinition } from "../lib/registry/metrics.js";

export async function runMetricsWords(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const metrics = await writeWordMetrics(resolved);
  console.log(`# Word Metrics`);
  console.log(`Workspace: ${resolved}`);
  console.log(`Total words: ${metrics.totalWords}`);
  if (metrics.targetWords) {
    console.log(`Target words: ${metrics.targetWords}`);
    console.log(`Progress: ${Math.round((metrics.percentOfTarget ?? 0) * 100)}%`);
  }
  console.log(`Status: ${metrics.status}`);
  console.log(`Wrote reports/word-metrics.json and reports/word-metrics.md`);
}

/** Measures what can be measured and writes the envelope the engine ingests.
 *
 * It reports rather than enforces: an unavailable input becomes an entry with
 * a reason, not a non-zero exit, because deciding what an absent measurement
 * means is the kernel's job and not this command's. */
export async function runMetricsEvaluate(
  workspaceDir: string,
  options: { tier?: string; asOf?: string } = {},
): Promise<void> {
  const { buildEnvelope, writeEnvelope } = await import("../lib/registry/evaluate.js");
  const tiers = ["unit", "round", "release"] as const;
  if (options.tier !== undefined && !tiers.includes(options.tier as (typeof tiers)[number])) {
    throw new Error(`unknown tier "${options.tier}"; expected one of ${tiers.join(", ")}`);
  }
  const envelope = await buildEnvelope(path.resolve(workspaceDir), {
    tier: options.tier as (typeof tiers)[number] | undefined,
    asOfDate: options.asOf ?? new Date().toISOString(),
  });
  const written = await writeEnvelope(path.resolve(workspaceDir), envelope);
  const counts = envelope.measurements.reduce<Record<string, number>>((totals, entry) => {
    totals[entry.status] = (totals[entry.status] ?? 0) + 1;
    return totals;
  }, {});
  const summary = Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(", ");
  process.stdout.write(`${written}: ${envelope.measurements.length} entries (${summary})\n`);
}

/** Acquires one model or external metric from its declared producer.
 *
 * Separate from `evaluate` because they are different acts: evaluation runs
 * deterministic evaluators, acquisition reduces a model's judgment. Routing a
 * model metric through `evaluate` defers it forever. */
export async function runMetricsAcquire(
  workspaceDir: string, options: { metric?: string; asOf?: string } = {},
): Promise<void> {
  if (!options.metric) throw new Error("metrics acquire requires --metric <id>");
  const { acquireModelMetric, acquireExternalMetric } = await import("../lib/registry/acquire.js");
  const resolved = path.resolve(workspaceDir);
  const definition = metricDefinition(metricId(options.metric));
  const { status, written } = definition.measurement_kind === "model"
    ? await acquireModelMetric(resolved, options.metric, options.asOf ?? new Date().toISOString())
    : await acquireExternalMetric(resolved, options.metric, options.asOf ?? new Date().toISOString());
  process.stdout.write(`${written}: ${options.metric} ${status}\n`);
}
