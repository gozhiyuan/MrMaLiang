import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runApprove } from "../src/commands/approve.js";
import { runWorkflow } from "../src/commands/run.js";
import { runRuntimes } from "../src/commands/runtimes.js";

const tempDirs: string[] = [];
const oldBin = process.env.LONGWRITE_MALACLAW_BIN;

async function makeWorkspace(): Promise<{ ws: string; log: string }> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-delegate-ws-"));
  tempDirs.push(ws);
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-delegate-bin-"));
  tempDirs.push(binDir);
  const log = path.join(ws, "malaclaw-calls.jsonl");
  const bin = path.join(binDir, "malaclaw");
  await fs.writeFile(bin, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "fs.appendFileSync(path.join(process.cwd(), 'malaclaw-calls.jsonl'), JSON.stringify(process.argv.slice(2)) + '\\n');",
    "console.log('stub malaclaw ' + process.argv.slice(2).join(' '));",
  ].join("\n"), "utf-8");
  await fs.chmod(bin, 0o755);
  process.env.LONGWRITE_MALACLAW_BIN = bin;
  return { ws, log };
}

async function readCalls(log: string): Promise<string[][]> {
  return (await fs.readFile(log, "utf-8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

afterEach(async () => {
  if (oldBin === undefined) delete process.env.LONGWRITE_MALACLAW_BIN;
  else process.env.LONGWRITE_MALACLAW_BIN = oldBin;
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

describe("MalaClaw delegation", () => {
  it("validates before running the flow by default", async () => {
    const { ws, log } = await makeWorkspace();
    await runWorkflow(ws, { runtime: "dry-run" });
    expect(await readCalls(log)).toEqual([
      ["validate"],
      ["flow", "run", "--runtime", "dry-run"],
    ]);
  });

  it("supports reset and skip-validate for workflow runs", async () => {
    const { ws, log } = await makeWorkspace();
    await runWorkflow(ws, { runtime: "codex", reset: true, skipValidate: true });
    expect(await readCalls(log)).toEqual([
      ["flow", "run", "--runtime", "codex", "--reset"],
    ]);
  });

  it("delegates individual and batch approvals", async () => {
    const { ws, log } = await makeWorkspace();
    await runApprove(ws, "approve-outline-001", {});
    await runApprove(ws, undefined, { batch: true });
    expect(await readCalls(log)).toEqual([
      ["flow", "approve", "approve-outline-001"],
      ["flow", "review", "--batch"],
    ]);
  });

  it("requires an approval id unless batch mode is enabled", async () => {
    const { ws } = await makeWorkspace();
    await expect(runApprove(ws, undefined, {})).rejects.toThrow(/approval id is required/);
  });

  it("delegates runtime health checks", async () => {
    const { ws, log } = await makeWorkspace();
    await runRuntimes(ws, { runtime: "codex" });
    expect(await readCalls(log)).toEqual([
      ["flow", "runtimes", "--runtime", "codex"],
    ]);
  });
});
