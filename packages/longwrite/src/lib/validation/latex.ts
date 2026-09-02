import fs from "node:fs/promises";
import path from "node:path";
import type { ValidationCheck, ValidationReport } from "./research.js";
import { gateId } from "../registry/ids.js";
import { FindingSchema, type Finding } from "../registry/records.js";
import { GLOBAL_SCOPE } from "../registry/scope.js";

type Route = { kind: "bibliography" | "outline" | "figure_spec" | "toolchain"; effect: "repair_bibliography_consistency" | "replace_organizing_claim" | "repair_artifact_placement" | "repair_toolchain" };

const PATHS: Record<Route["kind"], string> = {
  bibliography: "sources/bibliography.bib",
  outline: "outline.json",
  figure_spec: "figures/placement-plan.json",
  toolchain: "",
};

function lFinding(gate: string, route: Route, subject: string, diagnostic: string, location?: string): Finding {
  return FindingSchema.parse({
    id: `${gate}-${subject}`.replace(/[^A-Za-z0-9._-]+/g, "-"),
    gate_id: gate,
    artifact: route.kind === "toolchain"
      ? { kind: "toolchain", target: subject }
      : { kind: route.kind, path: PATHS[route.kind], artifact_id: subject },
    ...(location === undefined ? {} : { location }),
    objective_scope_key: GLOBAL_SCOPE,
    required_effect: route.effect,
    severity: "major",
    diagnostic,
  });
}

/** A check whose defects have no owner in the current capability vocabulary.
 * paper/main.tex is generated, and nothing here edits the generator, so the
 * honest answer is to ask for diagnosis rather than to name an artifact a
 * repair would overwrite on the next render. */
function structural(gate: string, findings: Finding[], unowned: string[]): ValidationCheck {
  return {
    id: gateId(gate),
    pass: findings.length === 0 && unowned.length === 0,
    findings, measurements: [], requires_diagnosis: unowned.length > 0,
    ...(unowned.length === 0 ? {} : { diagnostic: unowned.join("; ") }),
  };
}

async function fileText(workspaceDir: string, rel: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(workspaceDir, rel), "utf-8");
  } catch {
    return null;
  }
}

async function sectionFiles(workspaceDir: string): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(workspaceDir, "paper", "sections")))
      .filter((name) => name.endsWith(".tex"))
      .sort();
  } catch {
    return [];
  }
}

async function checkLatexSources(workspaceDir: string): Promise<ValidationCheck> {
  const GATE = "latex_sources";
  // Bibliography defects have an owner; layout defects in generated TeX do
  // not, so they are reported for diagnosis instead of routed at a file the
  // next render replaces.
  const findings: Finding[] = [];
  const unowned: string[] = [];
  const bib = (subject: string, diagnostic: string) => findings.push(
    lFinding(GATE, { kind: "bibliography", effect: "repair_bibliography_consistency" }, subject, diagnostic));
  const main = await fileText(workspaceDir, "paper/main.tex");
  const refs = await fileText(workspaceDir, "paper/references.bib");
  const sections = await sectionFiles(workspaceDir);
  if (!main?.trim()) unowned.push("latex_sources: paper/main.tex is missing or empty");
  if (!refs?.trim()) bib("references", "latex_sources: paper/references.bib is missing or empty");
  if (sections.length === 0) unowned.push("latex_sources: no paper/sections/*.tex files found");
  if (main && !main.includes("\\bibliography{references}")) {
    bib("bibliography-command", "latex_sources: paper/main.tex does not include \\bibliography{references}");
  }
  if (main && !main.includes("\\begin{abstract}")) unowned.push("latex_sources: paper/main.tex is missing an abstract");
  if (main?.includes("\\tableofcontents")) unowned.push("latex_sources: research paper main.tex must not add a book-style table of contents by default");
  for (const section of sections) {
    if (!main?.includes(`\\input{sections/${path.basename(section, ".tex")}.tex}`)) {
      unowned.push(`latex_sources: paper/main.tex does not input ${section}`);
    }
  }
  if (main && refs) {
    const cited = new Set([...main.matchAll(/\\cite\{([^}]+)\}/g)]
      .flatMap((match) => match[1].split(",").map((key) => key.trim()).filter(Boolean)));
    const referenceKeys = new Set([...refs.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)].map((match) => match[1]));
    for (const key of cited) {
      if (!referenceKeys.has(key)) bib(key, `latex_sources: \\cite{${key}} has no matching paper/references.bib entry`);
    }
    if (cited.size > 0) {
      for (const key of referenceKeys) {
        if (!cited.has(key)) bib(key, `latex_sources: paper/references.bib contains uncited key "${key}"`);
      }
    }
  }
  return structural(GATE, findings, unowned);
}

