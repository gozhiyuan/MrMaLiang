import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { archiveWorkspace, pruneWorkspace, writeRunProvenance } from "../src/lib/ops/workspace-lifecycle.js";

const roots: string[] = [];

async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "longwrite-lifecycle-"));
  roots.push(root);
  const target = path.join(root, "survey");
  await runInit(target, { topic: "Evidence-backed agent memory", researchProvider: "seed" });
  await fs.mkdir(path.join(target, "evidence"), { recursive: true });
  await fs.writeFile(path.join(target, "evidence", "chunks.jsonl"), "{\"chunk_id\":\"c1\"}\n", "utf8");
  await fs.mkdir(path.join(target, "codebases"), { recursive: true });
  await fs.writeFile(path.join(target, "codebases", "manifest.json"), "{\"version\":1,\"codebases\":[]}\n", "utf8");
  await fs.writeFile(path.join(target, "evidence", "index.sqlite"), "derived index", "utf8");
  await fs.writeFile(path.join(target, "build", "manuscript.pdf"), "final paper", "utf8");
  await fs.writeFile(path.join(target, "build", "manuscript.aux"), "rebuildable", "utf8");
  await fs.mkdir(path.join(target, ".malaclaw", "flow"), { recursive: true });
  await fs.writeFile(path.join(target, ".malaclaw", "flow", "state.json"), JSON.stringify({
    units: { "draft_sections.draft": { status: "succeeded", attempts: 1, requestedRuntime: "codex", actualRuntime: "codex", requestedModel: "gpt-5", actualModel: "gpt-5" } },
  }), "utf8");
  return target;
}

afterEach(async () => {
  while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true });
});

describe("workspace lifecycle", () => {
  it("writes secret-free provenance and prunes only verified, rebuildable artifacts", async () => {
    const target = await workspace();
    const provenance = await writeRunProvenance(target, { runtime: "codex" });
    const record = JSON.parse(await fs.readFile(path.join(target, provenance), "utf8")) as Record<string, unknown>;
    expect(record).toMatchObject({ version: 1, kind: "longwrite-run-provenance", execution: { requested_runtime: "codex", research_provider: "seed" } });
    expect((record.execution as { units: Array<{ actual_model: string }> }).units).toEqual(expect.arrayContaining([
      expect.objectContaining({ actual_runtime: "codex", actual_model: "gpt-5" }),
    ]));
    expect(JSON.stringify(record)).not.toContain("API_KEY");

    await fs.writeFile(path.join(target, ".malaclaw", "flow", "state.json"), "{not valid JSON", "utf8");
    await expect(writeRunProvenance(target, { runtime: "codex" })).resolves.toContain("reports/run-provenance/");

    const preview = await pruneWorkspace(target);
    expect(preview.dryRun).toBe(true);
    expect(preview.candidates).toEqual(expect.arrayContaining(["evidence/index.sqlite", "build/manuscript.aux"]));
    await expect(fs.access(path.join(target, "evidence", "index.sqlite"))).resolves.toBeUndefined();

    const archived = await archiveWorkspace(target);
    expect(await fs.stat(path.join(target, archived.archive))).toMatchObject({ size: expect.any(Number) });
    const manifest = JSON.parse(await fs.readFile(path.join(target, archived.manifest), "utf8")) as { archive: { sha256: string }; files: Array<{ path: string }> };
    expect(manifest.archive.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.files.map((file) => file.path)).toContain("evidence/chunks.jsonl");
    expect(manifest.files.map((file) => file.path)).toContain("codebases/manifest.json");

    const pruned = await pruneWorkspace(target, { execute: true, archive: archived.archive });
    expect(pruned.dryRun).toBe(false);
    await expect(fs.access(path.join(target, "evidence", "index.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(target, "build", "manuscript.aux"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(target, "evidence", "chunks.jsonl"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(target, "build", "manuscript.pdf"))).resolves.toBeUndefined();
  });
});
