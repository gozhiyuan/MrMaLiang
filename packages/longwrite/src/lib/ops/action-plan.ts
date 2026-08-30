import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadProjectConfig } from "../project-config.js";

export const AcceptanceCriterion = z.object({
  /** Each metric is mechanically observable in the workspace or by the
   * next independent reviewer; free-form success claims are not accepted.
   * Keep this list in sync with the `action_plan` planner instruction in
   * `src/workflow/composition.ts` (the "Use cited_sources, ..." sentence) —
   * see tests/action-plan-metric-sync.test.ts, which fails if they drift. */
  metric: z.enum(["cited_sources", "cited_within_one_year_ratio", "accepted_cited_ratio", "cited_arxiv_only_ratio", "citations_per_page", "citation_depth_per_section", "taxonomy_cell_ab_sources", "core_sources", "comparative_tables", "verified_metadata_plots", "figures", "tables", "rendered_visual_review", "empirical_trials", "outline_readiness", "review_score", "claim_support", "landmark_coverage_ratio", "claim_contradictions", "prose_redundancy", "diagram_connectivity"]),
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
    // The durable action-plan contract allows at most five criteria. A routed
    // citation-weaving action can merge into an existing revision action, so
    // preserve the earliest distinct criteria deterministically instead of
    // turning an otherwise valid plan into a schema failure.
    earlier.acceptance_criteria = [...earlier.acceptance_criteria, ...action.acceptance_criteria]
      .filter((criterion, index, all) => all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(criterion)) === index)
      .slice(0, 5);
    merged.add(action.tool);
  }
  return { plan: AgenticActionPlan.parse({ ...plan, actions }), merged: [...merged] };
}

export type EvidenceCapacity = {
  requiresExpansion: boolean;
  reasons: string[];
  citedSourceTarget: number;
};

/** Keep the expansion router aligned with the release validator.  A DOI is a
 * useful acceptance signal only when the record is not explicitly a preprint
 * or unknown venue; this is deliberately the same conservative policy that
 * determines the published-source gate. */
function isAcceptedSource(record: {
  identity?: { publication_status?: unknown };
  identifiers?: { doi?: unknown };
  venue?: unknown;
}): boolean {
  const status = typeof record.identity?.publication_status === "string"
    ? record.identity.publication_status.toLowerCase()
    : "";
  if (/(accepted|published|inproceedings|journal|proceedings)/.test(status)) return true;
  return typeof record.identifiers?.doi === "string"
    && !/(arxiv|preprint|unknown)/i.test(typeof record.venue === "string" ? record.venue : "");
}

/** Determine whether the currently allocated evidence can possibly satisfy
 * the configured cited-source and depth release gates.  Corpus gates measure
 * retrieval quality; they are intentionally not treated as proof that enough
 * packet-backed sources exist for this particular manuscript target. */
