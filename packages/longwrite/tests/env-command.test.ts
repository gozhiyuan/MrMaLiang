import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runEnvInit } from "../src/commands/env.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("longwrite env init", () => {
  it("adds only the non-secret template and ignore rule", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-env-command-"));
    roots.push(workspace);
    await runEnvInit(workspace);
    await expect(fs.access(path.join(workspace, ".env.example"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(workspace, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(workspace, ".gitignore"), "utf-8")).resolves.toContain(".env");
  });
});
