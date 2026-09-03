import { z } from "zod";
import {
  ArtifactKindSchema, CapabilityIdSchema, GateClassSchema, GateIdSchema,
  GENERATED_KINDS, MetricIdSchema, OPERATOR_CAPABILITY, OPERATOR_TARGET_KINDS,
  RequiredEffectSchema,
} from "./ids.js";
import { METRIC_REGISTRY } from "./metrics.js";
import { gateFamily, type ArtifactKind, type GateId, type MetricId, type RequiredEffect } from "./ids.js";

export const FindingShape = z.object({
  kind: ArtifactKindSchema,
  effect: RequiredEffectSchema,
  capability: CapabilityIdSchema,
  /** The acceptance metric this finding moves, or `null` when it moves none.
   *
   * Required, never inferred from the gate. A compound gate such as
   * `cited_literature_release_gates` decides on several different metrics, so
   * "the gate's metric" is not a function and acceptance could not be derived
   * from a finding without this. `null` is a statement, not an omission: it
   * says the defect is real and no registered metric tracks it. */
  acceptance_metric: MetricIdSchema.nullable(),
}).strict().superRefine((shape, ctx) => {
  if (shape.acceptance_metric !== null && !METRIC_REGISTRY.has(shape.acceptance_metric)) {
    ctx.addIssue({
      code: "custom", path: ["acceptance_metric"],
      message: `unknown metric ${shape.acceptance_metric}; register it in metrics.ts or declare null`,
    });
  }
  if (GENERATED_KINDS.includes(shape.kind)) {
    ctx.addIssue({
      code: "custom", path: ["kind"],
      message: `${shape.kind} is generated; name the producing surface instead and carry the generated location in \`location\``,
    });
    return;
  }
  // An operator target has no editable path but is still a real finding
  // subject; only an operator capability may own one.
  if (OPERATOR_TARGET_KINDS.includes(shape.kind) && String(shape.capability) !== OPERATOR_CAPABILITY) {
    ctx.addIssue({
      code: "custom", path: ["capability"],
      message: `${shape.kind} has no editable path; only ${OPERATOR_CAPABILITY} may own it`,
    });
  }
});

export const GateDefinition = z.object({
  id: GateIdSchema,
  class: GateClassSchema,
  /** Every finding this gate can legally emit. Legal triples and routes are
   * derived from this list — there is no parallel table to drift from. */
  findings: z.array(FindingShape).default([]),
  /** Metrics this gate measures while deciding. */
  observes: z.array(MetricIdSchema).default([]),
}).strict().superRefine((gate, ctx) => {
  if (gate.class === "manuscript" && gate.findings.length === 0) {
    ctx.addIssue({
      code: "custom", path: ["findings"],
      message: `manuscript gate ${gate.id} must declare at least one finding it can emit`,
    });
  }
  if (gate.class !== "manuscript" && gate.findings.length > 0) {
    ctx.addIssue({
      code: "custom", path: ["findings"],
      message: `${gate.class} gate ${gate.id} must declare no findings; it is not repairable`,
    });
  }
});

export const ProducerDefinition = z.object({
  module: z.string().min(1),
  gates: z.array(GateDefinition).min(1),
}).strict();
export type ProducerDefinition = z.infer<typeof ProducerDefinition>;
export type GateDefinition = z.infer<typeof GateDefinition>;
export type FindingShape = z.infer<typeof FindingShape>;

/** Declared beside the checks that emit these gates, so a reviewer sees the
 * declaration and the code together. */
/** Typed rather than `unknown`, so a producer that omits a required field —
 * `acceptance_metric` above all — is a compile error at its own declaration
 * site rather than a runtime failure at registry construction. */
export function defineProducer(definition: z.input<typeof ProducerDefinition>): ProducerDefinition {
  return ProducerDefinition.parse(definition);
}

/** The acceptance metric a producer declared for one of its triples.
 *
 * Each module looks this up against its OWN producer definition, so no module
 * has to import the registry and no import cycle appears. Throws rather than
 * returning undefined: an emitted triple that was never declared is the defect
 * routing-coverage exists to catch, and guessing here would hide it. */
export function acceptanceMetricOf(
  producer: ProducerDefinition, gate: GateId, kind: ArtifactKind, effect: RequiredEffect,
): MetricId | null {
  const family = gateFamily(gate);
  const declared = producer.gates.find((entry) => entry.id === family);
  if (!declared) throw new Error(`${producer.module} emits gate ${gate} without declaring it`);
  const shape = declared.findings.find((finding) => finding.kind === kind && finding.effect === effect);
  if (!shape) throw new Error(`${producer.module} gate ${gate} never declared (${kind}, ${effect})`);
  return shape.acceptance_metric;
}
