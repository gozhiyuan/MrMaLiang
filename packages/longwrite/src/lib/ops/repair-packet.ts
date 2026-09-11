import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Criterion } from "malaclaw/sdk";
import { FindingSchema, type Finding } from "../registry/records.js";
import { REGISTRY } from "../registry/producers.js";
import { templateFor } from "../registry/capabilities.js";
import { metricDefinition } from "../registry/metrics.js";
import { metricId } from "../registry/ids.js";
import { safeFileStem } from "../research/evidence.js";
import { redactSecrets, renderPacketPrompt } from "./packet-render.js";

const DEFAULT_LIMITS = { excerpt_bytes: 24_000, packet_bytes: 200_000, max_artifacts: 12 };

export const RepairPacket = z.object({
  version: z.literal(1),
  action_id: z.string().min(1),
  capability: z.string().min(1),
  findings: z.array(FindingSchema).min(1),
  artifacts: z.array(z.object({
    path: z.string().min(1), kind: z.string().min(1),
    excerpt: z.string(), truncated: z.boolean(),
  }).strict()),
  evidence: z.array(z.object({
    source_id: z.string().min(1), locator: z.string().min(1), excerpt: z.string(),
  }).strict()).default([]),
  /** Currently-passing measures this repair must not break, with their current
   * scoped values. Derived from the capability template — never optional
   * caller input, which could silently produce a packet with no invariants. */
  protect: z.array(z.object({
    metric: z.string().min(1), scope_key: z.string(), value: z.number(),
    operator: z.enum(["at_least", "at_most", "equals"]), target: z.number(),
  }).strict()),
  /** The capability the REGISTRY routed this finding to, when diagnosis chose
   * a different one. Its presence is what tells the worker it is being asked
   * under a strategy that replaced a failed one, rather than the obvious one. */
  escalated_from: z.string().min(1).optional(),
  /** Invariants the template protects that this repair CANNOT be judged
   * against, because their evaluator reported them unavailable. Named so the
   * worker reads a deferral rather than an absence. */
  deferred_invariants: z.array(z.string().min(1)).default([]),
  /** The wire Criterion union itself, IMPORTED rather than restated, so the
   * worker sees exactly what the kernel will evaluate and a schema change
   * cannot leave this copy behind. Restating a metric-only shape here would
   * reject every verification criterion — the objectives belonging to the
   * roughly twenty null-metric routes. */
  acceptance: z.array(Criterion),
  prior_attempts: z.array(z.object({
    fingerprint: z.string().min(1), capability: z.string().min(1),
    effect: z.string().min(1), outcome: z.string().min(1),
  }).strict()).default([]),
  untrusted_content: z.array(z.object({
    origin: z.string().min(1), role: z.literal("untrusted_external_content"), body: z.string(),
  }).strict()).default([]),
}).strict();
export type RepairPacket = z.infer<typeof RepairPacket>;

/** Raised instead of building a packet for a finding whose artifact is an
 * operator target. The dispatcher catches it and materializes an
 * `operator_required` blocker naming the target. */
export class OperatorTargetFinding extends Error {
  constructor(readonly findingIds: string[]) {
    super(`findings ${findingIds.join(", ")} name operator targets; there is nothing to repair, only to ask`);
    this.name = "OperatorTargetFinding";
  }
}

function assertInsideWorkspace(workspaceDir: string, relative: string): string {
  const resolved = path.resolve(workspaceDir, relative);
  const root = path.resolve(workspaceDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`unsafe path escapes the workspace: ${relative}`);
  }
  return resolved;
}

/** Containment after symlinks are resolved.
 *
 * Lexical containment answers a question about the STRING. A symlink inside the
 * workspace pointing at ~/.ssh satisfies it, and the packet builder — which
 * runs in the canonical workspace, outside any isolation — would then read that
 * file and put its contents in front of a model. Only the real path can answer
 * where a read actually lands. A path that does not exist yet is checked
 * lexically against its nearest existing ancestor, because a file that is about
 * to be created has no real path to resolve. */
