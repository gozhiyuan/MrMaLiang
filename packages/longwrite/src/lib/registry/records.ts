import { z } from "zod";
import {
  ArtifactKindSchema, EDITABLE_KIND_PATHS, GateIdSchema, MetricIdSchema,
  OPERATOR_TARGET_KINDS, RequiredEffectSchema,
  type ArtifactKind, type GateId, type RequiredEffect,
} from "./ids.js";

// Deliberately NO import of ./producers.js. The migrated validation modules
// import FindingSchema, producers.ts imports those modules, and records.ts
// importing producers.ts would close the cycle
// records -> producers -> validation -> records.
// Registry-dependent checks live in validateFindingAgainstRegistry below, which
// takes the registry as an argument rather than reaching for it.

function pathMatchesKind(kind: ArtifactKind, filePath: string): boolean {
  const prefixes = EDITABLE_KIND_PATHS[kind];
  if (prefixes.length === 0) return false;
  return prefixes.some((prefix) => prefix.endsWith("/") ? filePath.startsWith(prefix) : filePath === prefix);
}

/** An editable artifact names a workspace path. An operator target names a
 * thing with no editable path at all — a missing compiler, an absent experiment
 * manifest. Forcing both through path validation is why an operator finding
 * could not be represented: every kind with an empty path list was rejected. */
const EditableArtifact = z.object({
  kind: ArtifactKindSchema.refine((kind) => !OPERATOR_TARGET_KINDS.includes(kind),
    { message: "operator targets use the target form, not a path" }),
  path: z.string().min(1),
  artifact_id: z.string().min(1).optional(),
}).strict();

const OperatorTargetRef = z.object({
  kind: ArtifactKindSchema.refine((kind) => OPERATOR_TARGET_KINDS.includes(kind),
    { message: "only an operator-target kind uses the target form" }),
  /** What the operator must act on: a tool name, a manifest identifier. Never
   * a workspace path, because nothing here can edit one. */
  target: z.string().min(1).max(200),
}).strict();

export const FindingSchema = z.object({
  id: z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  gate_id: GateIdSchema,
  artifact: z.union([EditableArtifact, OperatorTargetRef]),
  /** Where the defect shows, including a generated location such as a TeX
   * line. A generated-artifact defect uses this field, because the artifact
   * itself must name the producing surface. */
  location: z.string().min(1).max(400).optional(),
  /** The scope of the OBJECTIVE this finding belongs to — never inferred from
   * the artifact path. Required, so a producer cannot omit it and leave the
   * objective ambiguous. `GLOBAL_SCOPE` for a workspace-wide objective. */
  objective_scope_key: z.string(),
  required_effect: RequiredEffectSchema,
  /** The acceptance metric this finding moves, copied from the producer's own
   * declaration. Required, never inferred from the gate: a compound gate
   * decides on several metrics, so acceptance cannot be derived from the gate
   * alone. `null` says no registered metric tracks this defect. */
  acceptance_metric: MetricIdSchema.nullable(),
  severity: z.enum(["minor", "major", "critical"]),
  /** For operators. Never parsed, never routed on. */
  diagnostic: z.string().min(1).max(8_000),
}).strict().superRefine((finding, ctx) => {
  // Shape-level only. Registry agreement is checked at the boundary, in
  // validateFindingAgainstRegistry, so this schema stays importable by the
  // producers it describes.
  if (!("path" in finding.artifact)) return;   // an operator target has no path to check
  if (!pathMatchesKind(finding.artifact.kind, finding.artifact.path)) {
    ctx.addIssue({ code: "custom", path: ["artifact", "path"],
      message: `${finding.artifact.path} is not an editable ${finding.artifact.kind}; name the producing surface and put the generated location in \`location\`` });
  }
});
export type Finding = z.infer<typeof FindingSchema>;

/** Wire contract §3: a model measurement is trusted because its acquisition,
 * validation and reduction are recorded — not because it is deterministic. */
export const ModelJudgmentSchema = z.object({
  reasons: z.array(z.string().min(1)).max(50),
  confidence: z.number().min(0).max(1),
  rubric_version: z.string().min(1),
  evidence_refs: z.array(z.string().min(1)).max(200),
  adjudicated: z.boolean(),
  disagreement: z.enum(["none", "within_tolerance", "material", "unresolved"]),
}).strict();

