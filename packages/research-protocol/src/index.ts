import { z } from "zod";

/** A completed condition/seed record is the smallest empirical unit LongWrite
 * may use when supporting a quantitative claim. */
export const TrialRecord = z.object({
  id: z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  seed: z.number().int().nonnegative(),
  condition: z.string().min(1),
  status: z.literal("completed"),
  metrics: z.record(z.number().finite()).refine((metrics) => Object.keys(metrics).length > 0, "trial must include at least one metric"),
  artifacts: z.array(z.string().min(1)).default([]),
}).strict();
export type TrialRecord = z.infer<typeof TrialRecord>;

export const ExperimentComparison = z.object({
  id: z.string().min(1),
  metric: z.string().min(1),
  baseline_condition: z.string().min(1),
  treatment_condition: z.string().min(1),
  estimate: z.number().finite(),
  confidence_interval: z.object({
    level: z.number().gt(0).lte(1),
    lower: z.number().finite(),
    upper: z.number().finite(),
  }).strict(),
  method: z.string().min(1),
  paired_seeds: z.array(z.number().int().nonnegative()).min(2),
}).strict();
export type ExperimentComparison = z.infer<typeof ExperimentComparison>;

/** Immutable hand-off from an experiment engine to a writing engine. */
export const ExperimentManifest = z.object({
  version: z.literal(1),
  project_id: z.string().min(1),
  hypothesis: z.string().min(1),
  status: z.enum(["completed", "failed", "inconclusive"]),
  best_run_id: z.string().min(1).optional(),
  trial_count: z.number().int().nonnegative().default(0),
  statistical_test: z.string().min(1).optional(),
  metrics: z.record(z.number().finite()),
  trials: z.array(TrialRecord).default([]),
  comparisons: z.array(ExperimentComparison).default([]),
  artifacts: z.object({
    results_json: z.string().min(1),
    tables: z.array(z.string()).default([]),
    figures: z.array(z.string()).default([]),
    logs: z.array(z.string()).default([]),
  }).strict(),
  provenance: z.object({
    runner_kind: z.enum(["command", "autoscientists", "modal"]),
    runner_version: z.string().optional(),
    source_revision: z.string().optional(),
    input_revisions: z.record(z.string().min(1)),
    input_locks_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    result_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    environment: z.record(z.string().min(1)).default({}),
    generated_at: z.string().datetime(),
  }).strict(),
  publication_eligible: z.boolean().default(false),
}).strict();
export type ExperimentManifest = z.infer<typeof ExperimentManifest>;

/** LongWrite accepts this stricter view only after an empirical run has been
 * completed and LongExperiment has certified the complete contract. */
export const PublicationExperimentManifest = ExperimentManifest.extend({
  status: z.literal("completed"),
  trial_count: z.number().int().positive(),
  statistical_test: z.string().min(1),
  metrics: z.record(z.number().finite()).refine((metrics) => Object.keys(metrics).length > 0),
  trials: z.array(TrialRecord).min(1),
  comparisons: z.array(ExperimentComparison).min(1),
  publication_eligible: z.literal(true),
});
export type PublicationExperimentManifest = z.infer<typeof PublicationExperimentManifest>;

/** Bounded empirical context injected into outline, drafting, artifact
 * planning, and review. It intentionally excludes arbitrary runner logs. */
export const ExperimentEvidencePacket = z.object({
  version: z.literal(1),
  manifest_path: z.string().min(1),
  manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  hypothesis: z.string().min(1),
  trial_count: z.number().int().positive(),
  statistical_test: z.string().min(1),
  metrics: z.record(z.number().finite()).refine((metrics) => Object.keys(metrics).length > 0),
  codebase_binding: z.object({ pass: z.literal(true), finding: z.string().min(1) }).strict(),
  provenance: ExperimentManifest.shape.provenance,
  comparisons: z.array(ExperimentComparison.extend({ claim: z.string().min(1) })).min(1),
  artifacts: z.array(z.object({
    id: z.string().min(1),
    kind: z.enum(["figure", "table"]),
    source_path: z.string().min(1),
    imported_path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).default([]),
}).strict();
export type ExperimentEvidencePacket = z.infer<typeof ExperimentEvidencePacket>;
