import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parseJsonl } from "../research/jsonl.js";
import type { ClassifiedSource } from "../research/types.js";
import { AgenticActionPlan } from "./action-plan.js";

export const OUTLINE_REVIEW_PATH = "reviews/outline-review.json";

const OutlineFinding = z.object({
  id: z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  severity: z.enum(["minor", "major", "critical"]),
  category: z.enum(["scope", "taxonomy", "evidence", "comparison", "sequence", "gap", "clarity"]),
  summary: z.string().min(20).max(2_000),
  section_ids: z.array(z.string().min(1)).max(12).default([]),
  source_ids: z.array(z.string().min(1)).max(16).default([]),
}).strict();

export const OutlineReview = z.object({
  version: z.literal(1),
  summary: z.string().min(20).max(4_000),
  strengths: z.array(z.string().min(8).max(800)).max(8).default([]),
  findings: z.array(OutlineFinding).max(12),
}).strict().superRefine((review, ctx) => {
  const ids = new Set<string>();
  review.findings.forEach((finding, index) => {
    if (ids.has(finding.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["findings", index, "id"], message: `duplicate finding id ${finding.id}` });
    ids.add(finding.id);
  });
});

function unwrapFence(raw: string): { content: string; normalized: boolean } {
  const trimmed = raw.trim();
  const matched = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  return matched ? { content: matched[1]!.trim(), normalized: true } : { content: trimmed, normalized: false };
}

async function outlineSectionIds(workspaceDir: string): Promise<Set<string>> {
  const raw = JSON.parse(await fs.readFile(path.join(workspaceDir, "outline.json"), "utf-8")) as { sections?: Array<{ id?: unknown }> };
  return new Set((raw.sections ?? []).flatMap((section) => typeof section.id === "string" ? [section.id] : []));
}

/** Validate that an LLM critique stays grounded in the current outline and
 * source corpus. It can identify weaknesses; it cannot invent sections or
 * citations as a way to manufacture an outline revision task. */
export async function repairOutlineReview(workspaceDir: string): Promise<{ normalized: boolean; reportPath: string }> {
  const target = path.join(workspaceDir, OUTLINE_REVIEW_PATH);
  const reportPath = path.join(workspaceDir, "reports", "outline-review-repair.md");
  const raw = await fs.readFile(target, "utf-8");
  const { content, normalized } = unwrapFence(raw);
  try {
    const [review, sections, sourceRaw] = await Promise.all([
      Promise.resolve(OutlineReview.parse(JSON.parse(content))),
      outlineSectionIds(workspaceDir),
      fs.readFile(path.join(workspaceDir, "sources", "classified_sources.jsonl"), "utf-8"),
    ]);
    const sources = new Set(parseJsonl<ClassifiedSource>(sourceRaw).map((source) => source.id));
    for (const finding of review.findings) {
      for (const sectionId of finding.section_ids) if (!sections.has(sectionId)) throw new Error(`finding ${finding.id} names unknown outline section ${sectionId}`);
      for (const sourceId of finding.source_ids) if (!sources.has(sourceId)) throw new Error(`finding ${finding.id} names unknown classified source ${sourceId}`);
    }
    if (normalized) {
      await fs.writeFile(`${target}.pre-normalization.md`, raw, "utf-8");
      await fs.writeFile(target, `${JSON.stringify(review, null, 2)}\n`, "utf-8");
    }
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, ["# Outline-review contract repair", "", "- Status: pass", `- Findings: ${review.findings.length}`, `- Blocking findings: ${review.findings.filter((finding) => finding.severity !== "minor").length}`, `- Envelope normalized: ${normalized ? "yes" : "no"}`, ""].join("\n"), "utf-8");
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, ["# Outline-review contract repair", "", "- Status: failed", `- Detail: ${detail}`, "- Required repair: write one JSON review grounded in current outline section IDs and classified source IDs.", ""].join("\n"), "utf-8");
    throw new Error(`${OUTLINE_REVIEW_PATH}: invalid outline-review contract; see reports/outline-review-repair.md`);
  }
  return { normalized, reportPath: "reports/outline-review-repair.md" };
}

async function readPass(workspaceDir: string, rel: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(workspaceDir, rel), "utf-8")) as { pass?: unknown };
    return parsed.pass === true;
  } catch {
    return false;
  }
}

/** The loop metric is script-owned. An LLM cannot declare its own outline
 * ready: deterministic contracts must pass and the review must contain no
 * unresolved major/critical finding. */
