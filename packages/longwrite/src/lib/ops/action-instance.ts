import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ActionInstance, OperatorRequiredBlocker, type MaterializationResult,
} from "malaclaw/sdk";
import { validateFindingAgainstRegistry, type Finding } from "../registry/records.js";
import { REGISTRY } from "../registry/producers.js";
import { templateFor } from "../registry/capabilities.js";
import { metricDefinition } from "../registry/metrics.js";
import { VERIFIERS } from "../registry/verifiers.js";
import { metricId, RequiredEffectSchema } from "../registry/ids.js";
import {
  buildRepairPacket, writeRepairPacket, writeRenderedPacket, OperatorTargetFinding,
  type ScopedTarget,
} from "./repair-packet.js";
import { toolGrantFor } from "./packet-render.js";
import { criterionForFinding } from "./action-plan.js";
import { ATTEMPTS_PATH, AttemptRecord, collapsedAttempts } from "./diagnosis-packet.js";

export { ActionInstance, OperatorRequiredBlocker };
export type { MaterializationResult };

/** A trusted observation for one metric at one scope.
 *
 * `operator`, `target` and `tolerance` travel WITH the observation because
 * only the evaluator that produced it knows what a scope-varying objective
 * requires: `citation_depth_per_section` has a different configured minimum at
 * depth A, B and C. A metric-wide default would judge every scope against the
 * same number and call the mismatch a failed repair. */
export type ScopedObservation = ScopedTarget & { value: number };

export type MaterializeRequest = {
  actionId: string;
  findings: Finding[];
  /** Current values keyed `metric scope_key`. */
  observations: Map<string, number>;
  /** Operator/target/tolerance keyed `metric scope_key`, from the evaluator. */
  targets?: ReadonlyMap<string, ScopedTarget>;
  /** What the kernel judged the PREVIOUS attempt at this action to be, when
   * there was one. The domain records the attempt ledger diagnosis reads, and
   * only the kernel knows how the last attempt was judged. */
  priorOutcome?: string | null;
  /** Keys (`metric scope_key`) a measurement RAN for and reported as
   * unavailable. An invariant listed here was looked for and could not be
   * produced yet; one that is absent from both this and `observations` was
   * never measured at all, and the two are not the same failure. */
  unavailable?: ReadonlySet<string>;
  /** Strategy directives the kernel's diagnosis produced for THIS dispatch
   * item, and that no replacement has yet been judged on.
   *
   * Pre-filtered by the kernel, which binds a directive to the dispatch item
   * that failed. Matching here on an objective string the diagnosing model was
   * asked to repeat is what made a formatting drift into a directive nothing
   * would ever apply — a silent loss of the corrective step. The kernel owns
   * the binding; this layer decides what the decision MEANS. */
  directives?: Array<{
    /** The kernel's own identity for this corrective lineage. Echoed back
     * verbatim as `applied_directive`, and checked there: a directive the
     * kernel never offered must not be able to mark an unrelated decision
     * claimed. */
    id?: string;
    objective: string; decision: string; detail?: string;
    next_effect?: string; next_capability?: string;
  }>;
  /** Every path this capability is permitted to read, and the subset it MUST.
   *
   * The instance's read set is used verbatim by the kernel and is what the
   * isolated task workspace is built from, so an input left out is one the
   * worker is told it has and cannot open. */
  readable?: string[];
  requiredInputs?: string[];
  evidence?: Array<{ source_id: string; locator: string; excerpt: string }>;
  untrusted?: Array<{ origin: string; body: string }>;
};

/** Wire contract §8: turn a validated finding set into work the kernel can run.
 *
 * The template supplies what is static — what this capability is and the most
 * it may ever touch. Everything else is narrowed to THIS dispatch: the
 * envelope shrinks to the artifacts the findings actually name, and the
 * acceptance criterion comes from the findings' own metric and scope. */
