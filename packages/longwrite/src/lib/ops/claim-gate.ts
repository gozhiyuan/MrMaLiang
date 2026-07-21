import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/** Claim-level review gate, deterministic half. An LLM judge stage writes
 *  reviews/claim-judgments.jsonl (one verdict per [source:id] claim pair);
 *  this scorer — not the judge — computes the official claim_support_rate
 *  into reports/metrics.json, so a loop gated on it cannot be passed by
 *  asserting a number. Verdicts: entailed (1.0), partial (0.5),
 *  unsupported (0). Rate = weighted mean over judged claims. */

export const ClaimJudgment = z.object({
  sample_id: z.string().min(1).optional(),
  reviewer_id: z.string().min(1).optional(),
  source_id: z.string().min(1),
  chapter: z.string().min(1),
  claim: z.string().min(1),
  evidence_ref: z.string().optional(),
  // Older prompts described locators without constraining their shape. Accept
  // either compact strings or structured packet/paragraph locators, then keep
  // them intact in the auditable judgment record.
  evidence_locators: z.array(z.union([z.string().min(1), z.record(z.unknown())])).default([]),
  prompt_hash: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  runtime: z.string().min(1).optional(),
  verdict: z.enum(["entailed", "partial", "unsupported"]),
  rationale: z.string().optional(),
}).strict();
export type ClaimJudgment = z.infer<typeof ClaimJudgment>;

export const CLAIM_JUDGMENTS_PATH = "reviews/claim-judgments.jsonl";

export type ClaimGateResult = {
  judged: number;
  entailed: number;
  partial: number;
  unsupported: number;
  supportRate: number;
  doubleReviewed: number;
  disagreements: number;
  findings: string[];
};

export type ClaimJudgmentRepairResult = {
  normalized: boolean;
  judgments: number;
  reportPath: string;
};

/** Normalize the two harmless envelopes models commonly produce for a JSONL
 * contract: one JSON array or one JSON object. This is deliberately syntax
 * repair only: every row is schema-validated and malformed semantic output is
 * retained in the report and fails visibly instead of being silently dropped. */
