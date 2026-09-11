import { z } from "zod";
import {
  ArtifactKindSchema, CapabilityIdSchema, MetricIdSchema, RequiredEffectSchema,
  capabilityId, type CapabilityId,
} from "./ids.js";

/** One (kind, effect) pair a capability knows how to repair. */
export const HandledTriple = z.object({
  kind: ArtifactKindSchema,
  effect: RequiredEffectSchema,
}).strict();
export type HandledTriple = z.infer<typeof HandledTriple>;

/** A catalog entry is a TEMPLATE, not a contract.
 *
 * The gate, the scope and therefore the acceptance criterion are known only
 * when a concrete finding is dispatched: the same capability repairs a
 * citation defect in one round and a redundancy defect in the next, against
 * different metrics at different scopes. Baking `acceptance` in at compile
 * time would mean either one criterion pretending to cover every dispatch, or
 * a catalog regenerated per finding. `must_preserve_template` is the part that
 * IS static — what this capability must never break, whatever it was asked to
 * repair. */
export const CapabilityTemplate = z.object({
  id: CapabilityIdSchema,
  kind: z.enum(["mutation", "measurement"]),
  /** The maximum a capability may ever touch. A dispatched instance narrows
   * this; nothing widens it. */
  owns: z.array(z.string().min(1)).min(1),
  /** Measurement stages that judge whatever this capability was dispatched to
   * do. Every name must be a stage the compiled workflow declares — a name
   * that resolves to nothing is worse than no name at all, because the kernel
   * then reports the objective as unmeasurable rather than the manifest as
   * wrong. Compilation checks this; the tiered measurement stages that fill
   * these in arrive with Task 11. */
  evaluate_with: z.array(z.string().min(1)).default([]),
  handles: z.array(HandledTriple).min(1),
  /** Registered metric ids, never gate ids: the kernel compares numbers, and a
   * gate id names no number. */
  must_preserve_template: z.array(MetricIdSchema).default([]),
  /** The MAXIMUM harness grant this capability may ever be given, per required
   * effect, with `*` as the default.
   *
   * Declared here so the ceiling is in the manifest the kernel compiles rather
   * than in whatever the materializer happens to ask for. An empty map is a
   * real answer and the common one: a capability whose compiled action runs a
   * script has no harness tools to grant, and saying so is what makes "an empty
   * ceiling grants nothing" safe to enforce. */
  tool_grants: z.record(z.array(z.string().min(1))).default({}),
  /** This capability cannot enumerate what it will write.
   *
   * A deterministic bulk writer creates files whose names do not exist until it
   * runs — a corpus expansion retrieves sources it has not yet found. Narrowing
   * its envelope to the paths a finding happens to mention makes correct work
   * come back as an `undeclared_write`, so its instance repeats the template's
   * own patterns instead. The kernel checks that every retained pattern is one
   * this template declares, so the ceiling still holds. Only appropriate for a
   * SCRIPT capability: a model that cannot say what it will touch is a model
   * that should not be given a directory. */
  retains_envelope: z.boolean().default(false),
  model_tier: z.enum(["high", "quality_drafting", "medium", "script"]),
}).strict();
export type CapabilityTemplate = z.infer<typeof CapabilityTemplate>;

