import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  ExclusionReason as ExclusionReasonSchema, TargetRecord, readTargets, reconcileTargetProgress, writeTargets,
  type ExclusionReason, type TargetStatus,
} from "./targets.js";

export class CapacityInfeasible extends Error {
  constructor(readonly selector: string, readonly reserved: number, readonly capacity: number) {
    super(
      `${selector}: ${reserved} reserved targets exceed capacity ${capacity}. ` +
      `Raise the selector's capacity or narrow the reserved set. This pauses before any work ` +
      `rather than silently dropping the targets that do not fit.`,
    );
    this.name = "CapacityInfeasible";
  }
}

export class ReservationViolation extends Error {
  constructor(readonly selector: string, readonly vanished: string[]) {
    super(
      `${selector} dropped ${vanished.length} reserved target(s) without a typed exclusion: ` +
      `${vanished.join(", ")}. A reserved target must be selected or explicitly excluded with a ` +
      `reason; it may never simply vanish because generic ranking filled the queue.`,
    );
    this.name = "ReservationViolation";
  }
}

export type CapacityPlan = {
  reserved: string[];
  free_slots: number;
  infeasible: boolean;
  detail: string;
};

/** Decide capacity BEFORE ranking, matching the reserve-before-rank pattern
 * already in semantic-screen.ts — and, unlike it, refusing to truncate an
 * over-subscribed reserve.
 *
 * Its reserve loop is guarded by `selected.size < max_candidates`, so
 * reservations beyond capacity are dropped silently: the target was reserved,
 * then disappeared, and nothing records that it ever existed. Reporting
 * infeasibility is what turns that into a decision someone makes. */
export function planCapacity(input: {
  selector: string; reserved: string[]; capacity: number; enforce?: boolean;
}): CapacityPlan {
  const infeasible = input.reserved.length > input.capacity;
  const detail = infeasible
    ? `${input.selector}: ${input.reserved.length} reserved targets exceed capacity ${input.capacity}`
    : `${input.selector}: ${input.reserved.length} reserved, ${input.capacity - input.reserved.length} free slots`;
  if (infeasible && input.enforce) throw new CapacityInfeasible(input.selector, input.reserved.length, input.capacity);
  return {
    reserved: [...input.reserved],
    free_slots: Math.max(0, input.capacity - input.reserved.length),
    infeasible, detail,
  };
}

export type Exclusion = { source_id: string; reason: ExclusionReason; detail: string };

/** reserved in == selected + explicitly excluded.
 *
 * The invariant is what makes a dropped target impossible rather than merely
 * unlikely: a selector must either keep what it reserved or say, in the typed
 * vocabulary, why it did not. */
export function assertAccounting(input: {
  selector: string; reservedIn: string[]; selected: string[]; excluded: Exclusion[];
}): void {
  const selected = new Set(input.selected);
  const excluded = new Set(input.excluded.map((entry) => entry.source_id));
  const both = [...selected].filter((id) => excluded.has(id));
  if (both.length > 0) throw new Error(`${input.selector}: ${both.join(", ")} are both selected and excluded`);
  const vanished = input.reservedIn.filter((id) => !selected.has(id) && !excluded.has(id));
  if (vanished.length > 0) throw new ReservationViolation(input.selector, vanished);
}

/** Writes typed exclusions onto the matching ledger records.
 *
 * Matching is by source id, so an unresolved target — which has none — is left
 * alone rather than picking up an exclusion meant for something else. */
export function applyExclusions(records: TargetRecord[], excluded: Exclusion[]): TargetRecord[] {
  const byId = new Map(excluded.map((entry) => [entry.source_id, entry]));
  return records.map((record) => {
    const exclusion = record.source_id === null ? undefined : byId.get(record.source_id);
    if (!exclusion) return record;
    return TargetRecord.parse({
      ...record,
      exclusion: { reason: exclusion.reason, detail: exclusion.detail, at: new Date().toISOString() },
    });
  });
}

const SelectorExclusions = z.object({
  version: z.literal(1),
  exclusions: z.array(z.object({
    selector: z.string().min(1),
    source_id: z.string().min(1),
    reason: ExclusionReasonSchema,
    detail: z.string().min(1).max(2_000),
  }).strict()).default([]),
}).strict();

const EXCLUSIONS_PATH = path.join("sources", "selector-exclusions.json");

/** Exclusions a selector has been told about, in the typed vocabulary.
 *
 * This is the only way a reserved target may leave a selector without being
 * chosen: the alternative is a target that was reserved and then simply was
 * not there, which is the disappearance the ledger exists to make impossible. */
