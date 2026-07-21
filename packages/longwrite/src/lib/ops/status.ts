import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { loadProjectConfigIfExists } from "../project-config.js";
import type { ValidationReport } from "../validation/research.js";

export type UnitSummary = {
  total: number;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
};

export type PendingApprovalSummary = {
  id: string;
  stageId: string;
  stepId?: string;
  itemId?: string;
  artifacts: string[];
};

export type WorkspaceStatus = {
  workspaceDir: string;
  projectName?: string;
  projectId?: string;
  mode?: string;
  runtimeProfile?: string;
  artifactType?: string;
  review: {
    cadence: "manual" | "daily" | "interval";
    time?: string;
    intervalHours?: number;
    batchApprovals: boolean;
  };
  flow?: {
    status: string;
    updatedAt: string;
    units: UnitSummary;
    failedUnits: Array<{ key: string; error?: string }>;
    pendingApprovals: PendingApprovalSummary[];
  };
  validation?: {
    pass: boolean;
    failedChecks: Array<{ id: string; findings: string[] }>;
  };
  artifacts: string[];
  missingConcreteOutputs: string[];
  nextAction: string;
};

type FlowStateLike = {
  status: string;
  updatedAt: string;
  units: Record<string, { status: string; lastError?: string }>;
  pendingApprovals?: PendingApprovalSummary[];
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
  return JSON.parse(raw) as T;
}

async function fileExists(absPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(absPath);
    // Match MalaClaw's required_output_exists validator: an intentionally
    // empty JSONL (for example, a seed-mode corpus with no downloadable full
    // text) is still a produced artifact. Content quality is reported by the
    // dedicated research/evidence validators, not as a false "missing" file.
    return stat.isFile();
  } catch {
    return false;
  }
}

async function listFiles(workspaceDir: string, relDir: string): Promise<string[]> {
  const absDir = path.join(workspaceDir, relDir);
  let entries: string[];
  try {
    entries = await fs.readdir(absDir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort()) {
    const rel = path.join(relDir, entry);
    const abs = path.join(workspaceDir, rel);
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) files.push(...(await listFiles(workspaceDir, rel)));
    else if (stat.isFile()) files.push(rel);
  }
  return files;
}

function unitSummary(units: FlowStateLike["units"]): UnitSummary {
  const summary: UnitSummary = { total: 0, pending: 0, running: 0, succeeded: 0, failed: 0 };
  for (const unit of Object.values(units)) {
    summary.total += 1;
    if (unit.status in summary) summary[unit.status as keyof UnitSummary] += 1;
  }
  return summary;
}

function collectWorkflowOutputs(workflow: { stages?: unknown[] } | undefined): string[] {
  if (!workflow?.stages) return [];
  const outputs: string[] = [];
  for (const stage of workflow.stages as Array<Record<string, unknown>>) {
    if (Array.isArray(stage.outputs)) outputs.push(...stage.outputs.filter((o): o is string => typeof o === "string"));
    if (Array.isArray(stage.steps)) {
      for (const step of stage.steps as Array<Record<string, unknown>>) {
        if (Array.isArray(step.outputs)) outputs.push(...step.outputs.filter((o): o is string => typeof o === "string"));
      }
    }
  }
  return [...new Set(outputs)].filter((output) => !output.includes("*") && !output.includes("{{"));
}

function nextAction(status: Pick<WorkspaceStatus, "flow" | "validation" | "review">): string {
  if (!status.flow) return "Run `malaclaw flow run --runtime dry-run`.";
  if (status.flow.pendingApprovals.length > 0) {
    if (status.review.batchApprovals) {
      return "Review pending approvals, then run `malaclaw flow review --batch`.";
    }
    if (status.review.cadence === "daily") {
      return `Review pending approvals during the ${status.review.time ?? "08:00"} standup, then approve or batch-review them.`;
    }
    if (status.review.cadence === "interval") {
      return `Review pending approvals at the next ${status.review.intervalHours ?? 4}-hour checkpoint.`;
    }
    return `Review pending approvals, then run \`malaclaw flow approve ${status.flow.pendingApprovals[0].id}\`.`;
  }
  if (status.flow.status === "failed") return "Inspect reports/validation.md and .malaclaw/flow/logs, then rerun the flow.";
  if (status.flow.status === "paused_blocker") return "Inspect reports/*-blocker.md, resolve the blocker, then rerun the flow.";
  if (status.flow.status === "completed" && !status.validation) return "Run `longwrite validate research .`.";
  if (status.flow.status === "completed" && status.validation && !status.validation.pass) {
    return "Fix LongWrite validation findings, then rerun `longwrite validate research .`.";
  }
  if (status.flow.status === "completed") return "Ready for human review/export.";
  return "Continue with `malaclaw flow run --runtime dry-run`.";
}

