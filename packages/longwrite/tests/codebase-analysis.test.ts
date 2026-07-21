import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { repairCodebaseAnalysis } from "../src/lib/research/codebase-analysis.js";

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<{ root: string; locator: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-codebase-analysis-"));
  tempDirs.push(root);
  await fs.mkdir(path.join(root, "codebases"), { recursive: true });
  await fs.mkdir(path.join(root, "evidence"), { recursive: true });
  const locator = "[codebase:demo:src/runner.ts#L1-L4]";
  await fs.writeFile(path.join(root, "codebases", "manifest.json"), JSON.stringify({
    version: 1,
    codebases: [{ version: 1, id: "demo", source: "https://example.test/demo.git", requested_ref: "main", resolved_commit: "a".repeat(40), title: "Demo", role: "primary_artifact", snapshot_path: "codebases/demo/snapshot", files: [{ path: "src/runner.ts", bytes: 80 }], generated_at: "2026-07-21T00:00:00.000Z" }],
  }), "utf8");
  await fs.writeFile(path.join(root, "evidence", "codebase-chunks.jsonl"), `${JSON.stringify({ id: "codebase:demo:src_runner.ts:L1-L4", codebase_id: "demo", path: "src/runner.ts", start_line: 1, end_line: 4, text: "export function run() { return loadConfig(); }" })}\n`, "utf8");
  return { root, locator };
}

function packet(locator: string): Record<string, unknown> {
  return {
    version: 1,
    codebases: [{
      codebase_id: "demo",
      summary: "The repository exposes a configured trial runner as its primary bounded component.",
      summary_locators: [locator],
      components: [{ id: "runner", name: "Trial runner", summary: "Coordinates one configured execution path.", locators: [locator] }],
      entrypoints: [{ id: "run", name: "run", summary: "Starts the bounded execution path.", locators: [locator] }],
      interfaces: [], data_control_flows: [], configuration_extension_points: [], trust_boundaries: [], operational_limitations: [],
    }],
  };
}

afterEach(async () => {
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

describe("repository architecture-analysis repair", () => {
  it("normalizes and accepts a packet grounded in exact code chunk locators", async () => {
    const { root, locator } = await makeWorkspace();
    await fs.writeFile(path.join(root, "evidence", "codebase-analysis.raw.json"), `\`\`\`json\n${JSON.stringify(packet(locator))}\n\`\`\`\n`, "utf8");
    const result = await repairCodebaseAnalysis(root);
    expect(result.normalized).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(root, "evidence", "codebase-analysis.json"), "utf8"))).toMatchObject({ version: 1, codebases: [{ codebase_id: "demo" }] });
    expect(await fs.readFile(path.join(root, "reports", "codebase-analysis-repair.md"), "utf8")).toContain("Status: pass");
  });

  it("fails closed when a statement cites an invented line range", async () => {
    const { root } = await makeWorkspace();
    await fs.writeFile(path.join(root, "evidence", "codebase-analysis.raw.json"), JSON.stringify(packet("[codebase:demo:src/runner.ts#L1-L99]")), "utf8");
    await expect(repairCodebaseAnalysis(root)).rejects.toThrow("invalid codebase architecture analysis");
    expect(await fs.readFile(path.join(root, "reports", "codebase-analysis-repair.md"), "utf8")).toContain("unknown or non-exact locator");
  });
});