export async function materializeAction(
  workspaceDir: string, request: MaterializeRequest,
): Promise<MaterializationResult> {
  // Requests arrive from a runtime JSON boundary. Validate BEFORE choosing
  // either materialization arm: an operator-target finding is still a finding,
  // and returning a blocker for an invented gate/metric would preserve the
  // same registry-validation bypass as dispatching it would.
  for (const finding of request.findings) validateFindingAgainstRegistry(finding, REGISTRY);
  // An operator target is a question, not a repair. It comes back as the other
  // arm of the union rather than as a dispatchable instance the kernel would
  // hand to a capability that cannot act on it.
  const operatorTargets = request.findings.filter((finding) => !("path" in finding.artifact));
  if (operatorTargets.length > 0) {
    const target = (operatorTargets[0]!.artifact as { target: string }).target;
    return OperatorRequiredBlocker.parse({
      version: 1,
      kind: "operator_required",
      action_id: request.actionId,
      findings: operatorTargets.map((finding) => finding.id),
      target,
      question: `${target} is required and this run cannot provide it: ` +
        operatorTargets.map((finding) => finding.diagnostic).join(" "),
    });
  }
  // Scope is DECLARED by the producer, never inferred from an artifact path. A
  // prose defect in one section can belong to a workspace-global objective;
  // inferring per-path scopes would split one objective into several that each
  // look separately unmet.
  const scopes = new Set(request.findings.map((finding) => finding.objective_scope_key));
  if (scopes.size > 1) {
    throw new Error(
      `action ${request.actionId} mixes objective scopes: ${[...scopes].map((s) => s || "(global)").join(", ")}`);
  }
  const scopeKey = [...scopes][0] ?? "";

  // A strategy diagnosis already chose, for THIS objective. Applied before
  // routing, because that is the whole content of the decision: the previous
  // attempt was routed by the registry and did not work, and repeating that
  // routing is the move the diagnosis exists to prevent.
  const objective = objectiveOf(request, scopeKey);
  // Already bound to this dispatch item by the kernel; the newest wins.
  const directive = (request.directives ?? [])[(request.directives ?? []).length - 1];

  // The effect the findings are repaired under. Diagnosis may replace it; when
  // it does, the substitution is total — the packet, the routing and the
  // attempt ledger all describe the strategy that actually ran, not the one
  // that already failed.
  const substituted = directive?.decision === "retry_with_different_effect"
    && directive.next_effect !== undefined
    && request.findings.some((finding) => String(finding.required_effect) !== directive.next_effect);
  const findings = substituted
    ? request.findings.map((finding) => ({
        ...finding, required_effect: RequiredEffectSchema.parse(directive!.next_effect),
      }))
    : request.findings;

  // A substituted effect is a NEW four-tuple, and the finding's acceptance
  // metric has to be legal for it. Only the (gate, kind, effect) triple was
  // re-resolved, so a diagnosis could change the effect and leave the repair
  // judged on a metric the new route does not decide — accepted or rejected on
  // evidence about something else.
  //
  // Where the new route decides exactly one metric, that IS the metric: a
  // strategy change naturally changes what the strategy is judged on, and
  // refusing there would make `retry_with_different_effect` unusable. Where it
  // decides several and the finding names none of them, nothing here can
  // choose, and guessing is precisely the invention this refuses.
  const rejudged = !substituted ? findings : findings.map((finding) => {
    const allowed = [...REGISTRY.acceptanceMetrics(
      finding.gate_id, finding.artifact.kind, finding.required_effect)];
    const metric = finding.acceptance_metric === null ? null : String(finding.acceptance_metric);
    const permitted = allowed.map((entry) => entry === null ? null : String(entry));
    if (permitted.includes(metric)) return finding;
    if (allowed.length === 1) return { ...finding, acceptance_metric: allowed[0]! };
    throw new Error(
      `diagnosis substituted effect ${String(finding.required_effect)} for finding ${finding.id}, ` +
      `but ${metric ?? "a verification"} is not an acceptance metric of ` +
      `(${String(finding.gate_id)}, ${finding.artifact.kind}, ${String(finding.required_effect)}), ` +
      `which decides ${permitted.map((entry) => entry ?? "a verification").join(", ")}; ` +
      `the repair would be judged on evidence the new strategy does not decide`);
  });

  const capabilities = new Set(rejudged.map((finding) => String(REGISTRY.resolveCapability({
    gate: finding.gate_id, kind: finding.artifact.kind, effect: finding.required_effect,
  }))));
  if (capabilities.size > 1) {
    throw new Error(`action ${request.actionId} mixes capabilities: ${[...capabilities].join(", ")}`);
  }
  const routed = [...capabilities][0]!;
  // `escalate_capability` names the capability outright; the registry cannot
  // be asked for it, because the registry is precisely what routed the attempt
  // that failed. It is still checked: `templateFor` refuses a capability
  // nothing implements, so an escalation to a name that owns no envelope fails
  // here rather than dispatching a repair with no authority at all.
  const capability = directive?.decision === "escalate_capability" && directive.next_capability
    ? directive.next_capability : routed;

  // Checked against the EFFECTIVE capability, after diagnosis has had its say.
  //
  // Against the routed one, `repair_source_metadata → targeted_research_expansion`
  // walked straight past this: the escalation is decided below the old check,
  // so the blocker never fired and the escalated action failed later as an
  // ordinary script error — which reads as a flaky repair rather than as work
  // no automated capability can do.
  if (capability === "targeted_research_expansion") {
    const requestsPath = path.join(workspaceDir, "sources", "metadata-replacement-requests.json");
    const raw = await fs.readFile(requestsPath, "utf-8").catch((error: NodeJS.ErrnoException) => {
      // Absent means nothing is pending. UNREADABLE means we cannot tell, and
      // proceeding on that basis dispatches a generic expansion at a record
      // that may need replacing — so it fails closed.
      if (error.code === "ENOENT") return null;
      throw new Error(
        `cannot read ${requestsPath} (${error.code ?? String(error)}); refusing to dispatch a ` +
        `generic expansion without knowing whether a source needs operator replacement`);
    });
    const pending = raw === null ? [] : ((): Array<{ source_id?: unknown; title?: unknown }> => {
      try {
        const parsed = JSON.parse(raw) as { requests?: Array<{ source_id?: unknown; title?: unknown }> };
        return (parsed.requests ?? []).filter((entry) =>
          typeof entry.source_id === "string" || typeof entry.title === "string");
      } catch (error) {
        throw new Error(
          `${requestsPath} is not readable JSON (${error instanceof Error ? error.message : String(error)}); ` +
          `refusing to dispatch a generic expansion without knowing whether a source needs replacement`);
      }
    })();
    if (pending.length > 0) {
      // An unrecoverable cited record needs an exact source replacement, not a
      // generic search expansion. The materialization union's blocker arm is
      // returned before dispatch, so the kernel raises a durable
      // operator_required block instead of retrying a script error.
      return OperatorRequiredBlocker.parse({
        version: 1, kind: "operator_required", action_id: request.actionId,
        findings: rejudged.map((finding) => finding.id),
        target: "replace_unrecoverable_source",
        question: `Replace the cited source record(s) ${pending.map((item) => String(item.source_id ?? item.title)).join(", ")} ` +
          "with operator-approved evidence, then rerun metadata verification.",
      });
    }
  }
  const template = templateFor(capability);
  // An escalation has to be to a capability that can actually act on these
  // artifacts. Refused HERE, where the capability and the artifact can both be
  // named, rather than left for the kernel to reject as a generic envelope
  // violation several steps later.
  if (capability !== routed) {
    const unreachable = rejudged
      .map((finding) => (finding.artifact as { path?: string }).path)
      .filter((artifact): artifact is string =>
        artifact !== undefined
        && !template.owns.some((pattern) => pattern.endsWith("/**")
          ? artifact.startsWith(pattern.slice(0, -2))
          : pattern === artifact));
    if (unreachable.length > 0) {
      throw new Error(
        `diagnosis escalated to ${capability}, whose envelope (${template.owns.join(", ")}) ` +
        `cannot own ${unreachable.join(", ")}; escalate to a capability that repairs this artifact ` +
        `kind, or record the objective as infeasible`);
    }
  }
  // Claimed only when the directive CHANGED something. A directive that
  // re-derives the routing already in force steered nothing, and reporting it
  // as applied would let one diagnosis be consumed by a repeat of the attempt
  // it rejected.
  // Claimed only when the directive CHANGED something. A decision that
  // re-derives the routing already in force steered nothing, and reporting it
  // as applied would let one diagnosis be discharged by a repeat of the very
  // attempt it rejected.
  const appliedDirective = directive !== undefined && (capability !== routed || substituted)
    ? directive.id ?? objective : undefined;
  // Everything downstream reads the findings as diagnosis left them, never as
  // they arrived. One substituted effect that reached the packet but not the
  // acceptance criteria would produce a repair judged against the strategy it
  // was told to abandon.
  const effective: MaterializeRequest = { ...request, findings: rejudged };

  // The instance's envelope is the MINIMUM this dispatch needs, not the
  // maximum the capability may ever touch — but that minimum has a floor. The
  // template's GLOB entries are the negotiable part: `chapters/**` narrows to
  // the chapters the findings actually name. Its CONCRETE entries are the
  // artifacts the capability writes on every dispatch — its own revision
  // report, the abstract it keeps in step with the prose — which no finding
  // will ever name and which the worker writes regardless. Dropping them
  // narrows the envelope past what the action does, and the write it always
  // makes comes back as `undeclared_write`.
  const fromFindings = rejudged.map((finding) => (finding.artifact as { path: string }).path);
  const templateFixed = template.owns.filter((entry) => !entry.includes("*"));
  // A capability that cannot enumerate what it will write keeps the template's
  // own patterns. `research expand` retrieves sources it has not yet found and
  // writes them across four directories; narrowed to the paths a finding
  // mentions, every successful expansion came back as an undeclared write. The
  // kernel checks each retained pattern against the template's own, so this
  // declines to narrow rather than widening.
  const owns = template.retains_envelope
    ? [...new Set([...template.owns, ...fromFindings])].sort()
    : [...new Set([...fromFindings, ...templateFixed])].sort();

  const targets = await resolveTargets(workspaceDir, effective);
  const acceptance = compileAcceptance(effective, scopeKey, targets, capability, template);
  const deferredInvariants: string[] = [];
  const mustPreserve = template.must_preserve_template.flatMap((name) => {
    const metric = String(name);
    const definition = metricDefinition(metricId(metric));
    const value = request.observations.get(`${metric} `);
    // An invariant with no current value is unknown, not preserved. There are
    // two ways to have no value, and only one of them is a defect. If a
    // measurement RAN and reported the metric unavailable — no judgment exists
    // yet for it — there is no before-value for a repair to make worse, and
    // the first measurement after this one sets the bar. That is recorded as a
    // deferral so the journal names it. If nothing measured it at all, the
    // contract would be a promise nobody checked, and the action is refused.
    if (value === undefined) {
      if (!request.unavailable?.has(`${metric} `)) {
        throw new Error(`${metric} has no current observation; cannot protect an unmeasured invariant`);
      }
      deferredInvariants.push(metric);
      return [];
    }
    return [{
      kind: "metric" as const,
      metric,
      scope_key: "",
      operator: definition.direction === "minimize" ? "at_most" as const : "at_least" as const,
      target: value,
      // Float comparison on a ratio needs a tolerance, or an unchanged value
      // reports as a regression on the last bit.
      tolerance: definition.target_type === "count" ? 0 : 1e-6,
      direction: definition.direction,
    }];
  });

  const packet = await buildRepairPacket(workspaceDir, {
    actionId: request.actionId,
    findings: rejudged,
    observations: request.observations,
    unavailable: request.unavailable,
    targets,
    priorAttempts: await readPriorAttempts(workspaceDir, objective),
    // The packet must describe the capability that will actually run. Built
    // from the routed one, it named the wrong envelope and protected the wrong
    // invariants on every escalation — and the worker read it and did the work
    // the diagnosis had just rejected.
    ...(capability === routed ? {} : {
      escalation: { capability, because: directive?.detail ?? "diagnosis escalated this objective" },
    }),
    evidence: request.evidence,
    untrusted: request.untrusted,
  }).catch((error: unknown) => {
    // Already handled above, but the packet builder is the authority on what
    // is repairable; do not swallow anything else.
    if (error instanceof OperatorTargetFinding) throw error;
    throw error;
  });
  await writeRepairPacket(workspaceDir, request.actionId, packet);
  // The rendered packet is what the WORKER is handed; the JSON beside it is
  // what a later round and a diagnosis parse.
  const packetPath = await writeRenderedPacket(workspaceDir, request.actionId, packet);

  // One attempt, one identity. The action id groups a retry and the
  // diagnosis-directed replacement that follows it under the same name, so the
  // ledger needs something that separates them — minted here, echoed back by
  // the kernel with its judgment, and never interpreted by either side.
  //
  // Reused when the last attempt for this action has not been JUDGED. A
  // dispatch pauses for a budget or human approval after materializing, and the
  // resume materializes again; minting a fresh identity there would put a row
  // in the history for an attempt that never ran, which is precisely the
  // "dispatched but never judged" ambiguity this field exists to remove.
  const attemptRef = await unjudgedAttemptRef(workspaceDir, request.actionId) ?? randomUUID();

  // The attempt ledger diagnosis reads. Only the dispatcher knows what the
  // kernel's strategy fingerprint MEANT — which capability, against which
  // effect — and only the kernel knows how the last attempt was judged, so the
  // record is written here, at the one point where both are in hand. Without
  // it `build_diagnosis_packet` has no objective to diagnose, and the
  // corrective path the kernel just demanded cannot run at all.
  await appendAttemptRecord(workspaceDir, {
    objective,
    attempt_ref: attemptRef,
    fingerprint: `${capability}:${scopeKey}:${rejudged.map((f) => f.id).sort().join(",")}`,
    capability,
    effect: String(rejudged[0]!.required_effect),
    // What this attempt IS, not how the last one turned out. The kernel reports
    // each judgment through its outcome channel and `recordAttemptOutcome`
    // resolves the row in place, so a row still reading `dispatched` means an
    // attempt that has genuinely not been judged yet — which is the one thing
    // a diagnosis has to be able to tell apart from a strategy that failed.
    outcome: "dispatched",
    action_id: request.actionId,
    metric: rejudged[0]!.acceptance_metric === null
      ? null : String(rejudged[0]!.acceptance_metric),
    at: new Date().toISOString(),
  });

  return ActionInstance.parse({
    version: 1,
    kind: "action_instance",
    from_template: capability,
    action_id: request.actionId,
    findings: rejudged.map((finding) => finding.id),
    scope_key: scopeKey,
    // The packet is an input, and so is every artifact this instance owns:
    // a worker that cannot read what it must edit will rewrite it from nothing.
    // Verbatim in the kernel, so everything the worker will open is named
    // here: the packet, the artifacts under repair, and every input the engine
    // declares this unit requires. Optional inputs are included only when they
    // exist — copying an absent path is not a narrowing, it is a no-op that
    // hides which ones were actually available.
    reads: [...new Set([
      packetPath, ...owns,
      ...(request.requiredInputs ?? []),
      ...await presentOptionalReads(workspaceDir, request, owns),
    ])].sort(),
    owns,
    writes: owns,
    acceptance,
    must_preserve: mustPreserve,
    deferred_invariants: deferredInvariants,
    // Named explicitly so the kernel makes it a required input and puts it in
    // front of the worker, rather than leaving a compiled contract on disk that
    // the prompt never mentions.
    packet_path: packetPath,
    // Least privilege, per capability AND per effect. The kernel narrows the
    // catalog grant to this set and refuses anything the template did not
    // already allow, so an escalation cannot acquire a tool along with it.
    requested_tools: [...new Set(rejudged.flatMap((finding) =>
      toolGrantFor(capability, String(finding.required_effect))))].sort(),
    ...(appliedDirective === undefined ? {} : { applied_directive: appliedDirective }),
    ...(template.retains_envelope ? { retains_template_envelope: true } : {}),
    attempt_ref: attemptRef,
    // Scope belongs in the identity: the same repair against a different
    // section is different work, and omitting it would make the second one
    // look like a repeat of the first.
    strategy_key: ["template", "finding_ids", "scope_key", "acceptance"],
  });
}

