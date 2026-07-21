import path from "node:path";
import { buildLatexWorkspace } from "../lib/writing/latex.js";
import { buildFigureWorkspace } from "../lib/writing/figures.js";
import { consolidateCitationLedger } from "../lib/research/evidence.js";

export async function runBuildFigures(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const written = await buildFigureWorkspace(resolved);
  console.log(`Built research figures and tables in ${resolved}`);
  for (const file of written) console.log(`  + ${file}`);
}

export async function runBuildLatex(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const written = await buildLatexWorkspace(resolved);
  console.log(`Built LaTeX manuscript in ${resolved}`);
  for (const file of written) console.log(`  + ${file}`);
}

export async function runBuildResearch(workspaceDir: string): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const ledger = await consolidateCitationLedger(resolved);
  const figureFiles = await buildFigureWorkspace(resolved);
  const latexFiles = await buildLatexWorkspace(resolved);
  console.log(`Built research manuscript artifacts in ${resolved}`);
  for (const file of [ledger.path, ...figureFiles, ...latexFiles]) console.log(`  + ${file}`);
}
