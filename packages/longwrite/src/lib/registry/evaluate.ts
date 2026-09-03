import fs from "node:fs/promises";
import path from "node:path";
import { loadProjectConfigIfExists } from "../project-config.js";
import { EVALUATOR_VERSION, MeasurementUnavailable, SCRIPT_EVALUATORS } from "./evaluators/index.js";
import { computeInputDigest, evaluatorDigest } from "./digests.js";
import type { MetricId } from "./ids.js";
import { METRIC_REGISTRY, metricDefinition, type MetricDefinition } from "./metrics.js";
import { MeasurementEnvelopeSchema, type MeasurementEntry, type MeasurementEnvelope } from "./records.js";

/** Stand-ins for inputs that do not exist yet.
 *
 * A model or external metric is reported `deferred` here: no judgment has been
 * taken and no toolchain has run, so there is no real prompt or toolchain to
 * digest. The acquisition stage supplies the actual one and gets a different
 * identity, which is exactly what must happen — a deferred entry must never be
 * reusable as a measurement.
 *
 * They are distinct constants so a deferred model entry and a deferred
 * external entry never collide either. */
const DEFERRED_PROMPT = "0".repeat(64);
const DEFERRED_TOOLCHAIN = "1".repeat(64);

export type EvaluateOptions = {
  metrics?: MetricId[];
  tier?: MetricDefinition["measurement_tier"];
  asOfDate: string;
  modelConfig?: Record<string, unknown>;
  /** Digest of the instructions a model measurement is taken under. Holding
   * the model fixed while rewriting the prompt must not reuse the earlier
   * judgment, so the prompt is part of the measurement's identity. */
  promptDigest?: string;
  /** Toolchain and configuration an external measurement ran under. */
  toolchainDigest?: string;
  /** Test-only: proves the missing-evaluator path reports unavailable rather
   * than deferred, which would hide the gap behind a legitimate-looking
   * status. */
  forceMissingEvaluator?: boolean;
};

/** Where a target comes from. The registry knows a metric's direction and
 * tolerance; only the workspace knows what this project promised, so the
 * threshold is read from config and never invented here. */
type Targets = { target?: number; operator?: MeasurementEntry["operator"] };

async function configuredTargets(workspaceDir: string): Promise<Map<string, Targets>> {
  const config = await loadProjectConfigIfExists(workspaceDir);
  if (!config) return new Map();
  const corpus = config.research.corpus_gates;
  const release = config.research.release_gates;
  return new Map<string, Targets>([
    ["candidate_count", { target: corpus.min_candidates, operator: "at_least" }],
    ["core_sources", { target: corpus.min_core_sources, operator: "at_least" }],
    ["recent_source_ratio", { target: corpus.min_recent_ratio, operator: "at_least" }],
    ["source_type_diversity_count", { target: corpus.min_source_type_diversity, operator: "at_least" }],
    ["taxonomy_cell_ab_sources", { target: corpus.min_sources_per_taxonomy_cell, operator: "at_least" }],
    ["landmark_coverage_ratio", { target: corpus.min_landmark_coverage_ratio, operator: "at_least" }],
    ["landmark_citation_coverage_ratio", { target: corpus.min_landmark_citation_coverage_ratio, operator: "at_least" }],
    ["cited_sources", { target: release.min_cited_sources, operator: "at_least" }],
    ["citations_per_page", { target: release.min_citations_per_page, operator: "at_least" }],
    ["cited_within_one_year_ratio", { target: release.min_cited_within_one_year_ratio, operator: "at_least" }],
    ["accepted_cited_ratio", { target: release.min_accepted_cited_ratio, operator: "at_least" }],
    ["cited_arxiv_only_ratio", { target: release.max_cited_arxiv_only_ratio, operator: "at_most" }],
  ]);
}

function select(options: EvaluateOptions): MetricDefinition[] {
  if (options.metrics) return options.metrics.map(metricDefinition);
  const all = [...METRIC_REGISTRY.values()];
  return options.tier ? all.filter((definition) => definition.measurement_tier === options.tier) : all;
}

/** Emits measurement entries. It does NOT store them, sequence them, or decide
 * whether an earlier one may be reused — the kernel owns all three, and this
 * side would have to guess at ordering it cannot see. */
export async function buildEnvelope(
  workspaceDir: string, options: EvaluateOptions,
): Promise<MeasurementEnvelope> {
  const targets = await configuredTargets(workspaceDir);
  const measurements: MeasurementEntry[] = [];

  for (const definition of select(options)) {
    const name = String(definition.metric);
    const common = {
      metric: definition.metric,
      target: targets.get(name)?.target,
      operator: targets.get(name)?.operator,
      tolerance: definition.tolerance,
      direction: definition.direction,
      evaluator: definition.evaluator,
      evaluator_digest: evaluatorDigest(definition.evaluator, EVALUATOR_VERSION),
      input_digest: await computeInputDigest(workspaceDir, definition, {
        asOfDate: options.asOfDate, model: options.modelConfig,
        // Supplied per kind. computeInputDigest demands a prompt for a model
        // measurement and a toolchain fingerprint for an external one, and
        // handing it the wrong stand-in threw before the entry could be
        // marked deferred at all.
        promptDigest: options.promptDigest ?? DEFERRED_PROMPT,
        toolchainDigest: options.toolchainDigest ?? DEFERRED_TOOLCHAIN,
      }),
      measurement_kind: definition.measurement_kind,
    };

    // A model or external value is produced by its own measurement unit, so it
    // is deferred here rather than reported as missing.
    if (definition.measurement_kind !== "script") {
      measurements.push({ ...common, scope_key: "", status: "deferred" });
      continue;
    }

    const evaluator = options.forceMissingEvaluator ? undefined : SCRIPT_EVALUATORS[name];
    if (typeof evaluator !== "function") {
      // Deliberately not deferred: deferred claims another unit will supply
      // the value, which is false for a script metric with no evaluator and
      // would hide the gap behind a legitimate-looking status.
      measurements.push({ ...common, scope_key: "", status: "unavailable",
        reason: `no evaluator is registered for the script metric ${name}` });
      continue;
    }

    try {
      const scoped = await evaluator({ workspaceDir, asOfDate: options.asOfDate });
      for (const { scope_key, value } of scoped) {
        measurements.push({ ...common, scope_key, status: "measured", value });
      }
    } catch (error) {
      if (!(error instanceof MeasurementUnavailable)) throw error;
      measurements.push({ ...common, scope_key: "", status: "unavailable", reason: error.reason });
    }
  }

  return MeasurementEnvelopeSchema.parse({
    version: 1, as_of_date: options.asOfDate, measurements,
  });
}

export const MEASUREMENTS_PATH = path.join("reports", "measurements.json");

export async function writeEnvelope(
  workspaceDir: string, envelope: MeasurementEnvelope,
): Promise<string> {
  const target = path.join(workspaceDir, MEASUREMENTS_PATH);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(envelope, null, 2)}\n`, "utf-8");
  return MEASUREMENTS_PATH;
}
