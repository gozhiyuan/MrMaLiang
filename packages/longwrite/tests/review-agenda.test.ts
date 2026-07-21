import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { readReviewAgenda } from "../src/lib/ops/review.js";

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-review-"));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, ".malaclaw", "flow"), { recursive: true });
  await fs.writeFile(path.join(dir, "longwrite.yaml"), stringifyYaml({
    version: 1,
    project: { id: "survey", name: "Survey", mode: "auto_research_agentic", artifact_type: "research_paper" },
    research: { provider: "seed", topic: "Long-horizon agent memory" },
    review: { cadence: "daily", time: "08:00", interval_hours: 4, batch_approvals: true },
  }), "utf-8");
  await fs.writeFile(path.join(dir, "malaclaw.yaml"), stringifyYaml({ workflow: { stages: [] } }), "utf-8");
  await fs.writeFile(path.join(dir, ".malaclaw", "flow", "state.json"), JSON.stringify({
    version: 1,
    workflowHash: "abc",
    status: "paused_for_approval",
    updatedAt: "2026-07-05T12:00:00.000Z",
    units: { outline: { status: "pending" } },
    pendingApprovals: [
      { id: "approve-outline-001", stageId: "outline", artifacts: ["outline.md"] },
    ],
    foreachItems: {},
  }), "utf-8");
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

describe("review agenda", () => {
  it("prints pending approvals with batch command when configured", async () => {
    const agenda = await readReviewAgenda(await makeWorkspace());
    expect(agenda).toContain("LongWrite Review Agenda");
    expect(agenda).toContain("Daily review at 08:00");
    expect(agenda).toContain("approve-outline-001");
    expect(agenda).toContain("malaclaw flow review --batch");
  });
});
