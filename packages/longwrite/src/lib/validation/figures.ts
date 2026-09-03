import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { figureManifestSchema, type FigureManifest } from "../writing/figures.js";
import { loadProjectConfigIfExists } from "../project-config.js";
import { paperProfile } from "../paper-profiles.js";
import { connectedComponents } from "../research/diagram-connectivity.js";
import { FindingSchema, type Finding, type StructuredCheck } from "../registry/records.js";
import { gateId } from "../registry/ids.js";
import { GLOBAL_SCOPE } from "../registry/scope.js";
import { z } from "zod";

/** A figures report. Structurally the same shape as ValidationReport, but its
 * checks carry findings the kernel can route rather than sentences. */
export type StructuredReport = { pass: boolean; checks: StructuredCheck[] };

const LOOP_CAPTION_PATTERN = /\b(loop|cycle|feedback|iterative|conjunctive|end-to-end)\b/i;
const NEGATED_LOOP_CAPTION_PATTERN = /\b(?:not|never|does\s+not|do\s+not|should\s+not|isn't|is\s+not|aren't|are\s+not)\b[^.!?]{0,100}\b(?:loop|cycle|feedback|iterative|conjunctive|end-to-end)\b/i;

const Graph = z.object({
  id: z.string().min(1).optional(), title: z.string().default(""), caption: z.string().default(""),
  layout: z.object({ kind: z.enum(["grid", "flow"]) }).passthrough().optional(),
  nodes: z.array(z.object({ id: z.string().min(1), label: z.string().default("") }).passthrough()),
  edges: z.array(z.object({ from: z.string().min(1), to: z.string().min(1), label: z.string().optional() }).passthrough()),
}).passthrough().superRefine((graph, ctx) => {
  const ids = graph.nodes.map((node) => node.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "node ids must be unique" });
  const known = new Set(ids);
  graph.edges.forEach((edge, index) => {
    if (!known.has(edge.from) || !known.has(edge.to)) ctx.addIssue({ code: "custom", path: ["edges", index], message: "edge endpoints must name existing nodes" });
  });
});
const PlacementPlanGraphs = z.object({ concept_map: z.unknown().optional(), diagrams: z.unknown().optional() }).passthrough();

/** Builds a routable finding from what the check already knows.
 *
 * Every check below used to push a sentence. The sentence survives as
 * `diagnostic`, for operators; the artifact, effect and scope beside it are
 * what the kernel routes on, and they were always computable here — they were
 * simply thrown away at the point of formatting. */
function finding(args: {
  gate: string;
  kind: "figure_spec" | "table_spec";
  effect: "repair_artifact_content" | "repair_artifact_placement";
  subject: string;
  diagnostic: string;
  location?: string;
  severity?: "minor" | "major" | "critical";
}): Finding {
  return FindingSchema.parse({
    // Stable and derived from the subject, so the same defect keeps the same
    // id across rounds and the kernel can tell a persisting finding from a new
    // one.
    id: `${args.gate}-${args.subject.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x"}`,
    gate_id: args.gate,
    // Both figures and tables are edited through the placement plan. The
    // generated TeX is named in `location`, never as the artifact: nothing may
    // be sent to repair a file the next render overwrites.
    artifact: { kind: args.kind, path: "figures/placement-plan.json", artifact_id: args.subject },
    ...(args.location === undefined ? {} : { location: args.location }),
    objective_scope_key: GLOBAL_SCOPE,
    required_effect: args.effect,
    acceptance_metric: acceptanceMetricOf(PRODUCER, gateId(args.gate), args.kind, args.effect),
    severity: args.severity ?? "major",
    diagnostic: args.diagnostic,
  });
}

async function readText(workspaceDir: string, rel: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(workspaceDir, rel), "utf-8");
  } catch {
    return null;
  }
}

async function statNonEmpty(workspaceDir: string, rel: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(workspaceDir, rel));
    return stat.size > 0;
  } catch {
    return false;
  }
}