export async function readDeclaredExclusions(
  workspaceDir: string, selector: string,
): Promise<Exclusion[]> {
  const file = path.join(workspaceDir, EXCLUSIONS_PATH);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`cannot read ${file}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
  }
  return SelectorExclusions.parse(JSON.parse(raw)).exclusions
    .filter((entry) => entry.selector === selector)
    .map(({ source_id, reason, detail }) => ({ source_id, reason, detail }));
}

export type SelectorName = "semantic_screen" | "fulltext_ingest" | "source_evidence" | "section_allocation";

/** Which lifecycle states a selector may still reserve capacity for.
 *
 * A target that has finished the pipeline, or that cannot proceed, must stop
 * holding a slot the remaining targets need: a `cited` landmark consuming a
 * screening slot starves one that has not been retrieved yet, and a target with
 * no ingested full text seeded into evidence extraction produces an empty
 * packet that looks like a measured absence. */
export const ELIGIBLE_STATUSES: Record<SelectorName, TargetStatus[]> = {
  semantic_screen: ["retrieved", "identity_verified"],
  fulltext_ingest: ["identity_verified"],
  source_evidence: ["fulltext_ingested"],
  section_allocation: ["evidence_validated"],
};

export function eligibleTargets(
  targets: TargetRecord[], selector: SelectorName, scopeKey?: string,
): TargetRecord[] {
  return targets.filter((record) => {
    if (!record.reserved || record.exclusion) return false;
    if (record.source_id === null) return false;
    if (!ELIGIBLE_STATUSES[selector].includes(record.status)) return false;
    // Section allocation reserves per section, not globally.
    if (selector === "section_allocation") return record.allocated_section === scopeKey;
    return true;
  });
}

/** Targets with no source id yet.
 *
 * They are not selector input — they are RETRIEVAL input. An id-based filter
 * drops them silently, which is exactly the disappearance the ledger exists to
 * prevent: a requested landmark nobody has found becomes indistinguishable
 * from one nobody asked for. */
export function pendingRetrievalTargets(targets: TargetRecord[]): TargetRecord[] {
  return targets.filter((record) =>
    record.reserved && !record.exclusion && record.status === "retrieval_pending");
}

/** Read reservations and declared exclusions, and decide capacity BEFORE the
 * selector ranks anything. Every target-aware selector calls this first. */
export async function reserveForSelector(
  workspaceDir: string, selector: SelectorName, capacity: number, scopeKey?: string,
): Promise<{ reservedIds: string[]; excluded: Exclusion[]; plan: CapacityPlan }> {
  // Bring the ledger up to date with the pipeline's own artifacts FIRST.
  // Eligibility is defined in lifecycle statuses, and until now nothing
  // assigned any status past `retrieved`: `fulltext_ingest`, `source_evidence`
  // and `section_allocation` each reserved a status no code ever set, found
  // nothing eligible, and fell through to ranking whatever the selector
  // happened to see. Reconciling here — the one call every selector already
  // makes before it ranks — is what makes reserve-before-rank hold for all
  // four rather than only the first.
  await reconcileTargetProgress(workspaceDir);
  const targets = await readTargets(workspaceDir);
  const excluded = await readDeclaredExclusions(workspaceDir, selector);
  const excludedIds = new Set(excluded.map((entry) => entry.source_id));
  const reservedIds = eligibleTargets(targets, selector, scopeKey)
    .map((record) => record.source_id!)
    .filter((id) => !excludedIds.has(id));
  const plan = planCapacity({ selector, reserved: reservedIds, capacity, enforce: true });
  return { reservedIds, excluded, plan };
}

/** Called immediately before the selector returns.
 *
 * Inert when nothing was reserved and nothing was excluded, so a workspace
 * with no ledger behaves exactly as it did before. */
export async function settleSelectorReservation(
  workspaceDir: string, selector: SelectorName, selected: string[],
  reservedIds: string[], excluded: Exclusion[],
): Promise<void> {
  if (reservedIds.length === 0 && excluded.length === 0) return;
  assertAccounting({ selector, reservedIn: reservedIds, selected, excluded });
  if (excluded.length > 0) {
    await writeTargets(workspaceDir, applyExclusions(await readTargets(workspaceDir), excluded));
  }
}

/** Assigns each evidence-validated target to exactly one section.
 *
 * Section allocation reserves per section, so a target with no section is
 * reserved nowhere — it would sit `evidence_validated` forever while every
 * packet fills up with generically retrieved material. Assignment is
 * deterministic and it records HOW it was made: an outline that already names
 * the source is an explicit editorial decision and wins; everything else is
 * distributed in stable key order, which is a spread rather than a judgment
 * and is labelled as one.
 *
 * Idempotent: a target that already has a section keeps it, so re-running
 * cannot shuffle allocations underneath a packet that was built from them. */
export async function allocateTargetsToSections(
  workspaceDir: string, sections: Array<{ id: string; sourceIds?: string[] }>,
): Promise<{ assigned: number; targets: TargetRecord[] }> {
  const targets = await readTargets(workspaceDir);
  if (sections.length === 0) return { assigned: 0, targets };

  const declared = new Map<string, string>();
  for (const section of sections) {
    for (const sourceId of section.sourceIds ?? []) {
      if (!declared.has(sourceId)) declared.set(sourceId, section.id);
    }
  }

  let spread = 0;
  let assigned = 0;
  const updated = [...targets]
    .sort((a, b) => a.target_key.localeCompare(b.target_key))
    .map((record) => {
      if (record.exclusion || record.allocated_section !== undefined) return record;
      if (record.status !== "evidence_validated" || record.source_id === null) return record;
      const explicit = declared.get(record.source_id);
      const section = explicit ?? sections[spread++ % sections.length]!.id;
      assigned += 1;
      return TargetRecord.parse({
        ...record,
        allocated_section: section,
        history: [...record.history, {
          status: record.status, at: new Date().toISOString(),
          detail: explicit
            ? `allocated to ${section}: the outline names this source`
            : `allocated to ${section}: distributed in stable key order, no outline assignment`,
        }],
      });
    });

  if (assigned > 0) await writeTargets(workspaceDir, updated);
  return { assigned, targets: updated };
}
