import fs from "node:fs/promises";
import path from "node:path";
import { readWorkspaceStatus, type WorkspaceStatus } from "./status.js";

type Metrics = Record<string, unknown>;

type ScoreHistoryEntry = {
  round?: number;
  reviewScore?: number;
  rawMedian?: number;
  ts?: string;
};

async function readTextIfExists(absPath: string): Promise<string | null> {
  try {
    return await fs.readFile(absPath, "utf-8");
  } catch {
    return null;
  }
}

async function readJsonIfExists<T>(absPath: string): Promise<T | null> {
  const raw = await readTextIfExists(absPath);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function countArtifacts(status: WorkspaceStatus, prefix: string, suffix?: string): number {
  return status.artifacts.filter((artifact) => artifact.startsWith(prefix) && (suffix ? artifact.endsWith(suffix) : true)).length;
}

function packetReviewPolicy(status: WorkspaceStatus): string {
  if (status.review.cadence === "daily") {
    return `daily at ${status.review.time ?? "08:00"}`;
  }
  if (status.review.cadence === "interval") {
    return `every ${status.review.intervalHours ?? 4} hours`;
  }
  return "manual";
}

function appendFlow(lines: string[], status: WorkspaceStatus): void {
  lines.push("## Flow Snapshot", "");
  if (!status.flow) {
    lines.push("- No MalaClaw flow state found.", "");
    return;
  }

  lines.push(
    `- Status: ${status.flow.status}`,
    `- Updated: ${status.flow.updatedAt}`,
    `- Units: ${status.flow.units.succeeded}/${status.flow.units.total} succeeded, ${status.flow.units.failed} failed, ${status.flow.units.pending} pending`,
    "",
  );

  if (status.flow.pendingApprovals.length > 0) {
    lines.push("### Pending Approvals", "");
    for (const approval of status.flow.pendingApprovals) {
      const target = [approval.stageId, approval.stepId, approval.itemId].filter(Boolean).join(" / ");
      lines.push(`- ${approval.id} (${target})`);
      for (const artifact of approval.artifacts) lines.push(`  - artifact: ${artifact}`);
    }
    lines.push("");
  }

  if (status.flow.failedUnits.length > 0) {
    lines.push("### Failed Units", "");
    for (const unit of status.flow.failedUnits) lines.push(`- ${unit.key}${unit.error ? `: ${unit.error}` : ""}`);
    lines.push("");
  }
}

function appendValidation(lines: string[], status: WorkspaceStatus): void {
  lines.push("## Validation", "");
  if (!status.validation) {
    lines.push("- No LongWrite validation report found.", "");
    return;
  }
  lines.push(`- Status: ${status.validation.pass ? "pass" : "fail"}`, "");
  if (!status.validation.pass) {
    for (const check of status.validation.failedChecks) {
      lines.push(`### ${check.id}`, "");
      for (const finding of check.findings) lines.push(`- ${finding}`);
      lines.push("");
    }
  }
}

function appendScorecard(lines: string[], metrics: Metrics | null, history: ScoreHistoryEntry[] | null): void {
  lines.push("## Scorecard", "");
  if (!metrics && !history?.length) {
    lines.push("- No scorecard metrics found yet.", "");
    return;
  }

  if (metrics) {
    const score = metrics.review_score;
    const raw = metrics.review_score_raw_median;
    const round = metrics.review_round;
    lines.push(
      `- Official review_score: ${typeof score === "number" ? score : "unknown"}`,
      `- Raw median: ${typeof raw === "number" ? raw : "unknown"}`,
      `- Round: ${typeof round === "number" ? round : "unknown"}`,
      "",
    );
  }

  if (history?.length) {
    lines.push("### History", "");
    for (const entry of history.slice(-5)) {
      lines.push(
        `- round ${entry.round ?? "?"}: score ${entry.reviewScore ?? "?"}, raw ${entry.rawMedian ?? "?"}${entry.ts ? ` (${entry.ts})` : ""}`,
      );
    }
    lines.push("");
  }
}

async function appendRouting(lines: string[], workspaceDir: string): Promise<void> {
  lines.push("## Routing", "");
  const routing = await readTextIfExists(path.join(workspaceDir, "reports", "routing.md"));
  if (!routing) {
    lines.push("- No routing report found. Run `longwrite review route .` after a scorecard exists.", "");
    return;
  }
  const excerpt = routing.split("\n").slice(0, 24).join("\n").trim();
  lines.push(excerpt, "");
}

function appendArtifacts(lines: string[], status: WorkspaceStatus): void {
  lines.push("## Artifacts", "");
  lines.push(
    `- Sources: ${countArtifacts(status, "sources/", ".jsonl")} JSONL files, ${countArtifacts(status, "sources/", ".bib")} bibliography files`,
    `- Chapters: ${countArtifacts(status, "chapters/", ".md")} Markdown files`,
    `- Reviews: ${countArtifacts(status, "reviews/")} files`,
    `- Reports: ${countArtifacts(status, "reports/")} files`,
    "",
  );

  lines.push("### Missing Concrete Outputs", "");
  if (status.missingConcreteOutputs.length === 0) lines.push("- None.");
  else for (const output of status.missingConcreteOutputs) lines.push(`- ${output}`);
  lines.push("");

  lines.push("### Recent Produced Files", "");
  for (const artifact of status.artifacts.slice(-20)) lines.push(`- ${artifact}`);
  if (status.artifacts.length === 0) lines.push("- None.");
  lines.push("");
}

export function reviewPacketToMarkdown(
  status: WorkspaceStatus,
  metrics: Metrics | null,
  history: ScoreHistoryEntry[] | null,
  routingSection: string[],
): string {
  const lines = [
    "# LongWrite Human Review Packet",
    "",
    `Workspace: ${status.workspaceDir}`,
    `Project: ${status.projectName ?? status.projectId ?? "unknown"}`,
    `Mode: ${status.mode ?? "unknown"}`,
    `Artifact: ${status.artifactType ?? "unknown"}`,
    `Review cadence: ${packetReviewPolicy(status)}`,
    `Batch approvals: ${status.review.batchApprovals ? "yes" : "no"}`,
    "",
  ];

  appendFlow(lines, status);
  appendValidation(lines, status);
  appendScorecard(lines, metrics, history);
  lines.push(...routingSection);
  appendArtifacts(lines, status);
  lines.push("## Next Action", "", status.nextAction, "");
  return `${lines.join("\n")}\n`;
}

export async function readReviewPacket(workspaceDir: string): Promise<string> {
  const status = await readWorkspaceStatus(workspaceDir);
  const metrics = await readJsonIfExists<Metrics>(path.join(status.workspaceDir, "reports", "metrics.json"));
  const history = await readJsonIfExists<ScoreHistoryEntry[]>(
    path.join(status.workspaceDir, "reports", "score-history.json"),
  );
  const routingSection: string[] = [];
  await appendRouting(routingSection, status.workspaceDir);
  return reviewPacketToMarkdown(status, metrics, history, routingSection);
}

export async function writeReviewPacket(workspaceDir: string): Promise<string> {
  const status = await readWorkspaceStatus(workspaceDir);
  const rel = "reports/human-review-packet.md";
  const abs = path.join(status.workspaceDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, await readReviewPacket(status.workspaceDir), "utf-8");
  return rel;
}
