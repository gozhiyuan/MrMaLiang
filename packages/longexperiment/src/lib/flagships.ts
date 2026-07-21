import type { ExperimentConfig } from "./schema.js";

/** Flagship IDs are declarative packs. Their configs may pin different source
 * revisions, but all compile through the same suite/study/runner modules. */
export const FLAGSHIP_IDS = ["self_play_small_model", "nanogpt_ablation", "proteingym_autoscientists"] as const;
export type FlagshipId = typeof FLAGSHIP_IDS[number];

/** This is deliberately stricter than a runner's self-report. The caller has
 * already validated every trial, source pin, artifact, and comparison; this
 * final predicate is small so the release policy is easy to audit. */
export function publicationEligible(
  config: ExperimentConfig,
  evidence: { status: "completed"; trialCount: number; comparisons: Array<{ paired_seeds?: number[] }>; verifiedArtifacts: number; requiredSeeds: number },
): boolean {
  if (!config.evaluation || evidence.status !== "completed") return false;
  const uniqueSeeds = new Set(config.evaluation.seeds);
  const minimumTrials = uniqueSeeds.size * 2; // baseline plus at least one treatment
  const comparisonSupportsAllSeeds = evidence.comparisons.some((comparison) =>
    new Set(comparison.paired_seeds ?? []).size >= uniqueSeeds.size,
  );
  return evidence.trialCount >= minimumTrials
    && evidence.trialCount <= config.execution.max_trials * Math.max(1, config.suite?.studies.length ?? 1)
    && comparisonSupportsAllSeeds
    && evidence.verifiedArtifacts > 0;
}
