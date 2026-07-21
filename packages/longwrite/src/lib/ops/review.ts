import { readWorkspaceStatus, type WorkspaceStatus } from "./status.js";

function policyLine(status: WorkspaceStatus): string {
  const review = status.review;
  if (review.cadence === "daily") {
    return `Daily review at ${review.time ?? "08:00"}; ${review.batchApprovals ? "batch approvals enabled" : "approve items individually"}.`;
  }
  if (review.cadence === "interval") {
    return `Review every ${review.intervalHours ?? 4} hours; ${review.batchApprovals ? "batch approvals enabled" : "approve items individually"}.`;
  }
  return `${review.batchApprovals ? "Batch approvals enabled" : "Manual review"}; run this agenda when you want to inspect progress.`;
}

export function reviewAgendaToMarkdown(status: WorkspaceStatus): string {
  const lines = [
    "# LongWrite Review Agenda",
    "",
    `Project: ${status.projectName ?? status.projectId ?? "unknown"}`,
    `Workspace: ${status.workspaceDir}`,
    `Policy: ${policyLine(status)}`,
    "",
    "## Flow",
    "",
    status.flow ? `Status: ${status.flow.status}` : "No MalaClaw flow state found.",
    "",
  ];

  if (status.flow?.pendingApprovals.length) {
    lines.push("## Pending Approvals", "");
    for (const approval of status.flow.pendingApprovals) {
      const target = [approval.stageId, approval.stepId, approval.itemId].filter(Boolean).join(" / ");
      lines.push(`- ${approval.id} (${target})`);
      for (const artifact of approval.artifacts) lines.push(`  - artifact: ${artifact}`);
    }
    lines.push("");
    lines.push(
      status.review.batchApprovals
        ? "Batch command: `malaclaw flow review --batch`"
        : `First command: \`malaclaw flow approve ${status.flow.pendingApprovals[0].id}\``,
      "",
    );
  } else {
    lines.push("## Pending Approvals", "", "- None.", "");
  }

  lines.push("## Validation", "");
  if (!status.validation) {
    lines.push("- No LongWrite validation report found.", "");
  } else if (status.validation.pass) {
    lines.push("- Validation passed.", "");
  } else {
    for (const check of status.validation.failedChecks) {
      lines.push(`- ${check.id}`);
      for (const finding of check.findings) lines.push(`  - ${finding}`);
    }
    lines.push("");
  }

  lines.push("## Next Action", "", status.nextAction, "");
  return `${lines.join("\n")}\n`;
}

export async function readReviewAgenda(workspaceDir: string): Promise<string> {
  return reviewAgendaToMarkdown(await readWorkspaceStatus(workspaceDir));
}
