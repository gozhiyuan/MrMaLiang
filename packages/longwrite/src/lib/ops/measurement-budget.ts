import { metricDefinition } from "../registry/metrics.js";
import type { MetricId } from "../registry/ids.js";

export type RoundCost = { model_calls: number; renders: number };

/** What a metric actually costs to take.
 *
 * The producer's declared calls PLUS the adjudication call its reducer may
 * perform. An `adjudicated_consensus` metric is not measured until a material
 * disagreement between its judges has been resolved, and pricing only the
 * judges would under-budget it by exactly one call.
 *
 * Priced unconditionally even though the adjudication stage is guarded, because
 * a budget check that assumed the judges would agree would admit a round it
 * could not finish paying for. The reducer is now what it claims: only
 * `review_score` declares one, and only `review_score` has an adjudication
 * stage — the two metrics that declared it while reducing a single judgment
 * were charged for a call nothing ever made. */
function costOf(metric: MetricId): RoundCost {
  // Throws on an unregistered metric. An unpriced metric must fail loudly
  // rather than being treated as free — free is how a budget check passes and
  // the round then runs out of quota mid-measurement.
  const definition = metricDefinition(metric);
  const adjudication = definition.reducer === "adjudicated_consensus" ? 1 : 0;
  return {
    model_calls: definition.estimated_cost.model_calls > 0
      ? definition.estimated_cost.model_calls + adjudication
      : 0,
    renders: definition.estimated_cost.render_required ? 1 : 0,
  };
}

export function projectedRoundCost(metrics: MetricId[]): RoundCost {
  return metrics.reduce<RoundCost>((total, metric) => {
    const cost = costOf(metric);
    return { model_calls: total.model_calls + cost.model_calls, renders: total.renders + cost.renders };
  }, { model_calls: 0, renders: 0 });
}

export function affordable(projected: RoundCost, remaining: RoundCost): boolean {
  return projected.model_calls <= remaining.model_calls && projected.renders <= remaining.renders;
}

/** Schedule what fits, defer what does not — cheapest first.
 *
 * Deferring is not skipping: a deferred metric is recorded as `deferred` in the
 * envelope, so the objective it belongs to reports `pending_verification`
 * rather than being judged on a value nobody took. Ordering cheapest first
 * means a tight budget still yields every deterministic signal instead of
 * spending the whole allowance on one persona review. */
export function planRoundMeasurements(
  invalidated: MetricId[], remaining: RoundCost,
): { scheduled: MetricId[]; deferred: MetricId[] } {
  const priced = invalidated
    .map((metric) => ({ metric, cost: costOf(metric) }))
    .sort((a, b) =>
      (a.cost.model_calls + a.cost.renders) - (b.cost.model_calls + b.cost.renders)
      || String(a.metric).localeCompare(String(b.metric)));

  const scheduled: MetricId[] = [];
  const deferred: MetricId[] = [];
  let spent: RoundCost = { model_calls: 0, renders: 0 };
  for (const { metric, cost } of priced) {
    const next = { model_calls: spent.model_calls + cost.model_calls, renders: spent.renders + cost.renders };
    if (affordable(next, remaining)) {
      scheduled.push(metric);
      spent = next;
      continue;
    }
    deferred.push(metric);
  }
  return { scheduled, deferred };
}
