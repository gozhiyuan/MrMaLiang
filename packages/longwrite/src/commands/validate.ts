import path from "node:path";
import { validateResearchWorkspace, writeValidationReport } from "../lib/validation/research.js";
import { loadScorecard } from "../lib/ops/scorecard.js";
import { loadProjectConfig, projectConfigErrorToFindings } from "../lib/project-config.js";
import { validateLatexWorkspace } from "../lib/validation/latex.js";
import { validateFigureWorkspace } from "../lib/validation/figures.js";
import {
  validateNovelWorkspace,
  validateTechnicalBookWorkspace,
  writeLongformValidationReport,
} from "../lib/validation/longform.js";

export async function runValidateResearch(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const report = await validateResearchWorkspace(resolved);
  const written = await writeValidationReport(resolved, report);
  console.log(`Validated LongWrite research workspace at ${resolved}`);
  for (const file of written) console.log(`  + ${file}`);
  if (!report.pass) {
    for (const check of report.checks.filter((c) => !c.pass)) {
      for (const finding of check.findings) console.error(`  ! ${finding}`);
    }
    // Seed is an offline dev fixture: release validation is advisory so a
    // free dry-run proves plumbing. Live providers get full enforcement.
    try {
      const { loadProjectConfigIfExists } = await import("../lib/project-config.js");
      const config = await loadProjectConfigIfExists(resolved);
      if (config?.research.provider === "seed") {
        console.error("  seed provider: research release validation advisory only");
        return;
      }
    } catch { /* enforce on error */ }
    process.exitCode = 1;
  }
}

/** Validator-command contract: exit non-zero with findings on stderr so the
 *  engine's retry feedback teaches the worker the exact scorecard shape. */
export async function runValidateScorecard(workspaceDir: string): Promise<void> {
  const load = await loadScorecard(path.resolve(workspaceDir));
  if (load.ok) {
    console.log(`Scorecard valid: ${load.scorecard.personas.length} personas`);
    return;
  }
  for (const finding of load.findings) console.error(finding);
  process.exitCode = 1;
}

export async function runValidateConfig(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  try {
    const config = await loadProjectConfig(resolved);
    console.log(`LongWrite config valid: ${config.project.id} (${config.project.mode})`);
  } catch (err) {
    for (const finding of projectConfigErrorToFindings(err)) console.error(finding);
    process.exitCode = 1;
  }
}

export async function runValidateLatex(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const report = await validateLatexWorkspace(resolved);
  console.log(`Validated LongWrite LaTeX workspace at ${resolved}`);
  for (const check of report.checks) {
    console.log(`  ${check.pass ? "✓" : "✗"} ${check.id}`);
    for (const finding of check.findings) console.error(`  ! ${finding}`);
  }
  if (!report.pass) process.exitCode = 1;
}

export async function runValidateFigures(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const report = await validateFigureWorkspace(resolved);
  console.log(`Validated LongWrite figure/table workspace at ${resolved}`);
  for (const check of report.checks) {
    console.log(`  ${check.pass ? "✓" : "✗"} ${check.id}`);
    for (const finding of check.findings) console.error(`  ! ${finding}`);
  }
  if (!report.pass) {
    // The seed provider is an offline dry-run fixture. Keep its visual report
    // visible, but do not make a no-spend plumbing rehearsal depend on the
    // optional local Python renderer. Full/live release runs are blocked by
    // `longwrite preflight` and retain the strict visual contract.
    const config = await loadProjectConfig(resolved).catch(() => null);
    if (config?.research.provider === "seed") {
      console.error("  seed provider: figure release validation advisory only");
      return;
    }
    process.exitCode = 1;
  }
}

export async function runValidateNovel(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const report = await validateNovelWorkspace(resolved);
  const written = await writeLongformValidationReport(resolved, report);
  console.log(`Validated LongWrite novel workspace at ${resolved}`);
  for (const file of written) console.log(`  + ${file}`);
  if (!report.pass) {
    for (const check of report.checks.filter((c) => !c.pass)) {
      for (const finding of check.findings) console.error(`  ! ${finding}`);
    }
    process.exitCode = 1;
  }
}

export async function runValidateTechnicalBook(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const report = await validateTechnicalBookWorkspace(resolved);
  const written = await writeLongformValidationReport(resolved, report);
  console.log(`Validated LongWrite technical-book workspace at ${resolved}`);
  for (const file of written) console.log(`  + ${file}`);
  if (!report.pass) {
    for (const check of report.checks.filter((c) => !c.pass)) {
      for (const finding of check.findings) console.error(`  ! ${finding}`);
    }
    process.exitCode = 1;
  }
}


/** Validator-command contract for the search_planner stage: exit non-zero
 *  with shape findings so the planner's retry sees the exact schema. */
export async function runValidateSearchPlan(workspaceDir: string): Promise<void> {
  const { loadSearchPlan, matchingTaxonomyCell } = await import("../lib/research/search-plan.js");
  const load = await loadSearchPlan(path.resolve(workspaceDir));
  if (!load.present) {
    console.error("sources/search-plan.json is missing");
    process.exitCode = 1;
    return;
  }
  if (!load.ok) {
    for (const finding of load.findings) console.error(finding);
    console.error('shape: {"version":1,"topic":"...","query_variants":["..."],"exclusion_terms":[],"venue_priorities":[]}');
    process.exitCode = 1;
    return;
  }
  const { loadProjectConfig } = await import("../lib/project-config.js");
  const config = await loadProjectConfig(path.resolve(workspaceDir));
  const uncovered = config.research.taxonomy.filter((cell) => !matchingTaxonomyCell(cell, load.plan));
  if (uncovered.length > 0) {
    for (const cell of uncovered) console.error(`sources/search-plan.json: taxonomy_cells must include configured coverage cell "${cell}" (use the label verbatim)`);
    process.exitCode = 1;
    return;
  }
  console.log(`Search plan valid: ${load.plan.query_variants.length} query variants`);
}
