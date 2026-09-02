import { z } from "zod";
import {
  ArtifactKindSchema, CapabilityIdSchema, GateClassSchema, GateIdSchema,
  GENERATED_KINDS, MetricIdSchema, OPERATOR_CAPABILITY, OPERATOR_TARGET_KINDS,
  RequiredEffectSchema,
} from "./ids.js";

export const FindingShape = z.object({
  kind: ArtifactKindSchema,
  effect: RequiredEffectSchema,
  capability: CapabilityIdSchema,
}).strict().superRefine((shape, ctx) => {
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
export function defineProducer(definition: unknown): ProducerDefinition {
  return ProducerDefinition.parse(definition);
}