async function sha256IfExists(workspaceDir: string, rel: string): Promise<string | null> {
  try { return createHash("sha256").update(await fs.readFile(path.join(workspaceDir, rel))).digest("hex"); } catch { return null; }
}

async function loadManifest(workspaceDir: string): Promise<{ manifest?: FigureManifest; findings: Finding[] }> {
  const content = await readText(workspaceDir, "figures/manifest.json");
  if (content === null) {
    return { findings: [finding({
      gate: "figure_manifest", kind: "figure_spec", effect: "repair_artifact_content",
      subject: "manifest", severity: "critical",
      diagnostic: "figure_manifest: figures/manifest.json is missing",
    })] };
  }
  try {
    return { manifest: figureManifestSchema.parse(JSON.parse(content)), findings: [] };
  } catch (err) {
    return { findings: [finding({
      gate: "figure_manifest", kind: "figure_spec", effect: "repair_artifact_content",
      subject: "manifest", severity: "critical",
      diagnostic: `figure_manifest: figures/manifest.json is invalid: ${err instanceof Error ? err.message : String(err)}`,
    })] };
  }
}

async function checkManifest(workspaceDir: string): Promise<{ check: StructuredCheck; manifest?: FigureManifest }> {
  const { manifest, findings } = await loadManifest(workspaceDir);
  // An empty manifest is valid for a reader-focused survey whose configured
  // visual minima are zero. The full-mode contract below remains the single
  // authority when a profile actually requires visual artifacts.
  return { check: { id: gateId("figure_manifest"), pass: findings.length === 0, findings, measurements: [], requires_diagnosis: false }, manifest };
}

/** What a dependent check emits when the manifest could not be read. It is a
 * real finding rather than a bare failure: the manifest is the editable
 * surface, and a check that only said "skipped" would fail the round with
 * nothing for the kernel to dispatch. */
function blockedOnManifest(gate: string): StructuredCheck {
  return {
    id: gateId(gate), pass: false, measurements: [], requires_diagnosis: false,
    findings: [finding({
      gate, kind: "figure_spec", effect: "repair_artifact_content", subject: "manifest",
      severity: "critical",
      diagnostic: `${gate}: skipped because figures/manifest.json is missing or invalid`,
    })],
  };
}

export async function checkArtifacts(workspaceDir: string, manifest?: FigureManifest): Promise<StructuredCheck> {
  const findings: Finding[] = [];
  if (!manifest) return blockedOnManifest("figure_artifacts");
  const fail = (kind: "figure_spec" | "table_spec", subject: string, diagnostic: string) =>
    findings.push(finding({ gate: "figure_artifacts", kind, effect: "repair_artifact_content", subject, diagnostic }));

  for (const figure of manifest.figures) {
    if (!(await statNonEmpty(workspaceDir, figure.path))) {
      fail("figure_spec", figure.id, `figure_artifacts: ${figure.path} is missing or empty`);
    }
    if (!(await statNonEmpty(workspaceDir, figure.latex_path))) {
      fail("figure_spec", figure.id, `figure_artifacts: ${figure.latex_path} is missing or empty`);
    }
    for (const data of figure.data) {
      if (!(await statNonEmpty(workspaceDir, data))) {
        fail("figure_spec", figure.id, `figure_artifacts: ${figure.id} data file ${data} is missing or empty`);
      }
    }
    if (figure.provenance) {
      const checksum = await sha256IfExists(workspaceDir, figure.path);
      if (checksum !== figure.provenance.sha256) fail("figure_spec", figure.id, `figure_artifacts: ${figure.id} imported-artifact checksum does not match its provenance record`);
      if (figure.backend === "repository-import" && (!figure.provenance.license || !figure.provenance.codebase_id || !figure.provenance.source_revision)) {
        fail("figure_spec", figure.id, `figure_artifacts: ${figure.id} repository import requires codebase id, revision, and license attribution`);
      }
      if (figure.backend === "experiment-import" && (!figure.provenance.manifest_path || !figure.provenance.source_revision)) {
        fail("figure_spec", figure.id, `figure_artifacts: ${figure.id} experiment import requires manifest and source-revision provenance`);
      }
    }
  }
  for (const table of manifest.tables) {
    if (!(await statNonEmpty(workspaceDir, table.path))) {
      fail("table_spec", table.id, `figure_artifacts: ${table.path} is missing or empty`);
    }
    if (!(await statNonEmpty(workspaceDir, table.latex_path))) {
      fail("table_spec", table.id, `figure_artifacts: ${table.latex_path} is missing or empty`);
    } else if (table.layout === "longtable") {
      const latex = await readText(workspaceDir, table.latex_path);
      if (!latex?.includes("\\begin{longtable}") || !latex.includes(`\\label{tab:${table.id}}`)) {
        fail("table_spec", table.id, `figure_artifacts: ${table.id} longtable lacks its required caption/label contract`);
      }
    }
    for (const data of table.data) {
      if (!(await statNonEmpty(workspaceDir, data))) {
        fail("table_spec", table.id, `figure_artifacts: ${table.id} data file ${data} is missing or empty`);
      }
    }
  }
  return { id: gateId("figure_artifacts"), pass: findings.length === 0, findings, measurements: [], requires_diagnosis: false };
}

