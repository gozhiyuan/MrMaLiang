import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const AcceptanceCriterion = z.object({
  /** Each metric is mechanically observable in the workspace or by the
   * next independent reviewer; free-form success claims are not accepted. */
  metric: z.enum(["cited_sources", "cited_within_one_year_ratio", "accepted_cited_ratio", "cited_arxiv_only_ratio", "citations_per_page", "citation_depth_per_section", "taxonomy_cell_ab_sources", "core_sources", "comparative_tables", "verified_metadata_plots", "figures", "tables", "empirical_trials", "outline_readiness"]),
  target: z.number().nonnegative(),
  scope: z.string().min(1).max(160).optional(),
}).strict();

/** The only content an agentic planner may choose. Tool authorization lives in
 * MalaClaw's workflow catalog; this file makes planner output durable,
 * inspectable, and safe to hand to that catalog. */
export const AgenticActionPlan = z.object({
  version: z.literal(1),
  findings: z.array(z.object({
    id: z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    severity: z.enum(["minor", "major", "critical"]),
    summary: z.string().min(1).max(8_000),
  }).strict()).max(100),
  actions: z.array(z.object({
    id: z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    tool: z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    finding_ids: z.array(z.string().min(1)).min(1).max(30),
    rationale: z.string().min(1).max(8_000),
    acceptance_criteria: z.array(AcceptanceCriterion).min(1).max(5).default([]),
  }).strict()).max(20),
}).strict().superRefine((plan, ctx) => {
  const findings = new Set<string>();
  for (const [index, finding] of plan.findings.entries()) {
    if (findings.has(finding.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["findings", index, "id"], message: `duplicate finding id ${finding.id}` });
    findings.add(finding.id);
  }
  const actions = new Set<string>();
  for (const [index, action] of plan.actions.entries()) {
    if (actions.has(action.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["actions", index, "id"], message: `duplicate action id ${action.id}` });
    actions.add(action.id);
    for (const findingId of action.finding_ids) {
      if (!findings.has(findingId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["actions", index, "finding_ids"], message: `unknown finding id ${findingId}` });
    }
  }
});

export type AgenticActionPlan = z.infer<typeof AgenticActionPlan>;

function unwrapFence(raw: string): { content: string; normalized: boolean } {
  const trimmed = raw.trim();
  const matched = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  return matched ? { content: matched[1]!.trim(), normalized: true } : { content: trimmed, normalized: false };
}

/** One catalog action owns one bounded output contract per round.  Planners
 * naturally split independent findings into separate actions, but invoking a
 * table/visual-plan writer twice would race on the same placement-plan.json.
 * Coalesce duplicates deterministically instead of rejecting an otherwise
 * valid remediation plan and wasting an entire review round. */
function mergeDuplicateToolActions(plan: AgenticActionPlan): { plan: AgenticActionPlan; merged: string[] } {
  const byTool = new Map<string, AgenticActionPlan["actions"][number]>();
  const actions: AgenticActionPlan["actions"] = [];
  const merged = new Set<string>();
  for (const action of plan.actions) {
    const earlier = byTool.get(action.tool);
    if (!earlier) {
      const copy = { ...action, finding_ids: [...action.finding_ids] };
      byTool.set(copy.tool, copy);
      actions.push(copy);
      continue;
    }
    earlier.finding_ids = [...new Set([...earlier.finding_ids, ...action.finding_ids])];
    const combined = `${earlier.rationale}\n\nAlso address: ${action.rationale}`;
    earlier.rationale = combined.length <= 8_000
      ? combined
      : `${combined.slice(0, 7_800).trimEnd()}\n\n[Additional rationale truncated by bounded plan repair.]`;
    earlier.acceptance_criteria = [...earlier.acceptance_criteria, ...action.acceptance_criteria]
      .filter((criterion, index, all) => all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(criterion)) === index);
    merged.add(action.tool);
  }
  return { plan: AgenticActionPlan.parse({ ...plan, actions }), merged: [...merged] };
}

/** Repair only a full JSON Markdown fence. It never invents actions, drops
 * findings, or loosens the action schema; malformed semantic output remains a
 * visible, actionable failure. */
