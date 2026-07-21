import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureWorkspaceEnvFiles, loadWorkspaceEnv } from "../src/lib/workspace-env.js";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.OPENALEX_API_KEY;
  delete process.env.SEMANTIC_SCHOLAR_API_KEY;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("workspace environment", () => {
  it("creates an ignored non-secret template", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-env-"));
    roots.push(workspace);
    await ensureWorkspaceEnvFiles(workspace);
    await expect(fs.readFile(path.join(workspace, ".env.example"), "utf-8")).resolves.toContain("OPENALEX_API_KEY=");
    await expect(fs.readFile(path.join(workspace, ".gitignore"), "utf-8")).resolves.toContain(".env");
  });

  it("loads only missing values from .env", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-env-"));
    roots.push(workspace);
    await fs.writeFile(path.join(workspace, ".env"), "OPENALEX_API_KEY=from-file\nSEMANTIC_SCHOLAR_API_KEY='quoted'\n", "utf-8");
    process.env.OPENALEX_API_KEY = "from-shell";

    expect(await loadWorkspaceEnv(workspace)).toEqual(["SEMANTIC_SCHOLAR_API_KEY"]);
    expect(process.env.OPENALEX_API_KEY).toBe("from-shell");
    expect(process.env.SEMANTIC_SCHOLAR_API_KEY).toBe("quoted");
  });
});
