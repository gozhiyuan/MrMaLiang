import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkVisualReviewReleaseGate, validateVisualReview } from "../src/lib/ops/visual-review.js";
import { renderVisualReviewPages, type VisualReviewCommandRunner } from "../src/lib/writing/visual-review.js";

const dirs: string[] = [];

async function workspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-visual-qa-"));
  dirs.push(dir);
  await fs.mkdir(path.join(dir, "reports", "visual-review"), { recursive: true });
  await fs.mkdir(path.join(dir, "reviews"), { recursive: true });
  const manifest = {
    version: 1,
    pdf_path: "build/manuscript.pdf",
    pdf_sha256: "a".repeat(64),
    render_dpi: 144,
    caption_pages: [3],
    rendered_pages: [{ page: 3, path: "reports/visual-review/page-003.png", sha256: "b".repeat(64) }],
    coverage_complete: true,
  };
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  await fs.writeFile(path.join(dir, "reports", "visual-render-manifest.json"), content, "utf8");
  return dir;
}

function manifestHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

afterEach(async () => {
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true });
});

describe("rendered visual review contract", () => {
  it("records a captionless PDF as repairable failed coverage instead of crashing the workflow", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-visual-qa-"));
    dirs.push(dir);
    await fs.mkdir(path.join(dir, "build"), { recursive: true });
    // A minimal PDF with one empty page. Inject the inspection boundary so the
    // contract test does not depend on Poppler being installed on the runner.
    const pdf = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 72 72]>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000056 00000 n \n0000000109 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n178\n%%EOF\n";
    await fs.writeFile(path.join(dir, "build", "manuscript.pdf"), pdf);
    const inspect: VisualReviewCommandRunner = async (command) => {
      if (command === "pdfinfo") return { stdout: "Pages:          1\n" };
      if (command === "pdftotext") return { stdout: "" };
      throw new Error(`unexpected visual-review command: ${command}`);
    };
    const manifest = await renderVisualReviewPages(dir, inspect);
    expect(manifest).toMatchObject({ caption_pages: [], rendered_pages: [], coverage_complete: false });
    expect(manifest.coverage_failure).toContain("no Figure/Table caption pages");
    expect(JSON.parse(await fs.readFile(path.join(dir, "reports", "metrics.json"), "utf8"))).toMatchObject({ visual_reviewable_pages: 0 });
    expect(await validateVisualReview(dir)).toMatchObject({ pass: false });
  });

  it("records missing Poppler as failed coverage instead of throwing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-visual-qa-"));
    dirs.push(dir);
    await fs.mkdir(path.join(dir, "build"), { recursive: true });
    await fs.writeFile(path.join(dir, "build", "manuscript.pdf"), "%PDF-1.4\n%%EOF\n");
    const missing: VisualReviewCommandRunner = async () => {
      throw Object.assign(new Error("spawn pdfinfo ENOENT"), { code: "ENOENT" });
    };
    const manifest = await renderVisualReviewPages(dir, missing);
    expect(manifest).toMatchObject({ caption_pages: [], rendered_pages: [], coverage_complete: false });
    expect(manifest.coverage_failure).toContain("install Poppler");
    expect(await validateVisualReview(dir)).toMatchObject({ pass: false });
  });

  it("requires every rendered caption page to have a concrete visual observation", async () => {
    const dir = await workspace();
    const manifest = await fs.readFile(path.join(dir, "reports", "visual-render-manifest.json"), "utf8");
    await fs.writeFile(path.join(dir, "reviews", "visual-qa.json"), `${JSON.stringify({
      version: 1, render_manifest_sha256: manifestHash(manifest), status: "pass", inspected_pages: [3],
      observations: [{ page: 3, observation: "The architecture boxes, arrow endpoints, and caption are separated and readable at the rendered review resolution." }],
      findings: [], summary: "The rendered architecture page is readable and all labels remain distinct from arrows and neighboring nodes.",
    }, null, 2)}\n`);
    expect(await validateVisualReview(dir)).toMatchObject({ pass: true });
    expect(await checkVisualReviewReleaseGate(dir, true)).toMatchObject({ pass: true });
  });

  it("records a legitimate failing visual review without retrying it as malformed, but blocks release", async () => {
    const dir = await workspace();
    const manifest = await fs.readFile(path.join(dir, "reports", "visual-render-manifest.json"), "utf8");
    await fs.writeFile(path.join(dir, "reviews", "visual-qa.json"), `${JSON.stringify({
      version: 1, render_manifest_sha256: manifestHash(manifest), status: "fail", inspected_pages: [3],
      observations: [{ page: 3, observation: "Labels in the central architecture node overlap the adjacent arrow captions and cannot be read reliably." }],
      findings: [{ id: "overlap", severity: "critical", page: 3, summary: "Central labels and arrows overlap.", remediation: "Reflow the diagram into separate columns with bounded label widths before rebuilding." }],
      summary: "The visual layout is not publication-readable.",
    }, null, 2)}\n`);
    expect(await validateVisualReview(dir)).toMatchObject({ pass: true });
    expect(await checkVisualReviewReleaseGate(dir, true)).toMatchObject({ pass: false });
  });
});