export async function checkRequiredFullModeVisuals(workspaceDir: string, manifest?: FigureManifest): Promise<StructuredCheck> {
  const config = await loadProjectConfigIfExists(workspaceDir);
  if (config?.project.mode !== "auto_research_agentic") {
    return { id: gateId("full_mode_visual_contract"), pass: true, findings: [], measurements: [], requires_diagnosis: false,
      diagnostic: "not a full research release mode; full visual contract is informational" };
  }
  if (!manifest) return blockedOnManifest("full_mode_visual_contract");
  const quality = config.figures.quality_gates;
  const findings: Finding[] = [];
  const GATE = "full_mode_visual_contract";
  const fail = (kind: "figure_spec" | "table_spec", subject: string, diagnostic: string) =>
    findings.push(finding({ gate: GATE, kind, effect: "repair_artifact_content", subject, diagnostic }));
  if (manifest.figures.length < quality.min_figures) fail("figure_spec", "figure-count", `${GATE}: ${manifest.figures.length} figures is below configured minimum ${quality.min_figures}`);
  if (manifest.tables.length < quality.min_tables) fail("table_spec", "table-count", `${GATE}: ${manifest.tables.length} tables is below configured minimum ${quality.min_tables}`);
  const comparativeTables = manifest.tables.filter((table) => table.comparative).length;
  if (comparativeTables < quality.min_comparative_tables) fail("table_spec", "comparative-tables", `${GATE}: ${comparativeTables} source-grounded comparative tables is below configured minimum ${quality.min_comparative_tables}`);
  const verifiedMetadataPlots = manifest.figures.filter((figure) => figure.backend !== "nanobanana" && figure.data.length > 0).length;
  if (verifiedMetadataPlots < quality.min_verified_metadata_plots) fail("figure_spec", "verified-plots", `${GATE}: ${verifiedMetadataPlots} data-driven figures is below configured minimum ${quality.min_verified_metadata_plots}`);
  const nanobananaIllustrations = manifest.figures.filter((figure) => figure.backend === "nanobanana").length;
  if (nanobananaIllustrations > quality.max_nanobanana_illustrations) fail("figure_spec", "illustration-budget", `${GATE}: ${nanobananaIllustrations} Nano Banana illustrations exceeds configured maximum ${quality.max_nanobanana_illustrations}; orienting illustrations cannot substitute for data-driven visuals`);
  if (quality.require_insight_statements) {
    const tableIds = new Set(manifest.tables.map((table) => table.id));
    for (const item of [...manifest.figures, ...manifest.tables]) {
      if (item.insight.trim().length < 24) fail(tableIds.has(item.id) ? "table_spec" : "figure_spec", item.id, `${GATE}: ${item.id} requires a substantive insight statement in figures/manifest.json`);
    }
  }
  const ids = new Set([...manifest.figures.map((figure) => figure.id), ...manifest.tables.map((table) => table.id)]);
  const profile = paperProfile(config.research.paper_profile);
  for (const id of profile.requiredVisualIds.filter((required) => !ids.has(required))) {
    fail("figure_spec", id, `${GATE}: missing required visual/table ${id}`);
  }
  if (profile.architectureTitleRequired) {
    const architecture = manifest.figures.find((figure) => figure.id === "concept-map");
    if (architecture && !/\b(?:system )?architecture\b/i.test(`${architecture.title} ${architecture.caption}`)) {
      fail("figure_spec", "concept-map", `${GATE}: ${profile.id} requires concept-map to be titled/captioned as a system architecture diagram`);
    }
  }
  return { id: gateId(GATE), pass: findings.length === 0, findings, measurements: [], requires_diagnosis: false };
}

