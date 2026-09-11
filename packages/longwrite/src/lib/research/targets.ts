import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveLandmarkTargets } from "./landmark.js";

/** The whole pipeline a research target passes through, from "we want this"
 * to "the manuscript cites it".
 *
 * A single boolean cannot say where a target stopped, and where it stopped is
 * the difference between a retrieval problem, an evidence problem and a
 * ranking decision. */
export const TARGET_STATUSES = [
  "retrieval_pending",
  "retrieved",
  "identity_verified",
  "fulltext_ingested",
  "fulltext_unavailable",
  "evidence_validated",
  "evidence_insufficient",
  "allocated",
  "cited",
] as const;
export const TargetStatus = z.enum(TARGET_STATUSES);
export type TargetStatus = z.infer<typeof TargetStatus>;

/** Why a target left the pipeline.
 *
 * "Search failed", "the full text is paywalled" and "ranking dropped it" are
 * three different outcomes that a free-text note collapses into one blank a
 * later round cannot act on. */
export const EXCLUSION_REASONS = [
  "identity_conflict",
  "source_unavailable",
  "fulltext_unavailable",
  "insufficient_claim_bearing_evidence",
  "duplicate_canonical_target",
  "outside_revised_scope",
  "policy_rejection",
  "capacity_infeasible",
] as const;
export const ExclusionReason = z.enum(EXCLUSION_REASONS);
export type ExclusionReason = z.infer<typeof ExclusionReason>;

export const TargetExclusion = z.object({
  reason: ExclusionReason,
  detail: z.string().min(1).max(2_000).optional(),
  at: z.string().datetime(),
}).strict();

export const TargetTransition = z.object({
  status: TargetStatus,
  at: z.string().datetime(),
  detail: z.string().min(1).max(2_000).optional(),
}).strict();

export const TargetRecord = z.object({
  /** Identity is the landmark target key, never the source id: a target that
   * resolves later must remain the same target. */
  target_key: z.string().min(1),
  source_id: z.string().min(1).nullable().default(null),
  status: TargetStatus,
  reserved: z.boolean().default(false),
  exclusion: TargetExclusion.optional(),
  /** The section this target's evidence was allocated to.
   *
   * Section allocation reserves per SECTION, not globally: proposing every
   * landmark to every section is what made one section's packet infeasible
   * because of landmarks belonging to another. */
  allocated_section: z.string().min(1).optional(),
  /** Every state this target has been in. Overwriting the status alone leaves
   * a ledger that cannot say whether a target reached full text and lost it or
   * never got there. */
  history: z.array(TargetTransition).default([]),
}).strict();
export type TargetRecord = z.infer<typeof TargetRecord>;

export const TargetLedger = z.object({
  version: z.literal(1),
  updated_at: z.string().datetime(),
  targets: z.array(TargetRecord).default([]),
}).strict();
export type TargetLedger = z.infer<typeof TargetLedger>;

const LEDGER = path.join("research", "target-ledger.json");

/** Moves a target forward, keeping where it has been.
 *
 * The transition recorded in history is the status being LEFT, so the history
 * plus the current status reads as the full path. */
export function advance(record: TargetRecord, status: TargetStatus, detail?: string): TargetRecord {
  return TargetRecord.parse({
    ...record,
    status,
    history: [...record.history, TargetTransition.parse({
      status: record.status, at: new Date().toISOString(), ...(detail ? { detail } : {}),
    })],
  });
}

export async function readTargets(workspaceDir: string): Promise<TargetRecord[]> {
  const file = path.join(workspaceDir, LEDGER);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch (error) {
    // Absent means no targets have been reserved yet. Unreadable means we
    // cannot tell, and answering "none" would let a run re-reserve targets it
    // has already excluded.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`cannot read ${file}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
  }
  return TargetLedger.parse(JSON.parse(raw)).targets;
}

