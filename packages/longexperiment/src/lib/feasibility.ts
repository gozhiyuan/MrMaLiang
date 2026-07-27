import { z } from "zod";
import { ExperimentIntent } from "@mr-maliang/research-protocol";

export const FeasibilityAssessment = z.object({
  version: z.literal(1),
  intent_id: z.string().min(1),
  feasible: z.boolean(),
  reasons: z.array(z.string().min(1)),
  estimated: z.object({ api_calls: z.number().int().nonnegative(), gpu_hours: z.number().nonnegative(), wall_minutes: z.number().nonnegative() }).strict(),
}).strict();
export type FeasibilityAssessment = z.infer<typeof FeasibilityAssessment>;

export type FeasibilityContext = {
  reliableVerifier: boolean;
  inputsAvailable: boolean;
  lease: { api_calls?: number; gpu_hours?: number; wall_minutes?: number } | null;
  conditions: number;
  usefulToPaper: boolean;
};

/** Reject a proposed study before it can become a runnable experiment. */
export function assessFeasibility(intentInput: unknown, context: FeasibilityContext): FeasibilityAssessment {
  const intent = ExperimentIntent.parse(intentInput);
  const estimated = {
    api_calls: intent.maximum_budget.api_calls ?? 0,
    gpu_hours: intent.maximum_budget.gpu_hours ?? 0,
    wall_minutes: intent.maximum_budget.wall_minutes ?? 0,
  };
  const reasons: string[] = [];
  if (!context.reliableVerifier) reasons.push("no reliable verifier is available");
  if (!context.inputsAvailable) reasons.push("required model or data input is unavailable");
  if (!context.usefulToPaper) reasons.push("the requested result is not useful to the paper claim");
  if (!Number.isInteger(context.conditions) || context.conditions < 1 || context.conditions > 20) reasons.push("conditions must be bounded between 1 and 20");
  if (context.lease) {
    for (const key of ["api_calls", "gpu_hours", "wall_minutes"] as const) {
      if (context.lease[key] !== undefined && estimated[key] > context.lease[key]!) reasons.push(`estimated ${key} exceeds the authorized lease`);
    }
  } else if (estimated.api_calls > 0 || estimated.gpu_hours > 0 || estimated.wall_minutes > 0) {
    reasons.push("a bounded lease is required for requested compute or API spend");
  }
  return FeasibilityAssessment.parse({ version: 1, intent_id: intent.id, feasible: reasons.length === 0, reasons, estimated });
}