export const MeasurementEntrySchema = z.object({
  metric: MetricIdSchema,
  scope_key: z.string().default(""),
  status: z.enum(["measured", "unavailable", "deferred"]),
  value: z.number().finite().optional(),
  target: z.number().finite().optional(),
  operator: z.enum(["at_least", "at_most", "equals"]).optional(),
  tolerance: z.number().nonnegative().optional(),
  direction: z.enum(["maximize", "minimize"]).optional(),
  evaluator: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/),
  evaluator_digest: z.string().regex(/^[0-9a-f]{64}$/),
  input_digest: z.string().regex(/^[0-9a-f]{64}$/),
  measurement_kind: z.enum(["script", "model", "external"]),
  judgment: ModelJudgmentSchema.optional(),
  reason: z.string().min(1).max(2_000).optional(),
}).strict().superRefine((entry, ctx) => {
  if (entry.status === "measured" && entry.value === undefined) {
    ctx.addIssue({ code: "custom", path: ["value"], message: "a measured entry must carry a value" });
  }
  if (entry.status !== "measured" && entry.value !== undefined) {
    ctx.addIssue({ code: "custom", path: ["value"], message: "only a measured entry may carry a value" });
  }
  // An unavailable input is a failure the operator must be able to act on, so
  // it names what was missing rather than reporting a bare absence.
  if (entry.status === "unavailable" && !entry.reason) {
    ctx.addIssue({ code: "custom", path: ["reason"], message: "an unavailable entry must state why" });
  }
  if (entry.measurement_kind === "model" && entry.status === "measured" && !entry.judgment) {
    ctx.addIssue({ code: "custom", path: ["judgment"], message: "a model measurement must carry judgment" });
  }
  if (entry.measurement_kind === "script" && entry.judgment) {
    ctx.addIssue({ code: "custom", path: ["judgment"], message: "a script measurement must not carry judgment" });
  }
});
export type MeasurementEntry = z.infer<typeof MeasurementEntrySchema>;

export const MeasurementEnvelopeSchema = z.object({
  version: z.literal(1),
  as_of_date: z.string().datetime().optional(),
  measurements: z.array(MeasurementEntrySchema).max(2_000),
}).strict();
export type MeasurementEnvelope = z.infer<typeof MeasurementEnvelopeSchema>;

/** The registry boundary. Called by the coverage test, the packet builder and
 * the action materializer — never by a producer, which would reintroduce the
 * import cycle. */
export function validateFindingAgainstRegistry(
  finding: Finding,
  registry: { legalTriples(gate: GateId): readonly { kind: ArtifactKind; effect: RequiredEffect }[] },
): void {
  const legal = registry.legalTriples(finding.gate_id);
  if (!legal.some((t) => t.kind === finding.artifact.kind && t.effect === finding.required_effect)) {
    throw new Error(
      `${finding.gate_id} never declared (${finding.artifact.kind}, ${finding.required_effect}); ` +
      `declare it on the producer or fix the finding`);
  }
}

export const StructuredCheckSchema = z.object({
  id: GateIdSchema,
  pass: z.boolean(),
  measurements: z.array(MeasurementEntrySchema).default([]),
  findings: z.array(FindingSchema).default([]),
  /** A failure the producer could not classify into a routable finding. The
   * kernel reads this as a pre-dispatch verdict and dispatches diagnosis; a
   * failed check with neither a finding nor this flag would stall the round. */
  requires_diagnosis: z.boolean().default(false),
  diagnostic: z.string().max(8_000).optional(),
}).strict().superRefine((check, ctx) => {
  if (!check.pass && check.findings.length === 0 && !check.requires_diagnosis) {
    ctx.addIssue({ code: "custom", path: ["findings"],
      message: `${check.id} failed with no finding and no requires_diagnosis; nothing could act on it` });
  }
  // A finding is a repair request. Attaching one to a satisfied gate would
  // dispatch work nobody asked for, and the kernel has no way to tell that
  // from a real one.
  if (check.pass && check.findings.length > 0) {
    ctx.addIssue({ code: "custom", path: ["findings"],
      message: `${check.id} passed but carries ${check.findings.length} finding(s); a satisfied gate has nothing to repair` });
  }
  if (check.pass && check.requires_diagnosis) {
    ctx.addIssue({ code: "custom", path: ["requires_diagnosis"],
      message: `${check.id} passed but requests diagnosis` });
  }
  // A finding travels inside its check. One naming a different gate would be
  // routed against a gate that never declared it.
  for (const [index, finding] of check.findings.entries()) {
    if (finding.gate_id !== check.id) {
      ctx.addIssue({ code: "custom", path: ["findings", index, "gate_id"],
        message: `finding ${finding.id} names gate ${finding.gate_id} but travels inside ${check.id}` });
    }
  }
});
export type StructuredCheck = z.infer<typeof StructuredCheckSchema>;
