export type PromotionContext = {
  direction: "maximize" | "minimize";
  incumbentMetric: number;
  candidateMetric?: number;
  candidateConfidence?: { lower: number; upper: number };
  incumbentComplexity?: number;
  candidateComplexity?: number;
  constraintsPassed: boolean;
  crashed?: boolean;
  minimumImprovement?: number;
};
export type PromotionDecision = { decision: "promote" | "discard" | "crash"; reason: string };

/** One deterministic writer decides promotion; agents only supply audited data. */
export function decidePromotion(context: PromotionContext): PromotionDecision {
  if (context.crashed) return { decision: "crash", reason: "candidate execution crashed" };
  if (!context.constraintsPassed) return { decision: "discard", reason: "candidate regressed a required constraint" };
  if (context.candidateMetric === undefined) return { decision: "discard", reason: "candidate has no audited primary metric" };
  const delta = context.direction === "maximize"
    ? context.candidateMetric - context.incumbentMetric
    : context.incumbentMetric - context.candidateMetric;
  const threshold = context.minimumImprovement ?? 0;
  if (delta < threshold) return { decision: "discard", reason: `improvement ${delta} is below required ${threshold}` };
  // If a confidence interval is supplied, it must not cross zero in the
  // improvement direction. This prevents promotion on measured noise.
  if (context.candidateConfidence) {
    const bound = context.direction === "maximize" ? context.candidateConfidence.lower : -context.candidateConfidence.upper;
    if (bound <= 0) return { decision: "discard", reason: "candidate improvement is not confirmed outside measured noise" };
  }
  if (delta === 0 && (context.candidateComplexity ?? Infinity) >= (context.incumbentComplexity ?? Infinity)) {
    return { decision: "discard", reason: "tie does not improve complexity" };
  }
  return { decision: "promote", reason: `audited ${context.direction} improvement of ${delta}` };
}