export async function writeTargets(workspaceDir: string, targets: TargetRecord[]): Promise<string> {
  const file = path.join(workspaceDir, LEDGER);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const ledger = TargetLedger.parse({
    version: 1, updated_at: new Date().toISOString(),
    targets: [...targets].sort((a, b) => a.target_key.localeCompare(b.target_key)),
  });
  await fs.writeFile(file, `${JSON.stringify(ledger, null, 2)}\n`, "utf-8");
  return file;
}

/** Reconcile the ledger against current landmark resolution.
 *
 * A target is keyed by its landmark key, so an unresolved target that is later
 * discovered gains a source id rather than becoming a second target. An
 * existing exclusion is never overwritten: its typed reason is what a later
 * round needs to decide whether to try again. */
export async function reconcileLandmarkTargets(
  workspaceDir: string,
): Promise<{ reserved: number; resolved: number; ledgerPath: string }> {
  const resolutions = await resolveLandmarkTargets(workspaceDir);
  const held = new Map((await readTargets(workspaceDir)).map((record) => [record.target_key, record]));
  for (const resolution of resolutions) {
    const existing = held.get(resolution.target_key);
    const status = resolution.resolved_source_id ? "retrieved" : "retrieval_pending";
    if (existing) {
      held.set(resolution.target_key, TargetRecord.parse({
        ...existing,
        source_id: resolution.resolved_source_id ?? existing.source_id,
        status: existing.exclusion ? existing.status
          : (existing.status === "retrieval_pending" ? status : existing.status),
        reserved: true,
      }));
      continue;
    }
    held.set(resolution.target_key, TargetRecord.parse({
      target_key: resolution.target_key,
      source_id: resolution.resolved_source_id,
      status, reserved: true, history: [],
    }));
  }
  const targets = [...held.values()];
  return {
    reserved: targets.filter((record) => record.reserved && !record.exclusion).length,
    resolved: targets.filter((record) => record.source_id !== null).length,
    ledgerPath: await writeTargets(workspaceDir, targets),
  };
}

/** The artifact that proves a target reached each status.
 *
 * Progress is READ from the pipeline's own outputs rather than reported by the
 * stage that made it. A stage that announces its own success can be believed
 * only about work it actually did; the ledger has to survive a stage that
 * crashed after writing half its output, and a run resumed in another process.
 * So the evidence is the artifact, and this reconciliation is idempotent. */
const PROGRESSION: TargetStatus[] = [
  "retrieved", "identity_verified", "fulltext_ingested", "evidence_validated", "cited",
];

async function readLines(workspaceDir: string, rel: string): Promise<string[]> {
  const raw = await fs.readFile(path.join(workspaceDir, rel), "utf-8").catch(() => "");
  return raw.split("\n").filter((line) => line.trim() !== "");
}

/** Source ids the pipeline has demonstrably carried to each stage. */
async function reachedByStatus(workspaceDir: string): Promise<Map<TargetStatus, Set<string>>> {
  const identityVerified = new Set<string>();
  for (const line of await readLines(workspaceDir, "sources/classified_sources.jsonl")) {
    try {
      const source = JSON.parse(line) as { id?: string };
      if (source.id) identityVerified.add(source.id);
    } catch { /* a malformed line proves nothing about any target */ }
  }

  const fulltextIngested = new Set<string>();
  for (const id of identityVerified) {
    // The ingest writes one file per source, named by its id. Its presence is
    // the fact; a manifest entry without the file is a claim.
    const exists = await fs.stat(path.join(workspaceDir, "fulltext", `${id}.md`))
      .then(() => true).catch(() => false);
    if (exists) fulltextIngested.add(id);
  }

  const evidenceValidated = new Set<string>();
  const evidenceRaw = await fs.readFile(
    path.join(workspaceDir, "evidence", "active-validated-source-evidence.json"), "utf-8").catch(() => null);
  if (evidenceRaw !== null) {
    try {
      const parsed = JSON.parse(evidenceRaw) as { entries?: Array<{ packet?: { source_id?: string } }> };
      for (const entry of parsed.entries ?? []) {
        if (entry.packet?.source_id) evidenceValidated.add(entry.packet.source_id);
      }
    } catch { /* likewise */ }
  }

  const cited = new Set<string>();
  for (const line of await readLines(workspaceDir, "evidence/citation-ledger.jsonl")) {
    try {
      const entry = JSON.parse(line) as { source_id?: string };
      if (entry.source_id) cited.add(entry.source_id);
    } catch { /* likewise */ }
  }

  return new Map<TargetStatus, Set<string>>([
    ["retrieved", identityVerified],
    ["identity_verified", identityVerified],
    ["fulltext_ingested", fulltextIngested],
    ["evidence_validated", evidenceValidated],
    ["cited", cited],
  ]);
}

