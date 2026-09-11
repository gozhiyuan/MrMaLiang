import crypto from "node:crypto";
import { z } from "zod";

const SEGMENT = "[a-z][a-z0-9_]*";
/** The parameter segment is a SLUG, not an identifier. Taxonomy cells are
 * configured free-form strings (`z.array(z.string().min(2))`), so a real cell
 * is "agent memory" or "long-horizon planning"; requiring an identifier there
 * would reject every realistic configuration. */
const SLUG = "[a-z0-9][a-z0-9-]{0,62}";
const GATE_ID = new RegExp("^" + SEGMENT + "(:" + SLUG + ")?$");
const PLAIN_ID = new RegExp("^" + SEGMENT + "$");

/** Branded string aliases.
 *
 * A metric-shaped string reaching a GateId parameter is the bug that let
 * `rendered_visual_review` steer live acceptance selection; distinct brands
 * make that a compile error at zero runtime cost.
 *
 * The brand is a string-literal property rather than a `unique symbol`: a
 * symbol brand cannot be named in the emitted declarations of the Zod schemas
 * that carry it (TS4023), which breaks every consumer of this package. */
export type GateId = string & { readonly __idBrand: "GateId" };
export type MetricId = string & { readonly __idBrand: "MetricId" };
export type CapabilityId = string & { readonly __idBrand: "CapabilityId" };

export const GateIdSchema = z.string().regex(GATE_ID).transform((value) => value as GateId);
export const MetricIdSchema = z.string().regex(PLAIN_ID).transform((value) => value as MetricId);
export const CapabilityIdSchema = z.string().regex(PLAIN_ID).transform((value) => value as CapabilityId);

export function gateId(value: string): GateId { return GateIdSchema.parse(value); }
export function metricId(value: string): MetricId { return MetricIdSchema.parse(value); }
export function capabilityId(value: string): CapabilityId { return CapabilityIdSchema.parse(value); }

/** Registry lookups key on the family, so one entry covers every instance. */
export function gateFamily(id: GateId): GateId {
  return id.split(":")[0] as GateId;
}
export function isParameterized(id: GateId): boolean {
  return id.includes(":");
}

/** One deterministic, collision-safe slug for a free-form configured label.
 *
 * A bare slug is not enough: "RL/control" and "RL control" slugify identically
 * and would merge two cells into one gate. The digest suffix separates them.
 * Shared by taxonomyGateId and scopeKey so a cell's gate and its observation
 * scope always agree. */
export function slugify(label: string): string {
  const slug = label.toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "x";
  const digest = crypto.createHash("sha256").update(label).digest("hex").slice(0, 10);
  return `${slug}-${digest}`;
}

/** The ONLY way to build a taxonomy gate id. Hand-writing `taxonomy:${cell}`
 * produces ids the grammar rejects, because a configured cell may contain
 * spaces, slashes or non-ASCII. */
export function taxonomyGateId(cell: string): GateId {
  return gateId(`taxonomy:${slugify(cell)}`);
}

/** Whether a gate is repairable at all. Only `manuscript` routes to a
 * capability: an `environment` gate is a precondition of the run (a missing
 * LaTeX compiler is not repaired by editing prose), and a `measurement` gate
 * is re-run rather than repaired. */
export const GATE_CLASSES = ["manuscript", "environment", "measurement"] as const;
export type GateClass = (typeof GATE_CLASSES)[number];
export const GateClassSchema = z.enum(GATE_CLASSES);

/** What kind of thing a finding is about. The path alone is insufficient:
 * `paper/sections/03.tex` is generated from `chapters/section-03.md`, and only
 * one of them is editable by a repair. */
export const ARTIFACT_KINDS = [
  "chapter_prose", "abstract", "outline",
  "figure_spec", "table_spec", "latex_layout", "publication_template", "bibliography",
  "source_record", "evidence_packet", "corpus", "experiment_manifest", "toolchain",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export const ArtifactKindSchema = z.enum(ARTIFACT_KINDS);

/** What must change. Deliberately small; a new value is a registry change with
 * a test, never a prompt edit. */
export const REQUIRED_EFFECTS = [
  "add_explicit_artifact_reference", "add_supporting_citation", "remove_unsupported_claim",
  "repair_citation_marker", "replace_organizing_claim", "resolve_contradiction",
  "remove_redundant_prose", "expand_argument",
  "repair_artifact_content", "repair_artifact_placement", "repair_template",
  "acquire_additional_evidence", "upgrade_source_quality", "repair_source_metadata",
  "repair_bibliography_consistency", "repair_citation_plan", "repair_toolchain",
] as const;
export type RequiredEffect = (typeof REQUIRED_EFFECTS)[number];
export const RequiredEffectSchema = z.enum(REQUIRED_EFFECTS);

/** Editable path prefixes per artifact kind, used to validate that a finding's
 * declared kind matches the path it names. */
export const EDITABLE_KIND_PATHS: Record<ArtifactKind, readonly string[]> = {
  chapter_prose: ["chapters/"],
  abstract: ["paper/abstract.md"],
  outline: ["outline.md", "outline.json"],
  figure_spec: ["figures/placement-plan.json"],
  table_spec: ["figures/placement-plan.json"],
  latex_layout: [],
  publication_template: ["paper/template/"],
  bibliography: ["sources/bibliography.bib"],
  source_record: ["sources/classified_sources.jsonl"],
  evidence_packet: ["evidence/"],
  corpus: ["sources/"],
  experiment_manifest: [],
  toolchain: [],
};

/** Kinds with no editable path fall into two groups, and conflating them made
 * the first draft self-contradictory: it declared routes for
 * `publication_template` and `toolchain` while rejecting every kind with an
 * empty path.
 *
 * `latex_layout` is GENERATED: a finding against it must name its producing
 * surface instead, and may never be a finding's own artifact kind.
 *
 * `toolchain` and `experiment_manifest` are OPERATOR TARGETS: they are real
 * things a finding is about, but nothing this product owns can edit them. A
 * finding of these kinds is legal only when its capability is
 * `request_operator_clarification`. */
export const OPERATOR_TARGET_KINDS: readonly ArtifactKind[] = ["toolchain", "experiment_manifest"];
export const GENERATED_KINDS: readonly ArtifactKind[] = ["latex_layout"];
export const OPERATOR_CAPABILITY = "request_operator_clarification";
