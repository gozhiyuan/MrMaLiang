import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { forwardCommand } from "../src/proxy.js";

const temporaryRoot = path.join(os.tmpdir(), `maliang-proxy-integration-${Date.now()}`);

async function workspace(id: string): Promise<string> {
  const dir = path.join(temporaryRoot, id);
  await fs.mkdir(path.join(dir, "writing"), { recursive: true });
  await fs.writeFile(path.join(dir, "maliang.yaml"), [
    "version: 1", "project:", `  id: ${id}`, "  template: paper.survey", "research:", "  paperKind: survey", "  evidenceProfile: literature", "  experimentSource: none", "components:", "  writing:", "    workspace: writing", "handoff:", "  mode: none", "  state: not_required", "",
  ].join("\n"));
  return dir;
}

async function fixture(name: string, source: string): Promise<string> {
  const file = path.join(temporaryRoot, name);
  await fs.mkdir(temporaryRoot, { recursive: true });
  await fs.writeFile(file, source, "utf8");
  return file;
}

afterAll(async () => { await fs.rm(temporaryRoot, { recursive: true, force: true }); });

describe("forwardCommand process integration", () => {
  it("returns the real child exit status and rewrites the parent workspace", async () => {
    const parent = await workspace("nonzero");
    const program = await fixture("exit-seven.js", [
      "const expected = process.argv[4];",
      "if (!expected.endsWith('/writing')) process.exit(9);",
      "process.exit(7);",
      "",
    ].join("\n"));
    await expect(forwardCommand(["validate", "config", parent], { componentCliPath: { writing: program } })).resolves.toBe(7);
  });

  it("forwards a synthetic SIGTERM to the spawned child and removes listeners", async () => {
    const parent = await workspace("signal");
    const program = await fixture("wait.js", "setInterval(() => {}, 1_000);\n");
    const before = process.listenerCount("SIGTERM");
    const pending = forwardCommand(["validate", "config", parent], { componentCliPath: { writing: program } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.emit("SIGTERM", "SIGTERM");
    await expect(pending).resolves.toBe(143);
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});