/** Advances every reserved target to the furthest status its artifacts support.
 *
 * Without this the ledger stops at `retrieved`, and reserve-before-rank holds
 * only for the first selector: `fulltext_ingest`, `source_evidence` and
 * `section_allocation` all reserve statuses nothing ever assigns, so their
 * eligible set is empty and every later selector silently falls back to
 * ranking whatever it happens to see. Movement is forward only — a target does
 * not un-cite itself because a file was rewritten — and an excluded target is
 * left exactly as it is, because its typed reason is what a later round needs. */
export async function reconcileTargetProgress(
  workspaceDir: string,
): Promise<{ advanced: number; ledgerPath: string }> {
  const targets = await readTargets(workspaceDir);
  if (targets.length === 0) return { advanced: 0, ledgerPath: path.join(workspaceDir, LEDGER) };
  const reached = await reachedByStatus(workspaceDir);
  let advanced = 0;
  const updated = targets.map((record) => {
    if (record.exclusion || record.source_id === null) return record;
    const current = PROGRESSION.indexOf(record.status);
    let furthest = current;
    for (let index = 0; index < PROGRESSION.length; index += 1) {
      if (reached.get(PROGRESSION[index]!)?.has(record.source_id) && index > furthest) furthest = index;
    }
    if (furthest <= current || furthest < 0) return record;
    advanced += 1;
    return advance(record, PROGRESSION[furthest]!,
      `reconciled from ${record.status}: the artifacts of record show ${PROGRESSION[furthest]}`);
  });
  return { advanced, ledgerPath: await writeTargets(workspaceDir, updated) };
}

/** The landmarks the ledger says nobody has found yet, written where the
 * retrieval capability can read them.
 *
 * The ledger could already NAME an unresolved landmark; nothing fed it back
 * into retrieval. A target-aware pipeline that identifies a gap and then ranks
 * whatever it happens to have is exactly the disappearance the ledger exists
 * to prevent, one step later: the landmark stays `retrieval_pending` round
 * after round, the coverage ratio stays short, and every round spends its
 * budget on sources nobody asked for.
 *
 * Written even when empty. An absent brief and a brief saying "nothing is
 * outstanding" are different claims, and only one of them is evidence that the
 * ledger was consulted. */
export const RETRIEVAL_BRIEF = path.join("research", "retrieval-brief.json");

export async function writeRetrievalBrief(
  workspaceDir: string,
): Promise<{ pending: number; briefPath: string }> {
  const { pendingRetrievalTargets } = await import("./reservation.js");
  const targets = await readTargets(workspaceDir);
  const pending = pendingRetrievalTargets(targets);
  // The candidate list carries what a searcher actually needs — the name and
  // why it is canonical. The ledger carries only the key, because a target must
  // stay the same target however its description is later edited.
  const candidates = await resolveLandmarkTargets(workspaceDir);
  const described = new Map(candidates.map((entry) => [entry.target_key, entry.candidate_name]));
  const target = path.join(workspaceDir, RETRIEVAL_BRIEF);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify({
    version: 1,
    generated_at: new Date().toISOString(),
    outstanding: pending.map((record) => ({
      target_key: record.target_key,
      candidate_name: described.get(record.target_key) ?? null,
      // Every state it has been in, so a round can tell "never searched for"
      // from "searched for and not found".
      attempts: record.history.length,
    })),
  }, null, 2)}\n`, "utf-8");
  return { pending: pending.length, briefPath: RETRIEVAL_BRIEF };
}