/** The optional reads this dispatch actually needs and that actually exist.
 *
 * The template's readable surface is a ceiling written for every dispatch this
 * capability will ever make; a repair of two sections does not need every
 * chapter, every source record and every evidence packet copied into its
 * isolated workspace. What it does need is the configuration and the planning
 * artifacts it was told to consult, so those are taken and the broad globs are
 * not — the concrete artifacts under repair are already in `owns`. */
async function presentOptionalReads(
  workspaceDir: string, request: MaterializeRequest, owns: string[],
): Promise<string[]> {
  const wanted = (request.readable ?? []).filter((entry) =>
    !entry.includes("*") && !entry.endsWith("/") && !owns.includes(entry));
  const present: string[] = [];
  for (const rel of wanted) {
    if (await fs.access(path.join(workspaceDir, rel)).then(() => true, () => false)) present.push(rel);
  }
  return present;
}

/** Fill in targets the evaluator did not record, for the cases where doing so
 * is reading a chosen number rather than inventing one.
 *
 * Two cases qualify. A `boolean` metric has one satisfying value by
 * definition — 1 when higher is better, 0 when lower is. A `global` metric at
 * the global scope has exactly one objective for the whole workspace, so the
 * configured target IS its target. Everything else — any scope-varying metric,
 * and any global metric asked about at a section scope — is left absent, and
 * the single refusal in buildRepairPacket rejects the action. */