async function assertRealPathInside(workspaceDir: string, relative: string): Promise<string> {
  const lexical = assertInsideWorkspace(workspaceDir, relative);
  const root = await fs.realpath(path.resolve(workspaceDir));
  let probe = lexical;
  for (;;) {
    const real = await fs.realpath(probe).catch(() => null);
    if (real !== null) {
      if (real !== root && !real.startsWith(root + path.sep)) {
        throw new Error(
          `${relative} resolves outside the workspace (${real}); a symlink cannot be used to read ` +
          `a file the packet was never allowed to see`);
      }
      return lexical;
    }
    const parent = path.dirname(probe);
    // Nothing on the path exists: the lexical check is all there is, and it
    // already passed.
    if (parent === probe) return lexical;
    probe = parent;
  }
}

function truncateUtf8(value: string, limit: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf-8") <= limit) return { text: value, truncated: false };
  // Cut on a codepoint boundary: a byte-level cut leaves U+FFFD in the middle
  // of the one paragraph the worker is supposed to read.
  const cut = Buffer.from(value, "utf-8").subarray(0, limit);
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(cut).replace(/�$/, ""), truncated: true };
}

/** Paragraphs around the finding's location, bounded.
 *
 * A static compile-time input list gives every invocation the same context
 * regardless of what it is repairing, and a whole large file dilutes attention
 * on the one paragraph that matters. */
async function excerptFor(
  workspaceDir: string, filePath: string, location: string | undefined, limit: number,
): Promise<{ excerpt: string; truncated: boolean }> {
  const body = await fs.readFile(await assertRealPathInside(workspaceDir, filePath), "utf-8")
    .catch((error: NodeJS.ErrnoException) => {
      // Only "there is no such file" means absence. A permission or I/O failure
      // turned into empty context handed the worker a packet that looked like
      // an artifact with nothing in it, and it rewrote from nothing.
      if (error.code === "ENOENT" || error.code === "EISDIR") return "";
      throw new Error(
        `cannot read ${filePath} for the repair packet (${error.code ?? String(error)}); ` +
        `a worker must not be given empty context in place of an unreadable artifact`);
    });
  const paragraphs = body.split(/\n\s*\n/);
  const terms = (location ?? "").toLowerCase().split(/\W+/).filter((term) => term.length > 3);
  const index = paragraphs.findIndex((paragraph) =>
    terms.some((term) => paragraph.toLowerCase().includes(term)));
  const centre = index >= 0 ? index : 0;
  const window = paragraphs.slice(Math.max(0, centre - 1), centre + 2).join("\n\n");
  const { text, truncated } = truncateUtf8(window, limit);
  return { excerpt: text, truncated };
}

/** One criterion per distinct (acceptance_metric, objective_scope_key).
 *
 * NEVER one per gate. A single gate such as cited_literature_release_gates
 * emits findings against seven different metrics; collapsing them would let a
 * repair that fixed recency claim to have fixed venue mix. A finding whose
 * metric is null is a real defect with no numeric objective, so it takes a
 * verification criterion instead: the gate that found it must re-run clean.
 * `verification_id` IS the gate id. */
export type ScopedTarget = { operator: "at_least" | "at_most" | "equals"; target: number; tolerance?: number };