/** These source-level checks catch the visual failures that can be decided
 * without asking a reviewer to guess: shrinking a data table to fit, a table
 * with no real caption/label, or a stale hand-numbered reference. Human/LLM
 * review still judges semantic usefulness of the rendered result. */
export async function checkPublicationLayout(workspaceDir: string): Promise<StructuredCheck> {
  const findings: Finding[] = [];
  const sectionDir = path.join(workspaceDir, "paper", "sections");
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(sectionDir)).filter((entry) => entry.endsWith(".tex"));
  } catch {
    return { id: gateId("publication_layout"), pass: true, findings: [], measurements: [], requires_diagnosis: false,
      diagnostic: "paper sections not built yet; layout preflight deferred" };
  }
  // Every defect here is visible in generated TeX but fixable only in the
  // placement plan that generates it, so the section path travels as
  // `location` while the artifact stays the plan.
  const fail = (subject: string, location: string, diagnostic: string) =>
    findings.push(finding({ gate: "publication_layout", kind: "figure_spec",
      effect: "repair_artifact_placement", subject, location, diagnostic }));
  for (const entry of entries) {
    const rel = path.join("paper", "sections", entry);
    const content = await readText(workspaceDir, rel);
    if (content === null) continue;
    const subject = entry.replace(/\.tex$/, "");
    if (content.includes("\\resizebox{\\textwidth}{!}{%")) {
      fail(subject, rel, `publication_layout: ${rel} shrinks a table to text width; use wrapped columns or a longtable`);
    }
    if (/\\begin\{longtable\}/.test(content) && !/\\caption\{[^}]+\}\\label\{tab:/.test(content)) {
      fail(subject, rel, `publication_layout: ${rel} contains an uncaptioned or unlabeled longtable`);
    }
    if (/\b(?:Table|Figure)\s+\d+\b/.test(content)) {
      fail(subject, rel, `publication_layout: ${rel} contains a hand-numbered table/figure reference`);
    }
  }
  return { id: gateId("publication_layout"), pass: findings.length === 0, findings, measurements: [], requires_diagnosis: false };
}

/** A declared flow, or a caption that promises one connected process (a
 * "loop", "cycle", or "feedback" mechanism), must render as one connected
 * graph. Grid diagrams intentionally support disconnected comparisons and
 * capability maps. Negated prose such as "not an end-to-end process" must not
 * turn a disconnected-intent diagram into a process-flow contract. */
