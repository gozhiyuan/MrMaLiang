import fs from "node:fs/promises";
import path from "node:path";

/**
 * Has this loop stopped making progress, and should it change the frame?
 *
 * A quality round is structurally identical to the one before it: review,
 * plan, revise, re-review. When the score stops moving, running the same shape
 * again is the definition of a loop that circles — the decisive gain usually
 * comes from changing a structural constraint rather than tuning harder inside
 * the existing one.
 *
 * So the rule here is about *which kind* of action stays eligible, not about
 * stopping. Below the threshold the planner may choose freely. At it, prose and
 * visual revision drop out and only the two tools that change the frame remain:
 * reopening the outline, or expanding the evidence the paper is built on.
 *
 * The determination is deliberately made from recorded scores rather than by
 * asking the agent whether it is stuck; an agent judging its own progress is
 * the thing that produced the flat rounds.
 */
export const STRUCTURAL_TOOLS = ["reopen_outline", "targeted_research_expansion"] as const;
export const TACTICAL_TOOLS = ["revise_sections", "revise_visual_plan"] as const;

/** Rounds without improvement before the frame itself must change. */
const STRUCTURAL_THRESHOLD = 2;
/** Rounds without improvement that no automatic pivot has rescued. */
const ESCALATION_THRESHOLD = 4;

export type StallStatus = {
  version: 1;
  rounds: number;
  latest_score: number | null;
  best_score: number | null;
  stale_rounds: number;
  posture: "open" | "structural" | "escalate";
  eligible_tools: string[];
  detail: string;
};

type HistoryEntry = { round?: unknown; reviewScore?: unknown };

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function evaluateStall(workspaceDir: string): Promise<StallStatus> {
  let history: HistoryEntry[] = [];
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(workspaceDir, "reports", "score-history.json"), "utf-8"));
    history = Array.isArray(parsed) ? parsed : [];
  } catch {
    history = [];
  }
  const scores = history.map((entry) => asNumber(entry.reviewScore)).filter((score): score is number => score !== null);
  if (scores.length === 0) {
    return {
      version: 1, rounds: 0, latest_score: null, best_score: null, stale_rounds: 0,
      posture: "open", eligible_tools: [...STRUCTURAL_TOOLS, ...TACTICAL_TOOLS],
      detail: "No scored round yet; every action remains eligible.",
    };
  }

  // Count back from the latest round while no round beat the best score that
  // preceded it. A round that merely matches the best is not progress.
  let staleRounds = 0;
  for (let index = scores.length - 1; index > 0; index -= 1) {
    const bestBefore = Math.max(...scores.slice(0, index));
    if (scores[index]! > bestBefore) break;
    staleRounds += 1;
  }
  const latest = scores[scores.length - 1]!;
  const best = Math.max(...scores);
  const posture = staleRounds >= ESCALATION_THRESHOLD ? "escalate"
    : staleRounds >= STRUCTURAL_THRESHOLD ? "structural"
      : "open";

  const detail = posture === "open"
    ? `The review score is still moving (latest ${latest}, best ${best}); the planner may choose any action.`
    : posture === "structural"
      ? `${staleRounds} consecutive rounds have not beaten the best score (latest ${latest}, best ${best}). Revising prose or the visual plan again repeats a shape that has already failed ${staleRounds} times, so only frame-changing actions remain eligible.`
      : `${staleRounds} consecutive rounds have not beaten the best score (latest ${latest}, best ${best}). Structural pivots have not rescued this loop either; the constraint is likely outside what the loop can change, and this run needs an operator decision on scope, evidence budget, or targets.`;

  return {
    version: 1,
    rounds: scores.length,
    latest_score: latest,
    best_score: best,
    stale_rounds: staleRounds,
    posture,
    eligible_tools: posture === "open" ? [...STRUCTURAL_TOOLS, ...TACTICAL_TOOLS] : [...STRUCTURAL_TOOLS],
    detail,
  };
}

function markdown(status: StallStatus): string {
  return [
    "# Loop progress and action eligibility",
    "",
    `- Scored rounds: ${status.rounds}`,
    `- Latest review score: ${status.latest_score ?? "n/a"}`,
    `- Best review score: ${status.best_score ?? "n/a"}`,
    `- Rounds without improvement: ${status.stale_rounds}`,
    `- Posture: **${status.posture}**`,
    "",
    status.detail,
    "",
    "## Eligible actions this round",
    "",
    ...status.eligible_tools.map((tool) => `- ${tool}`),
    "",
    status.posture === "open"
      ? ""
      : "Prose and visual revision are withheld deliberately. Pivot the structure, not the tactics: change the outline's frame or the evidence the paper rests on.",
    "",
  ].join("\n");
}

export async function writeStallStatus(workspaceDir: string): Promise<{ status: StallStatus; written: string[] }> {
  const status = await evaluateStall(workspaceDir);
  await fs.mkdir(path.join(workspaceDir, "reports"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "reports", "stall-status.json"), `${JSON.stringify(status, null, 2)}\n`, "utf-8");
  await fs.writeFile(path.join(workspaceDir, "reports", "stall-status.md"), markdown(status), "utf-8");
  return { status, written: ["reports/stall-status.json", "reports/stall-status.md"] };
}
