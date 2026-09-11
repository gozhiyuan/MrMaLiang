import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadProjectConfig } from "../project-config.js";
import { gateOwnedByCapability } from "./gate-routing.js";
import { FindingSchema, type Finding } from "../registry/records.js";
import { REGISTRY } from "../registry/producers.js";
import { capabilitiesOfPhase, phaseRoutes } from "../registry/phases.js";
import { METRIC_REGISTRY, PLANNER_SELECTABLE } from "../registry/metrics.js";
import { metricId } from "../registry/ids.js";

/** The metrics a planner may name, GENERATED from the registry's own
 * planner-selectable set rather than restated here. The hand-kept copy needed
 * a dedicated drift test to police it; generation removes the second copy that
 * could drift. */
export const ACCEPTANCE_METRICS = [...PLANNER_SELECTABLE].map(String).sort() as unknown as readonly [string, ...string[]];

const AcceptanceCriterionObject = z.object({
  /** Each metric is mechanically observable in the workspace or by the next
   * independent reviewer; free-form success claims are not accepted. The set
   * and the planner instructions are both rendered from the registry, so there
   * is no second copy to keep in sync. */
  metric: z.enum(ACCEPTANCE_METRICS),
  operator: z.enum(["at_least", "at_most", "equals"]).optional(),
  target: z.number().nonnegative(),
  scope: z.string().min(1).max(160).optional(),
}).strict().superRefine((criterion, ctx) => {
  // Direction comes from the METRIC REGISTRY, not from a list of metric names
  // kept here. The two disagreed: this file called diagram_connectivity a
  // defect count to minimize while the registry and its evaluator define it as
  // a connectivity ratio to maximize — so a correct criterion was rejected and
  // an inverted one demanded.
  const definition = METRIC_REGISTRY.get(metricId(criterion.metric));
  if (!definition || criterion.operator === undefined) return;
  if (definition.direction === "minimize" && criterion.operator === "at_least") {
    ctx.addIssue({ code: "custom", path: ["operator"],
      message: `${criterion.metric} is minimize; at_least would demand more of a defect count` });
  }
  if (definition.direction === "maximize" && criterion.operator === "at_most") {
    ctx.addIssue({ code: "custom", path: ["operator"],
      message: `${criterion.metric} is maximize; at_most would cap an objective it should raise` });
  }
});

/** Normalize plans written before directional criteria were introduced.
 *
 * The direction is the registry's, so every registered metric gets the right
 * comparison and a newly registered one needs no edit here. */
export const AcceptanceCriterion = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const criterion = value as Record<string, unknown>;
  if (criterion.operator !== undefined || typeof criterion.metric !== "string") return value;
  const definition = METRIC_REGISTRY.get(metricId(criterion.metric));
  if (!definition) return value;
  return { ...criterion, operator: definition.direction === "minimize" ? "at_most" : "at_least" };
}, AcceptanceCriterionObject);

/** What an agentic planner may choose: scholarly judgment, never routing.
 *
 * v2 takes STRUCTURED findings — the same shape the producers emit — and
 * actions that name finding ids without naming a tool. The capability is
 * resolved from each finding's (gate, artifact kind, required effect) triple
 * by the registry, because letting a planner pick the tool is how a prose
 * defect reached a figure generator. A prose summary carried no triple to
 * route on, which is why v1 had to be told. */
