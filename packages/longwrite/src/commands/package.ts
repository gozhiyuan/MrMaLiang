import path from "node:path";
import { packagePublicationWorkspace, validatePublicationWorkspace } from "../lib/publication.js";
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
      console.error(`seed provider: publication package advisory only (${error instanceof Error ? error.message : String(error)})`);
      return;
    }
    throw error;
  }
}