export async function scoreOutlineReadiness(workspaceDir: string): Promise<{ ready: boolean; reportPath: string }> {
  const [reviewRaw, surveyPass, structurePass] = await Promise.all([
    fs.readFile(path.join(workspaceDir, OUTLINE_REVIEW_PATH), "utf-8"),
    readPass(workspaceDir, "reports/survey-contract.json"),
    readPass(workspaceDir, "reports/structure-audit.json"),
  ]);
  const review = OutlineReview.parse(JSON.parse(unwrapFence(reviewRaw).content));
  const blockers = review.findings.filter((finding) => finding.severity === "major" || finding.severity === "critical");
  const ready = surveyPass && structurePass && blockers.length === 0;
  const metricsPath = path.join(workspaceDir, "reports", "metrics.json");
  let metrics: Record<string, unknown> = {};
  try { metrics = JSON.parse(await fs.readFile(metricsPath, "utf-8")) as Record<string, unknown>; } catch { /* fresh workspace */ }
  await fs.mkdir(path.dirname(metricsPath), { recursive: true });
  await fs.writeFile(metricsPath, `${JSON.stringify({
    ...metrics,
    outline_readiness: ready ? 1 : 0,
    outline_blocking_findings: blockers.length,
    outline_survey_contract_pass: surveyPass ? 1 : 0,
    outline_structure_audit_pass: structurePass ? 1 : 0,
  }, null, 2)}\n`, "utf-8");
  const reportPath = "reports/outline-readiness.md";
  await fs.writeFile(path.join(workspaceDir, reportPath), [
    "# Outline Readiness", "", `Status: ${ready ? "ready for human approval" : "revision required"}`,
    `- Survey contract: ${surveyPass ? "pass" : "fail"}`,
    `- Structure audit: ${structurePass ? "pass" : "fail"}`,
    `- Major/critical review findings: ${blockers.length}`,
    "- Official outline_readiness is script-computed; the reviewer cannot self-certify it.", "",
  ].join("\n"), "utf-8");
  return { ready, reportPath };
}

export async function writeOutlineApprovalBrief(workspaceDir: string): Promise<string> {
  let metrics: { outline_readiness?: unknown } = {};
  try { metrics = JSON.parse(await fs.readFile(path.join(workspaceDir, "reports", "metrics.json"), "utf-8")) as { outline_readiness?: unknown }; } catch { /* handled below */ }
  if (metrics.outline_readiness !== 1) throw new Error("outline approval gate requires outline_readiness = 1; inspect reports/outline-readiness.md");
  const rel = "reports/outline-approval.md";
  await fs.mkdir(path.join(workspaceDir, "reports"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, rel), ["# Outline Approval", "", "The bounded evidence-aware outline review loop passed its deterministic readiness gate.", "Continuation is controlled by research.outline_review.approval_mode in longwrite.yaml.", ""].join("\n"), "utf-8");
  return rel;
}

/** A structural reopen is intentionally narrower than ordinary prose
 * revision. The LLM may author the new outline only through the allowlisted
 * action; this script makes the resulting audit status durable and fails when
 * a selected reopen leaves either deterministic outline contract broken. */
export async function validateOutlineReopen(workspaceDir: string, actionPlanPath = "reviews/action-plan.json"): Promise<{ selected: boolean; ready: boolean; reportPath: string }> {
  const rel = "reports/outline-reopen.md";
  const raw = await fs.readFile(path.join(workspaceDir, actionPlanPath), "utf-8");
  const plan = AgenticActionPlan.parse(JSON.parse(raw));
  const selected = plan.actions.some((action) => action.tool === "reopen_outline");
  if (!selected) {
    await fs.mkdir(path.join(workspaceDir, "reports"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, rel), "# Outline Reopen\n\nStatus: not requested. The approved outline was retained this quality round.\n", "utf-8");
    return { selected: false, ready: true, reportPath: rel };
  }
  const [surveyPass, structurePass] = await Promise.all([
    readPass(workspaceDir, "reports/survey-contract.json"),
    readPass(workspaceDir, "reports/structure-audit.json"),
  ]);
  const ready = surveyPass && structurePass;
  await fs.mkdir(path.join(workspaceDir, "reports"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, rel), [
    "# Outline Reopen", "", `Status: ${ready ? "validated" : "blocked"}`,
    "", `- Survey contract: ${surveyPass ? "pass" : "fail"}`,
    `- Structure audit: ${structurePass ? "pass" : "fail"}`,
    "- The next independent manuscript review evaluates whether the structural correction actually resolves the original finding.", "",
  ].join("\n"), "utf-8");
  if (!ready) throw new Error("reopened outline failed deterministic survey/structure audit; inspect reports/outline-reopen.md");
  return { selected: true, ready, reportPath: rel };
}