export async function repairClaimJudgments(workspaceDir: string): Promise<ClaimJudgmentRepairResult> {
  const target = path.join(workspaceDir, CLAIM_JUDGMENTS_PATH);
  const reportPath = path.join(workspaceDir, "reports", "claim-judgment-repair.md");
  const raw = await fs.readFile(target, "utf-8");
  const trimmed = raw.trim();
  let rows: unknown[];
  let normalized = false;
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      rows = parsed;
      normalized = true;
    } else if (parsed && typeof parsed === "object") {
      rows = [parsed];
      normalized = true;
    } else {
      rows = raw.split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
    }
  } catch {
    try {
      rows = raw.split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
    } catch (error) {
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(reportPath, [
        "# Claim-judgment contract repair",
        "",
        "- Status: failed",
        "- The judge output is neither a JSON array/object nor valid JSONL.",
        `- Detail: ${error instanceof Error ? error.message : String(error)}`,
        "- Required repair: ask the claim judge to write one schema-valid object per line; do not wrap rows in an array or Markdown fence.",
        "",
      ].join("\n"), "utf-8");
      throw new Error(`${CLAIM_JUDGMENTS_PATH}: invalid JSONL contract; see reports/claim-judgment-repair.md`);
    }
  }

  const findings: string[] = [];
  const judgments = rows.flatMap((row, index) => {
    const parsed = ClaimJudgment.safeParse(row);
    if (parsed.success) return [parsed.data];
    findings.push(`row ${index + 1}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "row"} ${issue.message}`).join("; ")}`);
    return [];
  });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  if (findings.length > 0 || judgments.length === 0) {
    await fs.writeFile(reportPath, [
      "# Claim-judgment contract repair",
      "",
      "- Status: failed",
      `- Valid rows: ${judgments.length}/${rows.length}`,
      "- The source file was not rewritten because repair would discard or alter malformed judgments.",
      "- Required repair: have the claim judge rewrite every row as a JSONL object matching the stated contract.",
      "",
      "## Validation findings",
      "",
      ...findings.map((finding) => `- ${finding}`),
      "",
    ].join("\n"), "utf-8");
    throw new Error(`${CLAIM_JUDGMENTS_PATH}: ${findings.length} invalid judgment row(s); see reports/claim-judgment-repair.md`);
  }

  if (normalized) {
    await fs.writeFile(`${target}.pre-normalization.json`, raw, "utf-8");
    await fs.writeFile(target, `${judgments.map((judgment) => JSON.stringify(judgment)).join("\n")}\n`, "utf-8");
  }
  await fs.writeFile(reportPath, [
    "# Claim-judgment contract repair",
    "",
    "- Status: pass",
    `- Valid judgments: ${judgments.length}`,
    `- Envelope normalized: ${normalized ? "yes" : "no"}`,
    ...(normalized ? ["- Original preserved: reviews/claim-judgments.jsonl.pre-normalization.json"] : []),
    "",
  ].join("\n"), "utf-8");
  return { normalized, judgments: judgments.length, reportPath: "reports/claim-judgment-repair.md" };
}

export async function scoreClaimGate(workspaceDir: string): Promise<ClaimGateResult> {
  const raw = await fs.readFile(path.join(workspaceDir, CLAIM_JUDGMENTS_PATH), "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const findings: string[] = [];
  const judgments: ClaimJudgment[] = [];
  lines.forEach((line, i) => {
    try {
      judgments.push(ClaimJudgment.parse(JSON.parse(line)));
    } catch (err) {
      findings.push(`line ${i + 1}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
  });
  if (judgments.length === 0) throw new Error(`${CLAIM_JUDGMENTS_PATH}: no valid judgments\n${findings.join("\n")}`);
  const grouped = new Map<string, ClaimJudgment[]>();
  for (const judgment of judgments) {
    const key = judgment.sample_id ?? `${judgment.chapter}|${judgment.source_id}|${judgment.claim}`;
    const rows = grouped.get(key) ?? [];
    rows.push(judgment);
    grouped.set(key, rows);
  }
  const doubleReviewed = [...grouped.values()]
    .filter((rows) => new Set(rows.map((row) => row.reviewer_id ?? "anonymous")).size >= 2)
    .length;
  const disagreements = [...grouped.values()]
    .filter((rows) => new Set(rows.map((row) => row.verdict)).size > 1)
    .length;

  const entailed = judgments.filter((j) => j.verdict === "entailed").length;
  const partial = judgments.filter((j) => j.verdict === "partial").length;
  const unsupported = judgments.length - entailed - partial;
  const supportRate = Number(((entailed + 0.5 * partial) / judgments.length).toFixed(3));

  const metricsPath = path.join(workspaceDir, "reports", "metrics.json");
  let metrics: Record<string, unknown> = {};
  try { metrics = JSON.parse(await fs.readFile(metricsPath, "utf-8")); } catch { /* fresh */ }
  await fs.mkdir(path.dirname(metricsPath), { recursive: true });
  await fs.writeFile(metricsPath, JSON.stringify({
    ...metrics,
    claim_support_rate: supportRate,
    claims_judged: judgments.length,
    claims_unsupported: unsupported,
    claim_samples: grouped.size,
    claim_samples_double_reviewed: doubleReviewed,
    claim_review_disagreements: disagreements,
  }, null, 2), "utf-8");

  const unsupportedList = judgments.filter((j) => j.verdict === "unsupported")
    .map((j) => `- [${j.chapter}] ${j.claim.slice(0, 140)} (${j.source_id})`);
  await fs.writeFile(path.join(workspaceDir, "reports", "claim-gate.md"), [
    "# Claim Support Gate",
    "",
    `Judged ${judgments.length} claims: ${entailed} entailed, ${partial} partial, ${unsupported} unsupported.`,
    `Samples: ${grouped.size}; double-reviewed: ${doubleReviewed}; disagreements: ${disagreements}.`,
    `Official claim_support_rate: ${supportRate} (computed by the deterministic scorer, not the judge).`,
    "",
    ...(unsupportedList.length > 0 ? ["## Unsupported claims (fix or re-cite)", "", ...unsupportedList, ""] : []),
    ...(findings.length > 0 ? ["## Malformed judgment lines", "", ...findings.map((f) => `- ${f}`), ""] : []),
  ].join("\n"), "utf-8");

  return { judged: judgments.length, entailed, partial, unsupported, supportRate, doubleReviewed, disagreements, findings };
}
