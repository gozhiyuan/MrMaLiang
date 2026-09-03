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
/** A measurement gate: it is satisfied by re-running the visual review, never
 * by editing an artifact, so it declares no findings and asks for diagnosis
 * when the reviewer output itself is unusable. */
function contractFail(diagnostic: string): ValidationCheck {
  return { id: gateId("visual_review_contract"), pass: false, findings: [], measurements: [], requires_diagnosis: true, diagnostic };
}

export async function validateVisualReview(workspaceDir: string): Promise<ValidationCheck> {
  const manifestPath = path.join(workspaceDir, "reports", "visual-render-manifest.json");
  const qaPath = path.join(workspaceDir, "reviews", "visual-qa.json");
  const manifest = await readJson<VisualRenderManifest>(manifestPath);
  const raw = await fs.readFile(qaPath, "utf8").catch(() => null);
  const findings: string[] = [];
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.rendered_pages) || manifest.rendered_pages.length === 0) {
    return contractFail("reports/visual-render-manifest.json is missing, invalid, or has no rendered caption pages");
  }
  if (raw === null) return contractFail("reviews/visual-qa.json is missing");
  let qa: VisualQa;
  try { qa = VisualQa.parse(JSON.parse(raw)); } catch (error) {
    return contractFail(`reviews/visual-qa.json is invalid: ${error instanceof Error ? error.message : String(error)}`);
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
  return contractPass
    ? { id: gateId("visual_review_contract"), pass: true, findings: [], measurements: [], requires_diagnosis: false }
    : contractFail(findings.join("; "));
}

export async function checkVisualReviewReleaseGate(workspaceDir: string, required: boolean): Promise<ValidationCheck> {
  const GATE = "rendered_visual_review";
  if (!required) return { id: gateId(GATE), pass: true, findings: [], measurements: [], requires_diagnosis: false,
    diagnostic: "rendered visual review is informational for the seed provider" };
  const contract = await validateVisualReview(workspaceDir);
  // The reviewer could not be trusted to have run properly, which is a
  // different failure from the reviewer reporting a defect.
  if (!contract.pass) return { id: gateId(GATE), pass: false, findings: [], measurements: [],
    requires_diagnosis: true, diagnostic: contract.diagnostic };
  const qa = VisualQa.parse(JSON.parse(await fs.readFile(path.join(workspaceDir, "reviews", "visual-qa.json"), "utf8")));
  if (qa.status === "pass") return { id: gateId(GATE), pass: true, findings: [], measurements: [], requires_diagnosis: false,
    diagnostic: "all caption-bearing PDF pages received a passing multimodal visual inspection" };
  // A rendered-page defect is repaired in the placement plan, never in the
  // generated TeX or the PDF; the page it was seen on travels as `location`.
  const findings = qa.findings.filter((finding) => finding.severity !== "minor").map((finding) => FindingSchema.parse({
    id: `${GATE}-${finding.id}`.replace(/[^A-Za-z0-9._-]+/g, "-"),
    gate_id: GATE,
    artifact: { kind: "figure_spec", path: "figures/placement-plan.json", artifact_id: finding.id },
    location: `rendered page ${finding.page}`,
    objective_scope_key: GLOBAL_SCOPE,
    required_effect: "repair_artifact_placement",
    acceptance_metric: requireDeclaredFinding(PRODUCER, gateId(GATE), "figure_spec", "repair_artifact_placement", metricId("rendered_visual_review")),
    severity: finding.severity === "critical" ? "critical" : "major",
    diagnostic: `page ${finding.page}: ${finding.summary} → ${finding.remediation}`,
  }));
  return { id: gateId(GATE), pass: false, findings, measurements: [], requires_diagnosis: findings.length === 0,
    diagnostic: "visual QA reported blocking defects" };
}

import { defineProducer, requireDeclaredFinding } from "../registry/producer-types.js";
import { gateId, metricId } from "../registry/ids.js";
import { FindingSchema } from "../registry/records.js";
import { GLOBAL_SCOPE } from "../registry/scope.js";

/** Gate declarations, kept beside the checks that emit them so a reviewer
 * sees a gate's repair semantics and its code together. The class table,
 * legal triples and routes are all generated from this. */
export const PRODUCER = defineProducer({
  module: "visual-review",
  gates: [
    { id: "visual_review_contract", class: "measurement", findings: [] },
    { id: "rendered_visual_review", class: "manuscript", observes: ["rendered_visual_review"], findings: [
      { kind: "chapter_prose", effect: "add_explicit_artifact_reference", capability: "revise_sections",
        acceptance_metric: "rendered_visual_review" },
      { kind: "figure_spec", effect: "repair_artifact_content", capability: "revise_visual_plan",
        acceptance_metric: "rendered_visual_review" },
      { kind: "figure_spec", effect: "repair_artifact_placement", capability: "revise_visual_plan",
        acceptance_metric: "rendered_visual_review" },
      { kind: "table_spec", effect: "repair_artifact_content", capability: "revise_visual_plan",
        acceptance_metric: "rendered_visual_review" },
    ] },
  ],
});
