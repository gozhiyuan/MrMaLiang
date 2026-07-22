import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { loadProjectConfig, loadProjectConfigIfExists } from "./project-config.js";

export type PublicationCheck = { id: string; pass: boolean; findings: string[] };
export type PublicationReport = { pass: boolean; checks: PublicationCheck[] };

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function relativeFiles(root: string, current = root): Promise<string[]> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await relativeFiles(root, target));
    else if (entry.isFile()) files.push(path.relative(root, target));
  }
  return files;
}

export async function publicationDocumentClass(workspaceDir: string): Promise<{ name: string; options: string[]; anonymous: boolean }> {
  const config = await loadProjectConfigIfExists(workspaceDir);
  if (!config) return { name: "article", options: ["11pt"], anonymous: false };
  return {
    name: config.publication.target === "custom" ? config.publication.document_class! : "article",
    options: config.publication.target === "custom" ? config.publication.document_class_options : ["11pt"],
    anonymous: config.publication.anonymous,
  };
}

/** Copy only user-provided, workspace-local template assets into paper/ before
 * compilation. LongWrite never downloads a venue template or claims one. */
export async function copyPublicationTemplateAssets(workspaceDir: string, paperDir: string): Promise<string[]> {
  const config = await loadProjectConfigIfExists(workspaceDir);
  if (!config) return [];
  if (config.publication.target !== "custom") return [];
  const root = path.resolve(workspaceDir);
  const source = path.resolve(root, config.publication.template_dir!);
  if (!within(root, source)) throw new Error("publication.template_dir must stay inside the workspace");
  const stat = await fs.stat(source).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`publication.template_dir does not exist or is not a directory: ${config.publication.template_dir}`);
  await fs.cp(source, paperDir, { recursive: true, force: true, errorOnExist: false });
  return (await relativeFiles(source)).map((rel) => path.join("paper", rel));
}

async function pageCount(pdfPath: string): Promise<number | null> {
  return await new Promise((resolve) => {
    execFile("pdfinfo", [pdfPath], { timeout: 15_000 }, (error, stdout) => {
      if (error) return resolve(null);
      const match = stdout.match(/^Pages:\s*(\d+)\s*$/mi);
      resolve(match ? Number(match[1]) : null);
    });
  });
}

async function outlineTitles(workspaceDir: string): Promise<string[]> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(workspaceDir, "outline.json"), "utf-8")) as { sections?: Array<{ title?: unknown }> };
    return (raw.sections ?? []).flatMap((section) => typeof section.title === "string" ? [section.title] : []);
  } catch {
    return [];
  }
}

export async function validatePublicationWorkspace(workspaceDir: string): Promise<PublicationReport> {
  const root = path.resolve(workspaceDir);
  const config = await loadProjectConfig(root);
  const main = await fs.readFile(path.join(root, "paper", "main.tex"), "utf-8").catch(() => "");
  const checks: PublicationCheck[] = [];
  const common: string[] = [];
  if (!main) common.push("paper/main.tex is missing; build the manuscript before packaging");
  if (main.includes("\\tableofcontents")) common.push("research-paper submission must not use a book-style table of contents");
  if (main.includes("\\date{\\today}")) common.push("submission source must not use \\date{\\today}");
  if (!main.includes("\\begin{abstract}")) common.push("paper/main.tex is missing an abstract");
  checks.push({ id: "publication_article_layout", pass: common.length === 0, findings: common });

  if (config.project.mode === "auto_research_agentic") {
    const releaseFindings: string[] = [];
    type ReleaseGateEnvelope = { version?: unknown; pass?: unknown; gates?: unknown };
    let release: ReleaseGateEnvelope | null = null;
    try {
      release = JSON.parse(await fs.readFile(path.join(root, "reports", "release-gates.json"), "utf-8")) as ReleaseGateEnvelope;
    } catch {
      releaseFindings.push("reports/release-gates.json is missing or invalid; run the final research validator before packaging");
    }
    if (release) {
      if (release.version !== 1 || !Array.isArray(release.gates)) releaseFindings.push("reports/release-gates.json has an invalid contract");
      if (release.pass !== true) releaseFindings.push("research release gates have not passed");
    }
    checks.push({ id: "publication_release_gates", pass: releaseFindings.length === 0, findings: releaseFindings });
  }

  const titles = await outlineTitles(root);
  const missingSections = config.publication.required_sections.filter((required) =>
    !titles.some((title) => title.toLocaleLowerCase().includes(required.toLocaleLowerCase())),
  );
  checks.push({
    id: "publication_required_sections",
    pass: missingSections.length === 0,
    findings: missingSections.map((title) => `required section "${title}" is absent from outline.json`),
  });

  if (config.publication.target === "custom") {
    const custom: string[] = [];
    const classPath = path.join(root, "paper", `${config.publication.document_class}.cls`);
    if (!main.includes(`\\documentclass{${config.publication.document_class}}`) && !main.includes(`{${config.publication.document_class}}`)) {
      custom.push(`paper/main.tex does not select custom class ${config.publication.document_class}`);
    }
    if (!(await fs.stat(classPath).catch(() => null))) custom.push(`paper/${config.publication.document_class}.cls is missing after template copy`);
    checks.push({ id: "publication_custom_template", pass: custom.length === 0, findings: custom });
  }

  if (config.publication.page_limit) {
    const pages = await pageCount(path.join(root, "build", "manuscript.pdf"));
    checks.push({
      id: "publication_page_limit",
      pass: pages !== null && pages <= config.publication.page_limit,
      findings: pages === null
        ? ["pdfinfo is required to verify publication.page_limit; install poppler and compile a real PDF"]
        : pages > config.publication.page_limit
          ? [`manuscript has ${pages} pages; publication.page_limit is ${config.publication.page_limit}`]
          : [`${pages} pages within publication.page_limit ${config.publication.page_limit}`],
    });
  }
  if (config.publication.min_pages) {
    const pages = await pageCount(path.join(root, "build", "manuscript.pdf"));
    checks.push({
      id: "publication_min_pages",
      pass: pages !== null && pages >= config.publication.min_pages,
      findings: pages === null
        ? ["pdfinfo is required to verify publication.min_pages; install poppler and compile a real PDF"]
        : pages < config.publication.min_pages
          ? [`manuscript has ${pages} pages; publication.min_pages is ${config.publication.min_pages}`]
          : [`${pages} pages meets publication.min_pages ${config.publication.min_pages}`],
    });
  }
  return { pass: checks.every((check) => check.pass), checks };
}

/** Create a portable, upload-ready source directory after the release checks
 * have passed. The caller may zip/tar the directory for a chosen repository. */
export async function packagePublicationWorkspace(workspaceDir: string): Promise<string[]> {
  const root = path.resolve(workspaceDir);
  const report = await validatePublicationWorkspace(root);
  if (!report.pass) throw new Error(report.checks.flatMap((check) => check.findings).join("\n"));
  const config = await loadProjectConfig(root);
  const destination = path.join(root, "build", "submission", config.publication.target);
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(path.join(root, "paper"), destination, { recursive: true });
  const manifest = {
    version: 1,
    target: config.publication.target,
    anonymous: config.publication.anonymous,
    source_root: `build/submission/${config.publication.target}`,
    required_sections: config.publication.required_sections,
    min_pages: config.publication.min_pages ?? null,
    page_limit: config.publication.page_limit ?? null,
    package_instructions: "Upload the contents of this directory as the TeX source bundle; do not include build logs or placeholder PDFs.",
  };
  const manifestPath = path.join(destination, "longwrite-submission-manifest.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  return [path.relative(root, destination), path.relative(root, manifestPath)];
}