const TEMPLATES: CapabilityTemplate[] = [
  CapabilityTemplate.parse({
    id: "revise_sections",
    kind: "mutation",
    tool_grants: { "*": ["Read", "Edit", "Write"] },
    // Prose only. A generated figure, table, placement or build artifact is
    // repaired by revise_visual_plan; letting this capability own them would
    // send a repair at a file the next render overwrites.
    owns: ["chapters/**", "paper/abstract.md", "reviews/revision-report.md"],
    // Prose repairs move round-tier metrics; the acquisition stages produce
    // the model metrics this capability is judged on and must not break. A
    // review-gate finding routed here compiles a review_score criterion, and a
    // criterion no declared measurement can report is judged
    // `measurement_failed` however well the repair went.
    evaluate_with: ["measure_round_metrics", "acquire_claim_support", "acquire_review_score", "acquire_rendered_visual_review"],
    handles: [
      { kind: "chapter_prose", effect: "add_explicit_artifact_reference" },
      { kind: "chapter_prose", effect: "add_supporting_citation" },
      { kind: "chapter_prose", effect: "expand_argument" },
      { kind: "chapter_prose", effect: "remove_redundant_prose" },
      { kind: "chapter_prose", effect: "remove_unsupported_claim" },
      { kind: "chapter_prose", effect: "repair_citation_marker" },
      { kind: "chapter_prose", effect: "resolve_contradiction" },
    ],
    // Rewriting prose is exactly how citation support and verified metadata
    // are lost: the invariant is that a repair may not pay for itself with
    // another gate's evidence.
    must_preserve_template: ["claim_support", "citation_verification_status", "cited_sources"],
    model_tier: "quality_drafting",
  }),
  CapabilityTemplate.parse({
    id: "revise_visual_plan",
    kind: "mutation",
    tool_grants: { "*": ["Read", "Edit", "Write"] },
    owns: ["figures/**", "tables/**", "paper/template/**", "figures/placement-plan.json"],
    // A visual repair answers to the rendered review, which is a model metric
    // and therefore has an acquisition stage of its own.
    evaluate_with: ["measure_round_metrics", "acquire_latex_build_status", "acquire_rendered_visual_review", "acquire_review_score"],
    handles: [
      { kind: "figure_spec", effect: "repair_artifact_content" },
      { kind: "figure_spec", effect: "repair_artifact_placement" },
      { kind: "table_spec", effect: "repair_artifact_content" },
      { kind: "table_spec", effect: "repair_artifact_placement" },
      { kind: "publication_template", effect: "repair_template" },
    ],
    must_preserve_template: ["figures", "tables", "diagram_connectivity"],
    model_tier: "medium",
  }),
  CapabilityTemplate.parse({
    id: "reopen_outline",
    kind: "mutation",
    tool_grants: { "*": ["Read", "Edit", "Write"] },
    owns: ["outline.json", "outline.md", "feedback/outline-revision.md", "reviews/outline-revision.md"],
    evaluate_with: ["measure_round_metrics", "acquire_review_score"],
    handles: [{ kind: "outline", effect: "replace_organizing_claim" }],
    // Reorganizing an argument must not quietly drop the evidence the old
    // organization carried.
    must_preserve_template: ["cited_sources", "claim_support"],
    model_tier: "high",
  }),
  CapabilityTemplate.parse({
    id: "targeted_research_expansion",
    kind: "mutation",
    // `research expand` retrieves, screens and indexes sources it has not yet
    // found, writing throughout sources/, evidence/, fulltext/ and research/.
    // Its compiled action is a deterministic script, so the envelope its code
    // already implies is the honest one.
    retains_envelope: true,
    // Every path the catalog action actually writes, including the report it
    // leaves behind. An envelope narrower than the action's own outputs is not
    // a tighter contract — the manifest simply fails to parse, and the
    // capability cannot run at all.
    owns: ["sources/citation-verification.jsonl", "sources/**", "evidence/**", "fulltext/**", "research/**", "reports/research-expansion.md"],
    evaluate_with: ["measure_unit_metrics", "measure_round_metrics"],
    handles: [
      { kind: "corpus", effect: "acquire_additional_evidence" },
      { kind: "corpus", effect: "upgrade_source_quality" },
      { kind: "evidence_packet", effect: "acquire_additional_evidence" },
    ],
    // Adding sources must not degrade what the corpus already established.
    must_preserve_template: ["cited_sources", "landmark_coverage_ratio", "accepted_cited_ratio"],
    model_tier: "medium",
  }),
  CapabilityTemplate.parse({
    id: "repair_bibliography",
    kind: "mutation",
    // Including the report it leaves behind on every dispatch. An envelope
    // narrower than what the action actually writes is not a tighter contract:
    // the manifest simply fails to parse and the capability cannot run at all.
    owns: ["sources/bibliography.bib", "reports/bibliography-repair.md"],
    evaluate_with: ["measure_round_metrics"],
    handles: [{ kind: "bibliography", effect: "repair_bibliography_consistency" }],
    must_preserve_template: ["cited_sources", "citation_verification_status"],
    model_tier: "script",
  }),
  CapabilityTemplate.parse({
    id: "repair_citation_plan",
    kind: "mutation",
    owns: ["sources/citation_plan.jsonl", "reports/citation-plan-repair.md"],
    evaluate_with: ["measure_round_metrics"],
    handles: [{ kind: "corpus", effect: "repair_citation_plan" }],
    must_preserve_template: ["cited_sources"],
    model_tier: "script",
  }),
  CapabilityTemplate.parse({
    id: "repair_source_metadata",
    kind: "mutation",
    // Identity reconciliation rewrites the source records AND the two reports
    // it leaves behind. Both are part of the envelope; isolation found the
    // second one the first time this capability ever actually ran.
    owns: ["sources/classified_sources.jsonl", "sources/citation-verification.jsonl", "sources/**",
           "reports/source-identities.md", "reports/source-metadata-repair.md", "reports/source-verification.md"],
    evaluate_with: ["measure_round_metrics"],
    handles: [{ kind: "source_record", effect: "repair_source_metadata" }],
    must_preserve_template: ["cited_sources", "citation_verification_status"],
    model_tier: "script",
  }),
  CapabilityTemplate.parse({
    id: "request_operator_clarification",
    kind: "mutation",
    // An operator target has no editable path; the capability writes the
    // request, never the artifact.
    owns: ["reviews/clarification-request.md"],
    evaluate_with: [],
    handles: [{ kind: "toolchain", effect: "repair_toolchain" }],
    must_preserve_template: [],
    model_tier: "script",
  }),
];

export const CAPABILITY_TEMPLATES: ReadonlyMap<string, CapabilityTemplate> =
  new Map(TEMPLATES.map((template) => [String(template.id), template]));

/** Least privilege per capability AND per effect.
 *
 * An unknown capability gets nothing, because a permissive default is how a
 * prose editor acquires a network tool it never needed — and a capability whose
 * action is a script gets nothing because there is nothing to give it. */
export function toolGrantFor(capability: string, effect: string): string[] {
  const template = CAPABILITY_TEMPLATES.get(capability);
  if (!template) return [];
  return template.tool_grants[effect] ?? template.tool_grants["*"] ?? [];
}

/** The union of every grant this capability can ever request: the ceiling the
 * compiled manifest declares and the kernel enforces. */
export function toolCeilingFor(capability: string): string[] {
  const template = CAPABILITY_TEMPLATES.get(capability);
  if (!template) return [];
  return [...new Set(Object.values(template.tool_grants).flat())].sort();
}

export function templateFor(capability: string): CapabilityTemplate {
  const template = CAPABILITY_TEMPLATES.get(capability);
  if (!template) {
    throw new Error(
      `no capability template for ${capability}; declare one in registry/capabilities.ts ` +
      `so a dispatched instance has an envelope and protected metrics`);
  }
  return template;
}

export function capabilityIds(): CapabilityId[] {
  return [...CAPABILITY_TEMPLATES.keys()].sort().map((id) => capabilityId(id));
}