export async function evidenceCapacity(workspaceDir: string, requiredAcceptedRatio = 0): Promise<EvidenceCapacity> {
  try {
    const config = await loadProjectConfig(workspaceDir);
    const gates = config.research.release_gates;
    const activeEvidence = await fs.readFile(path.join(workspaceDir, "evidence", "active-validated-source-evidence.json"), "utf-8")
      .then((raw) => JSON.parse(raw) as { entries?: Array<{ packet?: { source_id?: unknown; claims?: unknown[] } }> })
      .catch(() => ({ entries: [] }));
    const claimValidatedIds = new Set((activeEvidence.entries ?? []).flatMap((entry) =>
      typeof entry.packet?.source_id === "string" && Array.isArray(entry.packet.claims) && entry.packet.claims.length > 0
        ? [entry.packet.source_id] : []));
    const packetsDir = path.join(workspaceDir, "evidence");
    const packetNames = (await fs.readdir(packetsDir)).filter((name) => /^section-.*\.json$/.test(name));
    const sourceIds = new Set<string>();
    const sectionSourceIds = new Map<string, Set<string>>();
    for (const name of packetNames) {
      const packet = JSON.parse(await fs.readFile(path.join(packetsDir, name), "utf-8")) as {
        section_id?: unknown;
        chunks?: Array<{ source_id?: unknown }>;
      };
      if (typeof packet.section_id !== "string" || !Array.isArray(packet.chunks)) continue;
      // A declared packet source can be metadata-only.  Only a source with an
      // actual evidence chunk can support a release-safe marker.
      const ids = new Set(packet.chunks.flatMap((chunk) =>
        typeof chunk.source_id === "string" && claimValidatedIds.has(chunk.source_id) ? [chunk.source_id] : []));
      sectionSourceIds.set(packet.section_id, ids);
      for (const id of ids) sourceIds.add(id);
    }

    const depths = new Map<string, "A" | "B" | "C">();
    const acceptedIds = new Set<string>();
    try {
      const rows = (await fs.readFile(path.join(workspaceDir, "sources", "classified_sources.jsonl"), "utf-8"))
        .split("\n").filter(Boolean);
      for (const row of rows) {
        const source = JSON.parse(row) as {
          id?: unknown;
          citation_depth?: unknown;
          identity?: { publication_status?: unknown };
          identifiers?: { doi?: unknown };
          venue?: unknown;
        };
        if (typeof source.id === "string" && (source.citation_depth === "A" || source.citation_depth === "B" || source.citation_depth === "C")) {
          depths.set(source.id, source.citation_depth);
        }
        if (typeof source.id === "string" && isAcceptedSource(source)) acceptedIds.add(source.id);
      }
    } catch {
      // A missing classification file means the planner must preserve any
      // selected expansion instead of assuming the requested depth exists.
    }

    const reasons: string[] = [];
    if (sourceIds.size < gates.min_cited_sources) {
      reasons.push(`configured minimum cited sources is ${gates.min_cited_sources}, but current section packets expose only ${sourceIds.size}`);
    }
    const acceptedRatio = Math.max(gates.min_accepted_cited_ratio, requiredAcceptedRatio);
    if (acceptedRatio > 0) {
      const requiredAccepted = Math.ceil(Math.max(gates.min_cited_sources, sourceIds.size) * acceptedRatio);
      const availableAccepted = [...sourceIds].filter((id) => acceptedIds.has(id)).length;
      if (availableAccepted < requiredAccepted) {
        reasons.push(`accepted-source target requires ${requiredAccepted} packet-backed accepted sources at ratio ${acceptedRatio}, but current section packets expose only ${availableAccepted}`);
      }
    }
    const targets = gates.min_citation_depths_per_section;
    for (const [sectionId, ids] of sectionSourceIds) {
      for (const depth of ["A", "B", "C"] as const) {
        const available = [...ids].filter((id) => depths.get(id) === depth).length;
        if (available < targets[depth]) {
          reasons.push(`section ${sectionId} needs ${targets[depth]} ${depth}-depth sources, but its packet exposes ${available}`);
        }
      }
    }
    // If allocation is absent but the workspace has a nonzero evidence
    // target, expansion remains safer than silently converting it to prose
    // revision. The normal allocation stages will make this observable.
    if (packetNames.length === 0 && (gates.min_cited_sources > 0 || Object.values(targets).some((value) => value > 0))) {
      reasons.push("no section evidence packets are available to demonstrate release-gate capacity");
    }
    return { requiresExpansion: reasons.length > 0, reasons, citedSourceTarget: gates.min_cited_sources };
  } catch {
    // Older/manual workspaces may not have a LongWrite config. Preserve the
    // selected action in that case rather than making a speculative rewrite.
    return { requiresExpansion: false, reasons: [], citedSourceTarget: 0 };
  }
}

async function failedReleaseGateIds(workspaceDir: string): Promise<Set<string>> {
  try {
    const report = JSON.parse(await fs.readFile(path.join(workspaceDir, "reports", "release-gates.json"), "utf-8")) as {
      gates?: Array<{ id?: unknown; pass?: unknown }>;
      checks?: Array<{ id?: unknown; pass?: unknown }>;
    };
    // Final research validation writes `gates`, while a few legacy/advisory
    // reports used `checks`.  Reading only the latter silently hid the exact
    // failures that a final-release repair must own.
    return new Set([...(report.gates ?? []), ...(report.checks ?? [])]
      .filter((check) => typeof check.id === "string" && check.pass === false)
      .map((check) => check.id as string));
  } catch {
    return new Set();
  }
}

/** A low manuscript citation count is not itself a retrieval deficit. When
 * deterministic corpus gates pass *and* the allocated packets can meet the
 * configured release target, first ask the editor to weave that evidence.
 * This prevents unnecessary live recall while retaining expansion for a real
 * capacity shortfall. */
