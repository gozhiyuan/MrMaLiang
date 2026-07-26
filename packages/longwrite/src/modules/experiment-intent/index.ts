/**
 * Experiment intent module (LE-7.1).
 *
 * LongWrite may request bounded empirical evidence, but it never schedules or
 * certifies an experiment. LongExperiment owns feasibility, authorization,
 * execution, and audited result handoff.
 */
export { ExperimentIntent } from "@mr-maliang/research-protocol";
export type { ExperimentIntentType } from "@mr-maliang/research-protocol";

export const EXPERIMENT_INTENT_ARTIFACT = "experiments/intent.json";
