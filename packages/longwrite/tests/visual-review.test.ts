import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkVisualReviewReleaseGate, validateVisualReview } from "../src/lib/ops/visual-review.js";

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