export async function checkDiagramConnectivity(workspaceDir: string): Promise<StructuredCheck> {
  const raw = await readText(workspaceDir, "figures/placement-plan.json");
  if (raw === null) return { id: gateId("diagram_connectivity"), pass: true, findings: [], measurements: [], requires_diagnosis: false,
    diagnostic: "figures/placement-plan.json not present; diagram connectivity check skipped" };
  const fail = (subject: string, diagnostic: string) =>
    finding({ gate: "diagram_connectivity", kind: "figure_spec", effect: "repair_artifact_content", subject, diagnostic });
  let plan: z.infer<typeof PlacementPlanGraphs>;
  try {
    plan = PlacementPlanGraphs.parse(JSON.parse(raw));
  } catch (error) {
    return { id: gateId("diagram_connectivity"), pass: false, measurements: [], requires_diagnosis: false,
      findings: [fail("placement-plan", `diagram_connectivity: figures/placement-plan.json has a malformed or invalid graph contract: ${error instanceof Error ? error.message : String(error)}`)] };
  }
  const findings: Finding[] = [];
  const candidates: Array<{ fallbackId: string; value: unknown }> = [];
  if (plan.concept_map !== undefined) candidates.push({ fallbackId: "concept-map", value: plan.concept_map });
  if (plan.diagrams !== undefined && !Array.isArray(plan.diagrams)) {
    findings.push(fail("diagrams", "diagram_connectivity: diagrams must be an array"));
  } else {
    for (const [index, value] of (plan.diagrams ?? []).entries()) candidates.push({ fallbackId: `diagram-${index + 1}`, value });
  }
  for (const candidate of candidates) {
    const candidateId = candidate.value && typeof candidate.value === "object" && !Array.isArray(candidate.value)
      && typeof (candidate.value as { id?: unknown }).id === "string"
      ? (candidate.value as { id: string }).id
      : candidate.fallbackId;
    const parsed = Graph.safeParse(candidate.value);
    if (!parsed.success) {
      findings.push(fail(candidateId, `diagram_connectivity: ${candidateId} has a malformed or invalid graph contract: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`));
      continue;
    }
    const diagram = { ...parsed.data, id: parsed.data.id ?? candidateId };
    const text = `${diagram.title} ${diagram.caption}`;
    const requiresConnectivity = diagram.layout?.kind === "flow"
      || (diagram.layout?.kind !== "grid" && LOOP_CAPTION_PATTERN.test(text) && !NEGATED_LOOP_CAPTION_PATTERN.test(text));
    if (!requiresConnectivity) continue;
    const components = connectedComponents({ nodes: diagram.nodes, edges: diagram.edges });
    if (components.length > 1) {
      findings.push(fail(diagram.id, `diagram_connectivity: ${diagram.id} caption/title implies one connected process ("${text.trim()}") but its rendered graph forms ${components.length} disconnected groups: ${components.map((group) => `[${group.join(", ")}]`).join(", ")}`));
    }
  }
  return { id: gateId("diagram_connectivity"), pass: findings.length === 0, findings, measurements: [], requires_diagnosis: false };
}

export async function checkManuscriptReferences(workspaceDir: string, manifest?: FigureManifest): Promise<StructuredCheck> {
  const findings: Finding[] = [];
  if (!manifest) return blockedOnManifest("figure_references");
  const main = await readText(workspaceDir, "paper/main.tex");
  if (main === null) return { id: gateId("figure_references"), pass: true, findings, measurements: [], requires_diagnosis: false };

  // Each defect is observed in generated TeX and repaired in the placement
  // plan. Naming the .tex file as the artifact would send a repair at a file
  // the next render overwrites, so it travels as `location` instead.
  const fail = (kind: "figure_spec" | "table_spec", subject: string, location: string | undefined, diagnostic: string) =>
    findings.push(finding({ gate: "figure_references", kind, effect: "repair_artifact_placement", subject, location, diagnostic }));

  if (main.includes("Generated Figures and Tables")) {
    fail("figure_spec", "generated-section", "paper/main.tex",
      "figure_references: paper/main.tex appends a generated-artifacts section instead of embedding artifacts in chapters");
  }
  const embedded = async (kind: "fig" | "tab", item: FigureManifest["figures"][number] | FigureManifest["tables"][number]) => {
    const spec = kind === "tab" ? "table_spec" as const : "figure_spec" as const;
    const rel = `paper/sections/${item.placement.section_id}.tex`;
    const section = await readText(workspaceDir, rel);
    if (section === null) {
      fail(spec, item.id, rel, `figure_references: placement section ${rel} is missing for ${item.id}`);
      return;
    }
    const longtableLabel = kind === "tab" && "layout" in item && item.layout === "longtable"
      ? (await readText(workspaceDir, item.latex_path))?.includes(`\\label{tab:${item.id}}`) === true
      : false;
    if (!section.includes(`\\label{${kind}:${item.id}}`) && !longtableLabel) fail(spec, item.id, rel, `figure_references: ${item.id} is not labeled in ${rel}`);
    if (!section.includes(`\\input{${item.latex_path.replace(/^paper\//, "")}}`)) fail(spec, item.id, rel, `figure_references: ${item.id} does not embed ${item.latex_path} in ${rel}`);
    // Embedded artifacts have a caption and stable label. Do not require a
    // separate prose ``Figure/Table N:'' lead-in: floats can legally move to
    // the next page, turning that mechanically required line into a detached
    // pseudo-caption. Natural in-text references remain welcome when the
    // author needs them, but placement and caption validation are the
    // publishability contract here.
  };
  for (const figure of manifest.figures) await embedded("fig", figure);
  for (const table of manifest.tables) await embedded("tab", table);
  return { id: gateId("figure_references"), pass: findings.length === 0, findings, measurements: [], requires_diagnosis: false };
}