async function resolveTargets(
  workspaceDir: string, request: MaterializeRequest,
): Promise<ReadonlyMap<string, ScopedTarget>> {
  const merged = new Map<string, ScopedTarget>(request.targets ?? []);
  for (const finding of request.findings) {
    if (finding.acceptance_metric === null) continue;
    const metric = String(finding.acceptance_metric);
    const scope = finding.objective_scope_key ?? "";
    const key = `${metric} ${scope}`;
    if (merged.has(key) || merged.has(`${metric} `)) continue;
    const definition = metricDefinition(metricId(metric));
    if (definition.scope_kind !== "global" || scope !== "") continue;
    const operator = definition.direction === "minimize" ? "at_most" : "at_least";
    const tolerance = definition.target_type === "count" || definition.target_type === "boolean" ? 0 : 1e-6;
    if (definition.target_type === "boolean") {
      merged.set(key, { operator, target: definition.direction === "minimize" ? 0 : 1, tolerance });
      continue;
    }
    const configured = await criterionForFinding(workspaceDir, finding);
    // A different metric means the builder fell back to the gate's own
    // criterion: no configured target exists, so none is recorded here.
    if (configured.metric !== metric || configured.target === undefined) continue;
    merged.set(key, { operator: configured.operator ?? operator, target: configured.target, tolerance });
  }
  return merged;
}

