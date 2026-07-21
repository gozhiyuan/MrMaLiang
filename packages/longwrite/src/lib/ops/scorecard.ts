import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { parse as parseYaml } from "yaml";
import {
  Scorecard,
  REVIEW_PERSONAS,
  computeReviewScore,
  dimensionsForArtifact,
  routeWeaknesses,
  scorecardSchema,
  type ScoreResult,
  type RoutedWeakness,
} from "../writing/scorecard.js";

export const SCORECARD_PATH = "reviews/scorecard.json";
const HISTORY_PATH = "reports/score-history.json";
const METRICS_PATH = "reports/metrics.json";
const ROUTING_PATH = "reports/routing.md";
const REMEDIATION_PATH = "reports/remediation-plan.json";

/** The workspace's artifact type decides which review dimensions apply
 *  (research vs novel vs technical book). Missing/invalid config falls back
 *  to the research dimensions. */
export async function workspaceDimensions(workspaceDir: string): Promise<readonly string[]> {
  try {
    const raw = await fs.readFile(path.join(workspaceDir, "longwrite.yaml"), "utf-8");
    const config = parseYaml(raw) as { project?: { artifact_type?: string }; research?: { paper_kind?: "survey" | "empirical" } };
    return dimensionsForArtifact(config?.project?.artifact_type, config?.research?.paper_kind ?? "survey");
  } catch {
    // Missing project config occurs in isolated scorecard tests and legacy
    // workspaces. Preserve the historical empirical schema in that case.
    return dimensionsForArtifact(undefined);
  }
}

/** Shown to workers via validator findings so a failed attempt teaches the
 *  exact contract instead of just "invalid scorecard". */
export function scorecardShapeHint(dimensions: readonly string[]): string {
  return [
    `${SCORECARD_PATH} must be JSON: {"version":1,"personas":[{"id":"<persona>","scores":{...},"weaknesses":[{"category":"...","detail":"...","severity":"minor|major|critical"}]}]}`,
    `scores must contain all of: ${dimensions.join(", ")} (numbers 0-10)`,
    `at least 3 personas; recommended: ${REVIEW_PERSONAS.join(", ")}`,
  ].join("\n");
}

export type ScorecardLoad =
  | { ok: true; scorecard: Scorecard; hash: string; dimensions: readonly string[] }
  | { ok: false; findings: string[] };

function scorecardHash(scorecard: Scorecard): string {
  return crypto.createHash("sha256").update(JSON.stringify(scorecard)).digest("hex").slice(0, 16);
}

