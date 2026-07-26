import { z } from "zod";

/** A claim is tied to an exact paper anchor before any reproduction compute. */
export const ReproductionClaim = z.object({
  id: z.string().min(1),
  statement: z.string().min(20),
  anchor: z.object({
    section: z.string().min(1).optional(),
    page: z.number().int().positive().optional(),
    figure: z.string().min(1).optional(),
    table: z.string().min(1).optional(),
    equation: z.string().min(1).optional(),
    quote: z.string().min(10),
  }).strict(),
  claim_type: z.enum([
    "quantitative", "ordering", "ablation", "mechanism",
    "scaling", "structural", "theoretical",
  ]),
  metric: z.string().min(1).optional(),
  reported_value: z.number().finite().optional(),
  tolerance: z.number().nonnegative().optional(),
  required_artifacts: z.array(z.string().min(1)).default([]),
  feasibility: z.enum(["exact", "reduced_scale", "mechanism_only", "blocked", "unknown"]),
  feasibility_reason: z.string().min(1),
}).strict();
export type ReproductionClaim = z.infer<typeof ReproductionClaim>;

/** A verdict records what was actually tested, including a precise blockage. */
export const ReproductionVerdict = z.object({
  claim_id: z.string().min(1),
  verdict: z.enum([
    "exact_reproduction",
    "reduced_scale_reproduction",
    "mechanism_reproduction",
    "partially_aligned",
    "inconclusive",
    "blocked_missing_artifacts",
    "not_attempted",
  ]),
  trial_ids: z.array(z.string().min(1)).default([]),
  observed_values: z.record(z.number().finite()).default({}),
  deviations: z.array(z.string().min(1)).default([]),
  evidence_artifacts: z.array(z.string().min(1)).default([]),
  rationale: z.string().min(1),
}).strict();
export type ReproductionVerdict = z.infer<typeof ReproductionVerdict>;