async function checkOutlineStructure(workspaceDir: string): Promise<ValidationCheck> {
  const GATE = "latex_outline_structure";
  // The outline is the editable surface; the .tex files are generated from it.
  const findings: Finding[] = [];
  const fail = (subject: string, diagnostic: string, location?: string) => findings.push(
    lFinding(GATE, { kind: "outline", effect: "replace_organizing_claim" }, subject, diagnostic, location));
  let outline: { sections?: Array<{ id?: unknown; title?: unknown }> } | null = null;
  try {
    outline = JSON.parse(await fs.readFile(path.join(workspaceDir, "outline.json"), "utf-8")) as { sections?: Array<{ id?: unknown; title?: unknown }> };
  } catch {
    return { id: gateId(GATE), pass: true, findings: [], measurements: [], requires_diagnosis: false,
      diagnostic: "outline.json not present; structure check skipped" };
  }
  const sections = (outline.sections ?? []).filter((section): section is { id: string; title: string } =>
    typeof section.id === "string" && typeof section.title === "string",
  );
  if (sections.length === 0) {
    fail("sections", "outline.json has no valid sections");
    return { id: gateId(GATE), pass: false, findings, measurements: [], requires_diagnosis: false };
  }
  for (const section of sections) {
    const rel = `paper/sections/${section.id}.tex`;
    const content = await fileText(workspaceDir, rel);
    if (content === null) {
      fail(section.id, `latex_outline_structure: missing ${rel}`, rel);
      continue;
    }
    if (!content.startsWith(`\\section{${section.title.replace(/([#$%&_{}])/g, "\\$1")}}`)) {
      fail(section.id, `latex_outline_structure: ${rel} must start with the canonical outline section title "${section.title}"`, rel);
    }
  }
  return { id: gateId(GATE), pass: findings.length === 0, findings, measurements: [], requires_diagnosis: false };
}

async function checkBuildArtifacts(workspaceDir: string): Promise<ValidationCheck> {
  const GATE = "latex_build";
  // A build failure is an operator matter: nothing this product owns installs
  // or repairs a LaTeX engine.
  const findings: Finding[] = [];
  const fail = (subject: string, diagnostic: string) => findings.push(
    lFinding(GATE, { kind: "toolchain", effect: "repair_toolchain" }, subject, diagnostic));
  for (const rel of ["build/manuscript.tex", "build/manuscript.pdf"]) {
    try {
      const stat = await fs.stat(path.join(workspaceDir, rel));
      if (stat.size === 0) fail(path.basename(rel), `latex_build: ${rel} is empty`);
    } catch {
      fail(path.basename(rel), `latex_build: ${rel} is missing`);
    }
  }
  try {
    await fs.access(path.join(workspaceDir, "build", "main.pdf"));
    fail("main.pdf", "latex_build: build/main.pdf is an intermediate duplicate; only build/manuscript.pdf may be published");
  } catch {
    // Expected canonical output contract.
  }
  const buildReport = await fileText(workspaceDir, "reports/latex-build.md");
  // Dry-run/test workspaces intentionally use the placeholder when no engine
  // exists. A real compiler that fails is different: never let that fallback
  // masquerade as a publication-ready build.
  if (buildReport?.includes("Real PDF compiled: no") && !buildReport.includes("- Engine: placeholder")) {
    fail("engine", "latex_build: reports/latex-build.md records a placeholder PDF rather than a real LaTeX compilation");
  }
  return { id: gateId(GATE), pass: findings.length === 0, findings, measurements: [], requires_diagnosis: false };
}

/** Keep operational bookkeeping out of the reader-facing manuscript. These
 * deterministic checks complement (rather than replace) the reviewer's
 * contextual judgment of whether a selected analytical artifact is useful. */
