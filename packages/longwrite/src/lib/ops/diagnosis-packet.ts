
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { safeFileStem } from "../research/evidence.js";

/** One attempt against an objective, as the dispatcher recorded it.
 *
 * The kernel's own journal knows a strategy fingerprint but not what the
 * domain meant by it, so the capability and effect are recorded here, beside
 * the outcome the kernel returned. */
export const AttemptRecord = z.object({
  objective: z.string().min(1),
  fingerprint: z.string().min(1),
  capability: z.string().min(1),
  effect: z.string().min(1),
  outcome: z.string().min(1),
  /** The identity of ONE attempt.
   *
   * The plan's action id is a grouping, not an identity: a retry and a
   * diagnosis-directed replacement reuse it, so a ledger keyed on it collapsed
   *
   *   a1 / strategy A / unmet
   *   a1 / strategy B / unmet
   *
   * into strategy B alone, and the next diagnosis was told A had never been
   * tried. This is minted per materialization and echoed back by the kernel
   * with its judgment, so the two rows for one attempt join and two attempts
   * never do. */
  attempt_ref: z.string().min(1).optional(),
  /** Grouping metadata: which dispatch item this attempt belonged to. */
  action_id: z.string().min(1).optional(),
  metric: z.string().min(1).nullable().default(null),
  at: z.string().datetime().optional(),
}).strict();
export type AttemptRecord = z.infer<typeof AttemptRecord>;

export const ATTEMPTS_PATH = path.join("repair", "attempts.jsonl");
const REACHABILITY_PATH = path.join("reviews", "reachability.json");
const OBSERVATION_STORE = path.join(".malaclaw", "observations");

export const DiagnosisPacket = z.object({
  version: z.literal(1),
  objective: z.string().min(1),
  prior_attempts: z.array(AttemptRecord).default([]),
  /** Every value recorded for the objective's metric, oldest first, so the
   * diagnosing unit can see a plateau rather than a single number. */
  observations: z.array(z.object({
    metric: z.string().min(1), scope_key: z.string(), value: z.number(),
    sequence: z.number().int().nonnegative().optional(),
    measured_at: z.string().optional(),
  }).strict()).default([]),
  /** Whether the objective is reachable at all. `unknown` is a real answer:
   * saying "reachable" because nothing computed it would send another round at
   * a target nothing can hit. */
  reachability: z.object({
    status: z.enum(["reachable", "unreachable", "unknown"]),
    detail: z.string().min(1),
  }).strict(),
  /** What the failed action was actually given. A diagnosis that cannot see
   * the packet is guessing about the attempt it is diagnosing. */
  failed_packet: z.unknown().nullable().default(null),
}).strict();
export type DiagnosisPacket = z.infer<typeof DiagnosisPacket>;

/** The attempt ledger with each attempt reduced to its LATEST row.
 *
 * The ledger is append-only, so one attempt appears twice — once when it is
 * dispatched and again when the kernel reports how it was judged. Reading every
 * row would show one strategy as two, half of which never failed.
 *
 * Collapsed on `attempt_ref`, which identifies an attempt, and NOT on
 * `action_id`, which only groups them: the same plan item is reused by a retry
 * and by the diagnosis-directed replacement that follows it, so collapsing on
 * it discarded the strategy whose failure caused the diagnosis in the first
 * place. A row with no reference keeps its own identity, since nothing can be
 * said to supersede it. */
export async function collapsedAttempts(workspaceDir: string): Promise<AttemptRecord[]> {
  const raw = await fs.readFile(path.join(workspaceDir, ATTEMPTS_PATH), "utf-8").catch(() => "");
  const rows = raw.split("\n").filter((line) => line.trim() !== "")
    .map((line) => AttemptRecord.parse(JSON.parse(line)));
  const latest = new Map<string, AttemptRecord>();
  for (const row of rows) {
    if (row.attempt_ref !== undefined) latest.set(row.attempt_ref, row);
  }
  // Dispatch order preserved: a diagnosis reads this as a history, and a
  // history reordered by when its last update happened is not one.
  const seen = new Set<string>();
  const ordered: AttemptRecord[] = [];
  for (const row of rows) {
    if (row.attempt_ref === undefined) { ordered.push(row); continue; }
    if (seen.has(row.attempt_ref)) continue;
    seen.add(row.attempt_ref);
    ordered.push(latest.get(row.attempt_ref)!);
  }
  return ordered;
}