function compileAcceptance(
  request: MaterializeRequest, scopeKey: string, targets: ReadonlyMap<string, ScopedTarget>,
  capability: string, template: { evaluate_with: readonly string[] },
): unknown[] {
  const criteria: unknown[] = [];
  const seen = new Set<string>();
  for (const finding of request.findings) {
    if (finding.acceptance_metric === null) {
      // No registered metric tracks this defect, so acceptance is the gate
      // running again and coming back clean. verification_id IS the gate id.
      const key = `verification:${String(finding.gate_id)}:${scopeKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Materialization is the LAST point where the run can still be told the
      // truth. A criterion naming a gate nothing can re-run is one nothing
      // could ever satisfy, and dispatching it spends a round to discover
      // that.
      if (typeof VERIFIERS[String(finding.gate_id)] !== "function") {
        throw new Error(
          `finding ${finding.id} needs a verification criterion for gate ${String(finding.gate_id)}, ` +
          `but no verifier is registered for it; register one or give the finding an acceptance metric`);
      }
      criteria.push({
        kind: "verification", verification_id: String(finding.gate_id),
        scope_key: scopeKey, expect_pass: true,
      });
      continue;
    }
    const metric = String(finding.acceptance_metric);
    const key = `metric:${metric}:${scopeKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const definition = metricDefinition(metricId(metric));
    // Read from the observation for THIS EXACT SCOPE. A metric-wide default
    // would judge every scope against one number, and a scope-varying
    // objective would report a correct repair as a failure.
    // A criterion this capability cannot MEASURE is one it can never satisfy.
    // The kernel judges an unreported metric as `measurement_failed`, which
    // reads as a broken repair rather than as a manifest that never arranged
    // to look — so it is refused here, where the capability and the stage it
    // is missing can both be named.
    const producer = definition.measurement_kind === "model"
      ? `acquire_${metric}`
      : `measure_${definition.measurement_tier}_metrics`;
    if (!template.evaluate_with.includes(producer)) {
      throw new Error(
        `${capability} would be judged on ${metric}, which none of its declared measurements ` +
        `(${template.evaluate_with.join(", ") || "none"}) reports; add ${producer} to its ` +
        `evaluate_with, or route this finding to a capability that measures it`);
    }
    const scoped = targets.get(`${metric} ${scopeKey}`);
    if (scoped) {
      criteria.push({
        kind: "metric", metric, scope_key: scopeKey,
        operator: scoped.operator, target: scoped.target,
        tolerance: scoped.tolerance ?? (definition.target_type === "count" ? 0 : 1e-6),
        direction: definition.direction,
      });
      continue;
    }
    // No target for this metric at this scope, and resolveTargets declined to
    // supply one because the objective varies by scope. Refuse here, where the
    // metric and scope are both known, rather than let a later guard report
    // only that the action ended up with no criteria.
    throw new Error(
      `${metric} at scope "${scopeKey || "(global)"}" carries no operator/target and no configured ` +
      `objective for this scope; a criterion with an invented target is worse than no action at all`);
  }
  if (criteria.length === 0) {
    throw new Error(`action ${request.actionId} would carry no acceptance criterion; nothing could satisfy it`);
  }
  return criteria;
}

/** The objective an attempt was against, in the form the diagnosis packet and
 * the kernel both use: metric and scope, or the gate when no metric tracks it. */
function objectiveOf(request: MaterializeRequest, scopeKey: string): string {
  const first = request.findings[0]!;
  const name = first.acceptance_metric === null
    ? `gate:${String(first.gate_id)}` : String(first.acceptance_metric);
  return scopeKey === "" ? name : `${name} ${scopeKey}`;
}

async function readPriorAttempts(
  workspaceDir: string, objective: string,
): Promise<Array<{ fingerprint: string; capability: string; effect: string; outcome: string }>> {
  return (await collapsedAttempts(workspaceDir))
    .filter((row) => row.objective === objective)
    .map((row) => ({
      fingerprint: row.fingerprint, capability: row.capability,
      effect: row.effect, outcome: row.outcome,
    }));
}


/** The identity of an attempt that was compiled and never judged. */
async function unjudgedAttemptRef(workspaceDir: string, actionId: string): Promise<string | null> {
  const rows = await collapsedAttempts(workspaceDir);
  const last = rows.filter((row) => row.action_id === actionId).pop();
  return last !== undefined && last.outcome === "dispatched" && last.attempt_ref !== undefined
    ? last.attempt_ref : null;
}

async function appendAttemptRecord(workspaceDir: string, record: AttemptRecord): Promise<void> {
  const target = path.join(workspaceDir, ATTEMPTS_PATH);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.appendFile(target, `${JSON.stringify(AttemptRecord.parse(record))}\n`, "utf-8");
}
