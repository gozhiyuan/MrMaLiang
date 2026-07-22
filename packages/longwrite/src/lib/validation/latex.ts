import fs from "node:fs/promises";
import path from "node:path";
import type { ValidationCheck, ValidationReport } from "./research.js";

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
  const findings: string[] = [];
  const main = await fileText(workspaceDir, "paper/main.tex");
  const refs = await fileText(workspaceDir, "paper/references.bib");
  const sections = await sectionFiles(workspaceDir);
  if (!main?.trim()) findings.push("latex_sources: paper/main.tex is missing or empty");
  if (!refs?.trim()) findings.push("latex_sources: paper/references.bib is missing or empty");
  if (sections.length === 0) findings.push("latex_sources: no paper/sections/*.tex files found");
  if (main && !main.includes("\\bibliography{references}")) {
    findings.push("latex_sources: paper/main.tex does not include \\bibliography{references}");
  }
  if (main && !main.includes("\\begin{abstract}")) findings.push("latex_sources: paper/main.tex is missing an abstract");
  if (main?.includes("\\tableofcontents")) findings.push("latex_sources: research paper main.tex must not add a book-style table of contents by default");
  for (const section of sections) {
    if (!main?.includes(`\\input{sections/${path.basename(section, ".tex")}.tex}`)) {
      findings.push(`latex_sources: paper/main.tex does not input ${section}`);
    }
  }
  if (main && refs) {
    const cited = new Set([...main.matchAll(/\\cite\{([^}]+)\}/g)]
      .flatMap((match) => match[1].split(",").map((key) => key.trim()).filter(Boolean)));
    const referenceKeys = new Set([...refs.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)].map((match) => match[1]));
    for (const key of cited) {
      if (!referenceKeys.has(key)) findings.push(`latex_sources: \\cite{${key}} has no matching paper/references.bib entry`);
    }
    if (cited.size > 0) {
      for (const key of referenceKeys) {
        if (!cited.has(key)) findings.push(`latex_sources: paper/references.bib contains uncited key "${key}"`);
      }
    }
  }
  return { id: "latex_sources", pass: findings.length === 0, findings };
}

async function checkOutlineStructure(workspaceDir: string): Promise<ValidationCheck> {
  const findings: string[] = [];
  let outline: { sections?: Array<{ id?: unknown; title?: unknown }> } | null = null;
  try {
    outline = JSON.parse(await fs.readFile(path.join(workspaceDir, "outline.json"), "utf-8")) as { sections?: Array<{ id?: unknown; title?: unknown }> };
  } catch {
    return { id: "latex_outline_structure", pass: true, findings: ["outline.json not present; structure check skipped"] };
  }
  const sections = (outline.sections ?? []).filter((section): section is { id: string; title: string } =>
    typeof section.id === "string" && typeof section.title === "string",
  );
  if (sections.length === 0) return { id: "latex_outline_structure", pass: false, findings: ["outline.json has no valid sections"] };
  for (const section of sections) {
    const rel = `paper/sections/${section.id}.tex`;
    const content = await fileText(workspaceDir, rel);
    if (content === null) {
      findings.push(`latex_outline_structure: missing ${rel}`);
      continue;
    }
    if (!content.startsWith(`\\section{${section.title.replace(/([#$%&_{}])/g, "\\$1")}}`)) {
      findings.push(`latex_outline_structure: ${rel} must start with the canonical outline section title "${section.title}"`);
    }
  }
  return { id: "latex_outline_structure", pass: findings.length === 0, findings };
}

async function checkBuildArtifacts(workspaceDir: string): Promise<ValidationCheck> {
  const findings: string[] = [];
  for (const rel of ["build/manuscript.tex", "build/manuscript.pdf"]) {
    try {
      const stat = await fs.stat(path.join(workspaceDir, rel));
      if (stat.size === 0) findings.push(`latex_build: ${rel} is empty`);
    } catch {
      findings.push(`latex_build: ${rel} is missing`);
    }
  }
  try {
    await fs.access(path.join(workspaceDir, "build", "main.pdf"));
    findings.push("latex_build: build/main.pdf is an intermediate duplicate; only build/manuscript.pdf may be published");
  } catch {
    // Expected canonical output contract.
  }
  const buildReport = await fileText(workspaceDir, "reports/latex-build.md");
  // Dry-run/test workspaces intentionally use the placeholder when no engine
  // exists. A real compiler that fails is different: never let that fallback
  // masquerade as a publication-ready build.
  if (buildReport?.includes("Real PDF compiled: no") && !buildReport.includes("- Engine: placeholder")) {
    findings.push("latex_build: reports/latex-build.md records a placeholder PDF rather than a real LaTeX compilation");
  }
  return { id: "latex_build", pass: findings.length === 0, findings };
}

export async function validateLatexWorkspace(workspaceDir: string): Promise<ValidationReport> {
  const checks = [
    await checkLatexSources(workspaceDir),
    await checkOutlineStructure(workspaceDir),
    await checkBuildArtifacts(workspaceDir),
  ];
  return { pass: checks.every((check) => check.pass), checks };
}