/** Every observation recorded for one metric, in sequence order.
 *
 * Read from the engine-owned store, not from a domain copy: the kernel is the
 * only writer, and a second view of the same numbers is a second thing to keep
 * in step. */
async function observationHistory(workspaceDir: string, metric: string | null): Promise<DiagnosisPacket["observations"]> {
  if (!metric) return [];
  const root = path.join(workspaceDir, OBSERVATION_STORE, encodeURIComponent(metric));
  const scopes = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const rows: DiagnosisPacket["observations"] = [];
  for (const scope of scopes) {
    if (!scope.isDirectory()) continue;
    const dir = path.join(root, scope.name);
    for (const entry of await fs.readdir(dir).catch(() => [])) {
      if (!entry.endsWith(".json")) continue;
      const record = JSON.parse(await fs.readFile(path.join(dir, entry), "utf-8")) as {
        metric?: string; scope_key?: string; value?: number; sequence?: number; measured_at?: string;
      };
      if (typeof record.value !== "number") continue;
      rows.push({
        metric: record.metric ?? metric,
        scope_key: record.scope_key ?? "",
        value: record.value,
        ...(record.sequence === undefined ? {} : { sequence: record.sequence }),
        ...(record.measured_at === undefined ? {} : { measured_at: record.measured_at }),
      });
    }
  }
  return rows.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
}

/** Assembles everything the diagnosing unit needs to choose a DIFFERENT
 * strategy — and nothing it could use to lower the target.
 *
 * This is the one unit that sees the whole history of an objective. That is
 * precisely why every other unit may reject a repeated strategy strictly: the
 * escape hatch is diagnosis, not a relaxed rule elsewhere. */
export async function buildDiagnosisPacket(
  workspaceDir: string, objective: string,
): Promise<DiagnosisPacket> {
  // Collapsed, not raw. Each attempt is appended twice — once when it is
  // dispatched and once when the kernel reports how it was judged — and a
  // diagnosis reading both would see one strategy as two, half of which never
  // failed.
  const attempts = (await collapsedAttempts(workspaceDir))
    .filter((row) => row.objective === objective);

  const metric = attempts.map((attempt) => attempt.metric).find((value) => value !== null) ?? null;
  const observations = await observationHistory(workspaceDir, metric);

  const reachabilityRaw = await fs.readFile(path.join(workspaceDir, REACHABILITY_PATH), "utf-8").catch(() => null);
  const reachability = reachabilityRaw === null
    ? { status: "unknown" as const, detail: "no reachability verdict has been computed for this objective" }
    : (() => {
        const parsed = JSON.parse(reachabilityRaw) as { verdicts?: Array<{ objective?: string; status?: string; detail?: string }> };
        const found = (parsed.verdicts ?? []).find((entry) => entry.objective === objective);
        return found?.status === "reachable" || found?.status === "unreachable"
          ? { status: found.status, detail: found.detail ?? `${objective} is ${found.status}` }
          : { status: "unknown" as const, detail: `no verdict recorded for ${objective}` };
      })();

  const lastAction = [...attempts].reverse().find((attempt) => attempt.action_id !== undefined)?.action_id;
  const failedPacket = lastAction === undefined ? null : await fs
    .readFile(path.join(workspaceDir, "repair", safeFileStem(lastAction), "packet.json"), "utf-8")
    .then((raw) => JSON.parse(raw) as unknown)
    .catch(() => null);

  return DiagnosisPacket.parse({
    version: 1,
    objective,
    prior_attempts: attempts,
    observations,
    reachability,
    failed_packet: failedPacket,
  });
}

export async function writeDiagnosisPacket(
  workspaceDir: string, packet: DiagnosisPacket,
): Promise<string> {
  const rel = path.join("repair", "diagnosis-packet.json");
  const target = path.join(workspaceDir, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(DiagnosisPacket.parse(packet), null, 2)}\n`, "utf-8");
  return rel;
}
