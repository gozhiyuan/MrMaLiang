import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { figureManifestSchema, type FigureManifest } from "../writing/figures.js";
import type { ValidationCheck, ValidationReport } from "./research.js";
import { loadProjectConfigIfExists } from "../project-config.js";
import { paperProfile } from "../paper-profiles.js";

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

async function loadManifest(workspaceDir: string): Promise<{ manifest?: FigureManifest; findings: string[] }> {
  const content = await readText(workspaceDir, "figures/manifest.json");
  if (content === null) return { findings: ["figure_manifest: figures/manifest.json is missing"] };
  try {
    return { manifest: figureManifestSchema.parse(JSON.parse(content)), findings: [] };
  } catch (err) {
    return { findings: [`figure_manifest: figures/manifest.json is invalid: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

async function checkManifest(workspaceDir: string): Promise<{ check: ValidationCheck; manifest?: FigureManifest }> {
  const { manifest, findings } = await loadManifest(workspaceDir);
  if (manifest && manifest.figures.length === 0 && manifest.tables.length === 0) {
    findings.push("figure_manifest: manifest must contain at least one figure or table");
  }
  return { check: { id: "figure_manifest", pass: findings.length === 0, findings }, manifest };
}

async function checkArtifacts(workspaceDir: string, manifest?: FigureManifest): Promise<ValidationCheck> {
  const findings: string[] = [];
  if (!manifest) return { id: "figure_artifacts", pass: false, findings: ["figure_artifacts: skipped because manifest is invalid"] };

  for (const figure of manifest.figures) {
    if (!(await statNonEmpty(workspaceDir, figure.path))) {
      findings.push(`figure_artifacts: ${figure.path} is missing or empty`);
    }
    if (!(await statNonEmpty(workspaceDir, figure.latex_path))) {
      findings.push(`figure_artifacts: ${figure.latex_path} is missing or empty`);
    }
    for (const data of figure.data) {
      if (!(await statNonEmpty(workspaceDir, data))) {
        findings.push(`figure_artifacts: ${figure.id} data file ${data} is missing or empty`);
      }
    }
    if (figure.provenance) {
      const checksum = await sha256IfExists(workspaceDir, figure.path);
      if (checksum !== figure.provenance.sha256) findings.push(`figure_artifacts: ${figure.id} imported-artifact checksum does not match its provenance record`);
      if (figure.backend === "repository-import" && (!figure.provenance.license || !figure.provenance.codebase_id || !figure.provenance.source_revision)) {
        findings.push(`figure_artifacts: ${figure.id} repository import requires codebase id, revision, and license attribution`);
      }
      if (figure.backend === "experiment-import" && (!figure.provenance.manifest_path || !figure.provenance.source_revision)) {
        findings.push(`figure_artifacts: ${figure.id} experiment import requires manifest and source-revision provenance`);
      }
    }
  }
  for (const table of manifest.tables) {
    if (!(await statNonEmpty(workspaceDir, table.path))) {
      findings.push(`figure_artifacts: ${table.path} is missing or empty`);
    }
    if (!(await statNonEmpty(workspaceDir, table.latex_path))) {
      findings.push(`figure_artifacts: ${table.latex_path} is missing or empty`);
    } else if (table.layout === "longtable") {
      const latex = await readText(workspaceDir, table.latex_path);
      if (!latex?.includes("\\begin{longtable}") || !latex.includes(`\\label{tab:${table.id}}`)) {
        findings.push(`figure_artifacts: ${table.id} longtable lacks its required caption/label contract`);
      }
    }
    for (const data of table.data) {
      if (!(await statNonEmpty(workspaceDir, data))) {
        findings.push(`figure_artifacts: ${table.id} data file ${data} is missing or empty`);
      }
    }
  }
  return { id: "figure_artifacts", pass: findings.length === 0, findings };
}

async function checkRequiredFullModeVisuals(workspaceDir: string, manifest?: FigureManifest): Promise<ValidationCheck> {
  const config = await loadProjectConfigIfExists(workspaceDir);
  if (config?.project.mode !== "auto_research_agentic") {
    return { id: "full_mode_visual_contract", pass: true, findings: ["not a full research release mode; full visual contract is informational"] };
  }
  if (!manifest) return { id: "full_mode_visual_contract", pass: false, findings: ["full_mode_visual_contract: skipped because manifest is invalid"] };
  const quality = config.figures.quality_gates;
  const quantitativeFindings: string[] = [];
  if (manifest.figures.length < quality.min_figures) quantitativeFindings.push(`full_mode_visual_contract: ${manifest.figures.length} figures is below configured minimum ${quality.min_figures}`);
  if (manifest.tables.length < quality.min_tables) quantitativeFindings.push(`full_mode_visual_contract: ${manifest.tables.length} tables is below configured minimum ${quality.min_tables}`);
  const comparativeTables = manifest.tables.filter((table) => table.comparative).length;
  if (comparativeTables < quality.min_comparative_tables) quantitativeFindings.push(`full_mode_visual_contract: ${comparativeTables} source-grounded comparative tables is below configured minimum ${quality.min_comparative_tables}`);
  const verifiedMetadataPlots = manifest.figures.filter((figure) => figure.backend !== "nanobanana" && figure.data.length > 0).length;
  if (verifiedMetadataPlots < quality.min_verified_metadata_plots) quantitativeFindings.push(`full_mode_visual_contract: ${verifiedMetadataPlots} data-driven figures is below configured minimum ${quality.min_verified_metadata_plots}`);
  const nanobananaIllustrations = manifest.figures.filter((figure) => figure.backend === "nanobanana").length;
  if (nanobananaIllustrations > quality.max_nanobanana_illustrations) quantitativeFindings.push(`full_mode_visual_contract: ${nanobananaIllustrations} Nano Banana illustrations exceeds configured maximum ${quality.max_nanobanana_illustrations}; orienting illustrations cannot substitute for data-driven visuals`);
  if (quality.require_insight_statements) {
    for (const item of [...manifest.figures, ...manifest.tables]) {
      if (item.insight.trim().length < 24) quantitativeFindings.push(`full_mode_visual_contract: ${item.id} requires a substantive insight statement in figures/manifest.json`);
    }
  }
  const ids = new Set([...manifest.figures.map((figure) => figure.id), ...manifest.tables.map((table) => table.id)]);
  const profile = paperProfile(config.research.paper_profile);
  const required = profile.requiredVisualIds;
  const missing = required.filter((id) => !ids.has(id));
  if (profile.architectureTitleRequired) {
    const architecture = manifest.figures.find((figure) => figure.id === "concept-map");
    if (architecture && !/\b(?:system )?architecture\b/i.test(`${architecture.title} ${architecture.caption}`)) {
      quantitativeFindings.push(`full_mode_visual_contract: ${profile.id} requires concept-map to be titled/captioned as a system architecture diagram`);
    }
  }
  return {
    id: "full_mode_visual_contract",
    pass: missing.length === 0 && quantitativeFindings.length === 0,
    findings: [...missing.map((id) => `full_mode_visual_contract: missing required visual/table ${id}`), ...quantitativeFindings],
  };
}

/** These source-level checks catch the visual failures that can be decided
 * without asking a reviewer to guess: shrinking a data table to fit, a table
 * with no real caption/label, or a stale hand-numbered reference. Human/LLM
 * review still judges semantic usefulness of the rendered result. */
async function checkPublicationLayout(workspaceDir: string): Promise<ValidationCheck> {
  const findings: string[] = [];
  const sectionDir = path.join(workspaceDir, "paper", "sections");
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(sectionDir)).filter((entry) => entry.endsWith(".tex"));
  } catch {
    return { id: "publication_layout", pass: true, findings: ["paper sections not built yet; layout preflight deferred"] };
  }
  for (const entry of entries) {
    const rel = path.join("paper", "sections", entry);
    const content = await readText(workspaceDir, rel);
    if (content === null) continue;
    if (content.includes("\\resizebox{\\textwidth}{!}{%")) {
      findings.push(`publication_layout: ${rel} shrinks a table to text width; use wrapped columns or a longtable`);
    }
    if (/\\begin\{longtable\}/.test(content) && !/\\caption\{[^}]+\}\\label\{tab:/.test(content)) {
      findings.push(`publication_layout: ${rel} contains an uncaptioned or unlabeled longtable`);
    }
    if (/\b(?:Table|Figure)\s+\d+\b/.test(content)) {
      findings.push(`publication_layout: ${rel} contains a hand-numbered table/figure reference`);
    }
  }
  return { id: "publication_layout", pass: findings.length === 0, findings };
}

async function checkManuscriptReferences(workspaceDir: string, manifest?: FigureManifest): Promise<ValidationCheck> {
  const findings: string[] = [];
  if (!manifest) return { id: "figure_references", pass: false, findings: ["figure_references: skipped because manifest is invalid"] };
  const main = await readText(workspaceDir, "paper/main.tex");
  if (main === null) return { id: "figure_references", pass: true, findings };

  if (main.includes("Generated Figures and Tables")) {
    findings.push("figure_references: paper/main.tex appends a generated-artifacts section instead of embedding artifacts in chapters");
  }
  const embedded = async (kind: "fig" | "tab", item: FigureManifest["figures"][number] | FigureManifest["tables"][number]) => {
    const rel = `paper/sections/${item.placement.section_id}.tex`;
    const section = await readText(workspaceDir, rel);
    if (section === null) {
      findings.push(`figure_references: placement section ${rel} is missing for ${item.id}`);
      return;
    }
    const longtableLabel = kind === "tab" && "layout" in item && item.layout === "longtable"
      ? (await readText(workspaceDir, item.latex_path))?.includes(`\\label{tab:${item.id}}`) === true
      : false;
    if (!section.includes(`\\label{${kind}:${item.id}}`) && !longtableLabel) findings.push(`figure_references: ${item.id} is not labeled in ${rel}`);
    if (!section.includes(`\\input{${item.latex_path.replace(/^paper\//, "")}}`)) findings.push(`figure_references: ${item.id} does not embed ${item.latex_path} in ${rel}`);
    if (!section.includes(`${kind === "fig" ? "Figure" : "Table"}~\\ref{${kind}:${item.id}}`)) findings.push(`figure_references: ${item.id} has no in-text reference in ${rel}`);
  };
  for (const figure of manifest.figures) await embedded("fig", figure);
  for (const table of manifest.tables) await embedded("tab", table);
  return { id: "figure_references", pass: findings.length === 0, findings };
}

export async function validateFigureWorkspace(workspaceDir: string): Promise<ValidationReport> {
  const { check, manifest } = await checkManifest(workspaceDir);
  const checks = [
    check,
    await checkRequiredFullModeVisuals(workspaceDir, manifest),
    await checkArtifacts(workspaceDir, manifest),
    await checkManuscriptReferences(workspaceDir, manifest),
    await checkPublicationLayout(workspaceDir),
  ];
  return { pass: checks.every((item) => item.pass), checks };
}