export function acceptanceForFindings(
  findings: Finding[],
  /** Operator and target for each `metric scope_key`, as the evaluator that
   * produced the observation recorded them. Only the evaluator can know what a
   * scope-varying objective requires, so they are read from the trusted
   * observation and never re-derived here. */
  targets: ReadonlyMap<string, ScopedTarget> = new Map(),
): z.infer<typeof Criterion>[] {
  const criteria = new Map<string, z.infer<typeof Criterion>>();
  for (const finding of findings) {
    const scope = finding.objective_scope_key;
    if (finding.acceptance_metric === null) {
      const key = `verification:${finding.gate_id}:${scope}`;
      if (!criteria.has(key)) {
        criteria.set(key, Criterion.parse({
          kind: "verification",
          verification_id: String(finding.gate_id),
          scope_key: scope,
          expect_pass: true,
        }));
      }
      continue;
    }
    const name = String(finding.acceptance_metric);
    const key = `metric:${name}:${scope}`;
    if (criteria.has(key)) continue;
    const definition = metricDefinition(metricId(name));
    // The target travels with the observation the evaluator produced. Without
    // one there is nothing to compile: a criterion with an invented target is
    // worse than no action at all, because the action would then be judged
    // against a number nobody chose.
    const scoped = targets.get(`${name} ${scope}`) ?? targets.get(`${name} `);
    if (!scoped) {
      throw new Error(
        `${name} at scope "${scope}" has no recorded operator/target; ` +
        `a metric criterion cannot be compiled from a finding alone`);
    }
    criteria.set(key, Criterion.parse({
      kind: "metric",
      metric: name,
      scope_key: scope,
      operator: scoped.operator,
      target: scoped.target,
      tolerance: scoped.tolerance ?? 0,
      direction: definition.direction,
    }));
  }
  return [...criteria.values()];
}

export async function buildRepairPacket(
  workspaceDir: string,
  request: {
    actionId: string;
    findings: Finding[];
    /** Current scoped values, keyed `metric scope_key`, supplied by the engine. */
    observations: Map<string, number>;
    /** Keys a measurement RAN for and reported as unavailable. An invariant
     * listed here has no before-value to be made worse, so the packet records
     * it as deferred rather than refusing the repair; one absent from both
     * this and `observations` was never measured, and is refused. */
    unavailable?: ReadonlySet<string>;
    priorAttempts: RepairPacket["prior_attempts"];
    /** Operator/target per `metric scope_key`, from the evaluator's own
     * observation records. Required for any finding that names a metric. */
    targets?: ReadonlyMap<string, ScopedTarget>;
    evidence?: RepairPacket["evidence"];
    untrusted?: Array<{ origin: string; body: string }>;
    limits?: Partial<typeof DEFAULT_LIMITS>;
    /** A capability diagnosis chose INSTEAD of the routed one.
     *
     * The only legitimate way the packet's capability differs from what the
     * registry resolves, and it has to be explicit: the packet names the
     * capability that will actually run and protects THAT capability's
     * invariants, so a packet still describing the routed one would hand the
     * worker the wrong envelope and the wrong things not to break. Named
     * separately from `capability`, which remains forbidden — a caller may
     * record a decision, never simply assert a different answer. */
    escalation?: { capability: string; because: string };
  },
): Promise<RepairPacket> {
  const limits = { ...DEFAULT_LIMITS, ...request.limits };
  if (safeFileStem(request.actionId) !== request.actionId) {
    throw new Error(`unsafe action id for a repair directory: ${request.actionId}`);
  }
  // A caller that supplies its own protected metrics is a caller that can omit
  // them. Derivation is the whole point, so an attempt to override is refused
  // rather than ignored.
  for (const forbidden of ["templateMustPreserve", "protect", "capability"]) {
    if (forbidden in (request as Record<string, unknown>)) {
      throw new Error(`${forbidden} is derived from the resolved capability and may not be supplied`);
    }
  }

  // An operator target has no path to excerpt and nothing this product can
  // edit. It is a question, not a repair, so it never becomes a packet — the
  // dispatcher turns it straight into a typed blocker instead.
  const operatorTargets = request.findings.filter((finding) => !("path" in finding.artifact));
  if (operatorTargets.length > 0) {
    throw new OperatorTargetFinding(operatorTargets.map((finding) => finding.id));
  }

  // Fails closed: an unrouted finding raises here rather than being handed to
  // whichever capability seemed closest.
  const capabilities = new Set(request.findings.map((finding) => String(REGISTRY.resolveCapability({
    gate: finding.gate_id, kind: finding.artifact.kind, effect: finding.required_effect,
  }))));
  if (capabilities.size > 1) {
    throw new Error(`action ${request.actionId} mixes capabilities: ${[...capabilities].join(", ")}`);
  }
  const routed = [...capabilities][0]!;
  const effective = request.escalation?.capability ?? routed;

  const byPath = new Map(request.findings.map((finding) =>
    [(finding.artifact as { path: string }).path, finding]));
  const artifacts = await Promise.all([...byPath.values()].slice(0, limits.max_artifacts).map(async (finding) => {
    const artifact = finding.artifact as { path: string; kind: string };
    const { excerpt, truncated } = await excerptFor(
      workspaceDir, artifact.path, finding.location, limits.excerpt_bytes);
    return { path: artifact.path, kind: artifact.kind, excerpt, truncated };
  }));

  // Derived from the capability that will actually run — the routed one, or the
  // one diagnosis escalated to. Never simply asserted by the caller.
  const template = templateFor(effective);
  const deferred: string[] = [];
  const protect = template.must_preserve_template.flatMap((name) => {
    const definition = metricDefinition(metricId(String(name)));
    const key = `${String(name)} `;
    const value = request.observations.get(key);
    // An invariant with no current value is unknown, not preserved — unless a
    // measurement ran for it and reported it unavailable, in which case there
    // is no before-value to make worse and the deferral is recorded instead.
    if (value === undefined) {
      if (!request.unavailable?.has(key)) {
        throw new Error(`${String(name)} has no current observation; cannot protect an unmeasured invariant`);
      }
      deferred.push(String(name));
      return [];
    }
    return [{
      metric: String(name), scope_key: "", value,
      operator: definition.direction === "minimize" ? "at_most" as const : "at_least" as const,
      target: value,
    }];
  });

  return RepairPacket.parse({
    version: 1,
    action_id: request.actionId,
    capability: effective,
    ...(request.escalation === undefined ? {} : { escalated_from: routed }),
    findings: request.findings,
    artifacts,
    evidence: request.evidence ?? [],
    protect,
    deferred_invariants: deferred,
    acceptance: acceptanceForFindings(request.findings, request.targets),
    prior_attempts: request.priorAttempts,
    untrusted_content: (request.untrusted ?? []).map((entry) => ({
      origin: entry.origin, role: "untrusted_external_content" as const, body: entry.body,
    })),
  });
}

