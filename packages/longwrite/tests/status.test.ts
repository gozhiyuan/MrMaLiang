import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { writeReviewPacket } from "../src/lib/ops/packet.js";
import { readWorkspaceStatus, statusToMarkdown, writeDailyDigest } from "../src/lib/ops/status.js";

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-status-"));
  tempDirs.push(dir);
  await fs.mkdir(path.join(dir, ".malaclaw", "flow"), { recursive: true });
  await fs.mkdir(path.join(dir, "reports"), { recursive: true });
  await fs.mkdir(path.join(dir, "sources"), { recursive: true });
  await fs.writeFile(path.join(dir, "longwrite.yaml"), stringifyYaml({
    version: 1,
    project: {
      id: "agent-memory-survey",
      name: "Agent Memory Survey",
      artifact_type: "research_paper",
      mode: "auto_research_agentic",
    },
    review: {
      cadence: "daily",
      time: "08:00",
      interval_hours: 4,
      batch_approvals: true,
    },
  }), "utf-8");
  await fs.writeFile(path.join(dir, "malaclaw.yaml"), stringifyYaml({
    workflow: {
      stages: [
        { id: "intake", outputs: ["project_brief.md"] },
        { id: "build", outputs: ["build/manuscript.pdf"] },
      ],
    },
  }), "utf-8");
  await fs.writeFile(path.join(dir, "project_brief.md"), "# Brief\n", "utf-8");
  await fs.writeFile(path.join(dir, "sources/raw_results.jsonl"), "{}\n", "utf-8");
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

describe("LongWrite workspace status", () => {
  it("summarizes flow state, validation, artifacts, and next action", async () => {
    const ws = await makeWorkspace();
    await fs.writeFile(path.join(ws, ".malaclaw", "flow", "state.json"), JSON.stringify({
      version: 1,
      workflowHash: "abc",
      status: "paused_for_approval",
      updatedAt: "2026-07-05T12:00:00.000Z",
      units: {
        intake: { status: "succeeded" },
        outline: { status: "pending" },
      },
      pendingApprovals: [
        { id: "approve-outline-001", stageId: "outline", artifacts: ["outline.md"] },
      ],
      foreachItems: {},
    }), "utf-8");
    await fs.writeFile(path.join(ws, "reports", "longwrite-validation.json"), JSON.stringify({
      pass: false,
      checks: [
        { id: "citation_markers_present", pass: false, findings: ["missing marker"] },
      ],
    }), "utf-8");

    const status = await readWorkspaceStatus(ws);
    expect(status.projectName).toBe("Agent Memory Survey");
    expect(status.flow?.status).toBe("paused_for_approval");
    expect(status.flow?.pendingApprovals[0].id).toBe("approve-outline-001");
    expect(status.validation?.pass).toBe(false);
    expect(status.review.cadence).toBe("daily");
    expect(status.review.batchApprovals).toBe(true);
    expect(status.artifacts).toContain("sources/raw_results.jsonl");
    expect(status.missingConcreteOutputs).toContain("build/manuscript.pdf");
    expect(status.nextAction).toContain("malaclaw flow review --batch");

    const markdown = statusToMarkdown(status);
    expect(markdown).toContain("LongWrite Status");
    expect(markdown).toContain("Review Policy");
    expect(markdown).toContain("Pending Approvals");
    expect(markdown).toContain("missing marker");
  });

  it("writes a dated daily digest", async () => {
    const ws = await makeWorkspace();
    const rel = await writeDailyDigest(ws, new Date(2026, 6, 5));
    expect(rel).toBe("reports/digest-2026-07-05.md");
    expect(await fs.readFile(path.join(ws, rel), "utf-8")).toContain("Next Action");
  });

  it("counts an intentionally empty JSONL output as produced", async () => {
    const ws = await makeWorkspace();
    const manifest = {
      workflow: {
        stages: [{ id: "index", outputs: ["evidence/chunks.jsonl"] }],
      },
    };
    await fs.mkdir(path.join(ws, "evidence"), { recursive: true });
    await fs.writeFile(path.join(ws, "evidence", "chunks.jsonl"), "", "utf-8");
    await fs.writeFile(path.join(ws, "malaclaw.yaml"), stringifyYaml(manifest), "utf-8");

    const status = await readWorkspaceStatus(ws);
    expect(status.missingConcreteOutputs).not.toContain("evidence/chunks.jsonl");
    expect(status.artifacts).toContain("evidence/chunks.jsonl");
  });

  it("writes a human review packet with scorecard and routing context", async () => {
    const ws = await makeWorkspace();
    await fs.writeFile(path.join(ws, ".malaclaw", "flow", "state.json"), JSON.stringify({
      version: 1,
      workflowHash: "abc",
      status: "completed",
      updatedAt: "2026-07-05T12:00:00.000Z",
      units: {
        intake: { status: "succeeded" },
        build: { status: "succeeded" },
      },
      pendingApprovals: [],
      foreachItems: {},
    }), "utf-8");
    await fs.writeFile(path.join(ws, "reports", "metrics.json"), JSON.stringify({
      review_score: 8.2,
      review_score_raw_median: 8.7,
      review_round: 2,
    }), "utf-8");
    await fs.writeFile(path.join(ws, "reports", "score-history.json"), JSON.stringify([
      { round: 1, reviewScore: 7, rawMedian: 8.5, ts: "2026-07-05T11:00:00.000Z" },
      { round: 2, reviewScore: 8.2, rawMedian: 8.7, ts: "2026-07-05T12:00:00.000Z" },
    ]), "utf-8");
    await fs.writeFile(path.join(ws, "reports", "routing.md"), "# Review Weakness Routing\n\n## [major] citation coverage\n", "utf-8");

    const rel = await writeReviewPacket(ws);
    expect(rel).toBe("reports/human-review-packet.md");
    const markdown = await fs.readFile(path.join(ws, rel), "utf-8");
    expect(markdown).toContain("LongWrite Human Review Packet");
    expect(markdown).toContain("Status: completed");
    expect(markdown).toContain("Official review_score: 8.2");
    expect(markdown).toContain("round 2: score 8.2");
    expect(markdown).toContain("Review Weakness Routing");
    expect(markdown).toContain("Missing Concrete Outputs");
    expect(markdown).toContain("build/manuscript.pdf");
  });
});
