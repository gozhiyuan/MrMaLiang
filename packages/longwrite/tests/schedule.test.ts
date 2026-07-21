import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { scheduleToMarkdown, writeScheduleReport } from "../src/lib/ops/schedule.js";
import { readWorkspaceStatus } from "../src/lib/ops/status.js";

const tempDirs: string[] = [];

async function makeWorkspace(review: {
  cadence: "manual" | "daily" | "interval";
  time?: string;
  interval_hours?: number;
  batch_approvals?: boolean;
}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-schedule-"));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, "reports"), { recursive: true });
  await fs.writeFile(path.join(dir, "longwrite.yaml"), stringifyYaml({
    version: 1,
    project: {
      id: "agent-memory-survey",
      name: "Agent Memory Survey",
      artifact_type: "research_paper",
      mode: "auto_research_agentic",
    },
    review,
  }), "utf-8");
  await fs.writeFile(path.join(dir, "malaclaw.yaml"), stringifyYaml({
    workflow: {
      stages: [
        { id: "intake", outputs: ["project_brief.md"] },
      ],
    },
  }), "utf-8");
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

describe("LongWrite schedule helper", () => {
  it("writes daily scheduler snippets with batch approval guidance", async () => {
    const ws = await makeWorkspace({
      cadence: "daily",
      time: "08:00",
      interval_hours: 4,
      batch_approvals: true,
    });

    const rel = await writeScheduleReport(ws);
    expect(rel).toBe("reports/schedule.md");
    const markdown = await fs.readFile(path.join(ws, rel), "utf-8");
    expect(markdown).toContain("LongWrite Schedule Helper");
    expect(markdown).toContain("0 8 * * *");
    expect(markdown).toContain("longwrite report daily .");
    expect(markdown).toContain("longwrite review agenda .");
    expect(markdown).toContain("malaclaw flow review --batch");
    expect(markdown).toContain("This file contains scheduler snippets only.");
  });

  it("renders interval cadence as a repeated cron schedule", async () => {
    const ws = await makeWorkspace({
      cadence: "interval",
      interval_hours: 6,
      batch_approvals: false,
    });

    const status = await readWorkspaceStatus(ws);
    const markdown = scheduleToMarkdown(status);
    expect(markdown).toContain("Review cadence: every 6 hours");
    expect(markdown).toContain("0 */6 * * *");
    expect(markdown).toContain("OnUnitActiveSec=6h");
  });

  it("keeps manual cadence explicit instead of implying automation", async () => {
    const ws = await makeWorkspace({
      cadence: "manual",
      interval_hours: 4,
      batch_approvals: false,
    });

    const status = await readWorkspaceStatus(ws);
    const markdown = scheduleToMarkdown(status);
    expect(markdown).toContain("Review cadence: manual");
    expect(markdown).toContain("No automatic cadence is configured.");
    expect(markdown).toContain("longwrite status .");
  });
});