export async function writeRepairPacket(
  workspaceDir: string, actionId: string, packet: RepairPacket,
): Promise<string> {
  const stem = safeFileStem(actionId);
  const rel = path.join("repair", stem, "packet.json");
  const target = assertInsideWorkspace(workspaceDir, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  // Redacted before it is written, not before it is displayed: the packet is a
  // durable artifact that a later round, an operator and a provider all read.
  const redacted = RepairPacket.parse({
    ...packet,
    findings: packet.findings.map((finding) => ({
      ...finding, diagnostic: redactSecrets(finding.diagnostic),
    })),
    artifacts: packet.artifacts.map((artifact) => ({
      ...artifact, excerpt: redactSecrets(artifact.excerpt),
    })),
    evidence: packet.evidence.map((entry) => ({ ...entry, excerpt: redactSecrets(entry.excerpt) })),
    untrusted_content: packet.untrusted_content.map((entry) => ({
      ...entry, body: redactSecrets(entry.body),
    })),
  });
  await fs.writeFile(target, `${JSON.stringify(redacted, null, 2)}\n`, "utf-8");
  return rel;
}

/** Writes the packet the WORKER reads, beside the one the machine reads.
 *
 * Two files rather than one, because they answer to different readers. The JSON
 * is the record a later round and a diagnosis parse; this is the text a model
 * is handed, with every instruction ahead of the delimited region and the
 * retrieved material inside it, labeled as data. Rendering it only at test time
 * — which is what used to happen — meant the untrusted-content boundary existed
 * everywhere except in front of the worker it was written to protect. */
export async function writeRenderedPacket(
  workspaceDir: string, actionId: string, packet: RepairPacket,
): Promise<string> {
  const rel = path.join("repair", safeFileStem(actionId), "packet.md");
  const target = assertInsideWorkspace(workspaceDir, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${renderPacketPrompt(packet)}\n`, "utf-8");
  return rel.split(path.sep).join("/");
}
