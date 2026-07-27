import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LongWriteModeDef } from "../src/lib/mode-schema.js";
import { listModeIds, loadAllModes, loadMode } from "../src/lib/modes.js";

const tempDirs: string[] = [];

async function makeTempModes(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-modes-"));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content, "utf-8");
  }
  return dir;
}

afterEach(async () => {
  delete process.env.LONGWRITE_MODES_DIR;
  while (tempDirs.length > 0) await fs.rm(tempDirs.pop()!, { recursive: true, force: true });
});

describe("LongWriteModeDef", () => {
  it("parses all bundled modes", async () => {
    const modes = await loadAllModes();
    expect(modes.map((m) => m.id)).toContain("auto_research_agentic");
    expect(modes.every((m) => m.workflow.stages.length > 0)).toBe(true);
  });

  it("ships exactly one research mode and rejects the removed legacy ids", async () => {
    expect(await listModeIds()).toEqual(["auto_research_agentic", "novel", "technical_book"]);
    await expect(loadMode("auto_research_v2")).rejects.toThrow(/not found/);
    await expect(loadMode("auto_research_v2_lite")).rejects.toThrow(/not found/);
  });

  it("applies domain defaults", () => {
    const mode = LongWriteModeDef.parse({
      id: "x",
      name: "X",
      artifact_type: "paper",
      workflow: { stages: [{ id: "intake", owner: "lead" }] },
    });
    expect(mode.default_runtime.executor).toBe("malaclaw");
  });

  it("rejects unknown domain keys but allows workflow passthrough", () => {
    expect(() =>
      LongWriteModeDef.parse({
        id: "x",
        name: "X",
        artifact_type: "paper",
        mystery: true,
        workflow: { stages: [{ id: "intake", owner: "lead" }] },
      }),
    ).toThrow(/unrecognized key/i);

    const mode = LongWriteModeDef.parse({
      id: "x",
      name: "X",
      artifact_type: "paper",
      workflow: { stages: [{ id: "intake", owner: "lead" }], max_parallel: 4 },
    });
    expect(mode.workflow.max_parallel).toBe(4);
  });

  it("rejects workflow without stages", () => {
    expect(() =>
      LongWriteModeDef.parse({ id: "x", name: "X", artifact_type: "paper", workflow: {} }),
    ).toThrow();
  });
});

describe("mode loader", () => {
  it("lists and loads modes from LONGWRITE_MODES_DIR", async () => {
    process.env.LONGWRITE_MODES_DIR = await makeTempModes({
      "custom.yaml": "id: custom\nname: Custom\nartifact_type: paper\nworkflow:\n  stages:\n    - id: intake\n      owner: lead\n",
    });
    expect(await listModeIds()).toEqual(["custom"]);
    expect((await loadMode("custom")).id).toBe("custom");
  });

  it("throws with available ids when a mode is missing", async () => {
    process.env.LONGWRITE_MODES_DIR = await makeTempModes({
      "custom.yaml": "id: custom\nname: Custom\nartifact_type: paper\nworkflow:\n  stages:\n    - id: intake\n      owner: lead\n",
    });
    await expect(loadMode("nope")).rejects.toThrow(/custom/);
  });

  it("ships role profiles without a MalaClaw provisioner catalog", async () => {
    const root = path.resolve("role-profiles");
    const entries = await fs.readdir(root);
    expect(entries).toContain("research-lead.yaml");
    await expect(fs.access(path.resolve("templates"))).rejects.toThrow();
  });
});
