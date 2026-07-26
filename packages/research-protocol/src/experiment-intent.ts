import { z } from "zod";

/**
 * A bounded request for new experimental evidence.  This is intentionally an
 * input contract, not a result: a planner may propose one, but deterministic
 * LongExperiment stages still validate feasibility, cost, and authorization.
 */
export const ExperimentIntent = z.object({
  version: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  research_question: z.string().min(20),
  hypothesis: z.string().min(20),
  evidence_role: z.enum([
    "survey_validation",
    "original_empirical_claim",
    "mechanism_reproduction",
    "repository_optimization",
    "paper_claim_reproduction",
  ]),
  study_kind: z.enum([
    "api_evaluation",
    "simulation",
    "model_training",
    "repository_optimization",
    "benchmark_reproduction",
  ]),
  rationale: z.string().min(40),
  literature_source_ids: z.array(z.string()).default([]),
  factors: z.array(z.object({
    name: z.string().min(1),
    values: z.array(z.union([z.string(), z.number().finite(), z.boolean()])).min(1),
  }).strict()).default([]),
  metrics: z.object({
    primary: z.string().min(1),
    direction: z.enum(["maximize", "minimize"]),
    derived: z.array(z.string()).default([]),
  }).strict(),
  replication: z.object({
    seeds: z.array(z.number().int().nonnegative()).min(1),
    minimum_repeats: z.number().int().positive().default(1),
  }).strict(),
  expected_artifacts: z.array(z.string().min(1)).default([]),
  maximum_budget: z.object({
    api_calls: z.number().int().positive().optional(),
    gpu_hours: z.number().positive().optional(),
    wall_minutes: z.number().positive().optional(),
  }).strict(),
  limitations: z.array(z.string().min(1)).default([]),
}).strict();
export type ExperimentIntent = z.infer<typeof ExperimentIntent>;
