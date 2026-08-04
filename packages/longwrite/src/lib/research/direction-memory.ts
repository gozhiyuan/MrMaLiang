import fs from "node:fs/promises";
import path from "node:path";

/**
 * What has this loop already tried?
 *
 * Each quality round re-plans from scratch. The artifact planner sees the
 * current scorecard and evidence, but not the intents it chose two rounds ago,
 * nor the ones a reviewer already rejected — so a round can spend itself
 * re-proposing something the loop has settled. Rounds differ only in the
 * agent's revisions, which is what makes a loop circle rather than progress.
 *
 * This is append-only memory, folded forward one round at a time: it reads the
 * plan left by the previous round and records it before the next planner runs.
 * On the first round there is nothing to fold and the history is empty, which
 * is why a single stage placed ahead of the planner can both record and serve
 * without an ordering problem.
 *
 * It records what was chosen, not whether choosing it was right. Judging that
 * is the planner's job, and a memory that also ruled things out would quietly
 * become a second planner.
 */
export type TriedDirection = {
  round: number;
  id: string;
  kind: string;
  section_id?: string;
  rationale: string;
};

export type DirectionMemory = {
  version: 1;
  rounds_recorded: number;
  directions: TriedDirection[];
};

const MEMORY_PATH = path.join("reports", "directions-tried.json");

async function readJson<T>(workspaceDir: string, rel: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(workspaceDir, rel), "utf-8")) as T;
  } catch {
    return null;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export async function foldDirectionMemory(workspaceDir: string): Promise<DirectionMemory> {
  const existing = await readJson<DirectionMemory>(workspaceDir, MEMORY_PATH)
    ?? { version: 1 as const, rounds_recorded: 0, directions: [] };
  const plan = await readJson<{ intents?: Array<Record<string, unknown>> }>(workspaceDir, path.join("reviews", "artifact-plan.json"));
  if (!plan?.intents) return existing;

  const round = existing.rounds_recorded + 1;
  // An id can legitimately recur across rounds when a plan is carried forward;
  // recording it once keeps the history a set of tried directions rather than a
  // transcript, which is what the planner needs to avoid repeating itself.
  const known = new Set(existing.directions.map((direction) => `${direction.kind}:${direction.id}`));
  const added = plan.intents.flatMap((intent) => {
    const id = asString(intent.id);
    const kind = asString(intent.kind);
    if (!id || !kind || known.has(`${kind}:${id}`)) return [];
    known.add(`${kind}:${id}`);
    return [{
      round,
      id,
      kind,
      ...(asString(intent.section_id) ? { section_id: asString(intent.section_id)! } : {}),
      rationale: asString(intent.rationale) ?? "",
    }];
  });
  if (added.length === 0) return { ...existing, rounds_recorded: round };
  return { version: 1, rounds_recorded: round, directions: [...existing.directions, ...added] };
}

function markdown(memory: DirectionMemory): string {
  if (memory.directions.length === 0) {
    return [
      "# Directions already tried",
      "",
      "No artifact intent has been recorded yet. This is the first planning round,",
      "so nothing here constrains it.",
      "",
    ].join("\n");
  }
  const lines = [
    "# Directions already tried",
    "",
    `${memory.directions.length} artifact intent(s) across ${memory.rounds_recorded} planning round(s).`,
    "",
    "Proposing one of these again is not forbidden — evidence changes between",
    "rounds, and a direction that failed for want of support may now have it.",
    "But repeating one without saying what changed is how a loop circles. Prefer",
    "a direction absent from this list, and when you do repeat one, say in the",
    "rationale what is different now.",
    "",
    "| Round | Kind | Id | Section |",
    "| ---: | --- | --- | --- |",
  ];
  for (const direction of memory.directions) {
    lines.push(`| ${direction.round} | ${direction.kind} | ${direction.id} | ${direction.section_id ?? "—"} |`);
  }
  lines.push("");
  return lines.join("\n");
}

export async function writeDirectionMemory(workspaceDir: string): Promise<{ memory: DirectionMemory; written: string[] }> {
  const memory = await foldDirectionMemory(workspaceDir);
  await fs.mkdir(path.join(workspaceDir, "reports"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, MEMORY_PATH), `${JSON.stringify(memory, null, 2)}\n`, "utf-8");
  await fs.writeFile(path.join(workspaceDir, "reports", "directions-tried.md"), markdown(memory), "utf-8");
  return { memory, written: ["reports/directions-tried.json", "reports/directions-tried.md"] };
}
