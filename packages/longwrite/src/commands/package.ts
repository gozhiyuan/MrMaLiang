import path from "node:path";
import { packagePublicationWorkspace, validatePublicationWorkspace, writeUnpackagedSubmissionNotice } from "../lib/publication.js";
import { loadProjectConfigIfExists } from "../lib/project-config.js";

function printChecks(report: Awaited<ReturnType<typeof validatePublicationWorkspace>>): void {
  for (const check of report.checks) {
    console.log(`  ${check.pass ? "✓" : "✗"} ${check.id}`);
    for (const finding of check.findings) console.log(`    ${finding}`);
  }
}

export async function runValidatePublication(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const report = await validatePublicationWorkspace(resolved);
  console.log(`Validated publication package at ${resolved}`);
  printChecks(report);
  if (!report.pass) process.exitCode = 1;
}

export async function runPackagePublication(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  try {
    const written = await packagePublicationWorkspace(resolved);
    console.log(`Created submission source bundle at ${resolved}`);
    for (const file of written) console.log(`  + ${file}`);
  } catch (error) {
    // A seed + dry-run workspace has synthetic prose/fixtures and is used only
    // to exercise graph wiring. Keep the real packaging failure visible while
    // allowing that no-spend test path to finish; live release runs enforce it.
    const config = await loadProjectConfigIfExists(resolved);
    if (config?.research.provider === "seed") {
      const reasons = (error instanceof Error ? error.message : String(error)).split("\n").filter(Boolean);
      console.error(`seed provider: publication package advisory only (${reasons.join("; ")})`);
      // Still honor the stage's declared output, flagged as not release-ready,
      // so the rehearsal finishes without the engine reporting a stage that
      // produced nothing as a success.
      const notice = await writeUnpackagedSubmissionNotice(resolved, reasons);
      console.error(`  wrote ${notice} with release_ready: false`);
      return;
    }
    throw error;
  }
}