export async function loadScorecard(workspaceDir: string): Promise<ScorecardLoad> {
  const dimensions = await workspaceDimensions(workspaceDir);
  const absPath = path.join(workspaceDir, SCORECARD_PATH);
  let raw: string;
  try {
    raw = await fs.readFile(absPath, "utf-8");
  } catch {
    return { ok: false, findings: [`${SCORECARD_PATH} is missing`, scorecardShapeHint(dimensions)] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      findings: [
        `${SCORECARD_PATH} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        scorecardShapeHint(dimensions),
      ],
    };
  }
  const result = scorecardSchema(dimensions).safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${SCORECARD_PATH}: ${i.path.join(".")} — ${i.message}`);
    return { ok: false, findings: [...issues, scorecardShapeHint(dimensions)] };
  }
  return { ok: true, scorecard: result.data as Scorecard, hash: scorecardHash(result.data as Scorecard), dimensions };
}

type HistoryEntry = {
  round: number;
  reviewScore: number;
  rawMedian: number;
  scorecardHash?: string;
  /** Weakness categories reported this round — for regression detection. */
  weaknessCategories?: string[];
  ts: string;
};

/** A regression is a weakness category that was RESOLVED in an earlier round
 *  (present, then absent the next round) and has REAPPEARED. AutoResearch's
 *  Gate 5 "prior-fixed weaknesses remain fixed". */
function detectRegressions(history: HistoryEntry[], current: Set<string>): string[] {
  const everFixed = new Set<string>();
  for (let i = 1; i < history.length; i++) {
    const prev = new Set(history[i - 1].weaknessCategories ?? []);
    const cur = new Set(history[i].weaknessCategories ?? []);
    for (const cat of prev) if (!cur.has(cat)) everFixed.add(cat);
  }
  return [...current].filter((cat) => everFixed.has(cat));
}

function scorecardWeaknessCategories(scorecard: Scorecard): Set<string> {
  const categories = new Set<string>();
  for (const persona of scorecard.personas) {
    for (const w of persona.weaknesses ?? []) categories.add(w.category.trim().toLowerCase());
  }
  return categories;
}

async function readHistory(workspaceDir: string): Promise<HistoryEntry[]> {
  try {
    const raw = await fs.readFile(path.join(workspaceDir, HISTORY_PATH), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

async function readMetrics(workspaceDir: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(path.join(workspaceDir, METRICS_PATH), "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export type ScoreWorkspaceResult = ScoreResult & { metricsPath: string };

async function writeMetrics(workspaceDir: string, result: ScoreResult, regressions: string[] = []): Promise<void> {
  const metrics = await readMetrics(workspaceDir);
  const merged = {
    ...metrics,
    review_score: result.reviewScore,
    review_score_raw_median: result.rawMedian,
    review_round: result.round,
    review_regressions: regressions.length,
    ...Object.fromEntries(
      Object.entries(result.dimensionMedians).map(([k, v]) => [`review_${k}`, v]),
    ),
  };

  await fs.mkdir(path.join(workspaceDir, "reports"), { recursive: true });
  await fs.writeFile(path.join(workspaceDir, METRICS_PATH), JSON.stringify(merged, null, 2), "utf-8");
}

/** Compute the official review score and write it into reports/metrics.json,
 *  overwriting any worker-asserted review_score. Appends to score history so
 *  per-round anti-inflation caps survive across revision rounds. */
export async function scoreWorkspace(workspaceDir: string): Promise<ScoreWorkspaceResult> {
  const load = await loadScorecard(workspaceDir);
  if (!load.ok) throw new Error(load.findings.join("\n"));

  const history = await readHistory(workspaceDir);
  const last = history[history.length - 1];
  if (last?.scorecardHash === load.hash) {
    const recomputed = computeReviewScore(
      load.scorecard,
      history.slice(0, -1).map((h) => h.reviewScore),
      load.dimensions,
    );
    const replayed = {
      ...recomputed,
      reviewScore: last.reviewScore,
      rawMedian: last.rawMedian,
      round: last.round,
      capsApplied: recomputed.capsApplied,
      metricsPath: METRICS_PATH,
    };
    await writeMetrics(workspaceDir, replayed);
    return replayed;
  }

  const result = computeReviewScore(load.scorecard, history.map((h) => h.reviewScore), load.dimensions);

  const currentCategories = scorecardWeaknessCategories(load.scorecard);
  const regressions = detectRegressions(history, currentCategories);

  history.push({
    round: result.round,
    reviewScore: result.reviewScore,
    rawMedian: result.rawMedian,
    scorecardHash: load.hash,
    weaknessCategories: [...currentCategories],
    ts: new Date().toISOString(),
  });

  await writeMetrics(workspaceDir, result, regressions);
  await fs.writeFile(path.join(workspaceDir, HISTORY_PATH), JSON.stringify(history, null, 2), "utf-8");
  if (regressions.length > 0) {
    await fs.writeFile(path.join(workspaceDir, "reports", "regressions.md"),
      `# Review Regressions\n\nRound ${result.round} reintroduced weakness categories that ` +
      `a prior round had resolved: ${regressions.join(", ")}. The revision undid earlier fixes; ` +
      `route these back to revision before release.\n`, "utf-8");
  }

  return { ...result, metricsPath: METRICS_PATH };
}

export type RemediationAction = {
  id: "research_expansion" | "evidence_repair" | "structure_revision" | "artifact_rebuild" | "domain_reconciliation" | "prose_revision";
  stage: string;
  priority: "critical" | "major" | "minor";
  weaknesses: Array<{ personaId: string; category: string; detail: string; severity: "minor" | "major" | "critical" }>;
};

export type RouteWorkspaceResult = { routed: RoutedWeakness[]; routingPath: string; remediationPath: string; actions: RemediationAction[] };

function remediationId(stage: string, category: string): RemediationAction["id"] {
  if (stage === "recall") return /citation|source|evidence|reference|bibliograph/i.test(category) ? "evidence_repair" : "research_expansion";
  if (stage === "outline" || stage === "plot_outline") return "structure_revision";
  if (stage === "build") return "artifact_rebuild";
  if (["world_bible", "character_bible"].includes(stage)) return "domain_reconciliation";
  return "prose_revision";
}

const severityRank = { critical: 0, major: 1, minor: 2 } as const;

function remediationActions(routed: RoutedWeakness[]): RemediationAction[] {
  const actions = new Map<string, RemediationAction>();
  for (const weakness of routed) {
    for (const target of weakness.targets) {
      const id = remediationId(target.stage, weakness.category);
      const key = `${id}:${target.stage}`;
      const current = actions.get(key) ?? {
        id,
        stage: target.stage,
        priority: weakness.severity,
        weaknesses: [],
      };
      if (severityRank[weakness.severity] < severityRank[current.priority]) current.priority = weakness.severity;
      current.weaknesses.push({
        personaId: weakness.personaId,
        category: weakness.category,
        detail: weakness.detail,
        severity: weakness.severity,
      });
      actions.set(key, current);
    }
  }
  return [...actions.values()].sort((a, b) => severityRank[a.priority] - severityRank[b.priority] || a.stage.localeCompare(b.stage));
}

/** Write reports/routing.md mapping reviewer weaknesses to the stages that
 *  fix them. Purely advisory: the engine runs stages in order, so routing is
 *  a human/agent decision aid, not an automatic jump. */
export async function routeWorkspace(workspaceDir: string): Promise<RouteWorkspaceResult> {
  const load = await loadScorecard(workspaceDir);
  if (!load.ok) throw new Error(load.findings.join("\n"));

  const routed = routeWeaknesses(load.scorecard);
  const lines: string[] = ["# Review Weakness Routing", ""];
  if (routed.length === 0) {
    lines.push("No weaknesses reported by any reviewer persona.");
  }
  for (const w of routed) {
    lines.push(`## [${w.severity}] ${w.category} (${w.personaId})`, "", w.detail, "");
    for (const target of w.targets) {
      lines.push(`- **${target.stage}**: ${target.action}`);
    }
    lines.push("");
  }

  await fs.mkdir(path.join(workspaceDir, "reports"), { recursive: true });
  const actions = remediationActions(routed);
  lines.push("## Deterministic Remediation Plan", "");
  if (actions.length === 0) lines.push("- No remediation actions required.");
  for (const action of actions) {
    lines.push(`- [${action.priority}] ${action.id} via **${action.stage}** (${action.weaknesses.length} finding(s))`);
  }

  await fs.writeFile(path.join(workspaceDir, ROUTING_PATH), lines.join("\n"), "utf-8");
  await fs.writeFile(path.join(workspaceDir, REMEDIATION_PATH), JSON.stringify({ version: 1, actions }, null, 2), "utf-8");
  return { routed, routingPath: ROUTING_PATH, remediationPath: REMEDIATION_PATH, actions };
}
