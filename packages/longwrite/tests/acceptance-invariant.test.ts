import { describe, expect, it } from "vitest";
import { PRODUCERS } from "../src/lib/registry/producers.js";
import { VERIFIERS } from "../src/lib/registry/verifiers.js";
import { METRIC_REGISTRY } from "../src/lib/registry/metrics.js";
import { templateFor } from "../src/lib/registry/capabilities.js";

function canAffectDependency(owns: readonly string[], dependencies: readonly string[]): boolean {
  const prefix = (value: string) => value.replace(/\*.*$/, "");
  return owns.some((write) => dependencies.some((dependency) => {
    const a = prefix(write);
    const b = prefix(dependency);
    return a.startsWith(b) || b.startsWith(a);
  }));
}

describe("finding acceptance invariant", () => {
  it("judges every finding by an exact verifier or a metric its capability can remeasure", () => {
    for (const producer of PRODUCERS) {
      for (const gate of producer.gates) {
        for (const finding of gate.findings) {
          const metric = finding.acceptance_metric;
          if (metric === null) {
            expect(VERIFIERS, `${gate.id} must have an exact post-effect verifier`).toHaveProperty(String(gate.id));
            continue;
          }
          expect(METRIC_REGISTRY.has(metric), `${gate.id} names a registered acceptance metric`).toBe(true);
          const capability = templateFor(String(finding.capability));
          // Operator escalation is not a repair capability: it intentionally
          // cannot claim to change an external toolchain. The kernel records
          // the objective as blocked until the operator supplies that effect.
          if (String(finding.capability) === "request_operator_clarification") continue;
          const definition = METRIC_REGISTRY.get(metric)!;
          const requiredProducer = definition.measurement_kind === "model"
            ? `acquire_${metric}`
            : `measure_${definition.measurement_tier}_metrics`;
          expect(
            capability.evaluate_with,
            `${gate.id}/${finding.effect} assigns ${metric} to ${finding.capability}, but ` +
              `its post-effect topology omits ${requiredProducer}`,
          ).toContain(requiredProducer);
        }
      }
    }
  });

  it("does not route a metric to a capability that owns none of its dependencies", () => {
    for (const producer of PRODUCERS) {
      for (const gate of producer.gates) {
        for (const finding of gate.findings) {
          if (finding.acceptance_metric === null || String(finding.capability) === "request_operator_clarification") continue;
          const definition = METRIC_REGISTRY.get(finding.acceptance_metric)!;
          const capability = templateFor(String(finding.capability));
          expect(
            canAffectDependency(capability.owns, definition.dependencies),
            `${gate.id}/${finding.effect} cannot move ${finding.acceptance_metric}: ` +
              `${finding.capability} owns none of [${definition.dependencies.join(", ")}]`,
          ).toBe(true);
        }
      }
    }
  });
});