async function routeCitationWeavingActions(
  workspaceDir: string,
  plan: AgenticActionPlan,
): Promise<{ plan: AgenticActionPlan; rerouted: string[]; required: string[] }> {
  let corpusPass = false;
  try {
    const corpus = JSON.parse(await fs.readFile(path.join(workspaceDir, "reports", "corpus-gates.json"), "utf-8")) as { pass?: unknown };
    corpusPass = corpus.pass === true;
  } catch {
    // Missing gate evidence is not permission to suppress a selected research
    // action; the plan remains conservative until the deterministic report is
    // available.
  }
  if (!corpusPass) return { plan, rerouted: [], required: [] };

  // A planner may carry an operator-authorized ratio stricter than the
  // project default.  Treat it as a real evidence-capacity constraint: a
  // prose-only revision cannot make more cited records accepted.
  const requiredAcceptedRatio = Math.max(0, ...plan.actions.flatMap((action) => action.acceptance_criteria
    .filter((criterion) => criterion.metric === "accepted_cited_ratio")
    .map((criterion) => criterion.target)));
  const capacity = await evidenceCapacity(workspaceDir, requiredAcceptedRatio);
  const failedGates = await failedReleaseGateIds(workspaceDir);
  const findings = [...plan.findings];
  for (const id of ["cited_literature_release_gates", "rendered_visual_review"]) {
    if (failedGates.has(id) && !findings.some((finding) => finding.id === id)) {
      findings.push({
        id,
        severity: "critical",
        summary: `Deterministic final-release validation reports ${id} as failing; select its concrete repair action.`,
      });
    }
  }

  const rerouted: string[] = [];
  const required: string[] = [];
  const evidenceFindingIds = new Set(["cited_literature_release_gates", "citation_evidence_ledger", "claim_support"]);
  const citationRepairMetrics = new Set(["cited_sources", "citations_per_page", "citation_depth_per_section", "accepted_cited_ratio", "cited_arxiv_only_ratio"]);
  const actions = plan.actions.map((action) => {
    const isCitationWeaving = action.tool === "targeted_research_expansion"
      && (action.acceptance_criteria.some((criterion) => citationRepairMetrics.has(criterion.metric))
        || action.finding_ids.some((id) => evidenceFindingIds.has(id)));
    if (!isCitationWeaving || capacity.requiresExpansion) return action;
    rerouted.push(action.id);
    return {
      ...action,
      tool: "revise_sections",
      rationale: `The deterministic corpus gates already pass, so this is a citation-weaving repair rather than a prerequisite retrieval task. Reuse the current packet-backed corpus before requesting new live recall. ${action.rationale}`,
    };
  });
  const selectedEvidenceFindings = findings
    .filter((finding) => evidenceFindingIds.has(finding.id))
    .map((finding) => finding.id);
  if (capacity.requiresExpansion && selectedEvidenceFindings.length > 0 && !actions.some((action) => action.tool === "targeted_research_expansion")) {
    required.push("targeted_research_expansion");
    actions.push({
      id: "required-evidence-capacity-expansion",
      tool: "targeted_research_expansion",
      finding_ids: selectedEvidenceFindings,
      rationale: `Current packet-backed evidence cannot meet the configured release target: ${capacity.reasons.join("; ")}. Expand bounded research, then refresh classification, full text, evidence extraction, and section allocation before revising prose.`,
      acceptance_criteria: [capacity.citedSourceTarget > 0
        ? { metric: "cited_sources" as const, target: capacity.citedSourceTarget, scope: "configured release-gate capacity" }
        : { metric: "citation_depth_per_section" as const, target: 1, scope: "configured release-gate depth capacity" }],
    });
  }
  // Expansion repairs corpus capacity, never the prose itself.  Whether the
  // current packets were sufficient or were just refreshed, a failed ledger
  // or cited-manuscript gate always needs a bounded section revision before a
  // recovery round may claim progress.
  if (selectedEvidenceFindings.length > 0 && !actions.some((action) => action.tool === "revise_sections")) {
    required.push("revise_sections");
    actions.push({
      id: "required-corpus-backed-citation-revision",
      tool: "revise_sections",
      finding_ids: selectedEvidenceFindings,
      rationale: capacity.requiresExpansion
        ? "After the selected evidence expansion and packet refresh, revise every affected chapter using the refreshed packet-backed sources, remove unsupported citations, and record exact locators. Expansion alone cannot repair manuscript citations."
        : "Corpus gates already pass, so the final-release evidence and citation-depth failures require a chapter revision that weaves existing packet-backed sources, removes unsupported citations, and records locators. Research expansion alone cannot repair manuscript citations.",
      acceptance_criteria: [{ metric: "citation_depth_per_section", target: 1, scope: "sections named by the current release assessment" }],
    });
  }
  const visualFindingIds = findings.filter((finding) => finding.id === "rendered_visual_review").map((finding) => finding.id);
  if (visualFindingIds.length > 0 && !actions.some((action) => action.tool === "revise_visual_plan")) {
    required.push("revise_visual_plan");
    actions.push({
      id: "required-rendered-visual-repair",
      tool: "revise_visual_plan",
      finding_ids: visualFindingIds,
      rationale: "A rendered visual-review failure requires a concrete figure/table placement and layout repair, followed by a fresh PDF render and visual review. An outline rewrite cannot alter the placed visual artifact by itself.",
      acceptance_criteria: [{ metric: "rendered_visual_review", target: 1, scope: "fresh rendered PDF review" }],
    });
  }
  const merged = mergeDuplicateToolActions(AgenticActionPlan.parse({ ...plan, findings, actions }));
  return { plan: merged.plan, rerouted, required };
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

/** Add non-discretionary final-release repairs before the strict release-plan
 * contract is checked.  The model still decides the diagnosis and any
 * discretionary work; this adapter only supplies actions that are compelled
 * by the current deterministic release report (for example a rendered-PDF
 * failure always needs a visual-plan repair).  Keeping that rule here means a
 * stale ``escalate`` posture cannot spend two expensive retries merely
 * restating that a repair is ineligible.
 *
 * This is deliberately narrower than a generic plan repair: it never drops
 * an action, relaxes a target, or invents a finding unrelated to an actually
 * failed release gate.  The subsequent final-release validator remains the
 * authority for coverage and output ownership. */
export async function enrichFinalReleaseActionPlan(workspaceDir: string): Promise<{ added: string[] }> {
  const target = path.join(workspaceDir, "reviews", "action-plan.json");
  const raw = await fs.readFile(target, "utf-8");
  const plan = AgenticActionPlan.parse(JSON.parse(raw));
  const routed = await routeCitationWeavingActions(workspaceDir, plan);
  let enriched = routed.plan;
  // Unlike citation-capacity routing, these obligations require no corpus
  // inference.  Their failed IDs come directly from final validation, so they
  // must be executable even in a small/partially migrated workspace where a
  // corpus-gate report is not present.
  let failedIds = new Set<string>();
  try {
    const validation = JSON.parse(await fs.readFile(path.join(workspaceDir, "reports", "longwrite-validation.json"), "utf-8")) as {
      checks?: Array<{ id?: unknown; pass?: unknown }>;
    };
    failedIds = new Set((validation.checks ?? [])
      .filter((check) => check.pass === false && typeof check.id === "string")
      .map((check) => check.id as string));
  } catch {
    // The strict final-release validator will give the actionable error if
    // its authoritative report is unavailable or malformed.
  }
  const findings = [...enriched.findings];
  const actions = [...enriched.actions];
  // Do not manufacture a diagnosis a planner never named: strict validation
  // must still catch a plan that silently ignores a failed release gate.
  // Once a planner has acknowledged a deterministic prose failure, though,
  // the executable prose repair is non-discretionary.
  const namedFindings = new Set(findings.map((finding) => finding.id));
  // A review-score deficit may be wholly caused by a blocking rendered
  // visual defect. The deterministic generator records that ownership on the
  // visual action with both the review_target finding and its exact score
  // criterion. Preserve that routing here instead of manufacturing a second,
  // unrelated manuscript rewrite during enrichment.
  const visuallyOwnedReviewTarget = actions.some((action) =>
    action.tool === "revise_visual_plan"
    && action.finding_ids.includes("review_target")
    && action.acceptance_criteria.some((criterion) => criterion.metric === "review_score" && criterion.target >= 8));
  const proseIds = [...failedIds].filter((id) => namedFindings.has(id)
    && ["claim_support", "review_target", "taxonomy_direct_evidence", "cited_literature_release_gates"].includes(id)
    && !(id === "review_target" && visuallyOwnedReviewTarget));
  const proseOwned = new Set(actions.filter((action) => action.tool === "revise_sections").flatMap((action) => action.finding_ids));
  const proseMissing = proseIds.filter((id) => !proseOwned.has(id));
  if (proseMissing.length > 0) {
    actions.push({
      id: "required-final-release-prose-repair",
      tool: "revise_sections",
      finding_ids: proseMissing,
      rationale: "These deterministic release failures require an evidence-backed manuscript revision. Preserve all configured release thresholds, use the current packet-backed evidence, and narrow or remove claims that cannot be supported.",
      acceptance_criteria: [{ metric: "citation_depth_per_section", target: 1, scope: "sections named by the current release assessment" }],
    });
  }
  // Preserve the validator's actual quantitative contract on the executable
  // prose action. A generic depth criterion is not a substitute for a failed
  // distinct-source or review-score target; without this adapter an editor can
  // complete its declared action while leaving the gate unchanged.
  const proseAction = actions.find((action) => action.tool === "revise_sections");
  if (proseAction) {
    const exact: AgenticActionPlan["actions"][number]["acceptance_criteria"] = [];
    if (failedIds.has("cited_literature_release_gates")) {
      const config = await loadProjectConfig(workspaceDir);
      exact.push({ metric: "cited_sources", target: config.research.release_gates.min_cited_sources, scope: "distinct sources cited in chapters/*.md" });
      if (config.research.release_gates.min_accepted_cited_ratio > 0) {
        exact.push({ metric: "accepted_cited_ratio", target: config.research.release_gates.min_accepted_cited_ratio, scope: "distinct sources cited in chapters/*.md" });
      }
    }
    if (failedIds.has("review_target") && !visuallyOwnedReviewTarget) exact.push({ metric: "review_score", target: 8, scope: "fresh independent multi-persona review" });
    proseAction.acceptance_criteria = [...exact, ...proseAction.acceptance_criteria]
      .filter((criterion, index, all) => all.findIndex((candidate) => candidate.metric === criterion.metric && candidate.scope === criterion.scope) === index)
      .slice(0, 5);
  }
  if (failedIds.has("rendered_visual_review") && namedFindings.has("rendered_visual_review") && !actions.some((action) => action.tool === "revise_visual_plan" && action.finding_ids.includes("rendered_visual_review"))) {
    actions.push({
      id: "required-final-release-visual-repair",
      tool: "revise_visual_plan",
      finding_ids: ["rendered_visual_review"],
      rationale: "A failed rendered visual review requires a durable figure/table placement or layout repair and a fresh rendered-PDF review; it cannot be waived by a planner posture.",
      acceptance_criteria: [{ metric: "rendered_visual_review", target: 1, scope: "fresh rendered PDF review" }],
    });
  }
  enriched = mergeDuplicateToolActions(AgenticActionPlan.parse({ ...enriched, findings, actions })).plan;
  const before = JSON.stringify(plan);
  const after = JSON.stringify(enriched);
  if (before !== after) {
    await fs.writeFile(`${target}.pre-final-release-enrichment.json`, `${JSON.stringify(plan, null, 2)}\n`, "utf-8");
    await fs.writeFile(target, `${JSON.stringify(enriched, null, 2)}\n`, "utf-8");
  }
  return { added: [...routed.required, ...(proseMissing.length > 0 ? ["revise_sections"] : []), ...(failedIds.has("rendered_visual_review") ? ["revise_visual_plan"] : [])] };
}

/** Preserve one LLM decision record while dispatching it in dependency order:
 * research refresh first, then structural rewrite, then prose/visual repair.
 * This lets a same-round editor consume newly validated evidence instead of
 * revising from stale section packets. */
export async function splitAgenticActionPlan(workspaceDir: string, actionPlanPath = "reviews/action-plan.json"): Promise<{ reportPath: string; written: string[] }> {
  const raw = await fs.readFile(path.join(workspaceDir, actionPlanPath), "utf-8");
  const validated = AgenticActionPlan.parse(JSON.parse(raw));
  const routed = await routeCitationWeavingActions(workspaceDir, validated);
  const plan = routed.plan;
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
    ...(routed.rerouted.length > 0 ? [`- Citation-weaving actions rerouted from live expansion to section revision because corpus gates passed: ${routed.rerouted.join(", ")}.`] : []),
    ...(routed.required.length > 0 ? [`- Required corpus-backed release repairs added: ${routed.required.join(", ")}.`] : []),
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