export const AgenticActionPlan = z.object({
  version: z.literal(2),
  findings: z.array(FindingSchema).max(100),
  actions: z.array(z.object({
    id: z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    finding_ids: z.array(z.string().min(1)).min(1).max(30),
    rationale: z.string().min(1).max(8_000),
    /** What the planner believes should be done. Advisory: the registry
     * resolves the capability, and this is compared against it rather than
     * trusted. */
    proposed_effect: z.string().min(1).optional(),
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

function criterionText(criterion: z.infer<typeof AcceptanceCriterion>): string {
  const symbol = criterion.operator === "at_most" ? "<=" : criterion.operator === "equals" ? "=" : ">=";
  return `${criterion.metric}${criterion.scope ? `(${criterion.scope})` : ""} ${symbol} ${criterion.target}`;
}

/** A criterion whose operator follows the metric's registered direction.
 *
 * Written once so no call site can invert a metric by hand. */
function directional(
  metric: string, target: number, scope: string,
): z.infer<typeof AcceptanceCriterion> {
  const definition = METRIC_REGISTRY.get(metricId(metric));
  return AcceptanceCriterion.parse({
    metric, target, scope,
    operator: definition?.direction === "minimize" ? "at_most" : "at_least",
  }) as never;
}

export async function gateAcceptanceCriterion(
  workspaceDir: string,
  gateId: string,
  loadedConfig?: Awaited<ReturnType<typeof loadProjectConfig>>,
): Promise<z.infer<typeof AcceptanceCriterion>> {
  if (gateId === "landmark_coverage" || gateId === "landmark_citation_coverage") {
    const config = loadedConfig ?? await loadProjectConfig(workspaceDir);
    return gateId === "landmark_coverage"
      ? { metric: "landmark_coverage_ratio", operator: "at_least", target: config.research.corpus_gates.min_landmark_coverage_ratio, scope: "evidence-backed A/B landmark corpus" }
      : { metric: "landmark_citation_coverage_ratio", operator: "at_least", target: config.research.corpus_gates.min_landmark_citation_coverage_ratio, scope: "landmark works cited in chapters/*.md" };
  }
  if (gateId === "claim_contradictions") return directional("claim_contradictions", 0, "cross-chapter affirm/deny groups");
  if (gateId === "prose_redundancy") return directional("prose_redundancy", 0, "configured tracked-phrase and repeated-ngram findings");
  // A connectivity RATIO the registry declares as maximize. Hardcoding
  // `at_most 0` here produced a criterion this file's own schema rejects —
  // the generator could emit a plan its parser refused.
  if (gateId === "diagram_connectivity" || gateId === "publication_figures") {
    return directional("diagram_connectivity", 1, "mean connectivity of loop-captioned diagrams");
  }
  // An OWNERSHIP question, which the registry answers exactly: does any of
  // this gate's declared repairs belong to the visual capability? The old
  // table answered a preference question instead, and its default sent every
  // unclassified gate to prose.
  if (gateOwnedByCapability(gateId, "revise_visual_plan")) return { metric: "rendered_visual_review", operator: "equals", target: 1, scope: "fresh rebuilt and rendered PDF review" };
  if (gateId === "claim_support") return { metric: "claim_support", operator: "at_least", target: 0.9, scope: "fresh independently double-reviewed claim sample" };
  if (gateId === "review_target") return { metric: "review_score", operator: "at_least", target: 8, scope: "fresh independent multi-persona review" };
  return { metric: "citation_depth_per_section", operator: "at_least", target: 1, scope: "sections named by the current release assessment" };
}

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
/** The capability that will run an action, resolved from its findings.
 *
 * Every finding in one action must resolve to the same capability: an action
 * mixing a prose repair and a figure repair is two pieces of work sharing an
 * id, and whichever capability ran it would be acting outside its envelope for
 * half of them. */
export function capabilityOf(
  plan: Pick<AgenticActionPlan, "findings">, action: { id: string; finding_ids: string[] },
): string {
  const byId = new Map(plan.findings.map((finding) => [finding.id, finding]));
  const capabilities = new Set<string>();
  for (const id of action.finding_ids) {
    const finding = byId.get(id);
    if (!finding) continue;
    capabilities.add(String(REGISTRY.resolveCapability({
      gate: finding.gate_id, kind: finding.artifact.kind, effect: finding.required_effect,
    })));
  }
  if (capabilities.size === 0) {
    throw new Error(`action ${action.id} names no finding this registry can route`);
  }
  if (capabilities.size > 1) {
    throw new Error(`action ${action.id} mixes capabilities: ${[...capabilities].sort().join(", ")}`);
  }
  return [...capabilities][0]!;
}

/** One dispatch instance per capability, objective, and scope.
 *
 * Sharing a capability only says two findings may touch the same artifact; it
 * does not say they have the same success condition.  Coalescing by tool made
 * two taxonomy cells into one action that materialization correctly refused,
 * and worse, made a prose action with distinct metrics enter the attempt
 * ledger under whichever finding happened to be first.  Split before merging
 * so the kernel can serialize overlapping envelopes while diagnosis retains a
 * one-to-one objective lineage. */
function mergeDuplicateToolActions(plan: AgenticActionPlan): { plan: AgenticActionPlan; merged: string[] } {
  const byId = new Map(plan.findings.map((finding) => [finding.id, finding]));
  const byObjective = new Map<string, AgenticActionPlan["actions"][number]>();
  const actions: AgenticActionPlan["actions"] = [];
  const merged = new Set<string>();
  for (const action of plan.actions) {
    const partitions = new Map<string, string[]>();
    for (const findingId of action.finding_ids) {
      const finding = byId.get(findingId);
      if (!finding) continue;
      const capability = capabilityOf(plan, { ...action, finding_ids: [findingId] });
      const objective = finding.acceptance_metric === null
        ? `gate:${String(finding.gate_id)}` : `metric:${String(finding.acceptance_metric)}`;
      const key = `${capability}\u0000${objective}\u0000${finding.objective_scope_key}`;
      partitions.set(key, [...(partitions.get(key) ?? []), findingId]);
    }
    for (const [partitionKey, findingIds] of partitions) {
      const [capability, objective] = partitionKey.split("\u0000");
      const earlier = byObjective.get(partitionKey);
      if (!earlier) {
        const suffix = partitions.size === 1 ? "" : `-${actions.length + 1}`;
        const matchingCriteria = objective.startsWith("metric:")
          ? action.acceptance_criteria.filter((criterion) => criterion.metric === objective.slice("metric:".length))
          : action.acceptance_criteria;
        // The planner's criteria are advisory; the materialized contract is
        // derived from the finding. Preserve one declared criterion when a
        // legacy plan omitted the finding's metric so normalization remains a
        // valid migration, while never carrying unrelated criteria into a
        // split objective when an exact one is present.
        const copy = { ...action, id: `${action.id}${suffix}`, finding_ids: findingIds,
          acceptance_criteria: matchingCriteria.length > 0 ? matchingCriteria : [action.acceptance_criteria[0]!] };
        byObjective.set(partitionKey, copy);
        actions.push(copy);
        continue;
      }
      earlier.finding_ids = [...new Set([...earlier.finding_ids, ...findingIds])];
      const combined = `${earlier.rationale}\n\nAlso address: ${action.rationale}`;
      earlier.rationale = combined.length <= 8_000
        ? combined
        : `${combined.slice(0, 7_800).trimEnd()}\n\n[Additional rationale truncated by bounded plan repair.]`;
      earlier.acceptance_criteria = [...earlier.acceptance_criteria, ...action.acceptance_criteria]
        .filter((criterion, index, all) => all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(criterion)) === index)
        .slice(0, 5);
      merged.add(capability!);
    }
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
/** Structured findings the deterministic validators emitted for failed checks.
 *
 * These already exist in `reports/longwrite-validation.json`; the previous
 * contract ignored them and synthesized prose summaries keyed by gate id
 * instead, which is why routing needed a hand-maintained table. A finding
 * carries its own (gate, artifact kind, required effect) triple, so it routes
 * itself. */
export async function structuredFindingsFromValidation(workspaceDir: string): Promise<Finding[]> {
  // Both reports, because the same validator writes both: the full validation
  // report and the release-gate summary derived from it. Reading only one made
  // enrichment depend on which of the two a workspace happened to have.
  const sources: Array<{ pass?: boolean; findings?: unknown[] }> = [];
  for (const [rel, key] of [["longwrite-validation.json", "checks"], ["release-gates.json", "gates"]] as const) {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(workspaceDir, "reports", rel), "utf-8");
    } catch (error) {
      // The strict final-release validator gives the actionable error when its
      // authoritative report is unavailable; enrichment stays conservative.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const entry of (parsed[key] as Array<{ pass?: boolean; findings?: unknown[] }> | undefined) ?? []) {
      sources.push(entry);
    }
  }
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const check of sources) {
    if (check.pass !== false) continue;
    for (const raw of check.findings ?? []) {
      const parsed = FindingSchema.safeParse(raw);
      // A malformed finding is not silently repaired into a routable one: the
      // producer that emitted it is the thing to fix.
      if (!parsed.success || seen.has(parsed.data.id)) continue;
      seen.add(parsed.data.id);
      findings.push(parsed.data);
    }
  }
  return findings;
}

/** Groups findings by the capability the registry resolves for each, so a
 * required repair is synthesized per capability rather than per gate. */
/** The criterion a finding's own objective implies.
 *
 * The finding names the metric it moves; the configured gate supplies the
 * target. Deriving the criterion from the GATE instead collapsed a compound
 * gate's several objectives into one — a repair that fixed recency could then
 * claim to have fixed venue mix. A finding with no metric falls back to the
 * gate's criterion, which is where verification-style objectives live. */
export async function criterionForFinding(
  workspaceDir: string, finding: Finding,
): Promise<z.infer<typeof AcceptanceCriterion>> {
  const metric = finding.acceptance_metric === null ? null : String(finding.acceptance_metric);
  if (metric === null) return gateAcceptanceCriterion(workspaceDir, String(finding.gate_id));
  const config = await loadProjectConfig(workspaceDir).catch(() => null);
  const release = config?.research.release_gates;
  const corpusGates = config?.research.corpus_gates;
  const scope = finding.objective_scope_key || undefined;
  const targets: Record<string, number> = {
    cited_sources: release?.min_cited_sources ?? 1,
    accepted_cited_ratio: release?.min_accepted_cited_ratio ?? 0,
    citations_per_page: release?.min_citations_per_page ?? 1,
    landmark_coverage_ratio: corpusGates?.min_landmark_coverage_ratio ?? 1,
    landmark_citation_coverage_ratio: corpusGates?.min_landmark_citation_coverage_ratio ?? 1,
    claim_support: 0.9,
    review_score: 8,
    rendered_visual_review: 1,
    claim_contradictions: 0,
    prose_redundancy: 0,
    // A connectivity RATIO, not a defect count: fully connected is 1.
    diagram_connectivity: 1,
  };
  const target = targets[metric];
  // A metric with no configured target is not given an invented one: the
  // gate's own criterion is the honest fallback.
  if (target === undefined) return gateAcceptanceCriterion(workspaceDir, String(finding.gate_id));
  // The operator follows from the metric's declared DIRECTION, which the
  // registry knows for every metric. The schema's preprocess fills it in for a
  // hand-listed few; deriving it means a newly registered metric arrives with
  // the right comparison instead of none.
  const definition = METRIC_REGISTRY.get(metricId(metric));
  const operator = definition?.direction === "minimize" ? "at_most" as const : "at_least" as const;
  return AcceptanceCriterion.parse({ metric, target, operator, ...(scope ? { scope } : {}) }) as never;
}

export function byCapability(findings: Finding[]): Map<string, Finding[]> {
  const grouped = new Map<string, Finding[]>();
  for (const finding of findings) {
    let capability: string;
    try {
      capability = String(REGISTRY.resolveCapability({
        gate: finding.gate_id, kind: finding.artifact.kind, effect: finding.required_effect,
      }));
    } catch {
      // Unrouted findings go to diagnosis, never to whichever capability
      // seemed closest. Skipping here leaves the strict validator to report
      // the uncovered failure.
      continue;
    }
    grouped.set(capability, [...(grouped.get(capability) ?? []), finding]);
  }
  return grouped;
}

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
  // project default. Treat it as a real evidence-capacity constraint: a
  // prose-only revision cannot make more cited records accepted.
  const requiredAcceptedRatio = Math.max(0, ...plan.actions.flatMap((action) => action.acceptance_criteria
    .filter((criterion) => criterion.metric === "accepted_cited_ratio")
    .map((criterion) => criterion.target)));
  const capacity = await evidenceCapacity(workspaceDir, requiredAcceptedRatio);

  // Structured findings the validators actually emitted, added to the plan so
  // an action can name them. The planner's own findings are kept as-is.
  const known = new Set(plan.findings.map((finding) => finding.id));
  const emitted = (await structuredFindingsFromValidation(workspaceDir))
    .filter((finding) => !known.has(finding.id));
  const findings = [...plan.findings, ...emitted];

  const rerouted: string[] = [];
  const required: string[] = [];

  // Reclassification, not rerouting. With the corpus gates already passing and
  // capacity adequate, a citation defect typed as evidence ACQUISITION is
  // mis-typed: the sources exist and the repair is weaving them into prose.
  // Under v2 the capability follows the finding, so the honest correction is
  // to the finding — retyping it is what re-points the work.
  const reclassified = findings.map((finding) => {
    if (capacity.requiresExpansion) return finding;
    const capability = String(REGISTRY.resolveCapability({
      gate: finding.gate_id, kind: finding.artifact.kind, effect: finding.required_effect,
    }));
    if (capability !== "targeted_research_expansion") return finding;
    rerouted.push(finding.id);
    return FindingSchema.parse({
      ...finding,
      gate_id: "cited_literature_release_gates",
      artifact: { kind: "chapter_prose", path: "chapters/section-01.md" },
      required_effect: "add_supporting_citation",
      acceptance_metric: "cited_sources",
      diagnostic: `${finding.diagnostic} Corpus gates already pass, so this is a citation-weaving repair rather than a prerequisite retrieval task.`.slice(0, 8_000),
    });
  });
  findings.splice(0, findings.length, ...reclassified);

  // Expansion repairs corpus capacity; it never writes the citation into a
  // chapter. So an acquisition finding for a citation gate carries a companion
  // weaving finding: without it a recovery round can retrieve sources, change
  // no prose, and still claim the round did something.
  const companions: Finding[] = [];
  for (const finding of findings) {
    const capability = String(REGISTRY.resolveCapability({
      gate: finding.gate_id, kind: finding.artifact.kind, effect: finding.required_effect,
    }));
    if (capability !== "targeted_research_expansion") continue;
    const companionId = `${finding.id}-weave`;
    if (findings.some((candidate) => candidate.id === companionId)) continue;
    companions.push(FindingSchema.parse({
      ...finding,
      id: companionId,
      gate_id: "cited_literature_release_gates",
      artifact: { kind: "chapter_prose", path: "chapters/section-01.md" },
      required_effect: "add_supporting_citation",
      acceptance_metric: "cited_sources",
      diagnostic: `${finding.diagnostic} Once the sources are acquired, the manuscript still has to cite them: expansion alone cannot repair manuscript citations.`.slice(0, 8_000),
    }));
  }
  findings.push(...companions);

  const actions = [...plan.actions];
  const covered = new Set(actions.flatMap((action) => action.finding_ids));

  // One required action per capability that owns an uncovered failed finding.
  // No gate-level preference is consulted, because each finding routes itself.
  for (const [capability, group] of byCapability(findings.filter((finding) => !covered.has(finding.id)))) {
    required.push(capability);
    actions.push({
      id: `required-${capability.replace(/_/g, "-")}`,
      finding_ids: group.map((finding) => finding.id).slice(0, 30),
      rationale: capability === "targeted_research_expansion"
        ? `Current packet-backed evidence cannot meet the configured release target: ${capacity.reasons.join("; ")}. Expand bounded research, then refresh classification, full text, evidence extraction, and section allocation before revising prose.`
        : `These deterministic release failures route to ${capability}. Repair exactly the named findings, preserve every configured release threshold, and use current packet-backed evidence.`,
      acceptance_criteria: (await Promise.all(
        group.slice(0, 5).map((finding) => criterionForFinding(workspaceDir, finding)))),
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
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(content);
    plan = AgenticActionPlan.parse(parsedValue);
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
  const changed = normalized || merged.merged.length > 0 || JSON.stringify(parsedValue) !== JSON.stringify(plan);
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
      `- ${action.id} criteria: ${action.acceptance_criteria.map(criterionText).join("; ")}`,
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

  // Every failed check's structured findings, whether or not the planner
  // named them. A planner that ignores a failed gate still gets the executable
  // repair, and the capability comes from the finding's own triple rather than
  // from a gate-level preference.
  const emitted = await structuredFindingsFromValidation(workspaceDir);
  const known = new Set(enriched.findings.map((finding) => finding.id));
  const findings = [...enriched.findings, ...emitted.filter((finding) => !known.has(finding.id))];
  const actions = [...enriched.actions];
  const covered = new Set(actions.flatMap((action) => action.finding_ids));
  const added: string[] = [];

  for (const [capability, group] of byCapability(findings.filter((finding) => !covered.has(finding.id)))) {
    added.push(capability);
    actions.push({
      id: `required-final-release-${capability.replace(/_/g, "-")}`,
      finding_ids: group.map((finding) => finding.id).slice(0, 30),
      rationale: `These deterministic release failures route to ${capability}. Repair exactly the named findings using current packet-backed evidence, preserve every configured release threshold, and narrow or remove claims that cannot be supported.`,
      acceptance_criteria: (await Promise.all(
        group.slice(0, 5).map((finding) => criterionForFinding(workspaceDir, finding)))),
    });
  }

  // Every action carries the quantitative contract its own findings imply.
  // A planner may name a plausible criterion that is not the one the validator
  // will check; the executable action has to carry the real threshold, or it
  // can be completed while the gate stays shut.
  const withCriteria = await Promise.all(actions.map(async (action) => {
    const own = findings.filter((finding) => action.finding_ids.includes(finding.id));
    const derived = await Promise.all(own.map((finding) => criterionForFinding(workspaceDir, finding)));
    const combined = [...derived, ...action.acceptance_criteria]
      .filter((criterion, index, all) => all.findIndex((candidate) =>
        candidate.metric === criterion.metric && candidate.scope === criterion.scope) === index)
      .slice(0, 5);
    return { ...action, acceptance_criteria: combined };
  }));

  enriched = mergeDuplicateToolActions(AgenticActionPlan.parse({ ...enriched, findings, actions: withCriteria })).plan;
  const before = JSON.stringify(plan);
  const after = JSON.stringify(enriched);
  if (before !== after) {
    await fs.writeFile(`${target}.pre-final-release-enrichment.json`, `${JSON.stringify(plan, null, 2)}\n`, "utf-8");
    await fs.writeFile(target, `${JSON.stringify(enriched, null, 2)}\n`, "utf-8");
  }
  return { added: [...new Set([...routed.required, ...added])] };
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
  // DERIVED from the phase table, never restated here. The splitter choosing
  // its own filenames and each dispatcher choosing one independently is what
  // let a capability's actions be written to a file nothing read — and a
  // capability in no group at all be dropped between validation and dispatch
  // with nothing reporting it. `registry/phases.ts` refuses at load time to
  // leave a registered capability unrouted, so the check that used to live here
  // now runs wherever a capability is added.
  const groups: Array<[string, Set<string>]> = phaseRoutes().map((route) =>
    [route.planPath, new Set(capabilitiesOfPhase(route.phase))]);
  const written: string[] = [];
  await fs.mkdir(path.join(workspaceDir, "reviews"), { recursive: true });
  // Grouped by the capability the registry RESOLVES for each action, so an
  // action lands in the phase that matches what will actually run it.
  const capabilityFor = (action: AgenticActionPlan["actions"][number]): string => capabilityOf(plan, action);
  for (const [name, tools] of groups) {
    const selected = plan.actions.filter((action) => tools.has(capabilityFor(action)));
    // Translated into the KERNEL's dispatch format at the boundary. MrMaLiang's
    // planner contract is structured findings with registry-resolved routing;
    // the engine's ActionPlan is a different contract that dispatches on a
    // tool id and shows an operator a summary. This is the one place the
    // capability becomes that tool — resolved from the finding, never chosen.
    const dispatchPlan = {
      version: 1,
      findings: plan.findings
        .filter((finding) => selected.some((action) => action.finding_ids.includes(finding.id)))
        .map((finding) => ({
          id: finding.id,
          severity: finding.severity,
          summary: finding.diagnostic.slice(0, 8_000),
        })),
      actions: selected.map((action) => ({
        id: action.id,
        tool: capabilityFor(action),
        finding_ids: action.finding_ids,
        rationale: action.rationale,
        acceptance_criteria: action.acceptance_criteria,
      })),
    };
    const rel = name;
    await fs.writeFile(path.join(workspaceDir, rel), `${JSON.stringify(dispatchPlan, null, 2)}\n`, "utf-8");
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
    ...groups.map(([name, tools]) => `- ${name}: ${plan.actions.filter((action) => tools.has(capabilityFor(action))).map(capabilityFor).join(", ") || "none"}`), "",
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
  const selected = plan.actions.filter((action) => capabilityOf(plan, action) === "request_operator_clarification");
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
    // The finding's own diagnostic, which is what the producer wrote for an
    // operator; a prose summary was the planner's paraphrase of it.
    ...requested.flatMap((finding) => [`- **${finding.id}** (${finding.severity}): ${finding.diagnostic}`]),
    "",
  ].join("\n"), "utf-8");
  return "reviews/clarification-request.md";
}
