import fs from "node:fs/promises";
import path from "node:path";
import { readWorkspaceStatus, type WorkspaceStatus } from "./status.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function cronExpression(status: WorkspaceStatus): string | null {
  if (status.review.cadence === "daily") {
    const [hour = "08", minute = "00"] = (status.review.time ?? "08:00").split(":");
    return `${Number(minute)} ${Number(hour)} * * *`;
  }
  if (status.review.cadence === "interval") {
    return `0 */${status.review.intervalHours ?? 4} * * *`;
  }
  return null;
}

function launchdIntervalSeconds(status: WorkspaceStatus): number {
  if (status.review.cadence === "interval") return (status.review.intervalHours ?? 4) * 60 * 60;
  return 24 * 60 * 60;
}

export function scheduleToMarkdown(status: WorkspaceStatus): string {
  const workspace = status.workspaceDir;
  const quotedWorkspace = shellQuote(workspace);
  const xmlWorkspace = xmlEscape(workspace);
  const logPath = "reports/schedule.log";
  const reportAndAgenda = `cd ${quotedWorkspace} && longwrite report daily . && longwrite review agenda . >> ${logPath} 2>&1`;
  const cron = cronExpression(status);
  const cadenceSummary = status.review.cadence === "daily"
    ? `daily at ${status.review.time ?? "08:00"}`
    : status.review.cadence === "interval"
      ? `every ${status.review.intervalHours ?? 4} hours`
      : "manual";
  const lines = [
    "# LongWrite Schedule Helper",
    "",
    `Workspace: ${workspace}`,
    `Review cadence: ${cadenceSummary}`,
    `Batch approvals: ${status.review.batchApprovals ? "yes" : "no"}`,
    "",
    "This file contains scheduler snippets only. LongWrite does not install cron,",
    "launchd, systemd, or GitHub Actions jobs for you.",
    "",
  ];

  if (status.review.cadence === "manual") {
    lines.push(
      "## Manual Cadence",
      "",
      "No automatic cadence is configured. Run these commands when you want a",
      "progress digest and approval agenda:",
      "",
      "```bash",
      `cd ${quotedWorkspace}`,
      "longwrite status .",
      "longwrite report daily .",
      "longwrite review agenda .",
      "```",
      "",
      "Use the examples below as starting points if you later switch this workspace",
      "to a daily or interval review cadence.",
      "",
    );
  } else {
    lines.push(
      "## Scheduled Review Command",
      "",
      "```bash",
      reportAndAgenda,
      "```",
      "",
    );
  }

  lines.push(
    "## Cron",
    "",
    "```cron",
    `${cron ?? "0 8 * * *"} ${reportAndAgenda}`,
    "```",
    "",
    "## Launchd",
    "",
    "```xml",
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    "<dict>",
    "  <key>Label</key>",
    "  <string>com.longwrite.schedule</string>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xmlWorkspace}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    "    <string>/bin/sh</string>",
    "    <string>-lc</string>",
    "    <string>longwrite report daily . && longwrite review agenda . >> reports/schedule.log 2>&1</string>",
    "  </array>",
    "  <key>StartInterval</key>",
    `  <integer>${launchdIntervalSeconds(status)}</integer>`,
    "</dict>",
    "</plist>",
    "```",
    "",
    "## Systemd User Timer",
    "",
    "```ini",
    "# ~/.config/systemd/user/longwrite-report.service",
    "[Unit]",
    "Description=LongWrite report and review agenda",
    "",
    "[Service]",
    "Type=oneshot",
    `WorkingDirectory=${workspace}`,
    "ExecStart=/bin/sh -lc 'longwrite report daily . && longwrite review agenda . >> reports/schedule.log 2>&1'",
    "",
    "# ~/.config/systemd/user/longwrite-report.timer",
    "[Unit]",
    "Description=Run LongWrite report and review agenda",
    "",
    "[Timer]",
    status.review.cadence === "interval"
      ? `OnUnitActiveSec=${status.review.intervalHours ?? 4}h`
      : `OnCalendar=*-*-* ${status.review.time ?? "08:00"}:00`,
    "Persistent=true",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "```",
    "",
    "## GitHub Actions",
    "",
    "```yaml",
    "name: LongWrite schedule",
    "on:",
    "  schedule:",
    `    - cron: \"${cron ?? "0 8 * * *"}\"`,
    "  workflow_dispatch:",
    "jobs:",
    "  report:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: 22",
    "      - run: npm install -g longwrite",
    "      - run: longwrite report daily . && longwrite review agenda .",
    "```",
    "",
    "## Approval Policy",
    "",
  );

  if (status.review.batchApprovals) {
    lines.push(
      "This workspace prefers batch approval. After reading the agenda, approve",
      "review gates explicitly with:",
      "",
      "```bash",
      `cd ${quotedWorkspace}`,
      "malaclaw flow review --batch",
      "```",
      "",
    );
  } else {
    lines.push(
      "This workspace does not enable batch approval. Use the approval ids shown by",
      "`longwrite review agenda .` to approve individual review gates.",
      "",
    );
  }

  return `${lines.join("\n")}\n`;
}

export async function writeScheduleReport(workspaceDir: string): Promise<string> {
  const status = await readWorkspaceStatus(workspaceDir);
  const rel = "reports/schedule.md";
  const abs = path.join(status.workspaceDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, scheduleToMarkdown(status), "utf-8");
  return rel;
}