export async function validateFigureWorkspace(workspaceDir: string): Promise<StructuredReport> {
  const { check, manifest } = await checkManifest(workspaceDir);
  const checks: StructuredCheck[] = [
    check,
    await checkRequiredFullModeVisuals(workspaceDir, manifest),
    await checkArtifacts(workspaceDir, manifest),
    await checkManuscriptReferences(workspaceDir, manifest),
    await checkPublicationLayout(workspaceDir),
    await checkDiagramConnectivity(workspaceDir),
  ];
  return { pass: checks.every((item) => item.pass), checks };
}

import { defineProducer, acceptanceMetricOf } from "../registry/producer-types.js";

/** Gate declarations, kept beside the checks that emit them so a reviewer
 * sees a gate's repair semantics and its code together. The class table,
 * legal triples and routes are all generated from this. */
export const PRODUCER = defineProducer({
  module: "figures",
  gates: [
    { id: "figure_manifest", class: "manuscript", observes: ["figures", "tables"], findings: [
      { kind: "figure_spec", effect: "repair_artifact_content", capability: "revise_visual_plan",
        acceptance_metric: "figures" },
    ] },
    { id: "figure_artifacts", class: "manuscript", findings: [
      { kind: "figure_spec", effect: "repair_artifact_content", capability: "revise_visual_plan",
        acceptance_metric: "figures" },
      { kind: "table_spec", effect: "repair_artifact_content", capability: "revise_visual_plan",
        acceptance_metric: "tables" },
    ] },
    { id: "full_mode_visual_contract", class: "manuscript", findings: [
      { kind: "figure_spec", effect: "repair_artifact_content", capability: "revise_visual_plan",
        acceptance_metric: "figures" },
      { kind: "table_spec", effect: "repair_artifact_content", capability: "revise_visual_plan",
        acceptance_metric: "tables" },
    ] },
    { id: "publication_layout", class: "manuscript", findings: [
      { kind: "figure_spec", effect: "repair_artifact_placement", capability: "revise_visual_plan",
        acceptance_metric: null },
    ] },
    { id: "diagram_connectivity", class: "manuscript", observes: ["diagram_connectivity"], findings: [
      { kind: "figure_spec", effect: "repair_artifact_content", capability: "revise_visual_plan",
        acceptance_metric: "diagram_connectivity" },
    ] },
    { id: "figure_references", class: "manuscript", findings: [
      { kind: "figure_spec", effect: "repair_artifact_placement", capability: "revise_visual_plan",
        acceptance_metric: null },
      // Emitted when the manifest itself cannot be read: the defect is in the
      // spec's content, not in where an artifact was placed. The acceptance
      // lookup surfaced this triple as undeclared.
      { kind: "figure_spec", effect: "repair_artifact_content", capability: "revise_visual_plan",
        acceptance_metric: "figures" },
      { kind: "table_spec", effect: "repair_artifact_placement", capability: "revise_visual_plan",
        acceptance_metric: null },
      { kind: "chapter_prose", effect: "add_explicit_artifact_reference", capability: "revise_sections",
        acceptance_metric: null },
    ] },
  ],
});
