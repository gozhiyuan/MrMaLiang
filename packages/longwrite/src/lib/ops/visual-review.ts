import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ValidationCheck } from "../validation/research.js";
import type { VisualRenderManifest } from "../writing/visual-review.js";

const Severity = z.enum(["minor", "major", "critical"]);
const VisualQa = z.object({
  version: z.literal(1),
  render_manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["pass", "fail"]),
  inspected_pages: z.array(z.number().int().positive()).min(1),
  observations: z.array(z.object({ page: z.number().int().positive(), observation: z.string().min(24).max(2_000) }).strict()).min(1),
  findings: z.array(z.object({ id: z.string().min(1), severity: Severity, page: z.number().int().positive(), summary: z.string().min(12).max(2_000), remediation: z.string().min(12).max(2_000) }).strict()),
  summary: z.string().min(24).max(4_000),
}).strict();

export type VisualQa = z.infer<typeof VisualQa>;

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as T; } catch { return null; }
}

async function writeVisualMetric(workspaceDir: string, passed: boolean): Promise<void> {
  const target = path.join(workspaceDir, "reports", "metrics.json");
  const current = await readJson<Record<string, unknown>>(target) ?? {};
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify({ ...current, visual_review_pass: passed ? 1 : 0 }, null, 2)}\n`, "utf8");
}

/** Shape and coverage validation. A `fail` result is a valid reviewer output:
 * it records a real defect for the revision loop rather than retriggering the
 * reviewer. Only malformed/incomplete visual inspection fails this validator. */
export async function validateVisualReview(workspaceDir: string): Promise<ValidationCheck> {
  const manifestPath = path.join(workspaceDir, "reports", "visual-render-manifest.json");
  const qaPath = path.join(workspaceDir, "reviews", "visual-qa.json");
  const manifest = await readJson<VisualRenderManifest>(manifestPath);
  const raw = await fs.readFile(qaPath, "utf8").catch(() => null);
  const findings: string[] = [];
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.rendered_pages) || manifest.rendered_pages.length === 0) {
    return { id: "visual_review_contract", pass: false, findings: ["reports/visual-render-manifest.json is missing, invalid, or has no rendered caption pages"] };
  }
  if (raw === null) return { id: "visual_review_contract", pass: false, findings: ["reviews/visual-qa.json is missing"] };
  let qa: VisualQa;
  try { qa = VisualQa.parse(JSON.parse(raw)); } catch (error) {
    return { id: "visual_review_contract", pass: false, findings: [`reviews/visual-qa.json is invalid: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (qa.render_manifest_sha256 !== sha256(JSON.stringify(manifest, null, 2) + "\n")) findings.push("visual QA does not match the current rendered-page manifest");
  const expected = new Set(manifest.rendered_pages.map((page) => page.page));
  const inspected = new Set(qa.inspected_pages);
  if (inspected.size !== expected.size || [...expected].some((page) => !inspected.has(page))) findings.push("visual QA must inspect every rendered caption page");
  const observed = new Set(qa.observations.map((observation) => observation.page));
  if (observed.size !== expected.size || [...expected].some((page) => !observed.has(page))) findings.push("visual QA must record one concrete observation for every rendered caption page");
  for (const finding of qa.findings) if (!expected.has(finding.page)) findings.push(`visual QA finding ${finding.id} references unrendered page ${finding.page}`);
  const blocking = qa.findings.filter((finding) => finding.severity === "major" || finding.severity === "critical");
  if (qa.status === "pass" && blocking.length > 0) findings.push("visual QA cannot pass while it reports major or critical visual defects");
  if (qa.status === "fail" && blocking.length === 0) findings.push("visual QA fail status requires at least one major or critical visual defect");
  const contractPass = findings.length === 0;
  if (contractPass) await writeVisualMetric(workspaceDir, qa.status === "pass");
  return { id: "visual_review_contract", pass: contractPass, findings };
}

export async function checkVisualReviewReleaseGate(workspaceDir: string, required: boolean): Promise<ValidationCheck> {
  if (!required) return { id: "rendered_visual_review", pass: true, findings: ["rendered visual review is informational for the seed provider"] };
  const contract = await validateVisualReview(workspaceDir);
  if (!contract.pass) return { id: "rendered_visual_review", pass: false, findings: contract.findings };
  const qa = VisualQa.parse(JSON.parse(await fs.readFile(path.join(workspaceDir, "reviews", "visual-qa.json"), "utf8")));
  return qa.status === "pass"
    ? { id: "rendered_visual_review", pass: true, findings: ["all caption-bearing PDF pages received a passing multimodal visual inspection"] }
    : { id: "rendered_visual_review", pass: false, findings: qa.findings.filter((finding) => finding.severity !== "minor").map((finding) => `page ${finding.page}: ${finding.summary} → ${finding.remediation}`) };
}
