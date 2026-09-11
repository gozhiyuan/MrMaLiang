import { metricDefinition } from "./metrics.js";
import { VERIFIERS } from "./verifiers.js";
import type { GateId, MetricId } from "./ids.js";

/** The single place a metric registry entry plus a configured target becomes a
 * wire-contract criterion. Tolerance and direction are resolved here so the
 * kernel needs no metric registry (wire contract §5). */
export function compileCriterion(
  metric: MetricId, scopeKey: string,
  operator: "at_least" | "at_most" | "equals", target: number,
) {
  const definition = metricDefinition(metric);
  if (definition.direction === "maximize" && operator === "at_most") {
    throw new Error(`${metric} is maximize; at_most would cap an objective it should raise`);
  }
  if (definition.direction === "minimize" && operator === "at_least") {
    throw new Error(`${metric} is minimize; at_least would demand more of a defect count`);
  }
  return {
    // Explicit: a discriminated union reads the discriminant before applying
    // any member default, so a criterion omitting `kind` matches no arm and is
    // rejected at IR parse.
    kind: "metric" as const,
    metric: String(metric), scope_key: scopeKey, operator, target,
    tolerance: definition.tolerance, direction: definition.direction,
  };
}

/** The other arm. A finding whose `acceptance_metric` is `null` names no
 * number, so its objective is that the gate which emitted it passes again. */
export function compileVerificationCriterion(gate: GateId, scopeKey: string) {
  if (typeof VERIFIERS[String(gate)] !== "function") {
    throw new Error(
      `${gate} has no registered verifier, so a criterion naming it could never be satisfied; ` +
      `register one or give the finding an acceptance metric`);
  }
  // No digest: the bytes this must be checked against do not exist until the
  // repair has run, so freshness is bound by the kernel's post-effect request
  // rather than by anything fixed here.
  return {
    kind: "verification" as const,
    verification_id: String(gate),
    scope_key: scopeKey,
    expect_pass: true,
  };
}
