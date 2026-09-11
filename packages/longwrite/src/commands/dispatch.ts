import fs from "node:fs/promises";
import path from "node:path";

/** The three commands the kernel drives directly.
 *
 * Each reads its request (where there is one), computes, and writes exactly one
 * JSON document to `--output`. None prints its result to stdout, because the
 * kernel reads a file: a command that only logged its answer could be described
 * in a manifest and never actually consumed. */

async function writeJson(target: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(path.resolve(target)), { recursive: true });
  await fs.writeFile(path.resolve(target), `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function requireOption(value: string | undefined, name: string, command: string): string {
  if (!value) {
    throw new Error(
      `${command} requires ${name}; the kernel appends it, so a command that cannot accept it ` +
      `can be described in a manifest but never executed`);
  }
  return value;
}

/** Turns one validated finding set into an ActionInstance — or an
 * OperatorRequiredBlocker, which is the other legitimate answer. */
export async function runMaterializeAction(
  workspaceDir: string, options: { request?: string; output?: string },
): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const requestPath = requireOption(options.request, "--request", "materialize-action");
  const outputPath = requireOption(options.output, "--output", "materialize-action");
  const { materializeAction } = await import("../lib/ops/action-instance.js");
  const raw = JSON.parse(await fs.readFile(path.resolve(requestPath), "utf-8")) as {
    action_id?: string;
    findings?: unknown[];
    finding_ids?: string[];
    observations?: Record<string, number>;
    unavailable?: string[];
    prior_outcome?: string | null;
    targets?: Record<string, { operator: "at_least" | "at_most" | "equals"; target: number; tolerance?: number }>;
    directives?: Array<{
      id?: string;
      objective: string; decision: string; detail?: string;
      next_effect?: string; next_capability?: string;
    }>;
    readable?: string[];
    required_inputs?: string[];
  };
  if (!raw.action_id) throw new Error("materialization request must carry an action_id");

  // The kernel sends finding IDS, not finding bodies: it has no registry and
  // no way to represent a structured finding without learning what one means.
  // The domain resolves them from the report its own producers wrote — which
  // is the only place the (gate, artifact kind, required effect) triple that
  // decides routing actually exists.
  let findings: unknown[];
  if (Array.isArray(raw.findings) && raw.findings.length > 0) {
    findings = raw.findings;
  } else {
    const { structuredFindingsFromValidation } = await import("../lib/ops/action-plan.js");
    const wanted = new Set(raw.finding_ids ?? []);
    const known = await structuredFindingsFromValidation(resolved);
    findings = known.filter((finding) => wanted.has(finding.id));
    const missing = [...wanted].filter((id) => !findings.some((finding) => (finding as { id: string }).id === id));
    if (missing.length > 0) {
      throw new Error(
        `no structured finding is recorded for ${missing.join(", ")}; ` +
        `a repair cannot be materialized from a finding id alone`);
    }
  }
  if (findings.length === 0) {
    throw new Error(`materialization request for ${raw.action_id} names no finding`);
  }

  const result = await materializeAction(resolved, {
    actionId: raw.action_id,
    findings: findings as never,
    observations: new Map(Object.entries(raw.observations ?? {})),
    unavailable: new Set(raw.unavailable ?? []),
    priorOutcome: raw.prior_outcome ?? null,
    targets: new Map(Object.entries(raw.targets ?? {})),
    directives: raw.directives ?? [],
    readable: raw.readable ?? [],
    requiredInputs: raw.required_inputs ?? [],
  });
  await writeJson(outputPath, result);
}

/** The pre-dispatch verdict: what cannot be reached, and what could not be
 * classified.
 *
 * Both lists matter. An unreachable objective must not consume a round; an
 * unclassified failure must reach diagnosis rather than stalling the round on
 * a red gate with no next step. */
export async function runReachabilityVerdict(
  workspaceDir: string, options: { output?: string },
): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const outputPath = requireOption(options.output, "--output", "reachability-verdict");
  const { unreachableObjectives } = await import("../lib/research/gate-reachability.js");
  const unreachable = (await unreachableObjectives(resolved)).map((entry) => ({
    objective: entry.gate, detail: entry.detail.slice(0, 2_000),
  }));

  // A failed check whose producer could not classify the failure carries
  // `requires_diagnosis`. It has no routable finding, so nothing would pick it
  // up — this is how it reaches the diagnosis stage.
  const validation = await fs.readFile(path.join(resolved, "reports", "longwrite-validation.json"), "utf-8")
    .then((raw) => JSON.parse(raw) as {
      checks?: Array<{ id?: string; pass?: boolean; requires_diagnosis?: boolean; diagnostic?: string }>;
    })
    .catch(() => ({ checks: [] as Array<{ id?: string; pass?: boolean; requires_diagnosis?: boolean; diagnostic?: string }> }));
  const requiresDiagnosis = (validation.checks ?? [])
    .filter((check) => check.pass === false && check.requires_diagnosis === true && typeof check.id === "string")
    .map((check) => ({
      objective: check.id!,
      detail: (check.diagnostic ?? `${check.id} failed without a routable finding`).slice(0, 2_000),
    }));

  await writeJson(outputPath, { version: 1, unreachable, requires_diagnosis: requiresDiagnosis });
}

/** What the round about to be dispatched would cost, in the same units the
 * run limits are expressed in. */
export async function runCostProbe(
  workspaceDir: string, options: { request?: string; output?: string },
): Promise<void> {
  const outputPath = requireOption(options.output, "--output", "cost-probe");
  const { projectedRoundCost } = await import("../lib/ops/measurement-budget.js");
  const { metricId } = await import("../lib/registry/ids.js");
  const { metricsOfTier } = await import("../lib/registry/metrics.js");

  // The request names the metrics this round would measure. Without one, price
  // the round tier: that is what a round measures by default, and pricing
  // nothing would report every round as free.
  let metrics: string[];
  if (options.request) {
    const raw = JSON.parse(await fs.readFile(path.resolve(options.request), "utf-8")) as { metrics?: string[] };
    metrics = raw.metrics ?? [];
  } else {
    metrics = metricsOfTier("round").map(String);
  }
  const cost = projectedRoundCost(metrics.map((metric) => metricId(metric)));
  await writeJson(outputPath, { version: 1, model_calls: cost.model_calls, renders: cost.renders });
}

/** Answers the verification requests an attempt issued.
 *
 * The kernel issues one request per (gate, scope) AFTER the repair's effects
 * are applied, and cannot answer any of them: `citation_markers_present` names
 * a check only this product implements. This command runs those checks and
 * writes an envelope the kernel ingests.
 *
 * Every answer echoes the request's own `request_id` and `input_digest`. That
 * binding is the point: a result that does not name this request describes an
 * earlier workspace, and letting it satisfy a later criterion is exactly the
 * staleness the post-effect request exists to prevent. */
export async function runAnswerVerifications(
  workspaceDir: string, options: { request?: string; output?: string },
): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const requestPath = requireOption(options.request, "--request", "answer-verifications");
  const outputPath = requireOption(options.output, "--output", "answer-verifications");
  const { runVerification, verifierDigest } = await import("../lib/registry/verifiers.js");
  const raw = JSON.parse(await fs.readFile(path.resolve(requestPath), "utf-8")) as {
    requests?: Array<{
      request_id?: string; verification_id?: string; scope_key?: string; input_digest?: string;
    }>;
  };

  const results = [];
  for (const request of raw.requests ?? []) {
    if (!request.request_id || !request.verification_id || !request.input_digest) {
      throw new Error("a verification request must carry request_id, verification_id and input_digest");
    }
    const scopeKey = request.scope_key ?? "";
    const verdict = await runVerification(request.verification_id, { workspaceDir: resolved, scopeKey });
    results.push({
      verification_id: request.verification_id,
      scope_key: scopeKey,
      request_id: request.request_id,
      status: verdict.status,
      input_digest: request.input_digest,
      verifier_digest: verifierDigest(request.verification_id),
      ...(verdict.diagnostic ? { diagnostic: verdict.diagnostic.slice(0, 8_000) } : {}),
      // An unavailable verdict must say why, and the schema enforces it. The
      // diagnostic is the reason when the verifier supplied one.
      ...(verdict.status === "unavailable"
        ? { reason: (verdict.diagnostic ?? "the verifier could not produce a verdict").slice(0, 2_000) }
        : {}),
    });
  }
  await writeJson(outputPath, { version: 1, results });
}

/** Records how the kernel judged one dispatched attempt.
 *
 * The attempt ledger is written when a repair is MATERIALIZED, because that is
 * the only point where the capability, the effect and the objective are all in
 * hand — but at that point nobody knows yet whether it worked. Left there, the
 * ledger says `dispatched` about every attempt forever, and the diagnosing
 * unit — the one unit that is supposed to see a whole objective's history — is
 * asked to choose a different strategy from a history in which nothing has
 * failed.
 *
 * Append-only. The row is not rewritten in place: `repair/attempts.jsonl` is a
 * journal several processes append to, and a read-modify-write over it would
 * lose a concurrent row. `readPriorAttempts` collapses by action id, keeping
 * the latest, so a resolution supersedes the dispatch it resolves. */
export async function runRecordOutcome(
  workspaceDir: string, options: { record?: string },
): Promise<void> {
  const resolved = path.resolve(workspaceDir);
  const recordPath = requireOption(options.record, "--record", "record-outcome");
  const { ATTEMPTS_PATH, AttemptRecord } = await import("../lib/ops/diagnosis-packet.js");
  const outcome = JSON.parse(await fs.readFile(path.resolve(recordPath), "utf-8")) as {
    action_id?: string | null; attempt_ref?: string | null;
    contract_outcome?: string; execution_outcome?: string;
  };
  // Joined on the ATTEMPT reference, never on the objective string and never on
  // the action id. The objective is named in the kernel's vocabulary on one
  // side and the domain's on the other; the action id groups a retry and its
  // diagnosis-directed replacement under one name, so resolving by it attaches
  // a judgment about strategy B to the row recording strategy A.
  if (!outcome.attempt_ref) return;

  const ledger = path.join(resolved, ATTEMPTS_PATH);
  const raw = await fs.readFile(ledger, "utf-8").catch(() => "");
  const attempt = raw.split("\n").filter((line) => line.trim() !== "")
    .map((line) => AttemptRecord.parse(JSON.parse(line)))
    .filter((row) => row.attempt_ref === outcome.attempt_ref)
    .pop();
  // Nothing to resolve. A dispatched action with no ledger row is a unit that
  // never went through materialization — a plain stage with a corrective hook —
  // and inventing a row for it would put a strategy in the history that no
  // capability ever ran.
  if (!attempt) return;

  // The kernel's two axes stay separate here too. A run that never completed
  // has no contract judgment worth recording as one; saying so keeps a timeout
  // from being read as a strategy that was tried and failed.
  const execution = outcome.execution_outcome ?? "completed";
  const judged = execution === "completed"
    ? (outcome.contract_outcome ?? "not_applicable") : execution;
  await fs.appendFile(ledger,
    `${JSON.stringify(AttemptRecord.parse({ ...attempt, outcome: judged, at: new Date().toISOString() }))}\n`,
    "utf-8");
}
