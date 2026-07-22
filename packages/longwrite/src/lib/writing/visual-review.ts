import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const RENDER_DPI = 144;
const CAPTION_PAGE_RE = /\b(?:Figure|Table)\s+\d+\s*:/i;

export type VisualRenderManifest = {
  version: 1;
  pdf_path: string;
  pdf_sha256: string;
  render_dpi: number;
  caption_pages: number[];
  rendered_pages: Array<{ page: number; path: string; sha256: string }>;
  coverage_complete: boolean;
};

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function pageCount(pdfPath: string): Promise<number> {
  const { stdout } = await execFile("pdfinfo", [pdfPath], { timeout: 15_000 });
  const match = stdout.match(/^Pages:\s+(\d+)\s*$/m);
  if (!match || Number(match[1]) < 1) throw new Error(`pdfinfo did not report a positive page count for ${pdfPath}`);
  return Number(match[1]);
}

async function captionPages(pdfPath: string, pages: number): Promise<number[]> {
  const matches: number[] = [];
  for (let page = 1; page <= pages; page += 1) {
    const { stdout } = await execFile("pdftotext", ["-layout", "-f", String(page), "-l", String(page), pdfPath, "-"], { timeout: 15_000 });
    if (CAPTION_PAGE_RE.test(stdout)) matches.push(page);
  }
  return matches;
}

/** Render every caption-bearing page as a first-class multimodal review input.
 * The PDF remains the source artifact; these PNGs are disposable evidence for
 * a reviewer to judge whether labels, arrows, tables, and captions are legible. */
export async function renderVisualReviewPages(workspaceDir: string): Promise<VisualRenderManifest> {
  const pdfPath = path.join(workspaceDir, "build", "manuscript.pdf");
  const pdf = await fs.readFile(pdfPath).catch(() => null);
  if (!pdf || pdf.length === 0) throw new Error("build/manuscript.pdf is missing or empty; build before visual review");
  const pages = await pageCount(pdfPath);
  const captions = await captionPages(pdfPath, pages);
  if (captions.length === 0) throw new Error("no Figure/Table caption pages were found in build/manuscript.pdf; a research paper visual review cannot proceed");

  const outputDir = path.join(workspaceDir, "reports", "visual-review");
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });
  const rendered: VisualRenderManifest["rendered_pages"] = [];
  for (const page of captions) {
    const rel = `reports/visual-review/page-${String(page).padStart(3, "0")}.png`;
    const target = path.join(workspaceDir, rel);
    await execFile("pdftoppm", ["-png", "-singlefile", "-r", String(RENDER_DPI), "-f", String(page), "-l", String(page), pdfPath, target.replace(/\.png$/, "")], { timeout: 30_000 });
    const bytes = await fs.readFile(target).catch(() => null);
    if (!bytes || bytes.length === 0) throw new Error(`pdftoppm did not produce ${rel}`);
    rendered.push({ page, path: rel, sha256: sha256(bytes) });
  }
  const manifest: VisualRenderManifest = {
    version: 1,
    pdf_path: "build/manuscript.pdf",
    pdf_sha256: sha256(pdf),
    render_dpi: RENDER_DPI,
    caption_pages: captions,
    rendered_pages: rendered,
    coverage_complete: true,
  };
  await fs.mkdir(path.join(workspaceDir, "reports"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "reports", "visual-render-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}