async function checkReaderFacingPublication(workspaceDir: string): Promise<ValidationCheck> {
  const GATE = "reader_facing_publication";
  // Every defect here is bookkeeping that leaked into the reader-facing
  // manuscript through the placement plan that generates it.
  const findings: Finding[] = [];
  const fail = (subject: string, diagnostic: string) => findings.push(
    lFinding(GATE, { kind: "figure_spec", effect: "repair_artifact_placement" }, subject, diagnostic));
  const main = await fileText(workspaceDir, "paper/main.tex") ?? "";
  const sections = await Promise.all((await sectionFiles(workspaceDir)).map((name) => fileText(workspaceDir, `paper/sections/${name}`)));
  const body = [main, ...sections].filter((value): value is string => Boolean(value)).join("\n");
  if (/Execution provenance:|Runtime\/model units:/i.test(body)) {
    fail("provenance", "reader_facing_publication: internal execution provenance leaked into the manuscript; retain it in reports/run-provenance instead");
  }
  if (/Metric\s*&\s*Value\s*&\s*Metric\s*&\s*Value|Cited sources\s*&.*Figures/i.test(main)) {
    fail("telemetry", "reader_facing_publication: production-statistics telemetry table must not appear in the manuscript");
  }
  if (/The following (?:figure|table) supports this section/i.test(body)) {
    fail("lead-ins", "reader_facing_publication: replace mechanical figure/table lead-ins with the artifact's specific comparison, inference, or limitation");
  }
  // Check only the tables the manuscript actually inputs. `paper/tables/` also
  // accumulates files from earlier rounds, and a table the manuscript no longer
  // includes cannot reach a reader — failing on one blocks a clean manuscript
  // over build residue, and no amount of agent revision can clear it, because
  // nothing the agent rewrites references those files.
  const included = [...body.matchAll(/\\input\{tables\/([^}]+?)(?:\.tex)?\}/g)].map((match) => `${match[1]}.tex`);
  const tables = await Promise.all([...new Set(included)].map((name) => fileText(workspaceDir, `paper/tables/${name}`)));
  if (/(?:Full source title|Paper \(full title\)|Venue \(full name\)|Packet evidence|Record status)/i.test(tables.filter((value): value is string => Boolean(value)).join("\n"))) {
    fail("inventory-table", "reader_facing_publication: source-inventory or pipeline-status table detected; use the bibliography and retain only analytical comparison columns");
  }
  return { id: gateId(GATE), pass: findings.length === 0, findings, measurements: [], requires_diagnosis: false };
}

export async function validateLatexWorkspace(workspaceDir: string): Promise<ValidationReport> {
  const checks = [
    await checkLatexSources(workspaceDir),
    await checkOutlineStructure(workspaceDir),
    await checkBuildArtifacts(workspaceDir),
    await checkReaderFacingPublication(workspaceDir),
  ];
  return { pass: checks.every((check) => check.pass), checks };
}

import { defineProducer } from "../registry/producer-types.js";

/** Gate declarations, kept beside the checks that emit them so a reviewer
 * sees a gate's repair semantics and its code together. The class table,
 * legal triples and routes are all generated from this. */
export const PRODUCER = defineProducer({
  module: "latex",
  gates: [
    { id: "latex_sources", class: "manuscript", findings: [
      { kind: "figure_spec", effect: "repair_artifact_placement", capability: "revise_visual_plan" },
      // Most of what this gate detects is a bibliography that does not resolve
      // against what main.tex cites. Layout defects in generated TeX have no
      // owner in the capability vocabulary and request diagnosis instead.
      { kind: "bibliography", effect: "repair_bibliography_consistency", capability: "repair_bibliography" },
    ] },
    { id: "latex_outline_structure", class: "manuscript", findings: [
      { kind: "outline", effect: "replace_organizing_claim", capability: "reopen_outline" },
    ] },
    { id: "latex_build", class: "manuscript", findings: [
      { kind: "figure_spec", effect: "repair_artifact_placement", capability: "revise_visual_plan" },
      { kind: "bibliography", effect: "repair_bibliography_consistency", capability: "repair_bibliography" },
      { kind: "toolchain", effect: "repair_toolchain", capability: "request_operator_clarification" },
    ] },
    { id: "reader_facing_publication", class: "manuscript", findings: [
      { kind: "figure_spec", effect: "repair_artifact_placement", capability: "revise_visual_plan" },
    ] },
  ],
});