export async function repairAgenticActionPlan(workspaceDir: string): Promise<{ normalized: boolean; merged: string[]; reportPath: string }> {
  const target = path.join(workspaceDir, "reviews", "action-plan.json");
  const reportPath = path.join(workspaceDir, "reports", "action-plan-repair.md");
  const raw = await fs.readFile(target, "utf-8");
  const { content, normalized } = unwrapFence(raw);
  let plan: AgenticActionPlan;
  try {
    plan = AgenticActionPlan.parse(JSON.parse(content));
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, [
      "# Agentic action-plan contract repair", "", "- Status: failed",
      `- Detail: ${detail}`,
      "- Required repair: write exactly one JSON object matching the action-plan schema. Do not use an array, prose, or invented tool ids.", "",
    ].join("\n"), "utf-8");
    throw new Error("reviews/action-plan.json: invalid action-plan contract; see reports/action-plan-repair.md");
  }
  const merged = mergeDuplicateToolActions(plan);
  plan = merged.plan;
  const changed = normalized || merged.merged.length > 0;
  if (changed) {
    await fs.writeFile(`${target}.pre-normalization.md`, raw, "utf-8");
    await fs.writeFile(target, `${JSON.stringify(plan, null, 2)}\n`, "utf-8");
  }
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, [
    "# Agentic action-plan contract repair", "", "- Status: pass",
    `- Findings: ${plan.findings.length}`,
    `- Selected actions: ${plan.actions.length}`,
    ...plan.actions.flatMap((action) => [
      `- ${action.id} criteria: ${action.acceptance_criteria.map((criterion) => `${criterion.metric}${criterion.scope ? `(${criterion.scope})` : ""} >= ${criterion.target}`).join("; ")}`,
    ]),
    `- Envelope normalized: ${normalized ? "yes" : "no"}`,
    `- Duplicate tool actions merged: ${merged.merged.length > 0 ? merged.merged.join(", ") : "none"}`,
    ...(changed ? ["- Original preserved: reviews/action-plan.json.pre-normalization.md"] : []), "",
  ].join("\n"), "utf-8");
  return { normalized, merged: merged.merged, reportPath: "reports/action-plan-repair.md" };
}

/** Preserve one LLM decision record while dispatching it in dependency order:
 * research refresh first, then structural rewrite, then prose/visual repair.
 * This lets a same-round editor consume newly validated evidence instead of
 * revising from stale section packets. */
export async function splitAgenticActionPlan(workspaceDir: string, actionPlanPath = "reviews/action-plan.json"): Promise<{ reportPath: string; written: string[] }> {
  const raw = await fs.readFile(path.join(workspaceDir, actionPlanPath), "utf-8");
  const plan = AgenticActionPlan.parse(JSON.parse(raw));
  const groups: Array<[string, Set<string>]> = [
    ["research-action-plan.json", new Set(["targeted_research_expansion"])],
    ["outline-action-plan.json", new Set(["reopen_outline"])],
    ["revision-action-plan.json", new Set(["revise_sections", "revise_visual_plan", "request_operator_clarification"])],
  ];
  const written: string[] = [];
  await fs.mkdir(path.join(workspaceDir, "reviews"), { recursive: true });
  for (const [name, tools] of groups) {
    const subset = AgenticActionPlan.parse({ ...plan, actions: plan.actions.filter((action) => tools.has(action.tool)) });
    const rel = `reviews/${name}`;
    await fs.writeFile(path.join(workspaceDir, rel), `${JSON.stringify(subset, null, 2)}\n`, "utf-8");
    written.push(rel);
  }
  const reportPath = "reports/action-plan-split.md";
  await fs.mkdir(path.join(workspaceDir, "reports"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, reportPath), [
    "# Agentic action-plan phase split", "",
    "- Research actions run before semantic/full-text evidence refresh.",
    "- Structural actions run after refreshed evidence and before reallocation.",
    "- Prose/visual actions run last, using the current section evidence packets.",
    ...groups.map(([name, tools]) => `- ${name}: ${plan.actions.filter((action) => tools.has(action.tool)).map((action) => action.tool).join(", ") || "none"}`), "",
  ].join("\n"), "utf-8");
  return { reportPath, written: [...written, reportPath] };
}

/** Materialize a narrow operator brief from an already validated plan. The
 * planner supplies the question in its rationale; this deterministic adapter
 * preserves the exact finding text and creates a stable file for the dashboard
 * and a human to inspect before approving continuation. */
export async function writeOperatorClarificationRequest(workspaceDir: string, actionPlanPath = "reviews/action-plan.json"): Promise<string> {
  const raw = await fs.readFile(path.join(workspaceDir, actionPlanPath), "utf-8");
  const plan = AgenticActionPlan.parse(JSON.parse(raw));
  const selected = plan.actions.filter((action) => action.tool === "request_operator_clarification");
  if (selected.length !== 1 || plan.actions.length !== 1) {
    throw new Error("operator clarification requires exactly one request_operator_clarification action");
  }
  const action = selected[0]!;
  const findings = new Map(plan.findings.map((finding) => [finding.id, finding]));
  const requested = action.finding_ids.map((id) => findings.get(id)).filter((finding): finding is NonNullable<typeof finding> => Boolean(finding));
  const target = path.join(workspaceDir, "reviews", "clarification-request.md");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, [
    "# Operator clarification requested", "",
    "The adaptive planner paused rather than guessing. Add a concise answer to `feedback/user-feedback.md`, then approve this action and resume the flow.",
    "",
    "## Requested decision", "", action.rationale, "",
    "## Findings requiring a decision", "",
    ...requested.flatMap((finding) => [`- **${finding.id}** (${finding.severity}): ${finding.summary}`]),
    "",
  ].join("\n"), "utf-8");
  return "reviews/clarification-request.md";
}