export async function readWorkspaceStatus(workspaceDir: string): Promise<WorkspaceStatus> {
  const resolved = path.resolve(workspaceDir);
  const longwriteConfig = await loadProjectConfigIfExists(resolved);
  const manifest = parseYaml(await readTextIfExists(path.join(resolved, "malaclaw.yaml")) ?? "{}") as
    | { workflow?: { stages?: unknown[] } }
    | undefined;
  const flowState = await readJsonIfExists<FlowStateLike>(path.join(resolved, ".malaclaw", "flow", "state.json"));
  const validationReport = await readJsonIfExists<ValidationReport>(
    path.join(resolved, "reports", "longwrite-validation.json"),
  );
  const concreteOutputs = collectWorkflowOutputs(manifest?.workflow);
  const missingConcreteOutputs = [];
  for (const output of concreteOutputs) {
    if (!(await fileExists(path.join(resolved, output)))) missingConcreteOutputs.push(output);
  }
  const artifacts = (await Promise.all(["sources", "fulltext", "evidence", "chapters", "reviews", "reports", "figures", "tables", "paper", "build"].map((dir) => listFiles(resolved, dir))))
    .flat()
    .sort();
  const failedChecks = validationReport?.checks
    .filter((check) => !check.pass)
    .map((check) => ({ id: check.id, findings: check.findings })) ?? [];
  const status: WorkspaceStatus = {
    workspaceDir: resolved,
    projectName: longwriteConfig?.project?.name,
    projectId: longwriteConfig?.project?.id,
    mode: longwriteConfig?.project?.mode,
    runtimeProfile: longwriteConfig?.runtime_profile,
    artifactType: longwriteConfig?.project?.artifact_type,
    review: {
      cadence: longwriteConfig?.review?.cadence ?? "manual",
      time: longwriteConfig?.review?.time,
      intervalHours: longwriteConfig?.review?.interval_hours,
      batchApprovals: longwriteConfig?.review?.batch_approvals ?? false,
    },
    flow: flowState
      ? {
          status: flowState.status,
          updatedAt: flowState.updatedAt,
          units: unitSummary(flowState.units),
          failedUnits: Object.entries(flowState.units)
            .filter(([, unit]) => unit.status === "failed")
            .map(([key, unit]) => ({ key, error: unit.lastError })),
          pendingApprovals: flowState.pendingApprovals ?? [],
        }
      : undefined,
    validation: validationReport ? { pass: validationReport.pass, failedChecks } : undefined,
    artifacts,
    missingConcreteOutputs,
    nextAction: "",
  };
  status.nextAction = nextAction(status);
  return status;
}

export function statusToMarkdown(status: WorkspaceStatus): string {
  const lines = [
    "# LongWrite Status",
    "",
    `Workspace: ${status.workspaceDir}`,
    `Project: ${status.projectName ?? status.projectId ?? "unknown"}`,
    `Mode: ${status.mode ?? "unknown"}`,
    `Runtime profile: ${status.runtimeProfile ?? "default"}`,
    `Artifact: ${status.artifactType ?? "unknown"}`,
    "",
    "## Review Policy",
    "",
    `Cadence: ${status.review.cadence}`,
    `Batch approvals: ${status.review.batchApprovals ? "yes" : "no"}`,
    ...(status.review.cadence === "daily" ? [`Review time: ${status.review.time ?? "08:00"}`] : []),
    ...(status.review.cadence === "interval" ? [`Interval hours: ${status.review.intervalHours ?? 4}`] : []),
    "",
    "## Flow",
    "",
  ];
  if (!status.flow) {
    lines.push("No MalaClaw flow state found.", "");
  } else {
    lines.push(
      `Status: ${status.flow.status}`,
      `Updated: ${status.flow.updatedAt}`,
      `Units: ${status.flow.units.succeeded}/${status.flow.units.total} succeeded, ${status.flow.units.failed} failed, ${status.flow.units.pending} pending`,
      "",
    );
    if (status.flow.pendingApprovals.length > 0) {
      lines.push("### Pending Approvals", "");
      for (const approval of status.flow.pendingApprovals) {
        const target = [approval.stageId, approval.stepId, approval.itemId].filter(Boolean).join(" / ");
        lines.push(`- ${approval.id} (${target})`);
      }
      lines.push("");
    }
    if (status.flow.failedUnits.length > 0) {
      lines.push("### Failed Units", "");
      for (const unit of status.flow.failedUnits) lines.push(`- ${unit.key}${unit.error ? `: ${unit.error}` : ""}`);
      lines.push("");
    }
  }
  lines.push("## Validation", "");
  if (!status.validation) {
    lines.push("No LongWrite validation report found.", "");
  } else {
    lines.push(`Status: ${status.validation.pass ? "pass" : "fail"}`, "");
    for (const check of status.validation.failedChecks) {
      lines.push(`### ${check.id}`, "");
      for (const finding of check.findings) lines.push(`- ${finding}`);
      lines.push("");
    }
  }
  lines.push("## Artifacts", "", `Produced files: ${status.artifacts.length}`, "");
  for (const artifact of status.artifacts.slice(0, 20)) lines.push(`- ${artifact}`);
  if (status.artifacts.length > 20) lines.push(`- ... ${status.artifacts.length - 20} more`);
  lines.push("", "## Missing Concrete Outputs", "");
  if (status.missingConcreteOutputs.length === 0) lines.push("- None.");
  else for (const output of status.missingConcreteOutputs) lines.push(`- ${output}`);
  lines.push("", "## Next Action", "", status.nextAction, "");
  return `${lines.join("\n")}\n`;
}

export async function writeDailyDigest(workspaceDir: string, date = new Date()): Promise<string> {
  const status = await readWorkspaceStatus(workspaceDir);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const rel = `reports/digest-${yyyy}-${mm}-${dd}.md`;
  const abs = path.join(status.workspaceDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, statusToMarkdown(status), "utf-8");
  return rel;
}
